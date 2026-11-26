// Synthetic tests for the Claude Code wishlist saver and generated page script. Node is a development-only dependency.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {parseToolResult, canonicalize, validate, decide, fieldLosses, checkCacheAuthorized, save, MAX_BACKUPS} from '../../skills/game-curator/scripts/claude-code/save-capture.mjs';
import {spawnSync} from 'node:child_process';
import {makeWishlistPage} from './fake-wishlist-dom.mjs';
import {buildPageScript} from '../../skills/game-curator/scripts/claude-code/build-page-script.mjs';

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const row = (i, {labels = ['RELEASE DATE:', 'ENGLISH REVIEWS:', 'USER TAGS:', 'MY CATEGORIES:'], base = 1000} = {}) => ({appid: base + i, rank: i, name: `Game ${i}`,
  pageText: `Game ${i}\n${labels.map(l => `${l}\nx`).join('\n')}\n$9.99`, membershipSource: 'wishlist-row'});
function make(n, {at = '2026-11-26T02:37:30.226Z', account, accessScope = 'signed-in', view = {sort: 'Your Rank', search: 'empty', filters: 'none'}, records, diag = {}} = {}) {
  records ??= Array.from({length: n}, (_, i) => row(i + 1));
  const env = {format: 'game-curator-steam-export', version: 1, source: 'wishlist', capturedAt: at, method: 'browser-dom-claude-code', coverage: 'partial', warnings: ['w'],
    diagnostics: {expectedCount: records.length, uniqueCount: records.length, ranksObserved: records.length, placeholderNameRows: 0, complete: true, stopReason: 'complete',
      reorderHandles: true, view, recordsSha256: sha(JSON.stringify(records)), ...diag}, accessScope, records};
  if (account) env.account = account;
  return env;
}
const sortKeys = o => Array.isArray(o) ? o.map(sortKeys) : o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).sort().map(k => [k, sortKeys(o[k])])) : o;
const harness = env => JSON.stringify([{type: 'text', text: JSON.stringify(sortKeys(env), null, 2) + '\n\n(captured at origin https://store.steampowered.com)'}]);
const bad = (env, re, opts = {accessScope: 'signed-in'}) => assert.ok(validate(env, opts).errors.some(e => re.test(e)), `expected error ${re}`);

// Transfer: harness file (alphabetized keys, trailer) -> canonical envelope with a reproducible checksum; small/plain input too.
const env = make(3);
const parsed = canonicalize(parseToolResult(harness(env)));
assert.deepEqual(Object.keys(parsed), ['format', 'version', 'source', 'capturedAt', 'method', 'coverage', 'warnings', 'diagnostics', 'accessScope', 'records']);
assert.deepEqual(validate(parsed, {accessScope: 'signed-in'}), {errors: [], incomplete: []});
assert.deepEqual(parseToolResult(JSON.stringify(env)), env);
bad({...env, transportPadding: 'xxx'}, /unexpected envelope field/); // no transport padding is accepted or stripped

