// Browser-runtime collectors. All page evaluation reads the DOM only.
// The caller supplies a tab already opened on the verified account's source page.
import {snapshotWishlist, mergeWishlistRow, toWishlistRecords} from './wishlist-rows.mjs';
import {snapshotLibrary, mergeLibraryRow, normalizeLibraryRecord, libraryFieldsKey} from './library-rows.mjs';
import {snapshotReviews} from './review-rows.mjs';
import {b64uEncode, b64uDecode} from './identity-probe.mjs';
import {codexIdentityPage} from './codex-identity-page.mjs';
import {snapshotReplay, replayLoading, dedupeReplayApps, replayYears} from './replay-rows.mjs';
import {stable} from '../cache-semantics.mjs';
import {pagePathFingerprint} from './path-fingerprint.mjs';

const LIMIT = 80;

async function envelope(source, records, warnings, diagnostics = {}) {
  // The assembled records exist in the host, so this is an integrity fingerprint
  // of that host object, not an independent page or transport attestation.
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(stable(records)));
    const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
    diagnostics.recordsChecksum = {scope:'host-records', sha256:[...hash].map(x=>x.toString(16).padStart(2,'0')).join('')};
  } catch { warnings.push('The host records checksum is unavailable.'); }
  return {format:'game-curator-steam-export', version:1, source,
    capturedAt:new Date().toISOString(), method:'browser-dom', coverage:'partial',
    warnings, diagnostics, records};
}

async function read(tab, fn, arg) {
  if (!tab?.playwright?.evaluate) throw new Error('A browser tab with read-only DOM evaluation is required');
  return tab.playwright.evaluate(fn, arg);
}

// Salted page-path checks never return or persist a raw path. They detect page
// navigation, but do not establish who is signed in or prove account continuity.
async function makePathGuard(tab) {
  let salt, first;
  try {
    salt = [...globalThis.crypto.getRandomValues(new Uint8Array(16))];
    first = await read(tab, pagePathFingerprint, {salt});
    if (typeof first !== 'string' || !/^[a-f0-9]{64}$/.test(first)) return null;
  } catch { return null; }
  return async () => {
    const current = await read(tab, pagePathFingerprint, {salt});
    if (current !== first) throw new Error('page path changed during collection');
  };
}


function interruptionClass(error) {
  const message = String(error?.message ?? error);
  if (/scroll|DOM.only|not supported|unsupported/i.test(message)) return 'scroll-unavailable';
  if (/navigat|redirect/i.test(message)) return 'navigation';
  if (/evaluat/i.test(message)) return 'evaluation';
  return 'unknown';
}

// Keep only fingerprints and fixed status codes in host state. A failed or changed
// observation after a verified start stops collection before the next merge.
function makeIdentityTracker(tab, identity) {
  if (!identity) return null;
  const salt = b64uDecode(identity.salt);
  if (!salt || salt.length !== 16) throw new Error('identity requires a valid 16-byte salt');
  const st = {checks:0, stable:true, broke:false, covered:true, first:null, last:null};
  const unavailable = () => ({version:1,sources:[],loggedIn:null,consistent:false,problems:[],saltCheck:null,sessionFingerprint:null,pathFingerprint:null,error:'observation-failed'});
  return {
    async step(owner = null) {
      const result = await collectIdentity(tab, {salt:identity.salt});
      const {available, reason, ...observed} = result;
      const shapeOk = available && observed.version === 1 && Array.isArray(observed.sources) && Array.isArray(observed.problems) && typeof observed.consistent === 'boolean' && (observed.loggedIn === true || observed.loggedIn === false || observed.loggedIn === null) && (observed.sessionFingerprint === null || typeof observed.sessionFingerprint === 'string');
      const obs = !available ? unavailable() : shapeOk ? observed : {version:1,sources:[],loggedIn:null,consistent:false,problems:['malformed-marker'],saltCheck:null,sessionFingerprint:null,pathFingerprint:null};
      obs.owner = owner;
      const good = obs.problems.length === 0 && obs.loggedIn === true && typeof obs.sessionFingerprint === 'string';
      const knownConflict = obs.problems.length > 0 || obs.loggedIn === false;
      if (st.checks === 0) st.first = good ? obs.sessionFingerprint : null;
      else if (st.first !== null && (!good || obs.sessionFingerprint !== st.first)) st.broke = true;
      else if (st.first === null && good) st.covered = false;
      if (!good) st.stable = false;
      if (knownConflict) st.broke = true;
      if (st.broke) st.stable = false;
      st.checks++; st.last = obs;
      return !st.broke;
    },
    result() { return st.last ? {...st.last,continuity:{checks:st.checks,stable:st.stable,broke:st.broke,covered:st.covered}} : undefined; },
  };
}

