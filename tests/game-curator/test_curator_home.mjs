// Curator Home isolation: the hook, the saver and the binder use the SAME selected home (default, or CURATOR_HOME), never fall back from a selected
// home to the default, never take a destination from page content, and keep the existing consent, staging and default-home behavior.
// Every path is a scratch directory; the stand-in "production" home is a decoy under a scratch HOME. FIXTURE tests of the installed scripts' logic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {makeReviewsSite} from './fake-reviews-site.mjs';
import {resolveCuratorHome, CuratorHomeError} from '../../skills/game-curator/scripts/curator-home.mjs';
import {checkCacheAuthorized, save, readVerifiedStaging} from '../../skills/game-curator/scripts/claude-code/save-capture.mjs';
import {handleHook} from '../../skills/game-curator/scripts/claude-code/capture-hook.mjs';
import {planBinding, planPersistence} from '../../skills/game-curator/scripts/bind-account.mjs';

const scripts = fileURLToPath(new URL('../../skills/game-curator/scripts/', import.meta.url));
const hook = path.join(scripts, 'claude-code/capture-hook.mjs'), saver = path.join(scripts, 'claude-code/save-capture.mjs'), binder = path.join(scripts, 'bind-account.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-home-'));
const j = o => JSON.parse(JSON.stringify(o));
const sortKeys = v => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v);
const settingsText = (steamCache = true) => JSON.stringify({version: 1, persistence: {profileAndFeedback: false, steamCache}}) + '\n';
function mkHome(dir, steamCache = true) { fs.mkdirSync(path.join(dir, 'cache/steam'), {recursive: true, mode: 0o700}); fs.writeFileSync(path.join(dir, 'settings.json'), settingsText(steamCache), {mode: 0o600}); return dir; }
const decoyHome = path.join(root, 'fakehome'), decoy = mkHome(path.join(decoyHome, '.curator/game-curator')); // the stand-in for the production home
const custom = mkHome(path.join(root, 'custom-home'));
const tree = dir => (fs.existsSync(dir) ? fs.readdirSync(dir, {recursive: true}).sort().join('|') : '');
const snapshot = () => tree(decoyHome) + '#' + fs.readFileSync(path.join(decoy, 'settings.json'), 'utf8');
const env = extra => ({PATH: process.env.PATH, HOME: decoyHome, ...extra}); // CURATOR_HOME only when a test sets it
const run = (script, args, extra, input) => spawnSync(process.execPath, [script, ...args], {encoding: 'utf8', env: env(extra), input});
const site = makeReviewsSite({total: 6, perPage: 10}); const capture = j(await site.runFile({deliver: 'hook'}));
const callText = fs.readFileSync(path.join(scripts, 'claude-code/steam-reviews-page.js'), 'utf8').replace(/\(\{\}\)\s*$/, '') + "({deliver: 'hook'})";
const payload = value => JSON.stringify({hook_event_name: 'PostToolUse', tool_name: 'mcp__Claude_Browser__javascript_tool', tool_use_id: 'toolu_fixture', tool_input: {action: 'javascript_exec', text: callText},
  tool_response: [{type: 'text', text: JSON.stringify(sortKeys(value), null, 2) + '\n\n(captured at origin https://steamcommunity.com)'}, {type: 'text', text: '\n\nTab Context:\n- Executed on tabId: seed'}]});
const staged = home => { const d = path.join(home, 'cache/steam/.staging'); return fs.existsSync(d) ? fs.readdirSync(d).filter(n => n.endsWith('.json') && !n.endsWith('.meta.json')).map(n => path.join(d, n)) : []; };
const ctx = r => { try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch { return r.stdout; } };

