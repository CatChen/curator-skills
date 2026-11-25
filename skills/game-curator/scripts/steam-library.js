// Paste into the console of the relevant Steam Community games page.
(() => {
  if (location.hostname !== 'steamcommunity.com' || !/\/games\/?/.test(location.pathname)) throw Error('Open a Steam Community games page first');
  const records = [], seen = new Set();
  for (const a of document.querySelectorAll('a[href*="/app/"]')) {
    const match = a.href.match(/\/app\/(\d+)/); if (!match || seen.has(match[1])) continue;
    const row = a.closest('[data-appid], .gameListRow, .gameListRowItem') || a;
    const text = (row.innerText || '').trim().slice(0, 4000);
    records.push({appid: Number(match[1]), name: (a.innerText || a.getAttribute('title') || '').trim() || null, pageText: text || null});
    seen.add(match[1]);
  }
  return {format:'game-curator-steam-export', version:1, source:'library', capturedAt:new Date().toISOString(), method:'page-dom', coverage:'partial', warnings:['Visible DOM only; scrolling or virtualized entries may be missing; selectors and English labels are unverified.'], records};
})()
