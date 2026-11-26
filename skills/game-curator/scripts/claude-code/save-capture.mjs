#!/usr/bin/env node
// Validate a Steam wishlist envelope produced by steam-wishlist-page.js and save it into the authorized
// Curator Home cache without passing the data through model context. Node built-ins only.
//
//   node save-capture.mjs <file | -> --account <alias> --access-scope signed-in|public|unknown
//        [--dest <cache/steam dir>] [--settings <settings.json>] [--view unfiltered]
//        [--existing-account <alias>] [--existing-view unfiltered] [--keep-separate] [--provenance tool-result|download] [--page-summary '<json>'] [--source-sha256 <64 hex>] [--expect-bytes <n>] [--dry-run]
// (--view / --existing-view / --existing-account are confirmations by the user or caller, not observations.)
//
// Input is the file Claude Code writes when a javascript_tool result is too large (a JSON array of
// {type,text}: the runtime's own transfer), a plain JSON envelope file (for example a browser download), or "-"
// for stdin for a file the user supplies. The model must not retype or reconstruct data; a result returned
// inline has no supported route to disk (report that blocker).
//
// Transfer evidence (verification levels, not one mechanism). Provenance is declared by the caller, never inferred
// from the file's shape; without --provenance a capture is kept as a separate snapshot.
//   --provenance tool-result  the caller received this exact file from the runtime's own tool-result mechanism for
//                             this run (the file must have that structure, which is necessary but not sufficient).
//   --provenance download     the caller verified the actual downloaded file for this run and passes the page's own
//                             summary with --page-summary. The saver then checks the file name, byte count, capture
//                             time, source, record count, expected count, completeness, stop reason and view against
//                             the received file; any mismatch rejects the file as not the one the page produced.
//   --provenance hook-capture the file is a staged result written by this skill's PostToolUse hook (capture-hook.mjs):
//                             the runtime-processed tool response of an intended collector run, as the hook received it.
//                             The saver verifies the staging location and permissions, the hook's sidecar (digest, size,
//                             tool, source and capture time) and the envelope; it is neither a native tool-result file nor
//                             a download, and it is removed after a successful save.
// --source-sha256 is OPTIONAL STRONGER evidence and must be a digest obtained independently at the source. A digest
// computed only after receipt proves nothing about source-to-destination transfer; it is recorded as a local
// fingerprint. When no source digest exists the saver records that and never claims exact end-to-end byte equality.
// The envelope's own records checksum is always recomputed; it covers the records, not the surrounding metadata.
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
import {normalizeLibraryRecord} from '../browser/library-rows.mjs';

export const MAX_BACKUPS = 5; // bounded retention: at the limit new captures are kept separately; nothing is auto-deleted
const ENVELOPE_ORDER = ['format', 'version', 'source', 'capturedAt', 'method', 'coverage', 'warnings', 'diagnostics', 'account', 'accessScope', 'diagnosticsScope', 'records'];
const DEFAULT_SORT = 'Your Rank';
const isPlainObject = o => !!o && typeof o === 'object' && !Array.isArray(o);

