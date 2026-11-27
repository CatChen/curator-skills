// Identity core: canonical SteamID64, salted fingerprint (Node and in-page agree), narrow extraction with decoys, settings v1/v2.
// Synthetic identifiers only. FIXTURE tests: nothing here touches a real Steam session.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {b64uEncode, b64uDecode, canonicalSteamId64, accountIdMatches, fingerprintBytes, sha256HexOf, observeIdentity, readSessionSources} from '../../skills/game-curator/scripts/browser/identity-probe.mjs';
import {parseSettings, fingerprintSync, newSalt, saltCheckOf, BINDING_ALG} from '../../skills/game-curator/scripts/settings.mjs';
import {parseCacheSettings, checkCacheAuthorized} from '../../skills/game-curator/scripts/cache.mjs';
import {collectIdentity} from '../../skills/game-curator/scripts/browser/steam.mjs';
import {buildPageScript} from '../../skills/game-curator/scripts/claude-code/build-page-script.mjs';

const ID_A = '76561197960278073', ACC_A = 12345, ID_B = '76561197960320049', ACC_B = 54321; // synthetic
const SALT = b64uEncode(Uint8Array.from({length: 16}, (_, i) => i + 1));
const j = o => JSON.parse(JSON.stringify(o)); // cross-realm -> plain

// ---- A. canonicalization and fingerprint
assert.equal(canonicalSteamId64(ID_A), ID_A);
assert.equal(canonicalSteamId64(Number(ID_A)), null, 'a number is never accepted (precision loss)');
assert.equal(canonicalSteamId64(76561197960278073n), null, 'a bigint is not a string');
for (const bad of [' ' + ID_A, ID_A + ' ', '+' + ID_A, '0' + ID_A.slice(1), ID_A.slice(1), ID_A + '0', '7656119796027807x', '76561197960265727' /* below base */, '76561202255233024' /* above range */, '', null, undefined, {}, [], false]) assert.equal(canonicalSteamId64(bad), null, `rejects ${String(bad)}`);
assert.ok(canonicalSteamId64('76561197960265728') && canonicalSteamId64('76561202255233023'), 'range ends are accepted');
assert.ok(accountIdMatches(ID_A, ACC_A) && accountIdMatches(ID_A, String(ACC_A)));
assert.ok(!accountIdMatches(ID_A, ACC_B) && !accountIdMatches(ID_A, -1) && !accountIdMatches(ID_A, 1.5) && !accountIdMatches(ID_A, undefined) && !accountIdMatches(Number(ID_A), ACC_A));
// Fixed vector: any change to canonicalization, framing or algorithm must change this value on purpose, in both runtimes.
const VECTOR = fingerprintSync(SALT, ID_A);
assert.equal(VECTOR, 'e4ee28186a1e27f9fc913b17c8d3b229466b5e2af5ec1a6bbadc11c8887caa9d', 'frozen test vector: changing canonicalization, framing or algorithm must be deliberate');
assert.equal(await sha256HexOf(fingerprintBytes(b64uDecode(SALT), ID_A)), VECTOR, 'the in-page async path and the Node path hash the same bytes');
assert.notEqual(fingerprintSync(SALT, ID_B), VECTOR);
assert.notEqual(fingerprintSync(newSalt(), ID_A), VECTOR, 'a different salt gives a different fingerprint');
assert.equal(fingerprintSync(SALT, ID_A), VECTOR, 'stable');
assert.throws(() => fingerprintSync(SALT, Number(ID_A)));
assert.throws(() => fingerprintSync(b64uEncode(new Uint8Array(15)), ID_A), /invalid/);
for (const bad of ['', 'abc=', 'a+b/', 'AAAA AAAA', '*', 'A', null, undefined, 5]) assert.equal(b64uDecode(bad), null, `salt text ${String(bad)}`);
assert.deepEqual([...b64uDecode('AQID')], [1, 2, 3]);
assert.deepEqual([...b64uDecode(b64uEncode(Uint8Array.from([251, 255, 254])))], [251, 255, 254]);
assert.equal(b64uDecode('AQ=='), null, 'padding is not canonical');