async function refresh(tab) {
  if (typeof tab.getAXState === 'function') await tab.getAXState({emit:false});
}

async function scroll(tab) {
  if (typeof tab.scroll === 'function') {
    try { return await tab.scroll([600, 600], 'down', 3); }
    catch (error) {
      if (!/DOM.only|not supported|unsupported/i.test(String(error.message || error))) throw error;
    }
  }
  if (tab.playwright?.locator) return tab.playwright.locator('body').press('PageDown');
  throw new Error('No supported browser scrolling operation');
}

export {normalizeLibraryRecord};

export async function collectWishlist(tab, {maxScrolls=80, identity=null} = {}) {
  if (!Number.isInteger(maxScrolls) || maxScrolls < 0 || maxScrolls > LIMIT) throw new Error('Invalid maxScrolls');
  const rowsByApp = new Map(), warnings = [], ranks = new Set();
  const pathGuard = await makePathGuard(tab), identityTracker = makeIdentityTracker(tab,identity);
  let expected = null, stagnant = 0, steps = 0, waits = 0, stopReason = null, view = null, reorderHandles = false;
  const rankOwners = new Map(), appRanks = new Map();
  const retries = new Map(), skipped = new Set();
  let quietSignature = null, observationSignature = null, quietSince = 0, settleStarted = null;
  const loaded = () => [...rowsByApp.values()].filter(r => r.complete).length;
  const missing = () => expected === null ? [] : Array.from({length:expected}, (_, i)=>i+1).filter(r=>!ranks.has(r));
  const pause = () => new Promise(resolve=>setTimeout(resolve,200));
  async function wishlistScroll(direction) {
    if (typeof tab.scroll === 'function') {
      try { return await tab.scroll([300, 500], direction, 1); }
      catch (error) { if (!/DOM.only|not supported|unsupported/i.test(String(error.message || error))) throw error; }
    }
    if (tab.playwright?.locator) return tab.playwright.locator('body').press(direction === 'up' ? 'PageUp' : 'PageDown');
    throw new Error('No supported browser scrolling operation');
  }
  try {
    let lastWindow = null;
    while (true) {
      if (pathGuard) await pathGuard();
      if (identityTracker && !await identityTracker.step()) { stopReason = 'identity-changed'; break; }
      const data = await read(tab, snapshotWishlist);
      if (pathGuard) await pathGuard();
      if (identityTracker && !await identityTracker.step(data.reorderHandles === true)) { stopReason = 'identity-changed'; break; }
      if (view !== null && (!data.view || JSON.stringify(view) !== JSON.stringify(data.view))) { stopReason = 'view-changed'; break; }
      view ??= data.view ?? null;
      if (expected !== null && data.expected !== expected) { stopReason = 'view-changed'; break; }
      expected = data.expected ?? expected;
      // Validate the entire batch before merging, including conflicts inside the batch.
      const batchRanks = new Map(rankOwners), batchApps = new Map(appRanks);
      let conflict = false;
      for (const row of data.rows) {
        if ((batchRanks.has(row.rank) && batchRanks.get(row.rank) !== row.appid) || (batchApps.has(row.appid) && batchApps.get(row.appid) !== row.rank)) { conflict = true; break; }
        batchRanks.set(row.rank, row.appid); batchApps.set(row.appid, row.rank);
      }
      if (conflict) { stopReason = 'rank-conflict'; break; }
      reorderHandles ||= data.reorderHandles === true;
      for (const [rank, appid] of batchRanks) rankOwners.set(rank, appid);
      for (const [appid, rank] of batchApps) appRanks.set(appid, rank);
      const before = loaded() + rowsByApp.size;
      for (const row of data.rows) { mergeWishlistRow(rowsByApp, row); }
      ranks.clear(); for (const row of rowsByApp.values()) if (row.complete) ranks.add(row.rank);
      // Progress counts new rows and placeholder rows that finished loading.
      stagnant = loaded() + rowsByApp.size === before ? stagnant+1 : 0;
      const ranksCovered = expected !== null && ranks.size === expected && loaded() === expected &&
        [...ranks].every(rank=>Number.isInteger(rank) && rank>=1 && rank<=expected);
      if (!pathGuard) { stopReason = 'path-unavailable'; break; }
      if (!view || view.search !== 'empty' || view.sort !== 'Your Rank') { stopReason = 'view-unverified'; break; }
      if (ranksCovered && expected > 0) {
        settleStarted ??= Date.now();
        if (Date.now() - settleStarted >= 10000) { stopReason = 'not-settled'; break; }
        const signature = JSON.stringify([...rowsByApp.values()].filter(r=>r.complete).map(r=>[r.appid,r.rank,r.name]).sort((a,b)=>a[1]-b[1]));
        const observed = JSON.stringify(data.rows.map(r=>[r.appid,r.rank,r.name,r.pageText,r.complete]).sort((a,b)=>a[1]-b[1]));
        if (signature !== quietSignature || observed !== observationSignature) { quietSignature = signature; observationSignature = observed; quietSince = Date.now(); }
        else if (Date.now() - quietSince >= 800) { stopReason = 'complete'; break; }
        await pause(); continue;
      }
      if (steps >= maxScrolls) break;
      const windowKey = data.rows.map(r=>`${r.appid}:${r.rank}:${r.complete !== false}`).join('|');
      const visibleRanks = data.rows.map(r=>r.rank).filter(Number.isInteger);
      const need = missing().find(r=>!skipped.has(r));
      const lo = Math.min(...visibleRanks), hi = Math.max(...visibleRanks);
      // Give a lazy row or unchanged virtualized window time to render, then re-read it.
      if ((need !== undefined && need >= lo && need <= hi) || (windowKey === lastWindow && stagnant > 0)) {
        const key = need ?? -1, n = (retries.get(key) || 0) + 1; retries.set(key,n);
        if (n <= 3) { waits++; await pause(); lastWindow=windowKey; continue; }
        if (need !== undefined) skipped.add(need);
        if (stagnant >= 8) break;
      }
      const target = missing().find(r=>!skipped.has(r));
      if (expected !== null && target === undefined && stagnant >= 8) break;
      const direction = target !== undefined && visibleRanks.length && target < lo ? 'up' : 'down';
      lastWindow=windowKey;
      await wishlistScroll(direction); await refresh(tab); steps++;
    }
  } catch (error) {
    if (!rowsByApp.size) throw error;
    stopReason = /page path changed during collection/.test(String(error?.message ?? '')) ? 'path-changed' : 'interrupted';
    warnings.push(`Collection interrupted after ${steps} scrolls (${stopReason === 'path-changed' ? stopReason : interruptionClass(error)}).`);
  }
  const records = toWishlistRecords(rowsByApp), placeholders = rowsByApp.size - loaded();
  if (stopReason && stopReason !== 'complete') warnings.push(`Collection stopped: ${stopReason}; later batches were not merged.`);
  if (!records.length) warnings.push('No wishlist rows found; verify authentication, page identity and selectors.');
  if (expected !== null && expected !== records.length) warnings.push(`Displayed ${expected} items; collected ${records.length} unique AppIDs.`);
  if (placeholders) warnings.push(`${placeholders} rows were still placeholders (lazy content not loaded) and were omitted rather than stored with unreliable fields.`);
  if (expected !== null && (ranks.size !== expected || ![...ranks].every(rank=>Number.isInteger(rank) && rank>=1 && rank<=expected))) warnings.push('Observed wishlist positions do not cover all displayed ranks.');
  warnings.push('Rank is a displayed row position, not verified global priority. Page-path checks do not establish signed-in account continuity; verify account, filters and membership.');
  return envelope('wishlist',records,warnings,
    {expectedCount:expected, uniqueCount:records.length, ranksObserved:ranks.size, placeholderNameRows:placeholders, missingRanks:missing(), scrollSteps:steps, stagnantSteps:stagnant, settleWaits:waits, stopReason:stopReason ?? 'partial', complete:stopReason === 'complete', pathChecked:!!pathGuard && stopReason !== 'path-changed', view, reorderHandles, ...(identityTracker?.result() ? {identity:identityTracker.result()} : {})});
}

