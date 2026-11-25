// Synthetic browser contract tests; Node is a development-only dependency.
import assert from 'node:assert/strict';
import {collectWishlist, collectLibrary, collectReviews, collectReplay, normalizeLibraryRecord} from '../../skills/game-curator/scripts/browser/steam.mjs';

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
assert.equal(wishlist.diagnostics.scrollSteps,1);
const partial=await collectWishlist(tabWith([{expected:2,rows:[{appid:1,rank:1}]}]),{maxScrolls:1});
assert.ok(partial.warnings.some(x=>x.includes('collected 1')));
const rankGap=await collectWishlist(tabWith([{expected:2,rows:[{appid:1,rank:1},{appid:2,rank:3}]}]),{maxScrolls:1});
assert.equal(rankGap.diagnostics.scrollSteps,1);
assert.ok(rankGap.warnings.some(x=>x.includes('do not cover')));
const library=await collectLibrary(tabWith([{expected:2,records:[{appid:1,name:'One'}]}]));
assert.ok(library.warnings.some(x=>x.includes('collected 1')));
const libraryBatches=await collectLibrary(tabWith([
  {expected:2,records:[{appid:1,name:'One',pageText:'One\nTOTAL PLAYED 1 hour'}]},
  {expected:2,records:[{appid:1,name:'One',pageText:'One'}, {appid:2,name:'Two',pageText:'Two'}]},
]));
assert.match(libraryBatches.records[0].pageText,/TOTAL PLAYED/);
const review=await collectReviews(tabWith([
  {url:'https://steamcommunity.com/id/example/recommended/',path:'/id/example/recommended/',expected:2,rows:[{appid:1,reviewUrl:'r1'}],links:['https://steamcommunity.com/id/example/recommended/?p=2']},
  {url:'https://steamcommunity.com/id/example/recommended/?p=2',path:'/id/example/recommended/',expected:2,rows:[{appid:2,reviewUrl:'r2'}],links:[]}
]));
assert.equal(review.records.length,2);
assert.equal(review.diagnostics.pagesVisited,2);
const reviewWithNames=await collectReviews(tabWith([
  {url:'https://steamcommunity.com/id/example/recommended/',path:'/id/example/recommended/',expected:1,rows:[{appid:1,reviewUrl:'r1'}],links:[]}
]), {library:{source:'library',records:[{appid:1,name:'Synthetic'}]},verifiedSameAccount:true});
assert.equal(reviewWithNames.records[0].name,'Synthetic');
assert.equal(reviewWithNames.records[0].nameSource,'verified-library-capture');
await assert.rejects(collectReviews(tabWith([]),{library:{source:'library',records:[]}}),/same account/);
const redirectedReview=await collectReviews(tabWith([
  {url:'https://steamcommunity.com/id/example/recommended/',path:'/id/example/recommended/',expected:2,rows:[{appid:1,reviewUrl:'r1'}],links:['https://steamcommunity.com/id/example/recommended/?p=2']},
  {url:'https://steamcommunity.com/id/example/recommended/',path:'/id/example/recommended/',expected:2,rows:[{appid:1,reviewUrl:'r1'}],links:[]}
]));
assert.equal(redirectedReview.diagnostics.pageAttempts,2);
assert.equal(redirectedReview.diagnostics.pagesPending,1);
assert.ok(redirectedReview.warnings.some(x=>x.includes('redirected')));
const replay=await collectReplay(tabWith([
  {year:2025,accountPath:'/replay/example',text:'activity',apps:[],links:['https://store.steampowered.com/replay/example/2024']},
  {year:2024,accountPath:'/replay/example',text:'activity',apps:[],links:[]}
]));
assert.deepEqual(replay.diagnostics.years,[2025,2024]);
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
assert.deepEqual((await collectReplay(loadingTab)).diagnostics.years,[2025]);
assert.equal(reads,2);

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
