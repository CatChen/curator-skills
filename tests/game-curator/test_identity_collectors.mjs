// Identity continuity and ownership through the REAL collectors: the generated page scripts run against the simulated Steam pages
// (wishlist, library, reviews, Replay), their output goes through the real hook grammar and staging or a native tool-result file, and the
// real saver CLI decides against a scratch cache and a bound scratch settings file. Synthetic data only; no production file is touched.
// FIXTURE tests: the sign-in switches, expiries and sign-outs are simulated by the fake pages (they are not exercised on a live session).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fingerprintSync, newSalt, saltCheckOf, readSettingsFile} from '../../skills/game-curator/scripts/settings.mjs';
import {planBinding} from '../../skills/game-curator/scripts/bind-account.mjs';
import {handleHook, identifyCall} from '../../skills/game-curator/scripts/claude-code/capture-hook.mjs';
import {HOOK_TOOLS, STAGING_DIR} from '../../skills/game-curator/scripts/claude-code/save-capture.mjs';
import {makeWishlistPage} from './fake-wishlist-dom.mjs';
import {makeLibraryPage} from './fake-library-dom.mjs';
import {makeReviewsSite} from './fake-reviews-site.mjs';
import {makeReplaySite} from './fake-replay-site.mjs';

const saver = fileURLToPath(new URL('../../skills/game-curator/scripts/claude-code/save-capture.mjs', import.meta.url));
const scriptsDir = new URL('../../skills/game-curator/scripts/claude-code/', import.meta.url).pathname;
const ID_A = '76561197960278073', ACC_A = 12345, ID_B = '76561197960320049', ACC_B = 54321; // synthetic
const DECOYS = [ID_A, ID_B, String(ACC_A), String(ACC_B), 'decoy_login_name', 'decoy-webapi-token-0123456789'];
const j = o => JSON.parse(JSON.stringify(o));
const uc = (id, acc) => ({logged_in: true, steamid: id, accountid: acc, account_name: 'decoy_login_name', webapi_token: 'decoy-webapi-token-0123456789'});
const A = () => uc(ID_A, ACC_A), B = () => uc(ID_B, ACC_B), OUT = () => ({logged_in: false});
const tmp = [];

