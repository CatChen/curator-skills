// Behavioral tests for the Claude page-side Library collector on a simulated All Games page (synthetic data).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {makeLibraryPage} from './fake-library-dom.mjs';
import {normalizeLibraryRecord} from '../../skills/game-curator/scripts/browser/library-rows.mjs';

const j = o => JSON.parse(JSON.stringify(o));
const fast = {quietMs: 120, stallMs: 150}; // shrink the quiet/stall windows so the suite stays quick; defaults are 800/1500 ms
const sha = recs => crypto.createHash('sha256').update(JSON.stringify(recs)).digest('hex');

// 1. Progressive rendering: waits for the displayed count, parses labeled values, keeps nulls for absent labels.
{
  const p = makeLibraryPage({n: 100});
  const e = j(await p.run(fast));
  assert.equal(e.source, 'library'); assert.equal(e.records.length, 100);
  assert.equal(e.diagnostics.complete, true); assert.equal(e.diagnostics.stopReason, 'complete'); assert.equal(e.diagnostics.expectedCount, 100);
  assert.equal(e.diagnostics.recordsSha256, sha(e.records));
  assert.deepEqual(Object.keys(e.records[0]), ['appid', 'name', 'pageText', 'membershipSource', 'hours', 'playtimeDisplay', 'lastPlayedDisplay', 'achievements']);
  const g3 = e.records.find(r => r.name === 'Game 3'), g1 = e.records.find(r => r.name === 'Game 1'), g6 = e.records.find(r => r.name === 'Game 6');
  assert.equal(g3.hours, 3.5); assert.equal(g3.lastPlayedDisplay, 'May 23, 2025'); assert.equal(g3.achievements, null);
  assert.equal(g1.hours, null); assert.equal(g1.playtimeDisplay, null); assert.equal(g1.achievements, null); // absent labels are null, never 0
  assert.equal(g6.hours, 6.5); assert.deepEqual(g6.achievements, {unlocked: 6, total: 11});
  assert.equal(e.diagnostics.rowsWithPlaytime, 33); assert.equal(e.diagnostics.rowsWithAchievements, 16);
  assert.ok(e.records.every(r => r.hours !== 0 || /TOTAL PLAYED\s*\n0 /.test(r.pageText)), 'no zero playtime may be invented');
  assert.deepEqual(e.records.map(r => r.hours), e.records.map(r => normalizeLibraryRecord(r).hours)); // same parser as Codex and the saver
  assert.equal(e.diagnostics.ownerControls, true); assert.deepEqual(e.diagnostics.view, {tab: 'all', search: 'empty', language: 'en'});
  assert.equal(e.accessScope, 'unknown'); assert.equal(p.ctx.window.__gcLibrary, undefined); assert.equal(p.ctx.window.__gcLibraryRun, undefined);
  assert.ok(e.warnings.some(w => /unknown values \(null\), not zero/.test(w)));
  const minutes = normalizeLibraryRecord({appid: 1, pageText: 'X\nTOTAL PLAYED\n45 minutes'}); assert.equal(minutes.hours, 0.75);
  assert.equal(normalizeLibraryRecord({appid: 1, pageText: 'X\nTOTAL PLAYED\n0 hours'}).hours, 0); // an explicit zero stays zero
}

// 2. Rendering that stalls until the page is scrolled: scroll to coax rows, bounded.
{
  const p = makeLibraryPage({n: 90, chunk: 30, requireScroll: true});
  const e = j(await p.run(fast));
  assert.equal(e.records.length, 90); assert.equal(e.diagnostics.complete, true);
  assert.ok(e.diagnostics.scrollSteps >= 2 && p.state.scrolls >= 2, 'rows beyond the first chunk only appear after scrolling');
}
// 2b. Rows that never appear: bounded no-progress with a warned partial result.
{
  const p = makeLibraryPage({n: 60, chunk: 20, requireScroll: true, scrollChunk: 0});
  const e = j(await p.run(fast));
  assert.equal(e.records.length, 20); assert.equal(e.diagnostics.complete, false); assert.equal(e.diagnostics.stopReason, 'no-progress');
  assert.ok(e.warnings.some(w => /Displayed 60 items; collected 20/.test(w)) && e.warnings.some(w => /Incomplete capture/.test(w)));
}

