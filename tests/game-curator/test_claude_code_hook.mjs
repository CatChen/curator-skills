// Behavioral tests for the skill-scoped PostToolUse capture hook and the saver's hook-capture provenance (synthetic data only).
// The hook sees the runtime-processed tool response; these tests build that structure the way the built-in browser returns it
// (two text blocks, keys alphabetized, an origin suffix) and check what is staged, what is ignored, what is rejected and what the saver verifies.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {makeReplaySite} from './fake-replay-site.mjs';
import {makeReviewsSite} from './fake-reviews-site.mjs';
import {makeLibraryPage} from './fake-library-dom.mjs';
import {makeWishlistPage} from './fake-wishlist-dom.mjs';
import {handleHook, identifyCall as identify, parseOptions, readInlineEnvelope} from '../../skills/game-curator/scripts/claude-code/capture-hook.mjs';
import {readVerifiedStaging, removeIfUnchanged, STAGING_DIR, HOOK_TOOLS} from '../../skills/game-curator/scripts/claude-code/save-capture.mjs';

const root = new URL('../../skills/game-curator/scripts/claude-code/', import.meta.url).pathname;
const j = o => JSON.parse(JSON.stringify(o));
const PAGES = {wishlist: 'steam-wishlist-page.js', library: 'steam-library-page.js', reviews: 'steam-reviews-page.js', replay: 'steam-replay-page.js'};
const script = s => fs.readFileSync(path.join(root, PAGES[s]), 'utf8').replace(/\(\{\}\)\s*$/, '');
const call = (s, literal = "({deliver: 'hook'})") => script(s) + literal;
const sortKeys = v => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v);
const identifyCall = (text, dir) => identify(text === undefined || typeof text !== 'string' ? {action: 'javascript_exec', text} : {action: 'javascript_exec', text}, dir);
const IAB = '\n\n(captured at origin https://store.steampowered.com)';
const tab = '\n\nTab Context:\n- Executed on tabId: seed';
// What the built-in browser returns for an inline result: pretty JSON with alphabetized keys, an origin note, then tab context.
const response = (value, suffix = IAB) => [{type: 'text', text: JSON.stringify(sortKeys(value), null, 2) + suffix}, {type: 'text', text: tab}];
const payload = (source, value, over = {}) => ({hook_event_name: 'PostToolUse', tool_name: HOOK_TOOLS[0], tool_use_id: 'toolu_synthetic', tool_input: {action: 'javascript_exec', text: call(source)}, tool_response: response(value), ...over});

async function envelopes() {
  const out = {};
  const wl = makeWishlistPage({n: 12}); let r = j(await wl.run({})); for (let i = 0; i < 20 && !r.format; i++) r = j(await wl.run({})); out.wishlist = r;
  out.library = j(await makeLibraryPage({n: 20}).run({quietMs: 120, stallMs: 150}));
  const drive = async (site, opts = {}) => { let r = j(await site.runFile(opts)); for (let i = 0; r.status === 'continue' && i < 30; i++) { site.navigate(r.next); r = j(await site.runFile(opts)); } return r; };
  out.reviews = await drive(makeReviewsSite({total: 12, perPage: 5}));
  out.replay = await drive(makeReplaySite());
  return out;
}
const ENV = await envelopes();
for (const [s, e] of Object.entries(ENV)) assert.equal(e.source, s, `fixture ${s} must be a ${s} envelope`);

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-hook-')), dir = path.join(home, '.curator/game-curator'), dest = path.join(dir, 'cache/steam'), settings = path.join(dir, 'settings.json');
  fs.mkdirSync(dest, {recursive: true});
  fs.writeFileSync(settings, JSON.stringify({version: 1, persistence: {profileAndFeedback: false, steamCache: true}}));
  const staged = () => { try { return fs.readdirSync(path.join(dest, STAGING_DIR)); } catch { return []; } };
  return {home, dir, dest, settings, staged, opts: {dest, settings, skillDir: root}};
}
const everything = d => fs.readdirSync(d, {recursive: true}).map(String);

// 1. Which calls are intended collector runs: the shipped script byte for byte plus a plain options literal, or a plain resume call.
for (const s of Object.keys(PAGES)) {
  assert.deepEqual(identifyCall(call(s), root), {source: s, call: 'run', scriptSha256: identifyCall(call(s), root).scriptSha256, optIn: true}, `${s} run`);
  assert.equal(identifyCall(call(s, '({})'), root).optIn, false, 'no deliver hook, no opt-in');
  assert.equal(identifyCall(call(s, "({deliver: 'return', maxPages: 5})"), root).optIn, false);
  assert.equal(identifyCall(call(s, '({deliver: "hook", maxYears: 3, fresh: true})'), root).optIn, true);
  assert.equal(identifyCall(`await window.__gc${s[0].toUpperCase() + s.slice(1)}Run({deliver: 'hook'})`, root).call, 'resume');
  assert.equal(identifyCall(`await window.__gc${s[0].toUpperCase() + s.slice(1)}Run({})`, root).optIn, false);
}
for (const bad of [call('replay').replace('await', 'await 0;'), call('replay', "({deliver: 'hook'}); fetch('https://example.invalid')"), call('replay', "({deliver: leak()})"), call('replay', '(1)'),
  script('replay') + "({deliver: 'hook'});\nawait (()=>1)()", "await window.__gcReplayRun({deliver: 'hook'}); await 1", "await window.__gcOtherRun({deliver: 'hook'})", "({probe: 'GCPROBE', deliver: 'hook'})", undefined, 7]) {
  assert.equal(identifyCall(bad, root), null, `not a collector run: ${String(bad).slice(-60)}`);
}
assert.equal(identifyCall(call('reviews').replace(/\n$/, ''), root).source, 'reviews', 'a trimmed trailing newline is the same run');

