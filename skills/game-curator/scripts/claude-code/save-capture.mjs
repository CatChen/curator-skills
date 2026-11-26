#!/usr/bin/env node
// Validate a Steam wishlist envelope produced by steam-wishlist-page.js and save it into the authorized
// Curator Home cache without passing the data through model context.
//
//   node save-capture.mjs <tool-result-file> --account <alias> --access-scope signed-in|public|unknown
//        [--dest <cache/steam dir>] [--existing-account <alias>] [--dry-run]
// --existing-account: the user confirmed the existing wishlist.json (which records no alias) belongs to that account.
//
// <tool-result-file> is the file Claude Code writes when a javascript_tool result is too large
// (a JSON array of {type,text}), or a plain JSON envelope. Node built-ins only.
// Policy (persistence.md "Freshness, refresh and safe replacement"): never overwrite a richer capture.
// A new capture becomes wishlist.json only if that file is absent, or the new one is same-account,
// same-scope, newer, complete and no poorer in labeled fields; the old file is then preserved as
// wishlist.superseded.<ts>.json. Otherwise it is saved separately as wishlist.partial.<ts>.json.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const ENVELOPE_ORDER = ['format', 'version', 'source', 'capturedAt', 'method', 'coverage', 'warnings', 'diagnostics', 'account', 'accessScope', 'records'];
const RECORD_ORDER = ['appid', 'rank', 'name', 'pageText', 'membershipSource'];
const LABELS = ['RELEASE DATE:', 'ENGLISH REVIEWS:', 'USER TAGS:'];

const pick = (obj, keys) => Object.fromEntries(keys.filter(k => k in obj).map(k => [k, obj[k]]));
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const stamp = iso => iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

