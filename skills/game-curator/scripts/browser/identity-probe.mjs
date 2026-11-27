// Narrow, read-only Steam identity extraction shared by the Claude page scripts, the Codex collector and the Node saver.
// Every function here relies only on page globals and on the others (they are inlined as text into generated page
// scripts, like the *-rows.mjs modules), so the canonical ID rules and the fingerprint bytes are the same everywhere.
//
// Privacy contract: only three fields are ever read by name (logged_in, steamid, accountid) from Steam's own page data
// (window.UserConfig, #application_config[data-userinfo], window.g_steamID). The surrounding objects, login names, tokens
// and cookies are never copied, serialized or returned. The raw SteamID64 never leaves this module: callers only ever see
// a salted fingerprint of it.

// Unpadded base64url (RFC 4648 §5) without Buffer, so the same code runs in a page and in Node.
export function b64uEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Strict decode: canonical unpadded base64url only. Returns a Uint8Array or null.
export function b64uDecode(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) return null;
  try {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return b64uEncode(out) === text ? out : null;
  } catch { return null; }
}

// Canonical SteamID64: a decimal STRING of 17 digits inside the individual-account range. A JavaScript number is rejected
// (IDs above 2^53 lose precision), as are whitespace, signs, other lengths and ranges. Returns the string or null.
export function canonicalSteamId64(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{16}$/.test(value)) return null;
  const n = BigInt(value);
  const base = 76561197960265728n; // individual-account base; a constant local to the function so the inlined page text stays self-contained
  return n >= base && n <= base + 4294967295n ? value : null;
}

// accountid must equal steamid64 - base. A number or a digit string are both accepted (32-bit values are exact in a number).
export function accountIdMatches(steamid64, accountid) {
  const id = canonicalSteamId64(steamid64);
  if (!id) return false;
  const a = typeof accountid === 'number' ? (Number.isSafeInteger(accountid) && accountid >= 0 ? BigInt(accountid) : null)
    : typeof accountid === 'string' && /^[0-9]{1,10}$/.test(accountid) ? BigInt(accountid) : null;
  return a !== null && BigInt(id) - 76561197960265728n === a;
}

// The bytes that are hashed: utf8("curator/steam-account/v1") 00 salt 00 utf8(canonical SteamID64).
export function fingerprintBytes(saltBytes, steamid64) {
  const enc = new TextEncoder(), head = enc.encode('curator/steam-account/v1'), id = enc.encode(steamid64);
  const out = new Uint8Array(head.length + 1 + saltBytes.length + 1 + id.length);
  out.set(head, 0); out[head.length] = 0; out.set(saltBytes, head.length + 1); out[head.length + 1 + saltBytes.length] = 0; out.set(id, head.length + 2 + saltBytes.length);
  return out;
}

export async function sha256HexOf(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Read ONLY the allowlisted fields. `win` and `doc` are injectable for tests; in a page they default to window and document.
export function readSessionSources(win = window, doc = document) {
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

// Observe who is signed in. Returns an observation that contains fingerprints only, never an identifier.
//   o.salt       base64url salt (16 bytes) of the approved binding, or
//   o.candidate  true: generate a fresh salt and return it as `salt` (standalone bind probe only).
// The fingerprint of the page's own URL ID (replay/profiles paths) is returned separately so a caller can compare the page being
// viewed with the signed-in account; a vanity URL has no ID and yields null.
export async function observeIdentity(o = {}, env = {}) {
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
