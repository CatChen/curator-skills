// Paste into the console of the Steam Store wishlist page.
(() => {
  if (location.hostname !== 'store.steampowered.com' || !location.pathname.startsWith('/wishlist')) throw Error('Open the Steam Store wishlist first');
  const records = [], seen = new Set();
  for (const a of document.querySelectorAll('a[href*="/app/"]')) {
    const m = a.href.match(/\/app\/(\d+)/); if (!m || seen.has(m[1])) continue;
    records.push({appid:Number(m[1]), name:(a.innerText || a.getAttribute('title') || '').trim() || null, metadataSource:'visible-link'}); seen.add(m[1]);
  }
  return {format:'game-curator-steam-export',version:1,source:'wishlist',capturedAt:new Date().toISOString(),method:'page-dom',coverage:'partial',warnings:['Visible links only; wishlist membership, order and metadata require verification; dynamic items may be missing.'],records};
})()