// ---- fake page environment
const DECOY = {name: 'decoy_login_name', token: 'decoy-webapi-token-0123456789', cookie: 'decoy-session-cookie-value', persona: 'Decoy Persona'};
function env({userConfig, attr, g, pathname = '/wishlist/id/somevanity/', origin = 'https://store.steampowered.com', rawAttr} = {}) {
  const win = {};
  if (userConfig !== undefined) win.UserConfig = userConfig;
  if (g !== undefined) win.g_steamID = g;
  const attrs = rawAttr !== undefined ? rawAttr : attr === undefined ? null : JSON.stringify(attr);
  const doc = {getElementById: id => id === 'application_config' ? {getAttribute: n => n === 'data-userinfo' ? attrs : n === 'data-store_user_config' ? JSON.stringify({webapi_token: DECOY.token}) : null} : null, cookie: `sessionid=${DECOY.cookie}`};
  return {win, doc, loc: {pathname, origin}};
}
const uc = (id, acc, extra = {}) => ({logged_in: true, steamid: id, accountid: acc, account_name: DECOY.name, persona_name: DECOY.persona, webapi_token: DECOY.token, ...extra});
const leak = o => { const s = JSON.stringify(o); for (const v of [...Object.values(DECOY), ID_A, ID_B, String(ACC_A), String(ACC_B)]) assert.ok(!s.includes(v), `observation leaks ${v}`); };