// Parse the harness file: [{type,text}] where text is JSON followed by "(captured at origin ...)".
export function parseToolResult(raw) {
  let value = JSON.parse(raw);
  if (Array.isArray(value)) value = value.filter(p => p?.type === 'text').map(p => p.text).join('');
  if (typeof value !== 'string') return value;
  const end = value.search(/\n\n\(captured at origin /);
  return JSON.parse(end >= 0 ? value.slice(0, end) : value);
}

// The harness alphabetizes object keys; restore the collector's order so the checksum is reproducible.
export function canonicalize(env) {
  const records = env.records.map(r => pick(r, RECORD_ORDER));
  const diagnostics = env.diagnostics;
  return {...pick(env, ENVELOPE_ORDER.filter(k => k !== 'records')), records, diagnostics};
}

export function validate(env, {account, accessScope}) {
  const errors = [];
  if (env.format !== 'game-curator-steam-export' || env.version !== 1) errors.push('unsupported format/version');
  if (env.source !== 'wishlist') errors.push('source is not wishlist');
  if (!Array.isArray(env.records) || !env.records.length) errors.push('no records');
  const recs = env.records ?? [];
  const ids = new Set(recs.map(r => r.appid));
  if (ids.size !== recs.length) errors.push('duplicate AppIDs');
  if (!recs.every((r, i) => Number.isInteger(r.appid) && r.rank === i + 1 && typeof r.name === 'string' && typeof r.pageText === 'string')) errors.push('records are not contiguous ranks 1..n with name/pageText');
  const d = env.diagnostics ?? {};
  if (d.expectedCount !== recs.length) errors.push(`expectedCount ${d.expectedCount} != ${recs.length} records`);
  if (d.placeholderNameRows) errors.push(`${d.placeholderNameRows} placeholder-name rows`);
  if (!d.recordsSha256 || sha256(JSON.stringify(recs)) !== d.recordsSha256) errors.push('records checksum mismatch (page vs transferred)');
  if (!(account === undefined || /^[A-Za-z0-9_-]{1,64}$/.test(account))) errors.push('unsafe account alias');
  if (!['signed-in', 'public', 'unknown'].includes(accessScope)) errors.push('invalid access scope');
  return errors;
}

const labelCount = env => env.records.reduce((n, r) => n + LABELS.filter(l => r.pageText.includes(l)).length, 0);

// Decide where the new capture goes. Returns {action:'create'|'replace'|'separate', reason}.
export function decide(existing, next, {existingAccount} = {}) {
  if (!existing) return {action: 'create', reason: 'no existing wishlist.json'};
  if (existing.format !== 'game-curator-steam-export' || existing.source !== 'wishlist' || !Array.isArray(existing.records)) return {action: 'separate', reason: 'existing file is not a valid wishlist envelope; preserved'};
  if (!next.account || (existing.account ?? existingAccount) !== next.account) return {action: 'separate', reason: 'account identity differs or is unknown'};
  if (existing.accessScope !== next.accessScope) return {action: 'separate', reason: 'access scope differs'};
  if (!(Date.parse(next.capturedAt) > Date.parse(existing.capturedAt))) return {action: 'separate', reason: 'new capture is not newer'};
  if (labelCount(next) / next.records.length < labelCount(existing) / existing.records.length) return {action: 'separate', reason: 'new capture has fewer labeled fields per row'};
  return {action: 'replace', reason: 'same account and scope, newer, complete, no poorer in labeled fields'};
}

function writeNew(file, text) {
  fs.writeFileSync(file, text, {flag: 'wx', mode: 0o600});
  if (fs.readFileSync(file, 'utf8') !== text) throw new Error(`read-back mismatch for ${file}`);
}

export function save(env, destDir, {dryRun = false, existingAccount} = {}) {
  const main = path.join(destDir, 'wishlist.json');
  let existing = null;
  if (fs.existsSync(main)) { try { existing = JSON.parse(fs.readFileSync(main, 'utf8')); } catch { existing = {malformed: true}; } }
  const decision = decide(existing, env, {existingAccount});
  const text = JSON.stringify(env, null, 2) + '\n';
  const ts = stamp(env.capturedAt);
  const target = decision.action === 'separate' ? path.join(destDir, `wishlist.partial.${ts}.json`) : main;
  let backup = null;
  if (!dryRun) {
    fs.mkdirSync(destDir, {recursive: true, mode: 0o700});
    if (decision.action === 'replace') {
      backup = path.join(destDir, `wishlist.superseded.${stamp(existing.capturedAt)}.json`);
      fs.copyFileSync(main, backup, fs.constants.COPYFILE_EXCL);
      const tmp = path.join(destDir, `.wishlist.${process.pid}.tmp`);
      writeNew(tmp, text);
      fs.renameSync(tmp, main); // atomic replace on the same filesystem
    } else writeNew(target, text);
    const back = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (JSON.stringify(back) !== JSON.stringify(env)) throw new Error('semantic read-back mismatch');
  }
  return {...decision, target, backup, bytes: Buffer.byteLength(text), sha256: sha256(text)};
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2), opt = n => { const i = args.indexOf(n); return i < 0 ? undefined : args[i + 1]; };
  const file = args.find(a => !a.startsWith('--') && a !== opt('--account') && a !== opt('--access-scope') && a !== opt('--dest') && a !== opt('--existing-account'));
  if (!file) { console.error('usage: save-capture.mjs <tool-result-file> --account <alias> --access-scope <scope> [--dest dir] [--dry-run]'); process.exit(2); }
  const account = opt('--account'), accessScope = opt('--access-scope') ?? 'unknown';
  const env = canonicalize(parseToolResult(fs.readFileSync(file, 'utf8')));
  const errors = validate(env, {account, accessScope});
  if (errors.length) { console.error('Validation failed:\n- ' + errors.join('\n- ')); process.exit(1); }
  if (account) env.account = account;
  env.accessScope = accessScope;
  const final = canonicalize(env);
  const dest = opt('--dest') ?? path.join(os.homedir(), '.curator/game-curator/cache/steam');
  const result = save(final, dest, {dryRun: args.includes('--dry-run'), existingAccount: opt('--existing-account')});
  console.log(JSON.stringify({...result, records: final.records.length, capturedAt: final.capturedAt, dryRun: args.includes('--dry-run')}, null, 2));
}
