// Source-independent page-side pieces shared by every generated Claude page script (wishlist, library, ...).
// Like the Steam row modules, these are inlined as text by build-page-script.mjs into one standalone expression,
// so they must only rely on page globals and on each other (sha256Hex), never on module scope.

// Lowercase hex SHA-256 of a Uint8Array (Web Crypto).
export async function sha256Hex(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Per-call clock. javascript_tool is cut off at 45 s, so every wait in a call is bounded by the call budget
// (+2 s grace). nextMutation waits for the DOM under `target` to change, with a timer only as the bound: unfocused
// panes throttle timers, and a message-polling wait was measured as a busy loop.
export function makeWaiter(callBudget) {
  const callStart = Date.now();
  const left = () => callStart + callBudget + 2000 - Date.now();
  const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, Math.min(ms, left()))));
  const outOfCall = () => Date.now() - callStart > callBudget;
  const nextMutation = (target, limit) => new Promise(res => {
    let t; const mo = new MutationObserver(() => done());
    const done = () => { clearTimeout(t); mo.disconnect(); res(); };
    mo.observe(target, {childList: true, subtree: true, characterData: true});
    t = setTimeout(done, Math.max(0, Math.min(limit, left())));
  });
  return {callStart, left, sleep, outOfCall, nextMutation};
}

// Deliver a finished envelope. deliver 'return' (default) returns it as the tool result. 'download' starts a local
// Blob download (no network) and returns only a small summary that reports INITIATION, never receipt: the browser may
// block, hold or relocate the file. The finished envelope is retained in page state for retainMs (1 s to 1 h, default
// 10 min) so an authorized retry needs no rescrape: window.__gcRedeliver() restarts the download (checking an absolute
// expiry, since background timers can be delayed) and window.__gcRelease() discards it. A new delivery releases the
// previous one. o = {deliver, retainMs, filePrefix}.
export async function deliverEnvelope(envelope, o) {
  // Identity continuity state (see identityStep): the last observation plus whether the signed-in account was the same at every check of the run.
  if (o.identityState) envelope.diagnostics = {...envelope.diagnostics, identity: identityOf(o.identityState)};
  if (o.deliver !== 'download') return envelope;
  const text = JSON.stringify(envelope, null, 2) + '\n', bytes = new TextEncoder().encode(text).length;
  const file = `${o.filePrefix}-${envelope.capturedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.json`;
  const retainMs = Math.min(Math.max(Number(o.retainMs) || 600000, 1000), 3600000), expiresAt = Date.now() + retainMs;
  window.__gcRelease?.();
  const start = () => {
    const a = document.createElement('a'), url = URL.createObjectURL(new Blob([text], {type: 'application/json'}));
    a.href = url; a.download = file; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  const release = () => { clearTimeout(window.__gcExpiry); delete window.__gcRedeliver; delete window.__gcRelease; delete window.__gcExpiry; return 'released'; };
  window.__gcRedeliver = () => { if (Date.now() > expiresAt) { release(); return {expired: true, retry: false}; } start(); return {downloadInitiated: true, retry: true, file, bytes}; };
  window.__gcRelease = release;
  window.__gcExpiry = setTimeout(release, retainMs);
  start();
  const d = envelope.diagnostics;
  return {downloadInitiated: true, source: envelope.source, capturedAt: envelope.capturedAt, file, bytes, retainedForMs: retainMs, records: envelope.records.length,
    expected: d.expectedCount, complete: d.complete, stopReason: d.stopReason, elapsedMs: d.elapsedMs, calls: d.calls, scrollSteps: d.scrollSteps, view: d.view,
    note: 'Initiation only. Confirm the file exists with the reported byte count before using it.'};
}

// Identity continuity across a collection (only when the caller passed identity: {salt}). Each call of a collector observes who is signed in
// and compares it with the first observation of the run, so a switch, a sign-out or an expiry between batches, resume calls or navigations is
// noticed (the run then stops and keeps its coherent partial evidence). The state is plain JSON: {checks, stable, broke, covered, first, last}; covered is false when identity was added (or its salt changed) on a resume call, so earlier batches are never attested retroactively. An observation
// that fails, or shows anything but one consistent signed-in account, makes the state unstable. ownerNow() reports whether this page shows
// owner-only controls; it is evaluated only when given, so the final observation is tied to the page that was collected.
export async function identityStep(state, identityOpt, ownerNow, covered = true) {
  if (!identityOpt) return state ?? null;
  const st = state ?? {checks: 0, stable: true, broke: false, covered: covered !== false, first: null, last: null}; // covered: identity was active from the FIRST batch of the run
  let obs = null;
  try { obs = await observeIdentity({salt: identityOpt.salt}); } catch { obs = null; }
  if (obs) { try { obs.owner = ownerNow ? !!ownerNow() : null; } catch { obs.owner = null; } }
  const good = !!obs && obs.problems.length === 0 && obs.loggedIn === true && obs.sessionFingerprint !== null;
  st.checks += 1;
  if (st.checks === 1) st.first = good ? obs.sessionFingerprint : null;
  const lost = !good || obs.sessionFingerprint !== st.first;
  if (lost) st.stable = false;
  if (lost && st.checks > 1 && st.first !== null) st.broke = true; // a signed-in account was established and then changed or lost: stop the run
  // (an account that was never established is not a change: the run proceeds and the saver reports identity as unobserved)
  st.last = obs ?? {version: 1, sources: [], loggedIn: null, consistent: false, problems: [], saltCheck: null, sessionFingerprint: null, pathFingerprint: null, error: 'observation-failed', owner: null};
  return st;
}
export function identityOf(st) {
  return st && st.last ? {...st.last, continuity: {checks: st.checks, stable: st.stable, broke: st.broke, covered: st.covered}} : undefined;
}

// Validators for identity state kept in the site's sessionStorage between navigations (data only; nothing read back is ever evaluated).
export function identityObsValid(o) {
  const hex = v => v === null || (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v));
  return !!o && typeof o === 'object' && !Array.isArray(o) && o.version === 1 && Array.isArray(o.sources) && o.sources.length <= 3 && o.sources.every(x => typeof x === 'string' && x.length <= 20)
    && Array.isArray(o.problems) && o.problems.length <= 10 && o.problems.every(x => typeof x === 'string' && x.length <= 30) && hex(o.sessionFingerprint) && hex(o.pathFingerprint)
    && (o.loggedIn === null || typeof o.loggedIn === 'boolean') && typeof o.consistent === 'boolean' && (o.saltCheck === null || (typeof o.saltCheck === 'string' && /^[0-9a-f]{8}$/.test(o.saltCheck)))
    && (o.owner === undefined || o.owner === null || typeof o.owner === 'boolean') && (o.error === undefined || o.error === 'observation-failed');
}
export function identityStateValid(st) {
  if (st === null) return true;
  return !!st && typeof st === 'object' && !Array.isArray(st) && Object.keys(st).every(k => ['checks', 'stable', 'broke', 'covered', 'first', 'last'].includes(k))
    && Number.isSafeInteger(st.checks) && st.checks >= 0 && st.checks < 10000 && typeof st.stable === 'boolean' && typeof st.broke === 'boolean' && typeof st.covered === 'boolean'
    && (st.first === null || (typeof st.first === 'string' && /^[0-9a-f]{64}$/.test(st.first))) && (st.last === null || identityObsValid(st.last));
}
