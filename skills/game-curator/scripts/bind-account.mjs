// Authorized changes to an EXISTING settings.json: bind, change or revoke the one Steam account, and edit the persistence choices without
// disturbing a binding. This is the only code that writes a version 2 settings file, and only on an explicit user instruction: every
// operation first PRINTS a plan with two digests (the exact settings revision it was based on and the exact candidate); writing requires
// --apply together with both digests the user approved, so a settings file or probe that changed in between is refused. It never infers a
// binding from what a browser shows, preserves the persistence choices, never touches caches, profile or feedback, never creates or
// repairs settings, and verifies the whole written record by reading it back byte for byte.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {b64uDecode} from './browser/identity-probe.mjs';
import {BINDING_ALG, bindingKey, newSalt, readSettingsFile, saltCheckOf} from './settings.mjs';

const ALIAS = /^[A-Za-z0-9_-]{1,64}$/;
const isPlain = o => !!o && typeof o === 'object' && !Array.isArray(o);
const sha256 = x => crypto.createHash('sha256').update(x).digest('hex');

// Serialization is fixed so a rewrite changes nothing but the intended fields. A version 1 record stays version 1 (it can hold no binding).
export function settingsDocument({version = 2, persistence, steamAccount}) {
  const p = {profileAndFeedback: persistence.profileAndFeedback, steamCache: persistence.steamCache};
  if (version === 1 && !steamAccount) return JSON.stringify({version: 1, persistence: p}, null, 2) + '\n';
  const doc = {version: 2, persistence: p};
  if (steamAccount) doc.steamAccount = {alias: steamAccount.alias, fingerprint: {alg: steamAccount.fingerprint.alg, salt: steamAccount.fingerprint.salt, value: steamAccount.fingerprint.value}, approvedAt: steamAccount.approvedAt, generation: steamAccount.generation};
  return JSON.stringify(doc, null, 2) + '\n';
}

// Validate an identity probe result (from steam-identity-page.js) as the input to a binding. It carries a salt and a fingerprint
// only; the identifier it was computed from is never available here. Every field must be an actual value of the right type.
export function checkBindProbe(p) {
  const bad = [];
  if (!isPlain(p)) return ['probe result is not an object'];
  if (p.loggedIn !== true) bad.push('the probe did not observe a signed-in session');
  if (p.consistent !== true || !Array.isArray(p.problems) || p.problems.length) bad.push('the probe found unusable or inconsistent identity evidence');
  if (typeof p.sessionFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(p.sessionFingerprint)) bad.push('the probe has no session fingerprint');
  const salt = b64uDecode(p.salt);
  if (!salt || salt.length !== 16) bad.push('the probe has no valid 16-byte salt (run it with candidate: true)');
  else if (p.saltCheck !== saltCheckOf(p.salt)) bad.push('the probe salt does not match its salt check');
  if (typeof p.origin !== 'string' || !['https://store.steampowered.com', 'https://steamcommunity.com'].includes(p.origin)) bad.push('the probe did not run on a supported Steam origin');
  return bad;
}

// Writes go only to a regular file the user named: a symbolic link is refused (the plan pins the bytes, not which file a link points at), and the
// user is asked to choose the real file explicitly.
function assertRegular(file) {
  let st; try { st = fs.lstatSync(file); } catch (e) { throw new Error(`settings not usable (nothing changed): ${e.code ?? e.message}`); }
  if (st.isSymbolicLink()) throw new Error('refused: settings.json is a symbolic link; nothing was changed. Pass the real settings file path explicitly.');
}

