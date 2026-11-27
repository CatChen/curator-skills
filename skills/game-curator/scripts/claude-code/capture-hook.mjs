#!/usr/bin/env node
// PostToolUse hook shipped in the skill's SKILL.md frontmatter (active only while the skill is). It moves the FINAL
// envelope of an intended Game Curator collector run from the browser tool's inline result into a private staging
// file, so a save needs no download dialog and no model transcription. Node built-ins only; no network.
//
// What it is: it receives the tool response AFTER the runtime has processed it (the same text blocks the model sees,
// including any runtime filtering or truncation). It cannot see raw page data, it does not reduce what the model
// receives, and it cannot recover anything the runtime redacted: such a response is rejected, never reconstructed.
//
// What it stages. All of these must hold, otherwise it stays silent and writes nothing:
//   1. the tool is the built-in browser's or Claude in Chrome's javascript_tool;
//   2. the call is a javascript_exec whose text is a shipped collector run (this skill's generated page script, byte for byte,
//      followed by a plain options literal) or a resume call of one, AND that literal sets deliver exactly once, to 'hook' (the
//      caller's per-run opt-in, made after considering the user's current instructions); the literal is parsed, never evaluated,
//      and a repeated or unknown key makes the call unrecognized;
//   3. the response is one complete game-curator-steam-export v1 envelope of the same source that passes the saver's
//      validation (intermediate results and summaries are ignored);
//   4. persistence is authorized right now (settings.json, steamCache true), checked by the saver's own function.
// A page-provided envelope marker alone authorizes nothing: it is the shipped script plus the opt-in literal.
// Files: <cache/steam>/.staging/ (0700), gc-<source>-<time>-<digest>.json plus a .meta.json sidecar, both 0600 and
// created exclusively. Files older than 24 h from earlier captures are removed. save-capture.mjs verifies the
// sidecar (--provenance hook-capture), saves, and removes the staged pair after a successful save.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolveCuratorHome} from '../curator-home.mjs';
import {canonicalize, validate, checkCacheAuthorized, HOOK_TOOLS, STAGING_DIR} from './save-capture.mjs';

export const MAX_STAGED_BYTES = 16 * 1024 * 1024;
export const STAGED_MAX_AGE_MS = 24 * 3600 * 1000;
const PAGES = {wishlist: 'steam-wishlist-page.js', library: 'steam-library-page.js', reviews: 'steam-reviews-page.js', replay: 'steam-replay-page.js'};
const RESUME = {__gcWishlistRun: 'wishlist', __gcLibraryRun: 'library', __gcReviewsRun: 'reviews', __gcReplayRun: 'replay'};
const OPTION_KEYS = new Set(['callBudgetMs', 'maxMs', 'maxSteps', 'fresh', 'cancel', 'deliver', 'retainMs', 'maxYears', 'maxPages', 'quietMs', 'stallMs', 'settleMs', 'settleCapMs', 'identity']);
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const here = path.dirname(fileURLToPath(import.meta.url));

// Parse the restricted options literal `({key: value, ...})` WITHOUT evaluating anything: known keys only, values are a short lowercase
// string, an integer, true or false, and a repeated key makes the whole literal invalid (so an ambiguous `deliver` never opts in).
// The one nested shape is `identity: {salt: '<22 base64url characters>'}`; any other object, key, salt shape or repetition is invalid.
export function parseOptions(literal) {
  const m = typeof literal === 'string' && literal.match(/^\(\{([^()]*)\}\)$/);
  if (!m) return null;
  const out = {};
  let rest = m[1];
  const item = /^\s*([A-Za-z]+)\s*:\s*('[a-z]*'|"[a-z]*"|\d+|true|false|\{\s*salt\s*:\s*(?:'([A-Za-z0-9_-]{22})'|"([A-Za-z0-9_-]{22})")\s*\})\s*(?:,|$)/;
  while (rest.trim() !== '') {
    const t = item.exec(rest);
    if (!t || !OPTION_KEYS.has(t[1]) || Object.hasOwn(out, t[1])) return null;
    const v = t[2];
    if (v.startsWith('{')) { if (t[1] !== 'identity') return null; out.identity = {salt: t[3] ?? t[4]}; rest = rest.slice(t[0].length); continue; }
    if (t[1] === 'identity') return null;
    out[t[1]] = v === 'true' ? true : v === 'false' ? false : /^\d/.test(v) ? Number(v) : v.slice(1, -1);
    rest = rest.slice(t[0].length);
  }
  return out;
}

