// Synthetic tests for the Claude Code wishlist saver and generated page script. Node is a development-only dependency.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {parseToolResult, canonicalize, validate, decide as decideRaw, fieldLosses, checkCacheAuthorized, enrichReviewNames, verifyNameAttribution, save as saveRaw, MAX_BACKUPS} from '../../skills/game-curator/scripts/claude-code/save-capture.mjs';
import {spawnSync} from 'node:child_process';
import {makeWishlistPage} from './fake-wishlist-dom.mjs';
import {makeLibraryPage} from './fake-library-dom.mjs';
import {makeReviewsSite} from './fake-reviews-site.mjs';
import {normalizeLibraryRecord} from '../../skills/game-curator/scripts/browser/library-rows.mjs';
import {buildPageScript} from '../../skills/game-curator/scripts/claude-code/build-page-script.mjs';

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
// Policy tests assume verified transfer unless a case says otherwise (the default is fail-closed).
const decide = (o, n, c = {}) => decideRaw(o, n, {transferVerified: true, ...c});
const save = (e, d, c = {}) => saveRaw(e, d, {transferVerified: true, ...c});
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
assert.match(decideRaw(null, next).reason, /transfer not verified/); // fail closed unless the caller establishes verified transfer
assert.equal(decideRaw(null, next, {transferVerified: true}).action, 'create');
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
assert.match(reason(legacy, next), /no view evidence/);
assert.equal(decide(legacy, next, {existingViewUnfiltered: true}).action, 'replace');
// --existing-view only fills missing evidence; it never overrides explicitly conflicting recorded evidence.
for (const view of [{...U, filters: 'active'}, {...U, sort: 'Name'}, {...U, search: 'active'}]) {
  const conflicted = {...old, diagnostics: {...old.diagnostics, view}};
  assert.match(reason(conflicted, next, {existingViewUnfiltered: true}), /non-default view/);
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
  let r = run(good, '--account', 'me', '--access-scope', 'signed-in', '--view', 'unfiltered', '--provenance', 'tool-result');
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
  // Verification levels. Provenance is declared by the caller, never inferred from file shape.
  const U2 = {sort: 'Your Rank', search: 'empty', filters: 'unknown'}; // as a real page reports it: filters unobserved
  const dl = make(5, {view: U2, at: '2026-11-26T04:30:00.000Z', diag: {}});
  const dlName = 'gc-wishlist-20261126T043000Z.json';
  const dlFile = path.join(home2, dlName); fs.writeFileSync(dlFile, JSON.stringify(dl, null, 2) + '\n');
  const dlBytes = fs.statSync(dlFile).size;
  const summary = {downloadInitiated: true, source: 'wishlist', capturedAt: dl.capturedAt, file: dlName, bytes: dlBytes, records: 5, expected: 5, complete: true, stopReason: 'complete', view: U2};
  const baseFlags = ['--account', 'me', '--access-scope', 'signed-in', '--view', 'unfiltered', '--dry-run'];
  const ok = r2 => { assert.equal(r2.status, 0, r2.stderr); return JSON.parse(r2.stdout); };
  // missing provenance or missing summary: kept separate
  for (const extra of [[], ['--provenance', 'download']]) {
    const d = ok(run(dlFile, ...baseFlags, ...extra)); assert.equal(d.action, 'separate'); assert.match(d.reason, /provenance was not established/);
  }
  // verified download: provenance + a page summary that agrees on every fact -> eligible under the ordinary policy
  const sumArg = JSON.stringify(summary);
  assert.doesNotMatch(ok(run(dlFile, ...baseFlags, '--provenance', 'download', '--page-summary', sumArg)).reason, /provenance|transfer not verified/);
  // each mismatching fact rejects the file as not the one the page produced
  for (const [label, patch, re] of [['bytes', {bytes: dlBytes + 1}, /byte count differs/], ['records', {records: 4}, /record count differs/], ['capturedAt', {capturedAt: '2026-11-26T04:31:00.000Z'}, /capture time differs/],
    ['stopReason', {stopReason: 'budget'}, /stop reason differs/], ['complete', {complete: false}, /completeness differs/], ['expected', {expected: 6}, /displayed count differs/],
    ['view', {view: {...U2, sort: 'Name'}}, /view differs/], ['source', {source: 'library'}, /source differs/], ['not a download', {downloadInitiated: false}, /does not report a download/],
    ['renamed copy', {file: 'gc-wishlist-20261126T043000Z (1).json'}, /file name differs/]]) {
    const r2 = run(dlFile, ...baseFlags, '--provenance', 'download', '--page-summary', JSON.stringify({...summary, ...patch}));
    assert.notEqual(r2.status, 0, `${label} mismatch must be rejected`); assert.match(r2.stderr, re, label);
  }
  // a duplicate-named copy of the right bytes is ambiguous and rejected
  const dup = path.join(home2, 'gc-wishlist-20261126T043000Z (1).json'); fs.copyFileSync(dlFile, dup);
  let r3 = run(dup, ...baseFlags, '--provenance', 'download', '--page-summary', sumArg); assert.notEqual(r3.status, 0); assert.match(r3.stderr, /file name differs/);
  // a file renamed to the right name but with the wrong capture stamp is rejected too
  const stamped = {...dl, capturedAt: '2026-11-26T04:30:01.000Z'}; fs.writeFileSync(path.join(home2, 'x.json'), JSON.stringify(stamped));
  // malformed arguments are errors, never silently skipped
  for (const [label, args2, re] of [['summary not JSON', ['--provenance', 'download', '--page-summary', '{nope'], /not valid JSON/], ['summary without download provenance', ['--page-summary', sumArg], /applies only with --provenance download/],
    ['unknown provenance', ['--provenance', 'trust-me'], /must be tool-result or download/], ['missing provenance value', ['--provenance'], /needs a value/], ['missing summary value', ['--provenance', 'download', '--page-summary'], /needs a value/]]) {
    const r2 = run(dlFile, ...baseFlags, ...args2); assert.notEqual(r2.status, 0, label); assert.match(r2.stderr, re, label);
  }
  // an array-shaped file does not by itself establish tool-result provenance
  const shaped = path.join(home2, 'array-shaped.json'); fs.writeFileSync(shaped, harness(dl));
  let d2 = ok(run(shaped, ...baseFlags)); assert.equal(d2.action, 'separate'); assert.match(d2.reason, /provenance was not established/);
  r3 = run(shaped, ...baseFlags, '--provenance', 'download'); assert.notEqual(r3.status, 0); assert.match(r3.stderr, /is a tool-result file/);
  r3 = run(dlFile, ...baseFlags, '--provenance', 'tool-result'); assert.notEqual(r3.status, 0); assert.match(r3.stderr, /tool-result structure/);
  assert.doesNotMatch(ok(run(shaped, ...baseFlags, '--provenance', 'tool-result')).reason, /provenance|transfer not verified/); // the caller declared it for this run
  // optional stronger evidence: an independently obtained SOURCE digest; strictly formatted, matched against the exact received bytes
  const exactSha = crypto.createHash('sha256').update(fs.readFileSync(dlFile)).digest('hex');
  assert.equal(ok(run(dlFile, ...baseFlags, '--provenance', 'download', '--page-summary', sumArg, '--source-sha256', exactSha)).action !== undefined, true);
  for (const [label, extra, re] of [['mismatching digest', ['--source-sha256', '0'.repeat(64)], /does not match --source-sha256/], ['missing value', ['--source-sha256'], /needs a value/],
    ['flag followed by flag', ['--source-sha256', '--dry-run'], /needs a value|64 hexadecimal/], ['grouped digest', ['--source-sha256', exactSha.match(/.{8}/g).join(' ')], /64 hexadecimal/],
    ['short digest', ['--source-sha256', exactSha.slice(0, 40)], /64 hexadecimal/], ['non-hex digest', ['--source-sha256', 'z'.repeat(64)], /64 hexadecimal/],
    ['bad byte count', ['--expect-bytes', 'abc'], /non-negative integer/], ['wrong byte count', ['--expect-bytes', '1'], /expected 1/], ['missing byte value', ['--expect-bytes'], /needs a value/]]) {
    const r2 = run(dlFile, ...baseFlags, ...extra); assert.notEqual(r2.status, 0, `${label} must be rejected, not skipped`); assert.match(r2.stderr, re, label);
  }
  // hashing covers the raw received bytes before decoding: a file containing an invalid UTF-8 byte
  const baseBuf = Buffer.from(JSON.stringify(dl));
  const withBadByte = Buffer.concat([baseBuf.subarray(0, baseBuf.length - 1), Buffer.from([0x20, 0xff, 0x20]), baseBuf.subarray(baseBuf.length - 1)]);
  const badFile = path.join(home2, 'badbyte.json'); fs.writeFileSync(badFile, withBadByte);
  const rawSha = crypto.createHash('sha256').update(withBadByte).digest('hex'), decodedSha = crypto.createHash('sha256').update(withBadByte.toString('utf8')).digest('hex');
  assert.notEqual(rawSha, decodedSha, 'fixture must distinguish raw-byte from decoded-string hashing');
  r3 = run(badFile, ...baseFlags, '--source-sha256', decodedSha); assert.notEqual(r3.status, 0); assert.match(r3.stderr, /does not match --source-sha256/);
  r3 = run(badFile, ...baseFlags, '--source-sha256', rawSha); assert.doesNotMatch(r3.stderr, /does not match/); // the exact-byte digest passes the digest check
  // what is recorded: a real save writes the transfer level, a local fingerprint and the unavailable source digest (never "byte-identical")
  {
    const homeB = path.join(home2, 'homeB'), cacheB = path.join(homeB, 'cache', 'steam'); fs.mkdirSync(cacheB, {recursive: true});
    fs.writeFileSync(path.join(homeB, 'settings.json'), '{"version":1,"persistence":{"profileAndFeedback":false,"steamCache":true}}');
    const real = spawnSync(process.execPath, [cli, dlFile, '--dest', cacheB, '--account', 'me', '--access-scope', 'signed-in', '--view', 'unfiltered', '--provenance', 'download', '--page-summary', sumArg], {encoding: 'utf8'});
    assert.equal(real.status, 0, real.stderr); assert.equal(JSON.parse(real.stdout).action, 'create');
    const t = JSON.parse(fs.readFileSync(path.join(cacheB, 'wishlist.json'), 'utf8')).diagnostics.attestations.transfer;
    assert.equal(t.provenance, 'download'); assert.equal(t.level, 'download-summary-verified'); assert.equal(t.sourceDigest, 'unavailable');
    assert.equal(t.localSha256Fingerprint, exactSha); assert.match(t.note, /Exact end-to-end byte equality is not claimed/); assert.equal(t.pageSummaryChecks.length, 9);
  }
  // the runtime's own tool-result file, declared by the caller, is verified provenance without a digest
  const q = run(good, ...baseFlags, '--provenance', 'tool-result'); assert.equal(q.status, 0, q.stderr); assert.doesNotMatch(JSON.parse(q.stdout).reason, /provenance|transfer not verified/);
  // revoked consent stops the CLI
  fs.writeFileSync(path.join(home2, 'settings.json'), '{"version":1,"persistence":{"profileAndFeedback":false,"steamCache":false}}');
  assert.notEqual(run(good, '--account', 'me', '--access-scope', 'signed-in', '--dry-run').status, 0);
  fs.rmSync(home2, {recursive: true});
}

