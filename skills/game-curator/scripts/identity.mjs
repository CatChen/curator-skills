// Account identity policy for the shared cache saver. Pure functions over an observation (fingerprints only) and the approved
// binding from settings.json. Four things stay separate and are never inferred from one another:
//   authenticated identity  (result):   who is signed in vs the bound account:
//        unbound | unobserved | signed-out | match | mismatch | ambiguous
//   page ownership          (ownership): whether the page that was collected belongs to that account: verified | unverified | contradicted
//   manual confirmation     (basis):    the user's own statement when extraction was UNAVAILABLE; never a fingerprint match, never a way
//                                       to override a known signed-out, conflicting or mismatching observation
//   capture completeness / persistence consent: decided elsewhere (validate, checkCacheAuthorized)
// A binding is created or changed only by bind-account.mjs on an explicit instruction, never from an observation.
import {saltCheckOf} from './settings.mjs';

const isPlain = o => !!o && typeof o === 'object' && !Array.isArray(o);
const isHex = (v, n) => typeof v === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(v);
const BASE_KEYS = ['version', 'sources', 'loggedIn', 'consistent', 'problems', 'saltCheck', 'sessionFingerprint', 'pathFingerprint'];
const OPTIONAL_KEYS = ['error', 'continuity', 'owner'];
const SOURCE_NAMES = ['user-config', 'userinfo-attr', 'g-steamid'];
export const PROBLEM_CODES = ['unsupported-origin', 'unreadable-marker', 'malformed-marker', 'login-state-conflict', 'invalid-id', 'missing-account-id', 'invalid-account-id', 'id-conflict'];

// Shape of the page-side observation embedded in diagnostics.identity (every fingerprint must be an actual string). Returns problems.
export function checkObservation(o) {
  if (!isPlain(o)) return ['diagnostics.identity is not an object'];
  const bad = [], keys = Object.keys(o);
  if (!BASE_KEYS.every(k => keys.includes(k)) || !keys.every(k => BASE_KEYS.includes(k) || OPTIONAL_KEYS.includes(k))) bad.push('diagnostics.identity has unexpected or missing fields');
  if (o.version !== 1) bad.push('diagnostics.identity version is unsupported');
  if (!Array.isArray(o.sources) || !o.sources.every(s => SOURCE_NAMES.includes(s))) bad.push('diagnostics.identity sources are invalid');
  if (!(o.loggedIn === true || o.loggedIn === false || o.loggedIn === null)) bad.push('diagnostics.identity loggedIn is invalid');
  if (typeof o.consistent !== 'boolean') bad.push('diagnostics.identity consistent is invalid');
  if (!Array.isArray(o.problems) || !o.problems.every(p => PROBLEM_CODES.includes(p)) || new Set(o.problems).size !== o.problems.length) bad.push('diagnostics.identity problems are invalid');
  else if (o.consistent !== (o.problems.length === 0) && !('error' in o)) bad.push('diagnostics.identity consistent disagrees with its problems');
  if (!(o.saltCheck === null || isHex(o.saltCheck, 8))) bad.push('diagnostics.identity saltCheck is invalid');
  for (const k of ['sessionFingerprint', 'pathFingerprint']) if (!(o[k] === null || isHex(o[k], 64))) bad.push(`diagnostics.identity ${k} is invalid`);
  if ('error' in o && o.error !== 'observation-failed') bad.push('diagnostics.identity error is invalid');
  if ('owner' in o && !(o.owner === true || o.owner === false || o.owner === null)) bad.push('diagnostics.identity owner is invalid');
  if ('continuity' in o) {
    const c = o.continuity;
    if (!isPlain(c) || Object.keys(c).sort().join() !== 'broke,checks,covered,stable' || !Number.isSafeInteger(c.checks) || c.checks < 1 || typeof c.stable !== 'boolean' || typeof c.broke !== 'boolean' || typeof c.covered !== 'boolean') bad.push('diagnostics.identity continuity is invalid');
  }
  return bad;
}

const unobservedNote = {noObservation: 'the capture carries no identity observation', malformed: 'the identity observation is malformed'};

