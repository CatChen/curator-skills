#!/usr/bin/env node
// Validate a Steam wishlist envelope produced by steam-wishlist-page.js and save it into the authorized
// Curator Home cache without passing the data through model context. Node built-ins only.
//
//   node save-capture.mjs <file | -> --account <alias> --access-scope signed-in|public|unknown
//        [--dest <cache/steam dir>] [--settings <settings.json>] [--view unfiltered]
//        [--existing-account <alias>] [--existing-view unfiltered] [--keep-separate] [--expect-sha256 <hex>] [--dry-run]
// (--view / --existing-view / --existing-account are confirmations by the user or caller, not observations.)
//
// Input is the file Claude Code writes when a javascript_tool result is too large (a JSON array of
// {type,text}), a plain JSON envelope file, or "-" for stdin for a file the user supplies. The model must not
// retype or reconstruct data; a result returned inline has no supported route to disk (report that blocker).
//
// Cache policy (persistence.md "Freshness, refresh and safe replacement"). Nothing is merged and nothing is
// deleted. A capture becomes wishlist.json (created or replacing) only when its account and scope are established
// (signed-in or public, verified account) and it is known to be in the default sort with an empty search and no
// filters (the caller attests filters; --existing-view only fills evidence an older capture lacks and never
// overrides a recorded conflict). Replacement also needs the same account, scope and coverage, a newer capture,
// no retained AppID losing a labeled field, fewer than MAX_BACKUPS backups, and the existing file unchanged since
// the decision. Everything else, including every incomplete capture, is kept beside it as
// wishlist.partial.<timestamp>.json. The previous file is first preserved as wishlist.superseded.<timestamp>.json.
// Caller-attested values are recorded in diagnostics.attestations, separate from the page's observed evidence.
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const MAX_BACKUPS = 5; // bounded retention: at the limit new captures are kept separately; nothing is auto-deleted
const ENVELOPE_ORDER = ['format', 'version', 'source', 'capturedAt', 'method', 'coverage', 'warnings', 'diagnostics', 'account', 'accessScope', 'records'];
const RECORD_ORDER = ['appid', 'rank', 'name', 'pageText', 'membershipSource'];
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
  const rest = env;
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
  for (const k of Object.keys(env)) if (!known.has(k)) errors.push(`unexpected envelope field: ${k}`);
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
  if (!recs.length) { // an empty page is preserved as an uncertain observation, never as a verified empty wishlist
    if (d?.stopReason === 'empty-observed' && d?.expectedCount === 0) incomplete.push('empty wishlist observed but owner, account and filter state were not independently verified');
    else errors.push('no records and no empty-page observation');
  }
  if (account !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(account)) errors.push('unsafe account alias');
  if (!['signed-in', 'public', 'unknown'].includes(accessScope)) errors.push('invalid access scope');
  if (accessScope === 'signed-in' && d?.reorderHandles !== true) errors.push('signed-in scope claimed without owner-only evidence (reorder handles)');
  return {errors, incomplete};
}

