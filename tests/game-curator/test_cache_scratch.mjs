// End-to-end scratch-cache acceptance. All paths are synthetic and private.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {selectSnapshots} from '../../skills/game-curator/scripts/cache.mjs';
const cli = fileURLToPath(new URL('../../skills/game-curator/scripts/claude-code/save-capture.mjs', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-lifecycle-'));
const dest = path.join(root, 'cache', 'steam');
fs.mkdirSync(dest, {recursive: true, mode: 0o700});
fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({version: 1, persistence: {profileAndFeedback: false, steamCache: true}}), {mode: 0o600});
const records = [{appid: 12345, rank: 1, name: 'Synthetic game', pageText: 'Synthetic game\nRELEASE DATE:\n2025', membershipSource: 'wishlist-row'}];
const capture = (at, rows) => ({format: 'game-curator-steam-export', version: 1, source: 'wishlist', capturedAt: at, method: 'browser-dom-claude-code', coverage: 'partial', warnings: [], diagnostics: {expectedCount: rows.length, uniqueCount: rows.length, ranksObserved: rows.length, placeholderNameRows: 0, complete: true, stopReason: 'complete', reorderHandles: true, view: {sort: 'Your Rank', search: 'empty', filters: 'unknown'}, recordsSha256: crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex')}, accessScope: 'unknown', records: rows});
function run(at, rows, expected) {
  const input = path.join(root, 'capture.json');
  fs.writeFileSync(input, JSON.stringify([{type: 'text', text: JSON.stringify(capture(at, rows))}]), {mode: 0o600});
  const args = [cli, input, '--dest', dest, '--account', 'synthetic', '--access-scope', 'signed-in', '--view', 'unfiltered', '--provenance', 'tool-result'];
  const dry = spawnSync(process.execPath, [...args, '--dry-run'], {encoding: 'utf8'});
  assert.equal(dry.status, 0, dry.stderr);
  const proposal = JSON.parse(dry.stdout);
  for (const target of [proposal.target, proposal.backup].filter(Boolean)) {
    assert.equal(fs.realpathSync(path.dirname(target)), fs.realpathSync(dest), 'dry-run target must be inside the scratch cache');
    if (fs.existsSync(target)) assert.equal(fs.realpathSync(path.dirname(fs.realpathSync(target))), fs.realpathSync(dest), 'existing target must not escape by symlink');
  }
  assert.equal(proposal.action, expected);
  const actual = spawnSync(process.execPath, args, {encoding: 'utf8'});
  assert.equal(actual.status, 0, actual.stderr);
  const result = JSON.parse(actual.stdout);
  assert.equal(result.action, expected);
  assert.equal(result.target, proposal.target);
  return result;
}
try {
  run('2026-01-01T00:00:00Z', records, 'create');
  const before = fs.readdirSync(dest).sort();
  run('2026-01-02T00:00:00Z', records, 'refresh');
  assert.deepEqual(fs.readdirSync(dest).sort(), before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dest, 'wishlist.json'))).capturedAt, '2026-01-02T00:00:00Z');
  const changed = [{...records[0], pageText: 'Synthetic game\nRELEASE DATE:\n2026'}];
  const replacement = run('2026-01-03T00:00:00Z', changed, 'replace');
  assert.ok(replacement.backup);
  const legacy = path.join(dest, 'wishlist.superseded.20200101T000000Z.json');
  fs.writeFileSync(legacy, 'legacy evidence');
  for (let i = 4; i <= 7; i++) {
    const nextRows = [{...records[0], pageText: `Synthetic game\nRELEASE DATE:\n20${i}`}];
    run(`2026-01-0${i}T00:00:00Z`, nextRows, 'replace');
  }
  const backups = fs.readdirSync(dest).filter(n => n.startsWith('wishlist.managed-v1.superseded.')).sort();
  assert.equal(backups.length, 2);
  assert.match(backups[0], /^wishlist\.managed-v1\.superseded\.20260105T000000Z-[a-f0-9]{12}\.json$/);
  assert.match(backups[1], /^wishlist\.managed-v1\.superseded\.20260106T000000Z-[a-f0-9]{12}\.json$/);
  assert.equal(fs.readFileSync(legacy, 'utf8'), 'legacy evidence');
  const current = JSON.parse(fs.readFileSync(path.join(dest, 'wishlist.json'), 'utf8'));
  const legacyCapture = {...current, method: 'browser-dom', account: undefined, diagnostics: {expectedCount: 1, uniqueCount: 1}};
  const selection = selectSnapshots([legacyCapture, current], {source: 'wishlist', account: 'synthetic', accessScope: 'signed-in'});
  assert.equal(selection.selected.capturedAt, current.capturedAt);
  assert.equal(selection.supporting.length, 1);
  assert.match(selection.supporting[0].reasons.join(' '), /identity|view/);
  const poorer = structuredClone(current);
  poorer.capturedAt = '2026-01-09T00:00:00Z';
  poorer.records[0].pageText = 'Synthetic game';
  poorer.diagnostics.recordsSha256 = crypto.createHash('sha256').update(JSON.stringify(poorer.records)).digest('hex');
  const withPoorer = selectSnapshots([poorer, current], {source: 'wishlist', account: 'synthetic', accessScope: 'signed-in'});
  assert.equal(withPoorer.selected.capturedAt, current.capturedAt);
  assert.match(withPoorer.supporting[0].reasons.join(' '), /lose fields/);
  const codex = {...capture('2026-01-08T00:00:00Z', records), method: 'browser-dom', diagnostics: {expectedCount: 1, uniqueCount: 1, ranksObserved: 1, placeholderNameRows: 0}};
  const codexFile = path.join(root, 'codex.json');
  fs.writeFileSync(codexFile, JSON.stringify(codex), {mode: 0o600});
  const codexArgs = [cli, codexFile, '--dest', dest, '--access-scope', 'unknown', '--provenance', 'host-result'];
  const codexDry = spawnSync(process.execPath, [...codexArgs, '--dry-run'], {encoding: 'utf8'});
  assert.equal(codexDry.status, 0, codexDry.stderr);
  const codexPlan = JSON.parse(codexDry.stdout);
  assert.equal(codexPlan.action, 'separate');
  assert.equal(fs.realpathSync(path.dirname(codexPlan.target)), fs.realpathSync(dest));
  const codexSave = spawnSync(process.execPath, codexArgs, {encoding: 'utf8'});
  assert.equal(codexSave.status, 0, codexSave.stderr);
  assert.equal(JSON.parse(codexSave.stdout).target, codexPlan.target);
  assert.equal(JSON.parse(fs.readFileSync(codexPlan.target)).diagnostics.complete, undefined);
  console.log('scratch cache checks passed');
} finally { fs.rmSync(root, {recursive: true, force: true}); }
