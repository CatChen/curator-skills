# Game Curator account identity: design status, tests and collector gaps

The procedure for agents is in [account identity](../skills/game-curator/references/acquisition.md#4-account-identity); settings fields are in [persistence](../skills/game-curator/SKILL.md#persistence). This page records the development decisions, what has been verified and how, and what is still missing. It contains no personal identifiers.

## Identity and cache policy

One user may bind one Steam account. The binding stores a salted fingerprint and generation in settings. The salt is stored beside the fingerprint and SteamID64 values come from a small, enumerable range, so the fingerprint is a pseudonym for change detection, not a way to hide the account: anyone who can read `settings.json` could recover the ID by enumeration; binding, cache consent and host permission are independent. Bind, change or revoke only at the user's explicit request. Do not store raw account identifiers in captures or reports.

The saver rejects known account conflicts, broken identity continuity, signed-out observations and incompatible binding generations. For unbound replacement of an attributed cache, explicitly confirm and supply its alias. A capture without a binding generation is unverified; one from another generation is not current-account evidence even if aliases match. A successfully confirmed new capture may replace an unattributed legacy file.

With a matching bound session and verified page ownership, save normally. Codex Library does not expose owner controls: when continuity is stable and no foreign page is known, the user may explicitly confirm the library belongs to the bound account and the saver records that confirmation separately from observed ownership. It cannot override a known conflict or provide verified review-name enrichment. See [account identity](../skills/game-curator/references/acquisition.md#4-account-identity).

Synthetic coverage includes `test_identity.mjs`, `test_account_binding.mjs`, `test_identity_collectors.mjs`, and `test_codex_collector_saver.mjs`. The cross-runtime snapshot sequence is also synthetic and uses isolated files; it is not installed-runtime acceptance. Live end-to-end collector and cross-runtime acceptance remain unverified.

## Live acceptance

Run 2026-11-26/27 against one signed-in account, read-only, with a **scratch** settings file (never the production one, which stayed version 1). The probe page script was pasted into each page; the capture collectors themselves were not re-run live in this pass (their identity embedding is fixture-tested on the fake page).

| Page | Built-in browser | Claude in Chrome |
| --- | --- | --- |
| Wishlist (`UserConfig`) | signed in; fingerprint obtained | same fingerprint |
| Library (`UserConfig`) | same fingerprint | same fingerprint |
| Reviews (`userinfo-attr` and `g_steamID`) | same fingerprint, owner controls present | same fingerprint, owner controls present |
| Replay (`userinfo-attr`; URL ID) | same fingerprint; URL ID fingerprint equals it; owner control present | same |

- **In-page fingerprint consistency (verified live):** one salt gave one identical fingerprint on all four pages in the built-in browser, and the same value was reproduced in Chrome (compared in-page, see below). Evaluating those observations against the scratch binding gave `match` with ownership `verified` for the four own pages.
- **Another person's public pages (verified live, read-only, two well-known public profiles):** the community profile page (vanity URL; no review boxes, no owner-only links) and a public Replay page (numeric URL ID). Both stayed `match` for the signed-in session but with ownership `unverified` (no owner controls; on Replay the URL ID fingerprint differed from the signed-in one), so neither establishes ownership; a known foreign page cannot replace the bound account cache. The authenticated identity alone did not establish ownership.
- **Runtime restriction found:** Claude in Chrome redacts long hex or base64-looking values and keys containing "session" from inline results. The identity probe therefore cannot return a fingerprint or salt inline in Chrome; the live Chrome checks compared the fingerprint in-page against the expected value and returned only a boolean. A **first binding** (which needs the salt and fingerprint back) must be done in a runtime that returns them (the built-in browser or Codex) or by a download; a **verification** run in Chrome embeds the observation in the capture, which already travels by download, so it is unaffected.
- **Not run live:** both Codex runtimes (page evaluation permitted or refused), the full collectors with `identity` end to end on a live page, and session expiry or signed-out states (fixture-only by design).

## Privacy audit notes (existing fields, tracked narrowly)

Navigation targets are not persisted identifiers. Replay's `next` navigation URL carries the numeric account path so the run can continue; it is used inside the run and is never written to a capture. Collectors still read the page path and review URLs to validate that every review belongs to the collected list, but the saver omits `diagnostics.urlPath` and each review's `reviewUrl` before writing (the profile path holds the vanity name or SteamID64), and records what it omitted in `diagnostics.attestations.minimized`. Caches saved before this change may still contain them; they are not rewritten, and the user may delete those fields. Public reports from tests and acceptance stay sanitized (no vanity names, persona names or numeric IDs).
