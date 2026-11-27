// Synthetic collector -> supported delivery -> saver integration, in both directions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {makeWishlistPage} from './fake-wishlist-dom.mjs';
import {collectWishlist} from '../../skills/game-curator/scripts/browser/steam.mjs';
import {pagePathFingerprint} from '../../skills/game-curator/scripts/browser/path-fingerprint.mjs';
import {handleHook} from '../../skills/game-curator/scripts/claude-code/capture-hook.mjs';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'gc-cross-runtime-'));
const scripts=fileURLToPath(new URL('../../skills/game-curator/scripts/claude-code/',import.meta.url));
const saver=path.join(scripts,'save-capture.mjs'), cache=path.join(home,'cache/steam');
fs.writeFileSync(path.join(home,'settings.json'),JSON.stringify({version:1,persistence:{profileAndFeedback:false,steamCache:true}}));
const oldHome=process.env.CURATOR_HOME; process.env.CURATOR_HOME=home;
const run = args => {const r=spawnSync(process.execPath,[saver,...args],{encoding:'utf8',env:{...process.env,CURATOR_HOME:home}});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout)};
try {
  const site=makeWishlistPage({n:1}); let claude=await site.run({});
  for(let i=0;i<20 && !claude.format;i++) claude=await site.run({});
  assert.equal(claude.source,'wishlist');
  const body=fs.readFileSync(path.join(scripts,'steam-wishlist-page.js'),'utf8').replace(/\(\{\}\)\s*$/, "({deliver: 'hook'})");
  const payload={hook_event_name:'PostToolUse',tool_name:'mcp__Claude_Browser__javascript_tool',tool_use_id:'synthetic',tool_input:{action:'javascript_exec',text:body},tool_response:[{type:'text',text:JSON.stringify(claude)}]};
  const stage=()=>{const message=handleHook(payload,{dest:cache,settings:path.join(home,'settings.json'),skillDir:scripts});assert.match(message,/staged/); const name=fs.readdirSync(path.join(cache,'.staging')).find(n=>n.endsWith('.json')&&!n.endsWith('.meta.json'));return path.join(cache,'.staging',name)};
  const c1=run([stage(),'--provenance','hook-capture','--account','fixture']); assert.equal(c1.action,'create');
  const fake={playwright:{evaluate:async fn=>fn===pagePathFingerprint?'a'.repeat(64):{expected:1,view:{sort:'Your Rank',search:'empty',filters:'unknown'},reorderHandles:true,rows:[{appid:42,rank:1,name:'Codex fixture',pageText:'Codex fixture',membershipSource:'wishlist-row',complete:true}]}},scroll:async()=>{}};
  const codex=await collectWishlist(fake); const host=path.join(home,'host-result.json'); fs.writeFileSync(host,JSON.stringify(codex),{flag:'wx',mode:0o600});
  assert.equal(run([host,'--account','fixture']).action,'replace');
  const foreign=path.join(home,'foreign.json'); fs.writeFileSync(foreign,JSON.stringify({...codex,account:'other'}));
  const rejected=spawnSync(process.execPath,[saver,foreign,'--account','fixture'],{encoding:'utf8',env:{...process.env,CURATOR_HOME:home}});
  assert.equal(rejected.status,1); assert.match(rejected.stderr,/conflicts with the capture/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cache,'wishlist.json'))).records[0].appid,42);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cache,'wishlist.json'))).records[0].appid,42);
  assert.equal(run([stage(),'--provenance','hook-capture','--account','fixture']).action,'replace');
  assert.equal(JSON.parse(fs.readFileSync(path.join(cache,'wishlist.json'))).records[0].appid,claude.records[0].appid);
  console.log('synthetic Claude → Codex → Claude replacement passed');
} finally { if(oldHome===undefined) delete process.env.CURATOR_HOME; else process.env.CURATOR_HOME=oldHome; fs.rmSync(home,{recursive:true,force:true}); }