// 3. Resume across calls gives the same records as one run.
{
  const one = j(await makeLibraryPage({n: 150, chunk: 10, chunkMs: 25}).run(fast));
  const p = makeLibraryPage({n: 150, chunk: 10, chunkMs: 25});
  let r = j(await p.run({...fast, callBudgetMs: 120})), calls = 1;
  while (r.inProgress && calls < 60) { assert.ok(r.collected <= 150 && r.hint); r = j(await p.run({...fast, callBudgetMs: 120})); calls++; }
  assert.ok(calls > 1, 'a tiny budget must force a resume');
  assert.equal(r.diagnostics.recordsSha256, one.diagnostics.recordsSha256); assert.equal(r.diagnostics.calls, calls);
}

// 4. The view is re-read during collection: a same-count tab or search change restarts, then stops with a warning.
{
  const p = makeLibraryPage({n: 150, chunk: 10, chunkMs: 25});
  setTimeout(() => { p.state.search = 'zzz'; }, 80);
  const e = j(await p.run(fast));
  assert.ok(e.diagnostics.restarts >= 1); assert.equal(e.diagnostics.view.search, 'active');
  assert.ok(e.warnings.some(w => /game-name search is active/.test(w)));
  const q = makeLibraryPage({n: 150, chunk: 10, chunkMs: 25, tab: 'all'});
  setTimeout(() => { q.state.tab = 'completed'; }, 60);
  const e2 = j(await q.run(fast));
  assert.ok(e2.diagnostics.restarts >= 1); assert.equal(e2.diagnostics.view.tab, 'completed');
  assert.ok(e2.warnings.some(w => /does not select the "All Games" tab/.test(w)));
}
// 4b. Resume bound to the view: a changed displayed count discards earlier state.
{
  const p = makeLibraryPage({n: 150, chunk: 10, chunkMs: 25});
  assert.ok(j(await p.run({...fast, callBudgetMs: 60})).inProgress);
  p.state.n = 151; p.state.count = 151;
  const e = j(await p.run({...fast, }));
  assert.ok(e.warnings.some(w => /view or item count changed/.test(w))); assert.equal(e.diagnostics.expectedCount, 151);
}

// 5. Count missing (non-English or changed layout): coverage cannot be verified, so it is not reported complete.
{
  const e = j(await makeLibraryPage({n: 30, countText: 'Spiele', lang: 'de'}).run(fast));
  assert.equal(e.records.length, 30); assert.equal(e.diagnostics.complete, false); assert.equal(e.diagnostics.stopReason, 'count-unknown');
  assert.equal(e.diagnostics.expectedCount, null);
  assert.ok(e.warnings.some(w => /count was not found/.test(w)) && e.warnings.some(w => /labels are parsed in English only/.test(w)));
}
// 6. Empty library is observed, never claimed verified; an unloaded page throws.
{
  const empty = makeLibraryPage({n: 0}); empty.state.count = 0;
  const e = j(await empty.run(fast));
  assert.equal(e.records.length, 0); assert.equal(e.diagnostics.stopReason, 'empty-observed'); assert.equal(e.diagnostics.complete, false);
  const unloaded = makeLibraryPage({n: 0}); unloaded.state.count = 5;
  await assert.rejects(() => unloaded.run({...fast, callBudgetMs: 800}), /No library rows rendered/);
  assert.equal(unloaded.ctx.window.__gcLibraryRun, undefined);
}
// 7. Guards: narrow viewport, a public view without owner controls, names missing.
{
  const narrow = makeLibraryPage({n: 10, width: 700});
  await assert.rejects(() => narrow.run(fast), /Viewport 700px/); assert.equal(narrow.ctx.window.__gcLibraryRun, undefined);
  const pub = j(await makeLibraryPage({n: 30, owner: false}).run(fast));
  assert.equal(pub.diagnostics.ownerControls, false);
}
// 8. Delivery modes (shared with the wishlist): download is initiation-only with a small, digest-free summary.
{
  const p = makeLibraryPage({n: 80});
  const r = j(await p.run({...fast, deliver: 'download'}));
  assert.equal(r.downloadInitiated, true); assert.equal(r.source, 'library'); assert.match(r.file, /^gc-library-\d{8}T\d{6}Z\.json$/);
  assert.ok(JSON.stringify(r).length < 900); assert.equal(JSON.stringify(r).match(/[0-9a-f]{40,}/), null);
  const text = await p.state.downloads[0].blob.text();
  assert.equal(Buffer.byteLength(text), r.bytes); const file = JSON.parse(text);
  assert.equal(file.records.length, 80); assert.equal(r.view.tab, 'all');
  assert.equal(j(p.ctx.window.__gcRedeliver()).retry, true); assert.equal(p.state.downloads.length, 2);
  assert.equal(p.ctx.window.__gcRelease(), 'released');
}
console.log('Claude Code library collector behavior checks passed');
