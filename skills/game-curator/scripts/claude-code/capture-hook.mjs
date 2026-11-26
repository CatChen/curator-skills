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
//   2. the call's own text is a shipped collector run (this skill's generated page script, byte for byte, followed
//      by a plain options literal) or a resume call of one, AND that literal says deliver: 'hook' (the caller's
//      per-run opt-in, made after considering the user's current instructions);
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
import {canonicalize, validate, checkCacheAuthorized, HOOK_TOOLS, STAGING_DIR} from './save-capture.mjs';

export const MAX_STAGED_BYTES = 16 * 1024 * 1024;
export const STAGED_MAX_AGE_MS = 24 * 3600 * 1000;
const PAGES = {wishlist: 'steam-wishlist-page.js', library: 'steam-library-page.js', reviews: 'steam-reviews-page.js', replay: 'steam-replay-page.js'};
const RESUME = {__gcWishlistRun: 'wishlist', __gcLibraryRun: 'library', __gcReviewsRun: 'reviews', __gcReplayRun: 'replay'};
const OPTIONS = /^\(\{(?:\s*[A-Za-z]+:\s*(?:'[a-z]*'|"[a-z]*"|\d+|true|false)\s*,?)*\s*\}\)$/;
const OPT_IN = /\bdeliver:\s*(['"])hook\1/;
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const here = path.dirname(fileURLToPath(import.meta.url));

// Which collector run is this call? Returns {source, call: 'run'|'resume', scriptSha256, optIn} or null.
export function identifyCall(text, dir = here) {
  if (typeof text !== 'string') return null;
  const t = text.replace(/\s+$/, '');
  const resume = t.match(/^await window\.(__gc[A-Za-z]+Run)\((\{[^()]*\})\)$/);
  if (resume && RESUME[resume[1]] && OPTIONS.test(`(${resume[2]})`)) return {source: RESUME[resume[1]], call: 'resume', scriptSha256: null, optIn: OPT_IN.test(resume[2])};
  for (const [source, file] of Object.entries(PAGES)) {
    let body; try { body = fs.readFileSync(path.join(dir, file), 'utf8'); } catch { continue; }
    const tail = body.match(/\(\{\}\)\s*$/);
    if (!tail) continue;
    const prefix = body.slice(0, tail.index);
    if (!t.startsWith(prefix)) continue;
    const literal = t.slice(prefix.length);
    if (!OPTIONS.test(literal)) return null; // not a plain options literal: not this skill's run
    return {source, call: 'run', scriptSha256: sha256(body), optIn: OPT_IN.test(literal)};
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
export function handleHook(payload, {dest = path.join(os.homedir(), '.curator/game-curator/cache/steam'), settings, skillDir = here, now = Date.now()} = {}) {
  if (!payload || payload.hook_event_name !== 'PostToolUse' || !HOOK_TOOLS.includes(payload.tool_name)) return null;
  const call = identifyCall(payload.tool_input?.text, skillDir);
  if (!call) {
    const t = payload.tool_input?.text;
    return typeof t === 'string' && t.length < 400 && /__gc[A-Za-z]+Run/.test(t) && OPT_IN.test(t) ? 'Game Curator hook: this call is not a recognized collector run, so nothing was staged.' : null;
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
    + `node ${saver} ${file} --provenance hook-capture --account <alias> --access-scope <scope> [--view unfiltered] --dry-run, then without --dry-run; the saver removes the staged pair after a successful save. Do not retype the data.`;
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
