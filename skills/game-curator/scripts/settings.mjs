// Curator Home settings.json: strict v1 and v2 reader and the account-binding model.
// Version 1 holds only the persistence scopes. Version 2 adds ONE optional steamAccount binding (a local alias plus a salted
// fingerprint of the SteamID64, never the identifier itself). Unknown versions, unknown or missing fields and malformed
// values are invalid and fail closed. Reading never upgrades a file; only an explicitly authorized bind/change/revoke (bind-account.mjs) writes one.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {b64uDecode, b64uEncode, canonicalSteamId64, fingerprintBytes} from './browser/identity-probe.mjs';

export const BINDING_ALG = 'sha256-salted-v1';
const ALIAS = /^[A-Za-z0-9_-]{1,64}$/;
const isPlain = o => !!o && typeof o === 'object' && !Array.isArray(o);
const keysAre = (o, keys) => Object.keys(o).sort().join() === [...keys].sort().join();
const isIso = s => typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(s) && Number.isFinite(Date.parse(s));

// Salted fingerprint of a canonical SteamID64, synchronous (Node). Same bytes as the in-page async version.
export function fingerprintSync(saltB64u, steamid64) {
  const salt = b64uDecode(saltB64u), id = canonicalSteamId64(steamid64);
  if (!salt || salt.length !== 16 || !id) throw new Error('invalid salt or SteamID64');
  return crypto.createHash('sha256').update(fingerprintBytes(salt, id)).digest('hex');
}
export const newSalt = () => b64uEncode(crypto.randomBytes(16));
export const saltCheckOf = saltB64u => crypto.createHash('sha256').update(b64uDecode(saltB64u) ?? new Uint8Array()).digest('hex').slice(0, 8);

export function parseSteamAccount(a) {
  if (!isPlain(a) || !keysAre(a, ['alias', 'fingerprint', 'approvedAt', 'generation'])) throw new Error('invalid steamAccount record');
  const f = a.fingerprint;
  if (typeof a.alias !== 'string' || !ALIAS.test(a.alias) || !isIso(a.approvedAt)) throw new Error('invalid steamAccount alias or timestamp');
  if (!isPlain(f) || !keysAre(f, ['alg', 'salt', 'value']) || f.alg !== BINDING_ALG || typeof f.value !== 'string' || !/^[0-9a-f]{64}$/.test(f.value)) throw new Error('invalid steamAccount fingerprint');
  const salt = b64uDecode(f.salt), generation = b64uDecode(a.generation);
  if (!salt || salt.length !== 16) throw new Error('invalid steamAccount salt');
  if (!generation || generation.length !== 16) throw new Error('invalid steamAccount generation');
  return {alias: a.alias, approvedAt: a.approvedAt, generation: a.generation, fingerprint: {alg: f.alg, salt: f.salt, value: f.value}};
}

// Dispatch by version. Returns {version, persistence, steamAccount|null}. Never infers authorization for an unknown version.
export function parseSettings(s) {
  if (!isPlain(s)) throw new Error('unsupported or invalid settings version');
  const persistenceOk = p => isPlain(p) && keysAre(p, ['profileAndFeedback', 'steamCache']) && typeof p.profileAndFeedback === 'boolean' && typeof p.steamCache === 'boolean';
  if (s.version === 1) {
    if (!keysAre(s, ['persistence', 'version']) || !persistenceOk(s.persistence)) throw new Error('invalid version 1 settings record');
    return {version: 1, persistence: s.persistence, steamAccount: null};
  }
  if (s.version === 2) {
    const keys = Object.keys(s);
    if (!keys.includes('persistence') || !keys.every(k => ['version', 'persistence', 'steamAccount'].includes(k)) || !persistenceOk(s.persistence)) throw new Error('invalid version 2 settings record');
    return {version: 2, persistence: s.persistence, steamAccount: 'steamAccount' in s ? parseSteamAccount(s.steamAccount) : null};
  }
  throw new Error('unsupported or invalid settings version');
}

// Identity of a binding for change detection (alias, generation and fingerprint; null when unbound). The generation is an opaque random id
// created with every bind or change, so the same alias bound again (or after a revoke) is a different binding.
export const bindingKey = b => JSON.stringify(b ? [b.alias, b.generation, b.fingerprint] : null);

export function readSettingsFile(file) {
  const bytes = fs.readFileSync(file);
  return {bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), settings: parseSettings(JSON.parse(bytes.toString('utf8')))};
}
