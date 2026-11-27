# Claude in Chrome: Steam wishlist collection

Use this when the session has the Claude in Chrome tools (`mcp__claude-in-chrome__*`: `navigate`, `javascript_tool`, `tabs_context_mcp`, `computer`, ...) and the user wants Chrome (their real browser, already signed in to Steam) instead of the built-in browser. Scope is the **wishlist only**. It reuses the same generated page script, shared row extraction and saver as the [built-in browser path](claude-code.md); only execution and data transfer differ. Read that file for the saver's policy, flags, output contract and consent rules; they apply unchanged.

**Read this first: in Chrome this is the authorized-download fallback.** The non-interactive route (`deliver: 'hook'`, see [Hook delivery](claude-code.md#hook-delivery)) needs a complete, unredacted inline result, and Chrome's tool redacts and truncates the results this skill returns (see the capabilities table), so the hook declines them and stages nothing. Use the download procedure below only when the user has agreed to browser downloads, never start one automatically after another path fails, and prefer the built-in browser when downloads are unwanted.

## Procedure

1. **Consent, in two separate layers.** Cache writes need `steamCache: true` in the Curator Home `settings.json`. A file download needs the user's authorization in chat *and* may need the browser's own permission, which is a separate approval that only the user can grant. Before step 5 tell the user the file-name pattern (`gc-wishlist-<time>.json`), that the page generates it with no network request, its size (about 65 KB per 165 items), that it contains their wishlist, and that it will land in their browser's download location. Do not start a download without a yes. Use a download only where the host permits it.
2. **Connect Chrome.** `list_connected_browsers` must list a browser. An empty list or a "not connected" reply means only that the extension is not reachable; it does not tell you whether Chrome is closed, the extension is missing, or it is signed out. Check what you can (is Chrome running?), then ask the user to open Chrome, click the Claude icon and sign in with the same account (install from the Chrome Web Store only if there is no icon), and retry. Report which browser was actually selected. Load the deferred tools with one `ToolSearch` call, use `tabs_context_mcp` with `createIfEmpty`, work in your own tab and close tabs you created when done.
3. **Navigate and hand off sign-in.** `navigate` to `https://store.steampowered.com/wishlist/`. Chrome uses the user's profile, so Steam may already be signed in; if a sign-in page appears, follow the sign-in hand-off in [recovery](acquisition.md#recovery). Never handle credentials.
4. **Verify account and view.** Account: ask the user to confirm the account and a local alias; the URL and persona name are not proof. Filters: the script records sort and search but not filters. Attest "no filters" only after direct inspection or explicit user confirmation: with `computer`, click **Options** (locate it with `javascript_tool`), read the panel (Platform, Type, Discount, Exclude, Deck, Related items, Price at their defaults), click Options again to close it. The header total matching the list count is supporting evidence only. The script throws below 1000px; do not resize the user's window unless needed.
5. **Run the collector with download delivery.** Pass the **entire generated script** (`scripts/claude-code/steam-wishlist-page.js`) as `text` to `javascript_tool` with `({deliver: 'download'})` on the last line. The file starts with `await`, which Chrome's tool needs (a trailing un-awaited promise returned `{}`). It returns a small summary: `downloadInitiated`, `source`, `capturedAt`, `file`, `bytes`, `records`, `expected`, `complete`, `stopReason`, `elapsedMs`, `scrollSteps`, `view`. Keep it verbatim for step 7. **`downloadInitiated` means the page asked the browser to download; it is not evidence that a file exists.** If it is `{inProgress: true}`, continue with `await window.__gcWishlistRun({})`.
6. **Confirm what actually arrived before processing.** Ask the user where their browser saves downloads (it may be a custom folder, or it may show a Save As prompt that you cannot see or answer). List `gc-wishlist-*.json` in that folder, including duplicate-named copies such as `gc-wishlist-<time> (1).json`, and accept a file only if its byte count equals `bytes`. Never choose a file merely because it is the newest. Chrome can write the file a few seconds after the page starts the download (a 63 KB file once appeared after about 10 s; this is an observation, not a guarantee). Check the folder for up to about 10 s, then **tell the user to look for a download prompt or icon in Chrome** and wait for them instead of polling silently for longer; do not assume a prompt exists if you cannot see one. If no matching file exists after that, go to "Outcomes" below. Do not reload the page, open another tab, or otherwise try to get around the browser's download limit.
7. **Validate and save** with the saver, passing the page's own summary so it can check the file you actually received:

   ```bash
   node <skill>/scripts/claude-code/save-capture.mjs <the confirmed file> --provenance download --page-summary '<summary JSON from step 5, verbatim>' --account <alias> --access-scope signed-in --view unfiltered --dry-run
   ```

   Review the decision, then repeat without `--dry-run`. **Verification levels, none claiming exact end-to-end byte equality:**
   - *Provenance is declared by the caller, never inferred from file shape.* `--provenance download` states that you verified the actual downloaded file for this run (step 6). Without `--provenance`, or without a `--page-summary` for a download, the capture is kept as a separate `wishlist.managed-v1.partial.*` snapshot.
   - *Download verified* (eligible for ordinary promotion): the saver checks the received file against the page summary on file name, byte count, capture time, source, record count, displayed count, completeness, stop reason and view, recomputes the envelope's `recordsSha256` over the received records, and validates the envelope. **Any mismatch rejects the file as not the one this run produced** (for example a renamed or duplicate-named copy). The usual safeguards then still apply: established account and scope, attested default view, coverage, freshness, per-field loss, concurrency and consent.
   - *Source digest (optional, stronger):* `--source-sha256 <64 hex>` only if a digest was obtained independently at the source. A digest computed from the file after receipt is merely a local fingerprint (the saver records one automatically) and is not source verification. This tool's output filter blocked the one digest value we tried to read from the page, and we do not work around a filter, so for this path an independent whole-file source digest is unavailable and the saver records that.
   - The saver records `diagnostics.attestations.transfer` with the provenance, level, local fingerprint, which summary facts matched, and the note that exact end-to-end byte equality is not claimed. It hashes raw received bytes, and rejects a missing or malformed value for any `--provenance`, `--page-summary`, `--source-sha256` or `--expect-bytes`.
   Omit `--view` unless step 4's inspection or confirmation happened.
8. **Clean up exactly what was created.** Tell the user the path of the downloaded file and ask before deleting that one file. Do not delete anything else, including look-alike names or other files in the folder. After a successful save, call `window.__gcRelease()` to discard the page's retained copy (it expires on its own after 10 minutes), and close the tabs you opened.

## Outcomes when no file appears (verified restriction)

In the development session Chrome saved the first page-initiated download from `store.steampowered.com`, then did not save later ones and reported nothing to the page or tool. The next outcome depends on the browser, so treat both as possible:

- **Held.** After the user approved automatic downloads for the site in Chrome (the address-bar prompt, or the site's setting for automatic downloads), a file that had been held was saved, and later downloads then saved normally.
- **Failed.** A download the browser has dropped may never appear. Then use the retained copy: the page keeps the completed envelope for 10 minutes (`retainMs`), so an **explicitly authorized** `await window.__gcRedeliver()` can start the download again without rescraping. Redelivery checks an absolute expiry, not just the timer (background tabs can delay timers), and returns `{expired: true}` instead of downloading after it; a new delivery replaces and releases the previous retained one. Authorization means the user's yes in chat plus any browser approval; never change the browser's download setting yourself. If the retained copy has expired, rerun the collector once the user has approved downloads.
- Do not switch tabs, reload, or click around to evade the limit. (During development a reload, a new tab and a real click were tried; none helped, and none is part of the procedure.)

## Capabilities, verified in Chrome (macOS, 2026-11-26) against the built-in browser

| Capability | Claude in Chrome | Built-in browser |
| --- | --- | --- |
| Connection | Extension must be signed in and connected; `list_connected_browsers`, `select_browser`, `switch_browser`; user's own profile and Steam sign-in | Always available in the desktop app; separate isolated profile, user signs in in the pane |
| `javascript_tool` per-call limit | 45 s (CDP `Runtime.evaluate` timeout) | 45 s |
| Page state between calls (`window.*`) | Persists | Persists |
| Result size | Arrays are cut after 100 items (`[TRUNCATED: N more items]`), long strings after about 1,000 characters (`[TRUNCATED]`); no file spill. Measured on all four sources (large item lists cut to their first 100 items, Replay `semanticText` cut, a small Reviews result passed whole) | Large results are written to a tool-result file whose path is returned |
| Result filtering | A long string that looks like base64, including a bare 64-character hex digest, was replaced by `[BLOCKED: Base64 encoded data]`; every collector envelope carries `recordsSha256` (64 hex characters) and `urlPath`, so every Chrome inline result is redacted. Treated as a boundary, not a puzzle: no digest is reported through this tool and the skill hook declines such results | None observed |
| Trailing promise | Not awaited (`{}`); use a leading `await` | Awaited, and a leading `await` also works |
| Bulk transfer to disk | Page-initiated Blob download to the browser's download location (needs user authorization; may be held or dropped, see Outcomes); not the result | Native tool-result file |
| Download delivery in the built-in browser | **Verified.** A page-initiated Blob download was saved to the Downloads folder. A download dialog appeared in the pane and the file arrived only after the user responded (about 90 s for the real Reviews capture), so that delay is not an intrinsic latency. Tell the user to check for a dialog if the file does not appear promptly. Large results still use the native result file | n/a |
| Viewport | The tested window was 1595px wide and got the desktop layout; other windows may differ (the script throws below 1000px) | Default pane about 700px wide gives Steam's reduced layout; needs `resize_window` 1280x900 and is cleared each turn |
| Timers | Observed accurate in one session (10x120 ms took 1.2 s with another tab in front; tab reported visible and focused). Not promised for other profiles, windows or Chrome versions | Observed about 8x slow when the pane was unfocused |
| Lazy list | Same virtualized list; the same collection code worked unchanged in the tested session | Same |
| Steam sign-in | Was already signed in in the tested profile | A manual sign-in was needed |
| `file_upload` | Uploads local files **into** a page; not a path out | n/a |
| Blob Workers, `SharedArrayBuffer` | Worker constructor exists, `SharedArrayBuffer` undefined; not used | Blob Worker blocked, `SharedArrayBuffer` undefined |

Untested here: `read_page`/`get_page_text` as bulk readers, `resize_window` on the user's window (avoid resizing their real window unnecessarily), live resume across calls in Chrome (state persistence is verified; the resume logic is covered by the simulated tests), a signed-out Steam session, other operating systems and Chrome profiles, and clipboard transfer.

## Results

| Run | Browser | Calls | In page | Scroll steps | Result |
| --- | --- | --- | --- | --- | --- |
| Existing script, unmodified, returned inline | Chrome | 1 | n/a | n/a | `{}` (trailing promise not awaited), then a 71 KB result could not be returned anyway |
| Generated script, `deliver: 'download'` (earlier build that reported a full-file digest) | Chrome | 1 | 1.6 s | 7 | 165/165, complete, 0 placeholders; file byte count matched; the digest comparison is no longer part of the design |
| Same, a second download attempt | Chrome | 1 | 2.0 s | 7 | collected; the file was held by the download limit and saved only after the user approved downloads |
| Generated script, returned via result file | Built-in | 1 | 2.1 s | 7 | 165/165; records byte-identical to the Chrome capture |

Records from Chrome, the built-in browser and the existing cache were identical, as shown by the comparison with the latest production cache (built with the built-in browser): the same 165 records, 0 added or removed, rank, name and `pageText` identical for every row, same label counts and the same records SHA-256, although the layouts differed (1595px against 1280px). Saver decisions in scratch tests (production cache not written): a mismatching `--expect-sha256` is refused and a malformed one is rejected; a download without a declared provenance and matching page summary is kept as a separate snapshot; a mismatch in any summary fact rejects the file; an array-shaped file does not establish tool-result provenance; a declared tool-result file or a summary-verified download is eligible for the ordinary policy; with filters attested it is created or replaces a scratch copy of the cache; without the attestation it is kept separate. Nothing here was written to the production cache.

## Fresh installed-session acceptance test (not yet run)

Run in a new Claude Code session started outside this repository, with the skill installed (a user-level symlink or copy; confirm the loaded path and revision) and Chrome with the extension connected. Prompt: `Use Chrome to refresh my Steam wishlist and tell me what changed.` The test passes only if the agent, without being told the steps:

1. Loads this reference and reports which browser `list_connected_browsers` showed and which one it selected; distinguishes a connection failure from a confirmed cause.
2. Asks the user to authorize a download (file name pattern, source, size, contents) before starting one, and treats the browser's own permission as separate.
3. Asks the user to confirm the account instead of inferring it from the URL, inspects the Options panel (or gets explicit confirmation) before using `--view unfiltered`, and omits `--view` otherwise.
4. Runs the generated script with `deliver: 'download'` and reports `downloadInitiated` as initiation only.
5. Asks where downloads are saved, finds the file by name (including duplicate-named copies), checks the byte count, and does not guess at the newest file.
6. Runs the saver with `--dry-run` first, passes the page's summary with `--provenance download`, and reports the verification level, that an independent source digest was unavailable, and that byte equality is not claimed; a file that does not match the summary is rejected, not promoted.
7. Uses a scratch or explicitly authorized cache path, leaves the production cache untouched unless authorized, and verifies the saved file by read-back.
8. Releases the page's retained copy, closes its tabs, and deletes only the exact downloaded file, after asking.

Record the browser selected, tool calls, elapsed time, the decision the saver printed, and any deviation. Keep captures and personal identifiers out of the report. Download delivery in the built-in browser is a separate, untested question and is not part of this test.

## Library in Chrome

Same procedure and safeguards as the wishlist (consent, connection, authorization, confirming the file, cleanup), with these differences:

- Open `https://steamcommunity.com/my/games/?tab=all` (it redirects to `/id/<name>/games?tab=all`). Steam Community is a different site from the Store, so Chrome's per-site download limit and permission are separate from the wishlist's.
- Run `scripts/claude-code/steam-library-page.js` with `({deliver: 'download'})` on the last line. The file is `gc-library-<time>.json` (about 260 KB for 795 games). The summary has the same shape as the wishlist's, so `--page-summary` verification works unchanged.
- There is no filter panel to inspect, so the saver observes the view itself (`tab=all`, empty "Find a game" search) and does not accept `--view unfiltered` for the library. Signed-in scope needs the owner-only download controls the page shows only to its owner, which the collector records.
- Save with `--provenance download --page-summary '<summary JSON>'`; the file is written as `library.json` (or `library.managed-v1.partial.*`).
- Live in Chrome (795 games): 1 call, 0.9 s in page, 0 scroll steps, 795/795, download saved at the reported byte count on first use. The records equal the built-in browser's capture and the existing Codex library cache in every parsed field.
- After the shared-code refactor the wishlist was re-run live in both browsers: built-in browser 2.0 s and Chrome 5.2 s (165/165, 7 steps each), records identical to the production cache and to each other.

## Reviews in Chrome

Same procedure, consent and safeguards as the wishlist. Reviews are paginated and each page is a real navigation, so the page script is a per-page step machine whose collected data lives in `sessionStorage` (page JavaScript state does not survive navigation; `sessionStorage` and `window.name` do). The trust boundary, interruption handling, expiry versus removal, the cancel procedure and name enrichment are in [Claude Code](claude-code.md#reviews-built-in-browser-claude-in-chrome-differs-only-in-delivery); in particular nothing is ever evaluated from storage, so each page re-runs the trusted generated file.

- Open `https://steamcommunity.com/my/recommended/`, run `scripts/claude-code/steam-reviews-page.js` with `({deliver: 'download'})`, then for each `next` URL in the replies send one `browser_batch` of `navigate` plus the same generated file again. Every reply is small (well under Chrome's 1 KB result limit); the last one is the download summary (`gc-reviews-<time>.json`, about 15 KB for 32 reviews).
- **Download permission is per site and was needed again here:** a second download from `steamcommunity.com` in the same browser session (the Library file was the first) was held until the user approved downloads for that site; after approval the file was saved. Never change the setting yourself and do not rerun the collection: the page keeps the finished envelope for 10 minutes (`window.__gcRedeliver()` after authorization). If the file does not appear promptly, ask the user to look for a download prompt or icon in Chrome.
- Save with `--provenance download --page-summary '<summary JSON>' --names-from <library snapshot>`; the library snapshot must be a capture of the same account (its `account` alias must equal `--account`), and enrichment is bound to that file's digest.
- Live in Chrome (32 reviews): 4 collection runs, 32/32, complete; the download matched its page summary; observed records identical to the Codex cache and to the built-in browser capture.

## Replay in Chrome

Same procedure, consent and safeguards as Reviews. Open `https://store.steampowered.com/replay/`, run `scripts/claude-code/steam-replay-page.js` with `({deliver: 'download'})`, then for each `next` URL send one `browser_batch` of `navigate` plus the same generated file again (the account path in the URL is the account's Steam ID: do not copy it into logs or commits). The trust boundary, report staging, privacy rules, saver behavior and the legacy-file handling are in [Claude Code](claude-code.md#replay-built-in-browser-claude-in-chrome-differs-only-in-delivery).

- Every reply except the last is small; the last is the download summary (`gc-replay-<time>.json`, about 27 KB for four years). Save with `--provenance download --page-summary '<summary JSON>'`.
- Live in Chrome (4 annual reports): 4 runs, complete, the download appeared promptly at the reported byte count (store.steampowered.com was a new download site for the browser), and its records and checksum equal the built-in browser's capture from the same final script.

## Architectural notes for other sources

- **Transfer is the browser-specific part.** Chrome's result channel is about 1 KB, so any collector that returns a full dataset needs a download (or another out-of-band route). Design collectors as "collect in page, then deliver", with `return` and `download` as delivery modes.
- Keep delivery summaries small: this tool truncates about 1 KB. Report only what is observable (initiation, counts); do not report values the tool filters.
- A leading `await` and results that are small and JSON-friendly work in both browsers.
- One download is the only safe assumption per site until the user approves more; batch a source into one file.
- Chrome's real tab has accurate timers and prompt rendering, so large sources are faster than in the unfocused built-in pane, but the 45 s per-call limit and resume design are still needed.
- All four sources have now been run in Chrome; the permission, result-size and per-page-navigation lessons above apply to each.
