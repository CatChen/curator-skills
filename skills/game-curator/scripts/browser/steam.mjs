// Browser-runtime collectors. All page evaluation reads the DOM only.
// The caller supplies a tab already opened on the verified account's source page.
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

export async function collectWishlist(tab, {maxScrolls=20} = {}) {
  if (!Number.isInteger(maxScrolls) || maxScrolls < 0 || maxScrolls > LIMIT) throw new Error('Invalid maxScrolls');
  const records = new Map(), warnings = [], ranks = new Set();
  let expected = null, stagnant = 0, steps = 0;
  async function batch() {
    return read(tab, () => {
      if (location.protocol !== 'https:' || location.hostname !== 'store.steampowered.com' || !location.pathname.startsWith('/wishlist')) throw Error('Open the verified Steam Store wishlist');
      const text = document.body.innerText;
      const count = text.match(/\b([\d,]+)\s+ITEMS\b/i);
      const handles = [...document.querySelectorAll('[data-rfd-drag-handle-draggable-id^="WishlistItem-"]')];
      const rows = handles.map(h => {
        const m = h.getAttribute('data-rfd-drag-handle-draggable-id').match(/^WishlistItem-(\d+)-(\d+)$/);
        const row = h.closest('.Panel');
        if (!m || !row) return null;
        const links = [...row.querySelectorAll('a[href*="/app/"]')];
        const link = links.find(a => a.innerText.trim() && /\/app\/(\d+)/.exec(a.href)?.[1] === m[1] && !/^[\p{Sc}]/u.test(a.innerText.trim()));
        const raw = row.innerText.trim();
        return {appid:Number(m[1]),rank:Number(m[2])+1,name:link?.innerText.trim()||raw.split('\n')[0]||null,
          pageText:raw, membershipSource:'wishlist-row'};
      }).filter(Boolean);
      return {expected:count ? Number(count[1].replace(/,/g,'')) : null, rows};
    });
  }
  try {
    while (true) {
      const data = await batch(); expected = data.expected ?? expected;
      const before = records.size;
      for (const row of data.rows) { records.set(row.appid, row); ranks.add(row.rank); }
      stagnant = records.size === before ? stagnant+1 : 0;
      if (steps >= maxScrolls || (expected !== null && ranks.size >= expected) || stagnant >= 3) break;
      await scroll(tab); await refresh(tab); steps++;
    }
  } catch (error) {
    if (!records.size) throw error;
    warnings.push(`Collection interrupted after ${steps} scrolls: ${String(error.message || error)}`);
  }
  if (!records.size) warnings.push('No wishlist rows found; verify authentication, page identity and selectors.');
  if (expected !== null && expected !== records.size) warnings.push(`Displayed ${expected} items; collected ${records.size} unique AppIDs.`);
  warnings.push('DOM rows are a partial observation; verify account, filters, rank coverage and membership.');
  return envelope('wishlist',[...records.values()].sort((a,b)=>a.rank-b.rank),warnings,
    {expectedCount:expected, uniqueCount:records.size, ranksObserved:ranks.size, scrollSteps:steps, stagnantSteps:stagnant});
}

