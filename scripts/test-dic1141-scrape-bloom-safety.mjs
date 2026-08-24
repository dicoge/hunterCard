#!/usr/bin/env node
// DIC-1141 CR blockers — Bloom Level scraper + overlay-loader safety.
//
// The initial fix shipped a scraper that silently deleted the canonical
// overlay when either (a) run with `--only=<series> --force`, or (b) run on a
// bad network day, and a build-database loader that swallowed that empty file
// and republished the "every Holomen looks the same" bug. Follow-up CRs then
// caught two more silent-corruption modes:
//   * every fetch returned HTTP 200 but the official markup dropped the
//     Bloomレベル tag → guard counted them as "successes", writer refreshed
//     `lastUpdated` with prior values (Codex CR blocker #1).
//   * the existing-overlay reader was lenient — invalid entries got silently
//     dropped, so a partial `--only + --force` write could delete them
//     (Codex CR blocker #2).
//   * `BLOOM_MIN_COVERAGE=NaN` or a negative number sailed past the coverage
//     guard entirely (Codex CR supplement).
//
// These tests lock every one of those failure modes closed:
//
//   1. mergeResults preserves OUT-OF-SCOPE and preserves FETCH-FAILED cards.
//   2. mergeResults preserves cards whose fetch succeeded but returned null.
//   3. evaluateCoverage refuses zero-hit / high-miss-ratio / high-failure /
//      coverage-drop batches; `--allow-coverage-drop` opts out only of the
//      coverage-drop leg.
//   4. writeOverlayAtomically writes via temp+rename with no residue.
//   5. readOverlayStrict THROWS on missing `byCardNumber`, non-object shape,
//      invalid keys / levels, or a totalCards mismatch (no silent drops).
//   6. decidePublication returns { shouldWrite:false } for every abnormal
//      batch, proving the atomic writer is never called on failure.
//   7. build-database.js's loadBloomLevelOverlay is fail-CLOSED (missing,
//      malformed, invalid, under-covered) and `coerceBloomMinCoverage`
//      rejects NaN / negative / non-integer BLOOM_MIN_COVERAGE.
//   8. Palette collision guard: three badge palettes pairwise disjoint at hex
//      level, each screen uses PRINTING_RARITY_COLORS as its single source.

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
  readOverlayStrict,
  decidePublication,
  VALID_LEVELS,
  DEFAULT_MAX_PARSE_MISS_RATIO,
} from './scrape-bloom-levels.mjs';
import { validateBloomOverlay, coerceBloomMinCoverage, VALID_BLOOM_LEVELS } from './build-database.js';
import {
  isCanonicalCardNumber,
  assertCanonicalCardNumber,
  CANONICAL_CARD_NUMBER_RE,
} from './lib/card-number.js';
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
    ['hBP04-026', { level: null, error: 'ECONNRESET' }],
    ['hBP04-027', { level: '1st' }],
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
  const fresh = new Map([['hBP04-026', { level: null }]]);
  const { merged, stats } = mergeResults({ existing, inScope, fresh });
  assert.equal(merged['hBP04-026'], '2nd', 'null level does not strip the record');
  assert.equal(stats.preservedOnFailure, 1);
}

// ── 4. Coverage / parse / failure guards — every mutation-sensitive branch ──