// 2. Reading the inline result: complete envelope only; intermediate results are ignored; redacted/truncated ones are rejected.
assert.equal(readInlineEnvelope(response(ENV.replay)).kind, 'envelope');
assert.equal(readInlineEnvelope(response(ENV.replay, '')).kind, 'envelope', 'Chrome returns no origin suffix');
for (const v of [{status: 'continue', next: 'https://store.steampowered.com/replay/1/2022'}, {inProgress: true, calls: 1}, {downloadInitiated: true}, {probe: 'x'}, [1, 2], 'text', null]) assert.equal(readInlineEnvelope(response(v)).kind, 'ignore', JSON.stringify(v));
assert.equal(readInlineEnvelope([{type: 'text', text: 'Result saved to /some/native/file.json'}]).kind, 'ignore', 'a pointer to a native tool-result file is not an inline envelope');
assert.equal(readInlineEnvelope([{type: 'image', data: 'x'}]).kind, 'ignore'); assert.equal(readInlineEnvelope('nope').kind, 'ignore'); assert.equal(readInlineEnvelope([]).kind, 'ignore');
const whole = JSON.stringify(sortKeys(ENV.replay), null, 2);
assert.equal(readInlineEnvelope([{type: 'text', text: whole.slice(0, 1000) + '\n[TRUNCATED]'}]).kind, 'reject');
assert.equal(readInlineEnvelope([{type: 'text', text: whole.slice(0, 1000)}]).kind, 'reject', 'cut-off JSON');
assert.equal(readInlineEnvelope([{type: 'text', text: whole.replace('game-curator-steam-export', '[BLOCKED: Base64 encoded data]')}]).kind, 'reject');

// 3. Happy path for every source: staged privately, exclusively, with a sidecar, and the model is told where, with provenance spelled out.
for (const s of Object.keys(PAGES)) {
  const f = fixture(), p = payload(s, ENV[s]);
  const note = handleHook(p, f.opts);
  const staged = f.staged();
  assert.equal(staged.length, 2, `${s}: file and sidecar`); assert.ok(staged.some(n => n.endsWith('.json.meta.json')));
  const file = path.join(f.dest, STAGING_DIR, staged.find(n => !n.endsWith('.meta.json')));
  assert.match(note, /hook-capture/); assert.match(note, /not a native tool-result file and not a browser download/); assert.ok(note.includes(file));
  assert.ok(note.length < 1500, 'the note carries no data');
  assert.equal(fs.statSync(path.join(f.dest, STAGING_DIR)).mode & 0o777, 0o700); assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.statSync(file + '.meta.json').mode & 0o777, 0o600);
  assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))), JSON.stringify(sortKeys(ENV[s])), 'the staged bytes are the received result, byte for byte, with no model in between');
  const meta = JSON.parse(fs.readFileSync(file + '.meta.json', 'utf8'));
  assert.equal(meta.source, s); assert.equal(meta.tool, HOOK_TOOLS[0]); assert.equal(meta.call, 'run'); assert.equal(meta.deliver, 'hook'); assert.equal(meta.toolUseId, 'toolu_synthetic');
  assert.equal(readVerifiedStaging(file, f.dest).meta.sha256, meta.sha256);
  assert.deepEqual(everything(f.home).filter(n => !n.startsWith('.curator/game-curator/cache/steam/.staging') && !/^\.curator(\/game-curator(\/cache(\/steam)?)?)?$/.test(n)).filter(n => n !== '.curator/game-curator/settings.json'), [], 'nothing else is written');
  // The same result delivered twice (a retried hook) is idempotent, not an error and not a second copy.
  handleHook(p, f.opts); assert.equal(f.staged().length, 2);
}
{ // Chrome tool name, and a resume call
  const f = fixture(), e = ENV.library;
  handleHook(payload('library', e, {tool_name: HOOK_TOOLS[1], tool_response: response(e, ''), tool_input: {action: 'javascript_exec', text: "await window.__gcLibraryRun({deliver: 'hook'})"}}), f.opts);
  assert.equal(f.staged().length, 2); const m = JSON.parse(fs.readFileSync(path.join(f.dest, STAGING_DIR, f.staged().find(n => n.endsWith('.meta.json'))), 'utf8'));
  assert.equal(m.tool, HOOK_TOOLS[1]); assert.equal(m.call, 'resume'); assert.equal(m.scriptSha256, null);
}

