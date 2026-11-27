// Authorized account-binding operations on an EXISTING settings.json: bind, change, revoke. This is the only code that writes a
// version 2 settings file, and only on an explicit user instruction (the caller must pass apply). It never infers a binding from
// what a browser shows, preserves the persistence choices exactly, and never touches caches, profile or feedback.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {b64uDecode} from './browser/identity-probe.mjs';
import {BINDING_ALG, readSettingsFile, saltCheckOf} from './settings.mjs';

const ALIAS = /^[A-Za-z0-9_-]{1,64}$/;
const isPlain = o => !!o && typeof o === 'object' && !Array.isArray(o);

// Serialization is fixed so a rewrite changes nothing but the intended fields.
export function settingsDocument({persistence, steamAccount}) {
  const doc = {version: 2, persistence: {profileAndFeedback: persistence.profileAndFeedback, steamCache: persistence.steamCache}};
  if (steamAccount) doc.steamAccount = {alias: steamAccount.alias, fingerprint: {alg: steamAccount.fingerprint.alg, salt: steamAccount.fingerprint.salt, value: steamAccount.fingerprint.value}, approvedAt: steamAccount.approvedAt};
  return JSON.stringify(doc, null, 2) + '\n';
}

// Validate an identity probe result (from steam-identity-page.js) as the input to a binding. It carries a salt and a fingerprint
// only; the identifier it was computed from is never available here.
export function checkBindProbe(p) {
  const bad = [];
  if (!isPlain(p)) return ['probe result is not an object'];
  if (p.loggedIn !== true) bad.push('the probe did not observe a signed-in session');
  if (p.consistent !== true) bad.push('the probe found inconsistent identity sources');
  if (!/^[0-9a-f]{64}$/.test(p.sessionFingerprint ?? '')) bad.push('the probe has no session fingerprint');
  const salt = b64uDecode(p.salt);
  if (!salt || salt.length !== 16) bad.push('the probe has no valid 16-byte salt (run it with candidate: true)');
  else if (p.saltCheck !== saltCheckOf(p.salt)) bad.push('the probe salt does not match its salt check');
  return bad;
}

// Plan (and optionally apply) a binding change on an EXISTING settings file. Preserves the persistence choices exactly.
// op: 'bind' (no current binding), 'change' (replace the current one), 'revoke' (remove it). Nothing is written unless apply.
export function planBinding(file, {op, probe, alias, apply = false, now = new Date(), hooks = {}}) {
  if (!['bind', 'change', 'revoke'].includes(op)) throw new Error('op must be bind, change or revoke');
  let current;
  try { current = readSettingsFile(file); } catch (e) { throw new Error(`settings not usable (nothing changed): ${e.code ?? e.message}`); }
  const {settings} = current;
  let next;
  if (op === 'revoke') {
    if (!settings.steamAccount) throw new Error('no account is bound');
    next = {persistence: settings.persistence, steamAccount: null};
  } else {
    if (op === 'bind' && settings.steamAccount) throw new Error('an account is already bound; use change to replace it explicitly');
    if (op === 'change' && !settings.steamAccount) throw new Error('no account is bound; use bind');
    if (typeof alias !== 'string' || !ALIAS.test(alias)) throw new Error('an alias of 1-64 letters, digits, - or _ is required');
    const bad = checkBindProbe(probe);
    if (bad.length) throw new Error(`cannot bind: ${bad.join('; ')}`);
    if (op === 'change' && settings.steamAccount.fingerprint.value === probe.sessionFingerprint && settings.steamAccount.fingerprint.salt === probe.salt && settings.steamAccount.alias === alias) throw new Error('the requested binding is identical to the current one');
    next = {persistence: settings.persistence, steamAccount: {alias, approvedAt: now.toISOString().replace(/\.\d+Z$/, 'Z'), fingerprint: {alg: BINDING_ALG, salt: probe.salt, value: probe.sessionFingerprint}}};
  }
  const text = settingsDocument(next);
  const plan = {op, file, fromVersion: settings.version, toVersion: 2, alias: next.steamAccount?.alias ?? null, persistencePreserved: true,
    previousAlias: settings.steamAccount?.alias ?? null, applied: false,
    followUp: op === 'revoke' ? 'Caches and personal files were not touched; later captures need a manual account confirmation.'
      : op === 'change' ? 'Ask the user explicitly whether the existing profile and feedback may be reused for the new account. Nothing was deleted, rewritten or reassigned, and caches captured under the previous alias are not merged or promoted.' : null};
  if (!apply) return plan;
  // Atomic replacement: private temp file in the same directory, refuse if the file changed since it was read, rename, read back.
  const dir = path.dirname(file), tmp = path.join(dir, `.settings.${process.pid}.tmp`);
  fs.writeFileSync(tmp, text, {flag: 'wx', mode: 0o600});
  try {
    hooks.beforeCommit?.(); // test seam for the read-to-rename window
    if (readSettingsFile(file).sha256 !== current.sha256) throw new Error('settings.json changed while the binding was prepared; nothing was written');
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  const back = readSettingsFile(file);
  if (JSON.stringify(back.settings.persistence) !== JSON.stringify(settings.persistence) || (back.settings.steamAccount?.alias ?? null) !== plan.alias) throw new Error('read-back of settings.json did not match the intended record');
  return {...plan, applied: true};
}

function isMain() {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; }
}

if (isMain()) {
  const args = process.argv.slice(2), valued = ['--settings', '--probe', '--alias'];
  const opt = n => {
    const i = args.indexOf(n);
    if (i < 0) return undefined;
    if (i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error(`${n} needs a value`);
    return args[i + 1];
  };
  const op = args.find((a, i) => !a.startsWith('--') && !valued.includes(args[i - 1]));
  try {
    const settings = opt('--settings');
    if (!['status', 'bind', 'change', 'revoke'].includes(op) || !settings) { console.error('usage: bind-account.mjs <status|bind|change|revoke> --settings <settings.json> [--probe <file|->] [--alias <alias>] [--apply]'); process.exit(2); }
    if (op === 'status') {
      const s = readSettingsFile(path.resolve(settings)).settings;
      console.log(JSON.stringify({version: s.version, persistence: s.persistence, bound: !!s.steamAccount, alias: s.steamAccount?.alias ?? null, approvedAt: s.steamAccount?.approvedAt ?? null, salt: s.steamAccount?.fingerprint.salt ?? null}, null, 2));
    } else {
      let probe;
      if (op !== 'revoke') {
        const p = opt('--probe');
        if (!p) throw new Error('--probe <identity probe result> is required');
        probe = JSON.parse(fs.readFileSync(p === '-' ? 0 : p, 'utf8'));
      }
      // Without --apply nothing is written: the plan is printed for the user to approve. --apply is the caller's statement that the
      // user explicitly approved exactly this operation; a binding is never created from what a browser shows.
      console.log(JSON.stringify(planBinding(path.resolve(settings), {op, probe, alias: opt('--alias'), apply: args.includes('--apply')}), null, 2));
    }
  } catch (e) { console.error(String(e.message ?? e)); process.exit(1); }
}