// Per-source rules. Everything source-specific lives here; the policy in decide()/save() is shared. Add a source by adding
// an entry, not by branching the policy.
//   file          cache file stem (wishlist.json, library.json); partial and superseded snapshots derive from it
//   recordOrder   canonical key order (allowed keys), matching what the Codex collector emits
//   validateRecord(r, i, errors) per-record contract checks
//   rankBased     records carry a contiguous displayed rank 1..n
//   ownerEvidence(d) owner-only evidence that justifies a signed-in scope claim
//   viewOk(e) / viewConflict(e)  evidence that the capture shows the full source (default view, no filter), and evidence that it does not
//   viewAttestable whether a caller may attest filters (the library page has no filter panel to inspect)
//   fieldLosses(existing, next)  per retained AppID, a field that existed and is now absent
const FIELD_GROUPS = {releaseDate: /RELEASE DATE:/, reviews: /(ENGLISH|OVERALL) REVIEWS:/, userTags: /USER TAGS:/, myCategories: /MY CATEGORIES:/};
const wishlistView = e => { const d = e?.diagnostics, v = d?.view; return v ? {...v, filters: d.attestations?.filters ?? v.filters} : null; };
const SOURCES = {
  wishlist: {
    file: 'wishlist', recordOrder: ['appid', 'rank', 'name', 'pageText', 'membershipSource'], rankBased: true, requiredDiagnostics: ['ranksObserved', 'placeholderNameRows'],
    validateRecord(r, i, errors) {
      if (!Number.isSafeInteger(r.rank) || r.rank <= 0) errors.push(`record ${i} has an invalid rank`);
      if (typeof r.name !== 'string' || !r.name.trim()) errors.push(`record ${i} has an empty name`);
      if (typeof r.pageText !== 'string' || !r.pageText.trim()) errors.push(`record ${i} has empty pageText`);
      if (r.membershipSource !== 'wishlist-row') errors.push(`record ${i} has an unexpected membershipSource`);
    },
    ownerEvidence: d => d?.reorderHandles === true, ownerLabel: 'owner-only evidence (reorder handles)',
    viewOk: e => { const v = wishlistView(e); return v?.filters === 'none' && v?.sort === DEFAULT_SORT && v?.search === 'empty'; },
    viewConflict: e => { const v = wishlistView(e); return !!v && (v.filters === 'active' || (v.sort != null && v.sort !== DEFAULT_SORT) || v.search === 'active'); },
    viewAttestable: true, viewSummaryKeys: ['sort', 'search', 'filters'],
    viewMessage: 'default sort, empty search and unfiltered; a filtered list can omit wishlist members',
    fieldLosses(existing, next) {
      const newer = new Map(next.records.map(r => [r.appid, r])), losses = {};
      for (const old of existing.records) {
        const now = newer.get(old.appid);
        if (!now) continue;
        for (const [group, re] of Object.entries(FIELD_GROUPS)) if (re.test(old.pageText) && !re.test(now.pageText)) losses[group] = (losses[group] ?? 0) + 1;
        if (old.name && !now.name) losses.name = (losses.name ?? 0) + 1;
      }
      return losses;
    },
  },
  library: {
    file: 'library', nestedOrder: {achievements: ['unlocked', 'total']}, recordOrder: ['appid', 'name', 'pageText', 'membershipSource', 'hours', 'playtimeDisplay', 'lastPlayedDisplay', 'achievements'], rankBased: false, requiredDiagnostics: [],
    validateRecord(r, i, errors) {
      if (!(r.name === null || (typeof r.name === 'string' && r.name.trim()))) errors.push(`record ${i} has an invalid name`);
      if (typeof r.pageText !== 'string' || !r.pageText.trim()) errors.push(`record ${i} has empty pageText`);
      if (r.membershipSource !== 'all-games-row') errors.push(`record ${i} has an unexpected membershipSource`);
      // Missing-value semantics: every labeled value must equal what the single shared parser derives from the row's own
      // text, so an absent label is null, never 0, and nothing is invented.
      if (typeof r.pageText === 'string') {
        const expected = normalizeLibraryRecord({appid: r.appid, name: r.name, pageText: r.pageText, membershipSource: r.membershipSource});
        for (const k of ['hours', 'playtimeDisplay', 'lastPlayedDisplay', 'achievements']) if (JSON.stringify(r[k]) !== JSON.stringify(expected[k])) errors.push(`record ${i} field ${k} disagrees with its own page text`);
      }
    },
    ownerEvidence: d => d?.ownerControls === true, ownerLabel: 'owner-only evidence (download controls)',
    viewOk: e => { const v = e?.diagnostics?.view; return v?.tab === 'all' && v?.search === 'empty'; },
    viewConflict: e => { const v = e?.diagnostics?.view; return !!v && ((v.tab != null && v.tab !== 'all') || v.search === 'active'); },
    viewAttestable: false, viewSummaryKeys: ['tab', 'search', 'language'],
    viewMessage: 'the "All Games" tab with an empty search',
    fieldLosses(existing, next) {
      const newer = new Map(next.records.map(r => [r.appid, r])), losses = {};
      for (const old of existing.records) {
        const now = newer.get(old.appid);
        if (!now) continue;
        for (const k of ['hours', 'lastPlayedDisplay', 'achievements']) if (old[k] != null && now[k] == null) losses[k] = (losses[k] ?? 0) + 1;
        if (old.name && !now.name) losses.name = (losses.name ?? 0) + 1;
      }
      return losses;
    },
  },
  reviews: {
    file: 'reviews', recordOrder: ['appid', 'reviewUrl', 'recommended', 'review', 'playtimeDisplay', 'postedDate', 'name', 'nameSource'], rankBased: false, requiredDiagnostics: ['pagesVisited', 'pagesPending'],
    // The records checksum covers observed fields only: names are never observed on this page and may be added later by enrichment.
    observedRecords: recs => recs.map(r => { const {name, nameSource, ...observed} = r; return observed; }),
    validateRecord(r, i, errors, env) {
      const m = typeof r.reviewUrl === 'string' && r.reviewUrl.match(/^https:\/\/steamcommunity\.com\/((?:id|profiles)\/[^/]+)\/recommended\/(\d+)\/?$/);
      if (!m) errors.push(`record ${i} has an invalid reviewUrl`);
      else {
        if (Number(m[2]) !== r.appid) errors.push(`record ${i} reviewUrl does not match its appid`);
        // Every review must belong to the list that was collected: the account path in its URL equals the list path the collector recorded.
        const listPath = env?.diagnostics?.urlPath;
        if (typeof listPath === 'string' && /^\/(?:id|profiles)\/[^/]+\/recommended$/.test(listPath) && `/${m[1]}/recommended` !== listPath) errors.push(`record ${i} reviewUrl belongs to a different account path than the collected list`);
      }
      if (!(r.recommended === null || typeof r.recommended === 'boolean')) errors.push(`record ${i} has an invalid recommended value`);
      for (const k of ['review', 'playtimeDisplay', 'postedDate']) if (!(r[k] === null || (typeof r[k] === 'string' && r[k].trim()))) errors.push(`record ${i} has an invalid ${k}`);
      // A name is never observed here; it is allowed only as a marked enrichment from a verified library capture.
      if ('name' in r || 'nameSource' in r) {
        if (typeof r.name !== 'string' || !r.name.trim()) errors.push(`record ${i} has an invalid name`);
        if (r.nameSource !== 'verified-library-capture') errors.push(`record ${i} has a name without nameSource "verified-library-capture"`);
      }
    },
    validateDiagnostics(d, recs, errors) {
      const count = n => Number.isSafeInteger(n) && n >= 0;
      for (const k of ['pagesVisited', 'pagesPending', 'pageAttempts']) if (!count(d[k])) errors.push(`diagnostics.${k} must be a non-negative integer`);
      if (count(d.pagesVisited) && count(d.pageAttempts) && recs.length && (d.pagesVisited < 1 || d.pageAttempts < d.pagesVisited)) errors.push('pagination diagnostics are inconsistent with the records');
      if (typeof d.urlPath !== 'string' || !/^\/(?:id|profiles)\/[^/]+\/recommended$/.test(d.urlPath)) errors.push('diagnostics.urlPath is not a reviews list path');
    },
    ownerEvidence: d => d?.ownerControls === true, ownerLabel: 'owner-only evidence (review controls)',
    viewOk: e => e?.diagnostics?.view?.kind === 'recommended-list',
    viewConflict: e => { const v = e?.diagnostics?.view; return !!v && v.kind != null && v.kind !== 'recommended-list'; },
    viewAttestable: false, viewSummaryKeys: ['kind', 'language'],
    viewMessage: 'the full "My reviews" list (the recommended-list view, every page)',
    fieldLosses(existing, next) {
      const newer = new Map(next.records.map(r => [r.appid, r])), losses = {};
      for (const old of existing.records) {
        const now = newer.get(old.appid);
        if (!now) continue;
        for (const k of ['review', 'recommended', 'playtimeDisplay', 'postedDate', 'name']) if (old[k] != null && now[k] == null) losses[k] = (losses[k] ?? 0) + 1;
      }
      return losses;
    },
  },
  // Replay: one record per annual report ({year, semanticText, apps}), keyed by year, not AppID. A page capture holds every year it reached;
  // the saver splits it into per-year files (replay/<year>.json) that keep the original capture's metadata and say so (diagnosticsScope).
  replay: {
    file: 'replay', recordOrder: ['year', 'semanticText', 'apps'], nestedOrder: {apps: ['appid', 'name', 'source']}, rankBased: false, requiredDiagnostics: ['years', 'yearsPending', 'yearAttempts'],
    keyLabel: 'year', keyOf: r => r.year, pendingKey: 'yearsPending', pendingLabel: 'annual reports',
    validateKey(r, i, errors) { if (!Number.isInteger(r.year) || r.year < 2000 || r.year > 2099) errors.push(`record ${i} has an invalid year`); },
    validateRecord(r, i, errors) {
      if (typeof r.semanticText !== 'string' || !r.semanticText.trim() || /^LOADING\.\.\.$/i.test(r.semanticText.trim())) errors.push(`record ${i} has empty or placeholder semanticText`);
      if (!Array.isArray(r.apps)) return errors.push(`record ${i} apps must be an array`);
      const seen = new Set();
      r.apps.forEach((a, j) => {
        if (!isPlainObject(a) || Object.keys(a).some(k => !['appid', 'name', 'source'].includes(k))) return errors.push(`record ${i} app ${j} is malformed`);
        if (!Number.isSafeInteger(a.appid) || a.appid <= 0) errors.push(`record ${i} app ${j} has an invalid appid`);
        if (seen.has(a.appid)) errors.push(`record ${i} repeats appid ${a.appid}`); seen.add(a.appid);
        if (!(a.name === null || (typeof a.name === 'string' && a.name.trim()))) errors.push(`record ${i} app ${j} has an invalid name`);
        if (!['app-link', 'image-asset'].includes(a.source)) errors.push(`record ${i} app ${j} has an unexpected source`);
      });
    },
    validateDiagnostics(d, recs, errors, env) {
      const count = n => Number.isSafeInteger(n) && n >= 0;
      if (!Array.isArray(d.years) || !d.years.every(y => Number.isInteger(y) && y >= 2000 && y <= 2099) || new Set(d.years).size !== d.years.length) errors.push('diagnostics.years must be distinct years');
      for (const k of ['yearsPending', 'yearAttempts']) if (!count(d[k])) errors.push(`diagnostics.${k} must be a non-negative integer`);
      for (const k of ['unsettledYears', 'truncatedYears']) {
        if (!Array.isArray(d[k]) || new Set(d[k]).size !== d[k].length || !d[k].every(y => Array.isArray(d.years) && d.years.includes(y))) errors.push(`diagnostics.${k} must list distinct visited years`);
      }
      if (Array.isArray(d.years)) {
        if (env.diagnosticsScope === undefined && JSON.stringify(d.years) !== JSON.stringify(recs.map(r => r.year))) errors.push('diagnostics.years disagrees with the records');
        if (env.diagnosticsScope !== undefined && recs.length === 1 && !d.years.includes(recs[0].year)) errors.push('the annual record is not among the original capture\'s years');
        if (env.diagnosticsScope !== undefined && (d.uniqueCount !== d.years.length)) errors.push('the original capture\'s year list disagrees with its record count');
        if (env.diagnosticsScope !== undefined && env.diagnostics?.attestations?.split && env.diagnostics.attestations.split.originalRecords !== d.uniqueCount) errors.push('the split attestation\'s original record count disagrees with the original capture\'s diagnostics');
        if (count(d.yearsPending) && d.expectedCount !== d.years.length + d.yearsPending) errors.push('diagnostics.expectedCount disagrees with the discovered years');
        if (count(d.yearAttempts) && d.yearAttempts < d.years.length) errors.push('year attempts are inconsistent with the visited years');
      }
    },
    // Per-report reasons a single year must not be promoted, decided for each per-year file (other years of the same capture are unaffected).
    yearIncomplete: (d, r) => [
      ...(typeof r?.semanticText === 'string' && /(^|\n)\s*LOADING\.\.\.\s*(\n|$)/i.test(r.semanticText) ? ['the report still contained a LOADING... placeholder, so its text may be partial'] : []),
      ...(d?.unsettledYears?.includes(r?.year) ? ['the report had not stopped changing when it was read, or the wait budget ended, so it may be incomplete'] : []),
      ...(d?.truncatedYears?.includes(r?.year) ? ['the report\'s game references were truncated at the collector\'s limit, so it is incomplete'] : []),
    ],
    ownerEvidence: d => d?.ownerControls === true, ownerLabel: 'owner-only evidence (the page visibility control on every report)',
    viewOk: e => e?.diagnostics?.view?.kind === 'annual-report',
    viewConflict: e => { const v = e?.diagnostics?.view; return !!v && v.kind != null && v.kind !== 'annual-report'; },
    viewAttestable: false, viewSummaryKeys: ['kind', 'language'],
    viewMessage: 'annual Replay reports (the annual-report view)',
    fieldLosses(existing, next) { // one record per file: a retained game reference must not lose a name it had
      const losses = {}, now = new Map((next.records[0]?.apps ?? []).map(a => [a.appid, a]));
      for (const old of existing.records[0]?.apps ?? []) if (now.has(old.appid) && old.name && !now.get(old.appid).name) losses.name = (losses.name ?? 0) + 1;
      return losses;
    },
  },
};
export const SOURCE_NAMES = Object.keys(SOURCES);
const cfgOf = e => SOURCES[e?.source] ?? SOURCES.wishlist;

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

