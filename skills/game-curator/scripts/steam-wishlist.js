// Run on the verified account's Steam Store wishlist page. Returns a Promise.
// Set resolveMissing to true only if same-origin requests are permitted.
(async () => {
  const resolveMissing = false;
  if (location.hostname !== 'store.steampowered.com' || location.protocol !== 'https:') throw Error('Expected HTTPS Steam Store origin');
  let data = window.SSR?.renderContext?.queryData;
  if (typeof data === 'string') data = JSON.parse(data);
  const queries = data?.queries;
  if (!Array.isArray(queries)) throw Error('Wishlist query cache unavailable; verify the account and page, then use recovery guidance');
  const lists = queries.filter(q => q.queryKey?.[0] === 'WishlistSortedFiltered')
    .map(q => q.state?.data?.items).filter(Array.isArray).sort((a,b) => b.length-a.length);
  if (!lists.length) throw Error('No recognized wishlist query; verify source identity and page structure');
  const items = lists[0], records = [], byId = new Map(), warnings = [];
  for (const [index, item] of items.entries()) {
    const appid = Number(item?.appid ?? item?.app_id ?? item);
    if (!Number.isSafeInteger(appid) || appid <= 0) { warnings.push(`Invalid item at position ${index+1}`); continue; }
    if (byId.has(appid)) { warnings.push(`Duplicate AppID ${appid}`); continue; }
    const record = {appid, rank:index+1, priority:item?.priority ?? null, dateAddedUnix:item?.date_added ?? null,
      name:null, nameSource:null, membershipSource:'WishlistSortedFiltered'};
    records.push(record); byId.set(appid, record);
  }
  for (const query of queries) {
    if (query.queryKey?.[0] !== 'StoreItem') continue;
    const item = query.state?.data?.store_item ?? query.state?.data;
    const record = byId.get(Number(item?.appid));
    if (record && typeof item.name === 'string' && item.name.trim()) {
      record.name = item.name.trim(); record.nameSource = 'steam-page-cache';
    }
  }
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  if (resolveMissing) {
    let failures = 0;
    for (const record of records.filter(row => !row.name)) {
      let error = 'lookup failed', found = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetch(`/api/appdetails?appids=${record.appid}&filters=basic`, {credentials:'same-origin', signal:AbortSignal.timeout(20000)});
          if (response.status === 429) { error = 'HTTP 429; rate limit'; failures = 10; break; }
          if (!response.ok) { error = `HTTP ${response.status}`; if (response.status < 500) break; }
          else {
            const body = await response.json(), value = body?.[String(record.appid)];
            if (value?.success && typeof value.data?.name === 'string' && value.data.name.trim()) {
              record.name = value.data.name.trim(); record.nameSource = 'steam-store-appdetails';
              record.type = value.data.type ?? null; record.release = value.data.release_date ?? null; found = true; break;
            }
            error = 'Steam returned no name'; break;
          }
        } catch (_) { error = 'request or response failed'; }
        if (attempt < 2) await pause(1500 * (attempt + 1));
      }
      if (found) failures = 0; else { record.lookupError = error; failures++; }
      if (failures >= 10) { warnings.push('Lookup circuit breaker stopped further requests'); break; }
      await pause(600);
    }
  }
  const unresolvedAppids = records.filter(row => !row.name).map(row => row.appid);
  if (!items.length) warnings.push('Empty cache does not prove an empty wishlist; verify account and page');
  if (unresolvedAppids.length) warnings.push('Some names were not resolved');
  warnings.push('Cache may be filtered or incomplete; verify account, rank, displayed counts and coverage');
  return {format:'game-curator-steam-export',version:1,source:'wishlist',capturedAt:new Date().toISOString(),
    method:resolveMissing ? 'steam-cache-and-appdetails' : 'steam-cache',coverage:'partial',warnings,records,
    diagnostics:{cacheItemCount:items.length,uniqueCount:records.length,unresolvedAppids}};
})()