// 4. Silence: unrelated tools and results, no opt-in, intermediate results, unrecognized scripts. Nothing may be staged and the staging directory is not even created.
{
  const f = fixture(), none = p => { assert.equal(handleHook(p, f.opts), null); assert.deepEqual(f.staged(), []); assert.ok(!fs.existsSync(path.join(f.dest, STAGING_DIR))); };
  none(payload('replay', ENV.replay, {tool_name: 'mcp__Claude_Browser__get_page_text'})); none(payload('replay', ENV.replay, {tool_name: 'Bash'})); none(payload('replay', ENV.replay, {hook_event_name: 'PreToolUse'}));
  none(payload('replay', ENV.replay, {tool_input: {text: call('replay', '({})')}}));                                           // no opt-in
  none(payload('replay', ENV.replay, {tool_input: {text: call('replay', "({deliver: 'download'})")}}));
  none(payload('replay', {status: 'continue', next: 'https://store.steampowered.com/replay/1/2022'}));                         // intermediate
  none(payload('wishlist', {inProgress: true, calls: 1}));
  none(payload('replay', ENV.replay, {tool_input: {text: "document.title"}}));                                                  // unrelated page script
  none(payload('replay', {probe: 'x', format: 'game-curator-steam-export'}, {tool_input: {text: "({format: 'game-curator-steam-export', deliver: 'hook'})"}})); // a page-style marker is not authorization
  none(payload('replay', ENV.replay, {tool_input: {text: "return {format: 'game-curator-steam-export', source: 'replay', deliver: 'hook'}"}}));
  none(null); none({}); none(payload('replay', ENV.replay, {tool_response: undefined}));
  assert.match(handleHook(payload('replay', ENV.replay, {tool_input: {text: "await window.__gcReplayRun({deliver: 'hook'}); await fetch('x')"}}), f.opts), /not a recognized, unambiguous collector run/);
  assert.deepEqual(f.staged(), []);
}

// 5. Rejections stage nothing: redacted, truncated, malformed, wrong source, tampered records, checksum mismatch, invalid envelope, oversized.
{
  const f = fixture(), refused = (p, re) => { const n = handleHook(p, f.opts); assert.match(n, re); assert.match(n, /nothing was staged/); assert.match(n, /Do not reconstruct/); assert.deepEqual(f.staged(), []); };
  refused(payload('replay', ENV.replay, {tool_response: [{type: 'text', text: whole.slice(0, 1000) + '\n[TRUNCATED]'}]}), /redacted or truncated/);
  refused(payload('replay', ENV.replay, {tool_response: [{type: 'text', text: whole.replace('game-curator-steam-export', '[BLOCKED: Base64 encoded data]')}]}), /redacted or truncated/);
  refused(payload('replay', ENV.replay, {tool_response: [{type: 'text', text: whole.slice(0, 2000)}]}), /not complete JSON/);
  refused(payload('wishlist', ENV.replay), /is a replay envelope but the call was a wishlist run/);
  const tampered = j(ENV.replay); tampered.records[0].semanticText += ' edited'; refused(payload('replay', tampered), /records checksum/);
  const extra = j(ENV.replay); extra.surprise = 1; refused(payload('replay', extra), /failed validation/);
  const wrongVersion = j(ENV.library); wrongVersion.version = 2; refused(payload('library', wrongVersion), /failed validation/);
  const huge = j(ENV.replay); huge.warnings = Array(40).fill('x'.repeat(500000)); refused(payload('replay', huge), /larger than the staging limit|failed validation/);
}