export async function collectLibrary(tab, {maxScrolls=40, identity=null} = {}) {
  if (!Number.isInteger(maxScrolls) || maxScrolls < 0 || maxScrolls > LIMIT) throw new Error('Invalid maxScrolls');
  const records = new Map(), warnings = [];
  const pathGuard = await makePathGuard(tab), identityTracker = makeIdentityTracker(tab,identity);
  let expected = null, steps = 0, stagnant = 0, stopReason = null, view = null;
  const batch = () => read(tab, snapshotLibrary);
  let quietSignature = null, observationSignature = null, quietSince = 0, settleStarted = null;
  try {
    while (true) {
      if (pathGuard) await pathGuard();
      if (identityTracker && !await identityTracker.step()) { stopReason = 'identity-changed'; break; }
      const data = await batch();
      if (pathGuard) await pathGuard();
      const ownerNow = data.records.some(r=>/\b(DOWNLOAD|UNINSTALL|UPDATE)\b|My Game Content/.test(r.pageText ?? ''));
      if (identityTracker && !await identityTracker.step(ownerNow)) { stopReason = 'identity-changed'; break; }
      if (view !== null && (!data.view || JSON.stringify(view) !== JSON.stringify(data.view))) { stopReason = 'view-changed'; break; }
      view ??= data.view ?? null;
      if (expected !== null && expected !== data.expected) { stopReason = 'view-changed'; break; }
      expected = data.expected ?? expected;
      const before = records.size;
      for (const row of data.records) mergeLibraryRow(records, row);
      stagnant = before === records.size ? stagnant + 1 : 0;
      if (!pathGuard) { stopReason = 'path-unavailable'; break; }
      if (!view || view.search !== 'empty' || view.tab !== 'all') { stopReason = 'view-unverified'; break; }
      if (expected !== null && expected > 0 && records.size === expected) {
        settleStarted ??= Date.now();
        if (Date.now() - settleStarted >= 10000) { stopReason = 'not-settled'; break; }
        const signature = JSON.stringify([...records.values()].map(r=>[r.appid,libraryFieldsKey(r)]).sort((a,b)=>a[0]-b[0]));
        const observed = JSON.stringify(data.records.map(r=>[r.appid,libraryFieldsKey(r)]).sort((a,b)=>a[0]-b[0]));
        if (signature !== quietSignature || observed !== observationSignature) { quietSignature = signature; observationSignature = observed; quietSince = Date.now(); }
        else if (Date.now() - quietSince >= 800) { stopReason = 'complete'; break; }
        await new Promise(resolve=>setTimeout(resolve,200)); continue;
      }
      if (steps >= maxScrolls || stagnant >= 3) break;
      await scroll(tab); await refresh(tab); steps++;
    }
  } catch (error) {
    if (!records.size) throw error;
    stopReason = /page path changed during collection/.test(String(error?.message ?? '')) ? 'path-changed' : 'interrupted';
    warnings.push(`Library collection interrupted (${stopReason === 'path-changed' ? stopReason : interruptionClass(error)}).`);
  }
  if (stopReason && stopReason !== 'complete') warnings.push(`Collection stopped: ${stopReason}; later batches were not merged.`);
  warnings.push('DOM capture may omit virtualized or unloaded items; page-path checks do not establish signed-in account continuity. Verify account and source membership.');
  if (!records.size) warnings.push('No library rows found; verify authentication and selectors.');
  if (expected !== null && expected !== records.size) warnings.push(`Displayed ${expected} items; collected ${records.size} unique AppIDs.`);
  const normalized = [...records.values()].map(normalizeLibraryRecord);
  for (const row of normalized) if (row.achievements && row.achievements.unlocked > row.achievements.total) warnings.push(`AppID ${row.appid}: achievement counts are inconsistent.`);
  return envelope('library',normalized,warnings,{expectedCount:expected,uniqueCount:records.size,scrollSteps:steps,stopReason:stopReason ?? 'partial',complete:stopReason === 'complete',pathChecked:!!pathGuard && stopReason !== 'path-changed',view,ownerControls:normalized.some(r=>/\b(DOWNLOAD|UNINSTALL|UPDATE)\b|My Game Content/.test(r.pageText ?? '')), ...(identityTracker?.result() ? {identity:identityTracker.result()} : {})});
}