// ---- B. observation and verdict inputs (fixtures)
{
  const o = j(await observeIdentity({salt: SALT}, env({userConfig: uc(ID_A, ACC_A)})));
  assert.deepEqual(Object.keys(o), ['version', 'sources', 'loggedIn', 'consistent', 'problems', 'saltCheck', 'sessionFingerprint', 'pathFingerprint']); assert.deepEqual(o.problems, []);
  assert.equal(o.loggedIn, true); assert.equal(o.consistent, true); assert.equal(o.sessionFingerprint, VECTOR); assert.equal(o.pathFingerprint, null);
  assert.deepEqual(o.sources, ['user-config']); assert.equal(o.saltCheck, saltCheckOf(SALT)); leak(o);
}
{ // display name changes never matter; the same display name with a different ID does
  const a = j(await observeIdentity({salt: SALT}, env({userConfig: uc(ID_A, ACC_A, {persona_name: 'Renamed'})})));
  const b = j(await observeIdentity({salt: SALT}, env({userConfig: uc(ID_B, ACC_B, {persona_name: DECOY.persona})})));
  assert.equal(a.sessionFingerprint, VECTOR); assert.notEqual(b.sessionFingerprint, VECTOR);
}
{ // every source agrees (replay-style attribute plus legacy global)
  const o = j(await observeIdentity({salt: SALT}, env({attr: {logged_in: true, steamid: ID_A, accountid: ACC_A, account_name: DECOY.name}, g: ID_A})));
  assert.deepEqual(o.sources, ['userinfo-attr', 'g-steamid']); assert.equal(o.consistent, true); assert.equal(o.sessionFingerprint, VECTOR); leak(o);
}
{ // legacy global only (reviews page): logged in is inferred only from a valid ID
  const o = j(await observeIdentity({salt: SALT}, env({g: ID_A}))); assert.equal(o.loggedIn, true); assert.equal(o.sessionFingerprint, VECTOR);
  const none = j(await observeIdentity({salt: SALT}, env({g: ''}))); assert.equal(none.loggedIn, null); assert.equal(none.sessionFingerprint, null);
}
{ // disagreeing sources, a number-typed ID, an inconsistent accountid: ambiguous, never guessed
  for (const e of [env({userConfig: uc(ID_A, ACC_A), g: ID_B}), env({userConfig: uc(Number(ID_A), ACC_A)}), env({userConfig: uc(ID_A, ACC_B)}), env({userConfig: uc('not-an-id', ACC_A)}), env({userConfig: uc(ID_A, ACC_A), attr: {logged_in: true, steamid: ID_B, accountid: ACC_B}})]) {
    const o = j(await observeIdentity({salt: SALT}, e)); assert.equal(o.consistent, false); assert.equal(o.sessionFingerprint, null); leak(o);
  }
}
{ // signed out and missing markers are unobserved, not a crash
  const out = j(await observeIdentity({salt: SALT}, env({userConfig: {logged_in: false}})));
  assert.equal(out.loggedIn, false); assert.equal(out.sessionFingerprint, null);
  const empty = j(await observeIdentity({salt: SALT}, env({})));
  assert.equal(empty.loggedIn, null); assert.equal(empty.sessionFingerprint, null); assert.deepEqual(empty.sources, []);
  const outWithId = j(await observeIdentity({salt: SALT}, env({userConfig: uc(ID_A, ACC_A, {logged_in: false})})));
  assert.equal(outWithId.sessionFingerprint, null, 'logged_in:false never yields a session fingerprint');
}
{ // present-but-unreadable or malformed markers are reported, never silently dropped
  const win = {get UserConfig() { throw new Error('SECRET blocked text'); }, g_steamID: ID_A};
  const o = j(await observeIdentity({salt: SALT}, {win, doc: {getElementById: () => ({getAttribute: () => '{not json'})}, loc: {pathname: '/', origin: 'https://store.steampowered.com'}}));
  assert.deepEqual(o.sources, ['user-config', 'userinfo-attr', 'g-steamid']); assert.deepEqual(o.problems, ['malformed-marker', 'unreadable-marker']); assert.equal(o.consistent, false); assert.equal(o.sessionFingerprint, null, 'a valid g_steamID cannot rescue unreadable or malformed evidence'); assert.ok(!JSON.stringify(o).includes('SECRET'));
  assert.deepEqual(readSessionSources({}, {getElementById: () => null}), [], 'absent markers are simply absent');
  for (const [name, e, code] of [
    ['user config is a string', env({userConfig: 'x'}), 'malformed-marker'], ['user config is an array', env({userConfig: []}), 'malformed-marker'], ['user config is null', env({userConfig: null}), 'malformed-marker'],
    ['attribute is a JSON array', env({rawAttr: '[]'}), 'malformed-marker'], ['attribute is JSON null', env({rawAttr: 'null'}), 'malformed-marker'], ['logged_in is not a boolean', env({userConfig: uc(ID_A, ACC_A, {logged_in: 'yes'})}), 'malformed-marker'],
    ['logged in without an ID', env({userConfig: {logged_in: true, accountid: ACC_A}}), 'login-state-conflict'], ['signed out but an ID is present', env({userConfig: uc(ID_A, ACC_A, {logged_in: false})}), 'login-state-conflict'],
    ['sources disagree about being signed in', env({userConfig: uc(ID_A, ACC_A), attr: {logged_in: false}}), 'login-state-conflict'],
    ['accountid is missing where Steam always sends it', env({userConfig: {logged_in: true, steamid: ID_A}}), 'missing-account-id'], ['accountid is invalid', env({userConfig: uc(ID_A, 'abc')}), 'invalid-account-id'],
    ['accountid belongs to another account', env({userConfig: uc(ID_A, ACC_B)}), 'invalid-account-id'], ['steamid is invalid', env({userConfig: uc('not-an-id', ACC_A)}), 'invalid-id'], ['two sources name different accounts', env({userConfig: uc(ID_A, ACC_A), g: ID_B}), 'id-conflict'],
  ]) { const r = j(await observeIdentity({salt: SALT}, e)); assert.ok(r.problems.includes(code), name + ': ' + JSON.stringify(r.problems)); assert.equal(r.consistent, false, name); assert.equal(r.sessionFingerprint, null, name); leak(r); }
  { // an invalid provided accountid in one marker is never outvoted by a valid second marker
    const r = j(await observeIdentity({salt: SALT}, env({userConfig: uc(ID_A, ACC_A), attr: {logged_in: true, steamid: ID_A, accountid: 999}}))); assert.deepEqual(r.problems, ['invalid-account-id']); assert.equal(r.sessionFingerprint, null);
    const lg = j(await observeIdentity({salt: SALT}, env({userConfig: uc(ID_A, ACC_A), attr: {logged_in: false, steamid: ID_A, accountid: ACC_A}}))); assert.ok(lg.problems.includes('login-state-conflict')); assert.equal(lg.sessionFingerprint, null);
  }
  { // field-level getters that throw are unreadable markers, never raw exception text; accountid must be canonical decimal
    const bad = {get steamid() { throw new Error('SECRET field text'); }, logged_in: true, accountid: ACC_A};
    const r = j(await observeIdentity({salt: SALT}, env({userConfig: bad}))); assert.deepEqual(r.problems, ['unreadable-marker']); assert.equal(r.sessionFingerprint, null); assert.ok(!JSON.stringify(r).includes('SECRET'));
    const z = j(await observeIdentity({salt: SALT}, env({userConfig: uc(ID_A, '0' + ACC_A)}))); assert.ok(z.problems.includes('invalid-account-id'), 'leading zeros are not canonical'); assert.equal(z.sessionFingerprint, null);
  }
  const g = j(await observeIdentity({salt: SALT}, env({g: ID_A}))); assert.deepEqual(g.problems, [], 'the legacy global genuinely has no accountid'); assert.equal(g.sessionFingerprint, VECTOR);
  const out = j(await observeIdentity({salt: SALT}, env({userConfig: {logged_in: false}}))); assert.deepEqual(out.problems, []); assert.equal(out.loggedIn, false, 'explicitly signed out is its own state');
  const none = j(await observeIdentity({salt: SALT}, env({}))); assert.deepEqual(none.problems, []); assert.equal(none.loggedIn, null, 'no markers is a different state again');
  // only supported Steam origins are read at all
  for (const origin of ['https://evil.example', 'https://store.steampowered.com.evil.example', 'http://store.steampowered.com', 'https://steampowered.com', 'https://steamcommunity.com:8443', '']) {
    const r = j(await observeIdentity({salt: SALT}, env({userConfig: uc(ID_A, ACC_A), pathname: `/replay/${ID_A}/2025`, origin}))); assert.deepEqual(r.problems, ['unsupported-origin'], String(origin)); assert.deepEqual(r.sources, []); assert.equal(r.sessionFingerprint, null); assert.equal(r.pathFingerprint, null); leak(r);
  }
  for (const origin of ['https://store.steampowered.com', 'https://steamcommunity.com']) assert.equal(j(await observeIdentity({salt: SALT}, env({userConfig: uc(ID_A, ACC_A), origin}))).sessionFingerprint, VECTOR);
}
{ // URL ID of the page viewed is fingerprinted separately; a vanity URL carries none
  const same = j(await observeIdentity({salt: SALT}, env({userConfig: uc(ID_A, ACC_A), pathname: `/replay/${ID_A}/2025`})));
  assert.equal(same.pathFingerprint, same.sessionFingerprint);
  const other = j(await observeIdentity({salt: SALT}, env({userConfig: uc(ID_A, ACC_A), pathname: `/replay/${ID_B}/2025`})));
  assert.notEqual(other.pathFingerprint, other.sessionFingerprint); assert.equal(other.pathFingerprint, fingerprintSync(SALT, ID_B)); leak(other);
  const prof = j(await observeIdentity({salt: SALT}, env({userConfig: uc(ID_A, ACC_A), pathname: `/profiles/${ID_B}/recommended`}))); assert.equal(prof.pathFingerprint, fingerprintSync(SALT, ID_B));
  const bad = j(await observeIdentity({salt: SALT}, env({userConfig: uc(ID_A, ACC_A), pathname: '/replay/99999999999999999/2025'}))); assert.equal(bad.pathFingerprint, null);
}
{ // salt handling: required, strict, candidate generates a fresh one
  await assert.rejects(() => observeIdentity({}, env({userConfig: uc(ID_A, ACC_A)})), /salt/);
  await assert.rejects(() => observeIdentity({salt: 'short'}, env({})), /salt/);
  await assert.rejects(() => observeIdentity({salt: b64uEncode(new Uint8Array(15))}, env({})), /salt/);
  const c1 = j(await observeIdentity({candidate: true}, env({userConfig: uc(ID_A, ACC_A)}))), c2 = j(await observeIdentity({candidate: true}, env({userConfig: uc(ID_A, ACC_A)})));
  assert.equal(b64uDecode(c1.salt).length, 16); assert.notEqual(c1.salt, c2.salt); assert.equal(c1.sessionFingerprint, fingerprintSync(c1.salt, ID_A)); assert.equal(c1.saltCheck, saltCheckOf(c1.salt)); leak(c1);
  const fixed = j(await observeIdentity({salt: SALT}, env({userConfig: uc(ID_A, ACC_A)}))); assert.ok(!('salt' in fixed), 'a supplied salt is not echoed');
}

