// Browser-runtime collectors. All page evaluation reads the DOM only.
// The caller supplies a tab already opened on the verified account's source page.
import {snapshotWishlist, mergeWishlistRow, toWishlistRecords} from './wishlist-rows.mjs';
import {snapshotLibrary, mergeLibraryRow, normalizeLibraryRecord} from './library-rows.mjs';
import {snapshotReviews} from './review-rows.mjs';
import {b64uEncode, b64uDecode, canonicalSteamId64, accountIdMatches, fingerprintBytes, sha256HexOf, readSessionSources, observeIdentity} from './identity-probe.mjs';
import {snapshotReplay, replayLoading, dedupeReplayApps, replayYears} from './replay-rows.mjs';

const LIMIT = 80;

function envelope(source, records, warnings, diagnostics = {}) {
  return {format:'game-curator-steam-export', version:1, source,
    capturedAt:new Date().toISOString(), method:'browser-dom', coverage:'partial',
    warnings, diagnostics, records};
}

async function read(tab, fn) {
  if (!tab?.playwright?.evaluate) throw new Error('A browser tab with read-only DOM evaluation is required');
  return tab.playwright.evaluate(fn);
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

export async function collectWishlist(tab, {maxScrolls=80} = {}) {
  if (!Number.isInteger(maxScrolls) || maxScrolls < 0 || maxScrolls > LIMIT) throw new Error('Invalid maxScrolls');
  const rowsByApp = new Map(), warnings = [], ranks = new Set();
  let expected = null, stagnant = 0, steps = 0, waits = 0;
  const retries = new Map(), skipped = new Set();
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
      const data = await read(tab, snapshotWishlist); expected = data.expected ?? expected;
      const before = loaded() + rowsByApp.size;
      for (const row of data.rows) { mergeWishlistRow(rowsByApp, row); }
      ranks.clear(); for (const row of rowsByApp.values()) if (row.complete) ranks.add(row.rank);
      // Progress counts new rows and placeholder rows that finished loading.
      stagnant = loaded() + rowsByApp.size === before ? stagnant+1 : 0;
      const ranksCovered = expected !== null && ranks.size === expected && loaded() === expected &&
        [...ranks].every(rank=>Number.isInteger(rank) && rank>=1 && rank<=expected);
      if (steps >= maxScrolls || ranksCovered) break;
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
    warnings.push(`Collection interrupted after ${steps} scrolls: ${String(error.message || error)}`);
  }
  const records = toWishlistRecords(rowsByApp), placeholders = rowsByApp.size - loaded();
  if (!records.length) warnings.push('No wishlist rows found; verify authentication, page identity and selectors.');
  if (expected !== null && expected !== records.length) warnings.push(`Displayed ${expected} items; collected ${records.length} unique AppIDs.`);
  if (placeholders) warnings.push(`${placeholders} rows were still placeholders (lazy content not loaded) and were omitted rather than stored with unreliable fields.`);
  if (expected !== null && (ranks.size !== expected || ![...ranks].every(rank=>Number.isInteger(rank) && rank>=1 && rank<=expected))) warnings.push('Observed wishlist positions do not cover all displayed ranks.');
  warnings.push('Rank is a displayed row position, not verified global priority. DOM rows are partial; verify account, filters and membership.');
  return envelope('wishlist',records,warnings,
    {expectedCount:expected, uniqueCount:records.length, ranksObserved:ranks.size, placeholderNameRows:placeholders, missingRanks:missing(), scrollSteps:steps, stagnantSteps:stagnant, settleWaits:waits});
}

