// A small simulated Steam Community "All Games" page for behavioral tests: rows render progressively in chunks, optionally
// only after the page is scrolled (a stall), with MutationObserver notifications. Synthetic data only.
import vm from 'node:vm';
import fs from 'node:fs';

// rowText(i) builds the labeled text for game i (1-based); by default every 3rd game has playtime, every 6th achievements.
export function makeLibraryPage({n = 100, chunk = 25, chunkMs = 20, requireScroll = false, scrollChunk = 25, countText = undefined, search = '', tab = 'all', lang = 'en',
  width = 1280, owner = true, appidOf = i => 2000 + i, nameOf = i => `Game ${i}`, rowText, sameName = false, path = '/id/test/games'} = {}) {
  const state = {rendered: 0, scrolls: 0, observers: new Set(), n, count: n, search, tab, lang, downloads: [], epoch: 0, churn: 0, late: new Map()};
  const notify = () => { for (const cb of [...state.observers]) cb(); };
  const defaultText = i => {
    const lines = [nameOf(i)];
    if (i % 3 === 0) lines.push('TOTAL PLAYED', `${i}.5 hours`, 'LAST PLAYED', 'May 23, 2025');
    if (i % 6 === 0) lines.push('ACHIEVEMENTS', `${i % 10}/${(i % 10) + 5}`);
    if (owner) lines.push('My Game Stats', 'My Game Content', 'DOWNLOAD'); // owner-only controls; a public view shows none
    else lines.push('Public');
    return lines.join('\n');
  };
  const baseText = rowText ?? defaultText;
  // churn: volatile client text (install size) that changes without any library change; late: a labeled value that appears after rendering
  const text = i => baseText(i) + (i === 1 ? `\n${state.churn} GB` : '') + (state.late.get(i) ?? '');
  const anchors = () => {
    const out = [];
    for (let i = 1; i <= state.rendered; i++) {
      const row = {innerText: text(i)}, id = appidOf(i) + state.epoch * 10000, name = nameOf(i);
      const title = {href: `https://store.steampowered.com/app/${id}/`, getAttribute: k => (k === 'aria-label' ? null : null), innerText: name, querySelector: () => null, closest: () => row};
      const image = {href: `https://store.steampowered.com/app/${id}/`, getAttribute: () => null, innerText: '', querySelector: () => ({alt: name}), closest: () => row};
      out.push(title, image);
    }
    return out;
  };
  // progressive rendering, like the real page (about 800 rows in 2 s)
  const target = () => (requireScroll ? Math.min(state.n, chunk + state.scrolls * scrollChunk) : state.n);
  const tick = () => { if (state.rendered < target()) { state.rendered = Math.min(target(), state.rendered + chunk); notify(); } if (state.rendered < target()) state.timer = setTimeout(tick, chunkMs); };
  state.render = () => { clearTimeout(state.timer); state.timer = setTimeout(tick, 1); };
  const scrollingElement = {clientHeight: 900, scrollHeight: 100000, _top: 0, get scrollTop() { return this._top; }, set scrollTop(v) { if (v !== this._top) { this._top = v; state.scrolls++; state.render(); } }};
  const body = {get innerText() { return `STORE\n${countText === undefined ? `All Games (${state.count})` : countText}\n`; }, parentElement: null, appendChild() {}};
  const blobs = new Map(), URLfake = {createObjectURL: b => { const u = `blob:fake/${blobs.size}`; blobs.set(u, b); return u; }, revokeObjectURL() {}};
  const document = {hidden: false, body, scrollingElement, documentElement: {get lang() { return state.lang; }},
    createElement: () => ({click() { state.downloads.push({name: this.download, blob: blobs.get(this.href)}); }, remove() {}}),
    querySelectorAll: sel => (/app\//.test(sel) ? anchors() : []),
    querySelector: sel => /app\//.test(sel) ? anchors()[0] ?? null : /Find a game/.test(sel) ? {get value() { return state.search; }} : null};
  class MutationObserver { constructor(cb) { this.cb = cb; } observe() { state.observers.add(this.cb); } disconnect() { state.observers.delete(this.cb); } }
  const location = {protocol: 'https:', hostname: 'steamcommunity.com', pathname: path, get search() { return state.tab === null ? '' : `?tab=${state.tab}`; }};
  const ctx = vm.createContext({document, MutationObserver, setTimeout, clearTimeout, Date, JSON, Map, Set, Array, Object, Math, Number, Error, Promise, RegExp, URLSearchParams,
    TextEncoder, Uint8Array, Blob, URL: URLfake, crypto: globalThis.crypto, console, innerWidth: width, location, getComputedStyle: () => ({overflowY: 'visible'})});
  ctx.window = ctx;
  state.render();
  const source = fs.readFileSync(new URL('../../skills/game-curator/scripts/claude-code/steam-library-page.js', import.meta.url), 'utf8');
  const run = (opts = {}) => ctx.window.__gcLibraryRun ? ctx.window.__gcLibraryRun(opts) : vm.runInContext(`(async () => (${source.replace(/\}\)\(\{\}\)\s*$/, `})(${JSON.stringify(opts)})`).replace(/^(?:\/\/.*\n)*await /m, '')}))()`, ctx);
  return {state, ctx, run, notify, text};
}
