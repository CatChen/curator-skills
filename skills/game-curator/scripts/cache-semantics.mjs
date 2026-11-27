// Conservative comparison of observed records. Unknown text remains significant.
// This module never changes a capture or infers identity, completeness or consent.
const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
};

// The library client can add or remove these installation controls independently
// of library membership and activity. Do not remove other unrecognized text.
export function libraryText(text) {
  if (typeof text !== 'string') return text;
  const lines = text.split('\n');
  const control = line => /^\s*(?:DOWNLOAD|UNINSTALL|UPDATE|INSTALL)\s*$/i.test(line ?? '');
  const size = line => /^\s*(?:[\d,.]+\s*(?:bytes?|[kmgt]i?b))\s*$/i.test(line ?? '');
  return lines.filter((line, i) => !control(line) && !(size(line) && (control(lines[i - 1]) || control(lines[i + 1])))).join('\n');
}

export function wishlistText(text) {
  return typeof text === 'string' ? text.split('\n').filter(line => !/^\s*(?:ADD TO CART|IN CART|REMOVE FROM WISHLIST)\s*$/i.test(line)).join('\n') : text;
}

export function meaningfulRecords(capture) {
  if (!capture || !Array.isArray(capture.records)) return null;
  const records = capture.records.map(record => {
    if (!record || typeof record !== 'object') return record;
    if (capture.source === 'library') return {...record, pageText: libraryText(record.pageText)};
    if (capture.source === 'wishlist') return {...record, pageText: wishlistText(record.pageText)};
    // Wishlist page text includes release information, reviews, tags and prices.
    // Reviews include the review itself and Replay contains annual statistics.
    // Until a presentation fragment is recognized, retain it in the comparison.
    return record;
  });
  if (capture.source === 'replay') records.sort((a, b) => (a?.year ?? 0) - (b?.year ?? 0));
  else if (['library', 'reviews', 'wishlist'].includes(capture.source)) records.sort((a, b) => (a?.appid ?? 0) - (b?.appid ?? 0));
  else return null;
  return JSON.stringify(stable(records));
}

export function equivalentRecords(a, b) {
  if (!a || !b || a.source !== b.source) return false;
  const left = meaningfulRecords(a), right = meaningfulRecords(b);
  return left !== null && left === right;
}

// Detect evidence that disappeared, rather than ordinary substitutions. Unknown
// text is never ignored; uncertain one-for-one edits remain meaningful changes.
export function textCoverageLost(source, oldText, newText) {
  const clean = source === 'library' ? libraryText : source === 'wishlist' ? wishlistText : x => x;
  const oldLines = String(clean(oldText) ?? '').split('\n').map(x => x.trim()).filter(Boolean);
  const newLines = String(clean(newText) ?? '').split('\n').map(x => x.trim()).filter(Boolean);
  const remaining = [...newLines];
  const removed = [];
  for (const line of oldLines) { const i = remaining.indexOf(line); if (i < 0) removed.push(line); else remaining.splice(i, 1); }
  if (removed.length > remaining.length) return true;
  // A shortened section that is plainly contained in its predecessor is also loss.
  return removed.some(line => remaining.some(next => next.length > 0 && next.length < line.length && line.includes(next)));
}
