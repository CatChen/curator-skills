# Game Curator account identity: design status, tests and collector gaps

The procedure for agents is in [account identity](../skills/game-curator/references/identity.md); settings fields are in [persistence](../skills/game-curator/references/persistence.md). This page records the development decisions, what has been verified and how, and what is still missing. It contains no personal identifiers.

## Decisions

- One user, at most one bound Steam account; no list, database, registry or service. Binding, raw-cache consent, capture scope and host permissions stay independent.
- The binding is a salted SHA-256 fingerprint of the canonical SteamID64 **string**, stored with its random 16-byte salt in `settings.json` version 2. Raw identifiers are never stored, logged or returned; the page computes the fingerprint. The salt is stored beside the value, so this keeps the identifier out of casually shared files; it is not secrecy.
- Observation reads only `logged_in`, `steamid` and `accountid`, by name, through the read-only page evaluation a runtime already permits. If that is unavailable or refused the result is `unobserved` and the manual confirmation remains; manual confirmation is recorded as such and is never described as a fingerprint match.
- A binding is created, changed or revoked only by `bind-account.mjs` on an explicit user instruction, preserving both persistence choices. After a change the agent asks before reusing profile and feedback; nothing is deleted, rewritten or reassigned. Older captures without an account are never attributed to the bound account; caches under another alias are never merged or promoted.
- Two development milestones, because settings version 2 must be readable by an installed saver before any file is written as version 2: **M1** adds the shared probe and the version 1 and 2 reader (it writes nothing); **M2** adds the saver verdicts and the bind/change/revoke operation. This ordering is a rollout procedure, not a product requirement: there is no runtime registry and users do not need both Codex and Claude Code. A reader that predates version 2 treats a version 2 file as invalid and fails closed.

## Verdict model

Authenticated identity (`unbound`, `unobserved` = extraction unavailable, `signed-out`, `match`, `mismatch`, `ambiguous` = present but unusable, contradictory or changed during the run) is separate from page ownership (`verified`, `unverified`, `contradicted`). A match promotes only with identity continuity (observed at the start, at every resume, navigation or Replay report, at collection boundaries and at the end, stopping on a change) and verified ownership: owner-only page controls observed on the observed page, and, where the URL carries an ID, a URL ID equal to the signed-in account. The saver derives the verdict itself at the shared `save()` boundary; every capture records the binding generation, so an alias reused after a change or revoke never inherits earlier evidence. Completeness, transfer provenance and cache consent are decided by their own existing checks and are not affected by identity.

## Test status

Fixture tests are synthetic and run in CI-style scripts (`node tests/game-curator/test_identity.mjs`, `test_account_binding.mjs`). Live results are filled in below only for what was actually run.