// Is this a structurally valid wishlist envelope that can serve as the comparison baseline?
function validExisting(e) {
  if (!e || typeof e !== 'object' || e.format !== 'game-curator-steam-export' || e.version !== 1 || e.source !== 'wishlist') return false;
  if (!isIso(e.capturedAt) || typeof e.method !== 'string' || !e.method || !['partial', 'complete'].includes(e.coverage)) return false;
  if (!Array.isArray(e.warnings) || !e.diagnostics || typeof e.diagnostics !== 'object' || Array.isArray(e.diagnostics) || !Array.isArray(e.records)) return false;
  const ids = new Set(), ranks = new Set(); // legacy-tolerant: no new diagnostics required, but no contradictions
  for (const r of e.records) {
    if (!r || !Number.isSafeInteger(r.appid) || r.appid <= 0 || typeof r.name !== 'string' || typeof r.pageText !== 'string') return false;
    if (ids.has(r.appid)) return false; ids.add(r.appid);
    if (r.rank !== undefined) { if (!Number.isSafeInteger(r.rank) || r.rank <= 0 || ranks.has(r.rank)) return false; ranks.add(r.rank); }
  }
  return true;
}
const viewOf = e => { const d = e?.diagnostics, v = d?.view; return v ? {...v, filters: d.attestations?.filters ?? v.filters} : null; };
const unfiltered = v => v?.filters === 'none' && v?.sort === DEFAULT_SORT && v?.search === 'empty';
// A user confirmation may fill evidence that is missing; it never overrides explicitly conflicting recorded evidence.
const conflicting = v => !!v && (v.filters === 'active' || (v.sort != null && v.sort !== DEFAULT_SORT) || v.search === 'active');
const established = e => !!e.account && ['signed-in', 'public'].includes(e.accessScope);

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
  // Main creation and promotion both need an established identity, scope and view; otherwise keep it separate.
  if (!established(next)) return {action: 'separate', reason: 'account identity or access scope is not established (signed-in or public with a verified account)', notes};
  if (!unfiltered(viewOf(next))) return {action: 'separate', reason: 'capture is not verified as default sort, empty search and unfiltered; a filtered list can omit wishlist members', notes};
  if (!existing) return {action: 'create', reason: 'no existing wishlist.json; established account and scope, default view', notes};
  if (!validExisting(existing)) return {action: 'separate', reason: 'existing file is not a valid wishlist envelope; preserved untouched', notes};
  if ((existing.account ?? existingAccount) !== next.account) return {action: 'separate', reason: 'account identity differs or is unknown', notes};
  if (existing.accessScope !== next.accessScope) return {action: 'separate', reason: 'access scope differs or is not established', notes};
  if (existing.coverage !== next.coverage) return {action: 'separate', reason: 'coverage differs', notes};
  if (!(Date.parse(next.capturedAt) > Date.parse(existing.capturedAt))) return {action: 'separate', reason: 'new capture is not newer', notes};
  const ev = viewOf(existing);
  if (conflicting(ev)) return {action: 'separate', reason: 'existing capture recorded a non-default sort, active search or active filter', notes};
  if (!(unfiltered(ev) || existingViewUnfiltered)) return {action: 'separate', reason: 'existing capture has no filter/sort evidence and the user has not confirmed it was unfiltered', notes};
  const losses = fieldLosses(existing, next);
  if (Object.keys(losses).length) return {action: 'separate', reason: `retained AppIDs lose fields: ${JSON.stringify(losses)}`, notes};
  if (backupCount >= MAX_BACKUPS) return {action: 'separate', reason: `${backupCount} superseded backups already exist (limit ${MAX_BACKUPS}); prune them to allow replacement`, notes};
  const now = new Set(next.records.map(r => r.appid)), before = new Set(existing.records.map(r => r.appid));
  notes.push(`membership: ${[...before].filter(a => !now.has(a)).length} removed, ${[...now].filter(a => !before.has(a)).length} added`);
  return {action: 'replace', reason: 'same established account, scope and coverage; newer; default view and unfiltered on both; no retained field lost', notes};
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
  const real = p => { let q = path.resolve(p); const tail = []; while (!fs.existsSync(q)) { tail.unshift(path.basename(q)); q = path.dirname(q); } return path.join(fs.realpathSync(q), ...tail); };
  const home = real(path.dirname(file)), target = real(dest);
  if (target !== home && !target.startsWith(home + path.sep)) throw new Error(`Cache not authorized: ${file} does not govern ${dest} (the destination must be inside the settings record's directory)`);
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

export function save(env, destDir, {dryRun = false, incomplete = [], hooks = {}, recheckConsent, ...policy} = {}) {
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

  recheckConsent?.(); // before creating or touching anything
  fs.mkdirSync(destDir, {recursive: true, mode: 0o700});
  let lockHeld = false, tmp = null;
  try {
    recheckConsent?.(); // consent may have been revoked since the CLI started
    fs.writeFileSync(lock, `${process.pid} ${new Date().toISOString()}\n`, {flag: 'wx', mode: 0o600}); lockHeld = true; // concurrent savers
    if (decision.action === 'replace') {
      const backup = path.join(destDir, `wishlist.superseded.${stamp(existing.capturedAt)}.json`);
      try { fs.copyFileSync(main, backup, fs.constants.COPYFILE_EXCL); }
      catch (e) { if (e.code !== 'EEXIST') throw e; } // a retry may find its own earlier backup; it must be identical
      if (sha256(fs.readFileSync(backup)) !== sha256(decisionBytes)) throw new Error('backup does not match the existing file');
      tmp = path.join(destDir, `.wishlist.${process.pid}.tmp`);
      writeNew(tmp, text);
      hooks.beforeCommit?.(); // test seam for the decision-to-commit window
      recheckConsent?.();
      const now = readIfExists(main); // the file the decision was based on must still be the one being replaced
      if (!now || sha256(now) !== sha256(decisionBytes)) {
        fs.unlinkSync(tmp); tmp = null;
        Object.assign(result, {action: 'separate', reason: 'existing wishlist.json changed during the save; kept this capture separately', target: partial});
        writeNew(partial, text);
      } else { fs.renameSync(tmp, main); tmp = null; result.backup = backup; }
    } else if (decision.action === 'create') {
      recheckConsent?.(); writeNew(main, text);
    } else { recheckConsent?.(); writeNew(partial, text); }
    const back = JSON.parse(fs.readFileSync(result.target, 'utf8'));
    if (JSON.stringify(back) !== JSON.stringify(env)) throw new Error('semantic read-back mismatch');
  } finally {
    if (tmp) try { fs.unlinkSync(tmp); } catch {} // only this process's own temporary file
    if (lockHeld) try { fs.unlinkSync(lock); } catch {}
  }
  return result;
}