export async function collectReviews(tab, {maxPages=20, library=null, verifiedSameAccount=false, identity=null} = {}) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > LIMIT) throw new Error('Invalid maxPages');
  if (library !== null || verifiedSameAccount) throw new Error('Review name enrichment must use the shared saver and a verified library snapshot');
  const records = new Map(), visited = new Set(), pending = [], warnings = [];
  const identityTracker = makeIdentityTracker(tab,identity);
  let expected = null, basePath = null, attempts = 0, requestedPage = null, stopReason = null, ownerControls = true, boxesVerified = true;
  while (attempts < maxPages) {
    let data;
    try {
      attempts++;
      if (identityTracker && !await identityTracker.step()) { stopReason = 'identity-changed'; break; }
      data = await read(tab, snapshotReviews);
      if (identityTracker && !await identityTracker.step(data.ownerControls === true)) { stopReason = 'identity-changed'; break; }
      if (basePath !== null && data.path !== basePath) throw Error('Review account or source changed');
      if (expected !== null && data.expected !== expected) { if (requestedPage) pending.unshift(requestedPage); stopReason = 'view-changed'; break; }
      const current = new URL(data.url); current.search = `?p=${current.searchParams.get('p') || '1'}`; current.hash = '';
      const pageKey = current.href;
      if (requestedPage !== null && pageKey !== requestedPage) {
        pending.unshift(requestedPage);
        warnings.push('Review navigation redirected to a different page; preserving partial records.'); break;
      }
      if (visited.has(pageKey)) {
        warnings.push('Review navigation returned a previously visited page; preserving partial records.'); break;
      }
      const listPath = data.path.replace(/\/+$/, '');
      const rowsValid = data.rows.every(row => {
        try { const u = new URL(row.reviewUrl); return u.origin === current.origin && u.pathname.replace(/\/+$/, '') === `${listPath}/${row.appid}`; }
        catch { return false; }
      });
      if (!rowsValid) { if (requestedPage && !pending.includes(requestedPage)) pending.unshift(requestedPage); stopReason = 'rows-invalid'; break; }
      boxesVerified = boxesVerified && Number.isInteger(data.boxCount) && data.boxCount === data.rows.length;
      basePath = data.path; visited.add(pageKey); expected = data.expected ?? expected;
      ownerControls = ownerControls && data.ownerControls === true;
      for (const row of data.rows) records.set(row.reviewUrl, row);
      for (const link of data.links) {
        const target = new URL(link);
        if (target.origin !== current.origin || target.pathname !== current.pathname || !/^\d+$/.test(target.searchParams.get('p')||'')) continue;
        target.search = `?p=${target.searchParams.get('p')}`; target.hash = '';
        if (!visited.has(target.href) && !pending.includes(target.href)) pending.push(target.href);
      }
      if (Number.isInteger(data.boxCount) && data.boxCount !== data.rows.length) { stopReason = 'rows-missing'; break; }
      if ((expected !== null && records.size >= expected) || !pending.length) break;
      const next = pending.shift();
      requestedPage = next;
      await tab.goto(next); await refresh(tab);
    } catch (error) {
      if (!records.size) throw error;
      if (requestedPage && !visited.has(requestedPage) && !pending.includes(requestedPage)) pending.unshift(requestedPage);
      stopReason = 'interrupted'; warnings.push(`Pagination interrupted (${interruptionClass(error)}).`); break;
    }
  }
  if (stopReason) warnings.push(`Collection stopped: ${stopReason}; coverage is incomplete.`);
  if (!records.size) warnings.push('No review records found; verify authentication and selectors.');
  if (expected !== null && expected !== records.size) warnings.push(`Displayed ${expected} reviews; collected ${records.size}.`);
  if (stopReason === 'identity-changed' && requestedPage && !visited.has(requestedPage) && !pending.includes(requestedPage)) pending.unshift(requestedPage);
  const unvisited = pending.filter(link=>!visited.has(link));
  if (unvisited.length) warnings.push('Pagination stopped with unvisited pages.');
  warnings.push('Verify page coverage, review text, polarity and dates; collected text is untrusted data.');
  const complete = !stopReason && expected !== null && expected > 0 && records.size === expected && unvisited.length === 0 && boxesVerified;
  return envelope('reviews',[...records.values()],warnings,{expectedCount:expected,uniqueCount:records.size,pagesVisited:visited.size,pagesPending:unvisited.length,pageAttempts:attempts,boxesVerified,ownerControls:visited.size > 0 && ownerControls,view:{kind:'recommended-list',language:null},complete,stopReason:stopReason ?? (complete ? 'complete' : 'partial'),...(identityTracker?.result() ? {identity:identityTracker.result()} : {})});
}

