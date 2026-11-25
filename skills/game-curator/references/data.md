# Steam data and tools

These experimental browser-runtime collectors return serializable objects to the agent. They use read-only page DOM evaluation and supported browser navigation and scrolling; they do not read internal page state, fetch metadata, download files, or change account state. Personal exports may contain account identifiers, reviews and sensitive history; store them outside the repository and review before sharing with an AI runtime.

| Source | Page and operation | Limitations |
| --- | --- | --- |
| Library | `scripts/steam-library.mjs` → `collectLibrary(tab)` on the verified Steam Community all-games page. | Scans DOM rows and scrolls within a bound. Virtualization, nested scroll containers or changed selectors may omit items. English parsing only. |
| Wishlist | `scripts/steam-wishlist.mjs` → `collectWishlist(tab)` on the verified Steam Store wishlist. | Scrolls and deduplicates rendered rows; rank is a displayed position, not verified global priority. Verify account, filters and coverage. No internal cache or metadata lookup. |
| Reviews | `scripts/steam-reviews.mjs` → `collectReviews(tab)` on the verified Community `/recommended` page. | Follows observed pagination links and preserves review text, polarity, date and playtime where available. Public views can omit private reviews. Pass `{library, verifiedSameAccount:true}` only after verifying both captures belong to the same account to add names with provenance. |
| Replay | `scripts/steam-replay.mjs` → `collectReplay(tab)` on an annual Replay page. | Follows observed same-account year links and retains semantic text and deduplicated AppIDs from links or image assets. Image assets are possible references, not proof the game was played. Metrics are not fully structured; percentages are not absolute playtime. |

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

Use the matching module and function in the table for each source. The passed tab must provide `playwright.evaluate` for read-only DOM extraction, `goto` for reviews/Replay, and supported `scroll` or a body `PageDown` locator for wishlist/library. Follow the host's actual instructions and permissions. Access to the browser does not prove authentication; the caller must verify source identity and account before collection. The collectors return `coverage: partial` even if counts match. Read `warnings` and `diagnostics`; if collection is interrupted they return any captured records with a warning when possible. Review and Replay navigation are bounded and stop on unexpected redirects. Write JSON outside the repository only if the user authorizes storage and the runtime permits it. No Python, special browser extension, API key, or page-console paste is required.

## Using collected or supplied data

Each collector returns `format: game-curator-steam-export`, `version: 1`, a `source`, `capturedAt`, `method`, `coverage`, `warnings`, `diagnostics`, and `records`. Keep captures and their timestamps separate; check source, account, AppIDs, missing fields and warnings before drawing conclusions. Compare counts and representative fields with the page, and treat a count match as evidence rather than proof of completeness. Collectors deduplicate records within a capture; there is no automated multi-capture merge, archive validator, or historical-format importer. Authorized caching, selective refresh and safe replacement follow [persistence](persistence.md).

For library rows the collector parses labeled English playtime, last-played display and achievement counts while preserving `pageText`. Missing values stay null, minutes are converted to hours, and dates without a year remain unchanged. Non-English page labels may not parse. Do not use file size as playtime. Historical library v2 exports had unreliable `hours`; do not treat those values as validated. Without reliable labeled evidence, report playtime as unknown. The skill can still use user-provided observations and review text without claiming an automated import or validation.

Only combine observations across captures when the user has confirmed they belong to the same account; do not silently override conflicting identity or fresher evidence. A historical wishlist is not proof of current membership, and a missing field in a newer partial capture does not invalidate an older value. Keep provenance and uncertainty visible. If a runtime cannot run the collectors, use uploaded data or conversation and explain any limitations.
