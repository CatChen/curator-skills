import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {save, selectSnapshots} from '../../skills/game-curator/scripts/cache.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-boundary-'));
const dest = path.join(root, 'cache', 'steam'); fs.mkdirSync(dest, {recursive: true});
const settings = path.join(root, 'settings.json');
const set = v => fs.writeFileSync(settings, v);
const records = [{appid: 1, rank: 1, name: 'Test', pageText: 'Test', membershipSource: 'wishlist-row'}];
const env = {format:'game-curator-steam-export', version:1, source:'wishlist', capturedAt:'2026-01-01T00:00:00Z', method:'browser-dom-claude-code', coverage:'partial', warnings:[], account:'test', accessScope:'signed-in', records, diagnostics:{expectedCount:1, uniqueCount:1, ranksObserved:1, placeholderNameRows:0, complete:true, reorderHandles:true, view:{sort:'Your Rank',search:'empty',filters:'none'}, recordsSha256:crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex')}};
try {
  const poison = new Proxy({}, {get() { throw Error('payload read'); }});
  const sentinel = path.join(dest, 'wishlist.json'); fs.writeFileSync(sentinel, 'private sentinel');
  const originalRead = fs.readFileSync; let cacheReads = 0;
  fs.readFileSync = function(file, ...args) { if (String(file).startsWith(dest + path.sep)) cacheReads++; return originalRead.call(this, file, ...args); };
  for (const setting of [null, '{', JSON.stringify({version:2}), JSON.stringify({version:1,persistence:{profileAndFeedback:false,steamCache:false}})]) {
    if (setting === null) fs.rmSync(settings, {force:true}); else set(setting);
    for (const dryRun of [true, false]) assert.throws(() => save(poison, dest, {dryRun}), /not authorized/);
  }
  assert.equal(cacheReads, 0); fs.readFileSync = originalRead; fs.unlinkSync(sentinel);
  set(JSON.stringify({version:1,persistence:{profileAndFeedback:false,steamCache:true}}));
  assert.throws(() => save(env, dest, {dryRun:true, stem:'../escape'}), /stem override/);
  assert.throws(() => save({...env,source:'replay',records:[]}, dest, {dryRun:true}), /Invalid capture|annual split/);
  const noTransfer = save(env, dest, {dryRun:true, transferVerified:true});
  assert.equal(noTransfer.action, 'separate');
  const verified = structuredClone(env); verified.diagnostics.attestations = {transfer:{level:'runtime-tool-result'}, sourceEnvelopeSha256:'../../escape'};
  const proposal = save(verified, dest, {dryRun:true, transferVerified:true});
  assert.equal(proposal.action, 'create');
  const separatePath = save(verified, dest, {dryRun:true, transferVerified:true, keepSeparate:true});
  assert.equal(fs.realpathSync(path.dirname(separatePath.target)), fs.realpathSync(dest));
  assert.match(path.basename(separatePath.target), /^wishlist\.managed-v1\.partial\.\d{8}T\d{6}Z-[a-f0-9]{12}\.json$/);
  assert.equal(fs.realpathSync(path.dirname(proposal.target)), fs.realpathSync(dest));
  assert.equal(save(verified, dest, {transferVerified:true}).action, 'create');
  const currentBytes = fs.readFileSync(proposal.target, 'utf8');
  const later = structuredClone(verified); later.capturedAt = '2026-01-02T00:00:00Z';
  const laterDry = save(later, dest, {dryRun:true, transferVerified:true});
  assert.equal(fs.realpathSync(path.dirname(laterDry.target)), fs.realpathSync(dest));
  assert.throws(() => save(later, dest, {transferVerified:true, hooks:{beforeCommit:() => set(JSON.stringify({version:1,persistence:{profileAndFeedback:false,steamCache:false}}))}}), /steamCache false/);
  assert.equal(fs.readFileSync(proposal.target, 'utf8'), currentBytes);
  set(JSON.stringify({version:1,persistence:{profileAndFeedback:false,steamCache:true}}));
  const invalid = {...verified, records: 'bad'};
  const foreign = {...verified, account:'other'};
  const result = selectSnapshots([invalid, foreign, verified], {source:'wishlist',account:'test',accessScope:'signed-in'});
  assert.equal(result.selected, verified); assert.equal(result.supporting.length, 0); assert.equal(result.rejected.length, 2);
  console.log('shared cache boundary checks passed');
} finally { fs.rmSync(root, {recursive:true,force:true}); }