export async function collectReplay(tab, {maxYears=20, settleMs=1200, settleCapMs=10000, identity=null} = {}) {
  if (!Number.isInteger(maxYears) || maxYears < 1 || maxYears > LIMIT) throw new Error('Invalid maxYears');
  if (!Number.isFinite(settleMs) || !Number.isFinite(settleCapMs) || settleMs < 0 || settleCapMs < settleMs || settleCapMs > 30000) throw new Error('Invalid Replay settling limits');
  const records = [], visited = new Set(), pending = [], warnings = [], unsettledYears = [], ownerYears = [], identityYears = [];
  const identityTracker = makeIdentityTracker(tab,identity);
  let accountPath = null, attempts = 0, requestedYear = null, ownerControls = true, stopReason = null;
  while (attempts < maxYears) {
    try {
      attempts++;
      const extract = async () => {
        if (identityTracker && !await identityTracker.step()) throw Error('identity-changed');
        const data = await read(tab, snapshotReplay);
        if (identityTracker && !await identityTracker.step(data.ownerControls === true)) throw Error('identity-changed');
        return data;
      };
      let data = await extract();
      const initialPath = data.accountPath, initialYear = data.year;
      const placeholder = text => /(^|\n)\s*LOADING\.\.\.\s*(\n|$)/i.test(text || '');
      const signature = d => d.text + '\u0000' + JSON.stringify(dedupeReplayApps(d.apps));
      const start = Date.now(); let stableSince = start, last = signature(data);
      let settled = false;
      for (;;) {
        if (!replayLoading(data.text) && !placeholder(data.text) && Date.now()-stableSince >= settleMs) { settled = true; break; }
        if (Date.now()-start >= settleCapMs) break;
        await new Promise(resolve=>setTimeout(resolve,Math.min(250, Math.max(1,settleMs), settleCapMs-(Date.now()-start))));
        data = await extract();
        if (data.accountPath !== initialPath || data.year !== initialYear) throw Error('Replay page changed while settling');
        const current = signature(data); if (current !== last) { last = current; stableSince = Date.now(); }
      }
      if (accountPath !== null && data.accountPath !== accountPath) throw Error('Replay account changed');
      if (replayLoading(data.text)) throw Error('Replay report did not finish loading');
      if (requestedYear !== null && data.year !== requestedYear) {
        warnings.push(`Replay navigation did not reach requested year ${requestedYear}; preserving partial records.`); break;
      }
      if (visited.has(data.year)) { warnings.push('Replay navigation returned a previously visited year; preserving partial records.'); break; }
      if (!settled) {
        unsettledYears.push(data.year);
        warnings.push(`The ${data.year} report did not settle before the time limit${placeholder(data.text) ? ' and still showed a LOADING... placeholder' : ''}, so its text and game references may be partial.`);
      }
      accountPath = data.accountPath; visited.add(data.year); ownerControls = ownerControls && data.ownerControls === true;
      ownerYears.push({year:data.year, ownerControls:data.ownerControls === true});
      if (identityTracker?.result()) identityYears.push({year:data.year,...identityTracker.result()});
      records.push({year:data.year,semanticText:data.text,apps:dedupeReplayApps(data.apps)});
      for (const year of replayYears(data.links, accountPath)) if (!visited.has(year) && !pending.some(x=>x.year===year)) pending.push({year,link:`https://store.steampowered.com${accountPath}/${year}`});
      if (!pending.length) break;
      const next = pending.shift(); requestedYear = next.year; await tab.goto(next.link); await refresh(tab);
    } catch (error) {
      if (!records.length) throw error;
      stopReason = String(error?.message ?? '') === 'identity-changed' ? 'identity-changed' : 'interrupted';
      warnings.push(`Replay collection interrupted (${stopReason === 'identity-changed' ? stopReason : interruptionClass(error)}).`); break;
    }
  }
  const missedYear = requestedYear !== null && !visited.has(requestedYear) && !pending.some(x=>x.year===requestedYear) ? 1 : 0;
  if (pending.length || missedYear) warnings.push('Year discovery stopped with unvisited reports.');
  warnings.push('Image-asset AppIDs are possible game references, not proof of annual play; semantic text is unstructured. Verify metrics and do not convert percentages to hours.');
  const complete = !stopReason && records.length > 0 && pending.length+missedYear === 0 && unsettledYears.length === 0;
  return envelope('replay',records,warnings,{years:records.map(r=>r.year),uniqueCount:records.length,expectedCount:records.length+pending.length+missedYear,yearsPending:pending.length+missedYear,yearAttempts:attempts,unsettledYears,truncatedYears:[],ownerControls:records.length > 0 && ownerControls,ownerYears,view:{kind:'annual-report',language:null},complete,stopReason:stopReason ?? (complete ? 'complete' : 'partial'),...(identityTracker?.result() ? {identity:identityTracker.result(),identityYears} : {})});
}

// Narrow, read-only identity observation (logged_in, steamid and accountid from Steam's page data, returned only as salted fingerprints).
// The page function is one self-contained text built from the shared identity-probe functions, so the canonicalization and fingerprint
// bytes are exactly those of the Claude page script and the saver. Respects the runtime: if page evaluation is unavailable or refused
// the result is {available:false}, which a caller must treat as "unobserved" and fall back to manual account confirmation; it is never
// reported as a match. Pass {salt} to check a binding or {candidate:true} for a first binding. Observation only: it approves nothing.
export async function collectIdentity(tab, {salt, candidate} = {}) {
  if (!tab?.playwright?.evaluate) return {available: false, reason: 'no read-only page evaluation in this runtime'};
  try {
    const isCandidate = salt === undefined && candidate === true;
    const selectedSalt = isCandidate ? b64uEncode(globalThis.crypto.getRandomValues(new Uint8Array(16))) : salt;
    if (selectedSalt === undefined) throw new Error('salt is required');
    return {available:true, ...(await tab.playwright.evaluate(codexIdentityPage, {salt:selectedSalt, candidate:isCandidate}))};
  } catch { return {available:false, reason:'page evaluation was refused or failed'}; }

}