// 6. Consent is checked at the moment of the call: revoked, absent, malformed or not governing the destination means no staging directory at all.
for (const [name, mutate] of [['revoked', f => fs.writeFileSync(f.settings, JSON.stringify({version: 1, persistence: {profileAndFeedback: true, steamCache: false}}))],
  ['absent', f => fs.rmSync(f.settings)], ['malformed', f => fs.writeFileSync(f.settings, '{"version":1}')], ['elsewhere', f => { f.opts.settings = path.join(f.home, 'settings.json'); fs.writeFileSync(f.opts.settings, JSON.stringify({version: 1, persistence: {profileAndFeedback: false, steamCache: true}})); f.opts.dest = path.join(os.tmpdir(), 'gc-hook-elsewhere'); }]]) {
  const f = fixture(); mutate(f);
  const n = handleHook(payload('replay', ENV.replay), f.opts);
  assert.match(n, /nothing was staged \(cache not authorized/, name); assert.ok(!fs.existsSync(path.join(f.opts.dest, STAGING_DIR)), `${name}: no staging directory`);
}
{ // Consent can be revoked between two calls of the same session: the first stages, the second does not.
  const f = fixture(); handleHook(payload('library', ENV.library), f.opts); assert.equal(f.staged().length, 2);
  fs.writeFileSync(f.settings, JSON.stringify({version: 1, persistence: {profileAndFeedback: false, steamCache: false}}));
  assert.match(handleHook(payload('reviews', ENV.reviews), f.opts), /cache not authorized/); assert.equal(f.staged().length, 2);
}

// 7. Hostile filesystem: a symlinked staging directory or file is refused, a colliding name with other content is refused, old staged files are pruned and strangers are left.
{
  const f = fixture(), elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-hook-target-'));
  fs.symlinkSync(elsewhere, path.join(f.dest, STAGING_DIR));
  assert.throws(() => handleHook(payload('replay', ENV.replay), f.opts), /plain directory/); assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing is written through a symlink');
}
{
  const f = fixture(); handleHook(payload('replay', ENV.replay), f.opts);
  const stagedFile = path.join(f.dest, STAGING_DIR, f.staged().find(n => !n.endsWith('.meta.json')));
  fs.writeFileSync(stagedFile, 'different'); // same name, other content
  assert.match(handleHook(payload('replay', ENV.replay), f.opts), /a different staged file already has this name/);
}
{
  const f = fixture(), dir = path.join(f.dest, STAGING_DIR); fs.mkdirSync(dir, {mode: 0o755}); fs.chmodSync(dir, 0o755);
  const old = path.join(dir, 'gc-replay-20200101T000000Z-abcdef12.json'), oldMeta = old + '.meta.json', fresh = path.join(dir, 'gc-replay-20200101T000000Z-abcdef13.json'), stranger = path.join(dir, 'notes.json');
  for (const x of [old, oldMeta, fresh, stranger]) fs.writeFileSync(x, '{}');
  const past = (Date.now() - 25 * 3600 * 1000) / 1000; for (const x of [old, oldMeta, stranger]) fs.utimesSync(x, past, past);
  handleHook(payload('replay', ENV.replay), f.opts);
  assert.ok(!fs.existsSync(old) && !fs.existsSync(oldMeta), 'stale staged captures are removed'); assert.ok(fs.existsSync(fresh) && fs.existsSync(stranger), 'recent or foreign files are left alone');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700, 'a loose staging directory is tightened');
}