// Check the page's own summary (from the tool result) against the file actually received. Returns the list of
// mismatches; an empty list means every available non-filtered summary fact agrees.
export function checkPageSummary(summary, env, receivedBytes, fileName) {
  const bad = [], d = env.diagnostics ?? {};
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return ['page summary is not an object'];
  if (summary.downloadInitiated !== true) bad.push('summary does not report a download');
  if (summary.source !== env.source) bad.push('source differs');
  if (summary.capturedAt !== env.capturedAt) bad.push('capture time differs');
  if (summary.bytes !== receivedBytes) bad.push(`byte count differs (summary ${summary.bytes}, received ${receivedBytes})`);
  if (summary.records !== env.records.length) bad.push('record count differs');
  if (summary.expected !== d.expectedCount) bad.push('displayed count differs');
  if (summary.complete !== d.complete) bad.push('completeness differs');
  if (summary.stopReason !== d.stopReason) bad.push('stop reason differs');
  if (JSON.stringify(cfgOf(env).viewSummaryKeys.map(k => summary.view?.[k])) !== JSON.stringify(cfgOf(env).viewSummaryKeys.map(k => d.view?.[k]))) bad.push('view differs');
  if (typeof summary.file !== 'string' || summary.file !== fileName) bad.push(`file name differs (summary ${JSON.stringify(summary.file)}, received ${JSON.stringify(fileName)}); a renamed or duplicate-named copy is ambiguous`);
  else if (summary.file !== `gc-${env.source}-${String(env.capturedAt).replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.json`) bad.push('file name does not match the capture time');
  return bad;
}

export function isToolResult(raw) { try { return Array.isArray(JSON.parse(raw)); } catch { return false; } }

// Restore the collector's key order (the harness alphabetizes keys) without dropping anything: unknown fields
// are kept so validate() can reject them instead of silently stripping evidence.
export function canonicalize(env) {
  const rest = env;
  const known = ENVELOPE_ORDER.filter(k => k in rest), extra = Object.keys(rest).filter(k => !ENVELOPE_ORDER.includes(k));
  const out = {};
  for (const k of [...known, ...extra]) out[k] = k === 'records' && Array.isArray(rest.records)
    ? rest.records.map(r => { // restore record and known nested key order (the harness alphabetizes every object, which changes JSON.stringify and the records checksum)
        const cfg = cfgOf(rest), order = cfg.recordOrder, nested = cfg.nestedOrder ?? {};
        if (!r || typeof r !== 'object') return r;
        const order1 = (v, keys) => ({...Object.fromEntries(keys.filter(k => k in v).map(k => [k, v[k]])), ...Object.fromEntries(Object.entries(v).filter(([k]) => !keys.includes(k)))});
        const fixed = Object.fromEntries(Object.entries(r).map(([f, v]) => [f, nested[f] && isPlainObject(v) ? order1(v, nested[f]) : nested[f] && Array.isArray(v) ? v.map(x => (isPlainObject(x) ? order1(x, nested[f]) : x)) : v]));
        return {...Object.fromEntries(order.filter(f => f in fixed).map(f => [f, fixed[f]])), ...Object.fromEntries(Object.entries(fixed).filter(([f]) => !order.includes(f)))};
      })
    : rest[k];
  return out;
}

