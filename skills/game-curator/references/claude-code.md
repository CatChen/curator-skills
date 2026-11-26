# Claude Code (desktop app): Steam wishlist collection

Use this when the session has the built-in browser tools (`mcp__Claude_Browser__*`: `navigate`, `javascript_tool`, `resize_window`, ...). It is a tested path for the **wishlist only**. The bundled Codex collectors need a `tab.playwright.evaluate` object that this runtime does not provide, so they cannot run here. Library, reviews and Replay have no Claude Code collector yet; use [acquisition](acquisition.md#recovery) for them.

Tested collector: [`scripts/claude-code/steam-wishlist-page.js`](../scripts/claude-code/steam-wishlist-page.js) (page side) and [`scripts/claude-code/save-capture.mjs`](../scripts/claude-code/save-capture.mjs) (validate and save). Both are read-only on Steam and use no dependencies beyond Node built-ins.

## Procedure

1. **Browser and pane.** Use the built-in browser. Open the pane for the user (`mcp__ccd_view__show_pane` with `pane: "preview"`; navigating alone does not reveal it). Navigate to `https://store.steampowered.com/wishlist/`. If the page shows a sign-in form, ask the user to sign in normally in the pane and wait; never ask for credentials.
2. **Desktop layout.** The pane is about 700px wide by default and Steam then serves a reduced layout (no reorder handles, no labeled fields). Call `resize_window` with width 1280, height 900, then reload. The collector throws if `innerWidth < 1000`. The emulation can be cleared when a turn ends, so reapply it per session; reset with `preset: "desktop"` when done.
3. **Verify identity.** The URL redirects to `/wishlist/id/<vanity>/` and a signed-in view shows reorder handles and the account menu. Confirm with the user which account they expect and, if they have not already given a local alias, ask for one. Do not infer `account` from the persona name.
4. **Run the collector.** Read the page script and pass its **entire text** as `text` to `javascript_tool` (`action: "javascript_exec"`). It registers `window.__gcWishlistRun`. A 165-row list took 10-15 s (one call). If it returns `{inProgress: true, ...}` run `await window.__gcWishlistRun({})` (a one-line call) until it returns the envelope. Options go in the final `({})`: `callBudgetMs` (35000), `maxMs` (150000), `maxSteps` (1000), `fresh` (discard saved page state).
5. **Bulk transfer.** The envelope is about 60 KB, larger than the tool-result limit, so the runtime writes it to a file and returns its path (JSON array of `{type,text}`). That is the supported transfer: do not copy the data through model context or retype it.
6. **Validate and save.** Only with the user's cache authorization (`settings.json` has `steamCache: true`) run:

   ```bash
   node <skill>/scripts/claude-code/save-capture.mjs <tool-result-file> --account <alias> --access-scope signed-in --dry-run
   ```

   Check the printed decision, then repeat without `--dry-run`. Add `--existing-account <alias>` only when the user has confirmed that an existing `wishlist.json` without an `account` field belongs to that alias. The script verifies format, source, contiguous ranks, unique AppIDs, no placeholder names and the page-computed SHA-256 of the records, then applies the replacement policy, reads the saved file back and prints its checksum. Delete the tool-result file afterwards.
7. **Report** elapsed time, calls, `warnings`, `diagnostics` and the save decision. The collector returns `coverage: partial` even when counts match, as the Codex collector does.

## Replacement policy implemented by `save-capture.mjs`

A new capture becomes `wishlist.json` only if there is none, or the existing file is a valid wishlist envelope with the same verified `account` and `accessScope`, an older `capturedAt`, and no lower rate of labeled fields (`RELEASE DATE:`, `ENGLISH REVIEWS:`, `USER TAGS:`) per row. The old file is first preserved as `wishlist.superseded.<timestamp>.json`, and the new file is written to a private temporary file and renamed. In every other case (unknown or different account, different scope, older, poorer, malformed existing file) it writes `wishlist.partial.<timestamp>.json` with exclusive creation and leaves existing files untouched. It never merges wishlists.

## Output contract

The envelope is `game-curator-steam-export` version 1 with the same record fields as the Codex collector (`appid`, `rank`, `name`, `pageText`, `membershipSource`). `method` is `browser-dom-claude-code`. `capturedAt` is the time the page script finished reading rows; `diagnostics.startedAt`/`finishedAt` bracket the acquisition. `account` and `accessScope` are added by the saver from verified values only. Extra diagnostics (`recordsSha256`, `scrollSteps`, `calls`, `timersThrottled`, `viewportWidth`, ...) are informational.

## Observed runtime behavior (Claude desktop app, built-in browser)

Verified on the maintainer's signed-in wishlist (165 items), 2026-11-26:

| Capability | Result |
| --- | --- |
| `javascript_tool` runs async page code with loops, `await`, DOM reads and `crypto.subtle` | Verified |
| Page state persists between calls in the same tab (`window.*`) | Verified |
| Per-call time limit | Restriction: a 100 s wait was cut off at 45 s ("timed out"). The collector yields at 35 s and resumes |
| Result size | A 71k-character result is written by the runtime to a tool-result file with its path returned. Keys in that file are alphabetized and a `(captured at origin ...)` line is appended, which the saver handles (key order is restored before checksum comparison) |
| Pane default width | About 703px, which triggers Steam's reduced layout. Verified fix: `resize_window` 1280x900 + reload |
| Timer throttling | `setTimeout(120)` took about 1 s each while the pane was unfocused, even with `visibilityState` "visible". The collector calibrates and then waits by polling a `MessageChannel` |
| Wishlist list is virtualized | Only 14-26 rows exist at a time and a scroll takes 0.1-1.8 s to re-render. Fixed-step scrolling skipped ranks 15-35 in a test; the collector seeks the lowest missing rank and waits for the rendered window to change |
| Lazy rows | Rows can show placeholder text (for example `MY CATEGORIES:`) before their data loads; the collector treats a row as complete only when its app link has text |
| `tab.playwright.evaluate` object (needed by the Codex collectors) | Not provided in this runtime, so those collectors cannot run here |
| Local Node process driving the browser; browser-initiated file download | No supported tool found / untested. The tool-result file is the verified transfer |
| Claude in Chrome (`mcp__claude-in-chrome__*`) | Untested with this script |

## Benchmarks (165 rows, unfocused pane)

| Run | Calls | Elapsed in page | Scroll steps | Result |
| --- | --- | --- | --- | --- |
| Manual browser tool calls, previous session | not counted (about 5 min wall clock) | n/a | repeated manual scrolls | 165 rows after placeholder repair |
| Final script, single call | 1 | 14.1 s | 7 | 165/165, 0 placeholders, contiguous ranks |
| Final script, forced resume (3 s budget) | 3 | 10.8 s | 7 | identical records and checksum |
| First fixed-step version, pane focused | 1 | 12.4 s | 42 | 165/165 |
| First fixed-step version, pane unfocused | 2 | 42 s | 192 | **144/165, ranks 15-35 missing**: rejected by the saver |

Records from the successful runs were identical (same SHA-256), and identical to the saved cache. Remaining time is dominated by the page's own render latency, not by transfer or saving.

## If this collector fails

Treat it as an adapter failure, not a browser failure. Keep the browser session, inspect a representative row with `javascript_tool`, and follow the [recovery procedure](acquisition.md#recovery): adapt a temporary copy (selector, scroll container, waits), validate counts, contiguous ranks and names, and report. Do not edit the installed skill during ordinary curation; send a sanitized maintenance report instead. If `javascript_tool` is unavailable, use `read_page`/`get_page_text` with `computer` scrolling and the same validation, or an export.
