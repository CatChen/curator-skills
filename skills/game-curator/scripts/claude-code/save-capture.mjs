#!/usr/bin/env node
// Save a validated Steam capture to the selected, authorized Curator Home.
// Input may be a collector envelope file, supported runtime result file, or stdin.
// A successful complete capture replaces the canonical source snapshot.
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {parseSettings, readSettingsFile, bindingKey} from '../settings.mjs';
import {resolveCuratorHome, assertWithinSelectedHome, guardSelectedHome} from '../curator-home.mjs';
import {checkObservation, evaluateIdentity, identityPolicy, knownConflict, generationOf} from '../identity.mjs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {normalizeLibraryRecord} from '../browser/library-rows.mjs';
import {stable} from '../cache-semantics.mjs';

const ENVELOPE_ORDER = ['format', 'version', 'source', 'capturedAt', 'method', 'coverage', 'warnings', 'diagnostics', 'account', 'accessScope', 'diagnosticsScope', 'records'];
const DEFAULT_SORT = 'Your Rank';
const isPlainObject = o => !!o && typeof o === 'object' && !Array.isArray(o);

// Per-source rules. The save policy is shared. Add a source by adding
// an entry, not by branching the policy.
//   file          cache file stem (wishlist.json, library.json); partial and superseded snapshots derive from it
//   recordOrder   canonical key order (allowed keys), matching what the Codex collector emits
//   validateRecord(r, i, errors) per-record contract checks
//   rankBased     records carry a contiguous displayed rank 1..n
//   ownerEvidence(d) owner-only evidence that justifies a signed-in scope claim
//   viewOk(e) / viewConflict(e)  evidence that the capture shows the full source (default view, no filter), and evidence that it does not
//   viewAttestable whether a caller may attest filters (the library page has no filter panel to inspect)
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
    // Per-report reasons a single year must not replace its cached year, decided for each per-year file (other years of the same capture are unaffected).
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
  },
};
export const SOURCE_NAMES = Object.keys(SOURCES);
const cfgOf = e => SOURCES[e?.source] ?? SOURCES.wishlist;

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
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

