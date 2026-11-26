#!/usr/bin/env node
// Generate steam-wishlist-page.js: the template with the shared row semantics from
// ../browser/wishlist-rows.mjs inlined, so the single pasted expression and the Codex collector run the
// same extraction code. Deterministic; the test suite fails if the committed output is stale.
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {snapshotWishlist, mergeWishlistRow, toWishlistRecords} from '../browser/wishlist-rows.mjs';

const dir = new URL('.', import.meta.url);
export function buildPageScript() {
  const template = fs.readFileSync(new URL('steam-wishlist-page.template.js', dir), 'utf8');
  const shared = [snapshotWishlist, mergeWishlistRow, toWishlistRecords].map(f => '  ' + f.toString().replace(/\n/g, '\n  ')).join('\n');
  if (!template.includes('/*@@SHARED@@*/')) throw new Error('template marker missing');
  return template.replace('/*@@SHARED@@*/', () => shared.trimStart());
}
// True only when this file is the process entry point, including when invoked through a symlink or a path
// with spaces (import.meta.url is the resolved file URL, argv[1] may be a symlinked path). Importing is side-effect free.
function isMain() {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; }
}

if (isMain()) {
  fs.writeFileSync(new URL('steam-wishlist-page.js', dir), buildPageScript());
  console.log('wrote steam-wishlist-page.js');
}
