# Game Curator manual testing

These are procedures, not reports of passed tests. Use your own data only in user-controlled storage outside the repository. Do not include personal data or identifiers in public issue reports. Record runtime/version, browser, observed capabilities and state, acquisition method, collector result, counts, completeness, fallback and limitations for each test. Each collector is experimental and may need changes after live observation.

1. **Codex + Chrome:** install the skill, request `Diagnose Game Curator's Steam data acquisition capabilities in this session`, and use an authenticated Steam session only if available. Test library, wishlist, reviews and Replay separately, subject to the actual tool permissions. Save only authorized exports; validate and record warnings and discrepancies. Test manual export fallback if page-context execution is unavailable.
2. **Codex + IAB:** repeat the diagnostic and each source independently. Do not assume Chrome capabilities or authentication carry over. Sign in normally if needed. Record whether the IAB permits page-context execution, returning output or downloads; use DOM/manual fallback if not.
3. **Claude:** upload the packaged skill, verify activation, run the diagnostic and each feasible acquisition path, then exercise manual export/import fallback. Record actual permissions and any blockers.
4. **No browser:** supply an export or describe games and feedback in conversation. Ask for a personalized recommendation; confirm the answer distinguishes evidence and unknowns and does not claim an import occurred.
5. **Cold start:** say `My favorite games are Portal 2, Fez, and Outer Wilds. What should I play next?` Confirm useful advice arrives without mandatory onboarding, unsupported claims or spoilers.

For a source, first inspect the page and collector code, use the source-specific instructions in the skill, and compare the capture with what the page actually shows. Record visible count versus collected count if possible, and inspect missing fields. A zero result or scroll plateau does not establish completeness. On reviews, collect several pages and identify any missing pages; on Replay, discover available years and inspect each separately. Do not make account changes.

## Recovery scenarios

Run each scenario independently in a test runtime with synthetic data or a controlled mock; do not induce rate limits against Steam. Observe the agent's actual actions, not just its description. These scenarios have not been run as live agent tests.

| Simulated failure | Expected behavior |
| --- | --- |
| Stale URL | Rediscover the intended source in the same session, verify identity, and resume. |
| Adapter error, direct browser works | Probe the same session, identify the adapter as the failure, inspect and repair or adapt it, then validate records. |
| Changed selector | Inspect a representative row, change the temporary extraction strategy, test it and rerun. |
| Missing internal cache | Confirm the failure is specific to state access, then use a permitted scoped extraction or report partial coverage. |
| JavaScript unavailable | Use supported direct navigation and structured extraction or an export; do not attempt forbidden execution. |
| Empty or incomplete result | Verify account, membership and coverage, retain earlier batches and report uncertainty; do not call it success. |
| Authentication failure | Stop and request normal sign-in; do not request secrets or switch accounts silently. |
| Rate limiting | Stop requests, preserve batches, and report the limit without bypassing it. |

Also verify ordinary use leaves installed code and dependencies unchanged; in a separately authorized development session, verify that an agent fixes the source and adds a regression test where feasible. Record which checks are simulated and which were live.

## Persistence acceptance tests

These are acceptance procedures, not evidence that persistence has passed. Use a dedicated user-controlled persistent test directory outside the repository, with only synthetic game names and feedback as in [persistence examples](../skills/game-curator/references/persistence.md). Do not substitute a temporary cloud sandbox for a verified durable local home. Record runtime, actual location, permissions, explicit consent and scope, session boundaries, operations, expected and observed results. Do not paste private file contents into public reports. Restart the agent between sessions where indicated; a new message in the same session does not prove persistence.

| Case | Steps | Expected result |
| --- | --- | --- |
| First use, decline | Start with no test directory; request a recommendation using fictional favorites, then decline persistence. | Useful recommendation; no directory or files created; no forced onboarding. |
| Explicit opt-ins and discovery | In a fresh session, opt in to profile/feedback at the test path, declining raw cache. Give meaningful synthetic feedback. Inspect files; start a **new session**, establish that the prior scope is available to it, and ask a relevant question without requesting import. | `profile.md` and `feedback.md` are readable, evidence linked, and reused automatically under established authorization. No `cache/steam` data is saved. If consent or custom location cannot be remembered, the agent explains what must be supplied again rather than claiming automatic discovery. |
| Feedback and correction | Provide one fictional observation, repeat it, then correct one detail in a later session. Inspect history and profile. Ask to edit or remove an entry. | One entry for the original observation, a distinct dated correction, correct evidence IDs and updated inference; explicit edit/removal is honored. No fabricated confirmation or replay of a user-deleted preference. |
| Cache reuse and explicit refresh | Separately opt in to raw caching. Save synthetic recent library/wishlist collector envelopes, start a fresh session, and ask a relevant question; then explicitly request refresh using a controlled source. | Relevant recent cache is read without a manual import or browser call; explicit refresh attempts the live source. Profile/feedback opt-in alone never authorizes raw caching. |
| Failed or incomplete refresh | Place a useful signed-in capture in the test cache; simulate failure and then a smaller public/partial capture. Compare original bytes before and after; permit a separate partial snapshot. | Original remains intact, stale/partial limitations are reported, and a useful partial snapshot is separate when authorized. No old wishlist is treated as current membership merely by union. |
| Identity, malformed data and conflict | Test unknown and differing account aliases; a malformed JSON cache; stale data; public versus signed-in scope; and a concurrent user edit to the profile between read and write. | Unknown/different identities are not silently merged, malformed data is not treated as empty or overwritten, stale/scope warnings remain visible, and conflicting edits are preserved or surfaced. No unsafe alias becomes a filesystem path. |
| Unavailable storage | Decline or deny filesystem permission; separately simulate a read-only or ephemeral home. Ask for a recommendation and then give feedback. | Curation continues from conversation or authorized data; no unverified persistence claim. Portable export is offered if useful and possible. |
| Cross-runtime, conditional | Only if both Codex and Claude can actually access the same authorized persistent test path, write synthetic feedback in one and read it in a fresh session in the other. | Shared reads/writes are verified with actual content and permissions; otherwise mark cross-runtime persistence unverified. Never infer sharing from identical path strings. |

For each case also verify the exact files the agent read or wrote, the agreed consent scope, and whether it preserved unrelated user edits. Do not add a database, background process, or persistence script to make these tests pass.