// Contract validation rejects incompatible input instead of repairing it.
bad({...make(2), extra: 1}, /unexpected envelope field/);
bad({...make(2), coverage: 'maybe'}, /coverage/);
bad({...make(2), capturedAt: 'yesterday'}, /capturedAt/);
bad({...make(2), method: ''}, /method/);
bad({...make(2), warnings: 'no'}, /warnings/);
bad({...make(2), version: 2}, /version/);
for (const [label, mutate, re] of [
  ['empty name', r => { r.name = '  '; }, /empty name/], ['empty pageText', r => { r.pageText = ''; }, /empty pageText/],
  ['zero appid', r => { r.appid = 0; }, /invalid appid/], ['extra record field', r => { r.hours = 3; }, /unexpected field hours/],
  ['wrong membershipSource', r => { r.membershipSource = 'library'; }, /membershipSource/]]) {
  const e = make(2); mutate(e.records[0]); e.diagnostics.recordsSha256 = sha(JSON.stringify(e.records)); bad(e, re);
}
{ const e = make(2); e.diagnostics.placeholderNameRows = undefined; bad(e, /placeholderNameRows/); }
{ const e = make(2); e.diagnostics.uniqueCount = 5; bad(e, /uniqueCount/); }
{ const e = make(2); e.records[0].name = 'Changed'; bad(e, /checksum/); }
{ const e = make(2); delete e.diagnostics.recordsSha256; bad(e, /checksum/); }
{ const e = make(2); e.diagnostics.reorderHandles = false; bad(e, /signed-in scope claimed/); }
bad(make(2), /alias/, {account: '../evil', accessScope: 'signed-in'});
bad(make(2), /scope/, {accessScope: 'admin'});
// Incomplete runs are valid but never promotable.
assert.ok(validate(make(3, {diag: {complete: false, stopReason: 'budget'}}), {accessScope: 'signed-in'}).incomplete.some(r => /budget/.test(r)));
assert.ok(validate(make(3, {diag: {placeholderNameRows: 2}}), {accessScope: 'signed-in'}).incomplete.some(r => /placeholder/.test(r)));
assert.ok(validate(make(3, {diag: {expectedCount: 9}}), {accessScope: 'signed-in'}).incomplete.some(r => /9 items/.test(r)));
{ const gap = make(0, {records: [row(1), row(3)]}); assert.ok(validate(gap, {accessScope: 'signed-in'}).incomplete.some(r => /contiguous/.test(r))); }
// An empty page is preserved as an uncertain observation (never promotable); zero rows without that observation are invalid.
{ const e = make(0, {records: [], diag: {expectedCount: 0, stopReason: 'empty-observed', complete: false, reorderHandles: false}});
  const v = validate(e, {accessScope: 'unknown'}); assert.deepEqual(v.errors, []); assert.ok(v.incomplete.some(r => /not independently verified/.test(r))); }
bad(make(0, {records: []}), /empty-page observation/, {accessScope: 'unknown'});
// Omitted unresolved rows keep the capture valid but incomplete; nothing is fabricated for them.
{ const e = make(0, {records: [row(1), row(3)], diag: {expectedCount: 3, placeholderNameRows: 1, missingRanks: [2], complete: false, stopReason: 'rows-missing'}});
  const v = validate(e, {accessScope: 'signed-in'}); assert.deepEqual(v.errors, []); assert.ok(v.incomplete.length >= 2); }

// Replacement policy.
const U = {sort: 'Your Rank', search: 'empty', filters: 'none'};
const old = make(4, {account: 'me', at: '2026-11-25T00:00:00Z'});
const next = make(3, {account: 'me', at: '2026-11-26T03:00:00Z'});
assert.equal(decide(null, next).action, 'create');
assert.equal(decide(old, next).action, 'replace'); // a legitimately smaller unfiltered wishlist replaces
assert.match(decide(old, next).notes.join(), /1 removed/);
const reason = (o, n, ctx) => decide(o, n, ctx).reason;
// Creation and promotion both need established identity, scope and view; otherwise the capture stays separate.
assert.match(reason(null, make(3, {account: 'me', accessScope: 'unknown'})), /not established/);
assert.match(reason(null, make(3, {accessScope: 'signed-in'})), /not established/); // no verified account
assert.match(reason(null, make(3, {account: 'me', view: {...U, filters: 'unknown'}})), /not verified as default sort/);
assert.match(reason(make(4, {account: 'me', accessScope: 'unknown', at: '2026-11-25T00:00:00Z'}), make(3, {account: 'me', accessScope: 'unknown'})), /not established/); // unknown never replaces unknown
// Observed evidence and caller attestation stay separate: an attestation can supply filters 'none' but never a default sort.
{ const attested = make(3, {account: 'me', view: {...U, filters: 'unknown'}}); attested.diagnostics.attestations = {by: 'caller', filters: 'none'};
  assert.equal(decide(null, attested).action, 'create');
  const wrongSort = make(3, {account: 'me', view: {sort: 'Name', search: 'empty', filters: 'unknown'}}); wrongSort.diagnostics.attestations = {by: 'caller', filters: 'none'};
  assert.match(reason(null, wrongSort), /not verified as default sort/); }