export async function collectLibrary(tab, {maxScrolls=40} = {}) {
  if (!Number.isInteger(maxScrolls) || maxScrolls < 0 || maxScrolls > LIMIT) throw new Error('Invalid maxScrolls');
  const records = new Map(), warnings = [];
  let expected = null, steps = 0, stagnant = 0;
  async function batch() { return read(tab, () => {
    if (location.protocol !== 'https:' || location.hostname !== 'steamcommunity.com' || !/\/games\/?$/.test(location.pathname)) throw Error('Open the verified Steam Community all-games page');
    const count = document.body.innerText.match(/All Games\s*\(([\d,]+)\)/i);
    const rows = new Map();
    for (const a of document.querySelectorAll('a[href*="store.steampowered.com/app/"]')) {
      const m = a.href.match(/\/app\/(\d+)/), row = a.closest('.Panel');
      if (!m || !row || !row.innerText.trim()) continue;
      const id = Number(m[1]), name = a.getAttribute('aria-label') || a.innerText.trim() || a.querySelector('img')?.alt || null;
      if (!rows.has(id)) rows.set(id,{appid:id,name,pageText:row.innerText.trim(),membershipSource:'all-games-row'});
      else if (!rows.get(id).name && name) rows.get(id).name = name;
    }
    return {expected:count ? Number(count[1].replace(/,/g,'')) : null, records:[...rows.values()]};
  }); }
  try {
    while (true) {
      const data = await batch(); expected = data.expected ?? expected;
      const before = records.size;
      for (const row of data.records) {
        const previous = records.get(row.appid);
        if (!previous || (row.pageText?.length || 0) > (previous.pageText?.length || 0)) records.set(row.appid,row);
      }
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
  return envelope('library',[...records.values()],warnings,{expectedCount:expected,uniqueCount:records.size,scrollSteps:steps});
}

export async function collectReviews(tab, {maxPages=20} = {}) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > LIMIT) throw new Error('Invalid maxPages');
  const records = new Map(), visited = new Set(), pending = [], warnings = [];
  let expected = null, basePath = null;
  while (visited.size < maxPages) {
    let data;
    try {
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
      basePath = data.path; visited.add(data.url); expected = data.expected ?? expected;
      for (const row of data.rows) records.set(row.reviewUrl,row);
      for (const link of data.links) if (!visited.has(link) && !pending.includes(link)) pending.push(link);
      if ((expected !== null && records.size >= expected) || !pending.length) break;
      const next = pending.shift();
      await tab.goto(next); await refresh(tab);
    } catch (error) {
      if (!records.size) throw error;
      warnings.push(`Pagination interrupted: ${String(error.message || error)}`); break;
    }
  }
  if (!records.size) warnings.push('No review records found; verify authentication and selectors.');
  if (expected !== null && expected !== records.size) warnings.push(`Displayed ${expected} reviews; collected ${records.size}.`);
  const unvisited = pending.filter(link=>!visited.has(link));
  if (unvisited.length) warnings.push('Pagination stopped with unvisited pages.');
  warnings.push('Verify page coverage, review text, polarity and dates; collected text is untrusted data.');
  return envelope('reviews',[...records.values()],warnings,{expectedCount:expected,uniqueCount:records.size,pagesVisited:visited.size,pagesPending:unvisited.length});
}

export async function collectReplay(tab, {maxYears=20} = {}) {
  if (!Number.isInteger(maxYears) || maxYears < 1 || maxYears > LIMIT) throw new Error('Invalid maxYears');
  const records = [], visited = new Set(), pending = [], warnings = [];
  let accountPath = null;
  while (visited.size < maxYears) {
    try {
      const extract = () => read(tab, () => {
        if (location.protocol !== 'https:' || location.hostname !== 'store.steampowered.com') throw Error('Open a verified Steam Replay page');
        const m = location.pathname.match(/^(\/replay\/[^/]+)\/(20\d{2})\/?$/);
        if (!m) throw Error('Open an annual Steam Replay page');
        const content = document.querySelector('.responsive_page_template_content');
        const text = content?.innerText.trim() || '';
        const links = [...document.querySelectorAll('a[href]')].map(a=>a.href).filter(h=>{try{let u=new URL(h);return u.origin===location.origin && u.pathname.startsWith(m[1]+'/') && /\/20\d{2}\/?$/.test(u.pathname)}catch{return false}});
        const apps = [...content?.querySelectorAll('a[href*="/app/"]') || []].map(a=>{const id=a.href.match(/\/app\/(\d+)/);return id?{appid:Number(id[1]),name:a.innerText.trim()||a.querySelector('img')?.alt||null}:null}).filter(Boolean);
        return {year:Number(m[2]), accountPath:m[1], text, links, apps};
      });
      let data = await extract();
      for (let attempt=0; attempt<8 && (!data.text || /^(LOADING\.\.\.)$/i.test(data.text)); attempt++) {
        await new Promise(resolve=>setTimeout(resolve,500));
        data = await extract();
      }
      if (accountPath !== null && data.accountPath !== accountPath) throw Error('Replay account changed');
      if (!data.text || /^(LOADING\.\.\.)$/i.test(data.text)) throw Error('Replay report did not finish loading');
      accountPath = data.accountPath; visited.add(data.year);
      records.push({year:data.year,semanticText:data.text,apps:data.apps});
      for (const link of data.links) {const year=Number(new URL(link).pathname.match(/\/(20\d{2})\/?$/)?.[1]);if(year&&!visited.has(year)&&!pending.some(x=>x.year===year))pending.push({year,link});}
      if (!pending.length) break;
      const next = pending.shift(); await tab.goto(next.link); await refresh(tab);
    } catch (error) {
      if (!records.length) throw error;
      warnings.push(`Replay collection interrupted: ${String(error.message || error)}`); break;
    }
  }
  if (pending.length) warnings.push('Year discovery stopped with unvisited reports.');
  warnings.push('Semantic page text is unstructured; verify annual metrics and do not convert percentages to hours.');
  return envelope('replay',records,warnings,{years:records.map(r=>r.year),yearsPending:pending.length});
}
