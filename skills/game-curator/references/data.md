# Steam data and tools

These experimental browser-runtime collectors return serializable objects to the agent. They use read-only page DOM evaluation and supported browser navigation and scrolling; they do not read internal page state, fetch metadata, download files, or change account state. Personal exports may contain account identifiers, reviews and sensitive history; store them outside the repository and review before sharing with an AI runtime.

| Source | Page and operation | Limitations |
| --- | --- | --- |
| Library | `scripts/steam-library.mjs` → `collectLibrary(tab)` on the verified Steam Community all-games page. | Scans DOM rows and scrolls within a bound. Virtualization, nested scroll containers or changed selectors may omit items. English parsing only. |
| Wishlist | `scripts/steam-wishlist.mjs` → `collectWishlist(tab)` on the verified Steam Store wishlist. | Scrolls and deduplicates rendered rows; verify account, filters, rank and coverage. No internal cache or metadata lookup. |
| Reviews | `scripts/steam-reviews.mjs` → `collectReviews(tab)` on the verified Community `/recommended` page. | Follows observed pagination links and preserves review text, polarity, date and playtime where available. Public views can omit private reviews. |
| Replay | `scripts/steam-replay.mjs` → `collectReplay(tab)` on an annual Replay page. | Follows observed same-account year links and retains semantic text and app links; metrics are not fully structured. Relative percentages are not absolute playtime. |

For each source verify the account, source identity, representative records, observed count and any pages or scroll ranges that were inaccessible. The library goal is membership plus labeled playtime, last played and achievement counts; repeat scoped batches across the full list, and note any gaps. The wishlist goal is membership and order, with names, dates and release metadata when available. The reviews goal is all accessible pages, with text, polarity, dates, playtime and review links when available; track page coverage and missing fields. Replay's goal is per-year activity, game percentages, sessions, monthly activity, achievements and streaks; preserve relevant semantic evidence and report missing metrics. No count match proves full coverage. Use the [recovery procedure](acquisition.md#recovery) when a strategy or selector fails.

## Running from a supported browser runtime

In Codex's computer-use JavaScript runtime, first create or select a tab in the user's chosen browser, navigate to the source page, and verify the account and the page. `skillPath` is the absolute path of the loaded `SKILL.md`; resolve scripts relative to it, not a hardcoded checkout. For example:

```js
const { pathToFileURL } = await import('node:url');
const moduleUrl = new URL('./scripts/steam-wishlist.mjs', pathToFileURL(skillPath));
const { collectWishlist } = await import(moduleUrl.href);
const result = await collectWishlist(tab);
nodeRepl.write({diagnostics: result.diagnostics, warnings: result.warnings});
```

Use the matching module and function in the table for each source. The passed tab must provide `playwright.evaluate` for read-only DOM extraction, `goto` for reviews/Replay, and supported `scroll` or a body `PageDown` locator for wishlist/library. Follow the host's actual instructions and permissions. Access to the browser does not prove authentication; the caller must verify source identity and account before collection. The collectors return `coverage: partial` even if counts match. Read `warnings` and `diagnostics`; if collection is interrupted they return any captured records with a warning when possible. Write JSON outside the repository only if the user authorizes storage and the runtime permits it. Python normalization is optional. No special browser extension, API key, or page-console paste is required.

## Import and validation

Python 3 is needed only for deterministic import. From the skill folder:

```sh
python3 scripts/normalize.py /path/to/export.json [/path/to/another.json ...] --output /path/outside/repo/normalized.json
python3 scripts/validate.py /path/outside/repo/normalized.json
```

To associate files the user has verified belong to the same account, supply an explicit local alias. For batches from the same acquisition, add a batch ID:

```sh
python3 scripts/normalize.py /path/to/batch-page-1.json /path/to/batch-page-2.json --account my-local-alias --batch-id acquisition-1 --output /path/outside/repo/normalized.json
```

The options apply to every input in that invocation; use `--batch-id` only if all inputs belong to that same acquisition, and omit it for unrelated captures. The alias is the user's explicit assertion, not automatic verification. Do not assign it without confirming account identity. Existing account or batch aliases that conflict are rejected, as are conflicting historical `user` identifiers; unknown identifiers cannot prove identity. Original exports are unchanged. Never infer a shared account simply because files appear together.

Input exports use `format: game-curator-steam-export`, `version: 1`, `source` (`library`, `wishlist`, `reviews`, or `replay`), `capturedAt`, `method`, `coverage`, `warnings`, and `records`. Optional `account` is a user-chosen, non-secret local pseudonym identifying the same account across captures; optional `batchId` groups pages of one acquisition. Never guess or use a shared default account identity. Different known accounts are rejected in one import; unknown identities are retained but excluded from the cross-capture view. These identifiers are still personal context and belong outside the repository.

Collectors mark coverage partial. Captures are retained independently and sorted by timestamp; original records are preserved in `rawRecords`, while normalized records are deduplicated within each capture. The `latestObservations` view selects the latest observed record per known account, source and AppID and includes earlier records in `previousObservations`. It is not a current membership snapshot: a historical wishlist union is not proof of current membership, and absence from a later partial capture does not imply removal. A missing field in a newer record is not evidence that an older value was absent or invalid; consult earlier observations and their dates. Multiple reviews for one AppID require consulting captures. Batch IDs label related captures but are not yet used to determine combined completeness. Library records preserve structured values except for known-buggy historical v2 hours, which are reparsed from English labeled page text; absent evidence yields null and the original remains in raw evidence with warnings. Dates lacking a year remain display strings. Wishlist and reviews retain their original records; Replay keeps its annual semantic observations without inventing playtime. Structural validation and warnings about invalid playtime and achievements cannot prove source data is complete or truthful. Invalid envelopes stop normalization rather than silently discarding a file. Historical library v2/v3, wishlist v3/v4, review v1/v2 and Replay v1 formats are accepted; historical imports retain the entire original export, use unknown account and coverage unless explicitly associated, and must be stored privately.

For partial manual data, construct this envelope with the relevant source and records, setting coverage to `partial` and explaining limitations in warnings. Capture timestamps should be ISO 8601 with timezone. If scripts cannot run, the agent can still reason from user-provided observations without claiming a validated import.