// Which collector run is this call? Returns {source, call: 'run'|'resume', scriptSha256, optIn} or null. optIn is true only when the
// options literal sets deliver exactly once, to 'hook'; the tool call must also be a plain javascript_exec.
export function identifyCall(input, dir = here) {
  if (!input || input.action !== 'javascript_exec' || typeof input.text !== 'string') return null;
  const t = input.text.replace(/\s+$/, '');
  const resume = t.match(/^await window\.(__gc[A-Za-z]+Run)(\(\{[^()]*\}\))$/);
  if (resume && RESUME[resume[1]]) { const o = parseOptions(resume[2]); return o ? {source: RESUME[resume[1]], call: 'resume', scriptSha256: null, optIn: o.deliver === 'hook'} : null; }
  for (const [source, file] of Object.entries(PAGES)) {
    let body; try { body = fs.readFileSync(path.join(dir, file), 'utf8'); } catch { continue; }
    const tail = body.match(/\(\{\}\)\s*$/);
    if (!tail) continue;
    const prefix = body.slice(0, tail.index);
    if (!t.startsWith(prefix)) continue;
    const o = parseOptions(t.slice(prefix.length)); // not a plain, unambiguous options literal: not this skill's run
    return o ? {source, call: 'run', scriptSha256: sha256(body), optIn: o.deliver === 'hook'} : null;
  }
  return null;
}

