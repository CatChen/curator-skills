#!/usr/bin/env node
// Validate a Steam wishlist envelope produced by steam-wishlist-page.js and save it into the authorized
// Curator Home cache without passing the data through model context. Node built-ins only.
//
//   node save-capture.mjs <file | -> --account <alias> --access-scope signed-in|public|unknown
//        [--dest <cache/steam dir>] [--settings <settings.json>] [--view unfiltered]
//        [--existing-account <alias>] [--existing-view unfiltered] [--keep-separate] [--dry-run]
//
// Input is the file Claude Code writes when a javascript_tool result is too large (a JSON array of
// {type,text}), a plain JSON envelope file, or "-" for stdin (for example `pbpaste`-style piping by the user;
// the model must not retype data into it).
//
// Cache policy (persistence.md "Freshness, refresh and safe replacement"). Nothing is merged and nothing is
// deleted. A capture becomes wishlist.json only when no file exists, or every comparability check below passes:
// same verified account and scope, newer, same coverage, both captures known to be in the default sort with
// no filters, no retained AppID losing a labeled field, and the existing file unchanged since the decision.
// Everything else is kept beside it as wishlist.partial.<timestamp>.json. A legitimately smaller unfiltered
// wishlist replaces; the previous file is first preserved as wishlist.superseded.<timestamp>.json.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const MAX_BACKUPS = 5; // bounded retention: at the limit new captures are kept separately; nothing is auto-deleted
const ENVELOPE_ORDER = ['format', 'version', 'source', 'capturedAt', 'method', 'coverage', 'warnings', 'diagnostics', 'account', 'accessScope', 'records'];
const RECORD_ORDER = ['appid', 'rank', 'name', 'pageText', 'membershipSource'];
const TRANSPORT_KEYS = ['transportPadding']; // added by forceFileTransfer only; not data
const DEFAULT_SORT = 'Your Rank';
// Field groups whose availability is compared per retained AppID. Review labels vary by game (English vs overall).
const FIELD_GROUPS = {releaseDate: /RELEASE DATE:/, reviews: /(ENGLISH|OVERALL) REVIEWS:/, userTags: /USER TAGS:/, myCategories: /MY CATEGORIES:/};

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const stamp = iso => iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const isIso = s => typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(s) && Number.isFinite(Date.parse(s));