// Contract validation. `errors` mean the input is not a valid v1 envelope for its source (nothing is saved).
// `incomplete` reasons mean it is valid but not a full capture: it is preserved as a partial snapshot, never promoted.
export function validate(env, {account, accessScope, incoming = false} = {}) {
  const errors = [], incomplete = [];
  const known = new Set(ENVELOPE_ORDER);
  if (!isPlainObject(env)) return {errors: ['not an object'], incomplete};
  for (const k of Object.keys(env)) if (!known.has(k)) errors.push(`unexpected envelope field: ${k}`);
  if (env.format !== 'game-curator-steam-export' || env.version !== 1) errors.push('unsupported format/version');
  const cfg = SOURCES[env.source];
  if (!cfg) errors.push(`unsupported source: ${JSON.stringify(env.source)} (supported: ${SOURCE_NAMES.join(', ')})`);
  const rules = cfg ?? SOURCES.wishlist;
  if (typeof env.method !== 'string' || !env.method) errors.push('missing method');
  if (!isIso(env.capturedAt)) errors.push('invalid capturedAt timestamp');
  if (!['partial', 'complete'].includes(env.coverage)) errors.push('invalid coverage');
  if (!Array.isArray(env.warnings) || !env.warnings.every(w => typeof w === 'string')) errors.push('warnings must be an array of strings');
  const d = env.diagnostics;
  if (!isPlainObject(d)) errors.push('missing diagnostics');
  const recs = Array.isArray(env.records) ? env.records : (errors.push('records must be an array'), []);
  const allowed = new Set(rules.recordOrder), ids = new Set(), ranks = new Set();
  recs.forEach((r, i) => {
    if (!r || typeof r !== 'object') return errors.push(`record ${i} is not an object`);
    for (const k of Object.keys(r)) if (!allowed.has(k)) errors.push(`record ${i} has unexpected field ${k}`);
    if (rules.validateKey) rules.validateKey(r, i, errors);
    else if (!Number.isSafeInteger(r.appid) || r.appid <= 0) errors.push(`record ${i} has an invalid appid`);
    const key = rules.keyOf ? rules.keyOf(r) : r.appid;
    if (ids.has(key)) errors.push(`duplicate ${rules.keyLabel ?? 'appid'} ${key}`); ids.add(key);
    rules.validateRecord(r, i, errors, env);
    if (rules.rankBased) { if (ranks.has(r.rank)) errors.push(`duplicate rank ${r.rank}`); ranks.add(r.rank); }
  });
  if (rules.rankBased && !recs.every((r, i) => r?.rank === i + 1)) incomplete.push('ranks are not contiguous 1..n');
  // A per-year file split from a multi-year Replay capture keeps the ORIGINAL capture's diagnostics (counts and checksum describe the whole
  // capture), says so with diagnosticsScope, and binds its single record by a checksum the saver recorded when it split the capture.
  const annual = env.diagnosticsScope !== undefined;
  if (annual) {
    if (incoming) errors.push('a page transfer must not carry diagnosticsScope');
    if (env.source !== 'replay' || env.diagnosticsScope !== 'original-multi-year-capture') errors.push('unsupported diagnosticsScope');
    if (recs.length !== 1) errors.push('a per-year file must hold exactly one record');
    const sp = d?.attestations?.split;
    if (!(isPlainObject(sp) && recs.length === 1 && sp.year === recs[0].year && sp.recordSha256 === sha256(JSON.stringify(recs[0])) && Number.isSafeInteger(sp.originalRecords) && sp.originalRecords >= 1)) errors.push('a per-year file lacks a matching split attestation for its record');
  }
  if (isPlainObject(d) && annual) {
    if (typeof d.recordsSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(d.recordsSha256)) errors.push('the original capture\'s records checksum is missing');
    if (!Number.isSafeInteger(d.uniqueCount) || d.uniqueCount < 1) errors.push('diagnostics.uniqueCount is invalid');
    if (d.view !== undefined && !isPlainObject(d.view)) errors.push('diagnostics.view is invalid');
    rules.validateDiagnostics?.(d, recs, errors, env);
    if (Number.isSafeInteger(d.yearsPending) && d.yearsPending > 0) incomplete.push(`${d.yearsPending} ${rules.pendingLabel} were not visited`);
    if (d.complete !== true) incomplete.push(`collector reported an incomplete run (${d.stopReason ?? 'unknown reason'})`);
  } else if (isPlainObject(d)) {
    if (d.uniqueCount !== recs.length) errors.push('diagnostics.uniqueCount disagrees with the records');
    if (rules.rankBased && d.ranksObserved !== recs.length) errors.push('diagnostics.ranksObserved disagrees with the records');
    if (!(d.expectedCount === null || Number.isSafeInteger(d.expectedCount))) errors.push('diagnostics.expectedCount is invalid');
    if (rules.requiredDiagnostics.includes('placeholderNameRows')) {
      if (!Number.isSafeInteger(d.placeholderNameRows)) errors.push('missing diagnostics.placeholderNameRows');
      else if (d.placeholderNameRows > 0) incomplete.push(`${d.placeholderNameRows} placeholder-name rows`);
    }
    if (typeof d.recordsSha256 !== 'string' || sha256(JSON.stringify(rules.observedRecords ? rules.observedRecords(recs) : recs)) !== d.recordsSha256) errors.push('records checksum mismatch (page vs transferred)');
    const pend = d[rules.pendingKey ?? 'pagesPending'];
    if (Number.isSafeInteger(pend) && pend > 0) incomplete.push(`${pend} ${rules.pendingLabel ?? 'review pages'} were not visited`);
    if (d.expectedCount !== null && d.expectedCount !== recs.length) incomplete.push(`displayed ${d.expectedCount} items but ${recs.length} records`);
    if (d.expectedCount === null) incomplete.push('the displayed count was not available, so coverage cannot be verified');
    if (d.complete !== true) incomplete.push(`collector reported an incomplete run (${d.stopReason ?? 'unknown reason'})`);
    if (d.view !== undefined && !isPlainObject(d.view)) errors.push('diagnostics.view is invalid');
    rules.validateDiagnostics?.(d, recs, errors, env);
    // A transfer from a page is observation only: it may not carry attestations (those are added here, by the caller's verified inputs)
    // and, for reviews, may not carry names (a name only ever comes from the enrichment step that verifies it).
    if (incoming && 'attestations' in d) errors.push('a page transfer must not carry diagnostics.attestations');
    if (env.source === 'reviews') {
      const named = recs.filter(r => r && ('name' in r || 'nameSource' in r)).length, e = d.attestations?.enrichment;
      if (incoming && named) errors.push('a page transfer must not carry game names; names are added only by the verified enrichment step');
      else if (named && !(isPlainObject(e) && e.namedRecords === named && typeof e.librarySha256 === 'string' && /^[0-9a-f]{64}$/.test(e.librarySha256) && e.names === 'verified-library-capture')) errors.push('names are present without a matching verified enrichment attestation bound to a library snapshot');
    }
  }
  if (!recs.length) { // an empty page is preserved as an uncertain observation, never as a verified empty source
    if (d?.stopReason === 'empty-observed' && d?.expectedCount === 0) incomplete.push('empty source observed but owner, account and view were not independently verified');
    else errors.push('no records and no empty-page observation');
  }
  if (account !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(account)) errors.push('unsafe account alias');
  if (!['signed-in', 'public', 'unknown'].includes(accessScope)) errors.push('invalid access scope');
  if (accessScope === 'signed-in' && !rules.ownerEvidence(d)) errors.push(`signed-in scope claimed without ${rules.ownerLabel}`);
  return {errors, incomplete};
}

