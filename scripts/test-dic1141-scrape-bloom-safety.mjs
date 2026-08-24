#!/usr/bin/env node
// DIC-1141 CR blockers — Bloom Level scraper + overlay-loader safety.
//
// The first pass shipped a scrape script that silently deleted the canonical
// overlay when either (a) run with `--only=<series> --force`, or (b) run on a
// bad network day, and a build-database loader that swallowed that empty file
// and republished the "every Holomen looks the same" bug. These tests lock
// those failure modes closed:
//
//   1. mergeResults preserves everything OUT OF SCOPE of a partial run —
//      `--only=hBP04 --force` cannot touch hBP05.
//   2. mergeResults preserves entries whose fetch failed — a network glitch
//      cannot wipe hBP04-026.
//   3. mergeResults preserves entries whose fetch returned no level — a
//      one-off official-page render glitch cannot silently strip the record.
//   4. evaluateCoverage rejects a batch that drops coverage or that failed
//      most fetches, so the CLI exits non-zero WITHOUT publishing.
//   5. writeOverlayAtomically writes to a temp path then renames — the final
//      file is never observed half-written.
//   6. build-database's loadBloomLevelOverlay is fail-CLOSED: missing file,
//      malformed JSON, invalid level, or coverage below floor all throw.
//   7. Palette collision guard: the three badge palettes (Bloom / category /
//      printing rarity) are pairwise disjoint at the hex level, and each
//      screen file uses PRINTING_RARITY_COLORS as its single source.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseBloomLevel,
  collectHolomenTargets,
  mergeResults,
  evaluateCoverage,
  buildPayload,
  writeOverlayAtomically,
  readOverlay,
  VALID_LEVELS,
} from './scrape-bloom-levels.mjs';
import { validateBloomOverlay, VALID_BLOOM_LEVELS } from './build-database.js';
import {
  BLOOM_LEVEL_COLORS,
  CATEGORY_COLORS,
  PRINTING_RARITY_COLORS,
  findBadgePaletteCollisions,
} from '../src/utils/cardNormalization.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// ── 0. parseBloomLevel accepts only the five valid levels ────────────────

for (const level of VALID_LEVELS) {
  assert.equal(parseBloomLevel(`<dt>Bloomレベル</dt><dd>${level}</dd>`), level, `parses ${level}`);
}
assert.equal(parseBloomLevel('<dt>Bloomレベル</dt><dd>Unknown</dd>'), null, 'rejects unknown values');
assert.equal(parseBloomLevel('<dt>カードタイプ</dt><dd>推しホロメン</dd>'), null, 'no Bloomレベル tag → null');
assert.equal(parseBloomLevel(''), null, 'empty html → null');
assert.equal(parseBloomLevel(null), null, 'non-string → null');

// ── 1. Partial --only NEVER touches out-of-scope canonical entries ───────

{
  const existing = {
    'hBP04-026': '2nd',   // in scope
    'hBP04-028': 'Debut', // in scope
    'hBP05-001': 'Debut', // OUT of scope — must survive untouched
    'hBP06-042': '1st',   // OUT of scope — must survive untouched
  };
  const inScope = new Set(['hBP04-026', 'hBP04-028']);
  const fresh = new Map([
    ['hBP04-026', { level: '2nd' }],
    ['hBP04-028', { level: 'Debut' }],
  ]);
  const { merged, stats, detail } = mergeResults({ existing, inScope, fresh });
  assert.equal(merged['hBP05-001'], 'Debut', 'out-of-scope hBP05 preserved');
  assert.equal(merged['hBP06-042'], '1st', 'out-of-scope hBP06 preserved');
  assert.equal(stats.preservedOutOfScope, 2, 'stats count out-of-scope preservations');
  assert.deepEqual(detail.preservedOutOfScope.sort(), ['hBP05-001', 'hBP06-042']);
  assert.equal(stats.mergedCount, 4, 'merged carries all four cards');
}

// ── 2. Fetch failure MUST NOT wipe an existing canonical entry ───────────