assert.equal(decide(old, next, {keepSeparate: true}).action, 'separate');
assert.equal(decide(old, next, {incomplete: ['x']}).action, 'separate');
assert.match(reason({...old, account: undefined}, next), /account/); // unknown identity is never merged
assert.equal(decide({...old, account: undefined}, next, {existingAccount: 'me'}).action, 'replace');
assert.match(reason({...old, account: 'other'}, next), /account/);
assert.match(reason({...old, accessScope: 'public'}, next), /scope/);
assert.match(reason({...old, coverage: 'complete'}, next), /coverage/);
assert.match(reason({...old, capturedAt: '2026-11-27T00:00:00Z'}, next), /not newer/);
assert.match(reason({malformed: true}, next), /not a valid wishlist/);
assert.match(reason({...old, records: [{appid: 'x'}]}, next), /not a valid wishlist/);
// Filters and sort: unknown, active or non-default views never promote.
for (const view of [{...U, filters: 'unknown'}, {...U, filters: 'active'}, {...U, sort: 'Name'}, {...U, search: 'active'}, null])
  assert.match(reason(old, make(3, {account: 'me', at: '2026-11-26T03:00:00Z', view})), /not verified as default sort/);
const legacy = {...old, diagnostics: {expectedCount: 4}}; // an older capture with no view evidence
assert.match(reason(legacy, next), /no filter\/sort evidence/);
assert.equal(decide(legacy, next, {existingViewUnfiltered: true}).action, 'replace');
// --existing-view only fills missing evidence; it never overrides explicitly conflicting recorded evidence.
for (const view of [{...U, filters: 'active'}, {...U, sort: 'Name'}, {...U, search: 'active'}]) {
  const conflicted = {...old, diagnostics: {...old.diagnostics, view}};
  assert.match(reason(conflicted, next, {existingViewUnfiltered: true}), /non-default sort, active search or active filter/);
}
assert.equal(decide({...old, diagnostics: {...old.diagnostics, view: {...U, filters: 'unknown'}}}, next, {existingViewUnfiltered: true}).action, 'replace'); // unknown filters: user may fill
// Existing files must be structurally sound but need no new diagnostics (historical v1 data stays usable).
assert.match(reason({...old, records: [old.records[0], {...old.records[0]}]}, next), /not a valid wishlist/); // duplicate AppID
assert.match(reason({...old, records: [old.records[0], {...old.records[1], rank: 1}]}, next), /not a valid wishlist/); // duplicate rank
assert.match(reason({...old, coverage: 'bogus'}, next), /not a valid wishlist/);
assert.match(reason({...old, warnings: undefined}, next), /not a valid wishlist/);
assert.match(reason({...old, method: ''}, next), /not a valid wishlist/);
{ const historical = {format: 'game-curator-steam-export', version: 1, source: 'wishlist', capturedAt: '2026-11-25T00:00:00Z', method: 'browser-dom', coverage: 'partial', warnings: [], diagnostics: {expectedCount: 4},
    accessScope: 'signed-in', account: 'me', records: old.records.map(({appid, name, pageText, membershipSource}) => ({appid, name, pageText, membershipSource}))};
  assert.equal(decide(historical, next, {existingViewUnfiltered: true}).action, 'replace'); }