// ---- generated page script: same behavior in the real artifact, no leaks, strict options
{
  const source = fs.readFileSync(new URL('../../skills/game-curator/scripts/claude-code/steam-identity-page.js', import.meta.url), 'utf8');
  assert.equal(source, buildPageScript('identity'), 'steam-identity-page.js is stale: run node build-page-script.mjs');
  const run = async (opts, e) => {
    const ctx = vm.createContext({window: e.win, document: e.doc, location: {origin: 'https://store.steampowered.com', pathname: e.loc.pathname}, crypto: globalThis.crypto, TextEncoder, btoa, atob, JSON, Object, Array, Error, Promise, Uint8Array, BigInt, String, Number, Math, Set, Map, RegExp});
    ctx.UserConfig = e.win.UserConfig; ctx.g_steamID = e.win.g_steamID; // page globals resolve on window in a real page
    return j(await vm.runInContext(`(async () => (${source.replace(/^(?:\/\/.*\n)*await /, '').replace(/\}\)\(\{\}\)\s*$/, `})(${JSON.stringify(opts)})`)}))()`, ctx));
  };
  const r = await run({salt: SALT}, env({userConfig: uc(ID_A, ACC_A)}));
  assert.equal(r.format, 'game-curator-identity-probe'); assert.equal(r.sessionFingerprint, VECTOR); assert.equal(r.origin, 'https://store.steampowered.com'); leak(r);
  const c = await run({candidate: true}, env({userConfig: uc(ID_B, ACC_B)})); assert.equal(c.sessionFingerprint, fingerprintSync(c.salt, ID_B)); leak(c);
  await assert.rejects(() => run({salt: SALT, extra: 1}, env({})), /unknown option/);
  await assert.rejects(() => run({salt: SALT, candidate: true}, env({})), /either salt or candidate/);
  await assert.rejects(() => run({}, env({})), /salt/);
  // the generated text must not touch the surrounding objects, cookies or tokens by name
  for (const forbidden of ['document.cookie', 'webapi_token', 'account_name', 'localStorage', 'sessionStorage', 'fetch(', 'XMLHttpRequest']) assert.ok(!source.includes(forbidden), `generated probe mentions ${forbidden}`);
}


