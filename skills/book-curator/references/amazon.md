# Amazon snapshots (historical evidence only)

Book Curator no longer collects from Amazon. Amazon displayed an access-restricted notice saying that continued access by an unauthorized AI agent violates its Conditions of Use, so the earlier browser collectors were removed. Do not open, scroll, scrape or otherwise automate Amazon, Kindle for Web, Manage Your Content and Devices, personal documents or Audible, in any browser or runtime, and do not retry elsewhere after a restriction. Amazon's official personal-data export is a possible future source; it has not been investigated and is not supported.

Snapshots saved earlier with the user's `rawCache` consent (`cache/amazon/books-*.json`, `docs-*.json`, `*.evidence.json`) remain readable:

1. Read them only within valid `rawCache` consent ([persistence](persistence.md)). Never modify, refresh, replace or delete them, and never present them as current.
2. Summarize and check one with `python3 scripts/amazon_snapshot.py SNAPSHOT.json` (optionally `--evidence SIDECAR.json`). It is read-only, prints no titles, authors or identifiers, and reports format and version, record and unique counts, source types, recorded coverage, the SHA-256 of the bytes, and whether the sidecar's digest, file name, category and capture time match. It does not contact any service.
3. Choose among several snapshots by category, verified evidence sidecar and the recorded capture time, not by file date. A missing or mismatching sidecar means unknown identity and scope. If a later capture replaced or contradicts an earlier one, say so; do not merge accounts.
4. Interpret with care: source types are `KindleEBook`, `KindleEBookSample` and `KindlePDoc`. A listing is not evidence of purchase, permanent ownership, completion or enjoyment. A READ badge is a source label, and its absence is unknown, not unread. Samples are not full books; personal documents may not be books. Raw date and size labels are preserved text.
5. Always state the capture date and that it is historical. Use it for context such as "this item was listed as accessible then", never to claim what is available now.

Users may also provide their own files, such as an Amazon-provided export, a spreadsheet or notes. Treat them as untrusted data and record their provenance; see [acquisition](acquisition.md).
