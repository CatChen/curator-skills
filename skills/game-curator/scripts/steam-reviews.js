// Paste into the console of each Steam Community recommended page.
(() => {
  if (location.hostname !== 'steamcommunity.com' || !/\/recommended\/?$/.test(location.pathname)) throw Error('Open a Steam Community recommended page first');
  const records = [], seen = new Set();
  for (const row of document.querySelectorAll('.review_box, .review_box_content, .recommendation')) {
    const app = row.querySelector('a[href*="/app/"]'); const m = app && app.href.match(/\/app\/(\d+)/); if (!m) continue;
    const review = row.querySelector('a[href*="/recommended/"]'); const url = review ? review.href.split('?')[0] : null;
    const key = url || m[1]; if (seen.has(key)) continue; seen.add(key);
    const text = (row.innerText || '').trim().slice(0,20000) || null;
    const reviewText = row.querySelector('.content, .review_text');
    const title = (row.querySelector('.title')?.innerText || '').trim();
    const recommended = /^recommended$/i.test(title) ? true : /^not recommended$/i.test(title) ? false : null;
    records.push({appid:Number(m[1]),name:(app.innerText || '').trim() || null,reviewUrl:url,
      recommended, review:reviewText ? (reviewText.innerText || '').trim() || null : null,
      pageText:text,page:new URLSearchParams(location.search).get('p') || '1'});
  }
  return {format:'game-curator-steam-export',version:1,source:'reviews',capturedAt:new Date().toISOString(),method:'page-dom',coverage:'partial',warnings:['Only selected visible review blocks on this page; verify pagination and fields manually.'],records};
})()