| Scenario | Evidence | Where |
| --- | --- | --- |
| Canonical ID, fingerprint vectors, number rejection, salt validation | fixture | `test_identity.mjs` |
| Node and in-page fingerprints agree; generated probe is current and leak-free | fixture | `test_identity.mjs` |
| Display-name change does not matter; same name with another ID mismatches | fixture | `test_identity.mjs` |
| Disagreeing sources, malformed or number-typed IDs, inconsistent `accountid` | fixture | `test_identity.mjs` |
| Signed out, missing markers, unreadable page data, runtime refuses evaluation | fixture | `test_identity.mjs`, `test_account_binding.mjs` |
| Settings v1/v2 reader, malformed v2 fails closed, binding is not cache consent | fixture | `test_identity.mjs`, `test_account_binding.mjs` |
| Bind, change, revoke; persistence preserved; concurrent edit; refusals | fixture | `test_account_binding.mjs` |
| Verified match without a question; mismatch/ambiguity cannot overwrite or be overridden | fixture | `test_account_binding.mjs` |
| Another person's public page; owner controls contradicting the URL | fixture | `test_account_binding.mjs` |
| Binding changed or revoked between decision and commit (intrinsic to `save()`) | fixture | `test_account_binding.mjs` |
| Alias reused after change or revoke: decide, selection, separate deduplication and backup rotation by generation | fixture | `test_account_binding.mjs` |
| Known mismatch, ambiguity, signed-out or unproven ownership is never supporting evidence, with or without a saved alias | fixture | `test_account_binding.mjs` |
| Bind, change, revoke and persistence edits need the approved settings revision and candidate digests; full read-back; binding preserved | fixture | `test_account_binding.mjs` |
| Real generated collectors with the identity option: start/resume/end observation, remembered across navigations, stop on a mid-run switch, expiry or sign-out, per-year Replay binding, hook grammar and staging, native tool-result path, then the real saver | fixture (the sign-in switches are simulated pages) | `test_identity_collectors.mjs` |
| Legacy no-account files untouched; old alias not merged after a rebind | fixture | `test_account_binding.mjs` |
| No raw ID, decoy login name or token in any stored file | fixture | both |
| Live: normal signed-in account on the four sources, built-in browser and Claude in Chrome | live (probe only) | [Live acceptance](#live-acceptance) |
| Live: another person's public profile (ownership not verified) | live | see [Live acceptance](#live-acceptance) |
| Live: Codex runtimes (page evaluation permitted or refused) | not run: no Codex page runtime in this session | open |
| Live: full collectors with the identity option on a real page, end to end | not run | open |

Signed-out state, a second account, expired sessions and display-name changes are **fixture-only by design**: they would disrupt the user's real sign-in or need another account.

## Live acceptance

Run 2026-11-26/27 against one signed-in account, read-only, with a **scratch** settings file (never the production one, which stayed version 1). The probe page script was pasted into each page; the capture collectors themselves were not re-run live in this pass (their identity embedding is fixture-tested on the fake page).

| Page | Built-in browser | Claude in Chrome |
| --- | --- | --- |
| Wishlist (`UserConfig`) | signed in; fingerprint obtained | same fingerprint |
| Library (`UserConfig`) | same fingerprint | same fingerprint |
| Reviews (`userinfo-attr` and `g_steamID`) | same fingerprint, owner controls present | same fingerprint, owner controls present |
| Replay (`userinfo-attr`; URL ID) | same fingerprint; URL ID fingerprint equals it; owner control present | same |

- **In-page fingerprint consistency (verified live):** one salt gave one identical fingerprint on all four pages in the built-in browser, and the same value was reproduced in Chrome (compared in-page, see below). Evaluating those observations against the scratch binding gave `match` with ownership `verified` for the four own pages.
- **Another person's public pages (verified live, read-only, two well-known public profiles):** the community profile page (vanity URL; no review boxes, no owner-only links) and a public Replay page (numeric URL ID). Both stayed `match` for the signed-in session but with ownership `unverified` (no owner controls; on Replay the URL ID fingerprint differed from the signed-in one), so neither can be promoted or replace a signed-in capture. The authenticated identity alone did not establish ownership.
- **Runtime restriction found:** Claude in Chrome redacts long hex or base64-looking values and keys containing "session" from inline results. The identity probe therefore cannot return a fingerprint or salt inline in Chrome; the live Chrome checks compared the fingerprint in-page against the expected value and returned only a boolean. A **first binding** (which needs the salt and fingerprint back) must be done in a runtime that returns them (the built-in browser or Codex) or by a download; a **verification** run in Chrome embeds the observation in the capture, which already travels by download, so it is unaffected.
- **Not run live:** both Codex runtimes (page evaluation permitted or refused), the full collectors with `identity` end to end on a live page, and session expiry or signed-out states (fixture-only by design).

## Remaining collector evidence gaps (not resolved by account binding)

The Codex DOM collectors (`scripts/browser/steam.mjs`: `collectWishlist`, `collectLibrary`, `collectReviews`, `collectReplay`) emit `method: browser-dom` envelopes that the saver validates through its legacy path and never promotes. Binding an account does not close these gaps:

1. **Enumeration integrity and completeness:** no `recordsSha256`, `complete` or `stopReason`; Library and Reviews report only a displayed count and scroll or page counters; Wishlist is a bounded scroll of rendered rows. The Claude page scripts record a checksum and a verified stop reason.
2. **View evidence:** no `diagnostics.view` (sort, search, tab or filter state; review list kind). Promotion needs it.
3. **Owner evidence:** no observation of the owner-only controls (wishlist reorder handles, review controls, Replay visibility control) that distinguish the user's own page from a public view.
4. **Transfer provenance:** the result is an in-memory object handed through the host; the saver can only record `host-result` as unverified.
5. **Replay settling:** partial renders (a `LOADING...` line) are possible; the Claude script settles and flags them.

A focused follow-up, "Codex collector evidence parity", should add the owner, view and completeness diagnostics to the Codex collectors by reusing the shared row modules, and define how a Codex run proves transfer provenance. It needs a live Codex runtime and is intentionally not part of the identity work. Until then, Codex captures stay separate snapshots and an identity match does not promote them.

## Privacy audit notes (existing fields, tracked narrowly)

Navigation targets are not persisted identifiers. Replay's `next` navigation URL carries the numeric account path so the run can continue; it is used inside the run and is never written to a capture. Separately, existing collectors persist a page path in `diagnostics.urlPath` and review URLs, which contain the public profile vanity name; that is existing behavior, not part of this change, and a candidate for a focused scrub or opt-out. Public reports from tests and acceptance stay sanitized (no vanity names, persona names or numeric IDs).