// 8. The saver's hook-capture provenance: verified staging, recorded level, removal after a real save only, and refusal of everything else.
const saver = path.join(root, 'save-capture.mjs');
const runSaver = (f, file, extra = []) => spawnSync(process.execPath, [saver, file, '--dest', f.dest, '--settings', f.settings, '--account', 'scratch', '--access-scope', 'signed-in', ...extra], {encoding: 'utf8'});
for (const s of ['wishlist', 'library', 'reviews', 'replay']) {
  const f = fixture(); handleHook(payload(s, ENV[s]), f.opts);
  const file = path.join(f.dest, STAGING_DIR, f.staged().find(n => !n.endsWith('.meta.json')));
  const extra = ['--provenance', 'hook-capture', ...(s === 'wishlist' ? ['--view', 'unfiltered'] : [])];
  const dry = runSaver(f, file, [...extra, '--dry-run']); assert.equal(dry.status, 0, `${s} dry run: ${dry.stderr}`);
  assert.equal(f.staged().length, 2, 'a dry run leaves the staged pair'); assert.ok(!fs.existsSync(path.join(f.dest, s === 'replay' ? 'replay' : `${s}.json`)));
  const real = runSaver(f, file, extra); assert.equal(real.status, 0, `${s} save: ${real.stderr}`);
  assert.deepEqual(f.staged(), [], 'the staged pair is removed after a successful save'); assert.match(real.stderr, /removed the staged hook capture/);
  const target = s === 'replay' ? path.join(f.dest, 'replay', `${ENV.replay.records[0].year}.json`) : path.join(f.dest, `${s}.json`);
  const saved = JSON.parse(fs.readFileSync(target, 'utf8')), t = saved.diagnostics.attestations.transfer;
  assert.equal(t.provenance, 'hook-capture'); assert.equal(t.level, 'hook-tool-response'); assert.equal(t.hook.tool, HOOK_TOOLS[0]); assert.equal(t.hook.call, 'run'); assert.equal(t.sourceDigest ?? 'unavailable', 'unavailable');
  assert.match(t.note, /not a native tool-result file, not a download/); assert.ok(t.hook.sha256 && t.hook.stagedAt);
  assert.equal(saved.records.length, s === 'replay' ? 1 : ENV[s].records.length);
}
{ // Negatives: each leaves the cache untouched and the staged pair in place.
  const mk = () => { const f = fixture(); handleHook(payload('library', ENV.library), f.opts); const file = path.join(f.dest, STAGING_DIR, f.staged().find(n => !n.endsWith('.meta.json'))); return {f, file}; };
  const fails = (f, file, re, extra = ['--provenance', 'hook-capture']) => { const r = runSaver(f, file, extra); assert.equal(r.status, 1, r.stdout); assert.match(r.stderr, re); assert.ok(!fs.existsSync(path.join(f.dest, 'library.json')), 'nothing saved'); assert.ok(fs.existsSync(file), 'staged file kept for inspection'); };
  { const {f, file} = mk(); fs.appendFileSync(file, ' '); fails(f, file, /does not match its sidecar/); }
  { const {f, file} = mk(); fs.chmodSync(file, 0o644); fails(f, file, /readable by others/); }
  { const {f, file} = mk(); fs.chmodSync(file + '.meta.json', 0o644); fails(f, file, /readable by others/); }
  { const {f, file} = mk(); const m = JSON.parse(fs.readFileSync(file + '.meta.json', 'utf8')); fs.writeFileSync(file + '.meta.json', JSON.stringify({...m, tool: 'Bash'}), {mode: 0o600}); fails(f, file, /names a tool the hook does not handle/); }
  { const {f, file} = mk(); const m = JSON.parse(fs.readFileSync(file + '.meta.json', 'utf8')); fs.writeFileSync(file + '.meta.json', JSON.stringify({...m, extra: 1}), {mode: 0o600}); fails(f, file, /not a hook capture record/); }
  { const {f, file} = mk(); const m = JSON.parse(fs.readFileSync(file + '.meta.json', 'utf8')); fs.writeFileSync(file + '.meta.json', JSON.stringify({...m, stagedAt: new Date(Date.now() - 30 * 3600 * 1000).toISOString()}), {mode: 0o600}); fails(f, file, /older than 24 hours/); }
  { const {f, file} = mk(); fs.rmSync(file + '.meta.json'); fails(f, file, /ENOENT|no such file/i); }
  { const {f, file} = mk(); const copy = path.join(f.home, path.basename(file)); fs.copyFileSync(file, copy); fs.copyFileSync(file + '.meta.json', copy + '.meta.json'); fs.chmodSync(copy, 0o600); fs.chmodSync(copy + '.meta.json', 0o600); fails(f, copy, /unexpected staged file name|not in the skill's private staging directory/); }
  { const {f, file} = mk(); const link = path.join(path.dirname(file), 'gc-library-20200101T000000Z-deadbeef.json'); fs.symlinkSync(file, link); fs.symlinkSync(file + '.meta.json', link + '.meta.json'); fails(f, link, /cannot open/); }
}
{ // A plain file or a native tool-result file cannot claim hook-capture, and hook files cannot claim other provenance as verified.
  const f = fixture(), plain = path.join(f.home, 'plain.json'); fs.writeFileSync(plain, JSON.stringify(ENV.library));
  const r = runSaver(f, plain, ['--provenance', 'hook-capture']); assert.equal(r.status, 1); assert.match(r.stderr, /unexpected staged file name|not in the skill's private staging directory/);
  const tr = path.join(f.home, 'tr.json'); fs.writeFileSync(tr, JSON.stringify(response(ENV.library)));
  const r2 = runSaver(f, tr, ['--provenance', 'hook-capture']); assert.equal(r2.status, 1); assert.match(r2.stderr, /unexpected staged file name/);
  const r3 = spawnSync(process.execPath, [saver, '-', '--dest', f.dest, '--settings', f.settings, '--account', 'scratch', '--access-scope', 'signed-in', '--provenance', 'hook-capture'], {input: JSON.stringify(ENV.library), encoding: 'utf8'}); assert.equal(r3.status, 1); assert.match(r3.stderr, /needs the staged file path/);
  assert.ok(!fs.existsSync(path.join(f.dest, 'library.json')));
}
{ // Revoking consent after staging blocks the save, and the saver does not remove the staged pair on failure.
  const f = fixture(); handleHook(payload('library', ENV.library), f.opts); const file = path.join(f.dest, STAGING_DIR, f.staged().find(n => !n.endsWith('.meta.json')));
  fs.writeFileSync(f.settings, JSON.stringify({version: 1, persistence: {profileAndFeedback: false, steamCache: false}}));
  const r = runSaver(f, file, ['--provenance', 'hook-capture']); assert.equal(r.status, 1); assert.match(r.stderr, /steamCache false/); assert.equal(f.staged().length, 2);
}
{ // A failed check inside the saver (here a wrong source digest) also keeps the pair and writes no cache file.
  const f = fixture(); handleHook(payload('library', ENV.library), f.opts); const file = path.join(f.dest, STAGING_DIR, f.staged().find(n => !n.endsWith('.meta.json')));
  const r = runSaver(f, file, ['--provenance', 'hook-capture', '--source-sha256', '0'.repeat(64)]); assert.equal(r.status, 1); assert.match(r.stderr, /does not match --source-sha256/); assert.equal(f.staged().length, 2); assert.ok(!fs.existsSync(path.join(f.dest, 'library.json')));
}

{ // Acceptance-style split: staged under the default cache location, saved into another (scratch) cache that has its own consent record.
  const f = fixture(); handleHook(payload('reviews', ENV.reviews), f.opts);
  const file = path.join(f.dest, STAGING_DIR, f.staged().find(n => !n.endsWith('.meta.json')));
  const scratch = fixture(); // a second, independent Curator Home
  const r = spawnSync(process.execPath, [saver, file, '--dest', scratch.dest, '--settings', scratch.settings, '--account', 'scratch', '--access-scope', 'signed-in', '--provenance', 'hook-capture'], {encoding: 'utf8', env: {...process.env, HOME: f.home}});
  assert.equal(r.status, 0, r.stderr); assert.ok(fs.existsSync(path.join(scratch.dest, 'reviews.json'))); assert.deepEqual(f.staged(), []);
  const other = fixture(), r2 = spawnSync(process.execPath, [saver, file, '--dest', other.dest, '--settings', other.settings, '--account', 'scratch', '--access-scope', 'signed-in', '--provenance', 'hook-capture'], {encoding: 'utf8', env: {...process.env, HOME: other.home}});
  assert.equal(r2.status, 1); // the staged pair is gone, and a staging directory that is not the skill's is never trusted
}

// 9. The hook as the runtime runs it: a process reading the payload on stdin, answering with additionalContext, never failing the tool call.
{
  const f = fixture(), run = input => spawnSync(process.execPath, [path.join(root, 'capture-hook.mjs')], {input, encoding: 'utf8', env: {...process.env, HOME: f.home}});
  const ok = run(JSON.stringify(payload('replay', ENV.replay))); assert.equal(ok.status, 0, ok.stderr); const out = JSON.parse(ok.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse'); assert.match(out.hookSpecificOutput.additionalContext, /staged the complete replay result/); assert.equal(f.staged().length, 2);
  const un = run(JSON.stringify(payload('replay', ENV.replay, {tool_input: {text: 'document.title'}}))); assert.equal(un.status, 0); assert.equal(un.stdout, '');
  const junk = run('not json at all'); assert.equal(junk.status, 0); assert.equal(junk.stdout, ''); assert.match(junk.stderr, /Game Curator hook error/);
  const f2 = fixture(); f2.home && fs.writeFileSync(f2.settings, '{}');
  const denied = spawnSync(process.execPath, [path.join(root, 'capture-hook.mjs')], {input: JSON.stringify(payload('replay', ENV.replay)), encoding: 'utf8', env: {...process.env, HOME: f2.home}});
  assert.equal(denied.status, 0); assert.match(JSON.parse(denied.stdout).hookSpecificOutput.additionalContext, /cache not authorized/); assert.deepEqual(f2.staged(), []);
}
// 10. The hook ships in SKILL.md's own frontmatter, narrowly matched, pointing at the shipped script; nothing in the repo asks users to edit settings.
{
  const skill = fs.readFileSync(new URL('../../skills/game-curator/SKILL.md', import.meta.url), 'utf8'), front = skill.match(/^---\n([\s\S]*?)\n---\n/)[1];
  assert.match(front, /^hooks:\n  PostToolUse:\n/m); assert.equal((front.match(/^\s+- matcher:/gm) ?? []).length, 1, 'exactly one matcher');
  assert.equal(front.match(/matcher: "([^"]+)"/)[1], HOOK_TOOLS.join('|'), 'only the two javascript_tool names');
  const block = front.match(/command: \|\n((?:            .*\n?)+)/)[1].replace(/^ {12}/gm, '');
  assert.match(block, /capture-hook\.mjs/); assert.ok(fs.existsSync(path.join(root, 'capture-hook.mjs')));
  // The runtime does not set CLAUDE_SKILL_DIR for skill hooks (measured); the command must find the installed skill by itself.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-hook-home-')), dir = path.join(home, '.curator/game-curator'), dest = path.join(dir, 'cache/steam');
  fs.mkdirSync(dest, {recursive: true}); fs.mkdirSync(path.join(home, '.claude/skills'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({version: 1, persistence: {profileAndFeedback: false, steamCache: true}}));
  fs.symlinkSync(path.join(root, '..', '..'), path.join(home, '.claude/skills/game-curator'));
  const viaShell = (input, env = {}) => spawnSync('sh', ['-c', block], {input, encoding: 'utf8', env: {PATH: process.env.PATH, HOME: home, ...env}});
  const ran = viaShell(JSON.stringify(payload('reviews', ENV.reviews)));
  assert.equal(ran.status, 0, ran.stderr); assert.match(JSON.parse(ran.stdout).hookSpecificOutput.additionalContext, /staged the complete reviews result/);
  assert.equal(fs.readdirSync(path.join(dest, STAGING_DIR)).length, 2);
  const none = viaShell(JSON.stringify(payload('reviews', ENV.reviews)), {HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'gc-hook-nohome-'))}); // skill not installed there: silent success, nothing runs
  assert.equal(none.status, 0); assert.equal(none.stdout, '');
  assert.equal((front.match(/^\s+- type:/gm) ?? []).length, 1); assert.ok(!/PreToolUse|Stop|SessionStart|UserPromptSubmit/.test(front), 'no other events');
}
// 11. Review follow-up. (a) The options literal is parsed, never evaluated: a repeated key, an unknown key, code or a non-exec action never opts in.
{
  assert.deepEqual(parseOptions("({deliver: 'hook'})"), {deliver: 'hook'}); assert.deepEqual(parseOptions('({deliver: "hook", maxYears: 3, fresh: true,})'), {deliver: 'hook', maxYears: 3, fresh: true}); assert.deepEqual(parseOptions('({})'), {});
  for (const bad of ["({deliver: 'download', deliver: 'hook'})", "({deliver: 'hook', deliver: 'return'})", "({deliver: 'hook', deliver: 'hook'})", "({deliver: 'hook', surprise: 1})", "({deliver: 'hook', maxMs: 1 + 1})", "({deliver: ('hook')})",
    "({deliver: `hook`})", "({['deliver']: 'hook'})", "({...x, deliver: 'hook'})", "({deliver: 'Hook'})", "({deliver: 'hook'}, 1)", "({deliver: 'hook'}).x", "({deliver: 'hook' deliver: 'hook'})", "({deliver 'hook'})", '(1)', 'x', undefined, 7]) assert.equal(parseOptions(bad), null, String(bad));
  for (const s of Object.keys(PAGES)) {
    assert.equal(identifyCall(call(s, "({deliver: 'download', deliver: 'hook'})"), root), null, 'a repeated deliver key is not an opt-in'); assert.equal(identifyCall(call(s, "({deliver: 'hook', deliver: 'return'})"), root), null);
    assert.equal(identifyCall(call(s, "({deliver: 'hook', unknownOption: 1})"), root), null);
    assert.equal(identify({action: 'javascript_exec', text: call(s)}, root).optIn, true); assert.equal(identify({action: 'other', text: call(s)}, root), null); assert.equal(identify({text: call(s)}, root), null); assert.equal(identify({action: 'javascript_exec'}, root), null);
    assert.equal(identify({action: 'javascript_exec', text: `await window.__gc${s[0].toUpperCase() + s.slice(1)}Run({deliver: 'hook', deliver: 'hook'})`}, root), null);
  }
  const f = fixture();
  assert.equal(handleHook(payload('replay', ENV.replay, {tool_input: {action: 'other', text: call('replay')}}), f.opts), null); assert.equal(handleHook(payload('replay', ENV.replay, {tool_input: {text: call('replay')}}), f.opts), null);
  assert.deepEqual(f.staged(), [], 'nothing is staged without javascript_exec');
  assert.match(handleHook(payload('replay', ENV.replay, {tool_input: {action: 'javascript_exec', text: "await window.__gcReplayRun({deliver: 'download', deliver: 'hook'})"}}), f.opts), /not a recognized, unambiguous collector run/);
  assert.deepEqual(f.staged(), []);
}
// (b) The saver reads the staged file once and uses exactly the verified bytes: the path is never reread, and the pair is removed only if it is still the verified pair.
{
  const mk = () => { const f = fixture(); handleHook(payload('library', ENV.library), f.opts); const file = path.join(f.dest, STAGING_DIR, f.staged().find(n => !n.endsWith('.meta.json'))); return {f, file}; };
  { const {f, file} = mk(), v = readVerifiedStaging(file, f.dest), original = Buffer.from(v.bytes);
    const tampered = JSON.parse(original.toString('utf8')); tampered.warnings = ['changed after verification'];
    fs.rmSync(file); fs.writeFileSync(file, JSON.stringify(tampered), {mode: 0o600}); // same path, new file, after the verified read
    assert.deepEqual(v.bytes, original, 'the verified bytes do not change when the path does'); assert.equal(removeIfUnchanged(v.identity), false, 'a replaced file is not removed');
    assert.ok(fs.existsSync(file) && fs.existsSync(file + '.meta.json'), 'both files are left in place'); }
  { const {f, file} = mk(), v = readVerifiedStaging(file, f.dest);
    fs.appendFileSync(file, ' '); // same file, modified in place after the verified read
    assert.equal(removeIfUnchanged(v.identity), false); assert.ok(fs.existsSync(file) && fs.existsSync(file + '.meta.json')); }
  { const {f, file} = mk(), v = readVerifiedStaging(file, f.dest);
    fs.rmSync(file + '.meta.json'); fs.writeFileSync(file + '.meta.json', '{}', {mode: 0o600}); // the sidecar was replaced
    assert.equal(removeIfUnchanged(v.identity), false); assert.ok(fs.existsSync(file)); }
  { const {f, file} = mk(), v = readVerifiedStaging(file, f.dest); assert.equal(removeIfUnchanged(v.identity), true, 'the untouched verified pair is removed'); assert.deepEqual(f.staged(), []); }
  { const {f, file} = mk(); const link = path.join(f.dest, STAGING_DIR, 'gc-library-20200101T000000Z-cafef00d.json');
    fs.symlinkSync(file, link); fs.symlinkSync(file + '.meta.json', link + '.meta.json'); assert.throws(() => readVerifiedStaging(link, f.dest), /cannot open/, 'links are never followed'); }
  { // nothing arbitrary is read before the location is verified: a path outside the staging directory or with another name fails without being opened
    const f = fixture(), outside = path.join(f.home, 'gc-library-20200101T000000Z-cafef00d.json'); fs.writeFileSync(outside, 'secret', {mode: 0o600});
    assert.throws(() => readVerifiedStaging(outside, f.dest), /not in the skill's private staging directory/); assert.throws(() => readVerifiedStaging(path.join(f.home, 'secret.txt'), f.dest), /unexpected staged file name/);
    assert.throws(() => readVerifiedStaging(path.join(f.dest, STAGING_DIR, 'gc-library-20200101T000000Z-cafef00d.json'), f.dest), /does not exist|cannot open/); }
}
// (c) Consent over the source: a staged file in the default home may not be consumed into another, separately authorized destination once the default home's steamCache is revoked.
{
  const f = fixture(); handleHook(payload('reviews', ENV.reviews), f.opts); const file = path.join(f.dest, STAGING_DIR, f.staged().find(n => !n.endsWith('.meta.json')));
  const scratch = fixture(), saveInto = (extra = []) => spawnSync(process.execPath, [saver, file, '--dest', scratch.dest, '--settings', scratch.settings, '--account', 'scratch', '--access-scope', 'signed-in', '--provenance', 'hook-capture', ...extra], {encoding: 'utf8', env: {...process.env, HOME: f.home}});
  fs.writeFileSync(f.settings, JSON.stringify({version: 1, persistence: {profileAndFeedback: false, steamCache: false}})); // the default home revokes
  const r = saveInto(); assert.equal(r.status, 1); assert.match(r.stderr, /steamCache false/); assert.equal(f.staged().length, 2, 'the staged pair stays'); assert.ok(!fs.existsSync(path.join(scratch.dest, 'reviews.json')), 'nothing was written to the scratch cache');
  assert.equal(saveInto(['--dry-run']).status, 1, 'a dry run is refused too');
  fs.rmSync(f.settings); const r2 = saveInto(); assert.equal(r2.status, 1); assert.match(r2.stderr, /Cache not authorized/); assert.ok(!fs.existsSync(path.join(scratch.dest, 'reviews.json')));
  fs.writeFileSync(f.settings, JSON.stringify({version: 1, persistence: {profileAndFeedback: false, steamCache: true}})); // consent restored: the same file now saves
  const ok = saveInto(); assert.equal(ok.status, 0, ok.stderr); assert.ok(fs.existsSync(path.join(scratch.dest, 'reviews.json'))); assert.deepEqual(f.staged(), []);
  // and the destination's own consent still governs: a destination that declines receives nothing
  const f2 = fixture(); handleHook(payload('library', ENV.library), f2.opts); const file2 = path.join(f2.dest, STAGING_DIR, f2.staged().find(n => !n.endsWith('.meta.json')));
  const declined = fixture(); fs.writeFileSync(declined.settings, JSON.stringify({version: 1, persistence: {profileAndFeedback: false, steamCache: false}}));
  const r3 = spawnSync(process.execPath, [saver, file2, '--dest', declined.dest, '--settings', declined.settings, '--account', 'scratch', '--access-scope', 'signed-in', '--provenance', 'hook-capture'], {encoding: 'utf8', env: {...process.env, HOME: f2.home}});
  assert.equal(r3.status, 1); assert.match(r3.stderr, /steamCache false/); assert.equal(f2.staged().length, 2); assert.ok(!fs.existsSync(path.join(declined.dest, 'library.json')));
}
// (d) The hook locator runs the script of the installation it finds, and a mismatched installation fails safely: a copy whose shipped script differs from the one the model ran stages nothing.
{
  const skill = fs.readFileSync(new URL('../../skills/game-curator/SKILL.md', import.meta.url), 'utf8').match(/^---\n([\s\S]*?)\n---\n/)[1], block = skill.match(/command: \|\n((?:            .*\n?)+)/)[1].replace(/^ {12}/gm, '');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-hook-mismatch-')), dir = path.join(home, '.curator/game-curator'), dest = path.join(dir, 'cache/steam');
  fs.mkdirSync(dest, {recursive: true}); fs.mkdirSync(path.join(home, '.claude/skills'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({version: 1, persistence: {profileAndFeedback: false, steamCache: true}}));
  const copy = path.join(home, '.claude/skills/game-curator'); fs.cpSync(path.join(root, '..', '..'), copy, {recursive: true});
  fs.appendFileSync(path.join(copy, 'scripts/claude-code/steam-replay-page.js'), '// an older or newer release of the script\n'); // the installed copy is a different release than the model's script
  const run = (input, env = {}) => spawnSync('sh', ['-c', block], {input, encoding: 'utf8', env: {PATH: process.env.PATH, HOME: home, ...env}});
  const r = run(JSON.stringify(payload('replay', ENV.replay))); assert.equal(r.status, 0); assert.equal(r.stdout, ''); assert.ok(!fs.existsSync(path.join(dest, STAGING_DIR)), 'a mismatched installation stages nothing');
  assert.equal(run(JSON.stringify(payload('reviews', ENV.reviews))).status, 0); assert.equal(fs.readdirSync(path.join(dest, STAGING_DIR)).length, 2, 'a source whose script still matches is staged');
  const unsupported = run(JSON.stringify(payload('reviews', ENV.reviews)), {HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'gc-hook-elsewhere-'))}); assert.equal(unsupported.status, 0); assert.equal(unsupported.stdout, '', 'an undocumented install layout is a silent no-op');
}

console.log('Claude Code hook capture checks passed');
