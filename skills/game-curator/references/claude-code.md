# Claude Code: built-in browser and Claude in Chrome

For Steam wishlist, library, reviews and Replay. The page scripts are generated; run them as shipped and never edit them. Both browsers use the same scripts and saver; only the transfer to disk differs. Claude Code CLI and other runtimes are best-effort. Recovery, saving policy and identity are in [acquisition](acquisition.md).

| Source | Start URL | Script (`scripts/claude-code/`) | Notes |
| --- | --- | --- | --- |
| Wishlist | `https://store.steampowered.com/wishlist/` | `steam-wishlist-page.js` | needs a window at least 1000 px wide; `resize_window` 1280x900, reload, reset with `preset: "desktop"` after |
| Library | `https://steamcommunity.com/my/games/?tab=all` | `steam-library-page.js` | no `--view` flag; view is observed |
| Reviews | `https://steamcommunity.com/my/recommended/` | `steam-reviews-page.js` | one real navigation per page |
| Replay | `https://store.steampowered.com/replay/` | `steam-replay-page.js` | one navigation per year; the account path in the URL is the Steam ID: never log or commit it |

## Procedure

1. **Consent.** Cache writes need a recorded `steamCache: true` (a current instruction can decline, not grant). Built-in browser: reveal its pane (`mcp__ccd_view__show_pane` with `pane: "preview"`) and open the start URL. Chrome: see [Chrome](#chrome).
2. **Sign in, account and view.** If a sign-in page appears, follow the hand-off in acquisition Recovery. A URL or persona name never proves the account. With a binding, collect with identity (step 3) and ask nothing; otherwise ask the user to confirm the account and a local alias. Wishlist filters sit in an Options panel the script does not open, so `view.filters` is unknown: attest `--view unfiltered` only after opening Options and reading the filters (then closing it) or the user's explicit confirmation; otherwise omit it and report the uncertainty.
3. **Run.** Pass the whole text of the script as `text` to `javascript_tool` (`action: "javascript_exec"`); the file starts with `await`, which both browsers need. Options go in the literal on the last line: `fresh`, `identity: {salt}` (first call; remembered), `deliver`; Wishlist and Library also take `callBudgetMs` (35000), `maxMs` (150000) and `maxSteps`; Reviews and Replay take `callBudgetMs` (20000) and `maxPages` or `maxYears`. If it returns `{inProgress: true}`, continue with `await window.__gc<Source>Run({})` (Wishlist, Library, Reviews, Replay) until the envelope arrives. `deliver` is not remembered: restate it on every call.
4. **Reviews and Replay** navigate for every page or year: each reply gives `next`; navigate the tab there and run the same generated file again, each run in its **own** `javascript_tool` call (the hook does not see `browser_batch`). To cancel, run the file with `({cancel: true})`; cancel an abandoned run, because its data otherwise stays in the tab's `sessionStorage` until the tab closes. Stored state is data only and never evaluated; a sign-in redirect keeps saved data, so sign in and rerun. A run that did not settle is flagged in `diagnostics`; the saver rejects an obviously incomplete year or page set.
5. **Transfer** with `deliver: 'hook'` on every call (built-in browser). A large result (the wishlist and library) is written by the runtime to a native tool-result file whose path it returns: pass that path directly to the saver. A smaller result (Reviews, Replay) arrives inline and the skill's hook stages it privately and names the staged path: use `--provenance hook-capture`. If staging is not authorized (no `steamCache` consent in the selected home) use `deliver: 'return'`. If the hook says it staged nothing, read why; never reconstruct the data, rerun only to change serialization, or pad output. The saver removes the staged pair after a successful save; staged files expire after 24 hours. Downloads (`deliver: 'download'`) are an authorized fallback only, never started automatically.
6. **Save:** `node scripts/claude-code/save-capture.mjs <file> --dry-run` (add `--view unfiltered` for the Wishlist only after the check in step 2; the saver rejects it for Library, Reviews and Replay); with a verified binding no `--account` is needed, otherwise add `--account <alias> --access-scope signed-in`. Reviews also take `--names-from <library capture in the authorized cache of the same account>`. Review the decision, `curatorHome` and `destination`, then repeat without `--dry-run`.
7. **Report** time, tool calls, `warnings`, `diagnostics` and the save decision. A bounded stop (`stopReason` not `complete`), missing ranks, a count mismatch or an empty page is not saved over the current snapshot; an empty wishlist is "observed empty", not verified empty.

If a collector fails, treat it as an adapter failure: keep the session, inspect a representative row, adapt a temporary copy under Recovery, and keep partial captures. Without `javascript_tool`, use `read_page` or `get_page_text` with scrolling and the same validation, or an export. If Steam authentication disappears when the app closes, sign in again when a refresh is needed.

## Runtime facts

- A `javascript_tool` call is cut off at 45 s; the scripts yield before that (about 35 s for Wishlist and Library, 20 s for Reviews and Replay) and resume.
- Page state persists between calls in a tab (`window.*`), but not across navigations (Reviews and Replay use `sessionStorage`).
- A trailing un-awaited promise returns `{}`: keep the leading `await`.
- Large built-in browser results go to a native result file (about 40,000 characters and up).
- Steam's lists are virtualized: the scripts seek missing ranks and treat a row as loaded only when its app link has text; do not use a fixed-step scroller.
- An unfocused built-in pane runs timers slowly; the scripts wait on observers.

## Chrome

For Claude in Chrome (the user's own signed-in browser).

- Load its deferred tools with one `ToolSearch` call. `list_connected_browsers` must list a browser; an empty list means only that the extension is unreachable. Ask the user to open Chrome and sign in to the extension; report which browser was selected. Use your own tab and close tabs you created.
- Chrome's tool **truncates arrays after 100 items and strings after about 1,000 characters and replaces long hex or base64-looking values with `[BLOCKED…]`**, so every collector result is redacted inline and the hook declines it. Do not try to work around that. The only route to disk is a download the user authorizes.
- **Download.** Before starting, tell the user the filename pattern (`gc-<source>-<time>.json`), that the page generates it with no network request, the approximate size, that it contains their data, and where it will land; get a yes. The browser may also ask permission, which only the user can grant; never change its download setting. Run the script with `({deliver: 'download'})` on the last line; keep its small summary verbatim. `downloadInitiated` means only that the page asked the browser to download.
- **Confirm the file.** Ask where downloads are saved, list `gc-<source>-*.json` there (including `(1)` copies), and accept a file only if its byte count equals the summary's `bytes`; never choose by recency. Allow about 10 s, then ask the user to look for a download prompt in Chrome instead of polling. If nothing arrives, the file may be held until the user approves downloads for the site, or dropped: with the user's yes, `await window.__gcRedeliver()` re-issues the retained copy for 10 minutes without rescraping. Do not reload, open tabs or click around to evade the limit.
- **Save** the identified download with the saver and account flags as above. Check the summary against the file before saving.
- **Clean up** exactly what you created: call `window.__gcRelease()`, close your tabs, and ask before deleting the single downloaded file; delete nothing else.