{
  // Healthy: passes.
  assert.equal(evaluateCoverage({
    priorCount: 316, mergedCount: 316,
    parseHits: 40, parseMisses: 0, fetchFailures: 0,
  }).ok, true, 'healthy run passes guard');

  // 4a. All-HTTP-200 with zero valid parses (schema-break). The prior guard
  //     summed hits+misses into "successes" and let this slip through — the
  //     regression that Codex flagged.
  const zeroHit = evaluateCoverage({
    priorCount: 316, mergedCount: 316,
    parseHits: 0, parseMisses: 316, fetchFailures: 0,
  });
  assert.equal(zeroHit.ok, false, 'zero valid parses refused');
  assert.ok(zeroHit.reasons.some((r) => /zero valid Bloom parses|schema/i.test(r)),
    `zero-hit reason mentions schema, got ${JSON.stringify(zeroHit.reasons)}`);

  // 4b. Excessive parse-miss ratio (partial schema break).
  const highMiss = evaluateCoverage({
    priorCount: 316, mergedCount: 316,
    parseHits: 100, parseMisses: 20, fetchFailures: 0, // 16.7% miss vs default 5%
  });
  assert.equal(highMiss.ok, false, 'high miss ratio refused');
  assert.ok(highMiss.reasons.some((r) => /parse-miss ratio/i.test(r)));

  // Just below the miss threshold: passes.
  const belowMiss = evaluateCoverage({
    priorCount: 316, mergedCount: 316,
    parseHits: 100, parseMisses: 4, fetchFailures: 0, // 3.8% miss < 5%
  });
  assert.equal(belowMiss.ok, true, 'sub-threshold miss ratio passes');

  // 4c. --allow-coverage-drop opts out only of the coverage-drop leg,
  //     not of the schema-break / high-miss / high-failure legs.
  const dropStillBroken = evaluateCoverage({
    priorCount: 316, mergedCount: 315,
    parseHits: 0, parseMisses: 40, fetchFailures: 0,
    allowCoverageDrop: true,
  });
  assert.equal(dropStillBroken.ok, false,
    'coverage-drop opt-in must NOT waive the zero-hit schema-break guard');
  assert.ok(dropStillBroken.reasons.some((r) => /zero valid Bloom parses/i.test(r)));

  // Coverage drop alone: refuse without opt-in, accept with opt-in.
  assert.equal(evaluateCoverage({
    priorCount: 316, mergedCount: 315,
    parseHits: 40, parseMisses: 0, fetchFailures: 0,
  }).ok, false, 'coverage drop refused');
  assert.equal(evaluateCoverage({
    priorCount: 316, mergedCount: 315,
    parseHits: 40, parseMisses: 0, fetchFailures: 0,
    allowCoverageDrop: true,
  }).ok, true, 'coverage drop accepted with opt-in');

  // 4d. Fetch failure ratio.
  const highFail = evaluateCoverage({
    priorCount: 316, mergedCount: 316,
    parseHits: 20, parseMisses: 0, fetchFailures: 20, // 50% failure vs default 10%
  });
  assert.equal(highFail.ok, false, 'high fetch-failure ratio refused');
  assert.ok(highFail.reasons.some((r) => /fetch failure ratio/i.test(r)));

  // 4e. Origin outage — every attempt failed, no parse attempts at all.
  const outage = evaluateCoverage({
    priorCount: 316, mergedCount: 316,
    parseHits: 0, parseMisses: 0, fetchFailures: 40,
  });
  assert.equal(outage.ok, false, 'origin outage refused');
  assert.ok(outage.reasons.some((r) => /origin outage/i.test(r)));

  // Sanity: the default parse-miss threshold is exported and reasonable.
  assert.ok(DEFAULT_MAX_PARSE_MISS_RATIO > 0 && DEFAULT_MAX_PARSE_MISS_RATIO < 1);
}

