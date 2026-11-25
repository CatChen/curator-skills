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
