import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {save} from '../../skills/game-curator/scripts/cache.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-separate-'));
const dest = path.join(root, 'steam'); fs.mkdirSync(dest, {mode: 0o700});
const env = (n, at) => {
  const records = [{appid: n, rank: 1, name: `Game ${n}`, pageText: `Game ${n}`, membershipSource: 'wishlist-row'}];
  return {format: 'game-curator-steam-export', version: 1, source: 'wishlist', capturedAt: at, method: 'browser-dom-claude-code', coverage: 'partial', warnings: [], account: 'test', accessScope: 'signed-in', diagnostics: {view: {sort: 'Name'}, expectedCount: 1, uniqueCount: 1, ranksObserved: 1, placeholderNameRows: 0, complete: true, reorderHandles: true, recordsSha256: crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex')}, records};
};
function perform(e) {
  const opts = {transferVerified: true, keepSeparate: true};
  const proposal = save(e, dest, {...opts, dryRun: true});
  for (const target of [proposal.target, proposal.backup].filter(Boolean)) assert.equal(fs.realpathSync(path.dirname(target)), fs.realpathSync(dest));
  if (proposal.action === 'full') { assert.throws(() => save(e, dest, opts), /limit/); return proposal; }
  const actual = save(e, dest, opts); assert.equal(actual.action, proposal.action); assert.equal(actual.target, proposal.target); return actual;
}
try {
  const first = env(1, '2026-01-01T00:00:00Z');
  assert.equal(perform(first).action, 'separate');
  assert.equal(perform({...first, capturedAt: '2026-01-02T00:00:00Z'}).action, 'duplicate');
  for (let n = 2; n <= 5; n++) assert.equal(perform(env(n, `2026-01-0${n+1}T00:00:00Z`)).action, 'separate');
  const before = fs.readdirSync(dest).sort();
  assert.equal(perform(env(6, '2026-01-07T00:00:00Z')).action, 'full');
  assert.deepEqual(fs.readdirSync(dest).sort(), before);
  console.log('separate retention checks passed');
} finally { fs.rmSync(root, {recursive: true, force: true}); }