// Invocation through a symlinked skill directory whose path has spaces (how an installed skill is reached).
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc link test-'));
  const link = path.join(root, 'installed skill'); // symlink -> the real skill directory
  fs.symlinkSync(new URL('../../skills/game-curator', import.meta.url).pathname, link);
  const cli = path.join(link, 'scripts', 'claude-code', 'save-capture.mjs');
  const home3 = path.join(root, 'home dir'), cache3 = path.join(home3, 'cache', 'steam');
  fs.mkdirSync(cache3, {recursive: true});
  fs.writeFileSync(path.join(home3, 'settings.json'), '{"version":1,"persistence":{"profileAndFeedback":false,"steamCache":true}}');
  const input = path.join(root, 'result file.json');
  fs.writeFileSync(input, harness(make(5, {view: {...U, filters: 'unknown'}}))); // as a real page reports it: filters unobserved
  const args = [input, '--dest', cache3, '--account', 'me', '--access-scope', 'signed-in', '--view', 'unfiltered', '--provenance', 'tool-result'];
  const usage = spawnSync(process.execPath, [cli], {encoding: 'utf8'});
  assert.equal(usage.status, 2); assert.match(usage.stderr, /usage/); // the CLI really ran (it used to exit 0 silently)
  const dry = spawnSync(process.execPath, [cli, ...args, '--dry-run'], {encoding: 'utf8'});
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).action, 'create'); assert.equal(JSON.parse(dry.stdout).dryRun, true);
  assert.deepEqual(fs.readdirSync(cache3), []); // a dry run writes nothing
  const real = spawnSync(process.execPath, [cli, ...args], {encoding: 'utf8'});
  assert.equal(real.status, 0, real.stderr);
  const saved3 = JSON.parse(fs.readFileSync(path.join(cache3, 'wishlist.json'), 'utf8'));
  assert.equal(saved3.records.length, 5); assert.equal(saved3.diagnostics.attestations.filters, 'none');
  // Importing the modules must not run anything or print anything.
  for (const f of ['save-capture.mjs', 'build-page-script.mjs']) {
    const imp = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(path.join(link, 'scripts', 'claude-code', f))})`], {encoding: 'utf8'});
    assert.equal(imp.status, 0, imp.stderr); assert.equal(imp.stdout, '');
  }
  // Without the filters attestation the same capture is kept as a separate snapshot, never promoted.
  fs.rmSync(path.join(cache3, 'wishlist.json'));
  const unattested = spawnSync(process.execPath, [cli, input, '--dest', cache3, '--account', 'me', '--access-scope', 'signed-in', '--provenance', 'tool-result', '--dry-run'], {encoding: 'utf8'});
  const u = JSON.parse(unattested.stdout); assert.equal(u.action, 'separate'); assert.match(u.reason, /not verified as default sort/);
  fs.rmSync(root, {recursive: true});
}

// The committed page script must be the generated output of the template plus the shared row code, and stay read-only.
const generated = fs.readFileSync(new URL('../../skills/game-curator/scripts/claude-code/steam-wishlist-page.js', import.meta.url), 'utf8');
// ---- Library source: the same saver, source-specific rules ----
{
  const lrow = (i, extra = '') => normalizeLibraryRecord({appid: 3000 + i, name: `Lib ${i}`, pageText: `Lib ${i}\n${extra}My Game Stats\nDOWNLOAD`, membershipSource: 'all-games-row'});
  const lib = (n, {at = '2026-11-26T05:00:00.000Z', account, accessScope = 'signed-in', view = {tab: 'all', search: 'empty', language: 'en'}, records, diag = {}} = {}) => {
    records ??= Array.from({length: n}, (_, i) => lrow(i + 1, i % 2 ? 'TOTAL PLAYED\n2.5 hours\nLAST PLAYED\nMay 1, 2025\nACHIEVEMENTS\n3/10\n' : ''));
    const env = {format: 'game-curator-steam-export', version: 1, source: 'library', capturedAt: at, method: 'browser-dom-claude-code', coverage: 'partial', warnings: ['w'],
      diagnostics: {expectedCount: records.length, uniqueCount: records.length, complete: true, stopReason: 'complete', ownerControls: true, view, recordsSha256: sha(JSON.stringify(records)), ...diag}, accessScope, records};
    if (account) env.account = account;
    return env;
  };
  // validation: shape, missing-value semantics, nested key order from the harness
  const good = lib(6);
  assert.deepEqual(validate(good, {accessScope: 'signed-in'}), {errors: [], incomplete: []});
  assert.deepEqual(Object.keys(canonicalize(good).records[0]), ['appid', 'name', 'pageText', 'membershipSource', 'hours', 'playtimeDisplay', 'lastPlayedDisplay', 'achievements']);
  const viaHarness = canonicalize(parseToolResult(harness(good))); // the harness alphabetizes keys, including inside achievements
  assert.deepEqual(Object.keys(viaHarness.records[1].achievements), ['unlocked', 'total']);
  assert.deepEqual(validate(viaHarness, {accessScope: 'signed-in'}), {errors: [], incomplete: []});
  const libBad = (env, re, o = {accessScope: 'signed-in'}) => assert.ok(validate(env, o).errors.some(e => re.test(e)), `expected library error ${re}`);
  { const e = lib(4); e.records[0].hours = 0; e.diagnostics.recordsSha256 = sha(JSON.stringify(e.records)); libBad(e, /field hours disagrees/); } // zero must not be invented for a missing label
  { const e = lib(4); e.records[1].achievements = null; e.diagnostics.recordsSha256 = sha(JSON.stringify(e.records)); libBad(e, /field achievements disagrees/); } // nor dropped when present
  { const e = lib(4); e.records[0].extra = 1; libBad(e, /unexpected field extra/); }
  { const e = lib(4); e.records[0].membershipSource = 'wishlist-row'; libBad(e, /membershipSource/); }
  { const e = lib(4); e.records[0].pageText = ' '; libBad(e, /empty pageText/); }
  { const e = lib(4); e.records[0].name = ''; libBad(e, /invalid name/); }
  { const e = lib(4); e.records[0].name = null; e.diagnostics.recordsSha256 = sha(JSON.stringify(e.records)); assert.deepEqual(validate(e, {accessScope: 'signed-in'}).errors, []); } // an unnamed row is data, not an error
  { const e = lib(4); e.records.push({...e.records[0]}); e.diagnostics.uniqueCount = 5; e.diagnostics.recordsSha256 = sha(JSON.stringify(e.records)); libBad(e, /duplicate appid/); }
  { const e = lib(4); e.diagnostics.ownerControls = false; libBad(e, /signed-in scope claimed without owner-only evidence/); }
  { const e = lib(4); e.diagnostics.ownerControls = false; assert.deepEqual(validate(e, {accessScope: 'public'}).errors, []); }
  assert.ok(validate(lib(4, {diag: {expectedCount: 9}}), {accessScope: 'signed-in'}).incomplete.some(r => /9 items/.test(r)));
  assert.ok(validate(lib(4, {diag: {expectedCount: null}}), {accessScope: 'signed-in'}).incomplete.some(r => /count was not available/.test(r)));
  assert.ok(validate(lib(4, {diag: {complete: false, stopReason: 'no-progress'}}), {accessScope: 'signed-in'}).incomplete.some(r => /no-progress/.test(r)));
  { const e = lib(0, {records: [], diag: {expectedCount: 0, stopReason: 'empty-observed', complete: false}}); assert.ok(validate(e, {accessScope: 'unknown'}).incomplete.some(r => /empty source observed/.test(r))); }
  assert.ok(validate({...lib(2), source: 'achievements'}, {accessScope: 'signed-in'}).errors.some(e => /unsupported source/.test(e)));
  // policy: view evidence is observed (tab all, empty search); no attestation exists for the library
  const lnext = lib(4, {account: 'me', at: '2026-11-27T00:00:00.000Z'});
  assert.equal(decide(null, lnext).action, 'create');
  for (const view of [{tab: 'completed', search: 'empty'}, {tab: 'all', search: 'active'}, {tab: null, search: 'empty'}, {tab: 'all', search: 'unknown'}])
    assert.match(decideRaw(null, lib(4, {account: 'me', view}), {transferVerified: true}).reason, /not verified as the "All Games" tab/);
  const lold = lib(5, {account: 'me', at: '2026-11-26T00:00:00.000Z'});
  assert.equal(decide(lold, lnext).action, 'replace'); // fewer games (a removal or refund) still replaces
  assert.match(reason({...lold, account: 'other'}, lnext), /account/);
  assert.match(reason({...lold, diagnostics: {...lold.diagnostics, view: {tab: 'completed', search: 'empty'}}}, lnext), /non-default view/);
  assert.match(reason({...lold, diagnostics: {...lold.diagnostics, view: undefined}}, lnext), /no view evidence/);
  assert.match(reason({...lold, diagnostics: {...lold.diagnostics, view: undefined}}, lnext, {existingViewUnfiltered: true}), /no view evidence/); // the library has no attestation route
  assert.match(reason({...lold, source: 'wishlist'}, lnext), /not a valid library envelope/);
  // field loss: playtime, last played and achievements that existed must not vanish for a retained game
  { const a = lib(0, {account: 'me', at: '2026-11-26T00:00:00.000Z', records: [lrow(1, 'TOTAL PLAYED\n9 hours\nLAST PLAYED\nMay 1, 2025\nACHIEVEMENTS\n1/2\n'), lrow(2)]});
    const b = lib(0, {account: 'me', at: '2026-11-27T00:00:00.000Z', records: [lrow(1, 'TOTAL PLAYED\n9 hours\n'), lrow(2, 'TOTAL PLAYED\n1 hours\nLAST PLAYED\nMay 2, 2025\nACHIEVEMENTS\n1/2\n')]});
    assert.deepEqual(fieldLosses(a, b), {lastPlayedDisplay: 1, achievements: 1}); assert.match(reason(a, b), /lose fields/); // a gained field on another game does not offset them
    assert.equal(decide(b, a).action !== undefined, true); }
  // files: each source has its own cache file, snapshots and lock; a library save never touches wishlist.json
  const rootTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-lib-')), dest2 = path.join(rootTmp, 'game-curator', 'cache', 'steam');
  fs.mkdirSync(dest2, {recursive: true}); fs.writeFileSync(path.join(rootTmp, 'game-curator', 'settings.json'), '{"version":1,"persistence":{"profileAndFeedback":false,"steamCache":true}}');
  const wl = make(3, {account: 'me', at: '2026-11-26T01:00:00.000Z'});
  assert.equal(save(wl, dest2).target, path.join(dest2, 'wishlist.json'));
  const wlBefore = fs.readFileSync(path.join(dest2, 'wishlist.json'), 'utf8');
  const l1 = save(lold, dest2); assert.equal(l1.action, 'create'); assert.equal(l1.target, path.join(dest2, 'library.json'));
  const l2 = save(lnext, dest2); assert.equal(l2.action, 'replace'); assert.match(path.basename(l2.backup), /^library\.superseded\.20261126T000000Z\.json$/);
  const l3 = save(lib(4, {account: 'me', at: '2026-11-28T00:00:00.000Z', view: {tab: 'all', search: 'active'}}), dest2); assert.equal(l3.action, 'separate'); assert.match(path.basename(l3.target), /^library\.partial\.20261128T000000Z\.json$/);
  assert.equal(fs.readFileSync(path.join(dest2, 'wishlist.json'), 'utf8'), wlBefore);
  assert.equal(fs.readdirSync(dest2).filter(f => f.startsWith('.')).length, 0);
  fs.rmSync(rootTmp, {recursive: true});
  // end to end: simulated page -> tool-result file and -> download with a page summary -> CLI
  {
    const cli = new URL('../../skills/game-curator/scripts/claude-code/save-capture.mjs', import.meta.url).pathname;
    const home4 = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-lib-e2e-')), cache4 = path.join(home4, 'cache', 'steam'); fs.mkdirSync(cache4, {recursive: true});
    fs.writeFileSync(path.join(home4, 'settings.json'), '{"version":1,"persistence":{"profileAndFeedback":false,"steamCache":true}}');
    const fast = {quietMs: 100, stallMs: 150}, plain = async () => JSON.parse(JSON.stringify(await makeLibraryPage({n: 40, chunk: 20}).run(fast)));
    const trFile = path.join(home4, 'tool-result.json'); fs.writeFileSync(trFile, harness(await plain()));
    const run4 = (file, ...a) => spawnSync(process.execPath, [cli, file, '--dest', cache4, '--account', 'me', '--access-scope', 'signed-in', ...a], {encoding: 'utf8'});
    let r4 = run4(trFile, '--provenance', 'tool-result'); assert.equal(r4.status, 0, r4.stderr); assert.equal(JSON.parse(r4.stdout).action, 'create');
    const saved4 = JSON.parse(fs.readFileSync(path.join(cache4, 'library.json'), 'utf8'));
    assert.equal(saved4.records.length, 40); assert.equal(saved4.source, 'library'); assert.equal(saved4.diagnostics.attestations.transfer.level, 'runtime-tool-result');
    assert.equal(run4(trFile, '--provenance', 'tool-result', '--view', 'unfiltered').status === 0, false); // no attestation exists for the library
    const pg = makeLibraryPage({n: 40, chunk: 20}); const summary = JSON.parse(JSON.stringify(await pg.run({...fast, deliver: 'download'})));
    const dlText = await pg.state.downloads[0].blob.text(); const dlPath = path.join(home4, summary.file); fs.writeFileSync(dlPath, dlText);
    r4 = run4(dlPath, '--provenance', 'download', '--page-summary', JSON.stringify(summary), '--dry-run'); assert.equal(r4.status, 0, r4.stderr);
    assert.doesNotMatch(JSON.parse(r4.stdout).reason, /provenance|transfer not verified/);
    r4 = run4(dlPath, '--provenance', 'download', '--page-summary', JSON.stringify({...summary, view: {...summary.view, tab: 'completed'}}), '--dry-run'); assert.notEqual(r4.status, 0); assert.match(r4.stderr, /view differs/);
    pg.ctx.window.__gcRelease();
    fs.rmSync(home4, {recursive: true});
  }
}

// ---- Reviews source: observed fields only, names only by verified enrichment ----
{
  const LIBSHA = crypto.createHash('sha256').update('library snapshot bytes').digest('hex');
  const enrich = (e, l, o = {}) => enrichReviewNames(e, l, {librarySha256: LIBSHA, ...o}); // a local digest binds enrichment to the exact snapshot
  const rrow = (i, o = {}) => ({appid: 5000 + i, reviewUrl: `https://steamcommunity.com/id/test/recommended/${5000 + i}/`, recommended: i % 3 !== 0, review: `Review ${i}`, playtimeDisplay: `${i}.5 hrs on record`, postedDate: `Posted May ${i}.`, ...o});
  const rev = (n, {at = '2026-11-26T09:00:00.000Z', account, accessScope = 'signed-in', view = {kind: 'recommended-list', language: 'en'}, records, diag = {}} = {}) => {
    records ??= Array.from({length: n}, (_, i) => rrow(i + 1));
    const observed = records.map(({name, nameSource, ...r}) => r);
    const env = {format: 'game-curator-steam-export', version: 1, source: 'reviews', capturedAt: at, method: 'browser-dom-claude-code', coverage: 'partial', warnings: ['w'],
      diagnostics: {expectedCount: records.length, uniqueCount: records.length, pagesVisited: 2, pagesPending: 0, pageAttempts: 2, complete: true, stopReason: 'complete', ownerControls: true, urlPath: '/id/test/recommended', view, recordsSha256: sha(JSON.stringify(observed)), ...diag}, accessScope, records};
    if (account) env.account = account;
    return env;
  };
  const good = rev(5);
  assert.deepEqual(validate(good, {accessScope: 'signed-in'}), {errors: [], incomplete: []});
  assert.deepEqual(Object.keys(canonicalize(good).records[0]), ['appid', 'reviewUrl', 'recommended', 'review', 'playtimeDisplay', 'postedDate']);
  const viaHarness = canonicalize(parseToolResult(harness(good))); assert.deepEqual(validate(viaHarness, {accessScope: 'signed-in'}), {errors: [], incomplete: []}); // alphabetized keys restored
  assert.deepEqual(Object.keys(viaHarness.records[0]), ['appid', 'reviewUrl', 'recommended', 'review', 'playtimeDisplay', 'postedDate']);
  const revBad = (env, re) => assert.ok(validate(env, {accessScope: 'signed-in'}).errors.some(e => re.test(e)), `expected reviews error ${re}`);
  { const e = rev(3); e.records[0].reviewUrl = 'https://evil.example/recommended/5001/'; revBad(e, /invalid reviewUrl/); }
  { const e = rev(3); e.records[0].reviewUrl = 'https://steamcommunity.com/id/test/recommended/9999/'; revBad(e, /does not match its appid/); }
  { const e = rev(3); e.records[0].recommended = 'yes'; revBad(e, /invalid recommended/); }
  { const e = rev(3); e.records[0].review = ''; revBad(e, /invalid review/); }
  { const e = rev(3); e.records[0].review = 5; revBad(e, /invalid review/); }
  { const e = rev(3); e.records[0].extra = 1; revBad(e, /unexpected field extra/); }
  { const e = rev(3); e.records[1].appid = e.records[0].appid; e.records[1].reviewUrl = e.records[0].reviewUrl; revBad(e, /duplicate appid/); }
  { const e = rev(3); e.records[0].name = 'Some Game'; revBad(e, /name without nameSource/); } // a name may only come from marked enrichment
  { const e = rev(3); e.records[0].nameSource = 'verified-library-capture'; revBad(e, /invalid name/); }
  { const e = rev(3); e.records[0].review = null; e.records[0].recommended = null; e.diagnostics.recordsSha256 = sha(JSON.stringify(e.records.map(({name, nameSource, ...r}) => r))); assert.deepEqual(validate(e, {accessScope: 'signed-in'}).errors, []); } // unknown stays null
  { const e = rev(3); e.diagnostics.ownerControls = false; revBad(e, /signed-in scope claimed without owner-only evidence/); }
  assert.ok(validate(rev(3, {diag: {pagesPending: 2, complete: false, stopReason: 'budget'}}), {accessScope: 'signed-in'}).incomplete.some(r => /2 review pages were not visited/.test(r)));
  assert.ok(validate(rev(3, {diag: {expectedCount: 9}}), {accessScope: 'signed-in'}).incomplete.some(r => /9 items/.test(r)));
  // enrichment: only from a same-account library, marked, and the observed-fields checksum keeps the enriched file self-consistent
  const libAccount = (account, accessScope = 'signed-in', extra = {}) => ({format: 'game-curator-steam-export', version: 1, source: 'library', capturedAt: '2026-11-25T00:00:00.000Z', method: 'browser-dom', coverage: 'partial', warnings: [], diagnostics: {}, ...(account ? {account} : {}), accessScope,
    records: [{appid: 5001, name: 'Game One', pageText: 'x', membershipSource: 'all-games-row'}, {appid: 5002, name: null, pageText: 'x', membershipSource: 'all-games-row'}], ...extra});
  const rv = rev(3, {account: 'me'});
  const {env: enriched, enrichment} = enrich(rv, libAccount('me'));
  assert.equal(enriched.records[0].name, 'Game One'); assert.equal(enriched.records[0].nameSource, 'verified-library-capture');
  assert.ok(!('name' in enriched.records[1]) && !('name' in enriched.records[2]), 'no library name means no name, never a guess');
  assert.deepEqual({...enrichment, librarySha256: undefined, libraryAccount: undefined}, {names: 'verified-library-capture', namedRecords: 1, recordsWithoutName: 2, libraryCapturedAt: '2026-11-25T00:00:00.000Z', libraryRecords: 2, librarySha256: undefined, libraryAccount: undefined});
  assert.ok(enriched.warnings.some(w => /names are missing/.test(w)));
  assert.deepEqual(enrichment, {...enrichment, librarySha256: LIBSHA, libraryAccount: 'me'});
  { const saved = canonicalize({...enriched, diagnostics: {...enriched.diagnostics, attestations: {enrichment}}}); assert.deepEqual(validate(saved, {account: 'me', accessScope: 'signed-in'}), {errors: [], incomplete: []}); } // names are valid only with their bound attestation
  assert.equal(rv.records[0].name, undefined, 'the observed capture is not mutated');
  assert.throws(() => enrich(rv, libAccount('other')), /same account/);
  assert.throws(() => enrich(rv, libAccount(undefined)), /same account/);
  assert.equal(enrich(rv, libAccount(undefined), {libraryAccount: 'me'}).enrichment.namedRecords, 1); // a user-confirmed alias for an older library file
  assert.throws(() => enrich(rv, libAccount(undefined), {libraryAccount: 'other'}), /same account/);
  assert.throws(() => enrich({...rv, account: undefined}, libAccount('me')), /same account/);
  assert.throws(() => enrich(rv, libAccount('me', 'unknown')), /established access scope/);
  assert.throws(() => enrich(rv, {...libAccount('me'), source: 'wishlist'}), /not a valid library capture/);
  assert.throws(() => enrich(make(2, {account: 'me'}), libAccount('me')), /only to a reviews capture/);
  // ---- negative tests for the review's trust rules ----
  // Enrichment must be bound to the exact library snapshot (local digest).
  assert.throws(() => enrichReviewNames(rv, libAccount('me')), /bound to the exact library snapshot/);
  assert.throws(() => enrichReviewNames(rv, libAccount('me'), {librarySha256: 'abc'}), /bound to the exact library snapshot/);
  // A page transfer may not carry names or attestations: only the verified enrichment step adds names.
  { const e = rev(3); e.records[0].name = 'Planted'; e.records[0].nameSource = 'verified-library-capture';
    const v = validate(e, {accessScope: 'signed-in', incoming: true}); assert.ok(v.errors.some(m => /must not carry game names/.test(m)), 'incoming names must be rejected');
    assert.ok(validate(e, {accessScope: 'signed-in'}).errors.some(m => /without a matching verified enrichment attestation/.test(m))); } // and not accepted as a saved file either
  { const e = rev(3); e.diagnostics.attestations = {enrichment: {names: 'verified-library-capture', namedRecords: 0, librarySha256: LIBSHA}};
    assert.ok(validate(e, {accessScope: 'signed-in', incoming: true}).errors.some(m => /must not carry diagnostics.attestations/.test(m))); }
  // A planted attestation cannot launder planted names: it must match the count and carry a snapshot digest.
  for (const [label, attestation] of [['wrong count', {names: 'verified-library-capture', namedRecords: 2, librarySha256: LIBSHA}], ['no digest', {names: 'verified-library-capture', namedRecords: 1}],
    ['malformed digest', {names: 'verified-library-capture', namedRecords: 1, librarySha256: 'zz'}], ['wrong mode', {names: 'other', namedRecords: 1, librarySha256: LIBSHA}]]) {
    const e = rev(3); e.records[0].name = 'Planted'; e.records[0].nameSource = 'verified-library-capture'; e.diagnostics.attestations = {enrichment: attestation};
    assert.ok(validate(e, {accessScope: 'signed-in'}).errors.some(m => /without a matching verified enrichment attestation/.test(m)), label);
  }
  // Attribution is re-derived against the bound library: wrong name, missing marker, and a name for a game the library cannot name are all caught.
  { const library = libAccount('me'); const ok = enrich(rev(3, {account: 'me'}), library).env;
    assert.deepEqual(verifyNameAttribution(ok, library), []);
    const wrongName = {...ok, records: ok.records.map((r, i) => (i === 0 ? {...r, name: 'Another Game'} : r))}; assert.match(verifyNameAttribution(wrongName, library)[0], /does not give it/);
    const noMarker = {...ok, records: ok.records.map((r, i) => (i === 0 ? {...r, nameSource: 'guess'} : r))}; assert.match(verifyNameAttribution(noMarker, library)[0], /without the verified marker/);
    const unnamedInLib = {...ok, records: ok.records.map((r, i) => (i === 2 ? {...r, name: 'Invented', nameSource: 'verified-library-capture'} : r))}; assert.match(verifyNameAttribution(unnamedInLib, library)[0], /AppID 5003/); }
  // A review URL must belong to the collected list's account path, not just carry the right appid.
  { const e = rev(3); e.records[0].reviewUrl = 'https://steamcommunity.com/id/other/recommended/5001/'; e.diagnostics.recordsSha256 = sha(JSON.stringify(e.records.map(({name, nameSource, ...r}) => r)));
    assert.ok(validate(e, {accessScope: 'signed-in'}).errors.some(m => /different account path than the collected list/.test(m))); }
  { const e = rev(3); e.diagnostics.urlPath = '/id/test/other'; assert.ok(validate(e, {accessScope: 'signed-in'}).errors.some(m => /urlPath is not a reviews list path/.test(m))); }
  { const e = rev(3); delete e.diagnostics.urlPath; assert.ok(validate(e, {accessScope: 'signed-in'}).errors.some(m => /urlPath is not a reviews list path/.test(m))); }
  // Required pagination diagnostics are validated before anything can be promoted.
  for (const [label, patch, re] of [['missing pagesVisited', {pagesVisited: undefined}, /pagesVisited must be a non-negative integer/], ['negative pagesPending', {pagesPending: -1}, /pagesPending must be a non-negative integer/],
    ['fractional pageAttempts', {pageAttempts: 1.5}, /pageAttempts must be a non-negative integer/], ['string pagesVisited', {pagesVisited: '2'}, /pagesVisited must be a non-negative integer/],
    ['zero pages with records', {pagesVisited: 0, pageAttempts: 0}, /inconsistent with the records/], ['attempts below visited', {pagesVisited: 3, pageAttempts: 2}, /inconsistent with the records/],
    ['missing pageAttempts', {pageAttempts: undefined}, /pageAttempts must be a non-negative integer/]]) {
    const e = rev(3); Object.assign(e.diagnostics, patch); assert.ok(validate(e, {accessScope: 'signed-in'}).errors.some(m => re.test(m)), label);
  }
  // policy: view, field loss (a baseline that had names must not lose them), per-source files
  const rnext = rev(4, {account: 'me', at: '2026-11-28T00:00:00.000Z'}), rold = rev(5, {account: 'me', at: '2026-11-27T00:00:00.000Z'});
  assert.equal(decide(rold, rnext).action, 'replace'); assert.equal(decide(null, rnext).action, 'create'); // a removed review is a legitimate change
  assert.match(decideRaw(null, rev(4, {account: 'me', view: {kind: 'other'}}), {transferVerified: true}).reason, /not verified as the full "My reviews" list/);
  assert.match(reason({...rold, diagnostics: {...rold.diagnostics, view: undefined}}, rnext), /no view evidence/); // an older Codex baseline has no view evidence
  assert.match(reason({...rold, diagnostics: {...rold.diagnostics, view: {kind: 'other'}}}, rnext), /non-default view/);
  const named = enrich(rev(5, {account: 'me', at: '2026-11-27T00:00:00.000Z'}), libAccount('me')).env;
  assert.deepEqual(fieldLosses(named, rev(5, {account: 'me', at: '2026-11-28T00:00:00.000Z'})), {name: 1}); // un-enriched replacement would lose a name
  assert.match(reason(named, rev(5, {account: 'me', at: '2026-11-28T00:00:00.000Z'})), /lose fields/);
  assert.equal(decide(named, enrich(rev(5, {account: 'me', at: '2026-11-28T00:00:00.000Z'}), libAccount('me')).env).action, 'replace');
  const rootR = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-rev-')), destR = path.join(rootR, 'game-curator', 'cache', 'steam'); fs.mkdirSync(destR, {recursive: true});
  fs.writeFileSync(path.join(rootR, 'game-curator', 'settings.json'), '{"version":1,"persistence":{"profileAndFeedback":false,"steamCache":true}}');
  const r1 = save(rold, destR); assert.equal(r1.target, path.join(destR, 'reviews.json'));
  const r2 = save(rnext, destR); assert.equal(r2.action, 'replace'); assert.match(path.basename(r2.backup), /^reviews\.superseded\./);
  const partialRev = rev(4, {account: 'me', at: '2026-11-29T00:00:00.000Z', diag: {pagesPending: 1, complete: false, stopReason: 'budget'}});
  assert.equal(save(partialRev, destR, {incomplete: validate(partialRev, {accessScope: 'signed-in'}).incomplete}).action, 'separate'); // the CLI passes validate()'s incomplete reasons
  assert.ok(fs.readdirSync(destR).some(f => /^reviews\.partial\./.test(f)));
  fs.rmSync(rootR, {recursive: true});
  // end to end: simulated site -> navigations -> envelope -> CLI with enrichment from a library file
  {
    const cli = new URL('../../skills/game-curator/scripts/claude-code/save-capture.mjs', import.meta.url).pathname;
    const home5 = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-rev-e2e-')), cache5 = path.join(home5, 'cache', 'steam'); fs.mkdirSync(cache5, {recursive: true});
    fs.writeFileSync(path.join(home5, 'settings.json'), '{"version":1,"persistence":{"profileAndFeedback":false,"steamCache":true}}');
    const site = makeReviewsSite({total: 25});
    let r = JSON.parse(JSON.stringify(await site.runFile({deliver: 'download'})));
    while (r.status === 'continue') { site.navigate(r.next); r = JSON.parse(JSON.stringify(await site.runFile({deliver: 'download'}))); } // every page re-runs the trusted file
    const dlText = await site.downloads[0].blob.text(), dlPath = path.join(home5, r.file); fs.writeFileSync(dlPath, dlText);
    const libFile = path.join(home5, 'library.json'); fs.writeFileSync(libFile, JSON.stringify(libAccount('me', 'signed-in', {records: Array.from({length: 25}, (_, i) => ({appid: 4000 + i, name: `Lib Game ${i}`, pageText: 'x', membershipSource: 'all-games-row'})).slice(0, 20)})));
    const run5 = (...a) => spawnSync(process.execPath, [cli, dlPath, '--dest', cache5, '--account', 'me', '--access-scope', 'signed-in', '--provenance', 'download', '--page-summary', JSON.stringify(r), ...a], {encoding: 'utf8'});
    let o = run5('--dry-run'); assert.equal(o.status, 0, o.stderr); assert.equal(JSON.parse(o.stdout).action, 'create');
    o = run5('--names-from', libFile); assert.equal(o.status, 0, o.stderr);
    const saved5 = JSON.parse(fs.readFileSync(path.join(cache5, 'reviews.json'), 'utf8'));
    assert.equal(saved5.records.length, 25); assert.equal(saved5.records.filter(x => x.nameSource === 'verified-library-capture').length, 20);
    assert.equal(saved5.diagnostics.attestations.enrichment.namedRecords, 20); assert.equal(saved5.diagnostics.attestations.enrichment.librarySha256, crypto.createHash('sha256').update(fs.readFileSync(libFile)).digest('hex'), 'enrichment is bound to the exact snapshot bytes'); assert.equal(saved5.diagnostics.attestations.transfer.level, 'download-summary-verified');
    assert.deepEqual(validate(canonicalize(saved5), {account: 'me', accessScope: 'signed-in'}), {errors: [], incomplete: []});
    o = run5('--library-account', 'me'); assert.notEqual(o.status, 0); assert.match(o.stderr, /applies only with --names-from/);
    fs.writeFileSync(libFile, JSON.stringify(libAccount('other'))); o = run5('--names-from', libFile, '--dry-run'); assert.notEqual(o.status, 0); assert.match(o.stderr, /same account/);
    assert.equal(run5('--view', 'unfiltered', '--dry-run').status === 0, false); // no attestation exists for reviews
    // A page transfer that already carries names or attestations is rejected outright, before any enrichment or save.
    { const planted = JSON.parse(dlText); planted.records[0].name = 'Planted'; planted.records[0].nameSource = 'verified-library-capture'; const pf = path.join(home5, 'planted.json'); fs.writeFileSync(pf, JSON.stringify(planted));
      const o2 = spawnSync(process.execPath, [cli, pf, '--dest', cache5, '--account', 'me', '--access-scope', 'signed-in', '--provenance', 'download', '--dry-run'], {encoding: 'utf8'});
      assert.notEqual(o2.status, 0); assert.match(o2.stderr, /must not carry game names/);
      const forged = JSON.parse(dlText); forged.diagnostics.attestations = {enrichment: {names: 'verified-library-capture', namedRecords: 0, librarySha256: 'a'.repeat(64)}}; const ff = path.join(home5, 'forged.json'); fs.writeFileSync(ff, JSON.stringify(forged));
      const o3 = spawnSync(process.execPath, [cli, ff, '--dest', cache5, '--account', 'me', '--access-scope', 'signed-in', '--provenance', 'download', '--dry-run'], {encoding: 'utf8'});
      assert.notEqual(o3.status, 0); assert.match(o3.stderr, /must not carry diagnostics.attestations/); }
    site.ctx.window.__gcRelease?.();
    fs.rmSync(home5, {recursive: true});
  }
}

// The page scripts only read the page; the one local write path is the Blob download inside deliverEnvelope (shared by every source).
const delivery = fn => { const i = generated.indexOf(`function ${fn}(`); return i; };
for (const name of ['wishlist', 'library', 'reviews', 'replay']) {
  const src = fs.readFileSync(new URL(`../../skills/game-curator/scripts/claude-code/steam-${name}-page.js`, import.meta.url), 'utf8');
  assert.equal(src, buildPageScript(name), `steam-${name}-page.js is stale: run node skills/game-curator/scripts/claude-code/build-page-script.mjs`);
  const d0 = src.indexOf('async function deliverEnvelope('), d1 = src.indexOf('\n  }\n', d0);
  assert.ok(d0 > 0 && d1 > d0, `${name}: deliverEnvelope not found`);
  const outside = src.slice(0, d0) + src.slice(d1);
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|localStorage|document\.cookie|\.click\(|dispatchEvent|\.submit\(/.test(outside), `${name}: page script must stay read-only on the page`);
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|localStorage|document\.cookie/.test(src.slice(d0, d1)), `${name}: the download block must be local only (Blob + anchor)`);
}
console.log('Claude Code collector checks passed');