// ── 5. Atomic write: temp file, then rename ──────────────────────────────

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bloom-atomic-'));
  const target = path.join(dir, 'bloom-levels.json');
  writeOverlayAtomically(target, buildPayload({ 'hBP04-026': '2nd' }));
  const rt = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(rt.byCardNumber['hBP04-026'], '2nd');
  assert.equal(rt.totalCards, 1);
  assert.ok(fs.readdirSync(dir).every((f) => !f.endsWith('.tmp')), 'no temp residue');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 6. readOverlayStrict — every failure mode THROWS (no silent drops) ──

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bloom-strict-'));
  const p = path.join(dir, 'bloom-levels.json');

  // Missing file → present:false (virgin scrape scenario).
  const virgin = readOverlayStrict(p);
  assert.equal(virgin.present, false);
  assert.deepEqual(virgin.byCardNumber, {});

  // Non-object → throws.
  fs.writeFileSync(p, JSON.stringify([1, 2, 3]));
  assert.throws(() => readOverlayStrict(p), /top-level.*JSON object/);

  // Missing byCardNumber → throws.
  fs.writeFileSync(p, JSON.stringify({ totalCards: 1 }));
  assert.throws(() => readOverlayStrict(p), /byCardNumber/);

  // byCardNumber is a non-object.
  fs.writeFileSync(p, JSON.stringify({ byCardNumber: 'nope' }));
  assert.throws(() => readOverlayStrict(p), /non-null object/);

  // Invalid level → throws (never silently dropped).
  fs.writeFileSync(p, JSON.stringify({
    byCardNumber: { 'hBP04-026': '2nd', 'hBP05-001': 'HR' },
  }));
  assert.throws(() => readOverlayStrict(p), /invalid Bloom Level/);

  // totalCards mismatch → throws.
  fs.writeFileSync(p, JSON.stringify({
    totalCards: 3,
    byCardNumber: { 'hBP04-026': '2nd', 'hBP04-027': '1st' },
  }));
  assert.throws(() => readOverlayStrict(p), /totalCards.*does not match/);

  // totalCards negative → throws (defensive against hand-edits).
  fs.writeFileSync(p, JSON.stringify({
    totalCards: -1,
    byCardNumber: { 'hBP04-026': '2nd' },
  }));
  assert.throws(() => readOverlayStrict(p), /totalCards must be a non-negative integer/);

  // Malformed JSON → throws.
  fs.writeFileSync(p, '{not json');
  assert.throws(() => readOverlayStrict(p), /JSON parse failed/);

  // Valid payload → returns present:true with the map.
  fs.writeFileSync(p, JSON.stringify({
    totalCards: 2,
    byCardNumber: { 'hBP04-026': '2nd', 'hBP04-028': 'Debut' },
  }));
  const ok = readOverlayStrict(p);
  assert.equal(ok.present, true);
  assert.deepEqual(ok.byCardNumber, { 'hBP04-026': '2nd', 'hBP04-028': 'Debut' });

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 7. decidePublication proves the atomic writer is never called on failure ──

{
  const okExisting = { present: true, byCardNumber: { 'hBP04-026': '2nd', 'hBP04-027': '1st' } };

  // Happy path publishes.
  const happy = decidePublication({
    only: null,
    existingOverlay: okExisting,
    inScope: new Set(['hBP04-026', 'hBP04-027']),
    fresh: new Map([
      ['hBP04-026', { level: '2nd' }],
      ['hBP04-027', { level: '1st' }],
    ]),
    parseHits: 2, parseMisses: 0, fetchFailures: 0,
    now: new Date('2026-08-24T00:00:00Z'),
  });
  assert.equal(happy.shouldWrite, true, 'healthy batch decides shouldWrite=true');
  assert.equal(happy.payload.byCardNumber['hBP04-026'], '2nd');

  // 7a. All-HTTP-200 zero-hit schema break → no write.
  const schemaBreak = decidePublication({
    only: null,
    existingOverlay: okExisting,
    inScope: new Set(['hBP04-026', 'hBP04-027']),
    fresh: new Map([
      ['hBP04-026', { level: null }],
      ['hBP04-027', { level: null }],
    ]),
    parseHits: 0, parseMisses: 2, fetchFailures: 0,
  });
  assert.equal(schemaBreak.shouldWrite, false, 'zero-hit batch refuses to publish');
  assert.equal(schemaBreak.payload, undefined, 'no payload built when refusing');
  assert.ok(schemaBreak.reasons.some((r) => /schema/i.test(r)));

  // 7b. High parse-miss ratio → no write.
  const highMiss = decidePublication({
    only: null,
    existingOverlay: okExisting,
    inScope: new Set(['hBP04-026', 'hBP04-027']),
    fresh: new Map([
      ['hBP04-026', { level: '2nd' }],
      ['hBP04-027', { level: null }],
    ]),
    parseHits: 1, parseMisses: 1, fetchFailures: 0, // 50% miss
  });
  assert.equal(highMiss.shouldWrite, false, 'high-miss batch refuses to publish');
  assert.equal(highMiss.payload, undefined);

  // 7c. Partial --only mode with NO existing canonical → refuses.
  const partialNoBase = decidePublication({
    only: 'hBP04',
    existingOverlay: { present: false, byCardNumber: {} },
    inScope: new Set(['hBP04-026']),
    fresh: new Map([['hBP04-026', { level: '2nd' }]]),
    parseHits: 1, parseMisses: 0, fetchFailures: 0,
  });
  assert.equal(partialNoBase.shouldWrite, false,
    '--only without canonical refuses; cannot prove out-of-scope preservation');
  assert.ok(partialNoBase.reasons.some((r) => /--only/i.test(r) && /canonical/i.test(r)));
}