// Field loss is checked per label for retained AppIDs; one gained field cannot offset a lost one.
{
  const a = make(0, {account: 'me', at: '2026-11-25T00:00:00Z', records: [row(1), row(2, {labels: ['RELEASE DATE:']})]});
  const b = make(0, {account: 'me', at: '2026-11-26T00:00:00Z', records: [row(1, {labels: ['USER TAGS:', 'ENGLISH REVIEWS:', 'MY CATEGORIES:']}), row(2, {labels: ['RELEASE DATE:', 'USER TAGS:', 'ENGLISH REVIEWS:', 'MY CATEGORIES:']})]});
  assert.deepEqual(fieldLosses(a, b), {releaseDate: 1});
  assert.match(reason(a, b), /lose fields/); // aggregate label count would have gone up
  const c = make(0, {account: 'me', at: '2026-11-26T00:00:00Z', records: [row(1), row(2, {labels: ['RELEASE DATE:'], base: 5000})]}); // dropped AppID, new AppID: not a loss
  assert.equal(decide(a, c).action, 'replace');
  const reviews = make(0, {account: 'me', at: '2026-11-26T00:00:00Z', records: [{...row(1), pageText: 'Game 1\nRELEASE DATE:\nx\nOVERALL REVIEWS:\nx\nUSER TAGS:\nx\nMY CATEGORIES:\nx'}, row(2, {labels: ['RELEASE DATE:']})]});
  assert.equal(decide(a, reviews).action, 'replace'); // English vs overall reviews wording is not a loss
}
assert.match(reason(old, next, {backupCount: MAX_BACKUPS}), /backups/);

// Settings validation (fail closed) before any cache access.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-'));
const home = path.join(tmp, 'game-curator'), dest = path.join(home, 'cache', 'steam');
fs.mkdirSync(dest, {recursive: true});
const settings = path.join(home, 'settings.json');
assert.throws(() => checkCacheAuthorized(dest), /cannot read/);
for (const bad of ['{', '{"version":2,"persistence":{"profileAndFeedback":true,"steamCache":true}}', '{"version":1,"persistence":{"profileAndFeedback":true,"steamCache":"yes"}}',
  '{"version":1,"persistence":{"profileAndFeedback":true,"steamCache":true},"extra":1}', '{"version":1,"persistence":{"steamCache":true}}']) {
  fs.writeFileSync(settings, bad); assert.throws(() => checkCacheAuthorized(dest), /not authorized/);
}
fs.writeFileSync(settings, '{"version":1,"persistence":{"profileAndFeedback":true,"steamCache":false}}');
assert.throws(() => checkCacheAuthorized(dest), /steamCache false/);
fs.writeFileSync(settings, '{"version":1,"persistence":{"profileAndFeedback":false,"steamCache":true}}');
assert.equal(checkCacheAuthorized(dest), settings);
assert.throws(() => checkCacheAuthorized(path.join(tmp, 'elsewhere')), /--settings/); // custom locations need an explicit settings path
assert.throws(() => checkCacheAuthorized(path.join(tmp, 'elsewhere'), settings), /does not govern/); // the record must belong to the destination
fs.mkdirSync(path.join(home, 'custom', 'wl'), {recursive: true});
assert.equal(checkCacheAuthorized(path.join(home, 'custom', 'wl'), settings), settings);
fs.symlinkSync(os.tmpdir(), path.join(home, 'escape'));
assert.throws(() => checkCacheAuthorized(path.join(home, 'escape', 'x'), settings), /does not govern/); // symlinks cannot escape the governed tree
fs.unlinkSync(path.join(home, 'escape'));

