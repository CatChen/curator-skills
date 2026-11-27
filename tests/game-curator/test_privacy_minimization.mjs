// Data minimization: the saver validates review URLs and urlPath, then does not persist the profile path. Synthetic data, scratch home only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {collectReviews, collectLibrary} from '../../skills/game-curator/scripts/browser/steam.mjs';
import {pagePathFingerprint} from '../../skills/game-curator/scripts/browser/path-fingerprint.mjs';
import {minimizeForStorage} from '../../skills/game-curator/scripts/claude-code/save-capture.mjs';

const VANITY = 'syntheticvanity', STEAMID = '76561197960287930';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-privacy-'));
fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({version: 1, persistence: {profileAndFeedback: false, steamCache: true}}), {mode: 0o600});
const cli = fileURLToPath(new URL('../../skills/game-curator/scripts/claude-code/save-capture.mjs', import.meta.url));
const fake = data => ({playwright: {evaluate: async fn => fn === pagePathFingerprint ? 'a'.repeat(64) : structuredClone(data)}, scroll: async () => {}, goto: async () => {}});
const save = (capture, name) => {
  const input = path.join(root, name); fs.writeFileSync(input, JSON.stringify(capture), {mode: 0o600});
  return spawnSync(process.execPath, [cli, input, '--access-scope', 'unknown'], {encoding: 'utf8', env: {...process.env, CURATOR_HOME: root, HOME: root}});
};
try {
  for (const profile of [`id/${VANITY}`, `profiles/${STEAMID}`]) {
    fs.rmSync(path.join(root, 'cache'), {recursive: true, force: true});
    const list = `/${profile}/recommended`;
    const review = await collectReviews(fake({url: `https://steamcommunity.com${list}/`, path: `${list}/`, expected: 1, boxCount: 1, ownerControls: true,
      rows: [{appid: 7, reviewUrl: `https://steamcommunity.com${list}/7/`, recommended: true, review: 'Synthetic review text', playtimeDisplay: null, postedDate: null}], links: []}));
    // Input is still validated with the profile path present; a mismatching URL stays rejected.
    const foreign = structuredClone(review); foreign.records[0].reviewUrl = 'https://steamcommunity.com/id/other/recommended/7/';
    assert.notEqual(save(foreign, 'foreign.json').status, 0);
    const run = save(review, 'reviews.json');
    assert.equal(run.status, 0, run.stderr);
    const text = fs.readFileSync(path.join(root, 'cache/steam/reviews.json'), 'utf8');
    assert.ok(!text.includes(VANITY) && !text.includes(STEAMID) && !text.includes('steamcommunity.com'), 'profile path must not be persisted');
    const stored = JSON.parse(text);
    assert.equal(stored.records[0].appid, 7); assert.equal(stored.records[0].review, 'Synthetic review text');
    assert.ok(!('reviewUrl' in stored.records[0]) && !('urlPath' in stored.diagnostics));
    assert.deepEqual(stored.diagnostics.attestations.minimized.omitted, ['records[].reviewUrl']); // the Codex collector emits no urlPath
    // A second capture can replace the minimized snapshot (legacy-tolerant existing-cache check).
    const again = save(review, 'reviews2.json');
    assert.equal(again.status, 0, again.stderr); assert.equal(JSON.parse(again.stdout).action, 'replace');
  }
  // A page-script style envelope that carries urlPath on a non-review source loses it too; nothing else changes.
  const library = await collectLibrary(fake({expected: 1, view: {tab: 'all', search: 'empty', language: 'en'}, records: [{appid: 1, name: 'Fixture', pageText: 'Fixture\nDOWNLOAD', membershipSource: 'all-games-row'}]}));
  library.diagnostics.urlPath = `/id/${VANITY}/games`;
  const min = minimizeForStorage(library);
  assert.ok(!('urlPath' in min.diagnostics)); assert.deepEqual(min.records, library.records);
  assert.ok(library.diagnostics.urlPath, 'the input is not mutated');
  // The Claude Code page script also records the list path; both go.
  const both = minimizeForStorage({source: 'reviews', diagnostics: {urlPath: `/id/${VANITY}/recommended`}, records: [{appid: 1, reviewUrl: `https://steamcommunity.com/id/${VANITY}/recommended/1/`, review: 'x'}]});
  assert.ok(!JSON.stringify(both).includes(VANITY)); assert.deepEqual(both.diagnostics.attestations.minimized.omitted, ['diagnostics.urlPath', 'records[].reviewUrl']);
  // Nothing to omit: unchanged, with no attestation noise.
  assert.deepEqual(minimizeForStorage({source: 'wishlist', diagnostics: {}, records: []}), {source: 'wishlist', diagnostics: {}, records: []});
  console.log('privacy minimization ok');
} finally { fs.rmSync(root, {recursive: true, force: true}); }