// Validate the common envelope and explicit collection failures for either runtime.
export function validate(env, {account, accessScope = 'unknown'} = {}) {
  const errors = [], incomplete = [];
  if (!isPlainObject(env)) return {errors:['not an object'], incomplete};
  const cfg = SOURCES[env.source], d = env.diagnostics;
  for (const key of Object.keys(env)) if (!ENVELOPE_ORDER.includes(key)) errors.push(`unexpected envelope field: ${key}`);
  if (env.format !== 'game-curator-steam-export' || env.version !== 1 || !cfg) errors.push('unsupported format, version or source');
  if (!isIso(env.capturedAt) || typeof env.method !== 'string' || !env.method || !['partial','complete'].includes(env.coverage)) errors.push('invalid capture metadata');
  if (!Array.isArray(env.warnings) || !env.warnings.every(w => typeof w === 'string') || !isPlainObject(d) || !Array.isArray(env.records)) errors.push('invalid warnings, diagnostics or records');
  if (account !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(account)) errors.push('unsafe account alias');
  if (!['signed-in','public','unknown'].includes(accessScope)) errors.push('invalid access scope');
  if (d?.identity !== undefined) errors.push(...checkObservation(d.identity));
  const records = Array.isArray(env.records) ? env.records : [], seen = new Set();
  if (!records.length) incomplete.push('empty collection is not independently verified');
  if (cfg) records.forEach((r, i) => {
    if (!isPlainObject(r)) { errors.push(`record ${i} is not an object`); return; }
    const key = cfg.keyOf ? cfg.keyOf(r) : r.appid;
    if (seen.has(key)) errors.push(`duplicate record key ${key}`); seen.add(key);
    if (cfg.validateKey) cfg.validateKey(r, i, errors);
    else if (!Number.isSafeInteger(key) || key <= 0) errors.push(`record ${i} has an invalid appid`);
    cfg.validateRecord(r, i, errors, env);
  });
  if (d) {
    const originalRecords = env.diagnosticsScope === undefined;
    for (const key of ['uniqueCount', 'expectedCount', 'pagesPending', 'yearsPending', 'placeholderNameRows']) {
      if (d[key] !== undefined && d[key] !== null && (!Number.isSafeInteger(d[key]) || d[key] < 0)) errors.push(`invalid diagnostics.${key}`);
    }
    if (originalRecords && d.uniqueCount != null && d.uniqueCount !== records.length) incomplete.push('collected count does not match records');
    const observed = cfg?.observedRecords ? cfg.observedRecords(records) : records;
    if (originalRecords && d.recordsChecksum && (d.recordsChecksum.scope !== 'host-records' || d.recordsChecksum.sha256 !== sha256(JSON.stringify(stable(observed))))) errors.push('host records checksum mismatch');
    if (originalRecords && d.recordsSha256 && d.recordsSha256 !== sha256(JSON.stringify(observed))) errors.push('records checksum mismatch');
    if (!originalRecords && env.source === 'replay') {
      const split = d.attestations?.split;
      if (records.length !== 1 || split?.year !== records[0]?.year || split?.recordSha256 !== sha256(JSON.stringify(records[0]))) errors.push('Replay split record checksum mismatch');
    }
    const observations = [d.identity, ...(Array.isArray(d.identityYears) ? d.identityYears : [])].filter(Boolean);
    for (const observation of observations) {
      const {year, ...identity} = observation;
      if (year !== undefined) errors.push(...checkObservation(identity));
      if (identity.loggedIn === false || identity.problems?.length || identity.continuity?.broke || (identity.sessionFingerprint && identity.pathFingerprint && identity.sessionFingerprint !== identity.pathFingerprint)) errors.push('known account identity conflict');
    }
    // Legacy collectors used partial as a coverage label even after successful collection.
    if (d.stopReason && !['complete', 'partial', 'unknown'].includes(d.stopReason)) incomplete.push(`collector stopped: ${d.stopReason}`);
    if (d.complete === false) incomplete.push('collector reported an incomplete run');
    if (Number.isSafeInteger(d.expectedCount) && env.diagnosticsScope === undefined && d.expectedCount !== records.length) incomplete.push('displayed count does not match records');
    if ((d.pagesPending ?? 0) > 0 || (d.yearsPending ?? 0) > 0 || (d.placeholderNameRows ?? 0) > 0 || d.missingRanks?.length) incomplete.push('collector reported missing items');
    if (cfg?.viewConflict(env)) incomplete.push('collector observed a filtered view');
  }
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


// Add game names to a reviews envelope from a library capture that is verified to be the same account. The review page never shows
// a name, so this is the only source; every name added is marked nameSource "verified-library-capture" and the library capture's
// time and size are recorded. A review whose game is absent from the library simply stays without a name. Returns {env, enrichment}.
export function enrichReviewNames(env, library, {libraryAccount, librarySha256, binding = null, identity = null} = {}) {
  if (env?.source !== 'reviews') throw new Error('name enrichment applies only to a reviews capture');
  if (!validExisting(library, 'library')) throw new Error('the names source is not a valid library capture');
  if (binding) { // an account is bound: both captures must be verified under THIS binding generation; no manual alias can stand in
    if (libraryAccount !== undefined) throw new Error('--library-account cannot be used while an account is bound: the library capture must itself be verified under the current binding');
    if (!(identity?.result === 'match' && identity.ownership === 'verified')) throw new Error('names can only be added to a reviews capture verified as the bound account');
    const att = library.diagnostics?.attestations?.identity;
    if (library.account !== binding.alias || !(att?.by === 'binding' && att.result === 'match' && att.ownership === 'verified' && att.generation === binding.generation)) throw new Error('the library capture was not verified under the current account binding (a different generation, a legacy or manual capture, or another alias cannot supply names)');
  }
  const account = binding ? binding.alias : (library.account ?? libraryAccount);
  if (!binding && (!env.account || !account || account !== env.account)) throw new Error('names can only be added from a library capture verified as the same account (both captures must carry the same account alias; use --library-account only for a library file the user confirmed)');
  if (!['signed-in', 'public'].includes(library.accessScope)) throw new Error('the library capture has no established access scope');
  const names = new Map(library.records.filter(r => typeof r.name === 'string' && r.name.trim()).map(r => [r.appid, r.name]));
  let named = 0;
  const records = env.records.map(r => { if (!names.has(r.appid)) return r; named++; return {...r, name: names.get(r.appid), nameSource: 'verified-library-capture'}; });
  if (typeof librarySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(librarySha256)) throw new Error('enrichment must be bound to the exact library snapshot: the SHA-256 of its bytes is required (a local digest identifies the file; it does not authenticate its source)');
  const enrichment = {names: 'verified-library-capture', namedRecords: named, recordsWithoutName: records.length - named, libraryCapturedAt: library.capturedAt, libraryRecords: library.records.length, librarySha256, libraryAccount: account, ...(binding ? {generation: binding.generation} : {})};
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

// Hook-captured transfers (capture-hook.mjs). Shared with the hook so both sides agree on what is allowed.
export const HOOK_TOOLS = ['mcp__Claude_Browser__javascript_tool', 'mcp__claude-in-chrome__javascript_tool'];
export const STAGING_DIR = '.staging';
const HOOK_META_KEYS = ['bytes', 'call', 'capturedAt', 'deliver', 'kind', 'scriptSha256', 'sha256', 'source', 'stagedAt', 'tool', 'toolUseId', 'version'];

// Read a staged file ONCE, under verification, and return the exact bytes that were verified: the caller must parse and save those bytes
// and never reread the path. The location is checked before anything is read (the staging directory of this cache, or of the skill's default
// cache, private and owned by the user); the files are opened without following links and checked on the open descriptor (regular, owned by
// the user, not readable by others); the sidecar must describe exactly these bytes. Returns {meta, bytes, root, identity}: `root` is the cache
// whose staging directory held the file (its own consent governs the read: the `authorize` callback runs after the location is verified and before
// anything is opened) and `identity` lets removeIfUnchanged prove the pair is
// still the verified one. Throws on any mismatch.
export function readVerifiedStaging(file, dest, {now = Date.now(), defaultDest = resolveCuratorHome().cache, authorize = () => {}} = {}) {
  guardSelectedHome({dest}); // before the staged file is looked at
  guardSelectedHome({dest: defaultDest}); // an overriding defaultDest cannot name another home while one is selected
  const real = p => fs.realpathSync(p);
  const name = path.basename(file);
  if (!/^gc-[a-z]+-\d{8}T\d{6}Z-[0-9a-f]{8}\.json$/.test(name)) throw new Error('hook-capture: unexpected staged file name');
  let dir; try { dir = real(path.dirname(file)); } catch { throw new Error('hook-capture: the staged file does not exist'); }
  // The hook stages under the SELECTED home's cache (the default home unless CURATOR_HOME names another). With no selected home a saver run against
  // another destination (for example a private scratch cache) may still consume a staged file from the default cache, but only while that default
  // location's own consent holds too (checked by the caller from `root`); while a custom home is selected, only that home's staging is eligible.
  const root = [dest, defaultDest].find(d => { try { return fs.existsSync(d) && path.join(real(d), STAGING_DIR) === dir; } catch { return false; } });
  if (root === undefined) throw new Error('hook-capture: the file is not in the skill\'s private staging directory');
  const sd = fs.lstatSync(dir);
  if (!sd.isDirectory() || sd.isSymbolicLink() || sd.uid !== process.getuid() || (sd.mode & 0o077)) throw new Error('hook-capture: the staging directory is not private');
  authorize(root); // the consent that governs this staging directory is checked BEFORE either file is opened, so a revoked consent prevents the read itself
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

// Dispatch by version without inferring authorization for unknown versions.
export function parseCacheSettings(s) { return parseSettings(s).persistence; } // v1 and v2; the binding is read with parseSettings

// Persistence consent: strict settings.json v1 or v2 (SKILL.md "Persistence"). Fails closed.
export function checkCacheAuthorized(dest, settingsPath) {
  guardSelectedHome({dest, settings: settingsPath}); // a selected custom home bounds every caller, not only the command-line wrappers
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
  let scopes;
  try { scopes = parseCacheSettings(s); } catch { throw new Error(`Cache not authorized: ${file} is not a valid version 1 or 2 settings record`); }
  if (!scopes.steamCache) throw new Error('Cache not authorized: settings.json has steamCache false');
  return file;
}

const readIfExists = f => {
  let fd;
  try { fd = fs.openSync(f, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try { if (!fs.fstatSync(fd).isFile()) throw new Error('cache path is not a regular file'); return fs.readFileSync(fd); }
  finally { fs.closeSync(fd); }
};
function writeNew(file, text) {
  fs.writeFileSync(file, text, {flag: 'wx', mode: 0o600});
  if (!readIfExists(file)?.equals(Buffer.from(text))) throw new Error(`read-back mismatch for ${file}`);
}

// Derive the identity verdict for a capture at the shared boundary, from the actual observation, the approved binding and the collector's own
// owner evidence; nothing a caller attaches is trusted. The observation is consumed and only the verdict (with the binding generation) is
// stored. A manual alias counts only where extraction was unavailable. Returns {env, block, identity}.
export function applyIdentity(env, binding, manualAccount) {
  const out = JSON.parse(JSON.stringify(env)), d = out.diagnostics ?? {};
  const observation = d.identity;
  if (observation !== undefined) { const bad = checkObservation(observation); if (bad.length) throw new Error(`Invalid capture: ${bad.join('; ')}`); } // validated BEFORE it is consumed: a malformed observation is never downgraded to unobserved
  if (isPlainObject(out.diagnostics)) delete out.diagnostics.identity;
  if (!binding) { if (manualAccount !== undefined && out.account === undefined) out.account = manualAccount; return {env: canonicalize(out), block: null, identity: null}; }
  const ownerEvidence = SOURCES[out.source]?.ownerEvidence?.(d) === true;
  const evaluation = evaluateIdentity({binding, observation, ownerEvidence, identityChanged: d.stopReason === 'identity-changed'});
  const pol = identityPolicy({binding, evaluation, manualAccount}); // only an explicit manualAccount counts: an alias merely present on the envelope is not a confirmation
  if (pol.account === undefined) delete out.account; else out.account = pol.account;
  if (isPlainObject(out.diagnostics)) {
    const att = {...(out.diagnostics.attestations ?? {}), identity: pol.attestation};
    if (pol.account !== undefined) att.account = pol.account; else delete att.account;
    if (pol.scope && (out.accessScope === undefined || out.accessScope === 'unknown')) { out.accessScope = pol.scope; att.accessScope = pol.scope; }
    out.diagnostics.attestations = att;
  }
  return {env: canonicalize(out), block: pol.block, identity: pol.attestation};
}

export function save(env, destDir, {dryRun = false, incomplete = [], hooks = {}, recheckConsent: extraCheck, settings, stem: stemOverride, manualAccount} = {}) {
  const settingsFile = checkCacheAuthorized(destDir, settings);
  const bound0 = readSettingsFile(settingsFile).settings.steamAccount;
  if (stemOverride !== undefined) throw new Error('stem override is not supported');
  const recheck = () => {
    checkCacheAuthorized(destDir, settings);
    if (bindingKey(readSettingsFile(settingsFile).settings.steamAccount) !== bindingKey(bound0)) throw new Error('The account binding changed during the save');
    extraCheck?.();
  };
  if (env?.account !== undefined && ((manualAccount !== undefined && manualAccount !== env.account) || (bound0 && bound0.alias !== env.account))) throw new Error('Account alias conflicts with the capture or binding');
  const initial = validate(env, {account: env?.account, accessScope: env?.accessScope ?? 'unknown'});
  if (initial.errors.length) throw new Error(`Invalid capture: ${initial.errors.join('; ')}`);
  const applied = applyIdentity(env, bound0, manualAccount);
  env = applied.env;
  if (applied.block || knownConflict(env)) throw new Error(`Account conflict or unverified account: ${applied.block ?? knownConflict(env)}`);
  const checked = validate(env, {account: env?.account, accessScope: env?.accessScope ?? 'unknown'});
  if (checked.errors.length) throw new Error(`Invalid capture: ${checked.errors.join('; ')}`);
  const problems = [...incomplete, ...checked.incomplete, ...(env.source === 'replay' && env.records?.length === 1 ? replayYearIncomplete(env, env.records[0]) : [])];
  if (problems.length) throw new Error(`Incomplete capture: ${[...new Set(problems)].join('; ')}`);
  if (env.source === 'replay' && (env.diagnosticsScope !== 'original-multi-year-capture' || env.records.length !== 1)) throw new Error('Replay save requires one validated annual split capture');
  const stem = env.source === 'replay' ? String(env.records[0].year) : cfgOf(env).file;
  const dir = env.source === 'replay' ? path.join(destDir, 'replay') : destDir;
  if (env.source === 'replay' && fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error('Replay cache directory must not be a symlink');
  const main = path.join(dir, `${stem}.json`), lock = path.join(dir, `.${stem}.lock`);
  const before = readIfExists(main);
  let existing;
  if (before) {
    try { existing = JSON.parse(before.toString('utf8')); } catch { throw new Error('Existing cache is malformed; preserved untouched'); }
    if (!validExisting(existing, env.source)) throw new Error('Existing cache is invalid; preserved untouched');
    if (knownConflict(existing) || (existing.account && env.account && existing.account !== env.account)) throw new Error('Existing cache belongs to a conflicting account');
    const oldGeneration = generationOf(existing), newGeneration = generationOf(env);
    if (oldGeneration !== null && newGeneration !== null && oldGeneration !== newGeneration) throw new Error('Existing cache belongs to a different account binding');
    if (env.source === 'replay' && existing.records[0].year !== env.records[0].year) throw new Error('Existing cache has a different year');
  }
  const text = JSON.stringify(env, null, 2) + '\n';
  const result = {action: before ? 'replace' : 'create', target: main, bytes: Buffer.byteLength(text), sha256: sha256(text), identity: applied.identity};
  if (dryRun) return result;
  recheck();
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  let held = false, tmp;
  try {
    recheck();
    fs.writeFileSync(lock, `${process.pid}\n`, {flag:'wx', mode:0o600}); held = true;
    tmp = path.join(dir, `.${stem}.${crypto.randomBytes(8).toString('hex')}.tmp`);
    writeNew(tmp, text);
    hooks.beforeCommit?.();
    recheck();
    const now = readIfExists(main);
    if (before ? !now?.equals(before) : now !== null) throw new Error('Existing cache changed during save');
    fs.renameSync(tmp, main); tmp = null;
    if (!readIfExists(main)?.equals(Buffer.from(text))) throw new Error('Cache read-back mismatch');
  } finally {
    if (tmp) try { fs.unlinkSync(tmp); } catch {}
    if (held) try { fs.unlinkSync(lock); } catch {}
  }
  return result;
}

// Reasons one Replay report must not replace a cached year (decided per year, so other years of the same capture are unaffected).
export const replayYearIncomplete = (env, record) => SOURCES.replay.yearIncomplete(env.diagnostics, record);

// Split a validated multi-year Replay capture into one envelope per year, in year order. Each keeps the capture's metadata (account, access
// scope, warnings, observed diagnostics and attestations), is labeled as carrying the ORIGINAL multi-year capture's diagnostics, and records a
// checksum of its own record so the per-year file stays verifiable without the original.
export function splitReplay(env) {
  const {records, ...rest} = env, n = records.length;
  // Each annual file carries ONLY the identity observation made on its own report page (plus the run's continuity), never another year's.
  const {identityYears, identity: runIdentity, ...baseDiag} = env.diagnostics ?? {};
  const own = year => { const e = Array.isArray(identityYears) ? identityYears.find(x => x?.year === year) : null; if (!e) return {}; const {year: y, ...obs} = e; return {identity: {...obs, ...(runIdentity?.continuity ? {continuity: runIdentity.continuity} : {})}}; };
  return [...records].sort((a, b) => a.year - b.year).map(r => {
    const canonicalRecord = canonicalize({...rest, records: [r]}).records[0];
    return canonicalize({...rest, diagnosticsScope: 'original-multi-year-capture', records: [canonicalRecord],
      diagnostics: {...baseDiag, ...own(r.year), attestations: {...env.diagnostics.attestations, split: {year: r.year, recordSha256: sha256(JSON.stringify(canonicalRecord)), originalRecords: n}}}});
  });
}

// True only when this file is the process entry point, including when invoked through a symlink or a path
// with spaces (import.meta.url is the resolved file URL, argv[1] may be a symlinked path). Importing is side-effect free.
function isMain() {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; }
}

if (isMain()) {
  const args = process.argv.slice(2), valued = ['--account', '--access-scope', '--dest', '--settings', '--view', '--provenance', '--names-from', '--library-account'];
  const opt = n => { // a flag that needs a value must have one: never silently skip a given safeguard
    const i = args.indexOf(n);
    if (i < 0) return undefined;
    if (i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error(`${n} needs a value`);
    return args[i + 1];
  };
  const file = args.find((a, i) => (!a.startsWith('--') || a === '-') && !valued.includes(args[i - 1]));
  if (!file) { console.error('usage: save-capture.mjs <file | -> --account <alias> --access-scope <scope> [options]'); process.exit(2); }
  try {
    for (const arg of args) if (arg.startsWith('--') && !valued.includes(arg) && arg !== '--dry-run') throw new Error(`Unknown option: ${arg}`);
    const dryRun = args.includes('--dry-run');
    let hookRoot = null, sourceConsent = null;
    // The Curator Home: the default (~/.curator/game-curator) or the one CURATOR_HOME selects. A selected home that is unusable throws here (never a fallback),
    // and explicit --dest/--settings may only name the selected home's own paths, so the saver, the hook and the binder always agree.
    const selectedHome = resolveCuratorHome(), defaultCache = selectedHome.cache, realOrSelf = p => { try { return fs.realpathSync(p); } catch { return p; } };
    assertWithinSelectedHome(selectedHome, {dest: opt('--dest'), settings: opt('--settings')});
    const dest = path.resolve(opt('--dest') ?? selectedHome.cache), settingsArg = opt('--settings') ?? (selectedHome.source === 'env' ? selectedHome.settings : undefined);
    const settingsFile = checkCacheAuthorized(dest, settingsArg); // before any cache read or write
    const provenanceArg = opt('--provenance');
    if (provenanceArg !== undefined && provenanceArg !== 'hook-capture') throw new Error('--provenance only supports hook-capture');
    let hookMeta = null, hookIdentity = null, rawBytes;
    if (provenanceArg === 'hook-capture') {
      // Verify the location and the sidecar BEFORE reading, read the file once, and use only those verified bytes from here on.
      if (file === '-') throw new Error('--provenance hook-capture needs the staged file path, not stdin');
      // A staged file is data the skill retained under the cache consent of the home that staged it. That home's OWN settings.json must authorize
      // it before either file is opened (and again before the commit), in addition to the destination's: neither `--settings` nor a destination that
      // is another spelling of the selected home can stand in for it.
      sourceConsent = root => {
        const r = path.resolve(root);
        if (realOrSelf(r) === realOrSelf(defaultCache)) checkCacheAuthorized(defaultCache); // the standard home: its own settings.json, never --settings
        else if (r !== dest) checkCacheAuthorized(r);
      };
      const verified = readVerifiedStaging(path.resolve(file), dest, {defaultDest: defaultCache, authorize: sourceConsent});
      hookMeta = verified.meta; hookIdentity = verified.identity; rawBytes = verified.bytes; hookRoot = path.resolve(verified.root);
    } else rawBytes = file === '-' ? fs.readFileSync(0) : fs.readFileSync(file); // Buffer: hash the exact received bytes, before decoding
    let env = canonicalize(parseToolResult(rawBytes.toString('utf8')));
    if (hookMeta && (env.source !== hookMeta.source || env.capturedAt !== hookMeta.capturedAt)) throw new Error('hook-capture: envelope does not match sidecar');
    const accountArg = opt('--account'), scopeArg = opt('--access-scope');
    if (accountArg !== undefined && env.account !== undefined && accountArg !== env.account) throw new Error('Account alias conflicts with the capture');
    const {errors, incomplete} = validate(env, {account: accountArg, accessScope: scopeArg ?? 'unknown', incoming: true});
    if (errors.length) { console.error('Rejected (not a valid Steam export envelope for its source):\n- ' + errors.join('\n- ')); process.exit(1); }
    // Identity is derived inside save() from the page's observation and the approved binding (never trusted from here). With an account bound the
    // manual alias is only a fallback for unavailable extraction and is passed through; unbound, it is attested as before.
    const binding = readSettingsFile(settingsFile).settings.steamAccount;
    const account = binding ? undefined : accountArg, accessScope = scopeArg ?? 'unknown';
    // Caller-attested metadata goes in diagnostics.attestations; the page's observed evidence (diagnostics.view,
    // the reported accessScope) is kept as captured and the original envelope's checksum is recorded.
    const attestations = {...env.diagnostics.attestations, by: 'caller', attestedAt: new Date().toISOString()};
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
      let libBytes, library;
      try {
        const cacheRoot = fs.realpathSync(dest), parent = fs.realpathSync(path.dirname(path.resolve(namesFrom)));
        if (parent !== cacheRoot && !parent.startsWith(cacheRoot + path.sep)) throw new Error('names source must be within the authorized cache');
        checkCacheAuthorized(dest, settingsArg);
        libBytes = readIfExists(namesFrom);
        if (!libBytes) throw new Error('names source does not exist');
        library = JSON.parse(libBytes.toString('utf8'));
      } catch (e) { throw new Error(`cannot read the names source: ${e.code ?? e.message}`); }
      const pre = binding ? applyIdentity(env, binding, accountArg) : null; // the same binding revision save() will use; the observation stays on env for save() to consume
      const result = enrichReviewNames(env, library, {libraryAccount, librarySha256: sha256(libBytes), binding, identity: pre?.identity ? {result: pre.identity.result, ownership: pre.identity.ownership} : null});
      const bad = verifyNameAttribution(result.env, library);
      if (bad.length) throw new Error(`name attribution failed verification:\n- ${bad.join('\n- ')}`);
      toSave = result.env; attestations.enrichment = result.enrichment;
    }
    env = toSave;
    env.diagnostics = {...env.diagnostics, attestations};
    { const final = validate(canonicalize(env), {account, accessScope}); if (final.errors.length) throw new Error('The envelope to save failed validation after enrichment:\n- ' + final.errors.join('\n- ')); }
    const policy = {dryRun, incomplete, settings: settingsArg, manualAccount: accountArg,
      recheckConsent: () => { checkCacheAuthorized(dest, settingsArg); if (hookRoot !== null) sourceConsent(hookRoot); }};
    if (env.source === 'replay') { // one file per verified year under <cache>/replay/, each decided on its own; nothing is merged or migrated
      const outcomes = [];
      for (const annual of splitReplay(canonicalize(env))) {
        const year = annual.records[0].year;
        try { const r = save(annual, dest, {...policy, incomplete: [...incomplete, ...replayYearIncomplete(annual, annual.records[0])]}); outcomes.push({year, action: r.action, reason: r.reason, notes: r.notes, target: r.target, backup: r.backup, bytes: r.bytes, sha256: r.sha256}); }
        catch (e) { outcomes.push({year, error: String(e.message ?? e)}); }
      }
      console.log(JSON.stringify({source: 'replay', capturedAt: env.capturedAt, records: env.records.length, years: outcomes, dryRun, curatorHome: selectedHome.source, destination: dest}, null, 2));
      if (outcomes.some(o => o.error)) process.exit(1);
    } else {
      const result = save(canonicalize(env), dest, policy);
      console.log(JSON.stringify({...result, records: env.records.length, capturedAt: env.capturedAt, dryRun, curatorHome: selectedHome.source, destination: dest}, null, 2));
    }
    if (hookMeta && !dryRun) { // saved (kept or separate included): remove the staged pair only if it is still the verified one
      console.error(removeIfUnchanged(hookIdentity) ? 'removed the staged hook capture' : 'the staged files changed after verification: left in place, not removed');
    }
  } catch (e) { console.error(String(e.message ?? e)); process.exit(1); }
}