// ---- Codex collector: same fingerprints, and an honest unobserved result when the runtime refuses page evaluation (fixture; the real Codex runtime is exercised live)
{
  const e = env({userConfig: uc(ID_A, ACC_A)});
  const tab = {playwright: {evaluate: async fn => {
    const ctx = vm.createContext({window: e.win, document: e.doc, location: e.loc, crypto: globalThis.crypto, TextEncoder, btoa, atob, JSON, Object, Array, Error, Promise, Uint8Array, BigInt, String, Number, Math, Set, Map, RegExp});
    ctx.UserConfig = e.win.UserConfig;
    return j(await vm.runInContext('(' + fn.toString() + ')()', ctx));
  }}};
  const r = j(await collectIdentity(tab, {salt: SALT}));
  assert.equal(r.available, true); assert.equal(r.sessionFingerprint, VECTOR); leak(r);
  const c = j(await collectIdentity(tab, {candidate: true})); assert.equal(c.sessionFingerprint, fingerprintSync(c.salt, ID_A));
  assert.deepEqual(j(await collectIdentity({}, {salt: SALT})), {available: false, reason: 'no read-only page evaluation in this runtime'});
  const refused = j(await collectIdentity({playwright: {evaluate: async () => { throw new Error('evaluation is not permitted SECRET'); }}}, {salt: SALT}));
  assert.equal(refused.available, false); assert.ok(!('sessionFingerprint' in refused)); assert.equal(refused.reason, 'page evaluation was refused or failed'); assert.ok(!JSON.stringify(refused).includes('SECRET'), 'runtime exception text is never returned');
  const nosalt = j(await collectIdentity({playwright: {evaluate: async fn => { const ctx = vm.createContext({crypto: globalThis.crypto, TextEncoder, btoa, atob, window: {}, document: e.doc, location: e.loc, Error, Promise, JSON}); return j(await vm.runInContext('(' + fn.toString() + ')()', ctx)); }}}, {}));
  assert.equal(nosalt.available, false, 'neither salt nor candidate: refused, never a guess');
}

// (the identity option of the collectors is exercised against the real generated page scripts in test_identity_collectors.mjs)

