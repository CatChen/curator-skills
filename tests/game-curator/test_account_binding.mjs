// Account binding end to end on scratch homes (synthetic IDs and settings only; no production file is read or written).
// FIXTURE tests: identity observations are built by hand in the shape the page scripts emit; live sessions are exercised separately.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fingerprintSync, newSalt, saltCheckOf, readSettingsFile, bindingKey, parseSettings} from '../../skills/game-curator/scripts/settings.mjs';
import {planBinding} from '../../skills/game-curator/scripts/bind-account.mjs';
import {evaluateIdentity, identityPolicy, checkObservation} from '../../skills/game-curator/scripts/identity.mjs';
import {save, selectSnapshots} from '../../skills/game-curator/scripts/cache.mjs';

const saver = fileURLToPath(new URL('../../skills/game-curator/scripts/claude-code/save-capture.mjs', import.meta.url));
const binder = fileURLToPath(new URL('../../skills/game-curator/scripts/bind-account.mjs', import.meta.url));
const ID_A = '76561197960278073', ID_B = '76561197960320049'; // synthetic
const DECOYS = [ID_A, ID_B, 'decoy_login_name', 'decoy-webapi-token-0123456789'];
const records = [{appid: 12345, rank: 1, name: 'Synthetic game', pageText: 'Synthetic game\nRELEASE DATE:\n2025', membershipSource: 'wishlist-row'}];
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const tmpRoots = [];

function home({settings = {version: 1, persistence: {profileAndFeedback: true, steamCache: true}}} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-binding-')); tmpRoots.push(root);
  const dest = path.join(root, 'cache', 'steam'); fs.mkdirSync(dest, {recursive: true, mode: 0o700});
  const file = path.join(root, 'settings.json'); fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', {mode: 0o600});
  return {root, dest, file};
}
const probeFor = (id, salt = newSalt()) => ({format: 'game-curator-identity-probe', version: 1, sources: ['user-config'], loggedIn: true, consistent: true, saltCheck: saltCheckOf(salt), sessionFingerprint: fingerprintSync(salt, id), pathFingerprint: null, salt});
const bound = (h, id = ID_A, alias = 'my-steam') => { const probe = probeFor(id); planBinding(h.file, {op: 'bind', probe, alias, apply: true}); return {salt: probe.salt, alias}; };
const obs = (b, id, o = {}) => ({version: 1, sources: ['user-config'], loggedIn: true, consistent: true, saltCheck: saltCheckOf(b.salt), sessionFingerprint: fingerprintSync(b.salt, id), pathFingerprint: null, ...o});
const capture = (at, {identity, handles = true} = {}) => ({format: 'game-curator-steam-export', version: 1, source: 'wishlist', capturedAt: at, method: 'browser-dom-claude-code', coverage: 'partial', warnings: [],
  diagnostics: {expectedCount: 1, uniqueCount: 1, ranksObserved: 1, placeholderNameRows: 0, complete: true, stopReason: 'complete', reorderHandles: handles, view: {sort: 'Your Rank', search: 'empty', filters: 'unknown'}, recordsSha256: sha(JSON.stringify(records)), ...(identity ? {identity} : {})},
  accessScope: 'unknown', records});
function runSaver(h, env, extra = [], {dry = false} = {}) {
  const input = path.join(h.root, 'capture.json');
  fs.writeFileSync(input, JSON.stringify([{type: 'text', text: JSON.stringify(env)}]), {mode: 0o600});
  const r = spawnSync(process.execPath, [saver, input, '--dest', h.dest, '--view', 'unfiltered', '--provenance', 'tool-result', ...extra, ...(dry ? ['--dry-run'] : [])], {encoding: 'utf8'});
  return {status: r.status, out: r.stdout, err: r.stderr, json: r.status === 0 ? JSON.parse(r.stdout) : null};
}
const files = h => fs.readdirSync(h.dest).filter(n => !n.startsWith('.')).sort();
const stored = (h, name = 'wishlist.json') => JSON.parse(fs.readFileSync(path.join(h.dest, name), 'utf8'));
const noLeak = (text, label) => { for (const v of DECOYS) assert.ok(!text.includes(v), `${label} leaks ${v}`); };
function scanTree(dir) { for (const n of fs.readdirSync(dir, {withFileTypes: true})) { const p = path.join(dir, n.name); if (n.isDirectory()) scanTree(p); else noLeak(fs.readFileSync(p, 'utf8'), p); } }