{
  const existing = { 'hBP04-026': '2nd', 'hBP04-027': '1st' };
  const inScope = new Set(['hBP04-026', 'hBP04-027']);
  const fresh = new Map([
    ['hBP04-026', { level: null, error: 'ECONNRESET' }],   // network flake
    ['hBP04-027', { level: '1st' }],                        // succeeded
  ]);
  const { merged, stats, detail } = mergeResults({ existing, inScope, fresh });
  assert.equal(merged['hBP04-026'], '2nd', 'fetch failure preserves prior value');
  assert.equal(merged['hBP04-027'], '1st', 'successful fetch keeps its value');
  assert.deepEqual(detail.preservedOnFailure, ['hBP04-026']);
  assert.equal(stats.preservedOnFailure, 1);
  assert.equal(stats.overwritten, 0);
}

// ── 3. Parse returning null MUST NOT wipe (default posture) ──────────────

{
  const existing = { 'hBP04-026': '2nd' };
  const inScope = new Set(['hBP04-026']);
  const fresh = new Map([['hBP04-026', { level: null }]]); // page rendered without the field
  const { merged, stats } = mergeResults({ existing, inScope, fresh });
  assert.equal(merged['hBP04-026'], '2nd', 'null level does not strip the record');
  assert.equal(stats.preservedOnFailure, 1);
}

// ── 4. Coverage guard rejects abnormal drops / failure ratios ────────────

{
  // Healthy run: no drop, low failure ratio → ok.
  const ok = evaluateCoverage({
    priorCount: 316, mergedCount: 316, inScope: 40, freshCount: 40,
    fetchFailures: 0, fetchSuccesses: 40,
  });
  assert.equal(ok.ok, true, 'healthy run passes guard');

  // Coverage dropped by 1 without opt-in → refuse.
  const drop = evaluateCoverage({
    priorCount: 316, mergedCount: 315, inScope: 40, freshCount: 40,
    fetchFailures: 0, fetchSuccesses: 40,
  });
  assert.equal(drop.ok, false, 'coverage drop refused');
  assert.match(drop.reasons[0], /coverage dropped/, 'reason names the drop');

  // Same drop, with --allow-coverage-drop → ok.
  const dropAllowed = evaluateCoverage({
    priorCount: 316, mergedCount: 315, inScope: 40, freshCount: 40,
    fetchFailures: 0, fetchSuccesses: 40, allowCoverageDrop: true,
  });
  assert.equal(dropAllowed.ok, true, 'coverage drop accepted with opt-in');

  // High fetch-failure ratio → refuse.
  const failRatio = evaluateCoverage({
    priorCount: 316, mergedCount: 316, inScope: 40, freshCount: 40,
    fetchFailures: 20, fetchSuccesses: 20,
  });
  assert.equal(failRatio.ok, false, 'high failure ratio refused');
  assert.ok(failRatio.reasons.some((r) => /failure ratio/i.test(r)));

  // Zero successes with failures → refuse (origin outage).
  const outage = evaluateCoverage({
    priorCount: 316, mergedCount: 316, inScope: 40, freshCount: 40,
    fetchFailures: 40, fetchSuccesses: 0,
  });
  assert.equal(outage.ok, false, 'zero successes refused');
}

// ── 5. Atomic write: temp file, then rename ──────────────────────────────

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bloom-atomic-'));
  const target = path.join(dir, 'bloom-levels.json');
  writeOverlayAtomically(target, buildPayload({ 'hBP04-026': '2nd' }));
  const rt = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(rt.byCardNumber['hBP04-026'], '2nd');
  assert.ok(rt.totalCards === 1);
  // No .tmp files left behind.
  assert.ok(fs.readdirSync(dir).every((f) => !f.endsWith('.tmp')), 'no temp residue');
  fs.rmSync(dir, { recursive: true, force: true });
}

// readOverlay round-trips + drops invalid entries defensively.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bloom-read-'));
  const target = path.join(dir, 'bloom-levels.json');
  fs.writeFileSync(target, JSON.stringify({
    byCardNumber: { 'hBP04-026': '2nd', 'hBP04-999': 'Weird', 42: '1st' },
  }));
  const round = readOverlay(target);
  assert.equal(round['hBP04-026'], '2nd');
  assert.equal(round['hBP04-999'], undefined, 'invalid level dropped');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 6. build-database.js overlay validator is fail-closed ───────────────

