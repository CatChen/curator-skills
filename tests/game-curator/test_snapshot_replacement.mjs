import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {save} from '../../skills/game-curator/scripts/cache.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-snapshot-'));
const dest = path.join(root, 'cache', 'steam');
const settings = path.join(root, 'settings.json');
const consent = enabled => fs.writeFileSync(settings, JSON.stringify({version:1,persistence:{profileAndFeedback:false,steamCache:enabled}}));
const capture = (method, name) => ({format:'game-curator-steam-export',version:1,source:'wishlist',capturedAt:'2026-01-01T00:00:00Z',method,coverage:'partial',warnings:[],account:'fixture',accessScope:'unknown',diagnostics:{complete:true,stopReason:'complete',uniqueCount:1,expectedCount:1,view:{sort:'Your Rank',search:'empty',filters:'none'}},records:[{appid:1,rank:1,name,pageText:name,membershipSource:'wishlist-row'}]});
try {
  consent(true);
  const claude = capture('browser-dom-claude-code', 'Claude');
  const codex = capture('browser-dom', 'Codex');
  assert.equal(save(claude,dest).action, 'create');
  const legacy = structuredClone(codex); delete legacy.diagnostics.complete; legacy.diagnostics.stopReason = 'partial';
  assert.equal(save(legacy,dest,{manualAccount:'fixture'}).action, 'replace');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dest,'wishlist.json'))).records[0].name, 'Codex');
  assert.equal(save(claude,dest,{manualAccount:'fixture'}).action, 'replace');
  const legacyCurrent = {...claude}; delete legacyCurrent.account; delete legacyCurrent.accessScope;
  fs.writeFileSync(path.join(dest,'wishlist.json'), JSON.stringify(legacyCurrent));
  assert.equal(save(codex,dest,{manualAccount:'fixture'}).action, 'replace', 'legacy cache without identity metadata remains replaceable');
  assert.equal(save(claude,dest,{manualAccount:'fixture'}).action, 'replace');
  const anonymous = structuredClone(codex); delete anonymous.account;
  const attributed = fs.readFileSync(path.join(dest,'wishlist.json'));
  assert.throws(() => save(anonymous,dest), /Confirm the existing cache account/);
  assert.deepEqual(fs.readFileSync(path.join(dest,'wishlist.json')), attributed);
  assert.equal(save(anonymous,dest,{manualAccount:'fixture'}).action,'replace');
  const original = fs.readFileSync(path.join(dest,'wishlist.json'));
  for (const bad of [
    {...codex,account:'other'},
    {...codex,diagnostics:{...codex.diagnostics,complete:false,stopReason:'interrupted'}},
    {...codex,diagnostics:{...codex.diagnostics,complete:false,stopReason:'partial',expectedCount:null}},
    {...codex,diagnostics:{...codex.diagnostics,uniqueCount:10}},
    {...codex,diagnostics:{...codex.diagnostics,identity:{version:1,sources:[],loggedIn:false,consistent:true,problems:[],saltCheck:null,sessionFingerprint:null,pathFingerprint:null}}},
    {...codex,diagnostics:{...codex.diagnostics,identity:{version:1,sources:['userinfo-attr'],loggedIn:true,consistent:true,problems:[],saltCheck:'a'.repeat(8),sessionFingerprint:'a'.repeat(64),pathFingerprint:'b'.repeat(64)}}},
  ]) { assert.throws(() => save(bad,dest)); assert.deepEqual(fs.readFileSync(path.join(dest,'wishlist.json')), original); }
  assert.throws(() => save(codex,dest,{manualAccount:'fixture',hooks:{beforeCommit(){consent(false);}}}), /not authorized/);
  assert.deepEqual(fs.readFileSync(path.join(dest,'wishlist.json')),original);
  consent(true);
  assert.throws(() => save(codex,dest,{manualAccount:'fixture',hooks:{beforeCommit(){fs.writeFileSync(path.join(dest,'wishlist.json'),'concurrent edit');}}}), /changed during save/);
  assert.equal(fs.readFileSync(path.join(dest,'wishlist.json'),'utf8'),'concurrent edit');
  assert.deepEqual(fs.readdirSync(dest).sort(), ['wishlist.json']);
  console.log('snapshot replacement checks passed');
} finally {fs.rmSync(root,{recursive:true,force:true});}
