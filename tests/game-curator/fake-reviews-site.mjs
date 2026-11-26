// A simulated Steam Community "My reviews" site for behavioral tests: several numbered pages, real navigations that destroy page
// JavaScript state but keep sessionStorage, optional redirects, count changes and public (no owner controls) views.
// Synthetic data only.
import vm from 'node:vm';
import fs from 'node:fs';

export function makeReviewsSite({total = 25, perPage = 10, path = '/id/test/recommended', owner = true, lang = 'en', width = 1280, redirects = {}, reviewText} = {}) {
  const site = {total, perPage, owner, lang, redirects, downloads: [], visits: [], store: new Map(), reviews: null, path};
  const makeReviews = () => Array.from({length: site.total}, (_, i) => ({appid: 4000 + i, positive: i % 4 !== 0,
    text: reviewText ? reviewText(i) : `Synthetic review ${i + 1}`, hours: `${i + 1}.5 hrs on record`, posted: `Posted November ${(i % 28) + 1}.`}));
  site.reviews = makeReviews();
  const pages = () => Math.max(1, Math.ceil(site.total / site.perPage));
  let ctx = null;
  const sessionStorage = {getItem: k => (site.store.has(k) ? site.store.get(k) : null), setItem: (k, v) => site.store.set(k, String(v)), removeItem: k => site.store.delete(k)};
  const blobs = new Map();
  // The page needs a real URL class (parsing links) that also captures Blob downloads instead of touching the network or disk.
  class PageURL extends URL { static createObjectURL(b) { const u = `blob:fake/${blobs.size}`; blobs.set(u, b); return u; } static revokeObjectURL() {} }
  function render(urlString) {
    const url = new URL(urlString, `https://steamcommunity.com${site.path}`);
    const p = Number(url.searchParams.get('p') || '1'), start = (p - 1) * site.perPage, slice = site.reviews.slice(start, start + site.perPage);
    const boxes = slice.map(r => {
      const row = {querySelector: sel => (/\.title a/.test(sel) ? {href: `https://steamcommunity.com${site.path}/${r.appid}/`, innerText: r.positive ? 'Recommended' : 'Not Recommended'} : /\.content/.test(sel) ? {innerText: r.text} : /\.hours/.test(sel) ? {innerText: r.hours} : /\.posted/.test(sel) ? {innerText: r.posted} : null)};
      return row;
    });
    const links = Array.from({length: pages()}, (_, i) => i + 1).filter(n => n !== p).map(n => ({href: `https://steamcommunity.com${site.path}/?p=${n}`}));
    const shown = site.total ? `Showing ${start + 1}-${Math.min(site.total, start + site.perPage)} of ${site.total} entries` : '';
    const document = {hidden: false, body: {get innerText() { return `Reviews\n${shown}\n`; }, appendChild() {}}, documentElement: {lang: site.lang},
      createElement: () => ({click() { site.downloads.push({name: this.download, blob: blobs.get(this.href)}); }, remove() {}}),
      querySelectorAll: sel => (sel === '.review_box' ? boxes : /pagelink/.test(sel) ? links : []),
      querySelector: sel => (/control_block/.test(sel) ? (site.owner && boxes.length ? {} : null) : null)};
    class MutationObserver { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} }
    const loc = {protocol: 'https:', hostname: 'steamcommunity.com', origin: 'https://steamcommunity.com', pathname: url.pathname, search: url.search, href: url.href};
    // A navigation creates a brand new global scope: page JavaScript state is gone, sessionStorage is kept.
    ctx = vm.createContext({document, MutationObserver, sessionStorage, setTimeout, clearTimeout, Date, JSON, Map, Set, Array, Object, Math, Number, Error, Promise, RegExp, URLSearchParams,
      TextEncoder, Uint8Array, Blob, URL: PageURL, crypto: globalThis.crypto, console, innerWidth: width, location: loc, getComputedStyle: () => ({})});
    ctx.window = ctx;
  }
  // navigate(url): follows an optional redirect map, like a sign-in redirect for one page.
  site.navigate = url => {
    const target = url === '/' ? new URL(`https://steamcommunity.com${site.path}/`) : new URL(url, `https://steamcommunity.com${site.path}/`); // '/' means this site's list root
    const key = `${target.pathname.replace(/\/+$/, '')}?p=${target.searchParams.get('p') || '1'}`;
    site.visits.push(key);
    const redirected = site.redirects[key]; delete site.redirects[key]; // one-shot, like a transient redirect
    render(redirected ?? target.href);
  };
  const source = fs.readFileSync(new URL('../../skills/game-curator/scripts/claude-code/steam-reviews-page.js', import.meta.url), 'utf8');
  // Every page re-runs the whole trusted generated file: a navigation destroys the page scope and nothing is evaluated from storage.
  site.runFile = (opts = {}) => vm.runInContext(`(async () => (${source.replace(/\}\)\(\{\}\)\s*$/, `})(${JSON.stringify(opts)})`).replace(/^(?:\/\/.*\n)*await /m, '')}))()`, ctx);
  site.state = () => { const v = site.store.get('gcReviews'); return v === undefined ? null : JSON.parse(v); };
  Object.defineProperty(site, 'ctx', {get: () => ctx});
  site.navigate('/');
  return site;
}