// ---- D. settings v1 / v2 reader (fixtures; no production file is read)
const goodV2 = (extra = {}) => ({version: 2, persistence: {profileAndFeedback: true, steamCache: true}, steamAccount: {alias: 'my-steam', fingerprint: {alg: BINDING_ALG, salt: SALT, value: VECTOR}, approvedAt: '2026-11-26T00:00:00Z', generation: 'AAAAAAAAAAAAAAAAAAAAAA'}, ...extra});
assert.deepEqual(parseSettings({version: 1, persistence: {profileAndFeedback: true, steamCache: false}}), {version: 1, persistence: {profileAndFeedback: true, steamCache: false}, steamAccount: null});
assert.equal(parseSettings(goodV2()).steamAccount.alias, 'my-steam');
assert.equal(parseSettings({version: 2, persistence: {profileAndFeedback: false, steamCache: true}}).steamAccount, null, 'v2 without a binding is valid');
assert.deepEqual(parseCacheSettings(goodV2()), {profileAndFeedback: true, steamCache: true});
const clone = () => JSON.parse(JSON.stringify(goodV2()));
const invalids = {
  'unknown version': {version: 3, persistence: {profileAndFeedback: true, steamCache: true}}, 'v1 with a binding': {version: 1, persistence: {profileAndFeedback: true, steamCache: true}, steamAccount: goodV2().steamAccount},
  'v2 extra top key': goodV2({extra: 1}), 'v2 non-boolean': {version: 2, persistence: {profileAndFeedback: 'yes', steamCache: true}}, 'v2 missing persistence': {version: 2},
  'array instead of binding': goodV2({steamAccount: [goodV2().steamAccount]}), 'null binding': goodV2({steamAccount: null}),
};
for (const [name, bad] of Object.entries(invalids)) assert.throws(() => parseSettings(bad), /invalid|unsupported/, name);
for (const [name, mutate] of Object.entries({
  'extra binding key': s => { s.steamAccount.steamid = ID_A; }, 'extra fingerprint key': s => { s.steamAccount.fingerprint.extra = 1; }, 'unsafe alias': s => { s.steamAccount.alias = '../x'; }, 'empty alias': s => { s.steamAccount.alias = ''; },
  'missing generation': s => { delete s.steamAccount.generation; }, 'short generation': s => { s.steamAccount.generation = b64uEncode(new Uint8Array(15)); }, 'array generation': s => { s.steamAccount.generation = ['AAAAAAAAAAAAAAAAAAAAAA']; }, 'padded generation': s => { s.steamAccount.generation = 'AAAAAAAAAAAAAAAAAAAAAA=='; },
  'unknown alg': s => { s.steamAccount.fingerprint.alg = 'md5'; }, 'short salt': s => { s.steamAccount.fingerprint.salt = b64uEncode(new Uint8Array(15)); }, 'padded salt': s => { s.steamAccount.fingerprint.salt = SALT + '=='; },
  'array fingerprint value': s => { s.steamAccount.fingerprint.value = [VECTOR]; }, 'array alias': s => { s.steamAccount.alias = ['my-steam']; }, 'array salt': s => { s.steamAccount.fingerprint.salt = [SALT]; }, 'array time': s => { s.steamAccount.approvedAt = ['2026-11-26T00:00:00Z']; }, 'array alg': s => { s.steamAccount.fingerprint.alg = [BINDING_ALG]; },
  'uppercase value': s => { s.steamAccount.fingerprint.value = VECTOR.toUpperCase(); }, 'short value': s => { s.steamAccount.fingerprint.value = VECTOR.slice(1); }, 'bad time': s => { s.steamAccount.approvedAt = 'yesterday'; }, 'missing time': s => { delete s.steamAccount.approvedAt; },
})) { const s = clone(); mutate(s); assert.throws(() => parseSettings(s), /invalid/, name); assert.throws(() => parseCacheSettings(s), /invalid/, `${name} fails closed for consent too`); }
assert.ok(!JSON.stringify(parseSettings(goodV2())).includes(ID_A), 'no identifier in the parsed record');

// consent check reads v1 and v2 files (scratch home), fails closed on a malformed v2, and a binding never grants cache consent
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-identity-')), cache = path.join(home, 'cache', 'steam'); fs.mkdirSync(cache, {recursive: true});
  const write = o => fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(o));
  write(goodV2()); assert.ok(checkCacheAuthorized(cache));
  write({...goodV2(), persistence: {profileAndFeedback: true, steamCache: false}}); assert.throws(() => checkCacheAuthorized(cache), /steamCache false/, 'a binding does not authorize the cache');
  write({version: 1, persistence: {profileAndFeedback: false, steamCache: true}}); assert.ok(checkCacheAuthorized(cache));
  const bad = goodV2(); bad.steamAccount.fingerprint.salt = 'x'; write(bad); assert.throws(() => checkCacheAuthorized(cache), /not a valid/);
  fs.rmSync(home, {recursive: true, force: true});
}

console.log('identity core fixture checks passed');