// Read the inline result. {kind:'ignore'} for anything that is not an attempt at an envelope; {kind:'reject', reason}
// for an envelope-shaped result that must not be staged; {kind:'envelope', text, env} otherwise.
export function readInlineEnvelope(response) {
  if (!Array.isArray(response) || !response.length || !response.every(b => b && b.type === 'text' && typeof b.text === 'string')) return {kind: 'ignore'};
  const first = response[0].text;
  if (/\[BLOCKED[^\]]*\]|\[TRUNCATED\]/.test(first)) return {kind: 'reject', reason: 'the runtime redacted or truncated the result'};
  const text = first.replace(/\n\n\(captured at origin [^\n)]*\)\s*$/, '');
  let value;
  try { value = JSON.parse(text); } catch { return /^\s*[{[]/.test(text) ? {kind: 'reject', reason: 'the result is not complete JSON (truncated or malformed)'} : {kind: 'ignore'}; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.format !== 'game-curator-steam-export') return {kind: 'ignore'};
  return {kind: 'envelope', text, env: value};
}

function privateDir(dir) {
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('staging path is not a plain directory');
  if (st.uid !== process.getuid()) throw new Error('staging directory is not owned by the current user');
  if (st.mode & 0o077) fs.chmodSync(dir, 0o700);
  return dir;
}

function writeExclusive(file, bytes) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function prune(dir, now) {
  for (const name of fs.readdirSync(dir)) {
    if (!/^gc-[a-z]+-\d{8}T\d{6}Z-[0-9a-f]{8}\.json(\.meta\.json)?$/.test(name)) continue;
    const f = path.join(dir, name), st = fs.lstatSync(f);
    if (st.isFile() && now - st.mtimeMs > STAGED_MAX_AGE_MS) fs.rmSync(f, {force: true});
  }
}

// Decide and act on one hook payload. Returns the additionalContext text to show the model, or null to stay silent.
export function handleHook(payload, {dest, settings, skillDir = here, now = Date.now(), processEnv = process.env, homedir = os.homedir()} = {}) {
  if (!payload || payload.hook_event_name !== 'PostToolUse' || !HOOK_TOOLS.includes(payload.tool_name)) return null;
  const call = identifyCall(payload.tool_input, skillDir);
  if (!call) {
    const t = payload.tool_input?.text;
    return typeof t === 'string' && t.length < 400 && /__gc[A-Za-z]+Run/.test(t) && /\bdeliver\b/.test(t) ? 'Game Curator hook: this call is not a recognized, unambiguous collector run, so nothing was staged.' : null;
  }
  if (!call.optIn) return null; // the caller did not ask for hook delivery on this call
  const got = readInlineEnvelope(payload.tool_response);
  if (got.kind === 'ignore') return null;
  const refuse = why => `Game Curator hook: nothing was staged (${why}). Do not reconstruct the data; use the native tool-result file for a large result, or tell the user what is missing.`;
  if (got.kind === 'reject') return refuse(got.reason);
  const bytes = Buffer.from(got.text, 'utf8');
  if (bytes.length > MAX_STAGED_BYTES) return refuse('the result is larger than the staging limit');
  let env;
  try { env = canonicalize(got.env); } catch (e) { return refuse(`the envelope could not be read: ${e.message}`); }
  if (env.source !== call.source) return refuse(`the result is a ${env.source} envelope but the call was a ${call.source} run`);
  const {errors} = validate(env, {incoming: true, accessScope: 'unknown'}) // identity and scope are the saver's caller attestations, not the hook's;
  if (errors.length) return refuse(`it failed validation: ${errors.slice(0, 3).join('; ')}`);
  // The Curator Home is resolved HERE, from the process environment only (default home, or CURATOR_HOME as Claude Code's `env` setting provides it to hooks):
  // never from the page or the envelope, and a selected home that is unusable stops the hook instead of falling back to the default.
  if (dest === undefined) { try { dest = resolveCuratorHome({env: processEnv, homedir}).cache; } catch (e) { return refuse(String(e.message ?? e)); } }
  try { checkCacheAuthorized(dest, settings); } catch (e) { return refuse(String(e.message ?? e).replace(/^Cache not authorized: /, 'cache not authorized: ')); }
  const dir = privateDir(path.join(dest, STAGING_DIR));
  prune(dir, now);
  const digest = sha256(bytes), stamp = env.capturedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'), name = `gc-${env.source}-${stamp}-${digest.slice(0, 8)}.json`, file = path.join(dir, name);
  const meta = {version: 1, kind: 'game-curator-hook-capture', source: env.source, capturedAt: env.capturedAt, tool: payload.tool_name, toolUseId: String(payload.tool_use_id ?? ''), call: call.call,
    deliver: 'hook', scriptSha256: call.scriptSha256, bytes: bytes.length, sha256: digest, stagedAt: new Date(now).toISOString()};
  try { writeExclusive(file, bytes); } catch (e) { if (e.code !== 'EEXIST') throw e; if (sha256(fs.readFileSync(file)) !== digest) return refuse('a different staged file already has this name'); }
  try { writeExclusive(file + '.meta.json', JSON.stringify(meta, null, 1) + '\n'); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const saver = path.join(skillDir, 'save-capture.mjs');
  return `Game Curator hook: staged the complete ${env.source} result (${env.records.length} records, ${bytes.length} bytes, sha256 ${digest.slice(0, 16)}...) privately at ${file}. `
    + `Provenance is hook-capture: the runtime-processed tool response as the hook received it, not a native tool-result file and not a browser download. Validate and save it with `
    + `node ${saver} ${file} --provenance hook-capture [--view unfiltered] --dry-run (the selected Curator Home needs no --dest/--settings; read curatorHome and destination in the output; add --account <alias> --access-scope <scope> only as the manual fallback when no account is bound or identity was unobservable), then without --dry-run; the saver removes the staged pair after a successful save. Do not retype the data.`;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const c of process.stdin) raw += c;
  try {
    const context = handleHook(JSON.parse(raw));
    if (context) process.stdout.write(JSON.stringify({hookSpecificOutput: {hookEventName: 'PostToolUse', additionalContext: context}}) + '\n');
  } catch (e) { process.stderr.write(`Game Curator hook error: ${String(e.message ?? e)}\n`); }
  process.exitCode = 0;
}