// Parse the harness file: [{type,text}] whose text is JSON followed by "(captured at origin ...)", or plain JSON.
export function parseToolResult(raw) {
  let value = JSON.parse(raw);
  if (Array.isArray(value)) value = value.filter(p => p?.type === 'text').map(p => p.text).join('');
  if (typeof value !== 'string') return value;
  const end = value.search(/\n\n\(captured at origin /);
  return JSON.parse(end >= 0 ? value.slice(0, end) : value);
}

// Restore the collector's key order (the harness alphabetizes keys) without dropping anything: unknown fields
// are kept so validate() can reject them instead of silently stripping evidence.
export function canonicalize(env) {
  const {transportPadding: _pad, ...rest} = env;
  const known = ENVELOPE_ORDER.filter(k => k in rest), extra = Object.keys(rest).filter(k => !ENVELOPE_ORDER.includes(k));
  const out = {};
  for (const k of [...known, ...extra]) out[k] = k === 'records' && Array.isArray(rest.records)
    ? rest.records.map(r => r && typeof r === 'object' ? {...Object.fromEntries(RECORD_ORDER.filter(f => f in r).map(f => [f, r[f]])), ...Object.fromEntries(Object.entries(r).filter(([f]) => !RECORD_ORDER.includes(f)))} : r)
    : rest[k];
  return out;
}

// Contract validation. `errors` mean the input is not a valid v1 wishlist envelope (nothing is saved).
// `incomplete` reasons mean it is valid but not a full wishlist: it is preserved as a partial snapshot, never promoted.
export function validate(env, {account, accessScope} = {}) {
  const errors = [], incomplete = [];
  const known = new Set(ENVELOPE_ORDER);
  if (!env || typeof env !== 'object' || Array.isArray(env)) return {errors: ['not an object'], incomplete};
  for (const k of Object.keys(env)) if (!known.has(k) && !TRANSPORT_KEYS.includes(k)) errors.push(`unexpected envelope field: ${k}`);
  if (env.format !== 'game-curator-steam-export' || env.version !== 1) errors.push('unsupported format/version');
  if (env.source !== 'wishlist') errors.push('source is not wishlist');
  if (typeof env.method !== 'string' || !env.method) errors.push('missing method');
  if (!isIso(env.capturedAt)) errors.push('invalid capturedAt timestamp');
  if (!['partial', 'complete'].includes(env.coverage)) errors.push('invalid coverage');
  if (!Array.isArray(env.warnings) || !env.warnings.every(w => typeof w === 'string')) errors.push('warnings must be an array of strings');
  const d = env.diagnostics;
  if (!d || typeof d !== 'object' || Array.isArray(d)) errors.push('missing diagnostics');
  const recs = Array.isArray(env.records) ? env.records : (errors.push('records must be an array'), []);
  const allowed = new Set(RECORD_ORDER), ids = new Set(), ranks = new Set();
  recs.forEach((r, i) => {
    if (!r || typeof r !== 'object') return errors.push(`record ${i} is not an object`);
    for (const k of Object.keys(r)) if (!allowed.has(k)) errors.push(`record ${i} has unexpected field ${k}`);
    if (!Number.isSafeInteger(r.appid) || r.appid <= 0) errors.push(`record ${i} has an invalid appid`);
    if (!Number.isSafeInteger(r.rank) || r.rank <= 0) errors.push(`record ${i} has an invalid rank`);
    if (typeof r.name !== 'string' || !r.name.trim()) errors.push(`record ${i} has an empty name`);
    if (typeof r.pageText !== 'string' || !r.pageText.trim()) errors.push(`record ${i} has empty pageText`);
    if (r.membershipSource !== 'wishlist-row') errors.push(`record ${i} has an unexpected membershipSource`);
    if (ids.has(r.appid)) errors.push(`duplicate appid ${r.appid}`); ids.add(r.appid);
    if (ranks.has(r.rank)) errors.push(`duplicate rank ${r.rank}`); ranks.add(r.rank);
  });
  if (!recs.every((r, i) => r?.rank === i + 1)) incomplete.push('ranks are not contiguous 1..n');
  if (d && typeof d === 'object') {
    if (d.uniqueCount !== recs.length) errors.push('diagnostics.uniqueCount disagrees with the records');
    if (d.ranksObserved !== recs.length) errors.push('diagnostics.ranksObserved disagrees with the records');
    if (!(d.expectedCount === null || Number.isSafeInteger(d.expectedCount))) errors.push('diagnostics.expectedCount is invalid');
    if (!Number.isSafeInteger(d.placeholderNameRows)) errors.push('missing diagnostics.placeholderNameRows');
    else if (d.placeholderNameRows > 0) incomplete.push(`${d.placeholderNameRows} placeholder-name rows`);
    if (typeof d.recordsSha256 !== 'string' || sha256(JSON.stringify(recs)) !== d.recordsSha256) errors.push('records checksum mismatch (page vs transferred)');
    if (d.expectedCount !== null && d.expectedCount !== recs.length) incomplete.push(`displayed ${d.expectedCount} items but ${recs.length} records`);
    if (d.complete !== true) incomplete.push(`collector reported an incomplete run (${d.stopReason ?? 'unknown reason'})`);
    if (d.view !== undefined && !(d.view && typeof d.view === 'object')) errors.push('diagnostics.view is invalid');
  }
  if (!recs.length) { // only a verified empty wishlist may have no records
    if (!(d?.stopReason === 'empty-verified' && d?.expectedCount === 0)) errors.push('no records and no verified-empty evidence');
  }
  if (account !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(account)) errors.push('unsafe account alias');
  if (!['signed-in', 'public', 'unknown'].includes(accessScope)) errors.push('invalid access scope');
  if (accessScope === 'signed-in' && d?.reorderHandles !== true) errors.push('signed-in scope claimed without owner-only evidence (reorder handles)');
  return {errors, incomplete};
}

// Is this a structurally valid wishlist envelope that can serve as the comparison baseline?
function validExisting(e) {
  return e && e.format === 'game-curator-steam-export' && e.version === 1 && e.source === 'wishlist' && isIso(e.capturedAt)
    && Array.isArray(e.records) && e.records.every(r => r && Number.isSafeInteger(r.appid) && typeof r.pageText === 'string' && typeof r.name === 'string');
}
const viewOf = e => e?.diagnostics?.view;
const unfiltered = v => v?.filters === 'none' && v?.sort === DEFAULT_SORT && v?.search === 'empty';

// Per retained AppID, a field that existed and is now absent counts as a loss. Returns {group: count}.
export function fieldLosses(existing, next) {
  const newer = new Map(next.records.map(r => [r.appid, r])), losses = {};
  for (const old of existing.records) {
    const now = newer.get(old.appid);
    if (!now) continue;
    for (const [group, re] of Object.entries(FIELD_GROUPS)) if (re.test(old.pageText) && !re.test(now.pageText)) losses[group] = (losses[group] ?? 0) + 1;
    if (old.name && !now.name) losses.name = (losses.name ?? 0) + 1;
  }
  return losses;
}

// Decide where the new capture goes. Returns {action:'create'|'replace'|'separate', reason, notes}.
export function decide(existing, next, {existingAccount, existingViewUnfiltered = false, keepSeparate = false, backupCount = 0, incomplete = []} = {}) {
  const notes = [];
  if (keepSeparate) return {action: 'separate', reason: 'user asked to keep this capture separate', notes};
  if (incomplete.length) return {action: 'separate', reason: `incomplete capture: ${incomplete.join('; ')}`, notes};
  if (!unfiltered(viewOf(next))) notes.push('filters/sort of this capture were not verified as default and unfiltered');
  if (!existing) return {action: 'create', reason: 'no existing wishlist.json', notes};
  if (!validExisting(existing)) return {action: 'separate', reason: 'existing file is not a valid wishlist envelope; preserved untouched', notes};
  if (!next.account || (existing.account ?? existingAccount) !== next.account) return {action: 'separate', reason: 'account identity differs or is unknown', notes};
  if (existing.accessScope !== next.accessScope) return {action: 'separate', reason: 'access scope differs', notes};
  if (existing.coverage !== next.coverage) return {action: 'separate', reason: 'coverage differs', notes};
  if (!(Date.parse(next.capturedAt) > Date.parse(existing.capturedAt))) return {action: 'separate', reason: 'new capture is not newer', notes};
  if (!unfiltered(viewOf(next))) return {action: 'separate', reason: 'new capture is not verified as default sort and unfiltered; a filtered list can omit wishlist members', notes};
  if (!(unfiltered(viewOf(existing)) || existingViewUnfiltered)) return {action: 'separate', reason: 'existing capture has no filter/sort evidence and the user has not confirmed it was unfiltered', notes};
  const losses = fieldLosses(existing, next);
  if (Object.keys(losses).length) return {action: 'separate', reason: `retained AppIDs lose fields: ${JSON.stringify(losses)}`, notes};
  if (backupCount >= MAX_BACKUPS) return {action: 'separate', reason: `${backupCount} superseded backups already exist (limit ${MAX_BACKUPS}); prune them to allow replacement`, notes};
  const now = new Set(next.records.map(r => r.appid)), before = new Set(existing.records.map(r => r.appid));
  notes.push(`membership: ${[...before].filter(a => !now.has(a)).length} removed, ${[...now].filter(a => !before.has(a)).length} added`);
  return {action: 'replace', reason: 'same verified account, scope and coverage; newer; both default-sort and unfiltered; no retained field lost', notes};
}

// Persistence consent: strict settings.json v1 (persistence.md "Durable scope record"). Fails closed.
export function checkCacheAuthorized(dest, settingsPath) {
  let file = settingsPath;
  if (!file) {
    if (path.basename(dest) !== 'steam' || path.basename(path.dirname(dest)) !== 'cache') throw new Error('Custom cache location: pass --settings <path to the user-controlled settings.json>');
    file = path.join(dest, '..', '..', 'settings.json');
  }
  let s;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`Cache not authorized: cannot read a valid ${file} (${e.code ?? e.message})`); }
  const ok = s && typeof s === 'object' && s.version === 1 && Object.keys(s).sort().join() === 'persistence,version'
    && s.persistence && typeof s.persistence === 'object' && Object.keys(s.persistence).sort().join() === 'profileAndFeedback,steamCache'
    && typeof s.persistence.profileAndFeedback === 'boolean' && typeof s.persistence.steamCache === 'boolean';
  if (!ok) throw new Error(`Cache not authorized: ${file} is not a valid version 1 settings record`);
  if (!s.persistence.steamCache) throw new Error('Cache not authorized: settings.json has steamCache false');
  return file;
}

