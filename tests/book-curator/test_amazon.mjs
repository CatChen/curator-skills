import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanPage, assessPages, collectCategory} from '../../skills/book-curator/scripts/amazon/collector.mjs';
import {saveNewSnapshot} from '../../skills/book-curator/scripts/amazon/cache.mjs';

const row = (id, extra={}) => ({sourceId:id,sourceType:'KindleEBook',category:'books',title:'Synthetic',author:'Writer',dateLabel:'Acquired on a date',...extra});
const page = (start,end,total,rows,extra={}) => ({category:'books',range:[start,end,total],rows,pageNumbers:[1,2,3],...extra});
test('extracts category-specific fields from synthetic DOM, retaining unknowns', () => {
  const el = textContent => ({textContent});
  const details = {children:[{classList:{contains:()=>false}}, {classList:{contains:n=>n==='information_row'},textContent:'Author'}, {classList:{contains:n=>n==='information_row'},textContent:'2 MB'}],querySelector:q=>q === '.digital_entity_title_no_link' ? el('Document') : q.includes('content-acquired-date-') ? el('Created on today') : null};
  const fakeRow = {querySelector:q=>q.startsWith('input') ? {id:'DOC123:KindlePDoc'} : q === '.digital_entity_details' ? details : null};
  globalThis.location={hostname:'www.amazon.com',pathname:'/hz/mycd/digital-console/contentlist/pdocs/dateDsc'};
  globalThis.document={querySelector:q=>q==='#CONTENT_COUNT'?el('Showing 1 to 1 of 1 items'):null,querySelectorAll:q=>q.startsWith('tr[')?[fakeRow]:[]};
  const actual=scanPage(); assert.deepEqual(actual.rows[0],{sourceId:'DOC123',sourceType:'KindlePDoc',category:'docs',title:'Document',author:'Author',dateLabel:'Created on today',sizeLabel:'2 MB',sample:null,readLabel:null});
  globalThis.location.hostname='example.com'; assert.equal(scanPage().category,null);
  delete globalThis.document; delete globalThis.location;
});
test('validates ranges and keeps duplicates and missing IDs instead of silent merge',()=>{
  let good=assessPages([page(1,2,3,[row('1'),row('2')]),page(3,3,3,[row('3')])],'books');
  assert.equal(good.coverage,'complete-observed'); assert.equal(good.diagnostics.uniqueCount,3);
  let bad=assessPages([page(1,2,4,[row('1'),row('1')]),page(4,4,4,[row(null)])],'books');
  assert.equal(bad.coverage,'partial'); assert.equal(bad.records.length,3); assert.equal(bad.diagnostics.duplicateCount,1); assert.equal(bad.diagnostics.missingIds,1);
  assert.ok(bad.warnings.some(w=>w.includes('gaps')));
  assert.equal(assessPages([page(1,1,1,[row('1',{author:null})])],'books').coverage,'partial');
});
test('numbered pages advance and failure retains captured batches',async()=>{
  let i=0; const pages=[page(1,1,2,[row('1')]),page(2,2,2,[row('2')])];
  const tab={playwright:{evaluate:async()=>pages[i],locator:s=>({click:async()=>{assert.equal(s,'#page-2');i++;}})}};
  const result=await collectCategory(tab,'books'); assert.equal(result.coverage,'complete-observed');
  i=0; tab.playwright.locator=()=>({click:async()=>{throw new Error('private details');}});
  const partial=await collectCategory(tab,'books'); assert.equal(partial.records.length,1); assert.equal(partial.coverage,'partial'); assert.ok(!partial.warnings.join().includes('private details'));
});
test('waits for coherent settled pages and stops on challenge without clicking',async()=>{
  const first=page(1,1,2,[row('1')]); const mismatch=page(2,2,2,[]); const second=page(2,2,2,[row('2')]);
  let scans=[first,first,first,mismatch,second,second], clicks=0;
  const tab={playwright:{evaluate:async()=>scans.shift() ?? second,locator:()=>({click:async()=>{clicks++;}})}};
  const result=await collectCategory(tab,'books',{settleDelayMs:0}); assert.equal(result.coverage,'complete-observed'); assert.equal(clicks,1);
  scans=[first,first,{category:null,challenge:true}]; clicks=0;
  const challenged=await collectCategory(tab,'books',{settleDelayMs:0}); assert.equal(challenged.coverage,'partial'); assert.equal(challenged.records.length,1); assert.equal(clicks,0); assert.ok(challenged.warnings.some(w=>w.includes('verification')));
});
test('repeated page and missing pre-click range never trigger a blind click',async()=>{
  const first=page(1,1,2,[row('1')]); let scans=[first,first,{...first,range:null}],clicks=0;
  const tab={playwright:{evaluate:async()=>scans.shift() ?? first,locator:()=>({click:async()=>{clicks++;}})}};
  const stopped=await collectCategory(tab,'books',{settleDelayMs:0}); assert.equal(stopped.coverage,'partial'); assert.equal(clicks,0);
  scans=[first,first,first]; const repeated=await collectCategory(tab,'books',{settleAttempts:3,settleDelayMs:0}); assert.equal(repeated.coverage,'partial'); assert.equal(repeated.records.length,1); assert.equal(clicks,1);
});
test('cache requires consent and never replaces an existing richer file',async()=>{
  let dir=await mkdtemp(join(tmpdir(),'book-cache-test-')); try {
    let path=join(dir,'cache.json'); const capture=assessPages([page(1,1,1,[row('1')])],'books');
    await assert.rejects(saveNewSnapshot(path,capture),/authorization/);
    await saveNewSnapshot(path,capture,{rawCacheAuthorized:true}); assert.equal((await stat(path)).mode & 0o777,0o600);
    let before=await readFile(path,'utf8'); let partial=assessPages([page(1,1,2,[row('1')])],'books','interrupted');
    await assert.rejects(saveNewSnapshot(path,partial,{rawCacheAuthorized:true}),{code:'EEXIST'}); assert.equal(await readFile(path,'utf8'),before);
  } finally {await rm(dir,{recursive:true,force:true});}
});
