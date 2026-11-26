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