// Filesystem behavior: create, replace with preserved backup, separate, concurrent edit, lock, no deletion.
const list = () => fs.readdirSync(dest).sort();
const first = save(next, dest);
assert.equal(first.action, 'create');
assert.equal(fs.statSync(first.target).mode & 0o777, 0o600);
const newer = make(2, {account: 'me', at: '2026-11-26T04:00:00Z'});
const replaced = save(newer, dest);
assert.equal(replaced.action, 'replace');
assert.deepEqual(JSON.parse(fs.readFileSync(replaced.backup, 'utf8')), next);
assert.equal(JSON.parse(fs.readFileSync(path.join(dest, 'wishlist.json'), 'utf8')).records.length, 2);
assert.equal(list().filter(f => f.startsWith('.')).length, 0); // no temp or lock files left behind
// Concurrent edit between decision and commit: the edit survives and the capture is kept separately.
{
  const before = list();
  const edited = '{"user":"edit"}\n';
  const cand = make(2, {account: 'me', at: '2026-11-26T05:00:00Z'});
  const r = save(cand, dest, {hooks: {beforeCommit: () => fs.writeFileSync(path.join(dest, 'wishlist.json'), edited)}});
  assert.equal(r.action, 'separate');
  assert.match(r.reason, /changed during the save/);
  assert.equal(fs.readFileSync(path.join(dest, 'wishlist.json'), 'utf8'), edited);
  assert.ok(before.every(f => list().includes(f)), 'no file may disappear');
  assert.equal(list().filter(f => f.startsWith('.')).length, 0);
  fs.writeFileSync(path.join(dest, 'wishlist.json'), JSON.stringify(newer, null, 2) + '\n'); // restore for the next cases
}
// Poorer / filtered / incomplete captures are kept beside, never over, the current file.
{
  const current = fs.readFileSync(path.join(dest, 'wishlist.json'), 'utf8');
  const filtered = make(2, {account: 'me', at: '2026-11-26T06:00:00Z', view: {...U, filters: 'unknown'}});
  const r = save(filtered, dest);
  assert.equal(r.action, 'separate'); assert.match(r.target, /wishlist\.partial\.20261126T060000Z\.json$/);
  assert.equal(fs.readFileSync(path.join(dest, 'wishlist.json'), 'utf8'), current);
  assert.throws(() => save(filtered, dest), /EEXIST/); // never overwrite a snapshot
  assert.equal(save(filtered, dest, {dryRun: true}).action, 'separate');
  assert.equal(save(make(2, {account: 'me', at: '2026-11-26T07:00:00Z'}), dest, {keepSeparate: true}).action, 'separate');
}
// Consent is rechecked before anything is written: revocation between decision and commit stops the save.
{
  const before = list();
  let on = true;
  assert.throws(() => save(make(2, {account: 'me', at: '2026-11-26T09:00:00Z'}), dest, {recheckConsent: () => { if (!on) throw new Error('revoked'); }, hooks: {beforeCommit: () => { on = false; }}}), /revoked/);
  assert.ok(before.every(f => list().includes(f)));
  assert.equal(list().filter(f => f.startsWith('.')).length, 0); // own temp file removed
}
// A held lock blocks a concurrent saver instead of racing it.
fs.writeFileSync(path.join(dest, '.wishlist.lock'), 'other');
assert.throws(() => save(make(2, {account: 'me', at: '2026-11-26T08:00:00Z'}), dest), /EEXIST/);
assert.ok(fs.existsSync(path.join(dest, '.wishlist.lock'))); // a lock this process did not take is not removed
fs.unlinkSync(path.join(dest, '.wishlist.lock'));
// Backups are bounded and never pruned automatically.
{
  const count = () => fs.readdirSync(dest).filter(f => f.startsWith('wishlist.superseded.')).length;
  for (let i = count(); i < MAX_BACKUPS; i++) fs.writeFileSync(path.join(dest, `wishlist.superseded.2026010${i}T000000Z.json`), '{}');
  const before = count();
  const r = save(make(2, {account: 'me', at: '2026-12-01T00:00:00Z'}), dest);
  assert.equal(r.action, 'separate'); assert.match(r.reason, /backups/);
  assert.equal(count(), before); // nothing pruned automatically
}
fs.rmSync(tmp, {recursive: true});