// ── 8. build-database.js overlay validator + BLOOM_MIN_COVERAGE validator ──

{
  // Rejects non-object payloads.
  assert.equal(validateBloomOverlay(null).ok, false);
  assert.equal(validateBloomOverlay([]).ok, false);
  assert.equal(validateBloomOverlay({}).ok, false, 'missing byCardNumber');

  // Rejects invalid levels.
  const bad = validateBloomOverlay({ byCardNumber: { 'hBP04-026': 'HR' } }, { minCoverage: 1 });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /invalid/i);

  // Rejects coverage below floor.
  const shrunk = validateBloomOverlay({ byCardNumber: { 'hBP04-026': '2nd' } }, { minCoverage: 300 });
  assert.equal(shrunk.ok, false);
  assert.match(shrunk.reason, /coverage/i);

  // Accepts a valid, sufficient payload.
  const big = { byCardNumber: {} };
  for (let i = 0; i < 305; i++) big.byCardNumber[`hBP00-${String(i).padStart(3, '0')}`] = 'Debut';
  const okCheck = validateBloomOverlay(big, { minCoverage: 300 });
  assert.equal(okCheck.ok, true);
  assert.equal(okCheck.count, 305);

  // Exported constants agree between scraper and build.
  assert.deepEqual([...VALID_LEVELS], [...VALID_BLOOM_LEVELS]);

  // coerceBloomMinCoverage — the CR-supplement fail-closed cases.
  assert.equal(coerceBloomMinCoverage({}, 300), 300, 'default applied when unset');
  assert.equal(coerceBloomMinCoverage({ BLOOM_MIN_COVERAGE: '' }, 300), 300, 'empty string uses default');
  assert.equal(coerceBloomMinCoverage({ BLOOM_MIN_COVERAGE: '0' }, 300), 0, 'zero is a legitimate opt-out');
  assert.equal(coerceBloomMinCoverage({ BLOOM_MIN_COVERAGE: '250' }, 300), 250, 'integer string is coerced');
  assert.throws(() => coerceBloomMinCoverage({ BLOOM_MIN_COVERAGE: 'abc' }, 300), /non-negative integer/);
  assert.throws(() => coerceBloomMinCoverage({ BLOOM_MIN_COVERAGE: 'NaN' }, 300), /non-negative integer/);
  assert.throws(() => coerceBloomMinCoverage({ BLOOM_MIN_COVERAGE: '-1' }, 300), /non-negative integer/);
  assert.throws(() => coerceBloomMinCoverage({ BLOOM_MIN_COVERAGE: '1.5' }, 300), /non-negative integer/);

  // Sanity: a wiped overlay + a bogus BLOOM_MIN_COVERAGE cannot conspire to
  // pass the validator, because coerce throws before validate runs.
  const wiped = { byCardNumber: { 'hBP04-026': '2nd' } };
  assert.throws(() => {
    const min = coerceBloomMinCoverage({ BLOOM_MIN_COVERAGE: 'NaN' }, 300);
    validateBloomOverlay(wiped, { minCoverage: min });
  }, /non-negative integer/);
}

// ── 9. Palette collision guard — three sets, pairwise disjoint ──────────

