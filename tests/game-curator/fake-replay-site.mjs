// A simulated Steam Replay site for behavioral tests: one annual report per URL, real navigations that destroy page JavaScript state but
// keep sessionStorage, optional redirects, a loading placeholder, other accounts and public (no owner control) views. Synthetic data only.
import vm from 'node:vm';
import fs from 'node:fs';

export const ACCOUNT = '/replay/76561190000000001';
export const OTHER = '/replay/76561190000000002';

export function makeReplaySite({account = ACCOUNT, years = [2025, 2022, 2023, 2024], owner = true, lang = 'en', width = 1280, redirects = {}, loadingReads = 0, stageReads = 0, driftReads = 0, alwaysChanging = false, textFor, appsFor, linkYears} = {}) {
  const site = {account, years, owner, lang, redirects, downloads: [], visits: [], store: new Map(), loadingReads, stageReads, driftReads, alwaysChanging, current: null};
  let ctx = null, reads = 0;
  const sessionStorage = {getItem: k => (site.store.has(k) ? site.store.get(k) : null), setItem: (k, v) => site.store.set(k, String(v)), removeItem: k => site.store.delete(k)};
  const blobs = new Map();
  class PageURL extends URL { static createObjectURL(b) { const u = `blob:fake/${blobs.size}`; blobs.set(u, b); return u; } static revokeObjectURL() {} }
  const textOf = (acct, y) => (textFor ? textFor(acct, y) : `Synthetic Replay ${y}\nYou played a variety of games this year.\nTop moments for ${y}.`);
  const appsOf = (acct, y) => (appsFor ? appsFor(acct, y) : [{appid: 5000 + (y % 100), name: `Synthetic Game ${y}`, source: 'image-asset'}, {appid: 6000, name: null, source: 'image-asset'}]);
  function render(urlString) {
    const url = new URL(urlString, 'https://store.steampowered.com');
    const m = url.pathname.match(/^(\/replay\/[^/]+)\/(20\d{2})\/?$/);
    site.current = url.pathname;
    const acct = m?.[1], year = m ? Number(m[2]) : null;
    const allApps = m ? appsOf(acct, year) : [], staged = () => reads <= site.loadingReads + site.stageReads, drifting = () => reads <= site.loadingReads + site.stageReads + site.driftReads;
    const head = site.owner ? `Test's\nSTEAM REPLAY ${year}\nYour Page Visibility:\nFriends Only\nShare\n` : `Test's\nSTEAM REPLAY ${year}\n`;
    const content = {get innerText() { reads++; return m ? (reads <= site.loadingReads ? 'LOADING...' : reads <= site.loadingReads + site.stageReads ? `${head}partial render ${reads}` : (() => { const full = head + textOf(acct, year); return site.alwaysChanging || reads <= site.loadingReads + site.stageReads + site.driftReads ? full.slice(0, -1) + String(reads % 10) : full; })()) : 'Sign in to Steam'; },
      querySelectorAll: sel => (sel === 'img[src]' ? (staged() ? [] : allApps.map(a => (drifting() ? {...a, appid: a.appid + 1000} : a))).filter(a => a.source === 'image-asset').map(a => ({alt: a.name ?? '', getAttribute: () => `https://cdn.example/steam/apps/${a.appid}/capsule.jpg`}))
        : /\/app\//.test(sel) ? (staged() ? [] : allApps).filter(a => a.source === 'app-link').map(a => ({href: `https://store.steampowered.com/app/${a.appid}/`, innerText: a.name ?? '', querySelector: () => null})) : [])};
    const linked = m ? (linkYears ?? site.years) : [];
    const links = linked.map(y => ({href: `https://store.steampowered.com${acct}/${y}`}));
    const document = {hidden: false, body: {get innerText() { return content.innerText; }, appendChild() {}}, documentElement: {lang: site.lang},
      createElement: () => ({click() { site.downloads.push({name: this.download, blob: blobs.get(this.href)}); }, remove() {}}),
      querySelectorAll: sel => (sel === 'a[href]' ? links : []), querySelector: sel => (/responsive_page_template_content/.test(sel) ? content : null)};
    class MutationObserver { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} }
    const loc = {protocol: 'https:', hostname: 'store.steampowered.com', origin: 'https://store.steampowered.com', pathname: url.pathname, search: url.search, href: url.href};
    // A navigation creates a brand new global scope: page JavaScript state is gone, sessionStorage is kept.
    ctx = vm.createContext({document, MutationObserver, sessionStorage, setTimeout, clearTimeout, Date, JSON, Map, Set, Array, Object, Math, Number, Error, Promise, RegExp, URLSearchParams,
      TextEncoder, btoa, atob, Uint8Array, Blob, URL: PageURL, crypto: globalThis.crypto, console, innerWidth: width, location: loc, getComputedStyle: () => ({})});
    ctx.window = ctx;
    Object.defineProperty(ctx, 'UserConfig', {get: () => site.userConfig, configurable: true}); // synthetic Steam identity data; tests set it (or a getter) to model sign-in, switches and expiry
  }
  // navigate(url): follows an optional one-shot redirect map keyed by the requested path.
  site.navigate = url => {
    const target = new URL(url, 'https://store.steampowered.com');
    const key = target.pathname.replace(/\/+$/, '');
    site.visits.push(key);
    const redirected = site.redirects[key]; delete site.redirects[key];
    render(redirected ?? target.href);
  };
  const source = fs.readFileSync(new URL('../../skills/game-curator/scripts/claude-code/steam-replay-page.js', import.meta.url), 'utf8');
  // Every year re-runs the whole trusted generated file: a navigation destroys the page scope and nothing is evaluated from storage.
  site.runFile = (opts = {}) => vm.runInContext(`(async () => (${source.replace(/\}\)\(\{\}\)\s*$/, `})(${JSON.stringify({settleMs: 0, ...opts})})`).replace(/^(?:\/\/.*\n)*await /m, '')}))()`, ctx);
  site.state = () => { const v = site.store.get('gcReplay'); return v === undefined ? null : JSON.parse(v); };
  Object.defineProperty(site, 'ctx', {get: () => ctx});
  site.navigate(`${account}/${years[0]}`);
  return site;
}