// Evaluate authenticated identity and page ownership against the binding.
//   binding          parsed steamAccount or null
//   observation      diagnostics.identity from the page (or undefined); it must already have passed checkObservation
//   ownerEvidence    true when the collector observed the page's owner-only controls (existing, per-source evidence)
//   identityChanged  the collector itself stopped the run because the signed-in identity changed or was lost
// Known observations win over missing evidence: a changed identity, a mismatching account and a contradiction between owner controls and the
// URL are decided BEFORE continuity is judged, so none of them can be turned into "unobserved" (and then a manual fallback) by dropping
// the continuity record or by a final observation that failed or found no markers.
export function evaluateIdentity({binding, observation, ownerEvidence = false, identityChanged = false}) {
  if (!binding) return {result: 'unbound', ownership: 'unverified', note: 'no account is bound'};
  const un = note => ({result: 'unobserved', ownership: 'unverified', note});
  const changed = {result: 'ambiguous', ownership: 'unverified', note: 'the signed-in identity changed or was lost during the run'};
  if (observation === undefined) return identityChanged ? changed : un(unobservedNote.noObservation);
  if (checkObservation(observation).length) return identityChanged ? changed : un(unobservedNote.malformed);
  const source = observation.sources[0] ?? null, base = {source, ownership: 'unverified'}, c = observation.continuity;
  if (identityChanged || c?.broke === true) return {...changed, source};
  // A partially instrumented run (identity added or re-salted on a resume call) can contain earlier batches nobody observed, possibly another account's.
  // This is decided before anything that could downgrade it (salt, errors, unavailable markers): it is never current evidence and no manual alias can fix it.
  if (c?.covered === false) return {result: 'ambiguous', ownership: 'unverified', source, note: 'identity was observed only for part of the run (it was added or changed on a resume call); the earlier batches are not attested and may belong to another account'};
  if (observation.error) return un('the page could not read its identity');
  // Extraction unavailable (nothing was read) is different from evidence that is present but unusable or contradictory.
  if (observation.problems.length === 1 && observation.problems[0] === 'unsupported-origin') return un('the page is not a supported Steam origin, so no identity was read');
  if (observation.problems.length) return {...base, result: 'ambiguous', note: `identity evidence is unusable or contradictory (${observation.problems.join(', ')})`};
  if (observation.loggedIn === false) return {...base, result: 'signed-out', note: 'the page reports an explicitly signed-out session'};
  if (observation.loggedIn === null || observation.sessionFingerprint === null) return un('no signed-in identity markers were found on the page');
  if (observation.saltCheck !== saltCheckOf(binding.fingerprint.salt)) return un('the observation was computed with a different salt than the binding');
  if (observation.sessionFingerprint !== binding.fingerprint.value) return {...base, result: 'mismatch', note: 'the signed-in account is not the bound account'};
  const path = observation.pathFingerprint, foreignPath = path !== null && path !== observation.sessionFingerprint;
  if (foreignPath && ownerEvidence) return {...base, result: 'ambiguous', ownership: 'contradicted', note: 'owner controls are shown but the page URL names a different account'};
  // Continuity: the account must have been the same, from the FIRST batch of the run, at the start, at every checked boundary and at the end.
  if (foreignPath && (!c || c.checks < 2)) return {...base, result: 'ambiguous', note: 'the page URL names another account and continuity across the run is not established'}; // known foreign evidence is never downgraded to unobserved
  if (!c || c.checks < 2) return un('identity was not checked at the start and end of the run, so continuity across the collection is not established');
  if (c.stable !== true) return {...base, result: 'ambiguous', note: 'the signed-in identity was not the same at every check of the run'};
  if (foreignPath) return {...base, result: 'match', ownership: 'unverified', note: 'signed in as the bound account, but the page viewed belongs to another account'};
  const owned = ownerEvidence === true && observation.owner === true;
  return {...base, result: 'match', ownership: owned ? 'verified' : 'unverified', note: owned ? 'bound account, owner evidence present on the observed page' : 'bound account is signed in, but the observed page shows no owner-only evidence'};
}

// A record of what a capture's own attestation says about a KNOWN conflict, independent of whether an alias was saved with it.
// Returns a reason when the capture must never serve as evidence for the bound account (not even as supporting evidence).
export function knownConflict(capture) {
  const a = capture?.diagnostics?.attestations?.identity;
  if (!isPlain(a)) return null;
  if (['mismatch', 'ambiguous', 'signed-out'].includes(a.result)) return `identity was ${a.result} when this was captured`;
  if (a.ownership === 'contradicted') return 'page ownership was contradicted when this was captured';
  if (a.by === 'binding' && a.result === 'match' && a.ownership !== 'verified') return 'the page captured was not shown to belong to the bound account';
  return null;
}

export const generationOf = capture => capture?.diagnostics?.attestations?.identity?.generation ?? null;

// Combine the evaluation with the caller's manual alias into what is recorded and a reason that blocks saving.
// Returns {account, scope, block, attestation}. Throws when a manual alias would contradict a KNOWN observation.
// Manual confirmation can also establish ownership of a library page when owner controls are unavailable; it never overrides a known conflict.
export function identityPolicy({binding, evaluation, manualAccount, confirmPageOwnership = false}) {
  if (!binding) return {account: manualAccount, scope: undefined, block: null, attestation: null}; // unbound: exactly the manual flow
  const e = evaluation, gen = binding.generation;
  const record = {result: e.result, ownership: e.ownership, ...(e.source ? {source: e.source} : {}), generation: gen};
  if (e.result === 'match' && e.ownership === 'verified') {
    if (manualAccount !== undefined && manualAccount !== binding.alias) throw new Error('the manual alias conflicts with the bound account; change the binding explicitly instead');
    return {account: binding.alias, scope: 'signed-in', block: null, attestation: {by: 'binding', ...record}};
  }
  if (e.result === 'match') { // signed in as the bound account, but ownership could not be observed
    if (confirmPageOwnership && manualAccount === binding.alias) return {account: binding.alias, scope: undefined, block: null, attestation: {by: 'user', ...record, ownership: 'confirmed', basis: 'manual-confirmation'}};
    if (manualAccount !== undefined) throw new Error(`a manual alias cannot establish page ownership: ${e.note}`);
    return {account: undefined, scope: undefined, block: `page ownership is not verified (${e.note})`, attestation: {by: 'binding', ...record}};
  }
  if (['mismatch', 'ambiguous', 'signed-out'].includes(e.result)) {
    if (manualAccount !== undefined) throw new Error(`a manual alias cannot override a known observation (${e.result}): ${e.note}`);
    return {account: undefined, scope: undefined, block: `account identity is ${e.result} (${e.note})`, attestation: {by: 'binding', ...record}};
  }
  // unobserved: only the user's own confirmation can stand in, and it is recorded as such, never as a fingerprint match
  const manual = {by: 'user', result: 'unobserved', basis: 'manual-confirmation', ownership: 'unverified', generation: gen};
  if (manualAccount === binding.alias) return {account: manualAccount, scope: undefined, block: null, attestation: manual};
  if (manualAccount !== undefined) return {account: manualAccount, scope: undefined, block: 'the confirmed alias differs from the bound account; change the binding explicitly to use another account', attestation: manual};
  return {account: undefined, scope: undefined, block: `account identity was not observed (${e.note}) and was not confirmed`, attestation: {by: 'binding', ...record}};
}
