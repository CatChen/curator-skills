// Game Curator: Steam wishlist collector for Claude Code's built-in browser (page side).
// GENERATED FILE is steam-wishlist-page.js; edit this template and run `node build-page-script.mjs`.
//
// Run the WHOLE generated file as the `text` of mcp__Claude_Browser__javascript_tool (action javascript_exec)
// on the verified signed-in https://store.steampowered.com/wishlist/... tab. It is one async expression that
// registers itself as window.__gcWishlistRun and runs once. The leading `await` matters: Claude in Chrome's tool
// does not await a trailing promise (it returns {}), while REPL top-level await works in both browsers' tools. Read-only: it reads the DOM and scrolls the
// wishlist's own scroll container; no requests, no clicks, no internal page state. Its only page state is
// window.__gcWishlist (its own rows) and window.__gcWishlistRun, both removed when the run ends or fails.
//
// javascript_tool is cut off at 45 s per call, so a long run returns {inProgress:true,...} and resumes with
// the one-line call `await window.__gcWishlistRun({})`. Options (object literal on the last line):
//   callBudgetMs (35000, per call)  maxMs (150000)  maxSteps (1000)  fresh (discard saved state)
//   deliver: 'return' (default) returns the envelope as the tool result; 'download' makes the page save it as a
//   local file (a Blob download, no network) and returns only a small summary with the file's SHA-256. Use it where the
//   tool truncates large results, as Claude in Chrome does (see references/claude-code.md).
// maxMs, maxSteps and deliver are remembered across resume calls; the rest apply to the call they are passed to.
await (window.__gcWishlistRun = async (opts = {}) => {
  const startedAt = new Date().toISOString();
  /*@@SHARED@@*/
  const cleanup = () => { delete window.__gcWishlist; delete window.__gcWishlistRun; };
  try {
    if (innerWidth < 1000) throw new Error(`Viewport ${innerWidth}px wide: Steam serves a reduced layout. Use resize_window width 1280 height 900, reload, retry`);
    const callStart = Date.now();
    const callBudget = opts.callBudgetMs ?? 35000;
    const left = () => callStart + callBudget + 2000 - Date.now(); // absolute bound for every wait in this call
    const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, Math.min(ms, left()))));

    // View evidence. Filters live in an Options panel this read-only collector does not open, so they stay unknown.
    const viewInfo = () => {
      const sortBtn = [...document.querySelectorAll('button')].find(b => /^Sort by:/i.test(b.innerText.trim()));
      const box = document.querySelector('input[placeholder*="Search by name"]');
      return {sort: sortBtn ? sortBtn.innerText.replace(/^Sort by:\s*/i, '').trim() : null,
        search: box ? (box.value.trim() ? 'active' : 'empty') : 'unknown', filters: 'unknown'};
    };

    // Waits are event driven: a MutationObserver resolves as soon as the list changes; setTimeout only bounds it.
    // (Unfocused panes throttle timers to about 1 s, and a message-polling wait was measured as a busy loop.)
    let scroller = null;
    const nextMutation = limit => new Promise(res => {
      const target = scroller && scroller !== document.scrollingElement ? scroller : document.body;
      let t; const mo = new MutationObserver(() => done());
      const done = () => { clearTimeout(t); mo.disconnect(); res(); };
      mo.observe(target, {childList: true, subtree: true, characterData: true});
      t = setTimeout(done, Math.max(0, Math.min(limit, left())));
    });

    let snap = snapshotWishlist();
    for (let i = 0; !snap.rows.length && i < 10 && left() > 0; i++) { await nextMutation(500); snap = snapshotWishlist(); }
    let view = viewInfo(); const expected0 = snap.expected;
    const sigOf = (v, count) => JSON.stringify([location.pathname.replace(/\/+$/, ''), location.search, count, v.sort, v.search]);
    let sig = sigOf(view, expected0);
    if (!snap.rows.length) {
      if (expected0 !== 0) throw new Error('No wishlist rows rendered; the page may still be loading, signed out, or filtered. Verify sign-in and view, then retry');
      cleanup();
      return envelopeOf({startedAt, finishedAt: new Date().toISOString(), expected: 0, records: [], stopReason: 'empty-observed', view, stats: {}, activeMs: 0, calls: 1, warnings: [], deliver: opts.deliver});
    }
    const first = document.querySelector('[data-rfd-drag-handle-draggable-id^="WishlistItem-"]');
    let box = first.parentElement;
    while (box && box !== document.body && !(/(auto|scroll)/.test(getComputedStyle(box).overflowY) && box.scrollHeight > box.clientHeight + 4)) box = box.parentElement;
    scroller = (box && box !== document.body) ? box : document.scrollingElement;

    // Resumable state, bound to the verified view. A different view or count discards it.
    const fresh = () => ({sig, startedAt, got: new Map(), byRank: new Map(), skipped: new Set(), retries: {}, activeMs: 0, started: false, byApp: new Map(), opts: {},
      stats: {steps: 0, waits: 0, settleTimeouts: 0, backtracks: 0, calls: 0, restarts: 0}, futile: 0, lastSize: -1, warnings: [], conflict: false});
    let S = window.__gcWishlist;
    if (S && (opts.fresh || S.sig !== sig || Date.now() - S.touched > 600000)) {
      const stale = S; S = null;
      window.__gcWishlist = fresh(); window.__gcWishlist.warnings.push(opts.fresh ? 'Discarded earlier collector state on request.' : stale.sig !== sig ? 'Discarded earlier collector state because the wishlist view or item count changed.' : 'Discarded abandoned collector state.');
    }
    S = window.__gcWishlist ??= fresh();
    S.stats.calls++;
    for (const k of ['maxMs', 'maxSteps', 'deliver']) if (opts[k] !== undefined) S.opts[k] = opts[k]; // remembered across resume calls
    const maxMs = S.opts.maxMs ?? 150000, maxSteps = S.opts.maxSteps ?? 1000;
    const {got, stats} = S;
    let expected = expected0;
    const outOfCall = () => Date.now() - callStart > callBudget;
    const outOfTotal = () => S.activeMs + Date.now() - callStart > maxMs || stats.steps > maxSteps;
    const step = Math.max(200, Math.floor(scroller.clientHeight * 0.7));
    const noteRows = rows => { for (const r of rows) { mergeWishlistRow(got, r); const prior = S.byRank.get(r.rank); if (prior === undefined) S.byRank.set(r.rank, r.appid); else if (prior !== r.appid) S.conflict = true;
      const at = S.byApp.get(r.appid); if (at === undefined) S.byApp.set(r.appid, r.rank); else if (at !== r.rank) S.conflict = true; } };
    // Re-read the observable view at every collection boundary: count, sort, search and URL, plus rank<->AppID conflicts in observed rows.
    // Changes confined to ranks never observed in this run cannot be detected.
    const viewChanged = s => S.conflict || (s.expected !== null && s.expected !== expected) || sigOf(viewInfo(), s.expected ?? expected) !== sig;

    async function settle(limit) { // wait for placeholder rows to finish loading, bounded
      const end = Date.now() + limit;
      for (;;) {
        const s = snapshotWishlist(); noteRows(s.rows);
        if (s.rows.every(r => r.complete)) return s;
        if (Date.now() >= end || left() <= 0) { stats.settleTimeouts++; return s; }
        stats.waits++; await nextMutation(end - Date.now());
      }
    }
    const rankKey = rows => rows.map(r => r.rank).join();
    async function untilWindowChanges(prevKey, limit) { // the virtualized list re-renders 0.1-1.8 s after a scroll
      const end = Date.now() + limit;
      while (Date.now() < end && left() > 0) { if (rankKey(snapshotWishlist().rows) !== prevKey) return true; await nextMutation(end - Date.now()); }
      return false;
    }
    const nextNeeded = () => { const have = new Set([...got.values()].filter(r => r.complete).map(r => r.rank)); for (let r = 1; r <= (expected ?? 0); r++) if (!have.has(r) && !S.skipped.has(r)) return r; return null; };

    if (!S.started) { scroller.scrollTop = 0; await untilWindowChanges('', 600); S.started = true; }
    let stopReason = null;
    while (stopReason === null) {
      if (outOfTotal()) { stopReason = 'budget'; break; }
      if (outOfCall()) { // hand control back before the tool's 45 s limit; the next run resumes here
        S.activeMs += Date.now() - callStart; S.touched = Date.now();
        return {inProgress: true, collected: got.size, expected, elapsedMs: S.activeMs, calls: stats.calls, hint: 'Run window.__gcWishlistRun({}) again to resume'};
      }
      const s = await settle(1200), rows = s.rows;
      if (viewChanged(s)) { // rows of a different view/membership would be mixed in: restart once, then stop with a warning
        if (stats.restarts >= 1) { stopReason = 'view-changed'; break; }
        stats.restarts++; S.warnings.push('The wishlist view or item count changed during collection; restarted once.');
        got.clear(); S.byRank.clear(); S.byApp.clear(); S.skipped.clear(); S.retries = {}; S.conflict = false; S.futile = 0; S.lastSize = -1;
        expected = s.expected ?? expected; view = viewInfo(); sig = S.sig = sigOf(view, expected); scroller.scrollTop = 0; await untilWindowChanges('', 600); continue;
      }
      const need = nextNeeded();
      if (need === null) { stopReason = S.skipped.size ? 'rows-missing' : 'complete'; break; }
      const lo = Math.min(...rows.map(r => r.rank)), hi = Math.max(...rows.map(r => r.rank)), before = scroller.scrollTop;
      if (rows.length && need >= lo && need <= hi) { // inside the rendered window but not loaded (placeholder or hole): wait, then give up on it
        S.retries[need] = (S.retries[need] ?? 0) + 1;
        if (S.retries[need] > 3) S.skipped.add(need); else await sleep(400 * S.retries[need]);
        continue;
      }
      S.futile = got.size === S.lastSize ? S.futile + 1 : 0; S.lastSize = got.size;
      if (S.futile >= 4) { stopReason = 'no-progress'; break; }
      // Seek the lowest missing rank using the average row height; backtrack if the window overshot.
      const rowH = scroller.scrollHeight / (expected || rows.length || 1);
      const target = !rows.length ? before + step : need < lo ? before - (lo - need + 1) * rowH : before + Math.max(1, need - lo - 1) * rowH;
      if (rows.length && need < lo) stats.backtracks++;
      scroller.scrollTop = Math.max(0, target); stats.steps++;
      await untilWindowChanges(rankKey(rows), 2500);
    }
    if (stopReason === 'complete' && viewChanged(snapshotWishlist())) stopReason = 'view-changed'; // last look before emitting
    if (stopReason === 'view-changed') view = viewInfo(); // never emit the stale starting view for a changed one
    S.activeMs += Date.now() - callStart;
    const records = toWishlistRecords(got), skipped = [...S.skipped];
    cleanup();
    return envelopeOf({startedAt: S.startedAt, finishedAt: new Date().toISOString(), expected, records, stopReason, view, stats, activeMs: S.activeMs,
      calls: stats.calls, warnings: S.warnings, skipped, deliver: S.opts.deliver, incomplete: [...got.values()].filter(r => !r.complete).length});
  } catch (error) { cleanup(); throw error; }

  // Build the game-curator-steam-export v1 envelope from collected rows (hash over the exact record JSON).
  async function envelopeOf(c) {
    const ranks = c.records.map(r => r.rank), incomplete = c.incomplete ?? 0;
    const contiguous = c.expected !== null && ranks.length === c.expected && ranks.every((r, i) => r === i + 1);
    const done = c.stopReason === 'complete' && contiguous && !incomplete && !(c.skipped?.length); // an empty page is only ever 'observed'
    const have = new Set(ranks), missingRanks = [];
    for (let r = 1; r <= (c.expected ?? 0) && missingRanks.length < 500; r++) if (!have.has(r)) missingRanks.push(r);
    const warnings = [...c.warnings];
    if (c.expected !== null && c.records.length !== c.expected) warnings.push(`Displayed ${c.expected} items; collected ${c.records.length} unique AppIDs.`);
    if (c.expected !== null && !contiguous && c.records.length) warnings.push('Observed wishlist positions do not cover all displayed ranks.');
    if (incomplete) warnings.push(`${incomplete} rows were still placeholders after retries and were omitted rather than stored with unreliable fields.`);
    if (c.stopReason === 'empty-observed') warnings.push('The page showed 0 items and no rows. Owner, account and filter state of an empty list were not independently verified, so this is not treated as a verified empty wishlist.');
    if (c.skipped?.length) warnings.push(`Gave up waiting for lazy rows at ranks ${c.skipped.join(',')}.`);
    if (!done) warnings.push(`Incomplete capture (stop reason: ${c.stopReason}); do not treat it as the full wishlist.`);
    warnings.push('Rank is a displayed row position, not verified global priority. DOM rows are partial; verify account and membership.');
    warnings.push('Consistency was checked for observed rows and the displayed count, sort and search only; changes confined to unobserved ranks cannot be detected.');
    warnings.push('Wishlist filters were not verified (only sort and search state were recorded); confirm them before treating this as the full wishlist.');
    const sha256Hex = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    const sha = await sha256Hex(new TextEncoder().encode(JSON.stringify(c.records)));
    const envelope = {
      format: 'game-curator-steam-export', version: 1, source: 'wishlist',
      capturedAt: c.finishedAt, method: 'browser-dom-claude-code', coverage: 'partial', warnings,
      diagnostics: {expectedCount: c.expected, uniqueCount: c.records.length, ranksObserved: ranks.length, ranksContiguous: contiguous,
        placeholderNameRows: incomplete, missingRanks, complete: done, stopReason: c.stopReason, startedAt: c.startedAt, finishedAt: c.finishedAt,
        elapsedMs: c.activeMs, calls: c.calls, viewportWidth: innerWidth, view: c.view, waitStrategy: 'mutation-observer',
        scrollSteps: c.stats.steps ?? 0, backtracks: c.stats.backtracks ?? 0, restarts: c.stats.restarts ?? 0, settleWaits: c.stats.waits ?? 0,
        settleTimeouts: c.stats.settleTimeouts ?? 0, reorderHandles: !!document.querySelector('[data-rfd-drag-handle-draggable-id^="WishlistItem-"]'),
        urlPath: location.pathname.replace(/\/+$/, ''), recordsSha256: sha, extraction: 'claude-code-page-script'},
      accessScope: 'unknown', // the caller sets signed-in/account only after verifying them
      records: c.records,
    };
    if (c.deliver === 'download') { // the page saves the envelope as a local file and returns only a small, checkable summary
      const text = JSON.stringify(envelope, null, 2) + '\n', fileBytes = new TextEncoder().encode(text);
      const file = `gc-wishlist-${envelope.capturedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.json`;
      const a = document.createElement('a'), url = URL.createObjectURL(new Blob([text], {type: 'application/json'}));
      a.href = url; a.download = file; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      const d = envelope.diagnostics;
      return {delivered: 'download', file, bytes: fileBytes.length, fileSha256: (await sha256Hex(fileBytes)).match(/.{8}/g).join(' '), // grouped: Claude in Chrome blocks a bare 64-hex string as "base64 data"
        records: c.records.length, expected: d.expectedCount,
        complete: d.complete, stopReason: d.stopReason, elapsedMs: d.elapsedMs, calls: d.calls, scrollSteps: d.scrollSteps, view: d.view};
    }
    return envelope;
  }
})({})
