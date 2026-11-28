# Game Curator account identity: design notes and tests

The procedure for agents is in [account identity](../skills/game-curator/references/acquisition.md#4-account-identity); settings fields are in [persistence](../skills/game-curator/SKILL.md#persistence). This page records the design decisions, tests and known runtime restrictions. It contains no personal identifiers.

## Identity and cache policy

One user may bind one Steam account. The binding stores a salted fingerprint and generation in settings. The salt is stored beside the fingerprint and SteamID64 values come from a small, enumerable range, so the fingerprint is a pseudonym for change detection, not a way to hide the account: anyone who can read `settings.json` could recover the ID by enumeration; binding, cache consent and host permission are independent. Bind, change or revoke only at the user's explicit request. Do not store raw account identifiers in captures or reports.

The saver rejects known account conflicts, broken identity continuity, signed-out observations and incompatible binding generations. For an unbound replacement of an attributed cache, supply the cache's alias the user already confirmed; it is a local label, not verified identity, and is reused only while nothing suggests the account changed. A capture without a binding generation is unverified; one from another generation is not current-account evidence even if aliases match. A successfully confirmed new capture may replace an unattributed legacy file.

With a matching bound session and verified page ownership, save normally. Codex Library does not expose owner controls: when continuity is stable and no foreign page is known, the user may explicitly confirm the library belongs to the bound account and the saver records that confirmation separately from observed ownership. It cannot override a known conflict or provide verified review-name enrichment. See [account identity](../skills/game-curator/references/acquisition.md#4-account-identity).

Synthetic coverage includes `test_identity.mjs`, `test_account_binding.mjs`, `test_identity_collectors.mjs`, and `test_codex_collector_saver.mjs`. The cross-runtime snapshot sequence is also synthetic and uses isolated files.

## Runtime restrictions

- A foreign public page can match the signed-in session yet leave ownership unverified (no owner controls, or a URL ID that differs from the signed-in one); that cannot replace the bound account's cache.
- Claude in Chrome redacts long hex or base64-looking values and keys containing "session" from inline results, so the identity probe cannot return a fingerprint or salt inline there. A **first binding** needs a runtime that returns them (the built-in browser or Codex) or a download; a **verification** run in Chrome embeds the observation in the capture, which already travels by download, so it is unaffected.
- Live checks use a scratch settings file and scratch cache, never the production ones, and keep identifiers out of reports.

## Privacy audit notes (existing fields, tracked narrowly)

Navigation targets are not persisted identifiers. Replay's `next` navigation URL carries the numeric account path so the run can continue; it is used inside the run and is never written to a capture. Collectors still read the page path and review URLs to validate that every review belongs to the collected list, but the saver omits `diagnostics.urlPath` and each review's `reviewUrl` before writing (the profile path holds the vanity name or SteamID64), and records what it omitted in `diagnostics.attestations.minimized`. Caches saved before this change may still contain them; they are not rewritten, and the user may delete those fields. Public reports from tests and acceptance stay sanitized (no vanity names, persona names or numeric IDs).
