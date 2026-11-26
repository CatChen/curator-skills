// Game Curator: Steam library collector for Claude Code's built-in browser and Claude in Chrome (page side).
// GENERATED FILE is steam-library-page.js; edit this template and run `node build-page-script.mjs`.
//
// Run the WHOLE generated file as the `text` of the browser tool's javascript_tool (action javascript_exec) on the verified
// signed-in https://steamcommunity.com/id/<name>/games/?tab=all page. It is one async expression that registers itself as
// window.__gcLibraryRun and runs once. The leading `await` matters: Claude in Chrome's tool does not await a trailing
// promise (it returns {}), while REPL top-level await works in both browsers' tools.
// Read-only: it reads the DOM and, only if rendering stalls, scrolls the page. No requests, no clicks, no internal state.
// Its page state is window.__gcLibrary (its own rows) and window.__gcLibraryRun, removed when the run ends or fails.
//
// javascript_tool is cut off at 45 s per call, so a longer run returns {inProgress:true,...}; resume with the short call
// `await window.__gcLibraryRun({})`. Options (object literal on the last line):
//   callBudgetMs (35000, per call)  maxMs (150000)  maxSteps (200)  fresh (discard saved state)
//   quietMs (800: no change for this long once the displayed count is reached confirms completion)  stallMs (1500: no new rows for
//   this long before the count is reached triggers a bounded scroll)
//   deliver: 'return' (default) or 'download' (see page-common.mjs / references/claude-in-chrome.md): the page starts a
//   local file download and returns a small summary of INITIATION only; retainMs (default 10 min) bounds how long the
//   finished envelope is kept for an authorized retry via window.__gcRedeliver() / window.__gcRelease().
// maxMs, maxSteps, deliver and retainMs are remembered across resume calls.
await (window.__gcLibraryRun = async (opts = {}) => {
  const startedAt = new Date().toISOString();
  /*@@SHARED@@*/
  /*@@COMMON@@*/
  const cleanup = () => { delete window.__gcLibrary; delete window.__gcLibraryRun; };
  try {
    if (innerWidth < 1000) throw new Error(`Viewport ${innerWidth}px wide: Steam may serve a reduced layout. Use a desktop-width window (built-in browser: resize_window width 1280 height 900), reload, retry`);
    const callBudget = opts.callBudgetMs ?? 35000;
    const {callStart, left, sleep, outOfCall, nextMutation: waitMutation} = makeWaiter(callBudget);
    const nextMutation = limit => waitMutation(document.body, limit);

    // View evidence. The page has an "All Games" tab and a name search; there is no filter panel to open.
    const viewInfo = () => {
      const box = document.querySelector('input[placeholder="Find a game"]');
      return {tab: new URLSearchParams(location.search).get('tab'), search: box ? (box.value.trim() ? 'active' : 'empty') : 'unknown',
        language: document.documentElement.lang || null};
    };
    const sigOf = (v, count) => JSON.stringify([location.pathname.replace(/\/+$/, ''), v.tab, count, v.search]);

    let snap = snapshotLibrary();
    for (let i = 0; !snap.records.length && i < 10 && left() > 0; i++) { await nextMutation(500); snap = snapshotLibrary(); }
    let view = viewInfo(), expected = snap.expected;
    let sig = sigOf(view, expected);
    if (!snap.records.length) {
      if (expected !== 0) throw new Error('No library rows rendered; the page may still be loading, signed out or private, or its layout changed. Verify sign-in and view, then retry');
      cleanup();
      return envelopeOf({startedAt, finishedAt: new Date().toISOString(), expected: 0, got: new Map(), stopReason: 'empty-observed', view, stats: {}, activeMs: 0, calls: 1, warnings: [], deliver: opts.deliver, retainMs: opts.retainMs});
    }

    const fresh = () => ({sig, startedAt, got: new Map(), activeMs: 0, opts: {}, warnings: [], stats: {steps: 0, waits: 0, calls: 0, restarts: 0}, scrollStalls: 0, quietSince: Date.now()});
    let S = window.__gcLibrary;
    if (S && (opts.fresh || S.sig !== sig || Date.now() - S.touched > 600000)) {
      const stale = S; S = null;
      window.__gcLibrary = fresh(); window.__gcLibrary.warnings.push(opts.fresh ? 'Discarded earlier collector state on request.' : stale.sig !== sig ? 'Discarded earlier collector state because the library view or item count changed.' : 'Discarded abandoned collector state.');
    }
    S = window.__gcLibrary ??= fresh();
    S.stats.calls++;
    for (const k of ['maxMs', 'maxSteps', 'deliver', 'retainMs', 'quietMs', 'stallMs']) if (opts[k] !== undefined) S.opts[k] = opts[k];
    const maxMs = S.opts.maxMs ?? 150000, maxSteps = S.opts.maxSteps ?? 200;
    const quietMs = S.opts.quietMs ?? 800, stallMs = S.opts.stallMs ?? 1500; // quiet period that confirms completion; stall period before scrolling
    const {got, stats} = S;
    const outOfTotal = () => S.activeMs + Date.now() - callStart > maxMs || stats.steps > maxSteps;

    // Rows arrive progressively (about 2 s for 800 rows). Merge every observation; report whether anything new rendered.
    const observe = () => {
      const s = snapshotLibrary(); let changed = false;
      for (const r of s.records) {
        const before = got.get(r.appid), len = before?.pageText.length, hadName = !!before?.name;
        const after = mergeLibraryRow(got, r);
        if (!before || after.pageText.length !== len || (!hadName && !!after.name)) changed = true;
      }
      return {s, changed};
    };
    const viewChanged = s => (s.expected !== null && expected !== null && s.expected !== expected) || sigOf(viewInfo(), s.expected ?? expected) !== sig;
    // The page may scroll the document or an inner container; only used to coax more rows if rendering stalls.
    const scrollOnce = () => {
      const first = document.querySelector('a[href*="store.steampowered.com/app/"]')?.closest('.Panel');
      let box = first?.parentElement;
      while (box && box !== document.body && !(/(auto|scroll)/.test(getComputedStyle(box).overflowY) && box.scrollHeight > box.clientHeight + 4)) box = box.parentElement;
      const el = (box && box !== document.body) ? box : document.scrollingElement;
      el.scrollTop += Math.max(300, Math.floor(el.clientHeight * 0.9));
    };

    let stopReason = null; // S.quietSince lives in the resumable state so a quiet period can span calls
    while (stopReason === null) {
      if (outOfTotal()) { stopReason = 'budget'; break; }
      if (outOfCall()) { // hand control back before the tool's 45 s limit; the next run resumes here
        S.activeMs += Date.now() - callStart; S.touched = Date.now();
        return {inProgress: true, collected: got.size, expected, elapsedMs: S.activeMs, calls: stats.calls, hint: 'Run window.__gcLibraryRun({}) again to resume'};
      }
      const {s, changed} = observe();
      if (viewChanged(s)) { // rows from a different view would be mixed in: restart once, then stop with a warning
        if (stats.restarts >= 1) { stopReason = 'view-changed'; break; }
        stats.restarts++; S.warnings.push('The library view or item count changed during collection; restarted once.');
        got.clear(); S.scrollStalls = 0; expected = s.expected ?? expected; view = viewInfo(); sig = S.sig = sigOf(view, expected); S.quietSince = Date.now(); continue;
      }
      if (changed) { S.quietSince = Date.now(); S.scrollStalls = 0; }
      const quiet = Date.now() - S.quietSince, reached = expected !== null && got.size >= expected;
      if (reached && quiet >= quietMs) { stopReason = 'complete'; break; } // all rows present and nothing changed for a quiet period
      if (expected === null && quiet >= stallMs + 500) { stopReason = 'count-unknown'; break; } // cannot verify coverage without the displayed count, so do not scroll for it
      if (expected !== null && !reached && quiet >= stallMs) { // rendering stalled before the displayed count: coax more rows by scrolling, bounded
        if (S.scrollStalls >= 4) { stopReason = 'no-progress'; break; }
        scrollOnce(); stats.steps++; S.scrollStalls++; S.quietSince = Date.now();
      }
      stats.waits++; await nextMutation(reached ? Math.max(50, quietMs - quiet) : Math.min(400, stallMs));
    }
    if (stopReason === 'complete' && viewChanged(snapshotLibrary())) stopReason = 'view-changed'; // last look before emitting
    if (stopReason === 'view-changed') view = viewInfo();
    S.activeMs += Date.now() - callStart;
    const c = {startedAt: S.startedAt, finishedAt: new Date().toISOString(), expected, got, stopReason, view, stats, activeMs: S.activeMs, calls: stats.calls,
      warnings: S.warnings, deliver: S.opts.deliver, retainMs: S.opts.retainMs};
    cleanup();
    return envelopeOf(c);
  } catch (error) { cleanup(); throw error; }

  // Build the game-curator-steam-export v1 envelope. Records are the Codex shape: raw row fields plus labeled values parsed
  // from pageText, with null (never 0) for any label that is absent.
  async function envelopeOf(c) {
    const records = [...c.got.values()].map(normalizeLibraryRecord);
    const done = c.stopReason === 'complete' && c.expected !== null && records.length === c.expected;
    const warnings = [...c.warnings];
    if (c.expected !== null && c.expected !== records.length) warnings.push(`Displayed ${c.expected} items; collected ${records.length} unique AppIDs.`);
    if (c.expected === null) warnings.push('The displayed game count was not found (non-English or changed layout), so coverage cannot be verified.');
    if (c.stopReason === 'empty-observed') warnings.push('The page showed 0 games and no rows. Owner, account and view of an empty library were not independently verified.');
    if (!done) warnings.push(`Incomplete capture (stop reason: ${c.stopReason}); do not treat it as the full library.`);
    if (c.view.language && !/^en/i.test(c.view.language)) warnings.push(`Page language is "${c.view.language}"; labels are parsed in English only, so playtime, last played and achievements may be missing.`);
    if (c.view.tab !== 'all') warnings.push('The page URL does not select the "All Games" tab; membership may be partial.');
    if (c.view.search === 'active') warnings.push('A game-name search is active, so membership is filtered.');
    for (const r of records) if (r.achievements && r.achievements.unlocked > r.achievements.total) warnings.push(`AppID ${r.appid}: achievement counts are inconsistent.`);
    warnings.push('Missing playtime, last played or achievements labels are unknown values (null), not zero: a game without them may still have been played.');
    warnings.push('DOM capture may omit unrendered items; verify account and source membership. Consistency was checked for the displayed count, tab and search only.');
    const sha = await sha256Hex(new TextEncoder().encode(JSON.stringify(records)));
    const text = r => r.pageText;
    const envelope = {
      format: 'game-curator-steam-export', version: 1, source: 'library',
      capturedAt: c.finishedAt, method: 'browser-dom-claude-code', coverage: 'partial', warnings,
      diagnostics: {expectedCount: c.expected, uniqueCount: records.length, complete: done, stopReason: c.stopReason, startedAt: c.startedAt, finishedAt: c.finishedAt,
        elapsedMs: c.activeMs, calls: c.calls, viewportWidth: innerWidth, view: c.view, waitStrategy: 'mutation-observer',
        scrollSteps: c.stats.steps ?? 0, restarts: c.stats.restarts ?? 0, observeWaits: c.stats.waits ?? 0,
        // Informational counts of rows that carried each label; absent labels are unknown, not zero.
        rowsWithPlaytime: records.filter(r => r.hours !== null).length, rowsWithLastPlayed: records.filter(r => r.lastPlayedDisplay !== null).length,
        rowsWithAchievements: records.filter(r => r.achievements !== null).length, rowsWithoutName: records.filter(r => !r.name).length,
        ownerControls: records.some(r => /\bDOWNLOAD\b/.test(text(r))) || /REMOTE DOWNLOAD TO/i.test(document.body.innerText),
        urlPath: location.pathname.replace(/\/+$/, ''), recordsSha256: sha, extraction: 'claude-code-page-script'},
      accessScope: 'unknown', // the caller sets signed-in/account only after verifying them
      records,
    };
    return deliverEnvelope(envelope, {deliver: c.deliver, retainMs: c.retainMs, filePrefix: 'gc-library'});
  }
})({})
