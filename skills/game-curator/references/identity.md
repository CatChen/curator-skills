# Account identity and the Steam account binding

Game Curator is a personal, single-user skill: at most **one** Steam account is bound, and there is no account database, list or service. These are separate facts; approving one never approves another:

| Concept | Question | Where it lives |
| --- | --- | --- |
| Browser authentication | Is the browser signed in? | The browser; the user signs in normally. Never handle credentials |
| Observed identity | Which account does Steam's page data say is signed in, and did it stay the same during the run? | `diagnostics.identity` (fingerprints only), consumed by the saver |
| Approved binding | Which account did the user say is theirs? | `steamAccount` in `settings.json` (version 2) |
| Page ownership | Does the page that was collected belong to that account? | Owner-only page controls at the observed page plus, where a URL carries an ID, the URL |
| Raw-cache consent | May captures be written? | `persistence.steamCache` |
| Capture scope, completeness, transfer | Signed-in or public, whole, from the real run? | Collector evidence, `validate`, `decide` |
| Host permissions | May this runtime read the page, write the folder? | The runtime; never inferred from the above |

## What may be read

Only `logged_in`, `steamid` and `accountid`, by name, from Steam's own page data (`window.UserConfig`, the `data-userinfo` attribute of `#application_config`, `window.g_steamID`), on the two supported origins (`https://store.steampowered.com`, `https://steamcommunity.com`), through read-only page evaluation the runtime already permits ([identity-probe.mjs](../scripts/browser/identity-probe.mjs)). The surrounding objects, login names, tokens and cookies are never copied, serialized, logged or returned, and the raw identifier never leaves the page: the page returns a salted fingerprint. The identifier must be a decimal **string** of 17 digits in the individual-account range, consistent with `accountid`; a number is rejected because it loses precision. A display name, vanity URL or persona name is never identity, and renaming does not change a match.

Evidence is classified, never silently dropped: a marker that is **absent** is not the same as one that is present but unreadable, malformed or contradictory. The observation lists fixed problem codes (`unsupported-origin`, `unreadable-marker`, `malformed-marker`, `login-state-conflict`, `invalid-id`, `missing-account-id`, `invalid-account-id`, `id-conflict`); a valid second marker never outvotes an invalid one. Only the legacy `g_steamID` global is allowed to lack an `accountid`.

If the runtime does not allow this (page evaluation absent or refused), identity is **unobserved**: keep the manual confirmation below. Never work around a restriction. Claude in Chrome redacts long hex or base64-looking values (and keys containing "session") from inline tool results, so a **first binding** probe (which must return the salt and fingerprint) belongs in the built-in browser or Codex; in Chrome a verification run embeds the observation in the capture, which is delivered by download as usual.

## Procedure

1. **Read the binding.** `node scripts/bind-account.mjs status --settings <settings.json>` prints the alias, whether an account is bound and the binding's salt (never the fingerprint). Settings versions 1 and 2 both work; no binding means the manual flow below. A binding says nothing about cache consent.
2. **Bound: collect with the identity option.** Pass `identity: {salt: '<the salt status printed>'}` on the first call of the run (the options literal; for the hook path, `({deliver: 'hook', identity: {salt: '...'}})` is part of the recognized grammar and no other nested shape is). It is remembered across resume calls like `maxMs`; `deliver` still has to be restated on the finishing call. The collector observes who is signed in **at the start, at every resume or navigation (each page and each Replay report), at collection boundaries within a page and at the end**, so one run cannot silently span two accounts or a sign-out. If an account that was established is later changed or lost, the run **stops** (`stopReason: 'identity-changed'`) and keeps only the batches collected before the change; the page that showed the different identity is not merged. Each Replay report carries its own observation, bound to that report's own page.
3. **Save.** `save-capture.mjs` (and `save()` for library callers) re-reads the binding and **derives** the verdict itself from the observation, the binding and the collector's owner evidence; a caller-supplied attestation is never trusted. With a verified match it needs no `--account` and no question to the user. Any other result is kept as a separate snapshot and never replaces a verified cache. The binding is re-read before every commit step; a change or revocation mid-save stops it.
4. **Not bound or not observable.** Ask the user which account this is and for a local alias, then pass `--account <alias>` as before. This is recorded as `by: user`, `basis: manual-confirmation`, `result: unobserved` (or unbound); it is **never** described as a fingerprint match, and it can stand in **only where extraction was unavailable**.

## Verdicts