export async function collectLibrary(tab, {maxScrolls=40} = {}) {
  if (!Number.isInteger(maxScrolls) || maxScrolls < 0 || maxScrolls > LIMIT) throw new Error('Invalid maxScrolls');
  const records = new Map(), warnings = [];
  let expected = null, steps = 0, stagnant = 0;
  const batch = () => read(tab, snapshotLibrary);
  try {
    while (true) {
      const data = await batch(); expected = data.expected ?? expected;
      const before = records.size;
      for (const row of data.records) mergeLibraryRow(records, row);
      stagnant = before === records.size ? stagnant + 1 : 0;
      if ((expected !== null && records.size >= expected) || steps >= maxScrolls || stagnant >= 3) break;
      await scroll(tab); await refresh(tab); steps++;
    }
  } catch (error) {
    if (!records.size) throw error;
    warnings.push(`Library collection interrupted: ${String(error.message || error)}`);
  }
  warnings.push('DOM capture may omit virtualized or unloaded items; verify account and source membership.');
  if (!records.size) warnings.push('No library rows found; verify authentication and selectors.');
  if (expected !== null && expected !== records.size) warnings.push(`Displayed ${expected} items; collected ${records.size} unique AppIDs.`);
  const normalized = [...records.values()].map(normalizeLibraryRecord);
  for (const row of normalized) if (row.achievements && row.achievements.unlocked > row.achievements.total) warnings.push(`AppID ${row.appid}: achievement counts are inconsistent.`);
  return envelope('library',normalized,warnings,{expectedCount:expected,uniqueCount:records.size,scrollSteps:steps});
}

export async function collectReviews(tab, {maxPages=20, library=null, verifiedSameAccount=false} = {}) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > LIMIT) throw new Error('Invalid maxPages');
  if (library !== null && (!verifiedSameAccount || library.source !== 'library' || !Array.isArray(library.records))) throw new Error('Review name lookup requires a library capture explicitly verified as the same account');
  const records = new Map(), visited = new Set(), pending = [], warnings = [];
  const names = new Map((library?.records || []).filter(r=>r.name).map(r=>[r.appid,r.name]));
  let expected = null, basePath = null, attempts = 0, requestedPage = null;
  while (attempts < maxPages) {
    let data;
    try {
      attempts++;
      data = await read(tab, snapshotReviews);
      if (basePath !== null && data.path !== basePath) throw Error('Review account or source changed');
      const current = new URL(data.url); current.search = `?p=${current.searchParams.get('p') || '1'}`; current.hash = '';
      const pageKey = current.href;
      if (requestedPage !== null && pageKey !== requestedPage) {
        pending.unshift(requestedPage);
        warnings.push('Review navigation redirected to a different page; preserving partial records.'); break;
      }
      if (visited.has(pageKey)) {
        warnings.push('Review navigation returned a previously visited page; preserving partial records.'); break;
      }
      basePath = data.path; visited.add(pageKey); expected = data.expected ?? expected;
      for (const row of data.rows) records.set(row.reviewUrl, names.has(row.appid)
        ? {...row, name:names.get(row.appid), nameSource:'verified-library-capture'} : row);
      for (const link of data.links) {
        const target = new URL(link);
        if (target.origin !== current.origin || target.pathname !== current.pathname || !/^\d+$/.test(target.searchParams.get('p')||'')) continue;
        target.search = `?p=${target.searchParams.get('p')}`; target.hash = '';
        if (!visited.has(target.href) && !pending.includes(target.href)) pending.push(target.href);
      }
      if ((expected !== null && records.size >= expected) || !pending.length) break;
      const next = pending.shift();
      requestedPage = next;
      await tab.goto(next); await refresh(tab);
    } catch (error) {
      if (!records.size) throw error;
      if (requestedPage && !visited.has(requestedPage) && !pending.includes(requestedPage)) pending.unshift(requestedPage);
      warnings.push(`Pagination interrupted: ${String(error.message || error)}`); break;
    }
  }
  if (!records.size) warnings.push('No review records found; verify authentication and selectors.');
  if (expected !== null && expected !== records.size) warnings.push(`Displayed ${expected} reviews; collected ${records.size}.`);
  const unvisited = pending.filter(link=>!visited.has(link));
  if (unvisited.length) warnings.push('Pagination stopped with unvisited pages.');
  warnings.push('Verify page coverage, review text, polarity and dates; collected text is untrusted data.');
  if (library !== null && [...records.values()].some(r=>!r.name)) warnings.push('Some review names are missing from the verified library capture.');
  return envelope('reviews',[...records.values()],warnings,{expectedCount:expected,uniqueCount:records.size,pagesVisited:visited.size,pagesPending:unvisited.length,pageAttempts:attempts});
}