// Is this a structurally valid wishlist envelope that can serve as the comparison baseline?
function validExisting(e, source) {
  if (!e || typeof e !== 'object' || e.format !== 'game-curator-steam-export' || e.version !== 1 || e.source !== source) return false;
  if (!isIso(e.capturedAt) || typeof e.method !== 'string' || !e.method || !['partial', 'complete'].includes(e.coverage)) return false;
  if (!Array.isArray(e.warnings) || !e.diagnostics || typeof e.diagnostics !== 'object' || Array.isArray(e.diagnostics) || !Array.isArray(e.records)) return false;
  if (source === 'replay') { // one annual report per file; legacy-tolerant (older files carry no account, view or attestations)
    const r = e.records[0];
    return e.records.length === 1 && Number.isInteger(r?.year) && typeof r.semanticText === 'string' && Array.isArray(r.apps) && r.apps.every(a => isPlainObject(a) && Number.isSafeInteger(a.appid) && a.appid > 0);
  }
  const ids = new Set(), ranks = new Set(); // legacy-tolerant: no new diagnostics required, but no contradictions
  for (const r of e.records) {
    if (!r || !Number.isSafeInteger(r.appid) || r.appid <= 0 || !(typeof r.name === 'string' || (source === 'library' && r.name === null) || (source === 'reviews' && r.name === undefined)) || (source !== 'reviews' && typeof r.pageText !== 'string')) return false;
    if (ids.has(r.appid)) return false; ids.add(r.appid);
    if (r.rank !== undefined) { if (!Number.isSafeInteger(r.rank) || r.rank <= 0 || ranks.has(r.rank)) return false; ranks.add(r.rank); }
  }
  return true;
}
const established = e => !!e.account && ['signed-in', 'public'].includes(e.accessScope);

// Per retained AppID, a field that existed and is now absent counts as a loss. Returns {group: count}.
export function fieldLosses(existing, next) { return cfgOf(next).fieldLosses(existing, next); }

// Add game names to a reviews envelope from a library capture that is verified to be the same account. The review page never shows
// a name, so this is the only source; every name added is marked nameSource "verified-library-capture" and the library capture's
// time and size are recorded. A review whose game is absent from the library simply stays without a name. Returns {env, enrichment}.
export function enrichReviewNames(env, library, {libraryAccount, librarySha256} = {}) {
  if (env?.source !== 'reviews') throw new Error('name enrichment applies only to a reviews capture');
  if (!validExisting(library, 'library')) throw new Error('the names source is not a valid library capture');
  const account = library.account ?? libraryAccount;
  if (!env.account || !account || account !== env.account) throw new Error('names can only be added from a library capture verified as the same account (both captures must carry the same account alias; use --library-account only for a library file the user confirmed)');
  if (!['signed-in', 'public'].includes(library.accessScope)) throw new Error('the library capture has no established access scope');
  const names = new Map(library.records.filter(r => typeof r.name === 'string' && r.name.trim()).map(r => [r.appid, r.name]));
  let named = 0;
  const records = env.records.map(r => { if (!names.has(r.appid)) return r; named++; return {...r, name: names.get(r.appid), nameSource: 'verified-library-capture'}; });
  if (typeof librarySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(librarySha256)) throw new Error('enrichment must be bound to the exact library snapshot: the SHA-256 of its bytes is required (a local digest identifies the file; it does not authenticate its source)');
  const enrichment = {names: 'verified-library-capture', namedRecords: named, recordsWithoutName: records.length - named, libraryCapturedAt: library.capturedAt, libraryRecords: library.records.length, librarySha256, libraryAccount: account};
  const warnings = records.length - named ? [...env.warnings, 'Some review names are missing from the verified library capture.'] : env.warnings;
  return {env: {...env, records, warnings}, enrichment};
}

// Re-derive the attribution: every name in an enriched reviews capture must equal the name the bound library snapshot gives that AppID,
// carry the verified marker, and no record may be named that the library cannot name. Returns a list of problems (empty means verified).
export function verifyNameAttribution(env, library) {
  const names = new Map(library.records.filter(r => typeof r.name === 'string' && r.name.trim()).map(r => [r.appid, r.name])), bad = [];
  for (const r of env.records) {
    const named = 'name' in r || 'nameSource' in r;
    if (!named) continue;
    if (r.nameSource !== 'verified-library-capture') bad.push(`AppID ${r.appid} has a name without the verified marker`);
    else if (names.get(r.appid) !== r.name) bad.push(`AppID ${r.appid} has a name that the library snapshot does not give it`);
  }
  return bad;
}

// Decide where the new capture goes. Returns {action:'create'|'replace'|'separate', reason, notes}.
export function decide(existing, next, {existingAccount, existingViewUnfiltered = false, keepSeparate = false, backupCount = 0, incomplete = [], transferVerified = false} = {}) {
  const notes = [], cfg = cfgOf(next);
  if (keepSeparate) return {action: 'separate', reason: 'user asked to keep this capture separate', notes};
  if (incomplete.length) return {action: 'separate', reason: `incomplete capture: ${incomplete.join('; ')}`, notes};
  if (!transferVerified) return {action: 'separate', reason: 'transfer not verified: provenance was not established by the caller (--provenance tool-result, or --provenance download with a matching --page-summary)', notes};
  // Main creation and promotion both need an established identity, scope and view; otherwise keep it separate.
  if (!established(next)) return {action: 'separate', reason: 'account identity or access scope is not established (signed-in or public with a verified account)', notes};
  if (!cfg.viewOk(next)) return {action: 'separate', reason: `capture is not verified as ${cfg.viewMessage}`, notes};
  if (!existing) return {action: 'create', reason: `no existing ${next.source === 'replay' ? `replay/${next.records[0].year}` : cfg.file}.json; established account and scope, verified view`, notes};
  if (!validExisting(existing, next.source)) return {action: 'separate', reason: `existing file is not a valid ${next.source} envelope; preserved untouched`, notes};
  if (next.source === 'replay' && existing.records[0].year !== next.records[0].year) return {action: 'separate', reason: 'existing file holds a different year; preserved untouched', notes};
  if ((existing.account ?? existingAccount) !== next.account) return {action: 'separate', reason: 'account identity differs or is unknown', notes};
  if (existing.accessScope !== next.accessScope) return {action: 'separate', reason: 'access scope differs or is not established', notes};
  if (existing.coverage !== next.coverage) return {action: 'separate', reason: 'coverage differs', notes};
  if (!(Date.parse(next.capturedAt) > Date.parse(existing.capturedAt))) return {action: 'separate', reason: 'new capture is not newer', notes};
  if (cfg.viewConflict(existing)) return {action: 'separate', reason: 'existing capture recorded a non-default view (sort, search, tab or filter)', notes};
  if (!(cfg.viewOk(existing) || (cfg.viewAttestable && existingViewUnfiltered))) return {action: 'separate', reason: 'existing capture has no view evidence and the user has not confirmed it was unfiltered', notes};
  const losses = cfg.fieldLosses(existing, next);
  if (Object.keys(losses).length) return {action: 'separate', reason: `retained AppIDs lose fields: ${JSON.stringify(losses)}`, notes};
  if (backupCount >= MAX_BACKUPS) return {action: 'separate', reason: `${backupCount} superseded backups already exist (limit ${MAX_BACKUPS}); prune them to allow replacement`, notes};
  const now = new Set(next.records.map(r => r.appid)), before = new Set(existing.records.map(r => r.appid));
  notes.push(`membership: ${[...before].filter(a => !now.has(a)).length} removed, ${[...now].filter(a => !before.has(a)).length} added`);
  return {action: 'replace', reason: 'same established account, scope and coverage; newer; verified view on both; no retained field lost', notes};
}

