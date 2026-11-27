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
  r = run(hook, [], {}, payload(capture)); assert.match(ctx(r), /staged the complete reviews result/); assert.equal(staged(decoy).length, 1, 'default behavior preserved when nothing is selected'); const defaultStaged = staged(decoy)[0];
  fs.rmSync(path.join(decoy, 'cache/steam/.staging'), {recursive: true}); const base = snapshot();

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
  // a file staged in the DEFAULT home is not consumable while a custom home is selected
  r = run(saver, [defaultStaged, ...common, '--dry-run'], {CURATOR_HOME: custom}); assert.ok(!fs.existsSync(defaultStaged) || r.status === 1, 'refused'); assert.equal(snapshot(), base);
  // with nothing selected the saver still defaults to the default home and says so
  r = run(hook, [], {}, payload(capture)); const dStaged = staged(decoy)[0];
  r = run(saver, [dStaged, ...common, '--dry-run'], {}); out = JSON.parse(r.stdout); assert.equal(out.curatorHome, 'default'); assert.equal(out.destination, path.join(decoy, 'cache/steam'));
  fs.rmSync(path.join(decoy, 'cache/steam/.staging'), {recursive: true});

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
  console.log('curator home isolation checks passed');
} finally { fs.rmSync(root, {recursive: true, force: true}); }
