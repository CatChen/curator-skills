// Synthetic browser contract tests; Node is a development-only dependency.
import assert from 'node:assert/strict';
import {collectWishlist, collectLibrary, collectReviews, collectReplay} from '../../skills/game-curator/scripts/browser/steam.mjs';

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
const replay=await collectReplay(tabWith([
  {year:2025,accountPath:'/replay/example',text:'activity',apps:[],links:['https://store.steampowered.com/replay/example/2024']},
  {year:2024,accountPath:'/replay/example',text:'activity',apps:[],links:[]}
]));
assert.deepEqual(replay.diagnostics.years,[2025,2024]);
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
} finally {globalThis.document=oldDocument;globalThis.location=oldLocation;}
console.log('Synthetic browser orchestration checks passed');