// Hook-captured transfers (capture-hook.mjs). Shared with the hook so both sides agree on what is allowed.
export const HOOK_TOOLS = ['mcp__Claude_Browser__javascript_tool', 'mcp__claude-in-chrome__javascript_tool'];
export const STAGING_DIR = '.staging';
const HOOK_META_KEYS = ['bytes', 'call', 'capturedAt', 'deliver', 'kind', 'scriptSha256', 'sha256', 'source', 'stagedAt', 'tool', 'toolUseId', 'version'];

// Read a staged file ONCE, under verification, and return the exact bytes that were verified: the caller must parse and save those bytes
// and never reread the path. The location is checked before anything is read (the staging directory of this cache, or of the skill's default
// cache, private and owned by the user); the files are opened without following links and checked on the open descriptor (regular, owned by
// the user, not readable by others); the sidecar must describe exactly these bytes. Returns {meta, bytes, root, identity}: `root` is the cache
// whose staging directory held the file (its own consent governs the read, see the CLI) and `identity` lets removeIfUnchanged prove the pair is
// still the verified one. Throws on any mismatch.
export function readVerifiedStaging(file, dest, {now = Date.now(), defaultDest = path.join(os.homedir(), '.curator/game-curator/cache/steam')} = {}) {
  const real = p => fs.realpathSync(p);
  const name = path.basename(file);
  if (!/^gc-[a-z]+-\d{8}T\d{6}Z-[0-9a-f]{8}\.json$/.test(name)) throw new Error('hook-capture: unexpected staged file name');
  let dir; try { dir = real(path.dirname(file)); } catch { throw new Error('hook-capture: the staged file does not exist'); }
  // The hook stages under the default cache location it is authorized for; a saver run against another destination (for example a private
  // scratch cache) may still consume it, but only while that default location's own consent holds too (checked by the caller from `root`).
  const root = [dest, defaultDest].find(d => { try { return fs.existsSync(d) && path.join(real(d), STAGING_DIR) === dir; } catch { return false; } });
  if (root === undefined) throw new Error('hook-capture: the file is not in the skill\'s private staging directory');
  const sd = fs.lstatSync(dir);
  if (!sd.isDirectory() || sd.isSymbolicLink() || sd.uid !== process.getuid() || (sd.mode & 0o077)) throw new Error('hook-capture: the staging directory is not private');
  const open = (f, what) => {
    let fd; try { fd = fs.openSync(f, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch (e) { throw new Error(`hook-capture: cannot open ${what} (${e.code ?? e.message})`); }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) throw new Error(`hook-capture: ${what} is not a regular file`);
      if (st.uid !== process.getuid()) throw new Error(`hook-capture: ${what} is not owned by the current user`);
      if (st.mode & 0o077) throw new Error(`hook-capture: ${what} is readable by others`);
      const bytes = fs.readFileSync(fd);
      if (bytes.length !== st.size) throw new Error(`hook-capture: ${what} changed while it was read`);
      return {bytes, identity: {dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs}};
    } finally { fs.closeSync(fd); }
  };
  const staged = open(path.join(dir, name), 'the staged file'), sidecar = open(path.join(dir, name + '.meta.json'), 'the sidecar');
  let meta; try { meta = JSON.parse(sidecar.bytes.toString('utf8')); } catch { throw new Error('hook-capture: the sidecar is not valid JSON'); }
  if (!meta || typeof meta !== 'object' || Object.keys(meta).sort().join() !== HOOK_META_KEYS.join() || meta.version !== 1 || meta.kind !== 'game-curator-hook-capture' || meta.deliver !== 'hook') throw new Error('hook-capture: the sidecar is not a hook capture record');
  if (!HOOK_TOOLS.includes(meta.tool)) throw new Error('hook-capture: the sidecar names a tool the hook does not handle');
  if (staged.bytes.length !== meta.bytes || sha256(staged.bytes) !== meta.sha256) throw new Error('hook-capture: the staged file does not match its sidecar (size or digest)');
  const age = now - Date.parse(meta.stagedAt);
  if (!(age >= -60000 && age <= 24 * 3600 * 1000)) throw new Error('hook-capture: the staged file is older than 24 hours or dated in the future');
  return {meta, bytes: staged.bytes, root, identity: {dir, name, file: staged.identity, sidecar: sidecar.identity}};
}

