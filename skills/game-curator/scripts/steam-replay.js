// Paste into the console of a Steam Store Replay annual page.
(() => {
  if (location.hostname !== 'store.steampowered.com' || !/^\/replay\//.test(location.pathname)) throw Error('Open an annual Steam Replay page first');
  const m = location.pathname.match(/\/(20\d{2})\/?$/); const year = m ? Number(m[1]) : null;
  const headings = Array.from(document.querySelectorAll('h1,h2,h3')).map(x => x.innerText.trim()).filter(Boolean).slice(0,100);
  const links = Array.from(document.querySelectorAll('a[href*="/app/"]')).map(a => { const id=a.href.match(/\/app\/(\d+)/); return id ? {appid:Number(id[1]),name:(a.innerText || '').trim() || null} : null; }).filter(Boolean);
  return {format:'game-curator-steam-export',version:1,source:'replay',capturedAt:new Date().toISOString(),method:'page-dom',coverage:'partial',warnings:['Only headings and visible app links; annual metrics and unrendered sections are not captured.'],records:[{year,headings,apps:links}]};
})()
