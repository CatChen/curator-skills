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
      : typeof accountid === 'string' && /^(?:0|[1-9][0-9]{0,9})$/.test(accountid) ? BigInt(accountid) : null;
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
    const take = (name, raw, requireAccountId) => {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { out.push({name, state: 'malformed'}); return; }
      let lg, steamid, accountid;
      try { lg = raw.logged_in; steamid = raw.steamid; accountid = raw.accountid; } catch { out.push({name, state: 'unreadable'}); return; } // a throwing field getter is an unreadable marker; its message is never surfaced
      out.push({name, state: 'ok', loggedIn: lg === true ? true : lg === false ? false : lg === undefined ? null : 'invalid', steamid, accountid, requireAccountId});
    };
    let uc, ucState = 'ok';
    try { uc = win.UserConfig; } catch { ucState = 'unreadable'; }
    if (ucState === 'unreadable') out.push({name: 'user-config', state: 'unreadable'});
    else if (uc !== undefined) take('user-config', uc, true);
    let attr = null, attrState = 'ok';
    try { attr = doc.getElementById?.('application_config')?.getAttribute?.('data-userinfo') ?? null; } catch { attrState = 'unreadable'; }
    if (attrState === 'unreadable') out.push({name: 'userinfo-attr', state: 'unreadable'});
    else if (attr !== null) {
      let parsed, ok = true;
      try { parsed = JSON.parse(attr); } catch { ok = false; } // the parsed object is discarded after the three fields are copied
      if (ok) take('userinfo-attr', parsed, true); else out.push({name: 'userinfo-attr', state: 'malformed'});
    }
    let g, gState = 'ok';
    try { g = win.g_steamID; } catch { gState = 'unreadable'; }
    if (gState === 'unreadable') out.push({name: 'g-steamid', state: 'unreadable'});
    else if (g !== undefined) out.push({name: 'g-steamid', state: 'ok', loggedIn: null, steamid: g, accountid: undefined, requireAccountId: false}); // the legacy global genuinely has no accountid
    return out;
  }
  async function observeIdentity(o = {}, env = {}) {
    const win = env.win ?? window, doc = env.doc ?? document, loc = env.loc ?? location;
    let saltBytes = o.salt !== undefined ? b64uDecode(o.salt) : null, generated = false;
    if (o.salt === undefined && o.candidate === true) { saltBytes = crypto.getRandomValues(new Uint8Array(16)); generated = true; }
    if (!saltBytes || saltBytes.length !== 16) throw new Error('identity needs a 16-byte base64url salt (or candidate: true)');
    const saltCheck = (await sha256HexOf(saltBytes)).slice(0, 8);
    const finish = r => { if (generated) r.salt = b64uEncode(saltBytes); return r; };
    if (!['https://store.steampowered.com', 'https://steamcommunity.com'].includes(loc?.origin)) {
      return finish({version: 1, sources: [], loggedIn: null, consistent: false, problems: ['unsupported-origin'], saltCheck, sessionFingerprint: null, pathFingerprint: null});
    }
    const sources = readSessionSources(win, doc);
    const problems = new Set(), ids = new Set(), states = new Set();
    for (const s of sources) {
      if (s.state === 'unreadable') { problems.add('unreadable-marker'); continue; }
      if (s.state === 'malformed') { problems.add('malformed-marker'); continue; }
      if (s.loggedIn === 'invalid') { problems.add('malformed-marker'); continue; }
      const provided = s.steamid !== undefined && s.steamid !== null && s.steamid !== false && s.steamid !== '' && s.steamid !== 0 && s.steamid !== '0';
      if (s.loggedIn === true && !provided) problems.add('login-state-conflict');
      if (s.loggedIn === false && provided) problems.add('login-state-conflict');
      if (s.loggedIn !== null) states.add(s.loggedIn);
      if (!provided) continue;
      const id = canonicalSteamId64(s.steamid);
      if (!id) { problems.add('invalid-id'); continue; }
      if (s.accountid === undefined) { if (s.requireAccountId) { problems.add('missing-account-id'); continue; } }
      else if (!accountIdMatches(id, s.accountid)) { problems.add('invalid-account-id'); continue; }
      ids.add(id);
      if (s.name === 'g-steamid') states.add(true); // a valid ID in the legacy global means signed in
    }
    if (ids.size > 1) problems.add('id-conflict');
    if (states.size > 1) problems.add('login-state-conflict');
    const loggedIn = states.size === 1 ? [...states][0] : null;
    const consistent = problems.size === 0;
    const fp = async id => sha256HexOf(fingerprintBytes(saltBytes, id));
    const sessionId = ids.size === 1 ? [...ids][0] : null;
    const pathMatch = /\/(?:replay|profiles)\/([0-9]{17})(?=\/|$)/.exec(String(loc?.pathname ?? ''));
    const pathId = pathMatch ? canonicalSteamId64(pathMatch[1]) : null;
    return finish({
      version: 1,
      sources: sources.map(s => s.name),
      loggedIn,
      consistent,
      problems: [...problems].sort(),
      saltCheck,
      sessionFingerprint: consistent && loggedIn === true && sessionId ? await fp(sessionId) : null,
      pathFingerprint: pathId ? await fp(pathId) : null,
    });
  }
  const known = ['salt', 'candidate'];
  for (const k of Object.keys(opts)) if (!known.includes(k)) throw new Error(`unknown option: ${k}`);
  if (opts.salt !== undefined && opts.candidate !== undefined) throw new Error('pass either salt or candidate, not both');
  const result = await observeIdentity({salt: opts.salt, candidate: opts.candidate});
  return {format: 'game-curator-identity-probe', ...result, origin: location.origin};
})({})
