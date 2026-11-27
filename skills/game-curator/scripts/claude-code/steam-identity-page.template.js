// Game Curator: Steam identity probe for Claude Code's built-in browser and Claude in Chrome (page side).
// GENERATED FILE is steam-identity-page.js; edit this template and run `node build-page-script.mjs`.
//
// Reads ONLY logged_in, steamid and accountid from Steam's own page data (window.UserConfig, #application_config[data-userinfo],
// window.g_steamID) and returns a salted fingerprint, never an identifier. It does not read the surrounding objects, login names, tokens
// or cookies, makes no request and changes nothing. Run it with the whole file as `text` to javascript_tool on a Steam store or community
// page of the signed-in browser; the options go in the literal on the last line:
//   ({salt: '<22-char base64url salt of the approved binding>'})   verify against an existing binding
//   ({candidate: true})                                             first binding: returns a fresh salt and its fingerprint
// A result is an observation of who is signed in. It is not approval: a binding is created only by bind-account.mjs after the user says so.
// The page's own URL ID (only /replay/<id>/ and /profiles/<id>/ paths carry one) is fingerprinted separately as pathFingerprint.
await (async (opts = {}) => {
  /*@@SHARED@@*/
  /*@@COMMON@@*/
  const known = ['salt', 'candidate'];
  for (const k of Object.keys(opts)) if (!known.includes(k)) throw new Error(`unknown option: ${k}`);
  if (opts.salt !== undefined && opts.candidate !== undefined) throw new Error('pass either salt or candidate, not both');
  const result = await observeIdentity({salt: opts.salt, candidate: opts.candidate});
  return {format: 'game-curator-identity-probe', ...result, origin: location.origin};
})({})
