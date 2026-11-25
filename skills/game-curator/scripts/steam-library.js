// Paste into the console of the verified account's Steam Community games page.
// Enable scrolling only when the runtime permits it; returns a Promise.
(async () => {
  const autoScroll = false;
  if (location.hostname !== 'steamcommunity.com' || !/\/games\/?/.test(location.pathname)) throw Error('Open a Steam Community games page first');
  const records = [], seen = new Set();
  function collect() { for (const a of document.querySelectorAll('a[href*="/app/"]')) {
    const match = a.href.match(/\/app\/(\d+)/); if (!match || seen.has(match[1])) continue;
    const row = a.closest('.gameListRow, .gameListRowItem');
    if (!row) continue; // Do not turn unrelated app links into library membership.
    const text = (row.innerText || '').trim().slice(0, 4000);
    records.push({appid: Number(match[1]), name: (a.innerText || a.getAttribute('title') || '').trim() || null, pageText: text || null, membershipSource:'library-row'});
    seen.add(match[1]);
  } }
  let steps = 0, stagnant = 0;
  collect();
  if (autoScroll) {
    while (steps < 80 && stagnant < 4) {
      const before = records.length;
      window.scrollBy(0, Math.max(400, window.innerHeight * 0.8));
      await new Promise(resolve => setTimeout(resolve, 500));
      collect(); steps++;
      stagnant = records.length === before ? stagnant + 1 : 0;
    }
  }
  return {format:'game-curator-steam-export', version:1, source:'library', capturedAt:new Date().toISOString(), method:autoScroll ? 'page-dom-scroll' : 'page-dom', coverage:'partial', warnings:['Unverified library-row selectors; scrolling or virtualized entries may be missing. A plateau does not prove completeness.'], diagnostics:{scrollSteps:steps,stagnantSteps:stagnant}, records};
})()
