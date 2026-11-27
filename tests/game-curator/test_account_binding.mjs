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
import {save} from '../../skills/game-curator/scripts/cache.mjs';

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
  const r = spawnSync(process.execPath, [saver, input, '--dest', h.dest, '--view', 'unfiltered', ...extra, ...(dry ? ['--dry-run'] : [])], {encoding: 'utf8'});
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
    assert.equal(runSaver(h, capture('2026-01-02T00:00:00Z'), []).json.action, 'replace');
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

  // A bound observation cannot relabel an envelope already attributed to another account.
  {
    const h = home(), b = bindAs(h);
    const foreign = {...capture('2026-01-01T00:00:00Z', {identity: obs(b, ID_A)}), account: 'other'};
    assert.throws(() => save(foreign, h.dest), /conflicts with the capture or binding/);
    const result = runSaver(h, foreign); assert.equal(result.status, 1); assert.match(result.err, /conflicts with the capture or binding/);
    assert.ok(!fs.existsSync(path.join(h.dest, 'wishlist.json')));
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
