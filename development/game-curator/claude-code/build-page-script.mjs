#!/usr/bin/env node
// Generate the standalone page scripts (steam-<source>-page.js): each template with the shared Steam row semantics
// for its source (../browser/*-rows.mjs) and the source-independent page pieces (page-common.mjs) inlined, so one
// pasted expression and the Codex collector run the same extraction code. Deterministic; the test suite fails if a
// committed output is stale.
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {snapshotWishlist, mergeWishlistRow, toWishlistRecords} from '../../../skills/game-curator/scripts/browser/wishlist-rows.mjs';
import {snapshotLibrary, mergeLibraryRow, normalizeLibraryRecord, libraryLabelCount, libraryFieldsKey} from '../../../skills/game-curator/scripts/browser/library-rows.mjs';
import {snapshotReviews, reviewPageKey, queueReviewPages} from '../../../skills/game-curator/scripts/browser/review-rows.mjs';
import {snapshotReplay, dedupeReplayApps, replayYears} from '../../../skills/game-curator/scripts/browser/replay-rows.mjs';
import {b64uEncode, b64uDecode, canonicalSteamId64, accountIdMatches, fingerprintBytes, sha256HexOf, readSessionSources, observeIdentity} from '../../../skills/game-curator/scripts/browser/identity-probe.mjs';
import {sha256Hex, makeWaiter, deliverEnvelope, identityStep, identityOf, identityObsValid, identityStateValid} from './page-common.mjs';

const dir = new URL('.', import.meta.url);
export const PAGES = {
  wishlist: {functions: [snapshotWishlist, mergeWishlistRow, toWishlistRecords]},
  library: {functions: [snapshotLibrary, libraryLabelCount, libraryFieldsKey, mergeLibraryRow, normalizeLibraryRecord]},
  reviews: {functions: [snapshotReviews, reviewPageKey, queueReviewPages]},
  replay: {functions: [snapshotReplay, dedupeReplayApps, replayYears]},
  identity: {functions: []}, // standalone probe: only the identity functions (see buildPageScript)
};
const IDENTITY = [b64uEncode, b64uDecode, canonicalSteamId64, accountIdMatches, fingerprintBytes, sha256HexOf, readSessionSources, observeIdentity];
const COMMON = [...IDENTITY, sha256Hex, makeWaiter, identityStep, identityOf, identityObsValid, identityStateValid, deliverEnvelope];
const inline = fns => fns.map(f => '  ' + f.toString().replace(/\n/g, '\n  ')).join('\n').trimStart();

export function buildPageScript(name = 'wishlist') {
  if (!PAGES[name]) throw new Error(`unknown page script: ${name}`);
  const template = fs.readFileSync(new URL(`steam-${name}-page.template.js`, dir), 'utf8');
  for (const marker of ['/*@@SHARED@@*/', '/*@@COMMON@@*/']) if (!template.includes(marker)) throw new Error(`template marker missing: ${marker}`);
  return template.replace('/*@@SHARED@@*/', () => inline(PAGES[name].functions)).replace('/*@@COMMON@@*/', () => inline(name === 'identity' ? IDENTITY : COMMON));
}

// True only when this file is the process entry point, including when invoked through a symlink or a path
// with spaces (import.meta.url is the resolved file URL, argv[1] may be a symlinked path). Importing is side-effect free.
function isMain() {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; }
}

if (isMain()) {
  for (const name of Object.keys(PAGES)) {
    if (!fs.existsSync(new URL(`steam-${name}-page.template.js`, dir))) continue;
    fs.writeFileSync(new URL(`../../../skills/game-curator/scripts/claude-code/steam-${name}-page.js`, dir), buildPageScript(name));
    console.log(`wrote steam-${name}-page.js`);
  }
}
