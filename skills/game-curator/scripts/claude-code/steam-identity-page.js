// Game Curator: Steam identity probe for Claude Code's built-in browser and Claude in Chrome (page side).
// GENERATED FILE is steam-identity-page.js; edit this template and run `node build-page-script.mjs`.
//
// Reads ONLY logged_in, steamid and accountid from Steam's own page data (window.UserConfig, #application_config[data-userinfo],
// window.g_steamID) and returns a salted fingerprint, never an identifier. It does not read the surrounding objects, login names, tokens
// or cookies, makes no request and changes nothing. Run it with the whole file as `text` to javascript_tool on a Steam store or community
// page of the signed-in browser; the options go in the literal on the last line:
//   ({salt: '<22-char base64url salt of the approved binding>'})   verify against an existing binding
//   ({candidate: true})                                             first binding: returns a fresh salt and its fingerprint
// A result is an observation of who is signed in. It is not approval: a binding is created only by bind-account.mjs after the user says so.
// The page's own URL ID (only /replay/<id>/ and /profiles/<id>/ paths carry one) is fingerprinted separately as pathFingerprint.
await (async (opts = {}) => {
  function b64uEncode(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64uDecode(text) {
    if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) return null;
    try {
      const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return b64uEncode(out) === text ? out : null;
    } catch { return null; }
  }
  function canonicalSteamId64(value) {
    if (typeof value !== 'string' || !/^[1-9][0-9]{16}$/.test(value)) return null;
    const n = BigInt(value);
    const base = 76561197960265728n; // individual-account base; a constant local to the function so the inlined page text stays self-contained
    return n >= base && n <= base + 4294967295n ? value : null;
  }
  function accountIdMatches(steamid64, accountid) {
    const id = canonicalSteamId64(steamid64);
    if (!id) return false;
    const a = typeof accountid === 'number' ? (Number.isSafeInteger(accountid) && accountid >= 0 ? BigInt(accountid) : null)
      : typeof accountid === 'string' && /^[0-9]{1,10}$/.test(accountid) ? BigInt(accountid) : null;
    return a !== null && BigInt(id) - 76561197960265728n === a;
  }
  function fingerprintBytes(saltBytes, steamid64) {
    const enc = new TextEncoder(), head = enc.encode('curator/steam-account/v1'), id = enc.encode(steamid64);
    const out = new Uint8Array(head.length + 1 + saltBytes.length + 1 + id.length);
    out.set(head, 0); out[head.length] = 0; out.set(saltBytes, head.length + 1); out[head.length + 1 + saltBytes.length] = 0; out.set(id, head.length + 2 + saltBytes.length);
    return out;
  }
  async function sha256HexOf(bytes) {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  function readSessionSources(win = window, doc = document) {
    const out = [];
    const take = (name, o) => { if (o && typeof o === 'object') out.push({name, loggedIn: o.logged_in === true ? true : o.logged_in === false ? false : null, steamid: o.steamid, accountid: o.accountid}); };
    try { take('user-config', win.UserConfig); } catch { /* unreadable: treated as absent */ }
    try {
      const attr = doc.getElementById?.('application_config')?.getAttribute?.('data-userinfo');
      if (attr) take('userinfo-attr', JSON.parse(attr)); // the parsed object is discarded after the three fields are copied
    } catch { /* malformed: treated as absent */ }
    try { if (win.g_steamID !== undefined) out.push({name: 'g-steamid', loggedIn: null, steamid: win.g_steamID, accountid: undefined}); } catch { /* absent */ }
    return out;
  }
  async function observeIdentity(o = {}, env = {}) {
    const win = env.win ?? window, doc = env.doc ?? document, loc = env.loc ?? location;
    let saltBytes = o.salt !== undefined ? b64uDecode(o.salt) : null, generated = false;
    if (o.salt === undefined && o.candidate === true) { saltBytes = crypto.getRandomValues(new Uint8Array(16)); generated = true; }
    if (!saltBytes || saltBytes.length !== 16) throw new Error('identity needs a 16-byte base64url salt (or candidate: true)');
    const sources = readSessionSources(win, doc);
    const ids = new Set();
    let loggedIn = null, consistent = true;
    for (const s of sources) {
      if (s.loggedIn === false) loggedIn = false;
      else if (s.loggedIn === true && loggedIn !== false) loggedIn = true;
      const provided = s.steamid !== undefined && s.steamid !== null && s.steamid !== false && s.steamid !== '' && s.steamid !== 0 && s.steamid !== '0';
      if (!provided) continue;
      const id = canonicalSteamId64(s.steamid);
      if (!id || (s.accountid !== undefined && !accountIdMatches(id, s.accountid))) { consistent = false; continue; }
      ids.add(id);
      if (s.name === 'g-steamid' && loggedIn === null) loggedIn = true;
    }
    if (ids.size > 1) consistent = false;
    const fp = async id => sha256HexOf(fingerprintBytes(saltBytes, id));
    const sessionId = ids.size === 1 ? [...ids][0] : null;
    const pathMatch = /\/(?:replay|profiles)\/([0-9]{17})(?=\/|$)/.exec(String(loc?.pathname ?? ''));
    const pathId = pathMatch ? canonicalSteamId64(pathMatch[1]) : null;
    const result = {
      version: 1,
      sources: sources.map(s => s.name),
      loggedIn,
      consistent,
      saltCheck: (await sha256HexOf(saltBytes)).slice(0, 8),
      sessionFingerprint: loggedIn !== false && consistent && sessionId ? await fp(sessionId) : null,
      pathFingerprint: pathId ? await fp(pathId) : null,
    };
    if (generated) result.salt = b64uEncode(saltBytes);
    return result;
  }
  async function sha256Hex(bytes) {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  function makeWaiter(callBudget) {
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
  async function deliverEnvelope(envelope, o) {
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
  const known = ['salt', 'candidate'];
  for (const k of Object.keys(opts)) if (!known.includes(k)) throw new Error(`unknown option: ${k}`);
  if (opts.salt !== undefined && opts.candidate !== undefined) throw new Error('pass either salt or candidate, not both');
  const result = await observeIdentity({salt: opts.salt, candidate: opts.candidate});
  return {format: 'game-curator-identity-probe', ...result, origin: location.origin};
})({})