// Remove the staged pair only if both files are still exactly the ones that were verified and read (same file, size and times); otherwise leave
// both in place. Returns true when removed.
export function removeIfUnchanged(identity) {
  const same = (f, id) => { try { const st = fs.lstatSync(f); return st.isFile() && !st.isSymbolicLink() && st.dev === id.dev && st.ino === id.ino && st.size === id.size && st.mtimeMs === id.mtimeMs && st.ctimeMs === id.ctimeMs; } catch { return false; } };
  const file = path.join(identity.dir, identity.name), sidecar = file + '.meta.json';
  if (!same(file, identity.file) || !same(sidecar, identity.sidecar)) return false;
  for (const f of [file, sidecar]) fs.rmSync(f, {force: true});
  return true;
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

export function save(env, destDir, {dryRun = false, incomplete = [], hooks = {}, recheckConsent, stem: stemOverride, ...policy} = {}) {
  const stem = stemOverride ?? cfgOf(env).file, main = path.join(destDir, `${stem}.json`), lock = path.join(destDir, `.${stem}.lock`);
  const decisionBytes = readIfExists(main);
  let existing = null;
  if (decisionBytes) { try { existing = JSON.parse(decisionBytes.toString('utf8')); } catch { existing = {malformed: true}; } }
  const backups = fs.existsSync(destDir) ? fs.readdirSync(destDir).filter(f => f.startsWith(`${stem}.superseded.`) && f.endsWith('.json')) : [];
  let decision = decide(existing, env, {...policy, backupCount: backups.length, incomplete});
  const text = JSON.stringify(env, null, 2) + '\n', ts = stamp(env.capturedAt);
  const partial = path.join(destDir, `${stem}.partial.${ts}.json`);
  const result = {...decision, target: decision.action === 'separate' ? partial : main, backup: null, bytes: Buffer.byteLength(text), sha256: sha256(text)};
  if (dryRun) return result;

  recheckConsent?.(); // before creating or touching anything
  fs.mkdirSync(destDir, {recursive: true, mode: 0o700});
  let lockHeld = false, tmp = null;
  try {
    recheckConsent?.(); // consent may have been revoked since the CLI started
    fs.writeFileSync(lock, `${process.pid} ${new Date().toISOString()}\n`, {flag: 'wx', mode: 0o600}); lockHeld = true; // concurrent savers
    if (decision.action === 'replace') {
      const backup = path.join(destDir, `${stem}.superseded.${stamp(existing.capturedAt)}.json`);
      try { fs.copyFileSync(main, backup, fs.constants.COPYFILE_EXCL); }
      catch (e) { if (e.code !== 'EEXIST') throw e; } // a retry may find its own earlier backup; it must be identical
      if (sha256(fs.readFileSync(backup)) !== sha256(decisionBytes)) throw new Error('backup does not match the existing file');
      tmp = path.join(destDir, `.${stem}.${process.pid}.tmp`);
      writeNew(tmp, text);
      hooks.beforeCommit?.(); // test seam for the decision-to-commit window
      recheckConsent?.();
      const now = readIfExists(main); // the file the decision was based on must still be the one being replaced
      if (!now || sha256(now) !== sha256(decisionBytes)) {
        fs.unlinkSync(tmp); tmp = null;
        Object.assign(result, {action: 'separate', reason: `existing ${stem}.json changed during the save; kept this capture separately`, target: partial});
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

// Reasons one report of a Replay capture must not be promoted (decided per year, so other years of the same capture are unaffected).
export const replayYearIncomplete = (env, record) => SOURCES.replay.yearIncomplete(env.diagnostics, record);

// Split a validated multi-year Replay capture into one envelope per year, in year order. Each keeps the capture's metadata (account, access
// scope, warnings, observed diagnostics and attestations), is labeled as carrying the ORIGINAL multi-year capture's diagnostics, and records a
// checksum of its own record so the per-year file stays verifiable without the original.
export function splitReplay(env) {
  const {records, ...rest} = env, n = records.length;
  return [...records].sort((a, b) => a.year - b.year).map(r => canonicalize({...rest, diagnosticsScope: 'original-multi-year-capture', records: [r],
    diagnostics: {...env.diagnostics, attestations: {...env.diagnostics.attestations, split: {year: r.year, recordSha256: sha256(JSON.stringify(r)), originalRecords: n}}}}));
}

// True only when this file is the process entry point, including when invoked through a symlink or a path
// with spaces (import.meta.url is the resolved file URL, argv[1] may be a symlinked path). Importing is side-effect free.
function isMain() {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; }
}

if (isMain()) {
  const args = process.argv.slice(2), valued = ['--account', '--access-scope', '--dest', '--settings', '--view', '--existing-account', '--existing-view', '--source-sha256', '--expect-bytes', '--provenance', '--page-summary', '--names-from', '--library-account'];
  const opt = n => { // a flag that needs a value must have one: never silently skip a given safeguard
    const i = args.indexOf(n);
    if (i < 0) return undefined;
    if (i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error(`${n} needs a value`);
    return args[i + 1];
  };
  const file = args.find((a, i) => (!a.startsWith('--') || a === '-') && !valued.includes(args[i - 1]));
  if (!file) { console.error('usage: save-capture.mjs <file | -> --account <alias> --access-scope <scope> [options]'); process.exit(2); }
  try {
    const dryRun = args.includes('--dry-run');
    let hookRoot = null;
    const dest = path.resolve(opt('--dest') ?? path.join(os.homedir(), '.curator/game-curator/cache/steam'));
    checkCacheAuthorized(dest, opt('--settings')); // before any cache read or write
    const sourceSha = opt('--source-sha256'), expectBytes = opt('--expect-bytes'), provenanceArg = opt('--provenance'), summaryArg = opt('--page-summary');
    if (provenanceArg !== undefined && !['tool-result', 'download', 'hook-capture'].includes(provenanceArg)) throw new Error('--provenance must be tool-result, download or hook-capture');
    let hookMeta = null, hookIdentity = null, rawBytes;
    if (provenanceArg === 'hook-capture') {
      // Verify the location and the sidecar BEFORE reading, read the file once, and use only those verified bytes from here on.
      if (file === '-') throw new Error('--provenance hook-capture needs the staged file path, not stdin');
      const verified = readVerifiedStaging(path.resolve(file), dest);
      // A staged file is data the skill retained under the cache consent of the home that staged it: that consent must hold now (and again
      // before the commit), as well as the destination's own, so a revoked default home cannot be bypassed by saving elsewhere.
      if (path.resolve(verified.root) !== dest) checkCacheAuthorized(path.resolve(verified.root));
      hookMeta = verified.meta; hookIdentity = verified.identity; rawBytes = verified.bytes; hookRoot = path.resolve(verified.root);
    } else rawBytes = file === '-' ? fs.readFileSync(0) : fs.readFileSync(file); // Buffer: hash the exact received bytes, before decoding
    if (sourceSha !== undefined && !/^[0-9a-fA-F]{64}$/.test(sourceSha)) throw new Error('--source-sha256 must be exactly 64 hexadecimal characters');
    if (expectBytes !== undefined && !/^\d+$/.test(expectBytes)) throw new Error('--expect-bytes must be a non-negative integer');
    if (sourceSha !== undefined && sha256(rawBytes) !== sourceSha.toLowerCase()) throw new Error('Received file does not match --source-sha256 (incomplete, changed, or not the expected file)');
    if (expectBytes !== undefined && rawBytes.length !== Number(expectBytes)) throw new Error(`Received file is ${rawBytes.length} bytes, expected ${expectBytes}`);
    const raw = rawBytes.toString('utf8');
    if (provenanceArg === 'tool-result' && !isToolResult(raw)) throw new Error('--provenance tool-result was declared but the file does not have the runtime tool-result structure');
    if (provenanceArg === 'download' && isToolResult(raw)) throw new Error('--provenance download was declared but the file is a tool-result file');
    if (provenanceArg === 'hook-capture' && isToolResult(raw)) throw new Error('--provenance hook-capture was declared but the file is a tool-result file');
    let env = canonicalize(parseToolResult(raw));
    if (hookMeta && (env.source !== hookMeta.source || env.capturedAt !== hookMeta.capturedAt)) throw new Error('hook-capture: the envelope does not match the sidecar (source or capture time)');
    let summaryChecks = null;
    if (summaryArg !== undefined) {
      let summary; try { summary = JSON.parse(summaryArg); } catch { throw new Error('--page-summary is not valid JSON'); }
      if (provenanceArg !== 'download') throw new Error('--page-summary applies only with --provenance download');
      const bad = checkPageSummary(summary, env, rawBytes.length, file === '-' ? undefined : path.basename(file));
      if (bad.length) throw new Error(`The received file does not match the page's summary, so it is not the file this run produced:\n- ${bad.join('\n- ')}`);
      summaryChecks = ['file name', 'byte count', 'capture time', 'source', 'record count', 'displayed count', 'completeness', 'stop reason', 'view'];
    }
    // Verified means the caller established it: a declared tool-result file, or a download whose page summary matched every fact.
    const transferVerified = (provenanceArg === 'tool-result') || (provenanceArg === 'hook-capture' && hookMeta !== null) || (provenanceArg === 'download' && summaryChecks !== null);
    const level = provenanceArg === 'tool-result' ? 'runtime-tool-result' : provenanceArg === 'hook-capture' ? 'hook-tool-response' : transferVerified ? (sourceSha !== undefined ? 'download-summary-and-source-digest' : 'download-summary-verified') : 'unverified';
    const account = opt('--account'), accessScope = opt('--access-scope') ?? 'unknown';
    const {errors, incomplete} = validate(env, {account, accessScope, incoming: true});
    if (errors.length) { console.error('Rejected (not a valid Steam export envelope for its source):\n- ' + errors.join('\n- ')); process.exit(1); }
    // Caller-attested metadata goes in diagnostics.attestations; the page's observed evidence (diagnostics.view,
    // the reported accessScope) is kept as captured and the original envelope's checksum is recorded.
    const attestations = {by: 'caller', attestedAt: new Date().toISOString(), sourceEnvelopeSha256: sha256(JSON.stringify(env)), pageReportedAccessScope: env.accessScope,
      transfer: {provenance: provenanceArg ?? 'unspecified', level, receivedBytes: rawBytes.length, localSha256Fingerprint: sha256(rawBytes), sourceDigest: sourceSha !== undefined ? 'matched' : 'unavailable',
        pageSummaryChecks: summaryChecks ?? [], ...(hookMeta ? {hook: {tool: hookMeta.tool, toolUseId: hookMeta.toolUseId, call: hookMeta.call, scriptSha256: hookMeta.scriptSha256, stagedAt: hookMeta.stagedAt, sha256: hookMeta.sha256}} : {}), note: hookMeta ? 'The runtime-processed tool response as the skill hook received it (the text the model also saw, after any runtime filtering); not a native tool-result file, not a download, and no independent source digest.' : sourceSha !== undefined ? 'An independently obtained source digest matched the received bytes.' : 'No independent whole-file source digest was available; the local fingerprint only identifies the received file. Exact end-to-end byte equality is not claimed.'}};
    if (account) { env.account = account; attestations.account = account; }
    env.accessScope = accessScope; attestations.accessScope = accessScope;
    if (opt('--view') === 'unfiltered') { // the caller confirmed the page showed the default sort with no filters
      if (!SOURCES[env.source].viewAttestable) { console.error(`--view unfiltered does not apply to the ${env.source} source: its view evidence is observed by the collector, not attested`); process.exit(1); }
      const v = env.diagnostics.view;
      if (v?.sort !== DEFAULT_SORT || v?.search !== 'empty') { console.error(`--view unfiltered refused: the page recorded sort=${v?.sort} search=${v?.search}`); process.exit(1); }
      attestations.filters = 'none';
    }
    let toSave = env;
    const namesFrom = opt('--names-from'), libraryAccount = opt('--library-account');
    if (libraryAccount !== undefined && namesFrom === undefined) throw new Error('--library-account applies only with --names-from');
    if (namesFrom !== undefined && env.source !== 'reviews') throw new Error('--names-from applies only to a reviews capture');
    if (namesFrom !== undefined) { // read-only use of the user's library cache, inside the same consent scope; the file is never modified
      if (libraryAccount !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(libraryAccount)) throw new Error('unsafe --library-account alias');
      let libBytes, library; try { libBytes = fs.readFileSync(namesFrom); library = JSON.parse(libBytes.toString('utf8')); } catch (e) { throw new Error(`cannot read the names source: ${e.code ?? e.message}`); }
      const result = enrichReviewNames(env, library, {libraryAccount, librarySha256: sha256(libBytes)});
      const bad = verifyNameAttribution(result.env, library);
      if (bad.length) throw new Error(`name attribution failed verification:\n- ${bad.join('\n- ')}`);
      toSave = result.env; attestations.enrichment = result.enrichment;
    }
    env = toSave;
    env.diagnostics = {...env.diagnostics, attestations};
    { const final = validate(canonicalize(env), {account, accessScope}); if (final.errors.length) throw new Error('The envelope to save failed validation after enrichment:\n- ' + final.errors.join('\n- ')); }
    const policy = {dryRun, incomplete, transferVerified, existingAccount: opt('--existing-account'),
      existingViewUnfiltered: opt('--existing-view') === 'unfiltered', keepSeparate: args.includes('--keep-separate'),
      recheckConsent: () => { checkCacheAuthorized(dest, opt('--settings')); if (hookRoot !== null && hookRoot !== dest) checkCacheAuthorized(hookRoot); }};
    if (env.source === 'replay') { // one file per verified year under <cache>/replay/, each decided on its own; nothing is merged or migrated
      const outcomes = [];
      for (const annual of splitReplay(canonicalize(env))) {
        const year = annual.records[0].year;
        try { const r = save(annual, path.join(dest, 'replay'), {...policy, incomplete: [...incomplete, ...replayYearIncomplete(annual, annual.records[0])], stem: String(year)}); outcomes.push({year, action: r.action, reason: r.reason, notes: r.notes, target: r.target, backup: r.backup, bytes: r.bytes, sha256: r.sha256}); }
        catch (e) { outcomes.push({year, error: String(e.message ?? e)}); }
      }
      console.log(JSON.stringify({source: 'replay', capturedAt: env.capturedAt, records: env.records.length, years: outcomes, dryRun}, null, 2));
      if (outcomes.some(o => o.error)) process.exit(1);
    } else {
      const result = save(canonicalize(env), dest, policy);
      console.log(JSON.stringify({...result, records: env.records.length, capturedAt: env.capturedAt, dryRun}, null, 2));
    }
    if (hookMeta && !dryRun) { // saved (kept or separate included): remove the staged pair only if it is still the verified one
      console.error(removeIfUnchanged(hookIdentity) ? 'removed the staged hook capture' : 'the staged files changed after verification: left in place, not removed');
    }
  } catch (e) { console.error(String(e.message ?? e)); process.exit(1); }
}
