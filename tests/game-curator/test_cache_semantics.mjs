import assert from 'node:assert/strict';
import {equivalentRecords, textCoverageLost} from '../../skills/game-curator/scripts/cache-semantics.mjs';
const capture = (source, records) => ({source, records});
const library = capture('library', [{appid: 1, name: 'A', hours: 2, achievements: {unlocked: 1, total: 5}, pageText: 'A\nTOTAL PLAYED\n2 hours\nDOWNLOAD\n12 GB'}]);
const other = structuredClone(library); other.records[0].pageText = 'A\nTOTAL PLAYED\n2 hours\nUNINSTALL\n8 GB';
assert.equal(equivalentRecords(library, other), true);
other.records[0].hours = 3; assert.equal(equivalentRecords(library, other), false);
other.records[0].hours = 2; other.records[0].pageText += '\nnew unknown evidence'; assert.equal(equivalentRecords(library, other), false);
const wa = capture('wishlist', [{appid: 1, rank: 1, pageText: 'Game\nADD TO CART'}]);
const wb = capture('wishlist', [{appid: 1, rank: 1, pageText: 'Game\nIN CART'}]);
assert.equal(equivalentRecords(wa, wb), true);
wb.records[0].pageText += '\nnew review'; assert.equal(equivalentRecords(wa, wb), false);
for (const [source, record, field, changed] of [
  ['wishlist', {appid: 1, rank: 1, pageText: 'release date'}, 'rank', 2],
  ['reviews', {appid: 1, review: 'good'}, 'review', 'bad'],
  ['replay', {year: 2025, semanticText: 'games played: 3', apps: []}, 'semanticText', 'games played: 4'],
]) {
  const a = capture(source, [record]), b = structuredClone(a); b.records[0][field] = changed;
  assert.equal(equivalentRecords(a, b), false);
}
assert.equal(equivalentRecords(capture('library', [{appid: 1}, {appid: 2}]), capture('library', [{appid: 2}, {appid: 1}])), true);
assert.equal(equivalentRecords(capture('unknown', []), capture('unknown', [])), false);
console.log('cache semantics tests passed');

assert.equal(textCoverageLost('wishlist', 'Game\nDetailed description and price $20', 'Game'), true);
assert.equal(textCoverageLost('wishlist', 'Game\nPrice $20', 'Game\nPrice $21'), false);
assert.equal(textCoverageLost('replay', 'Games played: 4\nAnnual achievements: 12', 'Games played: 4'), true);
assert.equal(textCoverageLost('wishlist', 'A lengthy description and price $20', 'A lengthy description and price'), true);
assert.equal(textCoverageLost('reviews', 'This was a very memorable game with a wonderful ending', 'This was a very memorable game with a wonderful'), true);
assert.equal(textCoverageLost('reviews', 'This was a very memorable game with a wonderful ending', 'This was a very memorable game...'), true);
assert.equal(textCoverageLost('wishlist', 'OVERALL REVIEWS: 100', 'ENGLISH REVIEWS: 100'), true);