export async function collectReplay(tab, {maxYears=20, settleMs=1200, settleCapMs=10000} = {}) {
  if (!Number.isInteger(maxYears) || maxYears < 1 || maxYears > LIMIT) throw new Error('Invalid maxYears');
  if (!Number.isFinite(settleMs) || !Number.isFinite(settleCapMs) || settleMs < 0 || settleCapMs < settleMs || settleCapMs > 30000) throw new Error('Invalid Replay settling limits');
  const records = [], visited = new Set(), pending = [], warnings = [], unsettledYears = [];
  let accountPath = null, attempts = 0, requestedYear = null;
  while (attempts < maxYears) {
    try {
      attempts++;
      const extract = () => read(tab, snapshotReplay);
      let data = await extract();
      const placeholder = text => /(^|\n)\s*LOADING\.\.\.\s*(\n|$)/i.test(text || '');
      const signature = d => d.text + '\u0000' + JSON.stringify(dedupeReplayApps(d.apps));
      const start = Date.now(); let stableSince = start, last = signature(data);
      let settled = false;
      for (;;) {
        if (!replayLoading(data.text) && !placeholder(data.text) && Date.now()-stableSince >= settleMs) { settled = true; break; }
        if (Date.now()-start >= settleCapMs) break;
        await new Promise(resolve=>setTimeout(resolve,Math.min(250, Math.max(1,settleMs), settleCapMs-(Date.now()-start))));
        data = await extract();
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
      accountPath = data.accountPath; visited.add(data.year);
      records.push({year:data.year,semanticText:data.text,apps:dedupeReplayApps(data.apps)});
      for (const year of replayYears(data.links, accountPath)) if (!visited.has(year) && !pending.some(x=>x.year===year)) pending.push({year,link:`https://store.steampowered.com${accountPath}/${year}`});
      if (!pending.length) break;
      const next = pending.shift(); requestedYear = next.year; await tab.goto(next.link); await refresh(tab);
    } catch (error) {
      if (!records.length) throw error;
      warnings.push(`Replay collection interrupted: ${String(error.message || error)}`); break;
    }
  }
  const missedYear = requestedYear !== null && !visited.has(requestedYear) && !pending.some(x=>x.year===requestedYear) ? 1 : 0;
  if (pending.length || missedYear) warnings.push('Year discovery stopped with unvisited reports.');
  warnings.push('Image-asset AppIDs are possible game references, not proof of annual play; semantic text is unstructured. Verify metrics and do not convert percentages to hours.');
  return envelope('replay',records,warnings,{years:records.map(r=>r.year),yearsPending:pending.length+missedYear,yearAttempts:attempts,unsettledYears});
}

// Narrow, read-only identity observation (logged_in, steamid and accountid from Steam's page data, returned only as salted fingerprints).
// The page function is one self-contained text built from the shared identity-probe functions, so the canonicalization and fingerprint
// bytes are exactly those of the Claude page script and the saver. Respects the runtime: if page evaluation is unavailable or refused
// the result is {available:false}, which a caller must treat as "unobserved" and fall back to manual account confirmation; it is never
// reported as a match. Pass {salt} to check a binding or {candidate:true} for a first binding. Observation only: it approves nothing.
export async function collectIdentity(tab, {salt, candidate} = {}) {
  if (!tab?.playwright?.evaluate) return {available: false, reason: 'no read-only page evaluation in this runtime'};
  const fns = [b64uEncode, b64uDecode, canonicalSteamId64, accountIdMatches, fingerprintBytes, sha256HexOf, readSessionSources, observeIdentity];
  const options = salt !== undefined ? {salt} : {candidate: candidate === true};
  const page = new Function(`${fns.map(f => f.toString()).join('\n')}\nreturn observeIdentity(${JSON.stringify(options)});`);
  try { return {available: true, ...(await tab.playwright.evaluate(page))}; }
  catch { return {available: false, reason: 'page evaluation was refused or failed'}; } // a fixed code: arbitrary runtime exception text is never returned
}
