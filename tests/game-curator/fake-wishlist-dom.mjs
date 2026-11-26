// A small simulated Steam wishlist page for behavioral tests: a virtualized list inside a scroll container
// that renders a window of rows after a short lag, shows placeholder rows until their content "loads", and
// notifies MutationObservers. Synthetic data only. Not a DOM implementation: just what the collectors read.
import vm from 'node:vm';
import fs from 'node:fs';

export function makeWishlistPage({n = 60, rowH = 170, clientH = 900, renderLagMs = 15, loadMs = 30, width = 1280, search = '', count = n,
  appidOf = rank => 1000 + rank, neverRender = new Set(), neverLoad = new Set(), sort = 'Your Rank'} = {}) {
  const state = {top: 0, rendered: [], loaded: new Set(), observers: new Set(), renders: 0, appidOf, neverRender, neverLoad, count, n};
  const notify = () => { for (const cb of [...state.observers]) cb(); };
  const rowsInWindow = () => {
    const first = Math.max(1, Math.floor(state.top / rowH) - 1), last = Math.min(state.n, Math.ceil((state.top + clientH) / rowH) + 8);
    const out = []; for (let r = first; r <= last; r++) if (!state.neverRender.has(r)) out.push(r); return out;
  };
  const nameOf = r => `Game ${r}`;
  function render() {
    state.renders++;
    state.rendered = rowsInWindow();
    for (const r of state.rendered) if (!state.loaded.has(r) && !state.neverLoad.has(r)) setTimeout(() => { state.loaded.add(r); notify(); }, loadMs);
    notify();
  }
  const listBox = {
    get scrollTop() { return state.top; },
    set scrollTop(v) { state.top = Math.max(0, Math.min(v, listBox.scrollHeight - clientH)); setTimeout(render, renderLagMs); },
    get scrollHeight() { return state.n * rowH; }, clientHeight: clientH, parentElement: null,
  };
  const handleFor = r => {
    const loaded = state.loaded.has(r), appid = state.appidOf(r);
    const panel = {
      innerText: loaded ? `${nameOf(r)}\nMY CATEGORIES:\nRELEASE DATE:\nJAN 1, 2020\nENGLISH REVIEWS:\nVERY POSITIVE\n$9.99` : 'MY CATEGORIES:',
      querySelectorAll: () => loaded ? [{innerText: nameOf(r), href: `https://store.steampowered.com/app/${appid}/`}] : [],
    };
    return {getAttribute: () => `WishlistItem-${appid}-${r - 1}`, closest: () => panel, parentElement: listBox};
  };
  const body = {get innerText() { return `STORE\n${state.count} ITEMS\n`; }, parentElement: null};
  listBox.parentElement = body;
  const document = {
    hidden: false, body, scrollingElement: {},
    querySelectorAll: sel => /^\[data-rfd/.test(sel) ? state.rendered.map(handleFor) : sel === 'button' ? [{innerText: `Sort by:\n${sort}`}] : [],
    querySelector: sel => /^\[data-rfd/.test(sel) ? (state.rendered.length ? handleFor(state.rendered[0]) : null) : /Search by name/.test(sel) ? {value: search} : null,
  };
  class MutationObserver { constructor(cb) { this.cb = cb; } observe() { state.observers.add(this.cb); } disconnect() { state.observers.delete(this.cb); } }
  const ctx = vm.createContext({document, MutationObserver, setTimeout, clearTimeout, Date, JSON, Map, Set, Array, Object, Math, Number, Error, Promise,
    TextEncoder, Uint8Array, crypto: globalThis.crypto, console, innerWidth: width,
    location: {protocol: 'https:', hostname: 'store.steampowered.com', pathname: '/wishlist/id/test/', search: ''},
    getComputedStyle: () => ({overflowY: 'auto'})});
  ctx.window = ctx;
  state.render = render;
  render(); // initial window, rows loaded
  for (const r of state.rendered) if (!state.neverLoad.has(r)) state.loaded.add(r);
  const source = fs.readFileSync(new URL('../../skills/game-curator/scripts/claude-code/steam-wishlist-page.js', import.meta.url), 'utf8');
  const run = (opts = {}) => ctx.window.__gcWishlistRun ? ctx.window.__gcWishlistRun(opts) : vm.runInContext(source.replace(/\}\)\(\{\}\)\s*$/, `})(${JSON.stringify(opts)})`), ctx);
  return {state, ctx, run, notify};
}
