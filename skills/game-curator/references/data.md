# Steam data and tools

These experimental browser-runtime collectors return serializable objects to the agent. They use read-only page DOM evaluation and supported browser navigation and scrolling; they do not read internal page state, fetch metadata, download files, or change account state. Personal exports may contain account identifiers, reviews and sensitive history; store them outside the repository and review before sharing with an AI runtime.

| Source | Page and operation | Limitations |
| --- | --- | --- |
| Library | `scripts/steam-library.mjs` → `collectLibrary(tab)` on the verified Steam Community all-games page. In Claude Code (built-in browser or Chrome) use the page script in [Claude Code](claude-code.md#library-built-in-browser-claude-in-chrome-differs-only-in-delivery). | Scans DOM rows and scrolls within a bound. Virtualization, nested scroll containers or changed selectors may omit items. English parsing only. |
| Wishlist | `scripts/steam-wishlist.mjs` → `collectWishlist(tab)` on the verified Steam Store wishlist. | Scrolls and deduplicates rendered rows; rank is a displayed position, not verified global priority. Verify account, filters and coverage. No internal cache or metadata lookup. |
| Reviews | `scripts/steam-reviews.mjs` → `collectReviews(tab)` on the verified Community `/recommended` page. In Claude Code (built-in browser or Chrome) use the page script described in [Claude Code](claude-code.md#reviews-built-in-browser-claude-in-chrome-differs-only-in-delivery). | Follows observed pagination links and preserves review text, polarity, date and playtime where available. Public views can omit private reviews. Pass `{library, verifiedSameAccount:true}` only after verifying both captures belong to the same account to add names with provenance. |
| Replay | `scripts/steam-replay.mjs` → `collectReplay(tab)` on an annual Replay page. In Claude Code (built-in browser or Chrome) use the generated `scripts/claude-code/steam-replay-page.js` and the saver instead ([Claude Code](claude-code.md#replay-built-in-browser-claude-in-chrome-differs-only-in-delivery)); it waits for each report to finish rendering and writes per-year files. | Follows observed same-account year links and retains semantic text and deduplicated AppIDs from links or image assets. Image assets are possible references, not proof the game was played. Metrics are not fully structured; percentages are not absolute playtime. |

For each source verify the account, source identity, representative records, observed count and any pages or scroll ranges that were inaccessible. The library goal is membership plus labeled playtime, last played and achievement counts; repeat scoped batches across the full list, and note any gaps. The wishlist goal is membership and order, with names, dates and release metadata when available. The reviews goal is all accessible pages, with text, polarity, dates, playtime and review links when available; track page coverage and missing fields. Replay's goal is per-year activity, game percentages, sessions, monthly activity, achievements and streaks; preserve relevant semantic evidence and report missing metrics. No count match proves full coverage. Use the [recovery procedure](acquisition.md#recovery) when a strategy or selector fails.

The Codex wishlist collector uses small browser scrolls, bounded retries for lazy rows and missing-rank seeking. Check `missingRanks`, placeholder warnings and the partial coverage label; a stalled or interrupted run retains the records already observed.

## Running from a supported browser runtime

The collectors below need a tab object with `playwright.evaluate`, as in Codex. In Claude Code's built-in browser follow [Claude Code](claude-code.md) instead; it produces the same envelope. In Codex's computer-use JavaScript runtime, first create or select a tab in the user's chosen browser, navigate to the source page, and verify the account and the page. `skillPath` is the absolute path of the loaded `SKILL.md`; resolve scripts relative to it, not a hardcoded checkout. For example:

```js
const { pathToFileURL } = await import('node:url');
const moduleUrl = new URL('./scripts/steam-wishlist.mjs', pathToFileURL(skillPath));
const { collectWishlist } = await import(moduleUrl.href);
const result = await collectWishlist(tab);
nodeRepl.write({diagnostics: result.diagnostics, warnings: result.warnings});
```

Use the matching module and function in the table for each source. The passed tab must provide `playwright.evaluate` for read-only DOM extraction, `goto` for reviews/Replay, and supported `scroll` or a body `PageDown` locator for wishlist/library. Follow the host's actual instructions and permissions. Access to the browser does not prove authentication; the caller must verify source identity and account before collection. The collectors return `coverage: partial` even if counts match. Read `warnings` and `diagnostics`; if collection is interrupted they return any captured records with a warning when possible. Review and Replay navigation are bounded and stop on unexpected redirects. Write JSON outside the repository only if the user authorizes storage and the runtime permits it. No Python, special browser extension, API key, or page-console paste is required.

### Persisting results from the host runtime

Keep each complete result in the outer JavaScript runtime until the authorized cache write is verified. The browser page's read-only evaluation context is distinct from the host REPL holding `result`: restrictions on page evaluation do not by themselves describe the host's filesystem capabilities. Inspect the host tool instructions and permissions. If the outer runtime supports Node's built-in filesystem library, first test a synthetic object in a permitted private temporary directory. For example, in the same REPL, with `probePath` a new, trusted, host-permitted path:

```js
const fs = await import('node:fs/promises');
const probe = { synthetic: true, records: [1, 2] };
await fs.writeFile(probePath, JSON.stringify(probe), { flag: 'wx', mode: 0o600 });
const probeBack = JSON.parse(await fs.readFile(probePath, 'utf8'));
if (JSON.stringify(probeBack) !== JSON.stringify(probe)) throw new Error('Probe mismatch');
await fs.unlink(probePath);
```

After separate raw-cache consent and a successful probe, this example writes the complete `result` from the collector above to a **new**, trusted path that the host has explicitly permitted; it does not overwrite an existing cache:

```js
const bytes = JSON.stringify(result, null, 2);
await fs.writeFile(authorizedNewFile, bytes, { flag: 'wx', mode: 0o600 });
const saved = JSON.parse(await fs.readFile(authorizedNewFile, 'utf8'));
if (JSON.stringify(saved) !== JSON.stringify(result)) throw new Error('Cache mismatch');
```

Use a direct destination only when permitted. Otherwise, if supported, write a private temporary staging file and transfer it using the host's supported mechanism and normal destination approval. Staging does not grant destination access. Compare existing caches first, use a safe host-supported commit, reread the final file and compare with the original object; clean up temporary files on success or abandonment. Never send complete datasets or encoded copies through model context, or use page evaluation for filesystem access. Node is an example, not a requirement for other hosts. Follow [safe replacement and verification](persistence.md#freshness-refresh-and-safe-replacement) and [recovery](acquisition.md#recovery).

## Using collected or supplied data

Each collector returns `format: game-curator-steam-export`, `version: 1`, a `source`, `capturedAt`, `method`, `coverage`, `warnings`, `diagnostics`, and `records`. Keep captures and their timestamps separate; check source, account, AppIDs, missing fields and warnings before drawing conclusions. Compare counts and representative fields with the page, and treat a count match as evidence rather than proof of completeness. Collectors deduplicate records within a capture; there is no automated multi-capture merge, archive validator, or historical-format importer. Authorized caching, selective refresh and safe replacement follow [persistence](persistence.md).

For library rows the collector parses labeled English playtime, last-played display and achievement counts while preserving `pageText`. Missing values stay null, minutes are converted to hours, and dates without a year remain unchanged. Non-English page labels may not parse. Do not use file size as playtime. Historical library v2 exports had unreliable `hours`; do not treat those values as validated. Without reliable labeled evidence, report playtime as unknown. The skill can still use user-provided observations and review text without claiming an automated import or validation.

Only combine observations across captures when the user has confirmed they belong to the same account; do not silently override conflicting identity or fresher evidence. A historical wishlist is not proof of current membership, and a missing field in a newer partial capture does not invalidate an older value. Keep provenance and uncertainty visible. If a runtime cannot run the collectors, use uploaded data or conversation and explain any limitations.
