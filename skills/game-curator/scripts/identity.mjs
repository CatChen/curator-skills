// Account identity policy for the shared cache saver. Pure functions over an observation (fingerprints only) and the approved
// binding from settings.json. Four things stay separate and are never inferred from one another:
//   authenticated identity  (result):   who is signed in vs the bound account: unbound | unobserved | match | mismatch | ambiguous
//   page ownership          (ownership): whether the page that was collected belongs to that account: verified | unverified | contradicted
//   manual confirmation     (basis):    the user's own statement when nothing could be observed; never reported as a fingerprint match
//   capture completeness / transfer provenance / persistence consent: decided elsewhere (validate, decide, checkCacheAuthorized)
// A binding is created or changed only by bind-account.mjs on an explicit instruction, never from an observation.
import {saltCheckOf} from './settings.mjs';

const isPlain = o => !!o && typeof o === 'object' && !Array.isArray(o);
const HEX64 = /^[0-9a-f]{64}$/;
const OBSERVATION_KEYS = ['version', 'sources', 'loggedIn', 'consistent', 'saltCheck', 'sessionFingerprint', 'pathFingerprint'];
const SOURCE_NAMES = ['user-config', 'userinfo-attr', 'g-steamid'];

// Shape of the page-side observation embedded in diagnostics.identity. Returns a list of problems (empty = valid).
export function checkObservation(o) {
  if (!isPlain(o)) return ['diagnostics.identity is not an object'];
  const bad = [], keys = Object.keys(o).sort().join(), expected = [...OBSERVATION_KEYS, ...('error' in o ? ['error'] : [])].sort().join();
  if (keys !== expected) bad.push('diagnostics.identity has unexpected or missing fields');
  if (o.version !== 1) bad.push('diagnostics.identity version is unsupported');
  if (!Array.isArray(o.sources) || !o.sources.every(s => SOURCE_NAMES.includes(s))) bad.push('diagnostics.identity sources are invalid');
  if (!(o.loggedIn === true || o.loggedIn === false || o.loggedIn === null)) bad.push('diagnostics.identity loggedIn is invalid');
  if (typeof o.consistent !== 'boolean') bad.push('diagnostics.identity consistent is invalid');
  if (!(o.saltCheck === null || /^[0-9a-f]{8}$/.test(o.saltCheck ?? ''))) bad.push('diagnostics.identity saltCheck is invalid');
  for (const k of ['sessionFingerprint', 'pathFingerprint']) if (!(o[k] === null || HEX64.test(o[k] ?? ''))) bad.push(`diagnostics.identity ${k} is invalid`);
  if ('error' in o && o.error !== 'observation-failed') bad.push('diagnostics.identity error is invalid');
  return bad;
}

// Evaluate authenticated identity and page ownership against the binding.
//   binding        parsed steamAccount or null
//   observation    diagnostics.identity from the page (or undefined)
//   ownerEvidence  true when the page's owner-only controls were observed by the collector (existing, per-source evidence)
export function evaluateIdentity({binding, observation, ownerEvidence = false}) {
  if (!binding) return {result: 'unbound', ownership: 'unverified', note: 'no account is bound'};
  if (observation === undefined) return {result: 'unobserved', ownership: 'unverified', note: 'the capture carries no identity observation'};
  if (checkObservation(observation).length) return {result: 'unobserved', ownership: 'unverified', note: 'the identity observation is malformed'};
  const source = observation.sources[0] ?? null, base = {source, ownership: 'unverified'};
  if (observation.error) return {...base, result: 'unobserved', note: 'the page could not read its identity'};
  if (observation.consistent === false) return {...base, result: 'ambiguous', note: 'identity sources disagree or are malformed'};
  if (observation.loggedIn === false) return {...base, result: 'unobserved', note: 'the page reports a signed-out session'};
  if (observation.sessionFingerprint === null) return {...base, result: 'unobserved', note: 'no signed-in identity was found on the page'};
  if (observation.saltCheck !== saltCheckOf(binding.fingerprint.salt)) return {...base, result: 'unobserved', note: 'the observation was computed with a different salt than the binding'};
  if (observation.sessionFingerprint !== binding.fingerprint.value) return {...base, result: 'mismatch', note: 'the signed-in account is not the bound account'};
  const path = observation.pathFingerprint;
  if (path !== null && path !== observation.sessionFingerprint) {
    // The URL names another account. With owner-only controls on the page that is a contradiction; without them it is simply someone else's public page.
    return ownerEvidence ? {...base, result: 'ambiguous', ownership: 'contradicted', note: 'owner controls are shown but the page URL names a different account'}
      : {...base, result: 'match', ownership: 'unverified', note: 'signed in as the bound account, but the page viewed belongs to another account'};
  }
  return {...base, result: 'match', ownership: ownerEvidence ? 'verified' : 'unverified', note: ownerEvidence ? 'bound account, owner evidence present' : 'bound account is signed in, but the page shows no owner-only evidence'};
}

// Combine the evaluation with the caller's manual --account into the metadata the saver records and a reason that blocks promotion.
// Returns {account, scope, block, attestation}. Throws when a manual alias would contradict an observation.
export function identityPolicy({binding, evaluation, accountArg}) {
  if (!binding) return {account: accountArg, scope: undefined, block: null, attestation: null}; // unbound: exactly the manual flow
  const e = evaluation, record = {result: e.result, ownership: e.ownership, ...(e.source ? {source: e.source} : {})};
  if (e.result === 'match' && e.ownership === 'verified') {
    if (accountArg !== undefined && accountArg !== binding.alias) throw new Error('--account conflicts with the bound account; change the binding explicitly instead');
    return {account: binding.alias, scope: 'signed-in', block: null, attestation: {by: 'binding', ...record}};
  }
  if (e.result === 'match') { // signed in as the bound account, but this page is not shown to be that account's own
    if (accountArg !== undefined) throw new Error(`--account cannot establish page ownership: ${e.note}`);
    return {account: undefined, scope: undefined, block: `page ownership is not verified (${e.note})`, attestation: {by: 'binding', ...record}};
  }
  if (e.result === 'mismatch' || e.result === 'ambiguous') {
    if (accountArg !== undefined) throw new Error(`--account cannot override an observed identity (${e.result}): ${e.note}`);
    return {account: undefined, scope: undefined, block: `account identity is ${e.result} (${e.note})`, attestation: {by: 'binding', ...record}};
  }
  // unobserved: only the user's own confirmation can stand in, and it is recorded as such, never as a fingerprint match
  const manual = {by: 'user', result: 'unobserved', basis: 'manual-confirmation', ownership: 'unverified'};
  if (accountArg === binding.alias) return {account: accountArg, scope: undefined, block: null, attestation: manual};
  if (accountArg !== undefined) return {account: accountArg, scope: undefined, block: 'the confirmed alias differs from the bound account; change the binding explicitly to use another account', attestation: manual};
  return {account: undefined, scope: undefined, block: `account identity was not observed (${e.note}) and was not confirmed`, attestation: {by: 'binding', ...record}};
}