const readIfExists = f => { try { return fs.readFileSync(f); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
function writeNew(file, text) { // exclusive creation, owner-only, read back
  fs.writeFileSync(file, text, {flag: 'wx', mode: 0o600});
  if (fs.readFileSync(file, 'utf8') !== text) throw new Error(`read-back mismatch for ${file}`);
}

export function save(env, destDir, {dryRun = false, incomplete = [], hooks = {}, ...policy} = {}) {
  const main = path.join(destDir, 'wishlist.json'), lock = path.join(destDir, '.wishlist.lock');
  const decisionBytes = readIfExists(main);
  let existing = null;
  if (decisionBytes) { try { existing = JSON.parse(decisionBytes.toString('utf8')); } catch { existing = {malformed: true}; } }
  const backups = fs.existsSync(destDir) ? fs.readdirSync(destDir).filter(f => /^wishlist\.superseded\..+\.json$/.test(f)) : [];
  let decision = decide(existing, env, {...policy, backupCount: backups.length, incomplete});
  const text = JSON.stringify(env, null, 2) + '\n', ts = stamp(env.capturedAt);
  const partial = path.join(destDir, `wishlist.partial.${ts}.json`);
  const result = {...decision, target: decision.action === 'separate' ? partial : main, backup: null, bytes: Buffer.byteLength(text), sha256: sha256(text)};
  if (dryRun) return result;

  fs.mkdirSync(destDir, {recursive: true, mode: 0o700});
  let lockHeld = false, tmp = null;
  try {
    fs.writeFileSync(lock, `${process.pid} ${new Date().toISOString()}\n`, {flag: 'wx', mode: 0o600}); lockHeld = true; // concurrent savers
    if (decision.action === 'replace') {
      const backup = path.join(destDir, `wishlist.superseded.${stamp(existing.capturedAt)}.json`);
      fs.copyFileSync(main, backup, fs.constants.COPYFILE_EXCL);
      if (sha256(fs.readFileSync(backup)) !== sha256(decisionBytes)) throw new Error('backup does not match the existing file');
      tmp = path.join(destDir, `.wishlist.${process.pid}.tmp`);
      writeNew(tmp, text);
      hooks.beforeCommit?.(); // test seam for the decision-to-commit window
      const now = readIfExists(main); // the file the decision was based on must still be the one being replaced
      if (!now || sha256(now) !== sha256(decisionBytes)) {
        fs.unlinkSync(tmp); tmp = null;
        Object.assign(result, {action: 'separate', reason: 'existing wishlist.json changed during the save; kept this capture separately', target: partial});
        writeNew(partial, text);
      } else { fs.renameSync(tmp, main); tmp = null; result.backup = backup; }
    } else if (decision.action === 'create') {
      writeNew(main, text);
    } else writeNew(partial, text);
    const back = JSON.parse(fs.readFileSync(result.target, 'utf8'));
    if (JSON.stringify(back) !== JSON.stringify(env)) throw new Error('semantic read-back mismatch');
  } finally {
    if (tmp) try { fs.unlinkSync(tmp); } catch {} // only this process's own temporary file
    if (lockHeld) try { fs.unlinkSync(lock); } catch {}
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2), valued = ['--account', '--access-scope', '--dest', '--settings', '--view', '--existing-account', '--existing-view'];
  const opt = n => { const i = args.indexOf(n); return i < 0 ? undefined : args[i + 1]; };
  const file = args.find((a, i) => (!a.startsWith('--') || a === '-') && !valued.includes(args[i - 1]));
  if (!file) { console.error('usage: save-capture.mjs <file | -> --account <alias> --access-scope <scope> [options]'); process.exit(2); }
  try {
    const dryRun = args.includes('--dry-run');
    const dest = path.resolve(opt('--dest') ?? path.join(os.homedir(), '.curator/game-curator/cache/steam'));
    checkCacheAuthorized(dest, opt('--settings')); // before any cache read or write
    const raw = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
    const env = canonicalize(parseToolResult(raw));
    const account = opt('--account'), accessScope = opt('--access-scope') ?? 'unknown';
    const {errors, incomplete} = validate(env, {account, accessScope});
    if (errors.length) { console.error('Rejected (not a valid wishlist envelope):\n- ' + errors.join('\n- ')); process.exit(1); }
    if (account) env.account = account;
    env.accessScope = accessScope;
    if (opt('--view') === 'unfiltered') { // the caller confirmed the page showed the default sort with no filters
      if (env.diagnostics.view?.sort !== DEFAULT_SORT || env.diagnostics.view?.search !== 'empty') { console.error(`--view unfiltered refused: the page recorded sort=${env.diagnostics.view?.sort} search=${env.diagnostics.view?.search}`); process.exit(1); }
      env.diagnostics = {...env.diagnostics, view: {...env.diagnostics.view, filters: 'none', filtersVerifiedBy: 'caller-confirmation'}};
    }
    const result = save(canonicalize(env), dest, {dryRun, incomplete, existingAccount: opt('--existing-account'),
      existingViewUnfiltered: opt('--existing-view') === 'unfiltered', keepSeparate: args.includes('--keep-separate')});
    console.log(JSON.stringify({...result, records: env.records.length, capturedAt: env.capturedAt, dryRun}, null, 2));
  } catch (e) { console.error(String(e.message ?? e)); process.exit(1); }
}
