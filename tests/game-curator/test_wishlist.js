// Development-only synthetic browser simulation. Node is not required by the skill.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../../skills/game-curator/scripts/steam-wishlist.js'), 'utf8');
const query = (key, data) => ({queryKey:[key], state:{data}});
async function run(queries, extra = {}, code = source) {
  const ctx = {location:{hostname:'store.steampowered.com',protocol:'https:'},
    window:{SSR:{renderContext:{queryData:{queries}}}}, Date, AbortSignal,
    setTimeout: fn => fn(), ...extra};
  return vm.runInNewContext(code, ctx);
}
(async () => {
  const result = await run([
    query('WishlistSortedFiltered', {items:[{appid:11,priority:2,date_added:123}, {appid:12}, {appid:11}]}),
    query('StoreItem', {store_item:{appid:11,name:'Synthetic Game'}})
  ]);
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].name, 'Synthetic Game');
  assert.equal(result.records[0].rank, 1);
  assert.equal(result.records[1].name, null);
  assert.equal(result.diagnostics.unresolvedAppids[0], 12);
  assert.equal(result.coverage, 'partial');
  await assert.rejects(run([]), /No recognized wishlist query/);
  await assert.rejects(run([], {location:{hostname:'example.invalid',protocol:'https:'}}), /Steam Store origin/);
  let calls = 0;
  const rateLimited = await run([query('WishlistSortedFiltered', {items:[{appid:11},{appid:12}]})],
    {fetch:async () => {calls++; return {status:429,ok:false};}}, source.replace('const resolveMissing = false;', 'const resolveMissing = true;'));
  assert.equal(calls, 1);
  assert.equal(rateLimited.records[0].lookupError, 'HTTP 429; rate limit');
  assert.equal(rateLimited.diagnostics.unresolvedAppids.length, 2);
  console.log('Synthetic wishlist collector checks passed');
})().catch(error => {console.error(error); process.exitCode = 1;});