| `result` | Meaning | Effect |
| --- | --- | --- |
| `match` + `ownership: verified` | Signed in as the bound account at the start, throughout and at the end, and the observed page shows owner-only evidence (and any URL ID agrees) | Proceed without asking; normal scope/completeness/transfer rules still apply |
| `match` + `ownership: unverified` | Signed in as the bound account, but the page is not shown to be its own (another person's public page, or no owner controls) | Separate snapshot; not signed-in evidence; never replaces a signed-in capture |
| `mismatch` | A different account is signed in | Nothing is written to the verified cache; the user can switch the browser account or explicitly change the binding |
| `ambiguous` | Markers are present but unusable or contradictory, sources disagree, owner controls contradict the URL, or the identity **changed or was lost during the run** | Separate snapshot; stop and report; never guess; a manual alias cannot override it |
| `signed-out` | The page explicitly reports a signed-out session | Separate snapshot; the user signs in normally; a manual alias cannot override it |
| `unobserved` | Extraction was unavailable: no markers, unsupported origin, runtime refused or failed evaluation, a different salt, or identity was not checked at both the start and the end of the run | Ask the user to sign in, or fall back to manual confirmation; no match is claimed |
| `unbound` | No account is bound | Manual flow, identical to before |

Every capture saved under a binding records the binding's opaque **generation** in `diagnostics.attestations.identity.generation`. Alias equality never proves the same bound identity: a capture verified under an earlier binding (even with the same alias, or the same account after a revoke) is **not** current evidence for a later one. `decide`, selection, separate-snapshot deduplication and backup rotation all compare generations; pass the binding to `selectSnapshots` (`{binding}`) and only captures verified under its generation are eligible. A capture whose own attestation records a mismatch, ambiguity, signed-out state or unproven page ownership is never usable as evidence, not even as supporting evidence, whether or not an alias was saved with it.

## Binding, changing and revoking

Never create or change a binding from what the browser shows. Only on the user's explicit instruction:

1. Open any Steam page signed in as the account to bind and run `scripts/claude-code/steam-identity-page.js` with `({candidate: true})` (Codex: `collectIdentity(tab, {candidate: true})`). It returns a fresh salt and a fingerprint, not the identifier.
2. Show the user the alias you propose (the Steam display name may be shown as a hint; it is not evidence) and ask for approval.
3. `node scripts/bind-account.mjs bind --settings <settings.json> --probe <result> --alias <alias>` prints the **plan** with two digests (the exact settings revision and the exact candidate) and writes nothing. After the user's yes, run it again with `--apply --expect-settings <settingsSha256> --expect-candidate <candidateSha256>`; a settings file or probe that changed since the plan, or digests that do not match, are refused. It upgrades an **existing** valid settings file to version 2, preserves both persistence choices, refuses if the file changes during the write, rereads the file and compares it byte for byte. It never creates settings or repairs an invalid file.
4. `change` replaces the binding and `revoke` removes it, each with the same plan/approve/apply steps and on explicit instruction. Every bind or change creates a new generation. After a change **ask the user whether the existing profile and feedback may be reused for the new account** (they describe the person, not the Steam account); reuse is the user's decision, never assumed, and nothing is deleted, rewritten or reassigned. Caches captured under the previous binding are not merged or promoted; they stay readable as evidence from the old binding when the user wants.
5. Persistence choices are edited with `bind-account.mjs persistence --settings <file> [--profile-and-feedback true|false] [--steam-cache true|false]` (same plan and apply steps), which preserves a binding, its generation and the file's version. Do not rewrite `settings.json` by hand: a version 1 shaped rewrite would drop the binding.

Current user instructions and revocation override a recorded binding at any time.

## What a binding does not do

- It does not establish **page ownership**: a matching signed-in account alone never makes a viewed profile the user's.
- It does not authorize the raw cache, profile or feedback, and does not change scope, completeness or transfer rules.
- It never attributes an older capture without an account to the bound account, even if the records match; such files stay separate unless the user states a file's account.
- It does not prove the page's owner controls are genuine: those are page-attested evidence.

## Library use (Codex and other hosts)

`save()` in [cache.mjs](../scripts/cache.mjs) enforces all of this itself. A host passes the capture exactly as the page returned it (with `diagnostics.identity`) and, only if the user explicitly confirmed an alias because extraction was unavailable, `manualAccount`; an alias merely present on the envelope or an attestation attached by the caller counts for nothing. Without a binding nothing changes. Codex's page evaluation access for these probes is **not verified** in this repository: until it is exercised in a Codex runtime, treat identity there as unobserved and use the manual fallback.