// True only when this file is the process entry point, including when invoked through a symlink or a path
// with spaces (import.meta.url is the resolved file URL, argv[1] may be a symlinked path). Importing is side-effect free.
function isMain() {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; }
}

if (isMain()) {
  const args = process.argv.slice(2), valued = ['--account', '--access-scope', '--dest', '--settings', '--view', '--existing-account', '--existing-view', '--expect-sha256'];
  const opt = n => { const i = args.indexOf(n); return i < 0 ? undefined : args[i + 1]; };
  const file = args.find((a, i) => (!a.startsWith('--') || a === '-') && !valued.includes(args[i - 1]));
  if (!file) { console.error('usage: save-capture.mjs <file | -> --account <alias> --access-scope <scope> [options]'); process.exit(2); }
  try {
    const dryRun = args.includes('--dry-run');
    const dest = path.resolve(opt('--dest') ?? path.join(os.homedir(), '.curator/game-curator/cache/steam'));
    checkCacheAuthorized(dest, opt('--settings')); // before any cache read or write
    const raw = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
    const expectSha = opt('--expect-sha256'); // bytes the page reported for a downloaded file; guards the transfer
    if (expectSha !== undefined && sha256(raw) !== expectSha.toLowerCase().replace(/[\s-]/g, '')) throw new Error('Transferred file does not match --expect-sha256 (the file is incomplete, changed or not the one the page produced)');
    const env = canonicalize(parseToolResult(raw));
    const account = opt('--account'), accessScope = opt('--access-scope') ?? 'unknown';
    const {errors, incomplete} = validate(env, {account, accessScope});
    if (errors.length) { console.error('Rejected (not a valid wishlist envelope):\n- ' + errors.join('\n- ')); process.exit(1); }
    // Caller-attested metadata goes in diagnostics.attestations; the page's observed evidence (diagnostics.view,
    // the reported accessScope) is kept as captured and the original envelope's checksum is recorded.
    const attestations = {by: 'caller', attestedAt: new Date().toISOString(), sourceEnvelopeSha256: sha256(JSON.stringify(env)), pageReportedAccessScope: env.accessScope};
    if (account) { env.account = account; attestations.account = account; }
    env.accessScope = accessScope; attestations.accessScope = accessScope;
    if (opt('--view') === 'unfiltered') { // the caller confirmed the page showed the default sort with no filters
      const v = env.diagnostics.view;
      if (v?.sort !== DEFAULT_SORT || v?.search !== 'empty') { console.error(`--view unfiltered refused: the page recorded sort=${v?.sort} search=${v?.search}`); process.exit(1); }
      attestations.filters = 'none';
    }
    env.diagnostics = {...env.diagnostics, attestations};
    const result = save(canonicalize(env), dest, {dryRun, incomplete, existingAccount: opt('--existing-account'),
      existingViewUnfiltered: opt('--existing-view') === 'unfiltered', keepSeparate: args.includes('--keep-separate'),
      recheckConsent: () => checkCacheAuthorized(dest, opt('--settings'))});
    console.log(JSON.stringify({...result, records: env.records.length, capturedAt: env.capturedAt, dryRun}, null, 2));
  } catch (e) { console.error(String(e.message ?? e)); process.exit(1); }
}
