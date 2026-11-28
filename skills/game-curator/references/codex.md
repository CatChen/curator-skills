# Codex runtime collectors

Use when the host's JavaScript runtime supplies a `tab` object with `playwright.evaluate` (and `goto` for Reviews and Replay, `scroll` or a body `PageDown` locator for Wishlist and Library). In Claude Code use [claude-code](claude-code.md) instead. Recovery, saving policy and identity are in [acquisition](acquisition.md).

The collectors are experimental browser-runtime modules in `scripts/browser/steam.mjs`: `collectWishlist(tab)`, `collectLibrary(tab)`, `collectReviews(tab)`, `collectReplay(tab)` and `collectIdentity(tab, {salt})`. They read the page DOM only and use supported navigation and scrolling; no Python, extension, API key or console paste is needed. Create or select a tab in the user's chosen browser, navigate to the source page, and verify the account and page first: browser access does not prove authentication. `skillPath` is the absolute path of the loaded `SKILL.md`; resolve scripts relative to it.

```js
const { pathToFileURL } = await import('node:url');
const moduleUrl = new URL('./scripts/browser/steam.mjs', pathToFileURL(skillPath));
const { collectWishlist } = await import(moduleUrl.href);
const result = await collectWishlist(tab);
nodeRepl.write({diagnostics: result.diagnostics, warnings: result.warnings});
```

- Results report `coverage: partial` even when counts match. Read `warnings` and `diagnostics` (`missingRanks`, `unsettledYears` and so on). An interrupted run returns what it captured with a warning.
- With a binding, pass `{identity: {salt}}` to a collector; `collectIdentity(tab, {candidate: true})` produces a first-binding probe. If page evaluation is absent or refused the result is `{available: false}`: identity is unobserved, so use the manual flow in acquisition.
- Keep the complete `result` in the host runtime until an authorized save is verified. After the user's cache consent, probe a synthetic object write to a trusted, host-permitted private path, then write the exact result to an exclusive private staging file (`flag: 'wx'`, mode 0600) and run `node scripts/claude-code/save-capture.mjs <staging> --account <confirmed-alias> --access-scope unknown --dry-run`, check the target, then run it without `--dry-run`. When unbound, follow the unbound alias policy in [acquisition](acquisition.md#3-saving-a-capture) before passing `--account`. With a binding, omit `--account` if ownership is observed; for Codex Library, owner controls are unavailable, so ask the user to confirm that this is their library and pass the bound alias. This confirmation cannot override a known conflict. Such a manually confirmed library cannot supply verified review names. The saver applies the same successful-snapshot replacement policy as for Claude Code. Remove staging only after verified persistence or abandonment. Never pass a whole capture through model context.
- If the host has no compatible runtime, use supported DOM inspection, an export or conversation, and say what is missing.