function home() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-idcollect-')); tmp.push(root);
  const dest = path.join(root, 'cache', 'steam'); fs.mkdirSync(dest, {recursive: true, mode: 0o700});
  const file = path.join(root, 'settings.json'); fs.writeFileSync(file, JSON.stringify({version: 1, persistence: {profileAndFeedback: false, steamCache: true}}, null, 2) + '\n', {mode: 0o600});
  const salt = newSalt(), probe = {format: 'game-curator-identity-probe', version: 1, sources: ['user-config'], loggedIn: true, consistent: true, problems: [], origin: 'https://store.steampowered.com', saltCheck: saltCheckOf(salt), sessionFingerprint: fingerprintSync(salt, ID_A), pathFingerprint: null, salt};
  const plan = planBinding(file, {op: 'bind', probe, alias: 'my-steam'});
  planBinding(file, {op: 'bind', probe, alias: 'my-steam', apply: true, expect: {settingsSha256: plan.settingsSha256, candidateSha256: plan.candidateSha256}});
  return {root, dest, file, salt, gen: readSettingsFile(file).settings.steamAccount.generation};
}
const viewArgs = source => (source === 'wishlist' ? ['--view', 'unfiltered'] : []);
function saveNative(h, env, extra = []) { // a native tool-result file, as the runtime writes for a large result
  const input = path.join(h.root, 'tool-result.json');
  fs.writeFileSync(input, JSON.stringify([{type: 'text', text: JSON.stringify(env)}]), {mode: 0o600});
  return cli(h, [input, '--provenance', 'tool-result', ...viewArgs(env.source), ...extra]);
}
function cli(h, args) {
  const r = spawnSync(process.execPath, [saver, ...args, '--dest', h.dest], {encoding: 'utf8'});
  const out = {status: r.status, err: r.stderr, out: r.stdout}; try { out.json = JSON.parse(r.stdout); } catch { out.json = null; } return out;
}
const sortKeys = v => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v);
const IAB = '\n\n(captured at origin https://store.steampowered.com)', TAB = '\n\nTab Context:\n- Executed on tabId: seed';
const response = value => [{type: 'text', text: JSON.stringify(sortKeys(value), null, 2) + IAB}, {type: 'text', text: TAB}];
const PAGES = {wishlist: 'steam-wishlist-page.js', library: 'steam-library-page.js', reviews: 'steam-reviews-page.js', replay: 'steam-replay-page.js'};
const callText = (source, literal) => fs.readFileSync(path.join(scriptsDir, PAGES[source]), 'utf8').replace(/\(\{\}\)\s*$/, '') + literal;
// The runtime's hook: stage the inline result exactly as the real hook would, then hand the staged file to the real saver.
function viaHook(h, env, source, literal, extra = []) {
  const payload = {hook_event_name: 'PostToolUse', tool_name: HOOK_TOOLS[0], tool_use_id: 'toolu_synthetic', tool_input: {action: 'javascript_exec', text: callText(source, literal)}, tool_response: response(env)};
  const message = handleHook(payload, {dest: h.dest, settings: h.file});
  const dir = path.join(h.dest, STAGING_DIR), staged = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.json') && !n.endsWith('.meta.json')) : [];
  assert.equal(staged.length, 1, `the hook staged the ${source} result: ${message}`);
  const r = cli(h, [path.join(dir, staged[0]), '--provenance', 'hook-capture', ...viewArgs(source), ...extra]);
  return {...r, message};
}
const noLeak = (text, label) => { for (const v of DECOYS) assert.ok(!text.includes(v), `${label} leaks ${v}`); };
function scan(dir) { for (const n of fs.readdirSync(dir, {withFileTypes: true})) { const p = path.join(dir, n.name); if (n.isDirectory()) scan(p); else noLeak(fs.readFileSync(p, 'utf8'), p); } }
// A UserConfig that changes after n reads (one read per observation): models a switch, a sign-out or an expiry in the middle of a run.
const after = (n, first, then) => { let reads = 0; return () => (++reads <= n ? first() : then()); };
const setUser = (holder, v) => Object.defineProperty(holder, 'userConfig', {get: typeof v === 'function' ? v : () => v, configurable: true});

async function runWishlist(p, opts) { let r = j(await p.run(opts)); for (let i = 0; i < 400 && !r.format; i++) r = j(await p.run({})); return r; }
async function runLibrary(p, opts) { let r = j(await p.run({quietMs: 60, stallMs: 80, ...opts})); for (let i = 0; i < 100 && !r.format; i++) r = j(await p.run({})); return r; }
async function drive(site, first, resume = first) { let r = j(await site.runFile(first)); for (let i = 0; r.status === 'continue' && i < 40; i++) { site.navigate(r.next); r = j(await site.runFile(resume)); } return r; }

