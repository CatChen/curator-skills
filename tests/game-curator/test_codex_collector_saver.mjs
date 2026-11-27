// Synthetic collector -> shared saver acceptance. No user data or production settings.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {collectLibrary, collectWishlist, collectReviews, collectReplay} from '../../skills/game-curator/scripts/browser/steam.mjs';
import {pagePathFingerprint} from '../../skills/game-curator/scripts/browser/path-fingerprint.mjs';
import {codexIdentityPage} from '../../skills/game-curator/scripts/browser/codex-identity-page.mjs';
import {fingerprintSync,saltCheckOf} from '../../skills/game-curator/scripts/settings.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'gc-codex-e2e-'));
fs.writeFileSync(path.join(root,'settings.json'), JSON.stringify({version:1,persistence:{profileAndFeedback:false,steamCache:true}}), {mode:0o600});
const cli=fileURLToPath(new URL('../../skills/game-curator/scripts/claude-code/save-capture.mjs',import.meta.url));
const fake = data => ({playwright:{evaluate:async fn=>fn===pagePathFingerprint ? 'a'.repeat(64) : structuredClone(data)}, scroll:async()=>{}, goto:async()=>{}});
try {
  const results = [
    await collectLibrary(fake({expected:1,view:{tab:'all',search:'empty',language:'en'},records:[{appid:1,name:'Fixture',pageText:'Fixture\nDOWNLOAD',membershipSource:'all-games-row'}]})),
    await collectWishlist(fake({expected:1,view:{sort:'Your Rank',search:'empty',filters:'unknown'},reorderHandles:true,rows:[{appid:1,rank:1,name:'Fixture',pageText:'Fixture',membershipSource:'wishlist-row',complete:true}]})),
    await collectReviews(fake({url:'https://steamcommunity.com/id/fixture/recommended/',path:'/id/fixture/recommended/',expected:1,boxCount:1,ownerControls:true,rows:[{appid:1,reviewUrl:'https://steamcommunity.com/id/fixture/recommended/1/',recommended:true,review:'Fixture',playtimeDisplay:null,postedDate:null}],links:[]})),
    await collectReplay(fake({year:2024,accountPath:'/replay/fixture',text:'Fixture',apps:[],links:[],ownerControls:true}),{settleMs:0,settleCapMs:1}),
  ];
  for (const result of results) {
    const input=path.join(root,`${result.source}.json`); fs.writeFileSync(input,JSON.stringify(result),{mode:0o600});
    const run=spawnSync(process.execPath,[cli,input,'--access-scope','unknown'],{encoding:'utf8',env:{...process.env,CURATOR_HOME:root}});
    assert.equal(run.status,0,`${result.source}: ${run.stderr}`);
    const saved=JSON.parse(run.stdout), outcomes=result.source==='replay' ? saved.years : [saved];
    assert.ok(outcomes.length>0);
    for(const outcome of outcomes) assert.equal(outcome.action,'create',`${result.source} should create a snapshot`);
    const changed=structuredClone(result); changed.records[0][result.source==='replay'?'semanticText':result.source==='reviews'?'review':'name']='Tampered';
    fs.writeFileSync(input,JSON.stringify(changed),{mode:0o600});
    const bad=spawnSync(process.execPath,[cli,input,'--access-scope','unknown'],{encoding:'utf8',env:{...process.env,CURATOR_HOME:root}});
    assert.notEqual(bad.status,0,`${result.source} tampering must be rejected`);
    assert.match(bad.stderr,/host records checksum mismatch/);
  }
  // A mixed-identity run cannot be rescued by a manually confirmed alias.
  const salt='AQIDBAUGBwgJCgsMDQ4PEA', id='76561197960278073', fp=fingerprintSync(salt,id);
  fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({version:2,persistence:{profileAndFeedback:false,steamCache:true},steamAccount:{alias:'fixture',approvedAt:'2026-01-01T00:00:00Z',generation:'AAAAAAAAAAAAAAAAAAAAAA',fingerprint:{alg:'sha256-salted-v1',salt,value:fp}}}));
  let checks=0, batch=0;
  const tab={playwright:{evaluate:async fn=>fn===pagePathFingerprint?'c'.repeat(64):fn===codexIdentityPage?{version:1,sources:['userinfo-attr'],loggedIn:true,consistent:true,problems:[],saltCheck:saltCheckOf(salt),sessionFingerprint:++checks<4?fp:'b'.repeat(64),pathFingerprint:null}:{expected:2,view:{sort:'Your Rank',search:'empty',filters:'unknown'},reorderHandles:true,rows:[{appid:++batch,rank:batch,name:'Fixture',pageText:'Fixture',membershipSource:'wishlist-row',complete:true}]}},scroll:async()=>{}};
  const conflict=await collectWishlist(tab,{identity:{salt},maxScrolls:2});
  assert.equal(conflict.diagnostics.stopReason,'identity-changed');
  const conflictFile=path.join(root,'conflict.json'); fs.writeFileSync(conflictFile,JSON.stringify(conflict));
  const refused=spawnSync(process.execPath,[cli,conflictFile,'--access-scope','unknown','--account','fixture'],{encoding:'utf8',env:{...process.env,CURATOR_HOME:root}});
  assert.notEqual(refused.status,0); assert.match(refused.stderr,/known account identity conflict|cannot override a known observation/);
  console.log('synthetic Codex collector-to-saver checks passed');
} finally {fs.rmSync(root,{recursive:true,force:true});}