try {
  // ---- C1 unbound: the manual flow is unchanged and records no identity attestation
  {
    const h = home();
    const r = runSaver(h, capture('2026-01-01T00:00:00Z'), ['--account', 'my-steam', '--access-scope', 'signed-in']);
    assert.equal(r.json.action, 'create');
    const e = stored(h); assert.equal(e.account, 'my-steam'); assert.ok(!('identity' in e.diagnostics.attestations)); assert.equal(e.diagnostics.attestations.account, 'my-steam');
    const noAccount = runSaver(h, capture('2026-01-02T00:00:00Z'), []); assert.equal(noAccount.json.action, 'separate');
  }

  // ---- E. explicit bind / change / revoke on an existing file; persistence preserved; nothing automatic
  {
    for (const persistence of [{profileAndFeedback: true, steamCache: false}, {profileAndFeedback: false, steamCache: true}]) {
      const h = home({settings: {version: 1, persistence}}); const before = fs.readFileSync(h.file, 'utf8');
      const probe = probeFor(ID_A);
      const plan = planBinding(h.file, {op: 'bind', probe, alias: 'my-steam'}); // no apply: a plan only
      assert.equal(plan.applied, false); assert.equal(fs.readFileSync(h.file, 'utf8'), before, 'a plan writes nothing');
      const done = planBinding(h.file, {op: 'bind', probe, alias: 'my-steam', apply: true});
      assert.equal(done.applied, true); const back = readSettingsFile(h.file).settings;
      assert.equal(back.version, 2); assert.deepEqual(back.persistence, persistence, 'persistence choices preserved exactly'); assert.equal(back.steamAccount.alias, 'my-steam'); assert.equal(back.steamAccount.fingerprint.value, probe.sessionFingerprint);
      assert.ok(!fs.readFileSync(h.file, 'utf8').includes(ID_A), 'no raw identifier in settings');
      assert.deepEqual(fs.readdirSync(h.root).filter(n => n.startsWith('.settings')), [], 'no temp file left behind');
      assert.throws(() => planBinding(h.file, {op: 'bind', probe: probeFor(ID_B), alias: 'other', apply: true}), /already bound/);
      assert.throws(() => planBinding(h.file, {op: 'change', probe, alias: 'my-steam', apply: true}), /identical/);
    }
    const h = home(); const b = bound(h);
    const probeB = probeFor(ID_B), changed = planBinding(h.file, {op: 'change', probe: probeB, alias: 'second-account', apply: true});
    assert.match(changed.followUp, /ask the user explicitly/i); assert.equal(readSettingsFile(h.file).settings.steamAccount.alias, 'second-account');
    const revoked = planBinding(h.file, {op: 'revoke', apply: true});
    assert.equal(readSettingsFile(h.file).settings.steamAccount, null); assert.equal(revoked.alias, null); assert.equal(readSettingsFile(h.file).settings.version, 2);
    assert.throws(() => planBinding(h.file, {op: 'revoke', apply: true}), /no account is bound/);
    assert.throws(() => planBinding(h.file, {op: 'change', probe: probeB, alias: 'x', apply: true}), /use bind/);
    void b;
  }
  {
    const h = home(), good = probeFor(ID_A), before = fs.readFileSync(h.file, 'utf8');
    for (const [name, probe, alias] of [
      ['signed out', {...good, loggedIn: false}, 'a'], ['not signed in (null)', {...good, loggedIn: null}, 'a'], ['inconsistent', {...good, consistent: false}, 'a'], ['no fingerprint', {...good, sessionFingerprint: null}, 'a'],
      ['no salt (a verify probe, not candidate)', {...good, salt: undefined}, 'a'], ['salt check mismatch', {...good, saltCheck: '00000000'}, 'a'], ['short salt', {...good, salt: 'AQID', saltCheck: saltCheckOf('AQID')}, 'a'],
      ['bad alias', good, '../x'], ['no alias', good, undefined], ['not an object', null, 'a'],
    ]) assert.throws(() => planBinding(h.file, {op: 'bind', probe, alias, apply: true}), /./, name);
    assert.equal(fs.readFileSync(h.file, 'utf8'), before, 'refused operations change nothing');
    // missing, malformed or unsupported settings are never created or repaired by a bind
    const none = path.join(h.root, 'absent.json'); assert.throws(() => planBinding(none, {op: 'bind', probe: good, alias: 'a', apply: true}), /settings not usable/); assert.ok(!fs.existsSync(none));
    for (const bad of ['{', '{"version":3,"persistence":{"profileAndFeedback":true,"steamCache":true}}', '{"version":1,"persistence":{"profileAndFeedback":true}}']) { fs.writeFileSync(h.file, bad); assert.throws(() => planBinding(h.file, {op: 'bind', probe: good, alias: 'a', apply: true}), /settings not usable/); assert.equal(fs.readFileSync(h.file, 'utf8'), bad); }
  }
  { // concurrent edit between read and rename: nothing overwritten
    const h = home(), probe = probeFor(ID_A), edited = JSON.stringify({version: 1, persistence: {profileAndFeedback: false, steamCache: false}});
    assert.throws(() => planBinding(h.file, {op: 'bind', probe, alias: 'a', apply: true, hooks: {beforeCommit: () => fs.writeFileSync(h.file, edited)}}), /changed while/);
    assert.equal(fs.readFileSync(h.file, 'utf8'), edited); assert.deepEqual(fs.readdirSync(h.root).filter(n => n.startsWith('.settings')), []);
  }
  { // CLI: status never prints the fingerprint; a plan without --apply writes nothing; usage errors
    const h = home(), probeFile = path.join(h.root, 'probe.json'); fs.writeFileSync(probeFile, JSON.stringify(probeFor(ID_A)));
    const plan = spawnSync(process.execPath, [binder, 'bind', '--settings', h.file, '--probe', probeFile, '--alias', 'my-steam'], {encoding: 'utf8'});
    assert.equal(plan.status, 0, plan.stderr); assert.equal(JSON.parse(plan.stdout).applied, false); assert.equal(readSettingsFile(h.file).settings.version, 1);
    const apply = spawnSync(process.execPath, [binder, 'bind', '--settings', h.file, '--probe', probeFile, '--alias', 'my-steam', '--apply'], {encoding: 'utf8'}); assert.equal(apply.status, 0, apply.stderr);
    const status = spawnSync(process.execPath, [binder, 'status', '--settings', h.file], {encoding: 'utf8'}); const st = JSON.parse(status.stdout);
    assert.deepEqual(Object.keys(st), ['version', 'persistence', 'bound', 'alias', 'approvedAt', 'salt']); assert.equal(st.bound, true); assert.ok(!status.stdout.includes(readSettingsFile(h.file).settings.steamAccount.fingerprint.value), 'status never prints the fingerprint');
    assert.equal(spawnSync(process.execPath, [binder, 'frobnicate', '--settings', h.file], {encoding: 'utf8'}).status, 2);
  }

  // ---- B. bound identity at capture time
  { // match + owner evidence: no manual alias; scope observed; the observation is consumed, only the verdict stored
    const h = home(), b = bound(h);
    const r = runSaver(h, capture('2026-01-01T00:00:00Z', {identity: obs(b, ID_A)}), []);
    assert.equal(r.status, 0, r.err); assert.equal(r.json.action, 'create');
    const e = stored(h); assert.equal(e.account, 'my-steam'); assert.equal(e.accessScope, 'signed-in');
    assert.deepEqual(e.diagnostics.attestations.identity, {by: 'binding', result: 'match', ownership: 'verified', source: 'user-config'});
    assert.ok(!('identity' in e.diagnostics), 'the raw observation is not stored'); assert.equal(e.diagnostics.attestations.account, 'my-steam');
    assert.ok(!JSON.stringify(e).includes(b.salt) && !JSON.stringify(e).includes(readSettingsFile(h.file).settings.steamAccount.fingerprint.value));
    const again = runSaver(h, capture('2026-01-02T00:00:00Z', {identity: obs(b, ID_A)}), []); assert.equal(again.json.action, 'refresh');
    assert.equal(runSaver(h, capture('2026-01-03T00:00:00Z', {identity: obs(b, ID_A)}), ['--account', 'my-steam']).json.action, 'refresh', 'the matching alias is accepted');
    const conflict = runSaver(h, capture('2026-01-04T00:00:00Z', {identity: obs(b, ID_A)}), ['--account', 'someone-else']); assert.equal(conflict.status, 1); assert.match(conflict.err, /conflicts with the bound account/);
    scanTree(h.root);
  }
  { // mismatch / ambiguity never overwrite a verified cache and a manual alias cannot override them
    const h = home(), b = bound(h);
    runSaver(h, capture('2026-01-01T00:00:00Z', {identity: obs(b, ID_A)}), []);
    const main = fs.readFileSync(path.join(h.dest, 'wishlist.json'));
    for (const [name, identity] of [['mismatch', obs(b, ID_B)], ['ambiguous', obs(b, ID_A, {consistent: false, sessionFingerprint: null})]]) {
      const r = runSaver(h, capture('2026-01-05T00:00:00Z', {identity}), []);
      assert.equal(r.json.action, 'separate', name); assert.match(r.json.reason, new RegExp(name)); assert.deepEqual(fs.readFileSync(path.join(h.dest, 'wishlist.json')), main, `${name} leaves the verified cache untouched`);
      const manual = runSaver(h, capture('2026-01-06T00:00:00Z', {identity}), ['--account', 'my-steam', '--access-scope', 'signed-in']); assert.equal(manual.status, 1, `${name}: a manual alias cannot override`);
      const sep = Object.values(fs.readdirSync(h.dest)).find(n => n.includes('.partial.') && n.includes('20260105')); assert.ok(sep, `${name} kept a separate snapshot`);
      const e = JSON.parse(fs.readFileSync(path.join(h.dest, sep), 'utf8')); assert.ok(!('account' in e), `${name}: the separate capture claims no account`); assert.equal(e.diagnostics.attestations.identity.result, name);
      fs.unlinkSync(path.join(h.dest, sep));
    }
    scanTree(h.root);
  }
  { // signed out, no observation, wrong salt, failed observation: unobserved; only the user's own confirmation helps and it is never a match
    for (const [name, identity] of [['signed out', b => obs(b, ID_A, {loggedIn: false, sessionFingerprint: null})], ['no observation', () => undefined], ['wrong salt', b => obs(b, ID_A, {saltCheck: '00000000'})],
      ['page failed', () => ({version: 1, sources: [], loggedIn: null, consistent: false, saltCheck: null, sessionFingerprint: null, pathFingerprint: null, error: 'observation-failed'})]]) {
      const h2 = home(), b2 = bound(h2), id2 = identity(b2);
      const none = runSaver(h2, capture('2026-01-01T00:00:00Z', {identity: id2}), []);
      assert.equal(none.json.action, 'separate', `${name}: unconfirmed → separate`); assert.match(none.json.reason, /not observed|not confirmed/);
      assert.ok(!fs.existsSync(path.join(h2.dest, 'wishlist.json')));
      const manual = runSaver(h2, capture('2026-01-02T00:00:00Z', {identity: id2}), ['--account', b2.alias, '--access-scope', 'signed-in']);
      assert.equal(manual.json.action, 'create', `${name}: manual confirmation of the bound alias is the honest fallback`);
      const e = stored(h2); assert.deepEqual(e.diagnostics.attestations.identity, {by: 'user', result: 'unobserved', basis: 'manual-confirmation', ownership: 'unverified'});
      assert.notEqual(e.diagnostics.attestations.identity.result, 'match');
      const other = runSaver(h2, capture('2026-01-03T00:00:00Z', {identity: id2}), ['--account', 'different-alias', '--access-scope', 'signed-in']);
      assert.equal(other.json.action, 'separate'); assert.match(other.json.reason, /differs from the bound account/);
    }
  }
  { // another person's public page (URL names another account, no owner controls) and a contradiction (owner controls but URL names another account)
    const h = home(), b = bound(h), otherPath = fingerprintSync(b.salt, ID_B);
    const pub = runSaver(h, capture('2026-01-01T00:00:00Z', {identity: obs(b, ID_A, {pathFingerprint: otherPath}), handles: false}), []);
    assert.equal(pub.json.action, 'separate'); assert.match(pub.json.reason, /ownership is not verified/);
    assert.equal(runSaver(h, capture('2026-01-01T00:00:00Z', {identity: obs(b, ID_A, {pathFingerprint: otherPath}), handles: false}), ['--account', 'my-steam']).status, 1, 'a manual alias cannot establish ownership');
    const contra = runSaver(h, capture('2026-01-02T00:00:00Z', {identity: obs(b, ID_A, {pathFingerprint: otherPath}), handles: true}), []);
    assert.equal(contra.json.action, 'separate'); assert.match(contra.json.reason, /ambiguous/);
    const noOwner = runSaver(h, capture('2026-01-03T00:00:00Z', {identity: obs(b, ID_A), handles: false}), []);
    assert.equal(noOwner.json.action, 'separate'); assert.match(noOwner.json.reason, /ownership is not verified/);
    const sameUrl = runSaver(h, capture('2026-01-04T00:00:00Z', {identity: obs(b, ID_A, {pathFingerprint: fingerprintSync(b.salt, ID_A)})}), []); assert.equal(sameUrl.json.action, 'create');
  }
  { // an invalid embedded observation is rejected, never trusted
    const h = home(), b = bound(h);
    for (const bad of [{...obs(b, ID_A), salt: b.salt}, {...obs(b, ID_A), steamid: ID_A}, {...obs(b, ID_A), sessionFingerprint: 'zz'}, {...obs(b, ID_A), version: 2}, 'text']) {
      const r = runSaver(h, capture('2026-01-01T00:00:00Z', {identity: bad}), []); assert.equal(r.status, 1); assert.match(r.err, /diagnostics\.identity|Rejected/);
    }
    assert.deepEqual(files(h), []);
  }

  // ---- C. consent, binding changes, legacy files
  { // the binding is not cache consent
    const h = home({settings: {version: 1, persistence: {profileAndFeedback: true, steamCache: false}}}); const probe = probeFor(ID_A);
    planBinding(h.file, {op: 'bind', probe, alias: 'my-steam', apply: true});
    const r = runSaver(h, capture('2026-01-01T00:00:00Z', {identity: obs(probe, ID_A)}), []); assert.equal(r.status, 1); assert.match(r.err, /steamCache false/); assert.deepEqual(files(h), []);
  }
  { // rebind: old-account caches are never merged or promoted; selection by the new alias rejects them
    const h = home(), b = bound(h);
    runSaver(h, capture('2026-01-01T00:00:00Z', {identity: obs(b, ID_A)}), []);
    const oldMain = fs.readFileSync(path.join(h.dest, 'wishlist.json'));
    const probeB = probeFor(ID_B); planBinding(h.file, {op: 'change', probe: probeB, alias: 'second-account', apply: true});
    const r = runSaver(h, capture('2026-01-09T00:00:00Z', {identity: obs(probeB, ID_B)}), []);
    assert.equal(r.json.action, 'separate'); assert.match(r.json.reason, /account identity differs/); assert.deepEqual(fs.readFileSync(path.join(h.dest, 'wishlist.json')), oldMain);
    const sel = selectSnapshots([stored(h)], {source: 'wishlist', account: 'second-account', accessScope: 'signed-in'});
    assert.equal(sel.selected, null); assert.ok(sel.rejected.some(x => x.reasons.includes('different account')) || sel.supporting.some(x => x.reasons.includes('account identity differs or is unknown')));
  }
  { // legacy file without an account is never attributed to the bound account
    const h = home(), b = bound(h);
    const legacy = {...capture('2025-12-01T00:00:00Z'), method: 'browser-dom-claude-code', accessScope: 'signed-in'};
    fs.writeFileSync(path.join(h.dest, 'wishlist.json'), JSON.stringify(legacy, null, 2) + '\n');
    const before = fs.readFileSync(path.join(h.dest, 'wishlist.json'));
    const r = runSaver(h, capture('2026-01-01T00:00:00Z', {identity: obs(b, ID_A)}), []); assert.equal(r.json.action, 'separate'); assert.deepEqual(fs.readFileSync(path.join(h.dest, 'wishlist.json')), before);
  }
  { // a binding that changes or is revoked between the decision and the commit stops the save
    const h = home(), b = bound(h), binding0 = readSettingsFile(h.file).settings.steamAccount;
    runSaver(h, capture('2025-12-01T00:00:00Z', {identity: obs(b, ID_A)}), []); // an existing verified file, so the newer capture is a refresh that reaches the commit window
    const env = {...capture('2026-01-01T00:00:00Z'), account: 'my-steam', accessScope: 'signed-in', diagnostics: {...capture('2026-01-01T00:00:00Z').diagnostics, attestations: {by: 'caller', sourceEnvelopeSha256: sha('x'), transfer: {provenance: 'tool-result', level: 'runtime-tool-result', receivedBytes: 1, localSha256Fingerprint: sha('y'), sourceDigest: 'unavailable', pageSummaryChecks: []}, account: 'my-steam', accessScope: 'signed-in', filters: 'none', identity: {by: 'binding', result: 'match', ownership: 'verified', source: 'user-config'}}}};
    const recheck = () => { if (bindingKey(readSettingsFile(h.file).settings.steamAccount) !== bindingKey(binding0)) throw new Error('The account binding changed during the save'); };
    assert.throws(() => save(env, h.dest, {transferVerified: true, recheckConsent: recheck, hooks: {beforeCommit: () => planBinding(h.file, {op: 'revoke', apply: true})}}), /binding changed/);
    assert.equal(stored(h).capturedAt, '2025-12-01T00:00:00Z', 'the existing verified file was not replaced');
  }

  { // a library caller (no CLI) cannot bypass the binding: no verdict, or another alias, is not promoted
    const h = home(), b = bound(h), mk = (account, identity) => { const e = capture('2026-01-01T00:00:00Z'); e.account = account; e.accessScope = 'signed-in'; e.diagnostics = {...e.diagnostics, attestations: {by: 'caller', sourceEnvelopeSha256: sha('x'), transfer: {provenance: 'tool-result', level: 'runtime-tool-result', receivedBytes: 1, localSha256Fingerprint: sha('y'), sourceDigest: 'unavailable', pageSummaryChecks: []}, account, accessScope: 'signed-in', filters: 'none', ...(identity ? {identity} : {})}}; return e; };
    const dry = e => save(e, h.dest, {dryRun: true, transferVerified: true});
    assert.equal(dry(mk(b.alias)).action, 'separate'); assert.match(dry(mk(b.alias)).reason, /identity verdict/);
    assert.equal(dry(mk('other-alias', {by: 'user', basis: 'manual-confirmation', result: 'unobserved', ownership: 'unverified'})).action, 'separate'); assert.match(dry(mk('other-alias')).reason, /not for the bound account/);
    assert.equal(dry(mk(b.alias, {by: 'binding', result: 'match', ownership: 'verified'})).action, 'create');
    assert.equal(dry(mk(b.alias, {by: 'user', basis: 'manual-confirmation', result: 'unobserved', ownership: 'unverified'})).action, 'create');
    assert.equal(dry(mk(b.alias, {by: 'binding', result: 'match', ownership: 'unverified'})).action, 'separate');
    const h0 = home(); assert.equal(save(mk('any-alias'), h0.dest, {dryRun: true, transferVerified: true}).action, 'create', 'unbound: unchanged');
  }

  // ---- policy unit checks (replay-style path evidence, source names)
  {
    const salt = newSalt(), binding = parseSettings({version: 2, persistence: {profileAndFeedback: true, steamCache: true}, steamAccount: {alias: 'a', approvedAt: '2026-01-01T00:00:00Z', fingerprint: {alg: 'sha256-salted-v1', salt, value: fingerprintSync(salt, ID_A)}}}).steamAccount;
    const o = id => ({version: 1, sources: ['userinfo-attr'], loggedIn: true, consistent: true, saltCheck: saltCheckOf(salt), sessionFingerprint: fingerprintSync(salt, id), pathFingerprint: fingerprintSync(salt, ID_A)});
    assert.deepEqual(evaluateIdentity({binding, observation: o(ID_A), ownerEvidence: true}), {source: 'userinfo-attr', result: 'match', ownership: 'verified', note: 'bound account, owner evidence present'});
    assert.equal(evaluateIdentity({binding, observation: o(ID_B), ownerEvidence: true}).result, 'mismatch');
    assert.equal(evaluateIdentity({binding: null, observation: o(ID_A), ownerEvidence: true}).result, 'unbound');
    assert.equal(identityPolicy({binding: null, evaluation: {result: 'unbound'}, accountArg: 'x'}).account, 'x');
    assert.deepEqual(checkObservation(o(ID_A)), []);
  }

  // ---- F. nothing identifying anywhere in the scratch homes
  for (const root of tmpRoots) { const names = fs.readdirSync(path.join(root, 'cache', 'steam'), {recursive: true}); for (const n of names) { const p = path.join(root, 'cache', 'steam', n); if (fs.statSync(p).isFile()) noLeak(fs.readFileSync(p, 'utf8'), p); } }
  console.log('account binding fixture checks passed');
} finally { for (const r of tmpRoots) fs.rmSync(r, {recursive: true, force: true}); }
