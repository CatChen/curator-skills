// Amazon Manage Your Content and Devices: read-only DOM extraction and pagination.
// The caller navigates to the correct unfiltered category and verifies the account.
export function scanPage() {
  const text = e => e?.textContent?.trim() || null;
  const path = location.pathname;
  const category = location.hostname === 'www.amazon.com' && /\/hz\/mycd\/digital-console\/contentlist\/booksAll\//.test(path) ? 'books' : location.hostname === 'www.amazon.com' && /\/hz\/mycd\/digital-console\/contentlist\/pdocs\//.test(path) ? 'docs' : null;
  const challenge = !!document.querySelector('#tmms-challenge, #continueCheck, #auth-captcha-guess') || /\/checkpoint\/|\/ap\/signin/.test(path);
  if (challenge || !category) return {category:null, challenge, path, range:null, rows:[], pageNumbers:[]};
  const countText = text(document.querySelector('#CONTENT_COUNT'));
  const match = countText?.match(/Showing\s+([\d,]+)\s+to\s+([\d,]+)\s+of\s+([\d,]+)\s+items/i);
  const range = match ? match.slice(1).map(x => Number(x.replaceAll(',', ''))) : null;
  const rows = [...document.querySelectorAll('tr[role="listitem"]')].map(row => {
    const input = row.querySelector('input[type="checkbox"][id*="Kindle"]');
    const raw = input?.id || '';
    const split = raw.indexOf(':');
    const sourceId = split < 0 ? null : raw.slice(0, split);
    const sourceType = split < 0 ? null : raw.slice(split + 1);
    const details = row.querySelector('.digital_entity_details');
    const field = prefix => text(details?.querySelector(`[id^="${prefix}"]`));
    const direct = [...(details?.children || [])];
    const docTitle = details?.querySelector('.digital_entity_title_no_link');
    const docAuthor = direct.find(e => e.classList.contains('information_row'));
    const size = direct.filter(e => e.classList.contains('information_row'))[1];
    return {sourceId, sourceType, category, title: field('content-title-') || text(docTitle),
      author: field('content-author-') || (category === 'docs' ? text(docAuthor) : null),
      dateLabel: field('content-acquired-date-'), sizeLabel: category === 'docs' ? text(size) : null,
      sample: sourceType === 'KindleEBookSample' ? true : null,
      readLabel: text(details?.querySelector('#content-read-badge'))};
  });
  return {category, path, countText, range, rows, pageNumbers: [...document.querySelectorAll('#pagination [id^=\"page-\"]')].map(e => e.id.slice(5)).filter(x => /^\d+$/.test(x)).map(Number)};
}

export function assessPages(pages, category, failure = null) {
  const warnings = [], records = [], seen = new Map(), ranges = [];
  let total = null, expected = 1, duplicateCount = 0, missingIds = 0;
  for (const page of pages) {
    if (page.category !== category || !page.range || page.range.length !== 3) { warnings.push('Unexpected category or unrecognized displayed count'); break; }
    const [start, end, observedTotal] = page.range;
    if (total === null) total = observedTotal;
    if (observedTotal !== total || start !== expected || end < start || end > observedTotal) warnings.push('Displayed totals or page ranges changed or have gaps');
    if (page.rows.length !== end - start + 1) warnings.push('Displayed row count differs from range');
    ranges.push({start, end, total: observedTotal}); expected = end + 1;
    for (const row of page.rows) {
      if (!row.sourceId || !row.sourceType) { missingIds++; records.push(row); continue; }
      const key = `${row.sourceType}:${row.sourceId}`;
      if (seen.has(key)) { duplicateCount++; records.push(row); } else { seen.set(key, true); records.push(row); }
    }
  }
  if (failure) warnings.push(`Collection stopped: ${failure}`);
  if (duplicateCount) warnings.push('Duplicate source identifiers retained');
  if (missingIds) warnings.push('Rows with missing identifiers retained');
  const enumerationMatched = warnings.length === 0 && total !== null && expected === total + 1 && records.length === total && seen.size === total;
  if (records.some(r => !r.title || !r.author || !r.dateLabel)) warnings.push('Some records have missing title, author or date');
  const complete = enumerationMatched && !records.some(r => !r.title || !r.author || !r.dateLabel);
  if (!complete) warnings.push('Coverage is partial or unverified');
  return {format:'book-curator-amazon-content',version:1,source:'amazon-content-management',category,
    capturedAt:new Date().toISOString(),method:'read-only-dom-pagination',account:null,accessScope:'unknown',
    coverage:complete ? 'complete-observed' : 'partial',warnings,
    diagnostics:{displayedTotal:total,ranges,recordCount:records.length,uniqueCount:seen.size,duplicateCount,missingIds,missingMetadata:records.filter(r => !r.title || !r.author || !r.dateLabel).length, enumerationMatched},records};
}

export async function collectCategory(tab, category, options = {}) {
  if (!['books','docs'].includes(category)) throw new Error('Unsupported category');
  const pages = []; let failure = null;
  const maxPages = options.maxPages ?? 100;
  const attempts = options.settleAttempts ?? 20;
  const delay = options.settleDelayMs ?? 250;
  const signature = p => JSON.stringify([p.range, p.rows.map(r => [r.sourceType, r.sourceId])]);
  const coherent = p => Array.isArray(p.range) && p.range.length === 3 && p.range.every(Number.isSafeInteger) && p.range[0] >= 1 && p.range[1] >= p.range[0] && p.range[1] <= p.range[2] && p.rows.length === p.range[1] - p.range[0] + 1;
  async function settled(expectedStart) {
    let last = null;
    for (let n = 0; n < attempts; n++) {
      const p = await tab.playwright.evaluate(scanPage);
      if (p.challenge) return {failure:'human verification or sign-in required'};
      if (p.category !== category) return {failure:'unexpected source or category'};
      if (coherent(p) && p.range[0] === expectedStart) {
        const sig = signature(p);
        if (sig === last) return {page:p};
        last = sig;
      } else last = null;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    return {failure:'page did not settle at expected range'};
  }
  try {
    let expected = 1;
    for (let n = 0; n < maxPages; n++) {
      const result = await settled(expected);
      if (result.failure) { failure = result.failure; break; }
      const page = result.page;
      pages.push(page);
      if (page.range[1] >= page.range[2]) break;
      const nextNumber = Math.floor((page.range[0] - 1) / (page.range[1] - page.range[0] + 1)) + 2;
      // Re-read immediately before the click, checking both coherent range and control.
      const before = await tab.playwright.evaluate(scanPage);
      if (before.challenge) { failure = 'human verification or sign-in required'; break; }
      if (before.category !== category) { failure = 'unexpected source or category'; break; }
      if (!coherent(before) || signature(before) !== signature(page) || !before.pageNumbers.includes(nextNumber)) { failure = 'current page or next numbered control changed'; break; }
      await tab.playwright.locator(`#page-${nextNumber}`).click({timeout:5000});
      expected = page.range[1] + 1;
      if (n === maxPages - 1) failure = 'page limit reached';
    }
  } catch (error) { failure = `browser operation failed (${error?.name || 'Error'})`; }
  return assessPages(pages, category, failure);
}