function commit(file, current, text, check, {apply, expect, plan, hooks}) {
  const settingsSha256 = current.sha256;
  const full = {...plan, settingsSha256};
  if (!apply) return {...full, applied: false, next: 'Show this plan to the user. Only after their explicit approval run again with --apply --expect-settings <settingsSha256> --expect-candidate <candidateSha256>.'};
  if (!expect || expect.settingsSha256 !== settingsSha256 || expect.candidateSha256 !== plan.candidateSha256) throw new Error('refused: --apply needs the settings revision and candidate digests of the plan the user approved, and they differ from the current ones (the settings file or the candidate changed)');
  // Atomic replacement: private temp file in the same directory, refuse if the file changed since it was read, rename, read back.
  assertRegular(file); // again at apply time: the link may have been introduced since the plan
  const dir = path.dirname(file), tmp = path.join(dir, `.settings.${process.pid}.tmp`);
  fs.writeFileSync(tmp, text, {flag: 'wx', mode: 0o600});
  try {
    hooks.beforeCommit?.(); // test seam for the read-to-rename window
    if (readSettingsFile(file).sha256 !== settingsSha256) throw new Error('settings.json changed while the change was prepared; nothing was written');
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  const back = readSettingsFile(file);
  if (!back.bytes.equals(Buffer.from(text)) || !check(back.settings)) throw new Error('read-back of settings.json did not match the intended record');
  return {...full, applied: true, settingsSha256: back.sha256};
}

// op: 'bind' (no current binding), 'change' (replace the current one), 'revoke' (remove it). Nothing is written unless apply.
export function planBinding(file, {op, probe, alias, apply = false, expect, now = new Date(), hooks = {}}) {
  if (!['bind', 'change', 'revoke'].includes(op)) throw new Error('op must be bind, change or revoke');
  assertRegular(file);
  let current;
  try { current = readSettingsFile(file); } catch (e) { throw new Error(`settings not usable (nothing changed): ${e.code ?? e.message}`); }
  const {settings} = current;
  let next, candidate;
  if (op === 'revoke') {
    if (!settings.steamAccount) throw new Error('no account is bound');
    next = {version: 2, persistence: settings.persistence, steamAccount: null};
    candidate = ['revoke', settings.steamAccount.generation];
  } else {
    if (op === 'bind' && settings.steamAccount) throw new Error('an account is already bound; use change to replace it explicitly');
    if (op === 'change' && !settings.steamAccount) throw new Error('no account is bound; use bind');
    if (typeof alias !== 'string' || !ALIAS.test(alias)) throw new Error('an alias of 1-64 letters, digits, - or _ is required');
    const bad = checkBindProbe(probe);
    if (bad.length) throw new Error(`cannot bind: ${bad.join('; ')}`);
    if (op === 'change' && settings.steamAccount.fingerprint.value === probe.sessionFingerprint && settings.steamAccount.fingerprint.salt === probe.salt && settings.steamAccount.alias === alias) throw new Error('the requested binding is identical to the current one');
    // Every bind or change gets a fresh opaque generation: the same alias (or the same account after a revoke) is a NEW binding, so captures
    // verified under an earlier one are never treated as current evidence for it.
    next = {version: 2, persistence: settings.persistence, steamAccount: {alias, approvedAt: now.toISOString().replace(/\.\d+Z$/, 'Z'), generation: newSalt(), fingerprint: {alg: BINDING_ALG, salt: probe.salt, value: probe.sessionFingerprint}}};
    candidate = [op, alias, probe.salt, probe.sessionFingerprint, settings.steamAccount?.generation ?? null];
  }
  const text = settingsDocument(next);
  const plan = {op, file, fromVersion: settings.version, toVersion: 2, alias: next.steamAccount?.alias ?? null, persistencePreserved: true,
    previousAlias: settings.steamAccount?.alias ?? null, candidateSha256: sha256(JSON.stringify(candidate)),
    followUp: op === 'revoke' ? 'Caches and personal files were not touched; later captures need a manual account confirmation.'
      : op === 'change' ? 'Ask the user explicitly whether the existing profile and feedback may be reused for the new account; reuse is the user\'s decision, never assumed. Nothing was deleted, rewritten or reassigned, and caches captured under the previous binding are not merged or promoted.' : null};
  return commit(file, current, text, s => JSON.stringify(s.persistence) === JSON.stringify(settings.persistence) && bindingKey(s.steamAccount) === bindingKey(next.steamAccount), {apply, expect, plan, hooks});
}

// Edit the persistence choices of an existing settings file. A binding and the file's version are preserved exactly.
export function planPersistence(file, changes, {apply = false, expect, hooks = {}} = {}) {
  assertRegular(file);
  let current;
  try { current = readSettingsFile(file); } catch (e) { throw new Error(`settings not usable (nothing changed): ${e.code ?? e.message}`); }
  const keys = Object.keys(changes ?? {});
  if (!keys.length || !keys.every(k => ['profileAndFeedback', 'steamCache'].includes(k) && typeof changes[k] === 'boolean')) throw new Error('give profileAndFeedback and/or steamCache as true or false');
  const {settings} = current, next = {version: settings.version, persistence: {...settings.persistence, ...changes}, steamAccount: settings.steamAccount};
  const text = settingsDocument(next);
  const plan = {op: 'persistence', file, fromVersion: settings.version, toVersion: settings.version, alias: settings.steamAccount?.alias ?? null, bindingPreserved: !!settings.steamAccount,
    persistence: next.persistence, candidateSha256: sha256(JSON.stringify(['persistence', next.persistence])), followUp: null};
  return commit(file, current, text, s => JSON.stringify(s.persistence) === JSON.stringify(next.persistence) && bindingKey(s.steamAccount) === bindingKey(settings.steamAccount) && s.version === settings.version, {apply, expect, plan, hooks});
}

function isMain() {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; }
}

