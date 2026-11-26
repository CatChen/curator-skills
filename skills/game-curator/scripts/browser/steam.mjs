// Browser-runtime collectors. All page evaluation reads the DOM only.
// The caller supplies a tab already opened on the verified account's source page.
import {snapshotWishlist, mergeWishlistRow, toWishlistRecords} from './wishlist-rows.mjs';
import {snapshotLibrary, mergeLibraryRow, normalizeLibraryRecord} from './library-rows.mjs';

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

export async function collectWishlist(tab, {maxScrolls=20} = {}) {
  if (!Number.isInteger(maxScrolls) || maxScrolls < 0 || maxScrolls > LIMIT) throw new Error('Invalid maxScrolls');
  const rowsByApp = new Map(), warnings = [], ranks = new Set();
  let expected = null, stagnant = 0, steps = 0;
  const loaded = () => [...rowsByApp.values()].filter(r => r.complete).length;
  try {
    while (true) {
      const data = await read(tab, snapshotWishlist); expected = data.expected ?? expected;
      const before = loaded() + rowsByApp.size;
      for (const row of data.rows) { mergeWishlistRow(rowsByApp, row); }
      ranks.clear(); for (const row of rowsByApp.values()) if (row.complete) ranks.add(row.rank);
      // Progress counts new rows and placeholder rows that finished loading.
      stagnant = loaded() + rowsByApp.size === before ? stagnant+1 : 0;
      const ranksCovered = expected !== null && ranks.size === expected && loaded() === expected &&
        [...ranks].every(rank=>Number.isInteger(rank) && rank>=1 && rank<=expected);
      if (steps >= maxScrolls || ranksCovered || stagnant >= 3) break;
      await scroll(tab); await refresh(tab); steps++;
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
    {expectedCount:expected, uniqueCount:records.length, ranksObserved:ranks.size, placeholderNameRows:placeholders, scrollSteps:steps, stagnantSteps:stagnant});
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
      data = await read(tab, () => {
        if (location.protocol !== 'https:' || location.hostname !== 'steamcommunity.com' || !/\/recommended\/?$/.test(location.pathname)) throw Error('Open the verified Steam Community reviews page');
        const count = document.body.innerText.match(/Showing\s+\d+\s*-\s*\d+\s+of\s+([\d,]+)\s+entries/i);
        const rows = [...document.querySelectorAll('.review_box')].map(row => {
          const a = row.querySelector('.title a[href*="/recommended/"]'), id = a?.href.match(/\/recommended\/(\d+)\/?/);
          const polarity = a?.innerText.trim();
          return {appid:id ? Number(id[1]) : null, reviewUrl:a?.href.split('?')[0]||null,
            recommended:polarity === 'Recommended' ? true : polarity === 'Not Recommended' ? false : null,
            review:row.querySelector('.content')?.innerText.trim()||null,
            playtimeDisplay:row.querySelector('.hours')?.innerText.trim()||null,
            postedDate:row.querySelector('.posted')?.innerText.trim()||null};
        }).filter(x=>x.appid && x.reviewUrl);
        const links = [...document.querySelectorAll('.workshopBrowsePagingControls a.pagelink[href]')].map(a=>a.href).filter(h=>{try{let u=new URL(h);return u.origin===location.origin && u.pathname===location.pathname && /^\d+$/.test(u.searchParams.get('p')||'')}catch{return false}});
        const current = new URL(location.href); current.search = `?p=${current.searchParams.get('p') || '1'}`;
        return {url:current.href, path:location.pathname, expected:count?Number(count[1].replace(/,/g,'')):null, rows, links};
      });
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

export async function collectReplay(tab, {maxYears=20} = {}) {
  if (!Number.isInteger(maxYears) || maxYears < 1 || maxYears > LIMIT) throw new Error('Invalid maxYears');
  const records = [], visited = new Set(), pending = [], warnings = [];
  let accountPath = null, attempts = 0, requestedYear = null;
  while (attempts < maxYears) {
    try {
      attempts++;
      const extract = () => read(tab, () => {
        if (location.protocol !== 'https:' || location.hostname !== 'store.steampowered.com') throw Error('Open a verified Steam Replay page');
        const m = location.pathname.match(/^(\/replay\/[^/]+)\/(20\d{2})\/?$/);
        if (!m) throw Error('Open an annual Steam Replay page');
        const content = document.querySelector('.responsive_page_template_content');
        const text = content?.innerText.trim() || '';
        const links = [...document.querySelectorAll('a[href]')].map(a=>a.href).filter(h=>{try{let u=new URL(h);return u.origin===location.origin && u.pathname.startsWith(m[1]+'/') && /\/20\d{2}\/?$/.test(u.pathname)}catch{return false}});
        const apps = [...content?.querySelectorAll('a[href*="/app/"]') || []].map(a=>{const id=a.href.match(/\/app\/(\d+)/);return id?{appid:Number(id[1]),name:a.innerText.trim()||a.querySelector('img')?.alt||null,source:'app-link'}:null}).filter(Boolean);
        for (const img of content?.querySelectorAll('img[src]') || []) {
          const id=(img.getAttribute('src')||'').match(/\/steam\/apps\/(\d+)\//);
          if (id) apps.push({appid:Number(id[1]),name:img.alt?.trim()||null,source:'image-asset'});
        }
        return {year:Number(m[2]), accountPath:m[1], text, links, apps};
      });
      let data = await extract();
      for (let attempt=0; attempt<8 && (!data.text || /^(LOADING\.\.\.)$/i.test(data.text)); attempt++) {
        await new Promise(resolve=>setTimeout(resolve,500));
        data = await extract();
      }
      if (accountPath !== null && data.accountPath !== accountPath) throw Error('Replay account changed');
      if (!data.text || /^(LOADING\.\.\.)$/i.test(data.text)) throw Error('Replay report did not finish loading');
      if (requestedYear !== null && data.year !== requestedYear) {
        warnings.push(`Replay navigation did not reach requested year ${requestedYear}; preserving partial records.`); break;
      }
      if (visited.has(data.year)) { warnings.push('Replay navigation returned a previously visited year; preserving partial records.'); break; }
      accountPath = data.accountPath; visited.add(data.year);
      const apps = new Map();
      for (const app of data.apps) {
        const prior = apps.get(app.appid);
        if (!prior || (prior.source === 'image-asset' && app.source === 'app-link')) apps.set(app.appid,app);
      }
      records.push({year:data.year,semanticText:data.text,apps:[...apps.values()]});
      for (const link of data.links) {const year=Number(new URL(link).pathname.match(/\/(20\d{2})\/?$/)?.[1]);if(year&&!visited.has(year)&&!pending.some(x=>x.year===year))pending.push({year,link});}
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
  return envelope('replay',records,warnings,{years:records.map(r=>r.year),yearsPending:pending.length+missedYear,yearAttempts:attempts});
}
