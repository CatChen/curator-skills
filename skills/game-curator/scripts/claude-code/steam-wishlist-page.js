// Game Curator: Steam wishlist collector for Claude Code's built-in browser.
// Run the WHOLE file as the `text` of mcp__Claude_Browser__javascript_tool (action javascript_exec)
// on the verified signed-in https://store.steampowered.com/wishlist/... tab.
// The file is a single async expression: the tool awaits it and returns the envelope as the result.
// Read-only: it reads the DOM and scrolls the wishlist's own scroll container. No requests, no clicks,
// no internal page state. Options are the literal object on the last line: callBudgetMs (35000),
// maxMs (150000), maxSteps (1000), fresh. javascript_tool is cut off at 45 s per call, so a longer run
// returns {inProgress:true,...}. The script registers itself as window.__gcWishlistRun, so resume with the
// short call `await window.__gcWishlistRun({})` instead of pasting the file again.
(window.__gcWishlistRun = async (opts = {}) => {
  const startedAt = new Date().toISOString();
  // An unfocused or hidden pane throttles setTimeout to ~1 s (observed even with visibilityState "visible"),
  // so calibrate once and, if throttled, wait by polling a MessageChannel instead.
  let throttled = document.hidden;
  const sleep = ms => new Promise(r => {
    if (!throttled) return setTimeout(r, ms);
    const end = performance.now() + ms, mc = new MessageChannel();
    mc.port1.onmessage = () => { if (performance.now() >= end) { mc.port1.close(); r(); } else mc.port2.postMessage(0); };
    mc.port2.postMessage(0);
  });
  { const c0 = performance.now(); await new Promise(r => setTimeout(r, 30)); throttled = throttled || performance.now() - c0 > 250; }
  const SEL = '[data-rfd-drag-handle-draggable-id^="WishlistItem-"]';
  if (location.protocol !== 'https:' || location.hostname !== 'store.steampowered.com' || !location.pathname.startsWith('/wishlist'))
    throw new Error('Open the verified Steam Store wishlist first');
  if (innerWidth < 1000) throw new Error(`Viewport ${innerWidth}px wide: Steam serves a reduced layout. Use resize_window width 1280 height 900, reload, retry`);

  const bodyText = () => document.body.innerText;
  const expected = (() => { const m = bodyText().match(/\b([\d,]+)\s+ITEMS\b/i); return m ? Number(m[1].replace(/,/g, '')) : null; })();

  // Read one rendered row exactly as the bundled Codex collector does.
  function readRows() {
    const out = [];
    for (const h of document.querySelectorAll(SEL)) {
      const m = h.getAttribute('data-rfd-drag-handle-draggable-id').match(/^WishlistItem-(\d+)-(\d+)$/);
      const row = h.closest('.Panel');
      if (!m || !row) continue;
      const link = [...row.querySelectorAll('a[href*="/app/"]')].find(a =>
        a.innerText.trim() && /\/app\/(\d+)/.exec(a.href)?.[1] === m[1] && !/^[\p{Sc}]/u.test(a.innerText.trim()));
      const raw = row.innerText.trim();
      out.push({appid: Number(m[1]), rank: Number(m[2]) + 1, name: link?.innerText.trim() || raw.split('\n')[0] || null,
        pageText: raw, membershipSource: 'wishlist-row', complete: !!link});
    }
    return out;
  }

  // The wishlist scrolls inside its own container, not the document.
  const first = document.querySelector(SEL);
  if (!first) throw new Error('No wishlist rows rendered; verify sign-in, layout and that the page finished loading');
  let box = first.parentElement;
  while (box && box !== document.body && !(/(auto|scroll)/.test(getComputedStyle(box).overflowY) && box.scrollHeight > box.clientHeight + 4)) box = box.parentElement;
  const scroller = (box && box !== document.body) ? box : document.scrollingElement;

  // State lives on the page so a run can span several tool calls (javascript_tool is cut off at 45 s).
  const path = location.pathname.replace(/\/+$/, '');
  let S = window.__gcWishlist;
  if (!S || opts.fresh || S.path !== path || Date.now() - S.touched > 600000)
    S = window.__gcWishlist = {path, startedAt, got: new Map(), skipped: new Set(), retries: {}, activeMs: 0, started: false,
      stats: {steps: 0, waits: 0, settleTimeouts: 0, backtracks: 0, calls: 0}, futile: 0, lastSize: -1};
  S.stats.calls++;
  const {got, stats} = S, callStart = Date.now();
  const callBudget = opts.callBudgetMs ?? 35000, maxMs = opts.maxMs ?? 150000, maxSteps = opts.maxSteps ?? 1000;
  const outOfCall = () => Date.now() - callStart > callBudget;
  const outOfTotal = () => S.activeMs + Date.now() - callStart > maxMs || stats.steps > maxSteps;
  const step = Math.max(200, Math.floor(scroller.clientHeight * 0.7));
  const take = rows => { for (const r of rows) { const o = got.get(r.appid); if (!o || (!o.complete && r.complete)) got.set(r.appid, r); } };
  // Wait until the rendered rows stop changing and every one has its real name (lazy rows start as placeholders).
  async function settle(limit) {
    let last = '', stable = 0;
    for (let waited = 0; ; waited += 60) {
      const rows = readRows(); take(rows);
      const key = rows.map(r => r.rank).join();
      stable = key === last ? stable + 1 : 0; last = key;
      if (stable >= 1 && rows.every(r => r.complete)) return rows;
      if (waited >= limit) { stats.settleTimeouts++; return rows; }
      stats.waits++; await sleep(60);
    }
  }
  const haveRanks = () => new Set([...got.values()].filter(r => r.complete).map(r => r.rank));
  const nextNeeded = () => { const have = haveRanks(); for (let r = 1; r <= (expected ?? 0); r++) if (!have.has(r) && !S.skipped.has(r)) return r; return null; };

  const rankKey = rows => rows.map(r => r.rank).join();
  // The virtualized list re-renders a moment after scrollTop changes (0.1-1.8 s observed): wait for the window to change.
  async function untilWindowChanges(prevKey, limit) {
    for (let waited = 0; waited < limit; waited += 50) { await sleep(50); if (rankKey(readRows()) !== prevKey) return true; }
    return false;
  }
  if (!S.started) { scroller.scrollTop = 0; await untilWindowChanges('', 600); S.started = true; }
  let finished = false;
  while (!outOfTotal()) {
    if (outOfCall()) { // hand control back before the tool's 45 s limit; the next run resumes here
      S.activeMs += Date.now() - callStart; S.touched = Date.now();
      return {inProgress: true, collected: got.size, expected, elapsedMs: S.activeMs, calls: stats.calls, hint: 'Run window.__gcWishlistRun({}) again to resume'};
    }
    const rows = await settle(1200);
    const need = nextNeeded();
    if (need === null) { finished = true; break; }
    const lo = Math.min(...rows.map(r => r.rank)), hi = Math.max(...rows.map(r => r.rank)), before = scroller.scrollTop;
    if (rows.length && need >= lo && need <= hi) { // rendered but still a placeholder: wait, then give up on it
      S.retries[need] = (S.retries[need] ?? 0) + 1;
      if (S.retries[need] > 3) S.skipped.add(need); else await sleep(400 * S.retries[need]);
      continue;
    }
    S.futile = got.size === S.lastSize ? (S.futile) + 1 : 0; S.lastSize = got.size;
    if (S.futile >= 4) break; // no progress after repeated seeks: report what we have
    // Seek the lowest missing rank using the average row height; backtrack if the window overshot.
    const rowH = scroller.scrollHeight / (expected || rows.length || 1);
    const target = !rows.length ? before + step : need < lo ? before - (lo - need + 1) * rowH : before + Math.max(1, need - lo - 1) * rowH;
    if (rows.length && need < lo) stats.backtracks++;
    scroller.scrollTop = Math.max(0, target); stats.steps++;
    await untilWindowChanges(rankKey(rows), 2500);
  }
  S.activeMs += Date.now() - callStart;
  const timedOut = !finished && outOfTotal();
  delete window.__gcWishlist;

  const records = [...got.values()].sort((a, b) => a.rank - b.rank).map(({complete: _c, ...r}) => r);
  const ranks = records.map(r => r.rank), incomplete = [...got.values()].filter(r => !r.complete).length;
  const contiguous = expected !== null && ranks.length === expected && ranks.every((r, i) => r === i + 1);
  const warnings = [];
  if (expected !== null && records.length !== expected) warnings.push(`Displayed ${expected} items; collected ${records.length} unique AppIDs.`);
  if (!contiguous) warnings.push('Observed wishlist positions do not cover all displayed ranks.');
  if (incomplete) warnings.push(`${incomplete} rows still had placeholder names after retries; names fall back to the first text line.`);
  if (timedOut) warnings.push(`Stopped at the ${maxMs} ms / ${maxSteps} step budget; coverage is incomplete.`);
  if (S.skipped.size) warnings.push(`Gave up waiting for ${S.skipped.size} lazy rows (ranks ${[...S.skipped].join(',')}).`);
  warnings.push('Rank is a displayed row position, not verified global priority. DOM rows are partial; verify account, filters and membership.');
  warnings.push('Default wishlist filters and sort were not inspected by this collector; verify them on the page.');

  const finishedAt = new Date().toISOString();
  const bytes = new TextEncoder().encode(JSON.stringify(records));
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
  return {
    format: 'game-curator-steam-export', version: 1, source: 'wishlist',
    capturedAt: finishedAt, method: 'browser-dom-claude-code',
    coverage: 'partial', warnings,
    diagnostics: {expectedCount: expected, uniqueCount: records.length, ranksObserved: ranks.length, ranksContiguous: contiguous,
      placeholderNameRows: incomplete, startedAt: S.startedAt, finishedAt, elapsedMs: S.activeMs, calls: stats.calls, viewportWidth: innerWidth, pageHiddenAtEnd: document.hidden, timersThrottled: throttled,
      scrollSteps: stats.steps, backtracks: stats.backtracks, settleWaits: stats.waits, settleTimeouts: stats.settleTimeouts,
      reorderHandles: document.querySelectorAll(SEL).length > 0, urlPath: location.pathname.replace(/\/+$/, ''),
      recordsSha256: sha, extraction: 'claude-code-page-script'},
    accessScope: 'unknown', // the caller sets signed-in/account only after verifying them
    records,
  };
})({})
