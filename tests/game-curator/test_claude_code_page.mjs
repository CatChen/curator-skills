// Behavioral tests for the Claude Code page script against a simulated virtualized wishlist (synthetic data).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {makeWishlistPage} from './fake-wishlist-dom.mjs';

const j = o => JSON.parse(JSON.stringify(o)); // cross-realm objects -> plain
const sha = recs => crypto.createHash('sha256').update(JSON.stringify(recs)).digest('hex');

// 1. Placeholder-to-loaded, lazy rows, contiguous ranks, checksum, cleanup.
{
  const p = makeWishlistPage({n: 60});
  const e = j(await p.run());
  assert.equal(e.records.length, 60);
  assert.deepEqual(e.records.map(r => r.rank), Array.from({length: 60}, (_, i) => i + 1));
  assert.ok(e.records.every(r => r.name === `Game ${r.rank}` && r.pageText.includes('RELEASE DATE:') && !('complete' in r)));
  assert.deepEqual(Object.keys(e.records[0]), ['appid', 'rank', 'name', 'pageText', 'membershipSource']);
  assert.equal(e.diagnostics.complete, true);
  assert.equal(e.diagnostics.stopReason, 'complete');
  assert.equal(e.diagnostics.placeholderNameRows, 0);
  assert.equal(e.diagnostics.recordsSha256, sha(e.records));
  assert.equal(e.diagnostics.view.sort, 'Your Rank');
  assert.equal(e.diagnostics.view.filters, 'unknown');
  assert.equal(e.diagnostics.waitStrategy, 'mutation-observer');
  assert.equal(e.accessScope, 'unknown');
  assert.equal(p.ctx.window.__gcWishlist, undefined);
  assert.equal(p.ctx.window.__gcWishlistRun, undefined); // page state removed after a finished run
}

// 2. A rank that never renders: bounded, flagged incomplete, partial rows preserved.
{
  const p = makeWishlistPage({n: 40, neverRender: new Set([20])});
  const e = j(await p.run());
  assert.equal(e.records.length, 39);
  assert.equal(e.diagnostics.complete, false);
  assert.equal(e.diagnostics.stopReason, 'rows-missing');
  assert.equal(e.diagnostics.ranksContiguous, false);
  assert.ok(e.warnings.some(w => w.includes('Incomplete capture')) && e.warnings.some(w => w.includes('do not cover')));
}

// 3. A row stuck as a placeholder is retried, then reported (never counted as loaded).
{
  const p = makeWishlistPage({n: 30, neverLoad: new Set([7])});
  const e = j(await p.run());
  assert.equal(e.diagnostics.complete, false);
  assert.equal(e.diagnostics.stopReason, 'rows-missing');
  assert.equal(e.diagnostics.placeholderNameRows, 1);
  assert.ok(e.warnings.some(w => w.includes('ranks 7')));
  assert.equal(e.records.length, 30);
}

// 4. Resume across calls gives the same records as a single run, and returns small progress objects.
{
  const one = j(await makeWishlistPage({n: 80}).run());
  const p = makeWishlistPage({n: 80});
  let r = j(await p.run({callBudgetMs: 150})), calls = 1;
  while (r.inProgress && calls < 40) { assert.ok(r.collected <= 80 && r.hint); r = j(await p.run({callBudgetMs: 150})); calls++; }
  assert.ok(calls > 1, 'expected the tiny budget to force a resume');
  assert.equal(r.diagnostics.recordsSha256, one.diagnostics.recordsSha256);
  assert.equal(r.diagnostics.calls, calls);
}

// 5. Same count but changed membership mid-run: restart once, final capture is internally consistent.
{
  let flipped = false;
  const p = makeWishlistPage({n: 120, appidOf: r => (flipped && r >= 10 ? 5000 + r : 1000 + r)});
  const start = p.run({callBudgetMs: 60});
  let first = j(await start);
  assert.ok(first.inProgress);
  flipped = true; // the view now serves different games at the same ranks and the same displayed count
  let e = j(await p.run({callBudgetMs: 60000}));
  assert.equal(e.diagnostics.restarts, 1);
  assert.ok(e.warnings.some(w => w.includes('changed during collection')));
  const ids = e.records.map(r => r.appid);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(e.records.filter(r => r.rank >= 10).every(r => r.appid === 5000 + r.rank), 'no row from the old view may remain');
}
// 5b. Membership that keeps changing: stop with a warned partial capture, not a mixed success.
{
  let epoch = 0;
  const p = makeWishlistPage({n: 50, appidOf: r => 1000 + r + (r >= 10 ? epoch * 10000 : 0)});
  const timer = setInterval(() => { epoch++; }, 40);
  const e = j(await p.run());
  clearInterval(timer);
  assert.equal(e.diagnostics.complete, false);
  assert.ok(['view-changed', 'no-progress', 'budget', 'complete'].includes(e.diagnostics.stopReason));
  if (e.diagnostics.stopReason === 'complete') assert.equal(new Set(e.records.map(r => r.appid)).size, e.records.length);
}

// 6. Resume bound to the view: a different displayed count discards earlier state.
{
  const p = makeWishlistPage({n: 120});
  const first = j(await p.run({callBudgetMs: 60}));
  assert.ok(first.inProgress);
  p.state.count = 121; p.state.n = 121; // the list changed between calls
  const e = j(await p.run({}));
  assert.ok(e.warnings.some(w => w.includes('view or item count changed')));
  assert.equal(e.diagnostics.expectedCount, 121);
}

// 7. Bounded incomplete result: a step cap returns a warned partial capture.
{
  const e = j(await makeWishlistPage({n: 80}).run({maxSteps: 1}));
  assert.equal(e.diagnostics.complete, false);
  assert.equal(e.diagnostics.stopReason, 'budget');
  assert.ok(e.records.length > 0 && e.records.length < 80);
}

// 8. Empty page: a verified empty wishlist is distinct from a page that has not loaded.
{
  const empty = makeWishlistPage({n: 0, count: 0});
  empty.state.rendered = [];
  const e = j(await empty.run());
  assert.equal(e.records.length, 0);
  assert.equal(e.diagnostics.stopReason, 'empty-verified');
  assert.equal(e.diagnostics.complete, true);
  const unloaded = makeWishlistPage({n: 0, count: 5});
  unloaded.state.rendered = [];
  await assert.rejects(() => unloaded.run({callBudgetMs: 800}), /No wishlist rows rendered/);
  assert.equal(unloaded.ctx.window.__gcWishlistRun, undefined); // failed runs clean up too
}

// 9. Guards and options.
{
  await assert.rejects(() => makeWishlistPage({n: 10, width: 700}).run(), /reduced layout/);
  const e = j(await makeWishlistPage({n: 12}).run({forceFileTransfer: true}));
  assert.ok(JSON.stringify(e).length >= 80000 && e.transportPadding);
  assert.equal(e.diagnostics.recordsSha256, sha(e.records));
  const f = j(await makeWishlistPage({n: 12, search: 'zzz'}).run());
  assert.equal(f.diagnostics.view.search, 'active');
}
console.log('Claude Code page script behavior checks passed');