// End to end: simulated page -> runtime-style result file -> saver CLI in a scratch Curator Home.
{
  const cli = new URL('../../skills/game-curator/scripts/claude-code/save-capture.mjs', import.meta.url).pathname;
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-e2e-')), cache = path.join(home2, 'cache', 'steam');
  fs.mkdirSync(cache, {recursive: true});
  const pageRun = async (opts, run = {}) => JSON.parse(JSON.stringify(await makeWishlistPage(opts).run(run)));
  const toFile = (envelope, name) => { const f = path.join(home2, name); fs.writeFileSync(f, harness(envelope)); return f; };
  const run = (file, ...args) => spawnSync(process.execPath, [cli, file, '--dest', cache, ...args], {encoding: 'utf8'});
  const good = toFile(await pageRun({n: 50}), 'good.json');
  assert.notEqual(run(good, '--account', 'me', '--access-scope', 'signed-in', '--view', 'unfiltered').status, 0, 'no settings record: nothing may be read or written');
  assert.deepEqual(fs.readdirSync(cache), []);
  fs.writeFileSync(path.join(home2, 'settings.json'), '{"version":1,"persistence":{"profileAndFeedback":false,"steamCache":true}}');
  // complete capture with confirmed view -> main file; observed evidence and attestations stay separate
  let r = run(good, '--account', 'me', '--access-scope', 'signed-in', '--view', 'unfiltered');
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).action, 'create');
  const saved = JSON.parse(fs.readFileSync(path.join(cache, 'wishlist.json'), 'utf8'));
  assert.equal(saved.accessScope, 'signed-in'); assert.equal(saved.account, 'me');
  assert.equal(saved.diagnostics.view.filters, 'unknown'); // observed, unchanged
  assert.equal(saved.diagnostics.attestations.filters, 'none'); // attested by the caller
  assert.equal(saved.diagnostics.attestations.pageReportedAccessScope, 'unknown');
  assert.match(saved.diagnostics.attestations.sourceEnvelopeSha256, /^[0-9a-f]{64}$/);
  // the same capture without confirming the view cannot be promoted over it
  const later = toFile(await pageRun({n: 49}), 'later.json');
  await new Promise(res => setTimeout(res, 5));
  r = run(later, '--account', 'me', '--access-scope', 'signed-in');
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).action, 'separate');
  // a placeholder that never loads: omitted row, valid but incomplete -> preserved separately
  const stuck = toFile(await pageRun({n: 30, neverLoad: new Set([7])}), 'stuck.json');
  r = run(stuck, '--account', 'me', '--access-scope', 'signed-in', '--view', 'unfiltered');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout); assert.equal(out.action, 'separate'); assert.match(out.reason, /incomplete/);
  const partial = JSON.parse(fs.readFileSync(out.target, 'utf8'));
  assert.equal(partial.records.length, 29); assert.deepEqual(partial.diagnostics.missingRanks, [7]);
  assert.ok(partial.records.every(x => x.name && x.pageText));
  // an empty page: preserved as an uncertain observation, scope stays unknown
  const emptyPage = makeWishlistPage({n: 0, count: 0}); emptyPage.state.rendered = [];
  const empty = toFile(JSON.parse(JSON.stringify(await emptyPage.run())), 'empty.json');
  r = run(empty, '--account', 'me', '--access-scope', 'unknown');
  assert.equal(r.status, 0, r.stderr);
  const eout = JSON.parse(r.stdout); assert.equal(eout.action, 'separate');
  assert.equal(JSON.parse(fs.readFileSync(eout.target, 'utf8')).records.length, 0);
  assert.notEqual(run(empty, '--account', 'me', '--access-scope', 'signed-in').status, 0); // signed-in claim has no owner evidence
  // revoked consent stops the CLI
  fs.writeFileSync(path.join(home2, 'settings.json'), '{"version":1,"persistence":{"profileAndFeedback":false,"steamCache":false}}');
  assert.notEqual(run(good, '--account', 'me', '--access-scope', 'signed-in', '--dry-run').status, 0);
  fs.rmSync(home2, {recursive: true});
}

// The committed page script must be the generated output of the template plus the shared row code, and stay read-only.
const generated = fs.readFileSync(new URL('../../skills/game-curator/scripts/claude-code/steam-wishlist-page.js', import.meta.url), 'utf8');
assert.equal(generated, buildPageScript(), 'steam-wishlist-page.js is stale: run node skills/game-curator/scripts/claude-code/build-page-script.mjs');
assert.ok(!/\bfetch\s*\(|XMLHttpRequest|localStorage|document\.cookie|\.click\(|dispatchEvent|\.submit\(/.test(generated), 'page script must stay read-only');
console.log('Claude Code collector checks passed');