{
  // Reject non-object payloads.
  assert.equal(validateBloomOverlay(null).ok, false);
  assert.equal(validateBloomOverlay([]).ok, false);
  assert.equal(validateBloomOverlay({}).ok, false, 'missing byCardNumber');
  // Reject invalid levels.
  const bad = validateBloomOverlay({ byCardNumber: { 'hBP04-026': 'HR' } }, { minCoverage: 1 });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /invalid/i);
  // Reject coverage below floor.
  const shrunk = validateBloomOverlay({ byCardNumber: { 'hBP04-026': '2nd' } }, { minCoverage: 300 });
  assert.equal(shrunk.ok, false);
  assert.match(shrunk.reason, /coverage/i);
  // Accept a valid, sufficient payload.
  const big = { byCardNumber: {} };
  for (let i = 0; i < 305; i++) big.byCardNumber[`hBP00-${String(i).padStart(3, '0')}`] = 'Debut';
  const okCheck = validateBloomOverlay(big, { minCoverage: 300 });
  assert.equal(okCheck.ok, true);
  assert.equal(okCheck.count, 305);
  // The exported constants match between the two modules — no drift.
  assert.deepEqual([...VALID_LEVELS], [...VALID_BLOOM_LEVELS]);
}

// ── 7. Palette collision guard — three sets, pairwise disjoint ──────────

{
  const collisions = findBadgePaletteCollisions();
  assert.deepEqual(collisions, [], `badge palettes must be pairwise disjoint but got: ${JSON.stringify(collisions)}`);
  // Explicitly assert the CR-blocker case: Holomen category ≠ printing rarity R.
  assert.notEqual(CATEGORY_COLORS.holomen.toLowerCase(), PRINTING_RARITY_COLORS.R.toLowerCase(),
    'CATEGORY_COLORS.holomen must not equal PRINTING_RARITY_COLORS.R (Codex-flagged collision)');
  // No palette drifted below expected size — a sneaky merge that emptied one
  // trivially satisfies "disjoint" but leaves the UI unpainted.
  assert.equal(Object.keys(BLOOM_LEVEL_COLORS).length, 5);
  assert.equal(Object.keys(CATEGORY_COLORS).length, 5);
  assert.equal(Object.keys(PRINTING_RARITY_COLORS).length, 5);
}

// UI files use the shared PRINTING_RARITY_COLORS source, not a local copy.
{
  const searchSrc = fs.readFileSync(path.join(REPO, 'src', 'screens', 'SearchResultsScreen.tsx'), 'utf8');
  const detailSrc = fs.readFileSync(path.join(REPO, 'src', 'screens', 'CardDetailScreen.tsx'), 'utf8');
  assert.match(searchSrc, /PRINTING_RARITY_COLORS/, 'SearchResults imports PRINTING_RARITY_COLORS');
  assert.match(detailSrc, /PRINTING_RARITY_COLORS/, 'CardDetail imports PRINTING_RARITY_COLORS');
  // No local hardcoded rarity map with '#3b82f6' can drift the palette back.
  assert.doesNotMatch(searchSrc, /rarityColors\s*:\s*Record<string,\s*string>\s*=\s*\{[^}]*'#3b82f6'/,
    'SearchResults must not hardcode the rarity palette locally');
  assert.doesNotMatch(detailSrc, /rarityColors\s*:\s*Record<string,\s*string>\s*=\s*\{[^}]*'#3b82f6'/,
    'CardDetail must not hardcode the rarity palette locally');
}

// ── 8. Integration: collectHolomenTargets honours --only ────────────────

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bloom-collect-'));
  fs.writeFileSync(path.join(dir, 'hBP04.json'), JSON.stringify([
    { cardNumber: 'hBP04-026', id: '888', expansion: 'hBP04', cardType: 'ホロメン' },
    { cardNumber: 'hBP04-001', id: '861', expansion: 'hBP04', cardType: '推しホロメン' }, // Oshi, skipped
  ]));
  fs.writeFileSync(path.join(dir, 'hBP05.json'), JSON.stringify([
    { cardNumber: 'hBP05-050', id: '999', expansion: 'hBP05', cardType: 'ホロメン' },
  ]));
  const all = collectHolomenTargets({ officialDir: dir });
  assert.deepEqual([...all.keys()].sort(), ['hBP04-026', 'hBP05-050']);
  const onlyBP04 = collectHolomenTargets({ officialDir: dir, only: 'hBP04' });
  assert.deepEqual([...onlyBP04.keys()], ['hBP04-026']);
  const onlyBP05 = collectHolomenTargets({ officialDir: dir, only: 'hBP05' });
  assert.deepEqual([...onlyBP05.keys()], ['hBP05-050']);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('DIC-1141 scrape-bloom safety + palette-collision regression checks passed');
