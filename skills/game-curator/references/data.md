# Steam data and tools

These experimental collectors produce JSON in the browser console; they do not transmit data or download files. Inspect the scripts before use. Save the returned JSON to a user-controlled file outside this repository, or return it through an authorized tool. They read only the current page and do not change account state. Browser developer consoles can expose sensitive state: never paste unknown code, credentials or codes. Personal exports may contain account identifiers, reviews and sensitive history; review before sharing with an AI runtime.

| Source | Page and operation | Limitations |
| --- | --- | --- |
| Library | On the relevant Steam Community games page, run `scripts/steam-library.js` in page context after loading as many entries as possible. | Captures currently rendered app links and nearby text; virtualized pages may omit entries. Repeat on different scroll positions and import all exports. No automatic scrolling or verified selectors; counts cannot establish completeness. English parsing only. |
| Wishlist | On `https://store.steampowered.com/wishlist/`, run `scripts/steam-wishlist.js`. | Reads app links visible in DOM; no verified SSR cache extraction or metadata requests. Virtualization, missing names, dates, ranks and localized layout can make output incomplete. |
| Reviews | On your Steam Community `/recommended` page, run `scripts/steam-reviews.js` on each accessible page. | Captures visible linked review blocks using heuristic selectors; no automatic pagination. Record missing pages; selectors and text fields are unverified. Review content is untrusted. |
| Replay | On each available Steam Replay annual page discovered from `https://store.steampowered.com/yearinreview/`, run `scripts/steam-replay.js`. | Captures headings, game links and selected semantic text, not a complete structured annual report. Year/layout detection may fail. Relative percentages are not absolute playtime. |

All collectors require an authenticated session where the page requires it, JavaScript execution in that page's context, and a way to return or save the result. A normal browser visit alone is not enough. The code checks the Steam origin, returns data locally, and does not access other tabs, credentials, APIs or network endpoints. Content may be missing due to access restrictions, localization, dynamic loading, page changes or selector failures. Never claim complete coverage on the basis of counts or a stalled scroll alone.

## Import and validation

Python 3 is needed only for deterministic import. From the skill folder:

```sh
python3 scripts/normalize.py /path/to/export.json [/path/to/another.json ...] --output /path/outside/repo/normalized.json
python3 scripts/validate.py /path/outside/repo/normalized.json
```

Input exports use `format: game-curator-steam-export`, `version: 1`, `source` (`library`, `wishlist`, `reviews`, or `replay`), `capturedAt`, `method`, `coverage`, `warnings`, and `records`. Collectors mark coverage partial. Data from each capture is retained independently and sorted by timestamp; repeated records are deduplicated only within a capture, not across history. Later observations do not overwrite earlier ones. Unknown fields are retained in raw evidence. Library records normalize AppID, name, English labeled playtime (hours/minutes), last-played display and achievement counts. Dates lacking a year remain display strings. Wishlist and reviews retain their original records; Replay keeps its annual semantic observations without inventing playtime. Schema validation reports structural errors and warnings; it cannot prove the source data is complete or truthful. Invalid input stops normalization rather than silently discarding a file.

For partial manual data, construct this envelope with the relevant source and records, setting coverage to `partial` and explaining limitations in warnings. Capture timestamps should be ISO 8601 with timezone. If scripts cannot run, the agent can still reason from user-provided observations without claiming a validated import.