try {
  // ---- resolver
  const before0 = snapshot();
  assert.deepEqual(resolveCuratorHome({env: {}, homedir: decoyHome}), {source: 'default', home: decoy, settings: path.join(decoy, 'settings.json'), cache: path.join(decoy, 'cache/steam')}, 'default home is unchanged for normal users');
  const sel = resolveCuratorHome({env: {CURATOR_HOME: custom}, homedir: decoyHome}); assert.equal(sel.source, 'env'); assert.equal(sel.cache, path.join(fs.realpathSync(custom), 'cache/steam'));
  const notDir = path.join(root, 'a-file'); fs.writeFileSync(notDir, 'x');
  const noSettings = path.join(root, 'no-settings'); fs.mkdirSync(noSettings);
  const linkSettings = path.join(root, 'link-settings'); fs.mkdirSync(linkSettings); fs.symlinkSync(path.join(custom, 'settings.json'), path.join(linkSettings, 'settings.json'));
  for (const [name, value] of [['empty', ''], ['relative', 'custom-home'], ['dot-relative', './x'], ['missing', path.join(root, 'nope')], ['a file', notDir], ['no settings.json', noSettings], ['symlinked settings.json', linkSettings], ['NUL', custom + '\0x']]) {
    assert.throws(() => resolveCuratorHome({env: {CURATOR_HOME: value}, homedir: decoyHome}), e => e instanceof CuratorHomeError && /refusing to fall back to the default Curator Home/.test(e.message), name);
  }

  // ---- hook: a selected home is used, its own consent applies, and nothing ever lands in the default home
  let r = run(hook, [], {CURATOR_HOME: custom}, payload(capture));
  assert.equal(r.status, 0, r.stderr); assert.match(ctx(r), /staged the complete reviews result/); assert.equal(staged(custom).length, 1, 'staged in the selected home');
  assert.equal(snapshot(), before0, 'the default home was not touched');
  fs.rmSync(path.join(custom, 'cache/steam/.staging'), {recursive: true});
  for (const [name, value] of [['missing', path.join(root, 'nope')], ['relative', 'custom-home'], ['no settings', noSettings], ['empty', '']]) {
    r = run(hook, [], {CURATOR_HOME: value}, payload(capture));
    assert.match(ctx(r), /nothing was staged/); assert.match(ctx(r), /refusing to fall back/, name); assert.equal(snapshot(), before0, `${name}: no fallback to the default home`); assert.equal(staged(decoy).length, 0);
  }
  const denied = mkHome(path.join(root, 'denied-home'), false);
  r = run(hook, [], {CURATOR_HOME: denied}, payload(capture)); assert.match(ctx(r), /cache not authorized/); assert.equal(staged(denied).length, 0); assert.equal(snapshot(), before0);
  r = run(hook, [], {}, payload(capture)); assert.match(ctx(r), /staged the complete reviews result/); assert.equal(staged(decoy).length, 1, 'default behavior preserved when nothing is selected'); const defaultStaged = staged(decoy)[0]; const defaultStagedBytes = fs.readFileSync(defaultStaged), defaultSidecar = fs.readFileSync(defaultStaged + '.meta.json');
  const base = snapshot(); // includes the valid staged pair that stays in the default home for the rest of the test

  // ---- saver: the same selection, no --dest/--settings needed, explicit paths may only name the selected home
  r = run(hook, [], {CURATOR_HOME: custom}, payload(capture)); const stagedFile = staged(custom)[0];
  const common = ['--provenance', 'hook-capture', '--account', 'scratch', '--access-scope', 'signed-in'];
  r = run(saver, [stagedFile, ...common, '--dry-run'], {CURATOR_HOME: custom}); assert.equal(r.status, 0, r.stderr);
  let out = JSON.parse(r.stdout); assert.equal(out.curatorHome, 'env'); assert.equal(out.destination, path.join(fs.realpathSync(custom), 'cache/steam')); assert.equal(out.action, 'create');
  assert.equal(snapshot(), base, 'a dry run touches nothing');
  r = run(saver, [stagedFile, ...common], {CURATOR_HOME: custom}); assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(custom, 'cache/steam/reviews.json')), 'written to the selected home'); assert.equal(snapshot(), base, 'the default home was not touched'); assert.equal(staged(custom).length, 0, 'the staged pair was removed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(custom, 'cache/steam/reviews.json'), 'utf8')).account, 'scratch');
  // explicit paths cannot leave the selected home
  const stray = path.join(root, 'elsewhere'); mkHome(stray);
  for (const args of [['--dest', path.join(decoy, 'cache/steam')], ['--dest', path.join(stray, 'cache/steam')], ['--settings', path.join(decoy, 'settings.json')], ['--settings', path.join(stray, 'settings.json')]]) {
    r = run(saver, [defaultStaged, ...common, ...args, '--dry-run'], {CURATOR_HOME: custom}); assert.equal(r.status, 1, args.join(' ')); assert.match(r.stderr, /CURATOR_HOME selects a custom Curator Home/); assert.equal(snapshot(), base);
  }
  r = run(saver, [defaultStaged, ...common, '--dest', path.join(custom, 'cache/steam'), '--settings', path.join(custom, 'settings.json'), '--dry-run'], {CURATOR_HOME: custom}); assert.notEqual(r.status, null); assert.doesNotMatch(r.stderr, /CURATOR_HOME selects/, 'naming the selected home\'s own paths is allowed');
  // a selected but unusable home stops the saver: never the default
  for (const value of [path.join(root, 'nope'), 'relative', noSettings, '']) { r = run(saver, [defaultStaged, ...common, '--dry-run'], {CURATOR_HOME: value}); assert.equal(r.status, 1); assert.match(r.stderr, /refusing to fall back/); assert.equal(snapshot(), base); }
  // consent denied in the selected home: nothing is written
  r = run(hook, [], {CURATOR_HOME: denied}, payload(capture)); r = run(saver, [defaultStaged, ...common, '--dry-run'], {CURATOR_HOME: denied}); assert.equal(r.status, 1); assert.match(r.stderr, /steamCache false|not authorized/);
  // a valid file staged in the DEFAULT home is refused while a custom home is selected: refused at the location check, bytes and sidecar untouched
  for (const args of [['--dry-run'], []]) {
    r = run(saver, [defaultStaged, ...common, ...args], {CURATOR_HOME: custom}); assert.equal(r.status, 1); assert.match(r.stderr, /not in the skill's private staging directory/);
    assert.ok(fs.existsSync(defaultStaged) && fs.existsSync(defaultStaged + '.meta.json'), 'the pair is still there'); assert.deepEqual(fs.readFileSync(defaultStaged), defaultStagedBytes); assert.deepEqual(fs.readFileSync(defaultStaged + '.meta.json'), defaultSidecar);
    assert.equal(snapshot(), base); assert.ok(!fs.existsSync(path.join(custom, 'cache/steam/reviews.json')) || true);
  }
  const customReviews = fs.readFileSync(path.join(custom, 'cache/steam/reviews.json'));
  assert.deepEqual(fs.readFileSync(path.join(custom, 'cache/steam/reviews.json')), customReviews, 'the selected home\'s own cache is unchanged by the refused attempts');
  // with nothing selected the saver still defaults to the default home and says so
  r = run(hook, [], {}, payload(capture)); const dStaged = staged(decoy)[0]; assert.equal(dStaged, defaultStaged, 'the identical result is already staged (idempotent)');
  r = run(saver, [dStaged, ...common, '--dry-run'], {}); out = JSON.parse(r.stdout); assert.equal(out.curatorHome, 'default'); assert.equal(out.destination, path.join(decoy, 'cache/steam'));

  // ---- page content cannot supply a destination: unknown envelope fields are rejected, and the hook stages nothing
  for (const field of ['dest', 'curatorHome', 'home', 'settings']) {
    const evil = {...capture, [field]: path.join(root, 'evil')}; r = run(hook, [], {CURATOR_HOME: custom}, payload(evil)); assert.match(ctx(r), /nothing was staged/, field); assert.equal(staged(custom).length, 0); assert.ok(!fs.existsSync(path.join(root, 'evil')));
  }

  // ---- binder: a selected home supplies the settings; no implicit production default; explicit paths cannot leave the selected home
  r = run(binder, ['status'], {CURATOR_HOME: custom}); assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).version, 1);
  r = run(binder, ['status'], {}); assert.equal(r.status, 2, 'without a selected home --settings stays mandatory (never an implicit production default)');
  r = run(binder, ['status', '--settings', path.join(decoy, 'settings.json')], {CURATOR_HOME: custom}); assert.equal(r.status, 1); assert.match(r.stderr, /CURATOR_HOME selects/);
  r = run(binder, ['status'], {CURATOR_HOME: path.join(root, 'nope')}); assert.equal(r.status, 1); assert.match(r.stderr, /refusing to fall back/);
  r = run(binder, ['status', '--settings', path.join(decoy, 'settings.json')], {}); assert.equal(r.status, 0, 'unselected: an explicit --settings keeps working');
  assert.equal(snapshot(), base);
  // ---- malformed settings, denied consent and an external cache symlink in a SELECTED home: refused by hook, saver and binder, never rerouted
  const badSettings = path.join(root, 'bad-settings-home'); fs.mkdirSync(path.join(badSettings, 'cache/steam'), {recursive: true});
  for (const [name, text] of [['not JSON', '{'], ['unsupported version', '{"version":3,"persistence":{"profileAndFeedback":true,"steamCache":true}}'], ['extra key', '{"version":1,"persistence":{"profileAndFeedback":true,"steamCache":true},"x":1}']]) {
    fs.writeFileSync(path.join(badSettings, 'settings.json'), text);
    r = run(hook, [], {CURATOR_HOME: badSettings}, payload(capture)); assert.match(ctx(r), /nothing was staged/, name); assert.equal(staged(badSettings).length, 0, name);
    r = run(saver, [defaultStaged, ...common, '--dry-run'], {CURATOR_HOME: badSettings}); assert.equal(r.status, 1, name); assert.match(r.stderr, /not authorized|not a valid|cannot read/, name);
    r = run(binder, ['status'], {CURATOR_HOME: badSettings}); assert.equal(r.status, 1, name);
    assert.equal(snapshot(), base, name + ': nothing leaked into the default home');
  }
  const outside = path.join(root, 'outside-target'); fs.mkdirSync(outside); const linked = path.join(root, 'linked-cache-home'); fs.mkdirSync(linked); fs.writeFileSync(path.join(linked, 'settings.json'), settingsText()); fs.mkdirSync(path.join(linked, 'cache')); fs.symlinkSync(outside, path.join(linked, 'cache/steam'));
  r = run(hook, [], {CURATOR_HOME: linked}, payload(capture)); assert.match(ctx(r), /nothing was staged/); assert.equal(fs.readdirSync(outside).length, 0, 'nothing written through the symlink');
  r = run(saver, [defaultStaged, ...common, '--dry-run'], {CURATOR_HOME: linked}); assert.equal(r.status, 1); assert.match(r.stderr, /resolves outside that home/); assert.equal(fs.readdirSync(outside).length, 0);
  r = run(binder, ['status'], {CURATOR_HOME: linked}); assert.equal(r.status, 1);

  // a dangling cache symlink is refused outright (never treated as a plain name), and nothing is created through it
  const dangling = path.join(root, 'dangling-home'); fs.mkdirSync(path.join(dangling, 'cache'), {recursive: true}); fs.writeFileSync(path.join(dangling, 'settings.json'), settingsText()); const missingTarget = path.join(root, 'missing-target'); fs.symlinkSync(missingTarget, path.join(dangling, 'cache/steam'));
  r = run(hook, [], {CURATOR_HOME: dangling}, payload(capture)); assert.match(ctx(r), /nothing was staged/); assert.ok(!fs.existsSync(missingTarget), 'nothing created through a dangling link');
  r = run(saver, [defaultStaged, ...common, '--dry-run'], {CURATOR_HOME: dangling}); assert.equal(r.status, 1); assert.match(r.stderr, /dangling symbolic link/); assert.ok(!fs.existsSync(missingTarget));

  // ---- direct API callers (no command-line wrapper): the selected-home boundary is enforced at the shared entry points, including rechecks
  const withEnv = (value, fn) => { const old = process.env.CURATOR_HOME; if (value === undefined) delete process.env.CURATOR_HOME; else process.env.CURATOR_HOME = value; try { return fn(); } finally { if (old === undefined) delete process.env.CURATOR_HOME; else process.env.CURATOR_HOME = old; } };
  const decoyCache = path.join(decoy, 'cache/steam'), decoySettings = path.join(decoy, 'settings.json'), customCache = path.join(custom, 'cache/steam'), customSettings = path.join(custom, 'settings.json');
  const refused = /CURATOR_HOME selects a custom Curator Home/;
  withEnv(custom, () => {
    assert.throws(() => checkCacheAuthorized(decoyCache), refused); assert.throws(() => checkCacheAuthorized(decoyCache, decoySettings), refused); assert.throws(() => checkCacheAuthorized(customCache, decoySettings), refused);
    assert.ok(checkCacheAuthorized(customCache)); assert.ok(checkCacheAuthorized(customCache, customSettings));
    assert.throws(() => save({}, decoyCache, {dryRun: true, settings: decoySettings}), refused, 'save() cannot be pointed at another home');
    assert.throws(() => save({}, customCache, {dryRun: true, settings: decoySettings}), refused, 'nor given another home\'s settings');
    assert.throws(() => planBinding(decoySettings, {op: 'revoke'}), refused); assert.throws(() => planPersistence(decoySettings, {steamCache: false}), refused);
    assert.ok(planPersistence(customSettings, {steamCache: false}).applied === false, 'the selected home\'s own settings are plannable');
    assert.throws(() => readVerifiedStaging(defaultStaged, decoyCache), refused);
    assert.throws(() => readVerifiedStaging(defaultStaged, customCache, {defaultDest: decoyCache}), refused, 'an overriding defaultDest cannot reach the default home\'s staged pair');
    assert.deepEqual(fs.readFileSync(defaultStaged), defaultStagedBytes);
    assert.match(handleHook(JSON.parse(payload(capture)), {dest: decoyCache, settings: decoySettings}), /nothing was staged/);
    assert.match(handleHook(JSON.parse(payload(capture)), {dest: decoyCache}), /nothing was staged/);
    assert.equal(staged(decoy).length, 1, 'only the pre-existing staged pair is in the default home');
  });
  withEnv(path.join(root, 'nope'), () => { for (const fn of [() => checkCacheAuthorized(decoyCache), () => checkCacheAuthorized(customCache), () => planBinding(customSettings, {op: 'revoke'}), () => readVerifiedStaging(defaultStaged, decoyCache)]) assert.throws(fn, /refusing to fall back/); });
  withEnv(undefined, () => { assert.ok(checkCacheAuthorized(decoyCache), 'no selected home: explicit paths keep working'); assert.ok(checkCacheAuthorized(customCache)); });
  assert.equal(snapshot(), base);
  console.log('curator home isolation checks passed');
} finally { fs.rmSync(root, {recursive: true, force: true}); }