{
  const collisions = findBadgePaletteCollisions();
  assert.deepEqual(collisions, [],
    `badge palettes must be pairwise disjoint but got: ${JSON.stringify(collisions)}`);
  assert.notEqual(CATEGORY_COLORS.holomen.toLowerCase(), PRINTING_RARITY_COLORS.R.toLowerCase(),
    'CATEGORY_COLORS.holomen must not equal PRINTING_RARITY_COLORS.R');
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
  assert.doesNotMatch(searchSrc, /rarityColors\s*:\s*Record<string,\s*string>\s*=\s*\{[^}]*'#3b82f6'/,
    'SearchResults must not hardcode the rarity palette locally');
  assert.doesNotMatch(detailSrc, /rarityColors\s*:\s*Record<string,\s*string>\s*=\s*\{[^}]*'#3b82f6'/,
    'CardDetail must not hardcode the rarity palette locally');
}

// ── 10. Canonical card-number validator: shared, strict, disallows bogus keys ──

{
  // Positive: the exact shapes canonical Bloom keys already have.
  for (const cn of ['hBP04-026', 'hBP01-001', 'hSD10-042', 'hBP07-101']) {
    assert.equal(isCanonicalCardNumber(cn), true, `${cn} should be canonical`);
  }
  // Negative: every shape Codex called out (or that would sneak past the old
  // `typeof k === 'string' && k !== ''` check).
  const bad = [
    'bogus-0',       // no 'h' prefix
    'bogus-000',     // no 'h' prefix
    '',              // empty
    ' ',             // whitespace only
    'hBP04-26',      // suffix too short
    'hBP04-0026',    // suffix too long
    'BP04-026',      // missing 'h'
    'HBP04-026',     // wrong case for the leading 'h'
    'h-026',         // no set letters between h and dash
    'hBP04_026',     // wrong separator
    'hBP04-026 ',    // trailing whitespace
    ' hBP04-026',    // leading whitespace
    'hBP04-abc',     // non-digit index
    123,             // not a string
    null,
    undefined,
  ];
  for (const key of bad) {
    assert.equal(isCanonicalCardNumber(key), false, `${JSON.stringify(key)} must NOT be canonical`);
  }
  // assertCanonicalCardNumber throws with a helpful message.
  assert.throws(() => assertCanonicalCardNumber('bogus-0', 'test'), /test.*bogus-0/);
  assert.doesNotThrow(() => assertCanonicalCardNumber('hBP04-026', 'test'));
}

// ── 11. 300-bogus-key overlay is rejected on both scraper AND build paths ──

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bloom-bogus-'));
  const p = path.join(dir, 'bloom-levels.json');

  // Build a 300-key payload with an unbroken shape but every key bogus.
  const bogus = {};
  for (let i = 0; i < 300; i++) bogus[`bogus-${i}`] = 'Debut';
  fs.writeFileSync(p, JSON.stringify({
    totalCards: 300,
    byCardNumber: bogus,
  }));

  // Scraper path: readOverlayStrict must throw on the first bogus key so the
  // CLI aborts without ever calling the atomic writer.
  assert.throws(() => readOverlayStrict(p), /invalid card-number key/,
    'readOverlayStrict must reject bogus-N keys');

  // Build path: validateBloomOverlay must reject the payload even though the
  // count would satisfy the coverage floor.
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const check = validateBloomOverlay(raw, { minCoverage: 300 });
  assert.equal(check.ok, false, 'validateBloomOverlay must reject 300 bogus keys');
  assert.match(check.reason, /card-number does not match/,
    `expected reason to name the canonical schema, got ${check.reason}`);

  // mergeResults is the final defence: even if a bogus card number somehow
  // reaches the merge step (bypassing collectHolomenTargets and readOverlay
  // Strict), it MUST be filtered out — the merged map cannot end up carrying
  // a `bogus-0` key that could then be atomic-written. That's belt-and-braces
  // for Codex's "no bogus key ever hits disk" invariant.
  const merge = mergeResults({
    existing: { 'hBP04-026': '2nd' },
    inScope: new Set(['bogus-0', 'hBP04-027']),
    fresh: new Map([
      ['bogus-0', { level: 'Debut' }],       // bogus key: silently dropped by merge
      ['hBP04-027', { level: '1st' }],       // valid key: added
    ]),
  });
  assert.equal(merge.merged['bogus-0'], undefined, 'bogus key never enters merged map');
  assert.deepEqual(
    Object.keys(merge.merged).sort(),
    ['hBP04-026', 'hBP04-027'],
    'only canonically-shaped keys survive the merge',
  );
  // And the resulting payload contains only valid keys.
  const payload = buildPayload(merge.merged);
  assert.deepEqual(
    Object.keys(payload.byCardNumber).sort(),
    ['hBP04-026', 'hBP04-027'],
    'buildPayload output cannot include bogus keys',
  );

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 12. Single bogus key inside an otherwise valid overlay also throws ──

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bloom-one-bogus-'));
  const p = path.join(dir, 'bloom-levels.json');
  fs.writeFileSync(p, JSON.stringify({
    totalCards: 2,
    byCardNumber: { 'hBP04-026': '2nd', 'bogus-0': 'Debut' },
  }));
  assert.throws(() => readOverlayStrict(p), /invalid card-number key.*bogus-0/,
    'a single bogus key must fail the whole read (no silent drop)');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 13. Whitespace-only BLOOM_MIN_COVERAGE is treated as unset ─────────

