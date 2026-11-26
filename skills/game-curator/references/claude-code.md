# Claude Code (desktop app): Steam wishlist collection

Use this when the session has the built-in browser tools (`mcp__Claude_Browser__*`: `navigate`, `javascript_tool`, `resize_window`, ...). It is a tested path for the **wishlist only**; Library, Reviews and Replay have no Claude Code collector yet (see [acquisition](acquisition.md#recovery)). The Codex collectors need a `tab.playwright.evaluate` object that this runtime does not provide, so they cannot run here. Claude in Chrome uses the same script and saver with a different transfer; see [Claude in Chrome](claude-in-chrome.md). Claude Code CLI and other runtimes are best-effort recovery, not supported targets.

Files, all under `scripts/claude-code/` unless noted:

| File | Role |
| --- | --- |
| `steam-wishlist-page.js` | **Generated.** The standalone expression you paste into `javascript_tool`. Do not edit; run `node build-page-script.mjs` |
| `steam-wishlist-page.template.js` + `build-page-script.mjs` | Page orchestration (seek-scrolling, resume, bounds) and the generator that inlines the shared row code |
| `../browser/wishlist-rows.mjs` | Shared, self-contained row extraction and merge semantics used by this script **and** by the Codex `collectWishlist` |
| `save-capture.mjs` | Node saver: contract validation, cache policy, safe write and read-back |

## Procedure

1. **Consent first.** Raw cache writes need `steamCache: true` in the Curator Home `settings.json` ([persistence](persistence.md)); the saver checks it again and fails closed. Honor an explicit current instruction from the user over stored settings.
2. **Browser and pane.** Use the built-in browser and reveal its pane for the user (`mcp__ccd_view__show_pane` with `pane: "preview"`; navigating alone does not show it). Open `https://store.steampowered.com/wishlist/`. If a sign-in page appears, follow the sign-in hand-off in [recovery](acquisition.md#recovery): the user signs in normally, you wait, then verify and resume. Never handle credentials.
3. **Desktop layout.** The pane is about 700px wide by default and Steam then serves a reduced layout (no reorder handles or labeled fields). Call `resize_window` with width 1280, height 900, then reload. The script throws below 1000px. The emulation can be cleared when a turn ends; reset with `preset: "desktop"` when done.
4. **Verify identity and view.** The URL redirects to `/wishlist/id/<vanity>/`, but a URL alone does not establish whose account it is: ask the user to confirm the account and give their local alias for this capture, and never infer either from the URL, the persona name or an earlier capture. The script records the sort label and search-box state, but **not filters** (they sit in an Options panel it does not open), so `view.filters` is `unknown`. Matching item counts, equal records or an unchanged header total are supporting evidence only, never proof that no filter is active. Attest "no filters" (`--view unfiltered`) **only** after (a) directly inspecting the relevant controls with supported tools (open the Options panel and read the filter state, which changes only the page's view, and close it), or (b) the user explicitly confirms it for this capture. Otherwise omit `--view`: the capture is saved as a separate snapshot and does not replace or become the main cache.
5. **Run the collector.** Read `steam-wishlist-page.js` and pass its **entire text** as `text` to `javascript_tool` (`action: "javascript_exec"`). It registers `window.__gcWishlistRun` and runs (the file starts with `await`, which both browsers' tools accept). If it returns `{inProgress: true, ...}`, continue with the one-line call `await window.__gcWishlistRun({})` until the envelope arrives. Options go in the literal on the last line: `callBudgetMs` (35000, per call), `maxMs` (150000), `maxSteps` (1000) and `fresh`; `deliver` (`'return'` default, or `'download'` for tools that truncate large results, see [Claude in Chrome](claude-in-chrome.md)); `maxMs`, `maxSteps` and `deliver` are remembered across resume calls.
6. **Bulk transfer.** A full envelope is larger than the tool-result limit, so the runtime writes it to a file and returns its path (a JSON array of `{type,text}`). That native tool-result file is the only verified route: pass its path to the saver and never copy data through model context or retype it. If a small result comes back inline there is **no supported route to disk**: report that blocker, do not rerun the capture just to change how it is serialized, and do not pad the output to force a file (that would exploit an observed size behavior, not a documented transfer API). A user-supplied structured file (or `-` for stdin) is also accepted.
7. **Validate and save.**

   ```bash
   node <skill>/scripts/claude-code/save-capture.mjs <result-file> --provenance tool-result --account <alias> --access-scope signed-in --view unfiltered --dry-run
   ```

   Review the printed decision, then repeat without `--dry-run`. `--provenance tool-result` is the caller's statement that the file is the runtime's own tool-result file from this run; the saver never infers provenance from the file's shape, and without `--provenance` the capture is kept as a separate snapshot. `--account`, `--access-scope`, `--view unfiltered`, `--existing-account` and `--existing-view unfiltered` are **caller attestations**, not observations: pass them only for facts the user confirmed or you directly inspected for this capture (step 4); counts and record equality do not qualify. They are recorded in `diagnostics.attestations`, with the page's reported scope and a checksum of the original envelope, while the page's observed `diagnostics.view` and the rest of the evidence are kept as captured. `--existing-view` only fills evidence an older capture lacks; it never overrides a recorded non-default sort, active search or active filter. `--keep-separate` honors a user's decision not to promote. Use `--dest` and `--settings` for a user-specified custom location; the settings record must sit in a directory that contains the destination (symlinks resolved), and consent is re-read before anything is created and again before the commit. Then delete the tool-result file.
8. **Report** elapsed time, tool calls, `warnings`, `diagnostics` and the save decision, distinguishing live results from tests.

## What the saver validates and decides

It **rejects** (saves nothing) input that is not a valid v1 wishlist envelope: unexpected envelope or record fields (nothing is silently stripped), invalid `capturedAt`, `coverage`, `method`, `warnings`, non-positive AppIDs, empty names or `pageText`, wrong `membershipSource`, duplicate AppIDs or ranks, inconsistent counts, missing placeholder diagnostics, a records checksum that does not match the page's, a `signed-in` claim without the owner-only reorder-handle evidence, and zero rows without an empty-page observation, and anything that is not strictly a v1 wishlist envelope. It **keeps but never promotes** valid but incomplete captures as `wishlist.partial.<timestamp>.json`: a bounded stop, missing ranks, a count mismatch, and an **empty page**. Rows that never finished loading are **omitted** (never stored with blank or placeholder fields) and listed in `diagnostics.missingRanks`. A page showing 0 items is recorded as `empty-observed`, not as a verified empty wishlist, because an empty list has no owner-only reorder handles and the collector cannot independently verify the owner or filter state.

A capture becomes `wishlist.json`, by creation or replacement, only if its account and access scope are established (signed-in or public, with a verified account; `unknown` never qualifies) and it recorded the default sort, an empty search and caller-attested no filters. Replacement additionally requires: the existing file is structurally sound (valid required envelope fields, no duplicate AppIDs or ranks; older v1 files without newer diagnostics remain acceptable); same account, scope and coverage; strictly newer; the existing capture shows the same view evidence or the user confirmed it, and it does not record a conflicting one; no retained AppID lost a labeled field (release date, reviews, user tags, categories are checked individually, so a gained field never offsets a lost one); fewer than 5 `wishlist.superseded.*` backups exist; and the existing file is byte-identical at commit time as at decision time. A legitimately smaller unfiltered wishlist, or one with removed games, replaces. Otherwise the capture is saved beside it with exclusive creation. The previous file is preserved as `wishlist.superseded.<timestamp>.json` before a replacement. A lock file prevents concurrent savers. Nothing is merged and **nothing is ever deleted automatically**; at the backup limit the user decides what to prune. The final rename is not an atomic compare-and-swap, so the check narrows but cannot eliminate a race with an external editor; if the file changed, the capture is kept separately.

## Output contract

`game-curator-steam-export` version 1 with the same record fields as the Codex collector (`appid`, `rank`, `name`, `pageText`, `membershipSource`). `method` is `browser-dom-claude-code`; `capturedAt` is when the page script finished reading rows; `diagnostics.startedAt`/`finishedAt` bracket the acquisition. `account` and `accessScope` come from verified inputs at save time. `diagnostics` adds `complete`, `stopReason` (`complete`, `empty-observed`, `budget`, `no-progress`, `rows-missing`, `view-changed`), `missingRanks`, `view` (`sort`, `search`, `filters`, all observed), `recordsSha256`, timing counters and, after saving, `attestations`. Existing v1 caches stay readable, including ones without these fields.

## Shared code with the Codex collector

Row extraction (`snapshotWishlist`), merge (`mergeWishlistRow`: a loaded row is never replaced by a placeholder) and record shaping live in `scripts/browser/wishlist-rows.mjs`. They are self-contained functions because both hosts serialize them into a page: Codex passes the function to `evaluate`, and this runtime inlines its source into the generated script. Orchestration stays separate (Codex host-tab scrolling versus page-side seek, resume and file transfer). `collectWishlist` keeps its entry point and now reports placeholder rows instead of accepting them as loaded.

## Observed runtime behavior (Claude desktop app, built-in browser)

Verified live on a signed-in wishlist of about 165 items, 2026-11-26.

| Capability | Result |
| --- | --- |
| `javascript_tool` runs async page code (loops, `await`, DOM reads, `crypto.subtle`, `MutationObserver`) | Verified |
| Page state persists between calls in the same tab | Verified |
| Per-call time limit | Restriction: a 100 s wait was cut off at 45 s. The script yields at 35 s plus bounded waits and resumes |
| Large results | A 60-70k-character result is written to a tool-result file whose path is returned; keys are alphabetized and an origin line is appended (the saver restores order and checks the checksum) |
| Pane default width | About 703px; Steam serves a reduced layout. Fix: `resize_window` 1280x900 and reload |
| Timers in an unfocused pane | `setTimeout` and `scheduler.postTask` with delay ran about 8x slow (about 1 s per wait) even with `visibilityState` "visible". A `MessageChannel` wait was accurate but measured about 50,000 messages per second, a busy loop. The script therefore waits on a `MutationObserver` and uses timers only as deadlines |
| Web Workers, `SharedArrayBuffer` | Blob Worker creation failed on this page; `SharedArrayBuffer` is undefined. Not used |
| Virtualized list | 14-26 rows exist at a time and re-render 0.1-1.8 s after a scroll. A fixed-step scroller skipped ranks 15-35; the script seeks the lowest missing rank and waits for the window to change |
| Lazy rows | Rows show placeholder text before loading; a row counts as loaded only when its app link has text |
| `tab.playwright.evaluate` (Codex collectors) | Not provided here |
| Local Node driving the browser; browser-initiated download | No supported tool found / untested. The tool-result file is the verified transfer |
| Steam filters (Options panel) | Not opened; unknown by design. Sort and search state are read |
| Empty wishlist, signed-out page, Claude in Chrome | Not exercised live (simulated or untested). An empty page is only ever recorded as observed |
| Consistency checks during a run | The page re-reads URL, count, sort and search at every collection boundary and checks rank-to-AppID and AppID-to-rank conflicts among observed rows. Changes confined to ranks never observed cannot be detected (stated in the envelope warnings) |

## Results

| Run | Type | Calls | Time | Steps | Result |
| --- | --- | --- | --- | --- | --- |
| Manual browser tool calls, earlier | live | not counted | about 5 min | repeated | complete after placeholder repair |
| Final generated script | **live** | 1 | 20.4 s in page | 7 | 165/165, 0 placeholders, no restarts, checksum identical to earlier runs |
| Previous generated script (MutationObserver waits) | live | 1 | 19.6 s | 8 (1 backtrack) | 165/165 |
| Earlier busy-wait version | live | 1 | 14.1 s | 7 | 165/165 (replaced: CPU polling) |
| Earlier busy-wait version, forced resume | live | 3 | 10.8 s | 7 | identical records |
| Fixed-step version, unfocused pane | live | 2 | 42 s | 192 | 144/165, ranks 15-35 missing, rejected by the saver |
| Simulated virtualized page | test | n/a | n/a | n/a | placeholder-to-loaded, missing rank, stuck placeholder, resume, membership change at the same count, view-bound resume, step budget, verified empty, narrow viewport |

Live resume was exercised on an earlier version; the final version's resume, view-change and empty-page handling are covered by the simulated tests only. A fresh installed Claude session and a live Codex wishlist regression have not been run. Remaining time is dominated by the page's own render latency.

## Tests

```bash
node tests/game-curator/test_browser.mjs              # Codex orchestration, incl. the placeholder regression
node tests/game-curator/test_claude_code_page.mjs     # generated page script on a simulated DOM
node tests/game-curator/test_claude_code.mjs          # saver, policy, settings, end-to-end page -> saver, generated-file freshness
```

## Fresh-session acceptance (not yet run)

In a new Claude Code session outside this repository with the skill installed: ask `Refresh my Steam wishlist and tell me what changed`. Pass if the agent loads this reference, shows the pane, fixes the viewport, hands sign-in to the user, runs the generated script, saves via the saver with consent and the right flags, reads the file back, and reports warnings and unverified filters without being told the steps. Record tool calls, time, and any deviation. This has not been executed.

## If this collector fails

Treat it as an adapter failure, not a browser failure. Keep the session, inspect a representative row with `javascript_tool`, and follow the [recovery procedure](acquisition.md#recovery): adapt a temporary copy, validate counts, ranks and names, and preserve any partial capture (the saver keeps incomplete runs separately). Do not edit installed skill files during ordinary curation; report the failure instead. Without `javascript_tool`, use `read_page`/`get_page_text` with scrolling and the same validation, or an export.
