# Amazon: historical snapshots only

Book Curator does not collect from Amazon. Amazon displayed a notice that unauthorized AI-agent access violates its Conditions of Use. Never open, scroll, scrape or automate Amazon, Kindle for Web, Manage Your Content and Devices, personal documents or Audible, in any browser or runtime, and do not retry elsewhere after a restriction. If the user wants Amazon data, ask for their own export, spreadsheet or notes and treat it as untrusted data with its provenance ([goodreads](goodreads.md#reading-records)).

Snapshots saved earlier (`cache/amazon/books-*.json`, `docs-*.json`, `*.evidence.json`) are readable only within the raw-cache scope (recorded or authorized this session). They are historical: never refresh, replace, modify, delete or present them as current, unless the user explicitly asks for a named file to be deleted, exported or corrected.

- Check one with `python3 scripts/amazon_snapshot.py SNAPSHOT.json [--evidence SIDECAR.json]`. It writes nothing and prints only counts and booleans (record counts, source types, coverage, digests, whether the sidecar matches, the sidecar's identity claim). A sidecar match is integrity only; identity is whatever the sidecar claims, never authenticated, and scope is unknown.
- Choose among snapshots by category, verified sidecar and recorded capture time, not file date. A missing or mismatched sidecar means unknown identity and scope. If a later capture contradicts an earlier one, say so; never merge accounts.
- A listing is not evidence of purchase, ownership, completion or enjoyment. Sources are `KindleEBook`, `KindleEBookSample` (not a full book) and `KindlePDoc` (may not be a book). A READ badge is a source label; its absence is unknown, not unread.
- Always state the capture date and that it is historical, e.g. "listed as accessible then", never what is available now.
