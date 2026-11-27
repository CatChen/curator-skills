// Synthetic browser contract tests; Node is a development-only dependency.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {collectWishlist as rawWishlist, collectLibrary as rawLibrary, collectReviews, collectReplay, normalizeLibraryRecord} from '../../skills/game-curator/scripts/browser/steam.mjs';

import {pagePathFingerprint} from '../../skills/game-curator/scripts/browser/path-fingerprint.mjs';
import {codexIdentityPage} from '../../skills/game-curator/scripts/browser/codex-identity-page.mjs';
import {evaluateIdentity} from '../../skills/game-curator/scripts/identity.mjs';
const testTab = (tab, view) => ({...tab, playwright:{...tab.playwright, evaluate:async (fn,arg) => {
  if (fn === pagePathFingerprint) return 'a'.repeat(64);
  const data = await tab.playwright.evaluate(fn,arg);
  return data && !data.view ? {...data,view} : data;
}}});
const collectWishlist = (tab,options) => rawWishlist(testTab(tab,{sort:'Your Rank',search:'empty',filters:'unknown'}),options);
const collectLibrary = (tab,options) => rawLibrary(testTab(tab,{tab:'all',search:'empty',language:'en'}),options);

// A path fingerprint must match the standard SHA-256 framing and reveal no raw path.
{
  const prior = globalThis.location;
  try {
    globalThis.location = {origin:'https://steamcommunity.com', pathname:'/id/synthetic/games'};
    const salt = Array.from({length:16},(_,i)=>i);
    const bytes = Buffer.concat([Buffer.from(salt),Buffer.from('curator/page-path/v1\0https://steamcommunity.com/id/synthetic/games')]);
    const digest = pagePathFingerprint({salt});
    assert.equal(digest,crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.ok(!digest.includes('synthetic'));
  } finally {globalThis.location=prior;}
}
// Navigation between observations aborts before a foreign batch is read or merged.
{
  let checks=0, reads=0;
  const tab={playwright:{evaluate:async fn=>fn===pagePathFingerprint ? (++checks < 4 ? 'a'.repeat(64) : 'b'.repeat(64)) : (++reads,{expected:2,view:{sort:'Your Rank',search:'empty',filters:'unknown'},rows:[{appid:1,rank:1,name:'One'}]})},scroll:async()=>{}};
  const result=await rawWishlist(tab,{maxScrolls:2});
  assert.equal(result.records.length,1); assert.equal(reads,1); assert.equal(result.diagnostics.complete,false); assert.equal(result.diagnostics.stopReason,'path-changed');
  let calls=0;
  const unguarded={playwright:{evaluate:async fn=>fn===pagePathFingerprint ? null : (++calls,{expected:2,rows:[{appid:1,rank:1,name:'One'}]})},scroll:async()=>{}};
  const limited=await rawWishlist(unguarded,{maxScrolls:2});
  assert.equal(calls,1); assert.equal(limited.diagnostics.stopReason,'path-unavailable');
}

await assert.rejects(rawWishlist({playwright:{evaluate:async()=>null}},{identity:{salt:'invalid'}}),/valid 16-byte salt/);
// A change of signed-in identity stops before a later batch is merged.
{
  let checks=0, reads=0;
  const obs = fp => ({version:1,sources:['userinfo-attr'],loggedIn:true,consistent:true,problems:[],saltCheck:'12345678',sessionFingerprint:fp,pathFingerprint:null});
  const tab={playwright:{evaluate:async fn=>fn===pagePathFingerprint ? 'c'.repeat(64) : fn===codexIdentityPage ? obs(++checks<4?'a'.repeat(64):'b'.repeat(64)) : (++reads,{expected:2,view:{sort:'Your Rank',search:'empty',filters:'unknown'},rows:[{appid:reads,rank:reads,name:'Fixture'}]})},scroll:async()=>{}};
  const result=await rawWishlist(tab,{maxScrolls:2,identity:{salt:'AQIDBAUGBwgJCgsMDQ4PEA'}});
  assert.equal(result.records.length,1); assert.equal(result.diagnostics.stopReason,'identity-changed');
  assert.equal(result.diagnostics.identity.continuity.broke,true); assert.equal(result.diagnostics.identity.continuity.stable,false);
}

// Identity first becoming observable after a batch started cannot attest that batch.
{
  let checks=0;
  const obs=()=>({version:1,sources:++checks===1?[]:['userinfo-attr'],loggedIn:checks===1?null:true,consistent:true,problems:[],saltCheck:'12345678',sessionFingerprint:checks===1?null:'a'.repeat(64),pathFingerprint:null});
  const tab={playwright:{evaluate:async fn=>fn===pagePathFingerprint?'c'.repeat(64):fn===codexIdentityPage?obs():{expected:1,view:{sort:'Your Rank',search:'empty',filters:'unknown'},reorderHandles:true,rows:[{appid:1,rank:1,name:'Fixture',pageText:'Fixture'}]}}};
  const result=await rawWishlist(tab,{identity:{salt:'AQIDBAUGBwgJCgsMDQ4PEA'}});
  assert.equal(result.diagnostics.identity.continuity.covered,false);
  const verdict=evaluateIdentity({binding:{fingerprint:{salt:'AQIDBAUGBwgJCgsMDQ4PEA',value:'a'.repeat(64)}},observation:result.diagnostics.identity,ownerEvidence:true});
  assert.equal(verdict.result,'ambiguous');
}

const parsed=normalizeLibraryRecord({appid:1,pageText:'TOTAL PLAYED 45 minutes LAST PLAYED Jan 21 ACHIEVEMENTS 3/10 DOWNLOAD 4.6 GB'});
assert.equal(parsed.hours,0.75);
assert.equal(parsed.lastPlayedDisplay,'Jan 21');
assert.deepEqual(parsed.achievements,{unlocked:3,total:10});
assert.equal(normalizeLibraryRecord({appid:2,pageText:'DOWNLOAD 4.6 GB'}).hours,null);
assert.equal(normalizeLibraryRecord({appid:3,pageText:'TOTAL PLAYED 0 hours'}).hours,0);
assert.equal(normalizeLibraryRecord({appid:4,pageText:'TOTAL PLAYED 1,179.9 hours'}).hours,1179.9);
assert.equal(normalizeLibraryRecord({appid:5,hours:500,pageText:'TOTAL PLAYED 45 minutes'}).hours,0.75);
assert.equal(normalizeLibraryRecord({appid:6,hours:500,pageText:'DOWNLOAD 4.6 GB'}).hours,null);

function tabWith(batches) {
  let current=0;
  return {playwright:{evaluate:async()=>batches[Math.min(current,batches.length-1)]},
    scroll:async()=>{current++},getAXState:async()=>{},goto:async()=>{current++}};
}
const wishlist=await collectWishlist(tabWith([
  {expected:2,rows:[{appid:1,rank:1,name:'One'}]},
  {expected:2,rows:[{appid:2,rank:2,name:'Two'}]},
]));
assert.equal(wishlist.records.length,2);
assert.equal(wishlist.coverage,'partial');
assert.equal(wishlist.diagnostics.complete,true); assert.equal(wishlist.diagnostics.stopReason,'complete');
assert.equal(wishlist.diagnostics.recordsChecksum?.scope,'host-records');
assert.equal(wishlist.diagnostics.recordsChecksum?.sha256,'41669cc21ff8325c201e27e738603e5eda4cdf4bfcf80c19b0664f21876a9038');
assert.equal(wishlist.diagnostics.scrollSteps,1);
// Conflicting ranks or changing displayed totals never mix batches into one capture.
const conflicting=await collectWishlist(tabWith([
  {expected:2,rows:[{appid:1,rank:1,name:'One'}]},
  {expected:2,rows:[{appid:2,rank:1,name:'Two'}]},
]),{maxScrolls:2});
assert.deepEqual(conflicting.records.map(r=>r.appid),[1]);
assert.equal(conflicting.diagnostics.stopReason,'rank-conflict');
const changedRank=await collectWishlist(tabWith([
  {expected:2,rows:[{appid:1,rank:1,name:'One'}]},
  {expected:2,rows:[{appid:1,rank:2,name:'One'}]},
]),{maxScrolls:2});
assert.equal(changedRank.diagnostics.stopReason,'rank-conflict');
const withinBatch=await collectWishlist(tabWith([{expected:2,rows:[{appid:1,rank:1,name:'One'},{appid:2,rank:1,name:'Two'}]}]),{maxScrolls:1});
assert.equal(withinBatch.diagnostics.stopReason,'rank-conflict');
assert.equal(withinBatch.records.length,0);
const changedWishlistView=await collectWishlist(tabWith([
  {expected:2,view:{sort:'Your Rank',search:'empty',filters:'unknown'},rows:[{appid:1,rank:1,name:'One'}]},
  {expected:2,view:{sort:'Your Rank',search:'active',filters:'unknown'},rows:[{appid:2,rank:2,name:'Two'}]},
]),{maxScrolls:2});
assert.deepEqual(changedWishlistView.records.map(r=>r.appid),[1]);
assert.equal(changedWishlistView.diagnostics.stopReason,'view-changed');
let filteredReads=0;
const filtered=await collectWishlist({playwright:{evaluate:async()=>({expected:2,view:{sort:'Your Rank',search:'active',filters:'unknown'},rows:[{appid:++filteredReads,rank:filteredReads,name:'Fixture'}]})},scroll:async()=>{}});
assert.equal(filteredReads,1); assert.equal(filtered.diagnostics.stopReason,'view-unverified'); assert.equal(filtered.diagnostics.complete,false);
const changingCount=await collectWishlist(tabWith([
  {expected:2,rows:[{appid:1,rank:1,name:'One'}]},
  {expected:3,rows:[{appid:2,rank:2,name:'Two'}]},
]),{maxScrolls:2});
assert.deepEqual(changingCount.records.map(r=>r.appid),[1]);
assert.equal(changingCount.diagnostics.stopReason,'view-changed');
const partial=await collectWishlist(tabWith([{expected:2,rows:[{appid:1,rank:1}]}]),{maxScrolls:1});
assert.ok(partial.warnings.some(x=>x.includes('collected 1')));
const rankGap=await collectWishlist(tabWith([{expected:2,rows:[{appid:1,rank:1},{appid:2,rank:3}]}]),{maxScrolls:1});
assert.ok(rankGap.diagnostics.scrollSteps<=1);
assert.deepEqual(rankGap.diagnostics.missingRanks,[2]);
assert.ok(rankGap.warnings.some(x=>x.includes('do not cover')));
// Lazy placeholder rows (complete:false) never overwrite a loaded row and never count as loaded.
const lazy=await collectWishlist(tabWith([
  {expected:2,rows:[{appid:1,rank:1,name:'One',pageText:'One\nRELEASE DATE:\nJAN 1, 2020',complete:true},{appid:2,rank:2,name:'MY CATEGORIES:',pageText:'MY CATEGORIES:',complete:false}]},
  {expected:2,rows:[{appid:1,rank:1,name:'MY CATEGORIES:',pageText:'MY CATEGORIES:',complete:false},{appid:2,rank:2,name:'Two',pageText:'Two\nRELEASE DATE:\nJAN 2, 2020',complete:true}]},
]));
assert.deepEqual(lazy.records.map(r=>r.name),['One','Two']);
assert.ok(lazy.records.every(r=>!('complete' in r)&&r.pageText.includes('RELEASE DATE:')));
assert.equal(lazy.diagnostics.placeholderNameRows,0);
assert.equal(lazy.warnings.some(x=>x.includes('placeholders')),false);
const stuck=await collectWishlist(tabWith([{expected:2,rows:[{appid:1,rank:1,name:'One',pageText:'One',complete:true},{appid:2,rank:2,name:'MY CATEGORIES:',pageText:'MY CATEGORIES:',complete:false}]}]),{maxScrolls:2});
assert.equal(stuck.diagnostics.placeholderNameRows,1);
assert.ok(stuck.warnings.some(x=>x.includes('placeholders')));
assert.deepEqual(stuck.records.map(r=>r.name),['One']); // unresolved placeholder omitted, not stored
assert.equal(stuck.diagnostics.uniqueCount,1);
assert.ok(stuck.warnings.some(x=>x.includes('Displayed 2')));
assert.deepEqual(stuck.diagnostics.missingRanks,[2]);
// A late lazy row resolves on re-read without a scroll, preserving the first record.
let lazyReads=0, lazyScrolls=0;
const late=await collectWishlist({playwright:{evaluate:async()=>({expected:2,rows:[{appid:1,rank:1,name:'One'}, {appid:2,rank:2,name:'Two',complete:++lazyReads>=3}]})},scroll:async()=>{lazyScrolls++}});
assert.equal(lazyScrolls,0);
assert.deepEqual(late.records.map(r=>r.name),['One','Two']);
assert.equal(late.diagnostics.settleWaits,2);
// A gap behind the current rendered window causes a supported upward scroll.
let window=0, directions=[];
const gap=await collectWishlist({playwright:{evaluate:async()=>window===0?{expected:3,rows:[{appid:2,rank:2,name:'Two'},{appid:3,rank:3,name:'Three'}]}:{expected:3,rows:[{appid:1,rank:1,name:'One'}]}},scroll:async(_p,d)=>{directions.push(d);window++}});
assert.deepEqual(directions,['up']);
assert.deepEqual(gap.records.map(r=>r.rank),[1,2,3]);
// A failed scroll preserves the prior batch and reports missing ranks.
const interrupted=await collectWishlist({playwright:{evaluate:async()=>({expected:2,rows:[{appid:1,rank:1,name:'One'}]})},scroll:async()=>{throw Error('synthetic failure')}});
assert.deepEqual(interrupted.records.map(r=>r.rank),[1]);
assert.deepEqual(interrupted.diagnostics.missingRanks,[2]);
assert.ok(interrupted.warnings.some(x=>x.includes('interrupted')));
const interruptedSecret=await collectWishlist({playwright:{evaluate:async()=>({expected:2,rows:[{appid:1,rank:1,name:'One'}]})},scroll:async()=>{throw Error('scroll failed SECRET')}});
assert.ok(interruptedSecret.warnings.some(x=>x.includes('scroll-unavailable')));
assert.ok(!JSON.stringify(interruptedSecret).includes('SECRET'));
// The shared row snapshot is the function handed to the host's read-only evaluate.
let evaluated=null;
await collectWishlist({playwright:{evaluate:async fn=>{evaluated=fn;return {expected:1,rows:[{appid:1,rank:1,name:'One'}]}}}});
assert.equal(typeof evaluated,'function');
assert.match(evaluated.toString(),/WishlistItem-/);
const settledLibrary=await collectLibrary(tabWith([{expected:1,view:{tab:'all',search:'empty',language:'en'},records:[{appid:1,name:'One',pageText:'One'}]}]));
assert.equal(settledLibrary.diagnostics.complete,true);
// A retained row may stay unchanged while its current observed fields change.
let observationReads=0;
{
  const realNow=Date.now, realTimeout=globalThis.setTimeout;
  let clock=0;
  try {
    Date.now=()=>clock;
    globalThis.setTimeout=(callback,delay)=>{ clock+=delay; queueMicrotask(callback); return 0; };
    const changingLibrary=await collectLibrary({playwright:{evaluate:async()=>({expected:1,records:[{appid:1,name:++observationReads<3?'Old':'New',pageText:'Fixture'}]})}});
    assert.equal(changingLibrary.diagnostics.complete,true);
    assert.ok(observationReads>=7, 'settling restarts after current observations change');
  } finally { Date.now=realNow; globalThis.setTimeout=realTimeout; }
}
const library=await collectLibrary(tabWith([{expected:2,records:[{appid:1,name:'One'}]}]));
assert.ok(library.warnings.some(x=>x.includes('collected 1')));
const changedLibrary=await collectLibrary(tabWith([
  {expected:2,records:[{appid:1,name:'One',pageText:'One'}]},
  {expected:3,records:[{appid:2,name:'Two',pageText:'Two'}]},
]),{maxScrolls:2});
assert.deepEqual(changedLibrary.records.map(r=>r.appid),[1]);
assert.equal(changedLibrary.diagnostics.stopReason,'view-changed');
const filteredLibrary=await collectLibrary(tabWith([
  {expected:2,view:{tab:'all',search:'empty',language:'en'},records:[{appid:1,name:'One',pageText:'One'}]},
  {expected:2,view:{tab:'all',search:'active',language:'en'},records:[{appid:2,name:'Two',pageText:'Two'}]},
]),{maxScrolls:2});
assert.deepEqual(filteredLibrary.records.map(r=>r.appid),[1]);
assert.equal(filteredLibrary.diagnostics.stopReason,'view-changed');
const libraryBatches=await collectLibrary(tabWith([
  {expected:2,records:[{appid:1,name:'One',pageText:'One\nTOTAL PLAYED 1 hour'}]},
  {expected:2,records:[{appid:1,name:'One',pageText:'One'}, {appid:2,name:'Two',pageText:'Two'}]},
]));
assert.match(libraryBatches.records[0].pageText,/TOTAL PLAYED/);
// The Codex library collector hands the shared, self-contained row snapshot to the host's read-only evaluate (the same source the Claude page script inlines).
let libEvaluated=null;
const libShared=await collectLibrary({playwright:{evaluate:async fn=>{libEvaluated=fn;return {expected:1,records:[{appid:1,name:'One',pageText:'One\nTOTAL PLAYED\n2 hours'}]}}}});
assert.equal(typeof libEvaluated,'function'); assert.match(libEvaluated.toString(),/All Games/);
assert.equal(libShared.records[0].hours,2); assert.equal(libShared.records[0].achievements,null); // absent label stays null, never 0
const libGrow=await collectLibrary(tabWith([
  {expected:2,records:[{appid:1,name:null,pageText:'One'}]},
  {expected:2,records:[{appid:1,name:'One',pageText:'One\nTOTAL PLAYED\n1 hour'},{appid:2,name:'Two',pageText:'Two'}]},
]));
assert.equal(libGrow.records.find(r=>r.appid===1).name,'One'); assert.equal(libGrow.records.find(r=>r.appid===1).hours,1); assert.equal(libGrow.records.find(r=>r.appid===2).hours,null);
const review=await collectReviews(tabWith([
  {url:'https://steamcommunity.com/id/example/recommended/',path:'/id/example/recommended/',expected:2,rows:[{appid:1,reviewUrl:'https://steamcommunity.com/id/example/recommended/1/'}],links:['https://steamcommunity.com/id/example/recommended/?p=2']},
  {url:'https://steamcommunity.com/id/example/recommended/?p=2',path:'/id/example/recommended/',expected:2,rows:[{appid:2,reviewUrl:'https://steamcommunity.com/id/example/recommended/2/'}],links:[]}
]));
assert.equal(review.records.length,2);
assert.equal(review.diagnostics.pagesVisited,2);
// The Codex reviews collector hands the shared, self-contained page snapshot to the host's read-only evaluate.
let reviewEvaluated=null;
await collectReviews({playwright:{evaluate:async fn=>{reviewEvaluated=fn;return {url:'https://steamcommunity.com/id/example/recommended/',path:'/id/example/recommended/',expected:1,rows:[{appid:1,reviewUrl:'https://steamcommunity.com/id/example/recommended/1/'}],links:[]}}},goto:async()=>{}});
assert.equal(typeof reviewEvaluated,'function'); assert.match(reviewEvaluated.toString(),/\.review_box/);
// Names must be added by the shared saver, which checks the bound library snapshot.
await assert.rejects(collectReviews(tabWith([]), {library:{source:'library',records:[{appid:1,name:'Synthetic'}]},verifiedSameAccount:true}),/shared saver/);
const reviewChanged=await collectReviews(tabWith([
  {url:'https://steamcommunity.com/id/example/recommended/',path:'/id/example/recommended/',expected:2,boxCount:1,ownerControls:true,rows:[{appid:1,reviewUrl:'https://steamcommunity.com/id/example/recommended/1/'}],links:['https://steamcommunity.com/id/example/recommended/?p=2']},
  {url:'https://steamcommunity.com/id/example/recommended/?p=2',path:'/id/example/recommended/',expected:3,boxCount:1,ownerControls:true,rows:[{appid:2,reviewUrl:'https://steamcommunity.com/id/example/recommended/2/'}],links:[]}
]));
assert.equal(reviewChanged.records.length,1); assert.equal(reviewChanged.diagnostics.stopReason,'view-changed');
const missingBoxes=await collectReviews(tabWith([{url:'https://steamcommunity.com/id/example/recommended/',path:'/id/example/recommended/',expected:2,boxCount:2,ownerControls:true,rows:[{appid:1,reviewUrl:'https://steamcommunity.com/id/example/recommended/1/'}],links:[]}]));
assert.equal(missingBoxes.diagnostics.stopReason,'rows-missing'); assert.equal(missingBoxes.diagnostics.ownerControls,true);
const unownedReview=await collectReviews(tabWith([{url:'https://steamcommunity.com/id/example/recommended/',path:'/id/example/recommended/',expected:1,boxCount:1,ownerControls:false,rows:[{appid:1,reviewUrl:'https://steamcommunity.com/id/example/recommended/1/'}],links:[]}]));
assert.equal(unownedReview.diagnostics.ownerControls,false);
{
  let checks=0, page=0;
  const obs=()=>({version:1,sources:['userinfo-attr'],loggedIn:true,consistent:true,problems:[],saltCheck:'12345678',sessionFingerprint:(++checks<4?'a':'b').repeat(64),pathFingerprint:null});
  const tab={playwright:{evaluate:async fn=>fn===codexIdentityPage?obs():{url:`https://steamcommunity.com/id/example/recommended/?p=${page+1}`,path:'/id/example/recommended/',expected:2,boxCount:1,ownerControls:true,rows:[{appid:page+1,reviewUrl:`https://steamcommunity.com/id/example/recommended/${page+1}/`}],links:page?[]:['https://steamcommunity.com/id/example/recommended/?p=2']}},goto:async()=>{page++;}};
  const result=await collectReviews(tab,{identity:{salt:'AQIDBAUGBwgJCgsMDQ4PEA'}});
  assert.equal(result.records.length,1); assert.equal(result.diagnostics.stopReason,'identity-changed'); assert.equal(result.diagnostics.pagesPending,1);
}
const foreignReview=await collectReviews(tabWith([{url:'https://steamcommunity.com/id/example/recommended/',path:'/id/example/recommended/',expected:1,boxCount:1,ownerControls:true,rows:[{appid:1,reviewUrl:'https://steamcommunity.com/id/other/recommended/1/'}],links:[]} ]));
assert.equal(foreignReview.records.length,0); assert.equal(foreignReview.diagnostics.stopReason,'rows-invalid');
const redirectedReview=await collectReviews(tabWith([
  {url:'https://steamcommunity.com/id/example/recommended/',path:'/id/example/recommended/',expected:2,rows:[{appid:1,reviewUrl:'https://steamcommunity.com/id/example/recommended/1/'}],links:['https://steamcommunity.com/id/example/recommended/?p=2']},
  {url:'https://steamcommunity.com/id/example/recommended/',path:'/id/example/recommended/',expected:2,rows:[{appid:1,reviewUrl:'https://steamcommunity.com/id/example/recommended/1/'}],links:[]}
]));
assert.equal(redirectedReview.diagnostics.pageAttempts,2);
assert.equal(redirectedReview.diagnostics.pagesPending,1);
assert.ok(redirectedReview.warnings.some(x=>x.includes('redirected')));
const replay=await collectReplay(tabWith([
  {year:2025,accountPath:'/replay/example',text:'activity',apps:[],links:['https://store.steampowered.com/replay/example/2024']},
  {year:2024,accountPath:'/replay/example',text:'activity',apps:[],links:[]}
]));
assert.deepEqual(replay.diagnostics.years,[2025,2024]);
assert.equal(replay.diagnostics.ownerControls,false);
let replayBoundaryReads=0;
const switchedReplay=await collectReplay({playwright:{evaluate:async()=>({year:2025,accountPath:++replayBoundaryReads===1?'/replay/example':'/replay/other',text:'activity',apps:[],links:[],ownerControls:true})}},{settleMs:1,settleCapMs:5}).catch(e=>e);
assert.match(String(switchedReplay.message),/changed/);
{
  let checks=0, page=0;
  const obs=()=>({version:1,sources:['userinfo-attr'],loggedIn:true,consistent:true,problems:[],saltCheck:'12345678',sessionFingerprint:(++checks<4?'a':'b').repeat(64),pathFingerprint:null});
  const tab={playwright:{evaluate:async fn=>fn===codexIdentityPage?obs():{year:2025-page,accountPath:'/replay/fixture',text:'Fixture',apps:[],ownerControls:true,links:page?[]:['https://store.steampowered.com/replay/fixture/2024']}},goto:async()=>{page++;}};
  const result=await collectReplay(tab,{settleMs:0,settleCapMs:1,identity:{salt:'AQIDBAUGBwgJCgsMDQ4PEA'}});
  assert.equal(result.records.length,1); assert.equal(result.diagnostics.stopReason,'identity-changed'); assert.equal(result.diagnostics.identityYears.length,1);
}
const redirectedReplay=await collectReplay(tabWith([
  {year:2025,accountPath:'/replay/example',text:'activity',apps:[{appid:1,source:'image-asset'},{appid:1,source:'app-link'}],links:['https://store.steampowered.com/replay/example/2024']},
  {year:2025,accountPath:'/replay/example',text:'activity',apps:[],links:[]}
]));
assert.equal(redirectedReplay.diagnostics.yearAttempts,2);
assert.equal(redirectedReplay.diagnostics.yearsPending,1);
assert.equal(redirectedReplay.records[0].apps[0].source,'app-link');
assert.equal(redirectedReplay.records[0].apps.length,1);
assert.ok(redirectedReplay.warnings.some(x=>x.includes('requested year')));
let reads=0;
const loadingTab={playwright:{evaluate:async()=>({year:2025,accountPath:'/replay/example',text:++reads===1?'LOADING...':'activity',apps:[],links:[]})}};
assert.deepEqual((await collectReplay(loadingTab,{settleMs:1,settleCapMs:10})).diagnostics.years,[2025]);
assert.ok(reads>=2);
let stage=0;
const stagedTab={playwright:{evaluate:async()=>({year:2025,accountPath:'/replay/example',text:++stage===1?'Activity\nLOADING...':'Activity\nComplete',apps:stage<2?[]:[{appid:42,source:'image-asset'}],links:[]})}};
const settled=await collectReplay(stagedTab,{settleMs:1,settleCapMs:20});
assert.equal(settled.records[0].apps.length,1);
assert.equal(settled.records[0].semanticText,'Activity\nComplete');
const stuckReplay=await collectReplay({playwright:{evaluate:async()=>({year:2025,accountPath:'/replay/example',text:'Activity\nLOADING...\nMore',apps:[],links:[]})}},{settleMs:1,settleCapMs:5});
assert.deepEqual(stuckReplay.diagnostics.unsettledYears,[2025]);
assert.ok(stuckReplay.warnings.some(x=>x.includes('did not settle')));
// Changes hidden by the old length/tail/count signature must reset the stable window.
let revisions=0;
const changing=await collectReplay({playwright:{evaluate:async()=>{revisions++; return {year:2025,accountPath:'/replay/example',text:(revisions===1?'A':'B')+'x'.repeat(250),apps:[{appid:revisions<3?1:2,source:'image-asset'}],links:[]};}}},{settleMs:5,settleCapMs:60});
assert.ok(revisions>=4);
assert.equal(changing.records[0].semanticText[0],'B');
assert.equal(changing.records[0].apps[0].appid,2);
assert.deepEqual(changing.diagnostics.unsettledYears,[]);
const interruptedReplay=await collectReplay({playwright:{evaluate:async()=>({year:2025,accountPath:'/replay/example',text:'activity',apps:[],links:['https://store.steampowered.com/replay/example/2024']})},goto:async()=>{throw Error('synthetic failure')}},{settleMs:0,settleCapMs:1});
assert.equal(interruptedReplay.records.length,1);
assert.equal(interruptedReplay.diagnostics.yearsPending,1);
assert.ok(interruptedReplay.warnings.some(x=>x.includes('interrupted')));

// Exercise the actual read-only DOM extraction callback with synthetic elements.
const oldDocument=globalThis.document, oldLocation=globalThis.location;
try {
  globalThis.location={protocol:'https:',hostname:'steamcommunity.com',pathname:'/id/example/games'};
  const panel={innerText:'Synthetic game\nTOTAL PLAYED\n45 minutes'};
  const gameLink={href:'https://store.steampowered.com/app/123',closest:()=>panel,
    getAttribute:()=>null,innerText:'Synthetic game',querySelector:()=>null};
  globalThis.document={body:{innerText:'All Games (1)'},querySelectorAll:()=>[gameLink,gameLink]};
  const liveCallbackTab={playwright:{evaluate:async fn=>fn()}};
  const extracted=await collectLibrary(liveCallbackTab,{maxScrolls:0});
  assert.equal(extracted.records.length,1);
  assert.equal(extracted.records[0].appid,123);
  assert.match(extracted.records[0].pageText,/45 minutes/);
  globalThis.location.hostname='example.invalid';
  await assert.rejects(collectLibrary(liveCallbackTab),/Steam Community/);
  globalThis.location={protocol:'https:',hostname:'store.steampowered.com',pathname:'/replay/example/2025',origin:'https://store.steampowered.com'};
  const image={getAttribute:()=> 'https://example.invalid/steam/apps/123/image.jpg',alt:''};
  globalThis.document={querySelector:()=>({innerText:'Synthetic annual activity',querySelectorAll:selector=>selector==='img[src]'?[image]:[]}),querySelectorAll:()=>[]};
  const extractedReplay=await collectReplay(liveCallbackTab);
  assert.equal(extractedReplay.records[0].apps[0].appid,123);
  assert.equal(extractedReplay.records[0].apps[0].source,'image-asset');
} finally {globalThis.document=oldDocument;globalThis.location=oldLocation;}
console.log('Synthetic browser orchestration checks passed');
