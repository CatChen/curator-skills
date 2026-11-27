// Account binding on scratch homes (synthetic IDs and settings only; no production file is read or written).
// FIXTURE tests of the saver, selection and binding operations: identity observations are built by hand in the shape the page scripts emit.
// The real collectors (generated page scripts, hook delivery, saver CLI) are exercised in test_identity_collectors.mjs.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fingerprintSync, newSalt, saltCheckOf, readSettingsFile, bindingKey, parseSettings} from '../../skills/game-curator/scripts/settings.mjs';
import {planBinding, planPersistence} from '../../skills/game-curator/scripts/bind-account.mjs';
import {evaluateIdentity, identityPolicy, checkObservation, knownConflict, generationOf} from '../../skills/game-curator/scripts/identity.mjs';
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
const probeFor = (id, salt = newSalt()) => ({format: 'game-curator-identity-probe', version: 1, sources: ['user-config'], loggedIn: true, consistent: true, problems: [], origin: 'https://store.steampowered.com', saltCheck: saltCheckOf(salt), sessionFingerprint: fingerprintSync(salt, id), pathFingerprint: null, salt});
// Plan, then apply exactly the plan that was shown (as the user's approval would).
function approve(file, args) {
  const plan = planBinding(file, args);
  assert.equal(plan.applied, false);
  return planBinding(file, {...args, apply: true, expect: {settingsSha256: plan.settingsSha256, candidateSha256: plan.candidateSha256}});
}
const bindAs = (h, id = ID_A, alias = 'my-steam', salt) => { const probe = probeFor(id, salt); approve(h.file, {op: 'bind', probe, alias}); return {salt: probe.salt, alias, probe}; };
const settingsOf = h => readSettingsFile(h.file).settings;
const obs = (b, id, o = {}) => ({version: 1, sources: ['user-config'], loggedIn: true, consistent: true, problems: [], saltCheck: saltCheckOf(b.salt), sessionFingerprint: fingerprintSync(b.salt, id), pathFingerprint: null, owner: true, continuity: {checks: 2, stable: true, broke: false, covered: true}, ...o});
const capture = (at, {identity, handles = true, rows = records} = {}) => ({format: 'game-curator-steam-export', version: 1, source: 'wishlist', capturedAt: at, method: 'browser-dom-claude-code', coverage: 'partial', warnings: [],
  diagnostics: {expectedCount: rows.length, uniqueCount: rows.length, ranksObserved: rows.length, placeholderNameRows: 0, complete: true, stopReason: 'complete', reorderHandles: handles, view: {sort: 'Your Rank', search: 'empty', filters: 'unknown'}, recordsSha256: sha(JSON.stringify(rows)), ...(identity ? {identity} : {})},
  accessScope: 'unknown', records: rows});
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
  // ---- unbound: the manual flow is unchanged and records no identity attestation
  {
    const h = home();
    const r = runSaver(h, capture('2026-01-01T00:00:00Z'), ['--account', 'my-steam', '--access-scope', 'signed-in']);
    assert.equal(r.json.action, 'create');
    const e = stored(h); assert.equal(e.account, 'my-steam'); assert.ok(!('identity' in e.diagnostics.attestations)); assert.equal(e.diagnostics.attestations.account, 'my-steam');
    assert.equal(runSaver(h, capture('2026-01-02T00:00:00Z'), []).json.action, 'separate');
  }

  // ---- bind / change / revoke: plan first, apply only the approved plan; persistence preserved; nothing automatic
  {
    for (const persistence of [{profileAndFeedback: true, steamCache: false}, {profileAndFeedback: false, steamCache: true}]) {
      const h = home({settings: {version: 1, persistence}}); const before = fs.readFileSync(h.file, 'utf8');
      const probe = probeFor(ID_A);
      const plan = planBinding(h.file, {op: 'bind', probe, alias: 'my-steam'});
      assert.equal(plan.applied, false); assert.equal(fs.readFileSync(h.file, 'utf8'), before, 'a plan writes nothing');
      assert.match(plan.settingsSha256, /^[0-9a-f]{64}$/); assert.match(plan.candidateSha256, /^[0-9a-f]{64}$/);
      for (const expect of [undefined, {}, {settingsSha256: plan.settingsSha256}, {settingsSha256: sha('x'), candidateSha256: plan.candidateSha256}, {settingsSha256: plan.settingsSha256, candidateSha256: sha('y')}]) {
        assert.throws(() => planBinding(h.file, {op: 'bind', probe, alias: 'my-steam', apply: true, expect}), /refused/); assert.equal(fs.readFileSync(h.file, 'utf8'), before);
      }
      assert.throws(() => planBinding(h.file, {op: 'bind', probe: probeFor(ID_B), alias: 'my-steam', apply: true, expect: {settingsSha256: plan.settingsSha256, candidateSha256: plan.candidateSha256}}), /refused/, 'a different candidate than the one approved');
      const done = approve(h.file, {op: 'bind', probe, alias: 'my-steam'});
      assert.equal(done.applied, true); const back = settingsOf(h);
      assert.equal(back.version, 2); assert.deepEqual(back.persistence, persistence, 'persistence choices preserved exactly'); assert.equal(back.steamAccount.alias, 'my-steam'); assert.equal(back.steamAccount.fingerprint.value, probe.sessionFingerprint);
      assert.match(back.steamAccount.generation, /^[A-Za-z0-9_-]{22}$/);
      assert.ok(!fs.readFileSync(h.file, 'utf8').includes(ID_A), 'no raw identifier in settings');
      assert.deepEqual(fs.readdirSync(h.root).filter(n => n.startsWith('.settings')), [], 'no temp file left behind');
      assert.throws(() => planBinding(h.file, {op: 'bind', probe: probeFor(ID_B), alias: 'other'}), /already bound/);
      assert.throws(() => planBinding(h.file, {op: 'change', probe, alias: 'my-steam'}), /identical/);
    }
    const h = home(); const b = bindAs(h), gen1 = settingsOf(h).steamAccount.generation;
    const probeB = probeFor(ID_B), changed = approve(h.file, {op: 'change', probe: probeB, alias: 'second-account'});
    assert.match(changed.followUp, /ask the user explicitly/i); assert.equal(settingsOf(h).steamAccount.alias, 'second-account'); assert.notEqual(settingsOf(h).steamAccount.generation, gen1);
    const revoked = approve(h.file, {op: 'revoke'});
    assert.equal(settingsOf(h).steamAccount, null); assert.equal(revoked.alias, null); assert.equal(settingsOf(h).version, 2);
    assert.throws(() => planBinding(h.file, {op: 'revoke'}), /no account is bound/);
    assert.throws(() => planBinding(h.file, {op: 'change', probe: probeB, alias: 'x'}), /use bind/);
    // the same alias bound again (or the same account after a revoke) is a NEW binding
    approve(h.file, {op: 'bind', probe: probeFor(ID_A, b.salt), alias: 'my-steam'}); const gen2 = settingsOf(h).steamAccount.generation;
    approve(h.file, {op: 'change', probe: probeFor(ID_A, b.salt), alias: 'my-steam-2'}); approve(h.file, {op: 'change', probe: probeFor(ID_A, b.salt), alias: 'my-steam'});
    assert.notEqual(settingsOf(h).steamAccount.generation, gen2); assert.notEqual(gen1, gen2);
  }
  {
    const h = home(), good = probeFor(ID_A), before = fs.readFileSync(h.file, 'utf8');
    for (const [name, probe, alias] of [
      ['signed out', {...good, loggedIn: false}, 'a'], ['not signed in (null)', {...good, loggedIn: null}, 'a'], ['inconsistent', {...good, consistent: false}, 'a'], ['has problems', {...good, problems: ['id-conflict']}, 'a'], ['no problems list', {...good, problems: undefined}, 'a'], ['no fingerprint', {...good, sessionFingerprint: null}, 'a'],
      ['fingerprint is an array', {...good, sessionFingerprint: [good.sessionFingerprint]}, 'a'], ['no salt (a verify probe, not candidate)', {...good, salt: undefined}, 'a'], ['salt check mismatch', {...good, saltCheck: '00000000'}, 'a'],
      ['short salt', {...good, salt: 'AQID', saltCheck: saltCheckOf('AQID')}, 'a'], ['unsupported origin', {...good, origin: 'https://evil.example'}, 'a'],
      ['bad alias', good, '../x'], ['alias is an array', good, ['a']], ['no alias', good, undefined], ['not an object', null, 'a'],
    ]) assert.throws(() => planBinding(h.file, {op: 'bind', probe, alias}), /./, name);
    assert.equal(fs.readFileSync(h.file, 'utf8'), before, 'refused operations change nothing');
    const none = path.join(h.root, 'absent.json'); assert.throws(() => planBinding(none, {op: 'bind', probe: good, alias: 'a'}), /settings not usable/); assert.ok(!fs.existsSync(none));
    for (const bad of ['{', '{"version":3,"persistence":{"profileAndFeedback":true,"steamCache":true}}', '{"version":1,"persistence":{"profileAndFeedback":true}}']) { fs.writeFileSync(h.file, bad); assert.throws(() => planBinding(h.file, {op: 'bind', probe: good, alias: 'a'}), /settings not usable/); assert.equal(fs.readFileSync(h.file, 'utf8'), bad); }
  }
  { // an edit between the approved plan and the apply, or a concurrent edit during it: nothing overwritten
    const h = home(), probe = probeFor(ID_A), plan = planBinding(h.file, {op: 'bind', probe, alias: 'a'});
    const edited = JSON.stringify({version: 1, persistence: {profileAndFeedback: false, steamCache: false}});
    fs.writeFileSync(h.file, edited);
    assert.throws(() => planBinding(h.file, {op: 'bind', probe, alias: 'a', apply: true, expect: {settingsSha256: plan.settingsSha256, candidateSha256: plan.candidateSha256}}), /refused/);
    assert.equal(fs.readFileSync(h.file, 'utf8'), edited);
    const plan2 = planBinding(h.file, {op: 'bind', probe, alias: 'a'}), edited2 = JSON.stringify({version: 1, persistence: {profileAndFeedback: true, steamCache: false}});
    assert.throws(() => planBinding(h.file, {op: 'bind', probe, alias: 'a', apply: true, expect: {settingsSha256: plan2.settingsSha256, candidateSha256: plan2.candidateSha256}, hooks: {beforeCommit: () => fs.writeFileSync(h.file, edited2)}}), /changed while/);
    assert.equal(fs.readFileSync(h.file, 'utf8'), edited2); assert.deepEqual(fs.readdirSync(h.root).filter(n => n.startsWith('.settings')), []);
  }
  { // ordinary persistence edits preserve the binding, its generation and the v2 schema (and v1 stays v1)
    const h = home(); bindAs(h); const before = settingsOf(h).steamAccount;
    const plan = planPersistence(h.file, {steamCache: false}); assert.equal(plan.applied, false); assert.equal(plan.bindingPreserved, true);
    const done = planPersistence(h.file, {steamCache: false}, {apply: true, expect: {settingsSha256: plan.settingsSha256, candidateSha256: plan.candidateSha256}});
    assert.equal(done.applied, true); const after = settingsOf(h);
    assert.equal(after.version, 2); assert.equal(after.persistence.steamCache, false); assert.equal(after.persistence.profileAndFeedback, true); assert.equal(bindingKey(after.steamAccount), bindingKey(before));
    const p2 = planPersistence(h.file, {profileAndFeedback: false, steamCache: true}); planPersistence(h.file, {profileAndFeedback: false, steamCache: true}, {apply: true, expect: {settingsSha256: p2.settingsSha256, candidateSha256: p2.candidateSha256}});
    assert.equal(bindingKey(settingsOf(h).steamAccount), bindingKey(before));
    assert.throws(() => planPersistence(h.file, {}), /give profileAndFeedback/); assert.throws(() => planPersistence(h.file, {steamCache: 'yes'}), /give profileAndFeedback/); assert.throws(() => planPersistence(h.file, {extra: true}), /give profileAndFeedback/);
    assert.throws(() => planPersistence(h.file, {steamCache: true}, {apply: true}), /refused/);
    const h1 = home(), p1 = planPersistence(h1.file, {steamCache: false}); planPersistence(h1.file, {steamCache: false}, {apply: true, expect: {settingsSha256: p1.settingsSha256, candidateSha256: p1.candidateSha256}});
    assert.equal(JSON.parse(fs.readFileSync(h1.file, 'utf8')).version, 1, 'a version 1 file stays version 1');
  }
  { // CLI: plan, then apply with the digests; status never prints the fingerprint
    const h = home(), probeFile = path.join(h.root, 'probe.json'); fs.writeFileSync(probeFile, JSON.stringify(probeFor(ID_A)));
    const cli = (...a) => spawnSync(process.execPath, [binder, ...a], {encoding: 'utf8'});
    const plan = cli('bind', '--settings', h.file, '--probe', probeFile, '--alias', 'my-steam'); assert.equal(plan.status, 0, plan.stderr);
    const p = JSON.parse(plan.stdout); assert.equal(p.applied, false); assert.equal(readSettingsFile(h.file).settings.version, 1);
    assert.equal(cli('bind', '--settings', h.file, '--probe', probeFile, '--alias', 'my-steam', '--apply').status, 1, '--apply needs the digests');
    const apply = cli('bind', '--settings', h.file, '--probe', probeFile, '--alias', 'my-steam', '--apply', '--expect-settings', p.settingsSha256, '--expect-candidate', p.candidateSha256); assert.equal(apply.status, 0, apply.stderr);
    const status = cli('status', '--settings', h.file); const st = JSON.parse(status.stdout);
    assert.deepEqual(Object.keys(st), ['version', 'persistence', 'bound', 'alias', 'approvedAt', 'salt']); assert.equal(st.bound, true); assert.ok(!status.stdout.includes(settingsOf(h).steamAccount.fingerprint.value));
    const pp = JSON.parse(cli('persistence', '--settings', h.file, '--steam-cache', 'false').stdout);
    assert.equal(cli('persistence', '--settings', h.file, '--steam-cache', 'false', '--apply', '--expect-settings', pp.settingsSha256, '--expect-candidate', pp.candidateSha256).status, 0);
    assert.equal(settingsOf(h).steamAccount.alias, 'my-steam'); assert.equal(settingsOf(h).persistence.steamCache, false);
    assert.equal(cli('frobnicate', '--settings', h.file).status, 2); assert.equal(cli('persistence', '--settings', h.file, '--steam-cache', 'maybe').status, 1);
  }

  // ---- bound identity at capture time (the saver derives the verdict itself from the observation and the actual binding)
  { // match + owner evidence + continuity: no manual alias, scope observed; the observation is consumed and only the verdict (with the generation) stored
    const h = home(), b = bindAs(h), gen = settingsOf(h).steamAccount.generation;
    const r = runSaver(h, capture('2026-01-01T00:00:00Z', {identity: obs(b, ID_A)}), []);
    assert.equal(r.status, 0, r.err); assert.equal(r.json.action, 'create'); assert.equal(r.json.identity.result, 'match');
    const e = stored(h); assert.equal(e.account, 'my-steam'); assert.equal(e.accessScope, 'signed-in');
    assert.deepEqual(e.diagnostics.attestations.identity, {by: 'binding', result: 'match', ownership: 'verified', source: 'user-config', generation: gen});
    assert.ok(!('identity' in e.diagnostics), 'the raw observation is not stored'); assert.equal(e.diagnostics.attestations.account, 'my-steam');
    assert.ok(!JSON.stringify(e).includes(b.salt) && !JSON.stringify(e).includes(settingsOf(h).steamAccount.fingerprint.value));
    assert.equal(runSaver(h, capture('2026-01-02T00:00:00Z', {identity: obs(b, ID_A)}), []).json.action, 'refresh');
    assert.equal(runSaver(h, capture('2026-01-03T00:00:00Z', {identity: obs(b, ID_A)}), ['--account', 'my-steam']).json.action, 'refresh', 'the matching alias is accepted');
    const conflict = runSaver(h, capture('2026-01-04T00:00:00Z', {identity: obs(b, ID_A)}), ['--account', 'someone-else']); assert.equal(conflict.status, 1); assert.match(conflict.err, /conflicts with the bound account/);
    scanTree(h.root);
  }
  { // mismatch / ambiguity / signed-out never overwrite a verified cache and a manual alias cannot override a KNOWN observation
    const h = home(), b = bindAs(h);
    runSaver(h, capture('2026-01-01T00:00:00Z', {identity: obs(b, ID_A)}), []);
    const main = fs.readFileSync(path.join(h.dest, 'wishlist.json'));
    for (const [name, rx, identity] of [['mismatch', /mismatch/, obs(b, ID_B)], ['ambiguous (conflict)', /ambiguous/, obs(b, ID_A, {consistent: false, problems: ['id-conflict'], sessionFingerprint: null})],
      ['signed out', /signed-out/, obs(b, ID_A, {loggedIn: false, sessionFingerprint: null})], ['login-state conflict', /ambiguous/, obs(b, ID_A, {consistent: false, problems: ['login-state-conflict'], sessionFingerprint: null})],
      ['continuity broke', /ambiguous/, obs(b, ID_A, {continuity: {checks: 3, stable: false, broke: true, covered: true}})]]) {
      const r = runSaver(h, capture('2026-01-05T00:00:00Z', {identity}), []);
      assert.equal(r.json.action, 'separate', name); assert.match(r.json.reason, rx); assert.deepEqual(fs.readFileSync(path.join(h.dest, 'wishlist.json')), main, `${name} leaves the verified cache untouched`);
      const manual = runSaver(h, capture('2026-01-06T00:00:00Z', {identity}), ['--account', 'my-steam', '--access-scope', 'signed-in']); assert.equal(manual.status, 1, `${name}: a manual alias cannot override`); assert.match(manual.err, /cannot override a known observation/);
      const sep = fs.readdirSync(h.dest).find(n => n.includes('.partial.') && n.includes('20260105')); assert.ok(sep, `${name} kept a separate snapshot`);
      const e = JSON.parse(fs.readFileSync(path.join(h.dest, sep), 'utf8')); assert.ok(!('account' in e), `${name}: the separate capture claims no account`); assert.ok(knownConflict(e), `${name}: the saved attestation records the conflict`);
      fs.unlinkSync(path.join(h.dest, sep));
    }
    scanTree(h.root);
  }
  { // extraction UNAVAILABLE is the only case manual confirmation can stand in for; it is never recorded as a match
    for (const [name, identity] of [['no observation', () => undefined], ['wrong salt', b => obs(b, ID_A, {saltCheck: '00000000'})],
      ['page failed', () => ({version: 1, sources: [], loggedIn: null, consistent: false, problems: [], saltCheck: null, sessionFingerprint: null, pathFingerprint: null, error: 'observation-failed'})],
      ['unsupported origin', () => ({version: 1, sources: [], loggedIn: null, consistent: false, problems: ['unsupported-origin'], saltCheck: 'abcdef01', sessionFingerprint: null, pathFingerprint: null})],
      ['no markers', b => obs(b, ID_A, {loggedIn: null, sessionFingerprint: null})], ['continuity not established', b => obs(b, ID_A, {continuity: {checks: 1, stable: true, broke: false, covered: true}})], ['no continuity record', b => { const o = obs(b, ID_A); delete o.continuity; return o; }]]) {
      const h2 = home(), b2 = bindAs(h2), gen = settingsOf(h2).steamAccount.generation, id2 = identity(b2);
      const none = runSaver(h2, capture('2026-01-01T00:00:00Z', {identity: id2}), []);
      assert.equal(none.json.action, 'separate', `${name}: unconfirmed → separate`); assert.match(none.json.reason, /not observed|not confirmed/);
      assert.ok(!fs.existsSync(path.join(h2.dest, 'wishlist.json')));
      const manual = runSaver(h2, capture('2026-01-02T00:00:00Z', {identity: id2}), ['--account', b2.alias, '--access-scope', 'signed-in']);
      assert.equal(manual.json.action, 'create', `${name}: manual confirmation of the bound alias is the honest fallback`);
      const e = stored(h2); assert.deepEqual(e.diagnostics.attestations.identity, {by: 'user', result: 'unobserved', basis: 'manual-confirmation', ownership: 'unverified', generation: gen});
      const other = runSaver(h2, capture('2026-01-03T00:00:00Z', {identity: id2}), ['--account', 'different-alias', '--access-scope', 'signed-in']);
      assert.equal(other.json.action, 'separate'); assert.match(other.json.reason, /differs from the bound account/);
    }
  }
  { // another person's public page, a contradiction, and owner evidence that is missing at the observed page
    const h = home(), b = bindAs(h), otherPath = fingerprintSync(b.salt, ID_B);
    const pub = runSaver(h, capture('2026-01-01T00:00:00Z', {identity: obs(b, ID_A, {pathFingerprint: otherPath, owner: false}), handles: false}), []);
    assert.equal(pub.json.action, 'separate'); assert.match(pub.json.reason, /ownership is not verified/);
    assert.equal(runSaver(h, capture('2026-01-01T00:00:00Z', {identity: obs(b, ID_A, {pathFingerprint: otherPath, owner: false}), handles: false}), ['--account', 'my-steam']).status, 1, 'a manual alias cannot establish ownership');
    const contra = runSaver(h, capture('2026-01-02T00:00:00Z', {identity: obs(b, ID_A, {pathFingerprint: otherPath}), handles: true}), []);
    assert.equal(contra.json.action, 'separate'); assert.match(contra.json.reason, /ambiguous/);
    assert.match(runSaver(h, capture('2026-01-03T00:00:00Z', {identity: obs(b, ID_A, {owner: false}), handles: true}), []).json.reason, /ownership is not verified/, 'owner evidence at the observed page itself is required');
    assert.match(runSaver(h, capture('2026-01-03T01:00:00Z', {identity: obs(b, ID_A), handles: false}), []).json.reason, /ownership is not verified/);
    assert.equal(runSaver(h, capture('2026-01-04T00:00:00Z', {identity: obs(b, ID_A, {pathFingerprint: fingerprintSync(b.salt, ID_A)})}), []).json.action, 'create');
  }
  { // an invalid embedded observation is rejected, never trusted (every fingerprint must be an actual string, no stray fields)
    const h = home(), b = bindAs(h);
    for (const bad of [{...obs(b, ID_A), salt: b.salt}, {...obs(b, ID_A), steamid: ID_A}, {...obs(b, ID_A), sessionFingerprint: 'zz'}, {...obs(b, ID_A), sessionFingerprint: [obs(b, ID_A).sessionFingerprint]}, {...obs(b, ID_A), pathFingerprint: [obs(b, ID_A).sessionFingerprint]},
      {...obs(b, ID_A), saltCheck: [saltCheckOf(b.salt)]}, {...obs(b, ID_A), version: 2}, {...obs(b, ID_A), problems: ['made-up']}, {...obs(b, ID_A), problems: 'none'}, {...obs(b, ID_A), continuity: {checks: 0, stable: true, broke: false, covered: true}}, {...obs(b, ID_A), continuity: {checks: 2, stable: 'yes', broke: false, covered: true}}, {...obs(b, ID_A), owner: 'yes'}, 'text']) {
      const r = runSaver(h, capture('2026-01-01T00:00:00Z', {identity: bad}), []); assert.equal(r.status, 1); assert.match(r.err, /diagnostics\.identity|Rejected/);
    }
    assert.deepEqual(files(h), []);
    assert.ok(checkObservation(obs(b, ID_A)).length === 0 && checkObservation({...obs(b, ID_A), sessionFingerprint: [obs(b, ID_A).sessionFingerprint]}).length > 0);
  }

  // ---- shared boundary: save() derives the verdict itself and cannot be bypassed by a caller-supplied attestation
  {
    const h = home(), b = bindAs(h);
    const mk = (identity, extra = {}) => { const e = capture('2026-01-01T00:00:00Z', {identity}); e.diagnostics.attestations = {by: 'caller', sourceEnvelopeSha256: sha('x'), transfer: {provenance: 'tool-result', level: 'runtime-tool-result', receivedBytes: 1, localSha256Fingerprint: sha('y'), sourceDigest: 'unavailable', pageSummaryChecks: []}, filters: 'none', ...extra}; return e; };
    const dry = (e, o = {}) => save(e, h.dest, {dryRun: true, transferVerified: true, ...o});
    // a forged "verified" attestation and an alias on the envelope are worth nothing: no observation, no match
    const forged = mk(undefined, {identity: {by: 'binding', result: 'match', ownership: 'verified', generation: settingsOf(h).steamAccount.generation}}); forged.account = 'my-steam'; forged.accessScope = 'signed-in';
    assert.equal(dry(forged).action, 'separate'); assert.match(dry(forged).reason, /not observed/);
    assert.equal(dry(mk(obs(b, ID_B))).action, 'separate');
    assert.equal(dry(mk(obs(b, ID_A))).action, 'create'); assert.equal(dry(mk(obs(b, ID_A))).identity.result, 'match');
    const signedIn = () => Object.assign(mk(undefined), {accessScope: 'signed-in'});
    assert.equal(dry(signedIn(), {manualAccount: b.alias}).action, 'create'); assert.equal(dry(signedIn(), {manualAccount: b.alias}).identity.basis, 'manual-confirmation');
    assert.equal(dry(signedIn(), {manualAccount: 'other'}).action, 'separate');
    assert.throws(() => dry(mk(obs(b, ID_B)), {manualAccount: b.alias}), /cannot override a known observation/);
    const h0 = home(); assert.equal(save(Object.assign(mk(undefined), {account: 'any-alias', accessScope: 'signed-in'}), h0.dest, {dryRun: true, transferVerified: true}).action, 'create', 'unbound: unchanged');
    // the binding recheck is intrinsic: a change or revocation in the decision-to-commit window stops a direct save() with no callback supplied
    runSaver(h, capture('2025-12-01T00:00:00Z', {identity: obs(b, ID_A)}), []);
    assert.throws(() => save(mk(obs(b, ID_A)), h.dest, {transferVerified: true, hooks: {beforeCommit: () => approve(h.file, {op: 'revoke'})}}), /binding changed/);
    assert.equal(stored(h).capturedAt, '2025-12-01T00:00:00Z', 'the existing verified file was not replaced');
    assert.equal(settingsOf(h).steamAccount, null);
  }

  // ---- an alias is a label, not an identity: a re-bound alias never inherits earlier evidence
  {
    const h = home(), b1 = bindAs(h), gen1 = settingsOf(h).steamAccount.generation;
    assert.equal(runSaver(h, capture('2026-01-01T00:00:00Z', {identity: obs(b1, ID_A)}), []).json.action, 'create');
    const g1Main = fs.readFileSync(path.join(h.dest, 'wishlist.json'));
    approve(h.file, {op: 'revoke'});
    const manualWhileUnbound = runSaver(h, capture('2026-01-02T00:00:00Z'), ['--account', 'my-steam', '--access-scope', 'signed-in']);
    assert.equal(manualWhileUnbound.json.action, 'separate', 'a manual alias while unbound does not replace evidence recorded under a binding');
    const b2 = bindAs(h, ID_B, 'my-steam'), gen2 = settingsOf(h).steamAccount.generation; assert.notEqual(gen1, gen2);
    const r = runSaver(h, capture('2026-01-03T00:00:00Z', {identity: obs(b2, ID_B)}), []);
    assert.equal(r.json.action, 'separate'); assert.match(r.json.reason, /different \(or no\) account binding/); assert.deepEqual(fs.readFileSync(path.join(h.dest, 'wishlist.json')), g1Main, 'old evidence untouched');
    // selection by the new binding: the same-alias capture of the old generation is never eligible
    const read = () => fs.readdirSync(h.dest).filter(n => n.endsWith('.json')).map(n => JSON.parse(fs.readFileSync(path.join(h.dest, n), 'utf8')));
    const binding2 = settingsOf(h).steamAccount;
    const sel = selectSnapshots(read(), {source: 'wishlist', accessScope: 'signed-in', binding: binding2});
    assert.ok(!sel.selected || generationOf(sel.selected) === gen2, 'nothing of the old generation is selected');
    assert.ok(sel.rejected.some(x => generationOf(x.capture) === gen1 && /prior account binding/.test(x.reasons[0])), 'prior-generation evidence is rejected, not supporting');
    assert.ok(!sel.supporting.some(x => generationOf(x.capture) === gen1));
    { // genuinely unattributed (legacy or manual) captures stay separately caveated; with no binding supplied, mixed generations are never one verified account
      const legacy = JSON.parse(JSON.stringify(read().find(c => generationOf(c) === gen1))); delete legacy.diagnostics.attestations.identity; legacy.capturedAt = '2025-11-01T00:00:00Z';
      const sel3 = selectSnapshots([legacy], {source: 'wishlist', accessScope: 'signed-in', binding: binding2});
      assert.equal(sel3.selected, null); assert.ok(sel3.supporting.some(x => /outside any account binding/.test(x.reasons.join())), 'legacy: caveated supporting evidence');
      const g1cap = read().find(c => generationOf(c) === gen1), g2cap = JSON.parse(JSON.stringify(g1cap)); g2cap.diagnostics.attestations.identity.generation = gen2; g2cap.capturedAt = '2026-02-01T00:00:00Z';
      const mixed = selectSnapshots([g1cap, g2cap], {source: 'wishlist', account: 'my-steam', accessScope: 'signed-in'});
      assert.equal(mixed.selected, null, 'no binding supplied: neither generation is silently current'); assert.equal(mixed.supporting.length, 2); assert.ok(mixed.supporting.every(x => /not supplied/.test(x.reasons.join())));
    }
    assert.throws(() => selectSnapshots(read(), {source: 'wishlist', account: 'other', accessScope: 'signed-in', binding: binding2}), /differs from the bound account/);
    // once a capture is verified under the new generation it is selectable, and the old one is not
    fs.unlinkSync(path.join(h.dest, 'wishlist.json'));
    assert.equal(runSaver(h, capture('2026-01-04T00:00:00Z', {identity: obs(b2, ID_B)}), []).json.action, 'create');
    const sel2 = selectSnapshots(read(), {source: 'wishlist', accessScope: 'signed-in', binding: binding2});
    assert.equal(generationOf(sel2.selected), gen2);
    // rotation: the old generation's managed backups are never counted or deleted by the new generation's replacements
    for (let i = 5; i <= 6; i++) runSaver(h, capture(`2026-01-0${i}T00:00:00Z`, {identity: obs(b2, ID_B), rows: [{...records[0], pageText: `Synthetic game\nRELEASE DATE:\n20${i}`}]}), []);
    const old = fs.readdirSync(h.dest).filter(n => n.includes('.managed-v1.superseded.') && generationOf(JSON.parse(fs.readFileSync(path.join(h.dest, n), 'utf8'))) === gen2);
    assert.ok(old.length >= 1, 'the new generation has its own backups');
    // seed old-generation backups (valid managed names), then rotate the new generation past its limit
    const g1Doc = JSON.parse(g1Main.toString()); const seeded = [];
    for (const d of ['20251201', '20251202', '20251203']) { const c = {...g1Doc, capturedAt: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00Z`}; const bytes = JSON.stringify(c, null, 2) + '\n'; const name = `wishlist.managed-v1.superseded.${d}T000000Z-${sha(bytes).slice(0, 12)}.json`; fs.writeFileSync(path.join(h.dest, name), bytes, {flag: 'wx', mode: 0o600}); seeded.push(name); }
    for (let i = 7; i <= 9; i++) runSaver(h, capture(`2026-01-0${i}T00:00:00Z`, {identity: obs(b2, ID_B), rows: [{...records[0], pageText: `Synthetic game\nRELEASE DATE:\n20${i}`}]}), []);
    for (const n of seeded) assert.ok(fs.existsSync(path.join(h.dest, n)), `rotation removed the old-generation backup ${n}`);
    const g2Backups = fs.readdirSync(h.dest).filter(n => n.includes('.managed-v1.superseded.') && !seeded.includes(n) && generationOf(JSON.parse(fs.readFileSync(path.join(h.dest, n), 'utf8'))) === gen2);
    assert.equal(g2Backups.length, 2, 'the new generation keeps exactly its own two backups');
  }
  { // selection and known conflicts: a conflicting capture is never supporting evidence, whether or not an alias was saved with it
    const b0 = {salt: newSalt()};
    for (const [identity, rx, handles = true] of [[b => obs(b, ID_B), /mismatch/], [b => obs(b, ID_A, {loggedIn: false, sessionFingerprint: null}), /signed-out/], [b => obs(b, ID_A, {consistent: false, problems: ['id-conflict'], sessionFingerprint: null}), /ambiguous/], [b => obs(b, ID_A, {pathFingerprint: fingerprintSync(b.salt, ID_B), owner: false}), /not shown to belong/, false]]) {
      const hh = home(); bindAs(hh, ID_A, 'my-steam', b0.salt); const bb = {salt: b0.salt};
      runSaver(hh, capture('2026-01-01T00:00:00Z', {identity: identity(bb), handles}), []);
      const sepName = fs.readdirSync(hh.dest).find(n => n.includes('.partial.')); const cap = JSON.parse(fs.readFileSync(path.join(hh.dest, sepName), 'utf8'));
      assert.ok(!('account' in cap)); assert.match(knownConflict(cap) ?? '', rx);
      const withAlias = {...cap, account: 'my-steam', accessScope: 'signed-in'};
      for (const c of [cap, withAlias]) { const sel = selectSnapshots([c], {source: 'wishlist', accessScope: 'signed-in', binding: settingsOf(hh).steamAccount}); assert.equal(sel.selected, null); assert.equal(sel.supporting.length, 0, 'not supporting evidence'); assert.equal(sel.rejected.length, 1); assert.match(sel.rejected[0].reasons[0], rx); }
    }
  }

  { // known observations win over missing continuity; a run that changed identity can never become a manual fallback; late identity is never retroactive
    const h = home(), b = bindAs(h), salt = b.salt, mk = (o = {}) => { const x = obs(b, ID_A, o); return x; };
    const noCont = id => { const o = obs(b, id); delete o.continuity; return o; };
    const binding = settingsOf(h).steamAccount;
    assert.equal(evaluateIdentity({binding, observation: noCont(ID_B), ownerEvidence: true}).result, 'mismatch', 'a mismatch is not hidden by missing continuity');
    const contra = noCont(ID_A); contra.pathFingerprint = fingerprintSync(salt, ID_B);
    assert.deepEqual([evaluateIdentity({binding, observation: contra, ownerEvidence: true}).result, evaluateIdentity({binding, observation: contra, ownerEvidence: true}).ownership], ['ambiguous', 'contradicted']);
    assert.equal(evaluateIdentity({binding, observation: noCont(ID_A), ownerEvidence: true}).result, 'unobserved', 'no continuity and no conflict: still only unobserved');
    const gone = [['final observation failed', mk({continuity: {checks: 3, stable: false, broke: true, covered: true}, error: 'observation-failed', loggedIn: null, sessionFingerprint: null, consistent: false, owner: null})],
      ['final page has no markers', mk({continuity: {checks: 3, stable: false, broke: true, covered: true}, loggedIn: null, sessionFingerprint: null})], ['final page signed out', mk({continuity: {checks: 3, stable: false, broke: true, covered: true}, loggedIn: false, sessionFingerprint: null})]];
    for (const [name, identity] of gone) {
      assert.equal(evaluateIdentity({binding, observation: identity, ownerEvidence: true}).result, 'ambiguous', name);
      const r = runSaver(h, capture('2026-03-01T00:00:00Z', {identity}), []); assert.equal(r.json.action, 'separate', name);
      assert.equal(runSaver(h, capture('2026-03-02T00:00:00Z', {identity}), ['--account', 'my-steam', '--access-scope', 'signed-in']).status, 1, name + ': no manual fallback');
      fs.readdirSync(h.dest).filter(n => n.includes('.partial.')).forEach(n => fs.unlinkSync(path.join(h.dest, n)));
    }
    const stopped = capture('2026-03-03T00:00:00Z'); stopped.diagnostics.stopReason = 'identity-changed'; stopped.diagnostics.complete = false;
    assert.equal(evaluateIdentity({binding, observation: undefined, ownerEvidence: true, identityChanged: true}).result, 'ambiguous');
    assert.equal(runSaver(h, stopped, ['--account', 'my-steam', '--access-scope', 'signed-in']).status, 1, 'stopReason identity-changed without any observation is not a manual fallback');
    const late = mk({continuity: {checks: 3, stable: true, broke: false, covered: false}});
    assert.equal(evaluateIdentity({binding, observation: late, ownerEvidence: true}).result, 'unobserved', 'identity added on a resume call is not attested for earlier batches');
    assert.match(runSaver(h, capture('2026-03-04T00:00:00Z', {identity: late}), []).json.reason, /not observed|not confirmed/);
    // a malformed observation is rejected before it is consumed: never downgraded to unobserved and then confirmed manually
    const bad = {...obs(b, ID_A), sessionFingerprint: [obs(b, ID_A).sessionFingerprint]};
    assert.throws(() => save(Object.assign(capture('2026-03-05T00:00:00Z', {identity: bad}), {accessScope: 'signed-in'}), h.dest, {dryRun: true, transferVerified: true, manualAccount: 'my-steam'}), /Invalid capture/);
    // a probe without an origin is not a binding candidate; a symlinked settings.json is edited through the link
    assert.throws(() => planBinding(h.file, {op: 'change', probe: {...probeFor(ID_B), origin: undefined}, alias: 'x'}), /supported Steam origin/);
    const h2 = home(), real = path.join(h2.root, 'real-settings.json'); fs.renameSync(h2.file, real); fs.symlinkSync(real, h2.file);
    approve(h2.file, {op: 'bind', probe: probeFor(ID_A), alias: 'a'}); assert.ok(fs.lstatSync(h2.file).isSymbolicLink(), 'the link survives'); assert.equal(readSettingsFile(real).settings.steamAccount.alias, 'a');
  }

  // ---- policy unit checks
  {
    const salt = newSalt(), binding = parseSettings({version: 2, persistence: {profileAndFeedback: true, steamCache: true}, steamAccount: {alias: 'a', approvedAt: '2026-01-01T00:00:00Z', generation: newSalt(), fingerprint: {alg: 'sha256-salted-v1', salt, value: fingerprintSync(salt, ID_A)}}}).steamAccount;
    const o = (id, extra = {}) => ({version: 1, sources: ['userinfo-attr'], loggedIn: true, consistent: true, problems: [], saltCheck: saltCheckOf(salt), sessionFingerprint: fingerprintSync(salt, id), pathFingerprint: fingerprintSync(salt, ID_A), owner: true, continuity: {checks: 2, stable: true, broke: false, covered: true}, ...extra});
    assert.deepEqual(evaluateIdentity({binding, observation: o(ID_A), ownerEvidence: true}), {source: 'userinfo-attr', result: 'match', ownership: 'verified', note: 'bound account, owner evidence present on the observed page'});
    assert.equal(evaluateIdentity({binding, observation: o(ID_B), ownerEvidence: true}).result, 'mismatch');
    assert.equal(evaluateIdentity({binding: null, observation: o(ID_A), ownerEvidence: true}).result, 'unbound');
    assert.equal(evaluateIdentity({binding, observation: o(ID_A, {continuity: {checks: 2, stable: false, broke: true, covered: true}}), ownerEvidence: true}).result, 'ambiguous');
    assert.equal(evaluateIdentity({binding, observation: o(ID_A, {continuity: {checks: 1, stable: true, broke: false, covered: true}}), ownerEvidence: true}).result, 'unobserved');
    assert.equal(evaluateIdentity({binding, observation: o(ID_A, {loggedIn: false, sessionFingerprint: null}), ownerEvidence: true}).result, 'signed-out');
    assert.equal(evaluateIdentity({binding, observation: o(ID_A, {problems: ['invalid-account-id'], consistent: false, sessionFingerprint: null}), ownerEvidence: true}).result, 'ambiguous');
    assert.equal(identityPolicy({binding: null, evaluation: {result: 'unbound'}, manualAccount: 'x'}).account, 'x');
    assert.deepEqual(checkObservation(o(ID_A)), []);
  }

  // ---- nothing identifying anywhere in the scratch homes
  for (const root of tmpRoots) { const dir = path.join(root, 'cache', 'steam'); for (const n of fs.readdirSync(dir, {recursive: true})) { const p = path.join(dir, n); if (fs.statSync(p).isFile()) noLeak(fs.readFileSync(p, 'utf8'), p); } }
  console.log('account binding fixture checks passed');
} finally { for (const r of tmpRoots) fs.rmSync(r, {recursive: true, force: true}); }
