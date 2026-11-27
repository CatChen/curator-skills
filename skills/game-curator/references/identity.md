# Account identity and the Steam account binding

Game Curator is a personal, single-user skill: at most **one** Steam account is bound, and there is no account database, list or service. These are separate facts; approving one never approves another:

| Concept | Question | Where it lives |
| --- | --- | --- |
| Browser authentication | Is the browser signed in? | The browser; the user signs in normally. Never handle credentials |
| Observed identity | Which account does Steam's page data say is signed in? | `diagnostics.identity` (fingerprints only), consumed by the saver |
| Approved binding | Which account did the user say is theirs? | `steamAccount` in `settings.json` (version 2) |
| Page ownership | Does the page that was collected belong to that account? | Owner-only page controls plus, where a URL carries an ID, the URL |
| Raw-cache consent | May captures be written? | `persistence.steamCache` |
| Capture scope, completeness, transfer | Signed-in or public, whole, from the real run? | Collector evidence, `validate`, `decide` |
| Host permissions | May this runtime read the page, write the folder? | The runtime; never inferred from the above |

## What may be read

Only `logged_in`, `steamid` and `accountid`, by name, from Steam's own page data (`window.UserConfig`, the `data-userinfo` attribute of `#application_config`, `window.g_steamID`), through read-only page evaluation the runtime already permits ([identity-probe.mjs](../scripts/browser/identity-probe.mjs)). The surrounding objects, login names, tokens and cookies are never copied, serialized, logged or returned, and the raw identifier never leaves the page: the page returns a salted fingerprint. The identifier must be a decimal **string** of 17 digits in the individual-account range, consistent with `accountid`; a number is rejected because it loses precision. A display name, vanity URL or persona name is never identity, and renaming does not change a match.

Claude in Chrome redacts long hex or base64-looking values (and keys containing "session") from inline tool results, so a **first binding** probe (which must return the salt and fingerprint) belongs in the built-in browser or Codex; in Chrome a verification run embeds the observation in the capture, which is delivered by download as usual.

If the runtime does not allow this (page evaluation absent or refused), identity is **unobserved**: keep the manual confirmation below. Never work around a restriction.

## Procedure

1. **Read the binding.** `node scripts/bind-account.mjs status --settings <settings.json>` prints the alias, whether an account is bound and the binding's salt (never the fingerprint). Settings versions 1 and 2 both work; no binding means the manual flow below. A binding says nothing about cache consent.
2. **Bound: collect with the identity option.** Pass `identity: {salt: '<the binding's salt>'}` on the call that finishes the run (stated like `deliver`; it is not remembered across resume calls). The salt is the one `status` printed (it is not secret). Run on the page being collected (the store or community page of the capture, so ownership is judged on that page).
3. **Save.** `save-capture.mjs` re-reads the binding, compares the fingerprint and records only the verdict. With a verified match it needs no `--account` and no question to the user. Any other result is kept as a separate snapshot and never replaces a verified cache; a manual `--account` cannot override a mismatch or ambiguity.
4. **Not bound or not observable.** Ask the user which account this is and for a local alias, then pass `--account <alias>` as before. This is recorded as `by: user`, `basis: manual-confirmation`, `result: unobserved` or `unbound`; it is **never** described as a fingerprint match.

## Verdicts

| `result` | Meaning | Effect |
| --- | --- | --- |
| `match` + `ownership: verified` | Signed in as the bound account and the page shows owner-only evidence (and any URL ID agrees) | Proceed without asking; normal scope/completeness/transfer rules still apply |
| `match` + `ownership: unverified` | Signed in as the bound account, but the page is not shown to be its own (another person's public page, or no owner controls) | Separate snapshot; not signed-in evidence; never replaces a signed-in capture |
| `mismatch` | A different account is signed in | Nothing is written to the verified cache; tell the user, who can switch the browser account or explicitly change the binding |
| `ambiguous` | Sources disagree, an ID is malformed, `accountid` is inconsistent, or owner controls contradict the URL | Separate snapshot; stop and report; never guess |
| `unobserved` | Signed out, markers missing, runtime refused evaluation, observation failed, or a different salt was used | Ask the user to sign in, or fall back to manual confirmation; no promotion without it |
| `unbound` | No account is bound | Manual flow, identical to before |

## Binding, changing and revoking

Never create or change a binding from what the browser shows. Only on the user's explicit instruction:

1. Open any Steam page signed in as the account to bind and run `scripts/claude-code/steam-identity-page.js` with `({candidate: true})` (Codex: `collectIdentity(tab, {candidate: true})`). It returns a fresh salt and a fingerprint, not the identifier.
2. Show the user the alias you propose (the Steam display name may be shown as a hint; it is not evidence) and ask for approval.
3. `node scripts/bind-account.mjs bind --settings <settings.json> --probe <result> --alias <alias>` prints the plan and writes nothing. After the user's yes, repeat with `--apply`. It upgrades an **existing** valid settings file to version 2, preserves both persistence choices exactly, refuses if the file changed meanwhile, and rereads the result. It never creates settings or repairs an invalid file.
4. `change` replaces the binding and `revoke` removes it, each on explicit instruction. After a change **ask the user whether the existing profile and feedback may be reused for the new account** (they describe the person, not the Steam account); never delete, rewrite or reassign personal files. Caches captured under the previous alias are not merged or promoted; they stay readable as evidence from the old account when the user wants.

Current user instructions and revocation override a recorded binding at any time.

## What a binding does not do

- It does not establish **page ownership**: a matching signed-in account alone never makes a viewed profile the user's.
- It does not authorize the raw cache, profile or feedback, and does not change scope, completeness or transfer rules.
- It never attributes an older capture without an account to the bound account, even if the records match; such files stay separate unless the user states a file's account.
- It does not prove the page's owner controls are genuine: those are page-attested evidence.

## Library use (Codex and other hosts)

`save()` in [cache.mjs](../scripts/cache.mjs) enforces the binding itself: with an account bound, a capture under the bound alias is promoted only if its `diagnostics.attestations.identity` is the saver's verdict (a verified `match`, or the user's recorded manual confirmation), and a capture under any other alias is kept separate. A host that does not use the CLI should call `evaluateIdentity` and `identityPolicy` (exported from `cache.mjs`) on the page's `diagnostics.identity`, record the resulting attestation and pass `identityBlock` to `save()`. Without a binding nothing changes.