{
  assert.equal(coerceBloomMinCoverage({ BLOOM_MIN_COVERAGE: ' ' }, 300), 300,
    'single space must NOT coerce to 0 — treat as unset');
  assert.equal(coerceBloomMinCoverage({ BLOOM_MIN_COVERAGE: '\t' }, 300), 300);
  assert.equal(coerceBloomMinCoverage({ BLOOM_MIN_COVERAGE: '\n\t ' }, 300), 300);
  assert.equal(coerceBloomMinCoverage({ BLOOM_MIN_COVERAGE: '  250  ' }, 300), 250,
    'trimmed integer is still coerced correctly');
  // Non-string, non-number types must fail closed rather than stringify.
  assert.throws(() => coerceBloomMinCoverage({ BLOOM_MIN_COVERAGE: {} }, 300), /non-negative integer/);
  assert.throws(() => coerceBloomMinCoverage({ BLOOM_MIN_COVERAGE: [] }, 300), /non-negative integer/);
  // Sanity: the whitespace-typo defeat cannot let a wiped overlay pass.
  const wiped = { byCardNumber: {} };
  const min = coerceBloomMinCoverage({ BLOOM_MIN_COVERAGE: ' ' }, 300);
  assert.equal(min, 300);
  assert.equal(validateBloomOverlay(wiped, { minCoverage: min }).ok, false,
    'whitespace BLOOM_MIN_COVERAGE must not disable the coverage floor');
}

// ── 14. collectHolomenTargets refuses bogus cardNumber in input JSON ───

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bloom-target-bogus-'));
  fs.writeFileSync(path.join(dir, 'hBP04.json'), JSON.stringify([
    { cardNumber: 'hBP04-026', id: '888', expansion: 'hBP04', cardType: 'ホロメン' },
    { cardNumber: 'bogus-0',   id: '999', expansion: 'hBP04', cardType: 'ホロメン' },
  ]));
  const targets = collectHolomenTargets({ officialDir: dir });
  assert.deepEqual([...targets.keys()], ['hBP04-026'],
    'a bogus cardNumber in official JSON must not become a canonical target');
  fs.rmSync(dir, { recursive: true, force: true });
}

// Sanity: the canonical regex is what everything shares — one source of truth.
{
  assert.ok(CANONICAL_CARD_NUMBER_RE.test('hBP04-026'));
  assert.ok(!CANONICAL_CARD_NUMBER_RE.test('bogus-0'));
}

// ── 15. Integration: collectHolomenTargets honours --only ──────────────

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