try {
  // ======== hook grammar: the documented bound call must stage (and nothing looser may)
  {
    const h = home(), lit = `({deliver: 'hook', identity: {salt: '${h.salt}'}})`;
    for (const source of Object.keys(PAGES)) {
      const c = identifyCall({action: 'javascript_exec', text: callText(source, lit)}, scriptsDir); assert.equal(c?.source, source); assert.equal(c.optIn, true, `${source}: the bound run opts in to hook delivery`);
      const reordered = identifyCall({action: 'javascript_exec', text: callText(source, `({identity: {salt: "${h.salt}"}, deliver: 'hook'})`)}, scriptsDir); assert.equal(reordered?.optIn, true);
      for (const bad of [`({deliver: 'hook', identity: {salt: '${h.salt}', extra: 1}})`, `({deliver: 'hook', identity: {salt: 'short'}})`, `({deliver: 'hook', identity: {salt: '${h.salt}'}, identity: {salt: '${h.salt}'}})`, `({deliver: 'hook', identity: true})`,
        `({deliver: {salt: '${h.salt}'}})`, `({deliver: 'hook', identity: {salt: '${h.salt}'}}); fetch('x')`, `({deliver: 'hook', identity: {salt: '${h.salt}'}, nested: {salt: '${h.salt}'}})`, `({deliver: 'hook', identity: {salt: '${h.salt}' + 'x'}})`]) {
        assert.equal(identifyCall({action: 'javascript_exec', text: callText(source, bad)}, scriptsDir), null, `${source}: ${bad} is not a recognized run`);
      }
    }
    for (const lit of [`({deliver: 'hook', identity: {salt: '${h.salt}'}})`, `({deliver: 'hook'})`, `({identity: {salt: '${h.salt}'}, deliver: 'hook'})`]) assert.equal(identifyCall({action: 'javascript_exec', text: `await window.__gcReviewsRun${lit}`}, scriptsDir)?.optIn, true, `resume ${lit}`);
    assert.equal(identifyCall({action: 'javascript_exec', text: `await window.__gcReviewsRun({deliver: 'hook', identity: {salt: 'x'}})`}, scriptsDir), null);
  }

  // ======== wishlist (single page, resume inside page state)
  for (const how of ['native', 'hook']) {
    const h = home(), p = makeWishlistPage({n: 30}); setUser(p.state, A);
    const env = await runWishlist(p, {identity: {salt: h.salt}, deliver: 'hook'});
    assert.equal(env.diagnostics.stopReason, 'complete'); const id = env.diagnostics.identity;
    assert.ok(id.continuity.checks >= 2 && id.continuity.stable === true, 'start and end of the run were both observed'); assert.equal(id.owner, true); assert.equal(id.sessionFingerprint, fingerprintSync(h.salt, ID_A)); noLeak(JSON.stringify(env), 'wishlist envelope');
    const r = how === 'native' ? saveNative(h, env) : viaHook(h, env, 'wishlist', `({deliver: 'hook', identity: {salt: '${h.salt}'}})`);
    assert.equal(r.status, 0, r.err); assert.equal(r.json.action, 'create', `wishlist ${how}`); assert.equal(r.json.identity.result, 'match');
    const saved = JSON.parse(fs.readFileSync(path.join(h.dest, 'wishlist.json'), 'utf8')); assert.equal(saved.account, 'my-steam'); assert.equal(saved.accessScope, 'signed-in'); assert.equal(saved.diagnostics.attestations.identity.generation, h.gen);
    assert.ok(!('identity' in saved.diagnostics)); scan(h.root);
  }
  { // a switch to another account in the middle of the run: the run stops, keeps its coherent batches, and nothing is promoted
    const h = home(), p = makeWishlistPage({n: 40}); setUser(p.state, after(2, A, B));
    const env = await runWishlist(p, {identity: {salt: h.salt}, identityEveryMs: 0});
    assert.equal(env.diagnostics.stopReason, 'identity-changed'); assert.equal(env.diagnostics.complete, false); assert.ok(env.records.length < 40, 'collection stopped early'); assert.equal(env.diagnostics.identity.continuity.stable, false);
    assert.ok(env.records.every((r, i) => r.rank === i + 1) || env.records.length > 0); noLeak(JSON.stringify(env), 'switched wishlist');
    const r = saveNative(h, env); assert.equal(r.json.action, 'separate'); assert.match(r.json.reason, /incomplete|ambiguous/); assert.ok(!fs.existsSync(path.join(h.dest, 'wishlist.json')));
    assert.equal(saveNative(h, env, ['--account', 'my-steam', '--access-scope', 'signed-in']).status, 1, 'a manual alias cannot override a changed identity');
  }
  { // sign-out / expiry in the middle of the run
    const h = home(), p = makeWishlistPage({n: 40}); setUser(p.state, after(2, A, OUT));
    const env = await runWishlist(p, {identity: {salt: h.salt}, identityEveryMs: 0});
    assert.equal(env.diagnostics.stopReason, 'identity-changed'); assert.equal(env.diagnostics.complete, false);
    assert.equal(saveNative(h, env).json.action, 'separate');
  }
  { // identity changes only at the very end: the final observation catches it even for a short run
    const h = home(), p = makeWishlistPage({n: 8}); setUser(p.state, after(1, A, B));
    const env = await runWishlist(p, {identity: {salt: h.salt}, identityEveryMs: 100000});
    assert.equal(env.diagnostics.identity.continuity.stable, false); assert.notEqual(env.diagnostics.stopReason, 'complete');
    assert.equal(saveNative(h, env).json.action, 'separate');
  }
  { // a different account from the start (the bound account is A): the run completes, but nothing reaches the verified cache
    const h = home(), p = makeWishlistPage({n: 12}); setUser(p.state, B);
    const env = await runWishlist(p, {identity: {salt: h.salt}}); assert.equal(env.diagnostics.stopReason, 'complete');
    const r = saveNative(h, env); assert.equal(r.json.action, 'separate'); assert.match(r.json.reason, /mismatch/);
    assert.equal(saveNative(h, env, ['--account', 'my-steam', '--access-scope', 'signed-in']).status, 1);
  }
  { // extraction unavailable (no markers): collection proceeds; manual confirmation remains and is recorded as such
    const h = home(), p = makeWishlistPage({n: 12}); setUser(p.state, undefined);
    const env = await runWishlist(p, {identity: {salt: h.salt}}); assert.equal(env.diagnostics.stopReason, 'complete'); assert.equal(env.diagnostics.identity.loggedIn, null);
    assert.equal(saveNative(h, env).json.action, 'separate');
    const r = saveNative(h, env, ['--account', 'my-steam', '--access-scope', 'signed-in']); assert.equal(r.json.action, 'create');
    const saved = JSON.parse(fs.readFileSync(path.join(h.dest, 'wishlist.json'), 'utf8')); assert.deepEqual(saved.diagnostics.attestations.identity, {by: 'user', result: 'unobserved', basis: 'manual-confirmation', ownership: 'unverified', generation: h.gen});
  }
  { // explicitly signed out from the start: a known state, not "unavailable": no manual override
    const h = home(), p = makeWishlistPage({n: 12}); setUser(p.state, OUT);
    const env = await runWishlist(p, {identity: {salt: h.salt}});
    { const r0 = saveNative(h, env); assert.equal(r0.json.action, 'separate'); assert.match(r0.json.reason, /signed-out/); }
    assert.equal(saveNative(h, env, ['--account', 'my-steam', '--access-scope', 'signed-in']).status, 1);
  }
  { // no identity option: the collector is exactly as before (no observation, manual flow)
    const h = home(), p = makeWishlistPage({n: 10}); setUser(p.state, A);
    const env = await runWishlist(p, {}); assert.ok(!('identity' in env.diagnostics));
    assert.equal(saveNative(h, env).json.action, 'separate');
  }

  // ======== library
  {
    const h = home(), p = makeLibraryPage({n: 30}); setUser(p.state, A);
    const env = await runLibrary(p, {identity: {salt: h.salt}, deliver: 'hook'});
    assert.equal(env.diagnostics.stopReason, 'complete'); assert.ok(env.diagnostics.identity.continuity.checks >= 2 && env.diagnostics.identity.continuity.stable); assert.equal(env.diagnostics.identity.owner, true);
    const r = viaHook(h, env, 'library', `({deliver: 'hook', identity: {salt: '${h.salt}'}})`); assert.equal(r.status, 0, r.err); assert.equal(r.json.action, 'create'); assert.equal(r.json.identity.ownership, 'verified');
    scan(h.root);
  }
  {
    for (const [name, to] of [['switch', B], ['expiry', OUT]]) {
      const h = home(), p = makeLibraryPage({n: 200, chunk: 20, chunkMs: 40}); setUser(p.state, after(5, A, to));
      const env = await runLibrary(p, {identity: {salt: h.salt}, identityEveryMs: 0});
      assert.equal(env.diagnostics.stopReason, 'identity-changed', name); assert.ok(env.records.length < 200); assert.equal(env.diagnostics.complete, false);
      assert.equal(saveNative(h, env).json.action, 'separate', name);
    }
  }

  // ======== reviews (several pages, each a real navigation; sessionStorage carries the data and the identity state)
  {
    const h = home(), site = makeReviewsSite({total: 25, perPage: 10}); setUser(site, A);
    const env = await drive(site, {identity: {salt: h.salt}, deliver: 'hook'}, {deliver: 'hook'}); // the identity option is remembered across the resume calls
    assert.equal(env.diagnostics.stopReason, 'complete'); assert.ok(env.diagnostics.identity.continuity.checks >= 4 && env.diagnostics.identity.continuity.stable === true, 'checked at every page and at the end'); noLeak(JSON.stringify(env), 'reviews envelope');
    const r = viaHook(h, env, 'reviews', `({deliver: 'hook'})`); assert.equal(r.status, 0, r.err); assert.equal(r.json.action, 'create'); assert.equal(r.json.identity.result, 'match');
    assert.ok(!JSON.stringify(site.state() ?? {}).includes(ID_A), 'the carried state never holds an identifier'); scan(h.root);
  }
  for (const [name, to] of [['switch', B], ['expiry', OUT]]) { // identity changes before the second page: its rows are not merged; only coherent batches are kept
    const h = home(), site = makeReviewsSite({total: 25, perPage: 10}); setUser(site, () => (site.visits.length >= 2 ? to() : A()));
    const env = await drive(site, {identity: {salt: h.salt}});
    assert.equal(env.diagnostics.stopReason, 'identity-changed', name); assert.equal(env.records.length, 10, 'only the first page was merged'); assert.equal(env.diagnostics.complete, false);
    const r = saveNative(h, env); assert.equal(r.json.action, 'separate', name); assert.ok(!fs.existsSync(path.join(h.dest, 'reviews.json')));
    assert.equal(saveNative(h, env, ['--account', 'my-steam', '--access-scope', 'signed-in']).status, 1, `${name}: no manual override`);
  }
  { // a single-page run still has a start and an end observation; no markers -> unobserved, never a match
    const h = home(), site = makeReviewsSite({total: 5, perPage: 10}); setUser(site, A);
    const env = await drive(site, {identity: {salt: h.salt}}); assert.equal(env.diagnostics.identity.continuity.checks, 2); assert.equal(saveNative(h, env).json.action, 'create');
    const h2 = home(), site2 = makeReviewsSite({total: 5, perPage: 10}); setUser(site2, undefined);
    const env2 = await drive(site2, {identity: {salt: h2.salt}}); assert.equal(env2.diagnostics.stopReason, 'complete'); assert.equal(saveNative(h2, env2).json.action, 'separate');
    const h3 = home(), site3 = makeReviewsSite({total: 5, perPage: 10, owner: false}); setUser(site3, A); // signed in as the bound account on a public view: not owner evidence
    const env3 = await drive(site3, {identity: {salt: h3.salt}}); const r3 = saveNative(h3, env3); assert.equal(r3.json.action, 'separate'); assert.match(r3.json.reason, /ownership is not verified/);
  }
  { // tampered carried state is rejected, not trusted
    const h = home(), site = makeReviewsSite({total: 25, perPage: 10}); setUser(site, A);
    const first = j(await site.runFile({identity: {salt: h.salt}})); assert.equal(first.status, 'continue');
    const st = site.state(); st.identity.last.sessionFingerprint = 'not-a-fingerprint'; site.store.set('gcReviews', JSON.stringify(st));
    site.navigate(first.next); const next = j(await site.runFile({})); assert.ok(next.status === 'continue' || next.format, 'a discarded state starts a fresh run'); assert.ok(!next.format || next.records.length <= 10);
  }

  // ======== Replay (one navigation per year; each year's observation is bound to its own page)
  {
    const h = home(), site = makeReplaySite(); setUser(site, A);
    const env = await drive(site, {identity: {salt: h.salt}, deliver: 'hook'}, {deliver: 'hook'});
    assert.equal(env.diagnostics.stopReason, 'complete'); assert.equal(env.diagnostics.identityYears.length, 4); assert.ok(env.diagnostics.identityYears.every(y => y.owner === true && y.sessionFingerprint === fingerprintSync(h.salt, ID_A)));
    assert.ok(env.diagnostics.identity.continuity.checks >= 5 && env.diagnostics.identity.continuity.stable); noLeak(JSON.stringify(env), 'replay envelope');
    const r = viaHook(h, env, 'replay', `({deliver: 'hook'})`); assert.equal(r.status, 0, r.err);
    assert.deepEqual(r.json.years.map(y => y.action), ['create', 'create', 'create', 'create']);
    for (const y of [2022, 2023, 2024, 2025]) { const f = JSON.parse(fs.readFileSync(path.join(h.dest, 'replay', `${y}.json`), 'utf8')); assert.equal(f.account, 'my-steam'); assert.equal(f.diagnostics.attestations.identity.result, 'match'); assert.ok(!('identityYears' in f.diagnostics) && !('identity' in f.diagnostics)); }
    scan(h.root);
  }
  { // one year's own page contradicts its URL: only that year is held back; the others are verified on their own pages
    const h = home(), site = makeReplaySite(); setUser(site, A);
    const env = await drive(site, {identity: {salt: h.salt}});
    const other = fingerprintSync(h.salt, ID_B); env.diagnostics.identityYears.find(y => y.year === 2023).pathFingerprint = other;
    const r = saveNative(h, env); assert.equal(r.status, 0, r.err);
    const byYear = Object.fromEntries(r.json.years.map(y => [y.year, y.action])); assert.deepEqual(byYear, {2022: 'create', 2023: 'separate', 2024: 'create', 2025: 'create'});
    assert.match(r.json.years.find(y => y.year === 2023).reason, /ambiguous/);
  }
  for (const [name, to] of [['switch', B], ['expiry', OUT]]) { // the account changes while navigating to the third report
    const h = home(), site = makeReplaySite(); setUser(site, () => (site.visits.length >= 3 ? to() : A()));
    const env = await drive(site, {identity: {salt: h.salt}});
    assert.equal(env.diagnostics.stopReason, 'identity-changed', name); assert.equal(env.records.length, 2, 'only the reports collected before the change'); assert.equal(env.diagnostics.identityYears.length, 2);
    const r = saveNative(h, env); assert.equal(r.status, 0, r.err); assert.ok(r.json.years.every(y => y.action === 'separate'), `${name}: nothing promoted`); assert.ok(!fs.existsSync(path.join(h.dest, 'replay', '2025.json')));
  }
  { // a year whose own report shows no owner control cannot be verified even though the same account is signed in
    const h = home(), site = makeReplaySite({owner: false}); setUser(site, A);
    const env = await drive(site, {identity: {salt: h.salt}}); const r = saveNative(h, env); assert.ok(r.json.years.every(y => y.action === 'separate'));
  }

  // ======== identity added only on a resume call (or re-salted) never attests the earlier batches
  {
    const h = home(), site = makeReviewsSite({total: 25, perPage: 10}); setUser(site, B); // the first batches are collected as ANOTHER account, without the option
    const first = j(await site.runFile({})); assert.equal(first.status, 'continue');
    setUser(site, A); // then the bound account signs in and the resume call adds the identity option
    site.navigate(first.next); let r = j(await site.runFile({identity: {salt: h.salt}}));
    for (let i = 0; r.status === 'continue' && i < 10; i++) { site.navigate(r.next); r = j(await site.runFile({})); }
    assert.equal(r.diagnostics.identity.continuity.covered, false); const s = saveNative(h, r);
    assert.equal(s.json.action, 'separate'); assert.match(s.json.reason, /not observed|not confirmed/); assert.ok(!fs.existsSync(path.join(h.dest, 'reviews.json')), 'B\'s rows were not promoted as the bound account');
  }
  {
    const h = home(), p = makeWishlistPage({n: 30}); setUser(p.state, B);
    let r = j(await p.run({callBudgetMs: 1})); assert.ok(r.inProgress, 'a long first call hands control back without identity');
    setUser(p.state, A); r = j(await p.run({identity: {salt: h.salt}})); for (let i = 0; i < 400 && !r.format; i++) r = j(await p.run({}));
    assert.equal(r.diagnostics.identity.continuity.covered, false); assert.equal(saveNative(h, r).json.action, 'separate');
    const h2 = home(), p2 = makeWishlistPage({n: 30}); setUser(p2.state, A); // a different salt on resume restarts continuity as not covered
    let r2 = j(await p2.run({callBudgetMs: 1, identity: {salt: h2.salt}})); assert.ok(r2.inProgress);
    r2 = j(await p2.run({identity: {salt: newSalt()}})); for (let i = 0; i < 400 && !r2.format; i++) r2 = j(await p2.run({}));
    assert.equal(r2.diagnostics.identity.continuity.covered, false);
  }

  // ======== bound review-name enrichment: both captures must be verified under the SAME binding generation
  {
    const h = home(), lib = makeLibraryPage({n: 20, appidOf: i => 4000 + i, nameOf: i => 'Synthetic Game ' + i}); setUser(lib.state, A);
    const libEnv = await runLibrary(lib, {identity: {salt: h.salt}}); assert.equal(saveNative(h, libEnv).json.action, 'create');
    const reviewsEnv = async () => { const site = makeReviewsSite({total: 12, perPage: 10}); setUser(site, A); return drive(site, {identity: {salt: h.salt}}); };
    const libFile = path.join(h.dest, 'library.json');
    let r = saveNative(h, await reviewsEnv(), ['--names-from', libFile]); assert.equal(r.status, 0, r.err); assert.equal(r.json.action, 'create');
    const saved = JSON.parse(fs.readFileSync(path.join(h.dest, 'reviews.json'), 'utf8')); assert.ok(saved.records.some(x => x.nameSource === 'verified-library-capture'), 'names were added'); assert.equal(saved.diagnostics.attestations.enrichment.generation, h.gen); assert.equal(saved.diagnostics.attestations.identity.result, 'match');
    // manual library alias cannot stand in while bound
    const neg1 = saveNative(h, await reviewsEnv(), ['--names-from', libFile, '--library-account', 'my-steam']); assert.equal(neg1.status, 1); assert.match(neg1.err, /cannot be used while an account is bound/);
    // the reviews capture itself must be a verified match (another account signed in: no names)
    const other = makeReviewsSite({total: 12, perPage: 10}); setUser(other, B); const neg2 = saveNative(h, await drive(other, {identity: {salt: h.salt}}), ['--names-from', libFile]); assert.equal(neg2.status, 1);
    // a library capture of an EARLIER generation with the same alias cannot supply names to the new binding
    const planR = planBinding(h.file, {op: 'revoke'}); planBinding(h.file, {op: 'revoke', apply: true, expect: {settingsSha256: planR.settingsSha256, candidateSha256: planR.candidateSha256}});
    const probe2 = {format: 'game-curator-identity-probe', version: 1, sources: ['user-config'], loggedIn: true, consistent: true, problems: [], origin: 'https://store.steampowered.com', saltCheck: saltCheckOf(h.salt), sessionFingerprint: fingerprintSync(h.salt, ID_A), pathFingerprint: null, salt: h.salt};
    const planB = planBinding(h.file, {op: 'bind', probe: probe2, alias: 'my-steam'}); planBinding(h.file, {op: 'bind', probe: probe2, alias: 'my-steam', apply: true, expect: {settingsSha256: planB.settingsSha256, candidateSha256: planB.candidateSha256}});
    assert.notEqual(readSettingsFile(h.file).settings.steamAccount.generation, h.gen);
    fs.unlinkSync(path.join(h.dest, 'reviews.json'));
    const neg3 = saveNative(h, await reviewsEnv(), ['--names-from', libFile]); assert.equal(neg3.status, 1); assert.match(neg3.err, /not verified under the current account binding/);
    // a legacy manual library capture (saved while unbound, alias only) cannot supply names to a bound reviews capture
    const hl = home(); const cleanFile = fs.readFileSync(hl.file); fs.writeFileSync(hl.file, JSON.stringify({version: 1, persistence: {profileAndFeedback: false, steamCache: true}}) + '\n'); void cleanFile;
    const libL = makeLibraryPage({n: 20, appidOf: i => 4000 + i}); setUser(libL.state, A);
    const legacyEnv = await runLibrary(libL, {}); assert.equal(saveNative(hl, legacyEnv, ['--account', 'my-steam', '--access-scope', 'signed-in']).json.action, 'create');
    const probeL = {...probe2, salt: hl.salt, saltCheck: saltCheckOf(hl.salt), sessionFingerprint: fingerprintSync(hl.salt, ID_A)};
    const pl = planBinding(hl.file, {op: 'bind', probe: probeL, alias: 'my-steam'}); planBinding(hl.file, {op: 'bind', probe: probeL, alias: 'my-steam', apply: true, expect: {settingsSha256: pl.settingsSha256, candidateSha256: pl.candidateSha256}});
    const siteL = makeReviewsSite({total: 12, perPage: 10}); setUser(siteL, A);
    const neg4 = saveNative(hl, await drive(siteL, {identity: {salt: hl.salt}}), ['--names-from', path.join(hl.dest, 'library.json')]); assert.equal(neg4.status, 1); assert.match(neg4.err, /not verified under the current account binding/);
  }

  // ======== no identity anywhere in the scratch homes
  for (const root of tmp) scan(path.join(root, 'cache', 'steam'));
  console.log('identity collector integration checks passed');
} finally { for (const r of tmp) fs.rmSync(r, {recursive: true, force: true}); }