if (isMain()) {
  const args = process.argv.slice(2), valued = ['--settings', '--probe', '--alias', '--expect-settings', '--expect-candidate', '--profile-and-feedback', '--steam-cache'];
  const opt = n => {
    const i = args.indexOf(n);
    if (i < 0) return undefined;
    if (i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error(`${n} needs a value`);
    return args[i + 1];
  };
  const bool = n => { const v = opt(n); if (v === undefined) return undefined; if (v !== 'true' && v !== 'false') throw new Error(`${n} must be true or false`); return v === 'true'; };
  const op = args.find((a, i) => !a.startsWith('--') && !valued.includes(args[i - 1]));
  try {
    const settings = opt('--settings');
    if (!['status', 'bind', 'change', 'revoke', 'persistence'].includes(op) || !settings) { console.error('usage: bind-account.mjs <status|bind|change|revoke|persistence> --settings <settings.json> [--probe <file|->] [--alias <alias>] [--profile-and-feedback true|false] [--steam-cache true|false] [--apply --expect-settings <sha> --expect-candidate <sha>]'); process.exit(2); }
    const apply = args.includes('--apply'), expect = apply ? {settingsSha256: opt('--expect-settings'), candidateSha256: opt('--expect-candidate')} : undefined;
    if (op === 'status') {
      const s = readSettingsFile(path.resolve(settings)).settings;
      console.log(JSON.stringify({version: s.version, persistence: s.persistence, bound: !!s.steamAccount, alias: s.steamAccount?.alias ?? null, approvedAt: s.steamAccount?.approvedAt ?? null, salt: s.steamAccount?.fingerprint.salt ?? null}, null, 2));
    } else if (op === 'persistence') {
      const changes = Object.fromEntries(Object.entries({profileAndFeedback: bool('--profile-and-feedback'), steamCache: bool('--steam-cache')}).filter(([, v]) => v !== undefined));
      console.log(JSON.stringify(planPersistence(path.resolve(settings), changes, {apply, expect}), null, 2));
    } else {
      let probe;
      if (op !== 'revoke') {
        const p = opt('--probe');
        if (!p) throw new Error('--probe <identity probe result> is required');
        probe = JSON.parse(fs.readFileSync(p === '-' ? 0 : p, 'utf8'));
      }
      // Without --apply nothing is written. --apply is the caller's statement that the user explicitly approved exactly this plan.
      console.log(JSON.stringify(planBinding(path.resolve(settings), {op, probe, alias: opt('--alias'), apply, expect}), null, 2));
    }
  } catch (e) { console.error(String(e.message ?? e)); process.exit(1); }
}
