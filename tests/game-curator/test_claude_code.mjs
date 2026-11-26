// Synthetic tests for the Claude Code wishlist saver and page script. Node is a development-only dependency.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {parseToolResult, canonicalize, validate, decide, save} from '../../skills/game-curator/scripts/claude-code/save-capture.mjs';

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function make(n, {labels = true, at = '2026-11-26T02:37:30.226Z', account, accessScope = 'unknown'} = {}) {
  const records = Array.from({length: n}, (_, i) => ({appid: 1000 + i, rank: i + 1, name: `Game ${i + 1}`,
    pageText: `Game ${i + 1}\n${labels ? 'RELEASE DATE:\nJAN 1, 2020\nENGLISH REVIEWS:\nPOSITIVE\n' : ''}$9.99`, membershipSource: 'wishlist-row'}));
  const env = {format: 'game-curator-steam-export', version: 1, source: 'wishlist', capturedAt: at, method: 'browser-dom-claude-code',
    coverage: 'partial', warnings: ['w'], diagnostics: {expectedCount: n, placeholderNameRows: 0, recordsSha256: sha(JSON.stringify(records))}, accessScope, records};
  if (account) env.account = account;
  return env;
}
const sortKeys = o => Array.isArray(o) ? o.map(sortKeys) : o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).sort().map(k => [k, sortKeys(o[k])])) : o;
// The harness alphabetizes keys and appends an origin trailer.
const harness = env => JSON.stringify([{type: 'text', text: JSON.stringify(sortKeys(env), null, 2) + '\n\n(captured at origin https://store.steampowered.com)'}]);

// Transfer: harness file -> canonical envelope with a reproducible checksum.
const env = make(3);
const parsed = canonicalize(parseToolResult(harness(env)));
assert.deepEqual(Object.keys(parsed), ['format', 'version', 'source', 'capturedAt', 'method', 'coverage', 'warnings', 'diagnostics', 'accessScope', 'records']);
assert.deepEqual(validate(parsed, {account: 'me', accessScope: 'signed-in'}), []);
assert.equal(JSON.stringify(parsed.records), JSON.stringify(env.records));
assert.deepEqual(parseToolResult(JSON.stringify(env)), env); // plain envelope file also works

// Validation failures are reported, not silently repaired.
const bad = make(3); bad.records[1].rank = 5;
assert.ok(validate(bad, {accessScope: 'unknown'}).some(e => e.includes('contiguous')));
const tampered = make(3); tampered.records[0].name = 'Changed';
assert.ok(validate(tampered, {accessScope: 'unknown'}).some(e => e.includes('checksum')));
const holes = make(3); holes.diagnostics.placeholderNameRows = 2;
assert.ok(validate(holes, {accessScope: 'unknown'}).some(e => e.includes('placeholder')));
assert.ok(validate(make(2), {account: '../evil', accessScope: 'unknown'}).some(e => e.includes('alias')));
assert.ok(validate(make(2), {accessScope: 'admin'}).some(e => e.includes('scope')));

// Replacement policy.
const next = make(3, {account: 'me', accessScope: 'signed-in', at: '2026-11-26T03:00:00Z'});
assert.equal(decide(null, next).action, 'create');
const old = make(4, {account: 'me', accessScope: 'signed-in', at: '2026-11-25T00:00:00Z'});
assert.equal(decide(old, next).action, 'replace');
assert.equal(decide({...old, account: 'other'}, next).action, 'separate');
assert.equal(decide({...old, account: undefined}, next).action, 'separate'); // unknown identity is never merged
assert.equal(decide({...old, account: undefined}, next, {existingAccount: 'me'}).action, 'replace');
assert.equal(decide({...old, accessScope: 'public'}, next).action, 'separate');
assert.equal(decide({...old, capturedAt: '2026-11-27T00:00:00Z'}, next).action, 'separate');
assert.equal(decide(old, make(3, {account: 'me', accessScope: 'signed-in', at: '2026-11-26T03:00:00Z', labels: false})).action, 'separate'); // poorer
assert.equal(decide({malformed: true}, next).action, 'separate');

// Filesystem behavior in a temp directory: create, replace-with-backup, separate, exclusive creation.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-'));
const created = save(next, dir);
assert.equal(created.action, 'create');
assert.equal(fs.statSync(created.target).mode & 0o777, 0o600);
const newer = make(3, {account: 'me', accessScope: 'signed-in', at: '2026-11-26T04:00:00Z'});
const replaced = save(newer, dir);
assert.equal(replaced.action, 'replace');
assert.deepEqual(JSON.parse(fs.readFileSync(replaced.backup, 'utf8')), next); // old capture preserved
assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'wishlist.json'), 'utf8')).capturedAt, newer.capturedAt);
const poorer = make(3, {account: 'me', accessScope: 'signed-in', at: '2026-11-26T05:00:00Z', labels: false});
const before = fs.readFileSync(path.join(dir, 'wishlist.json'), 'utf8');
const sep = save(poorer, dir);
assert.equal(sep.action, 'separate');
assert.match(sep.target, /wishlist\.partial\.20261126T050000Z\.json$/);
assert.equal(fs.readFileSync(path.join(dir, 'wishlist.json'), 'utf8'), before); // richer capture untouched
assert.throws(() => save(poorer, dir), /EEXIST/); // never overwrite an existing snapshot
assert.equal(save(poorer, dir, {dryRun: true}).action, 'separate');
fs.rmSync(dir, {recursive: true});

// The page script must stay one valid async expression (it is pasted into javascript_tool).
const src = fs.readFileSync(new URL('../../skills/game-curator/scripts/claude-code/steam-wishlist-page.js', import.meta.url), 'utf8');
assert.doesNotThrow(() => new vm.Script(src));
assert.ok(!/\bfetch\s*\(|XMLHttpRequest|localStorage|document\.cookie|\.click\(/.test(src), 'page script must stay read-only');
console.log('Claude Code collector checks passed');
