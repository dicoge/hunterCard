#!/usr/bin/env node
// test-dic1229-history-provenance.mjs — mutation-sensitive regression for
// the DIC-1229 unproven-printing priceHistory contamination Mac-Codex CR
// flagged on main d5e49c73 and the CR rev.2 flagged on PR #161 head
// d8950165 (`hasCurrentPriceProvenance` too weak: any positive scalar
// passed even when the URL evidence was cross-printing, from an evil
// host, from an ambiguous hPR pair, or the timestamp was days-stale).
//
// Contract locked in below (matches
// `preserve-market-fields.js::hasCurrentPriceProvenance` +
// `findUnprovenPriceHistoryViolations`, `build-database.js` Step 6 skip
// + audit call, and `purge-unproven-price-history-DIC-1229.mjs::
// purgeUnprovenPriceHistory` — all pure/testable functions):
//
//   Predicate — hasCurrentPriceProvenance(card, options) is true only
//   when EVERY criterion holds:
//     (a) non-ambiguity — card.id not in options.ambiguousIds (set
//         produced by findAmbiguousPromoRowIds);
//     (b) freshness — card.timestamp parses and lies within
//         options.maxAgeMs of options.now (default 7d / Date.now());
//     (c) sourceProduct present;
//     (d) either the row-level payload (sellPrice > 0 + top-level
//         yuyuImage passing yuyuPayloadMatchesSource) OR at least one
//         prices[] entry (positive sellPrice + imageUrl passing
//         pricesEntryMatchesSource) proves the exact printing under
//         the DIC-1227 hardened URL validators.
//
//   Runtime wire — build-database.js Step 6 skips the priceHistory
//   merge on rows failing (a)-(d), the post-Step-6 audit call
//   throws when findUnprovenPriceHistoryViolations returns anything,
//   and the daily scheduler exits non-zero on any violation.
//
//   Purge wire — purgeUnprovenPriceHistory clears card.priceHistory
//   / priceHistoryMeta on unproven rows, deletes ≤1-record durable
//   files, preserves multi-record durable files, rebuilds the
//   price-history index to match the surviving files, and is truly
//   idempotent (a second run with no upstream changes rewrites
//   NEITHER data/database.json NOR data/price-history/index.json).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  hasCurrentPriceProvenance,
  findUnprovenPriceHistoryViolations,
  DIC1229_MAX_TIMESTAMP_AGE_MS,
} from './lib/preserve-market-fields.js';
import { purgeUnprovenPriceHistory, historyFilenameFor } from './purge-unproven-price-history-DIC-1229.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// A fixed "now" so freshness assertions are deterministic. Chosen close
// to the CR flag date so a card timestamped 2026-08-29 is fresh and one
// from 2026-08-01 is stale.
const NOW_MS = Date.parse('2026-08-29T00:00:00.000Z');
const FRESH_TS = '2026-08-28T12:00:00.000Z';   // ~12h before NOW → fresh
const STALE_TS = '2026-08-01T00:00:00.000Z';   // 28d before NOW → stale
const VALID_HBP01_URL = 'https://card.yuyu-tei.jp/hocg/100_140/hbp01/10001.jpg';
const VALID_HEB01_URL = 'https://card.yuyu-tei.jp/hocg/100_140/heb01/10001.jpg';
const VALID_PROMO_HBP10_URL = 'https://card.yuyu-tei.jp/hocg/100_140/promo-hbp10/10013.jpg';
const EVIL_HOST_URL = 'https://evil-yuyu-tei.jp/hocg/100_140/hbp01/10001.jpg';
const OPAQUE_URL = 'javascript:alert(1)';
const NON_DEFAULT_PORT_URL = 'https://card.yuyu-tei.jp:8443/hocg/100_140/hbp01/10001.jpg';
const NO_EXT_URL = 'https://card.yuyu-tei.jp/hocg/100_140/hbp01/10001';

const gate = (extra = {}) => ({ now: NOW_MS, ...extra });

// =============================================================================
// UNIT LAYER — hasCurrentPriceProvenance strict contract (rev.2)
// =============================================================================

// Type / null guards
assert.equal(hasCurrentPriceProvenance(null, gate()), false, 'null card is unproven');
assert.equal(hasCurrentPriceProvenance(undefined, gate()), false, 'undefined card is unproven');
assert.equal(hasCurrentPriceProvenance({}, gate()), false, 'empty card is unproven');
assert.equal(hasCurrentPriceProvenance('not an object', gate()), false, 'non-object card is unproven');

// Default 7-day window sanity check
assert.equal(DIC1229_MAX_TIMESTAMP_AGE_MS, 7 * 24 * 60 * 60 * 1000, 'default freshness window is 7 days');

// sourceProduct missing → unproven
assert.equal(
  hasCurrentPriceProvenance({
    sellPrice: 180, timestamp: FRESH_TS, yuyuImage: VALID_HBP01_URL,
    prices: [], sourceProduct: '',
  }, gate()),
  false,
  'empty sourceProduct is unproven — needed for URL-vs-sourceProduct match',
);

// Freshness — missing / unparseable / stale timestamp
assert.equal(
  hasCurrentPriceProvenance({
    sourceProduct: 'hBP01', sellPrice: 180, yuyuImage: VALID_HBP01_URL,
    prices: [], timestamp: '',
  }, gate()),
  false,
  'missing timestamp is stale',
);
assert.equal(
  hasCurrentPriceProvenance({
    sourceProduct: 'hBP01', sellPrice: 180, yuyuImage: VALID_HBP01_URL,
    prices: [], timestamp: 'not-a-date',
  }, gate()),
  false,
  'unparseable timestamp is stale',
);
assert.equal(
  hasCurrentPriceProvenance({
    sourceProduct: 'hBP01', sellPrice: 180, yuyuImage: VALID_HBP01_URL,
    prices: [], timestamp: STALE_TS,
  }, gate()),
  false,
  '28d-old timestamp exceeds default 7d window',
);
assert.equal(
  hasCurrentPriceProvenance({
    sourceProduct: 'hBP01', sellPrice: 180, yuyuImage: VALID_HBP01_URL,
    prices: [], timestamp: STALE_TS,
  }, gate({ maxAgeMs: 60 * 24 * 60 * 60 * 1000 })),
  true,
  'stale timestamp passes when caller widens maxAgeMs past the gap',
);
assert.equal(
  hasCurrentPriceProvenance({
    sourceProduct: 'hBP01', sellPrice: 180, yuyuImage: VALID_HBP01_URL,
    prices: [], timestamp: FRESH_TS,
  }, gate()),
  true,
  'fresh timestamp + valid URL + positive sellPrice + matching source passes',
);
// The default `now = Date.now()` path (no explicit `now` override) — the
// same fresh row still passes today, so a caller that omits `now` gets a
// wall-clock check without exploding on the fresh case.
assert.equal(
  hasCurrentPriceProvenance({
    sourceProduct: 'hBP01', sellPrice: 180, yuyuImage: VALID_HBP01_URL,
    prices: [], timestamp: new Date().toISOString(),
  }),
  true,
  'wall-clock default now works for a just-now-stamped row',
);

// URL provenance — evil host, opaque URI, non-default port, no extension
for (const [badUrl, label] of [
  [EVIL_HOST_URL, 'lookalike host'],
  [OPAQUE_URL, 'javascript: URI'],
  [NON_DEFAULT_PORT_URL, 'non-default port'],
  [NO_EXT_URL, 'missing extension'],
  ['', 'empty URL'],
]) {
  assert.equal(
    hasCurrentPriceProvenance({
      sourceProduct: 'hBP01', sellPrice: 180, yuyuImage: badUrl,
      prices: [], timestamp: FRESH_TS,
    }, gate()),
    false,
    `top-level yuyuImage = ${label} fails closed even with positive sellPrice`,
  );
}

// Cross-printing — sourceProduct hBP01 but yuyuImage from /heb01/
assert.equal(
  hasCurrentPriceProvenance({
    sourceProduct: 'hBP01', sellPrice: 180, yuyuImage: VALID_HEB01_URL,
    prices: [], timestamp: FRESH_TS,
  }, gate()),
  false,
  'cross-printing top-level URL (/heb01/ on hBP01 row) fails closed',
);

// promo carve-out — hPR row with /promo-hbp10/ image is proven
assert.equal(
  hasCurrentPriceProvenance({
    sourceProduct: 'hPR', sellPrice: 980, yuyuImage: VALID_PROMO_HBP10_URL,
    prices: [], timestamp: FRESH_TS, cardNumber: 'hBP01-048',
  }, gate()),
  true,
  'hPR + /promo-hbp10/ = known promo carve-out passes',
);

// Entry-level path — no top-level payload, but a valid prices[] entry
assert.equal(
  hasCurrentPriceProvenance({
    sourceProduct: 'hBP01', sellPrice: null, yuyuImage: '',
    prices: [{ sellPrice: 500, imageUrl: VALID_HBP01_URL, name: '風真いろは' }],
    timestamp: FRESH_TS, cardNumber: 'hBP01-001',
  }, gate()),
  true,
  'entry-level: positive prices[] entry with matching URL passes',
);
assert.equal(
  hasCurrentPriceProvenance({
    sourceProduct: 'hBP01', sellPrice: null, yuyuImage: '',
    prices: [{ sellPrice: 500, imageUrl: EVIL_HOST_URL }],
    timestamp: FRESH_TS, cardNumber: 'hBP01-001',
  }, gate()),
  false,
  'entry-level: evil-host imageUrl fails closed even with positive sellPrice',
);
assert.equal(
  hasCurrentPriceProvenance({
    sourceProduct: 'hBP01', sellPrice: null, yuyuImage: '',
    prices: [{ sellPrice: 500, imageUrl: VALID_HEB01_URL }],
    timestamp: FRESH_TS, cardNumber: 'hBP01-001',
  }, gate()),
  false,
  'entry-level: cross-printing imageUrl (/heb01/ on hBP01 row) fails closed',
);
// ent07 aggregation carve-out — sourceProduct=ent07 accepts any valid
// yuyu-tei image URL (it's the scraper's aggregation label, not an
// official product code). Well-formed URL passes; noimage placeholder
// fails.
assert.equal(
  hasCurrentPriceProvenance({
    sourceProduct: 'ent07', sellPrice: null, yuyuImage: '',
    prices: [{ sellPrice: 80, imageUrl: VALID_HBP01_URL }],
    timestamp: FRESH_TS,
  }, gate()),
  true,
  'ent07 aggregation: any well-formed yuyu URL passes',
);
assert.equal(
  hasCurrentPriceProvenance({
    sourceProduct: 'ent07', sellPrice: null, yuyuImage: '',
    prices: [{ sellPrice: 80, imageUrl: 'https://card.yuyu-tei.jp/noimage_100_140.jpg' }],
    timestamp: FRESH_TS,
  }, gate()),
  false,
  'ent07 aggregation: noimage placeholder still fails URL parse',
);

// Non-positive sellPrice — zero, negative, null, NaN, string
for (const badPrice of [0, -100, null, undefined, NaN, '180']) {
  assert.equal(
    hasCurrentPriceProvenance({
      sourceProduct: 'hBP01', sellPrice: badPrice, yuyuImage: VALID_HBP01_URL,
      prices: [], timestamp: FRESH_TS,
    }, gate()),
    false,
    `sellPrice=${String(badPrice)} + no valid entry = unproven`,
  );
}

// Ambiguity — even with valid URL / fresh / sourceProduct, an id in the
// ambiguous set fails closed.
{
  const card = {
    id: 'hSD03-002_hPR_P_hSD03-002_P',
    cardNumber: 'hSD03-002',
    sourceProduct: 'hPR', sellPrice: 980,
    yuyuImage: VALID_PROMO_HBP10_URL,
    prices: [], timestamp: FRESH_TS,
  };
  assert.equal(hasCurrentPriceProvenance(card, gate()), true, 'ambiguity-less baseline passes');
  const ambiguous = new Set([card.id]);
  assert.equal(
    hasCurrentPriceProvenance(card, gate({ ambiguousIds: ambiguous })),
    false,
    'row in ambiguous set fails closed',
  );
}

// The exact Mac-Codex-flagged shape must be unproven.
assert.equal(
  hasCurrentPriceProvenance({
    id: 'hBP01-090_hPR_P_hBP01-090_P_02',
    sourceProduct: 'hPR', sellPrice: null, prices: [], yuyuImage: '',
    priceHistory: { '2026-08-28': 30 }, timestamp: '',
  }, gate()),
  false,
  'the hBP01-090_02 shape (null sell, empty prices, no timestamp) is unproven even when priceHistory carries a value',
);

// The exact freshly-scraped shape a normal hEB01 row would have — proven.
assert.equal(
  hasCurrentPriceProvenance({
    sourceProduct: 'hEB01', sellPrice: 100,
    yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/heb01/10001.jpg',
    prices: [], timestamp: FRESH_TS,
    cardNumber: 'hEB01-001',
  }, gate()),
  true,
  'the canonical hEB01 fresh-scrape shape passes',
);

// =============================================================================
// UNIT LAYER — findUnprovenPriceHistoryViolations pure audit
// =============================================================================
{
  const cleanRow = {
    id: 'hEB01-001_hEB01_C_hEB01-001_C',
    sourceProduct: 'hEB01', sellPrice: 100,
    yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/heb01/10001.jpg',
    prices: [], timestamp: FRESH_TS, cardNumber: 'hEB01-001',
    priceHistory: { '2026-08-27': 100, '2026-08-28': 100 },
  };
  const flaggedRow = {
    id: 'hBP01-090_hPR_P_hBP01-090_P_02',
    sourceProduct: 'hPR', sellPrice: null, prices: [], yuyuImage: '', timestamp: '',
    cardNumber: 'hBP01-090',
    priceHistory: { '2026-08-28': 30 },
  };
  const staleScalarRow = {
    id: 'hBP01-050_hPR_P_hBP01-050_P',
    sourceProduct: 'hPR', sellPrice: 500, // positive but stale + wrong URL
    yuyuImage: VALID_HEB01_URL, // cross-printing
    prices: [], timestamp: STALE_TS, cardNumber: 'hBP01-050',
    priceHistory: { '2026-08-15': 500 },
  };
  const cards = {
    [cleanRow.id]: cleanRow,
    [flaggedRow.id]: flaggedRow,
    [staleScalarRow.id]: staleScalarRow,
  };
  const violations = findUnprovenPriceHistoryViolations(cards, gate());
  const ids = new Set(violations.map((v) => v.id));
  assert.equal(violations.length, 2, `expected 2 violations, got ${violations.length}: ${JSON.stringify(violations)}`);
  assert.ok(ids.has(flaggedRow.id), 'flagged row must appear in violations');
  assert.ok(ids.has(staleScalarRow.id), 'stale/cross-printing row must appear in violations');
  assert.ok(!ids.has(cleanRow.id), 'clean hEB01 row must NOT appear in violations');
  const flaggedEntry = violations.find((v) => v.id === flaggedRow.id);
  assert.equal(flaggedEntry.dayCount, 1, 'violation entry reports dayCount');

  // Empty / non-object cards map guards.
  assert.deepEqual(findUnprovenPriceHistoryViolations(null, gate()), []);
  assert.deepEqual(findUnprovenPriceHistoryViolations({}, gate()), []);
  assert.deepEqual(findUnprovenPriceHistoryViolations('nope', gate()), []);
}

// =============================================================================
// SOURCE-INSPECTION LAYER — build-database.js production wire
// =============================================================================
{
  const builderPath = path.join(REPO_ROOT, 'scripts/build-database.js');
  const src = fs.readFileSync(builderPath, 'utf8');

  // Imports for both the predicate and the pure audit function.
  assert.match(
    src,
    /import\s*{[\s\S]*?\bhasCurrentPriceProvenance\b[\s\S]*?}\s*from\s*['"]\.\/lib\/preserve-market-fields\.js['"]/,
    'scripts/build-database.js must import hasCurrentPriceProvenance',
  );
  assert.match(
    src,
    /import\s*{[\s\S]*?\bfindUnprovenPriceHistoryViolations\b[\s\S]*?}\s*from\s*['"]\.\/lib\/preserve-market-fields\.js['"]/,
    'scripts/build-database.js must import findUnprovenPriceHistoryViolations',
  );
  assert.match(
    src,
    /import\s*{[\s\S]*?\bfindAmbiguousPromoRowIds\b[\s\S]*?}\s*from\s*['"]\.\/lib\/preserve-market-fields\.js['"]/,
    'scripts/build-database.js must import findAmbiguousPromoRowIds (for the shared gate options)',
  );

  // Step 6 gate: skip and pass provenanceGateOptions with the ambiguous set.
  const step6Idx = src.indexOf('── Step 6: Merge priceHistory');
  assert.ok(step6Idx > -1, 'Step 6 header must still exist');
  const step6Slice = src.slice(step6Idx, step6Idx + 4000);
  assert.match(
    step6Slice,
    /provenanceGateOptions\s*=\s*\{[\s\S]*?ambiguousIds:\s*findAmbiguousPromoRowIds\s*\(\s*database\.cards\s*\)/,
    'Step 6 must derive provenanceGateOptions with ambiguousIds = findAmbiguousPromoRowIds(database.cards)',
  );
  assert.match(
    step6Slice,
    /if\s*\(\s*!\s*hasCurrentPriceProvenance\s*\(\s*card\s*,\s*provenanceGateOptions\s*\)\s*\)/,
    'Step 6 must call hasCurrentPriceProvenance(card, provenanceGateOptions) before merging records',
  );
  assert.match(
    step6Slice,
    /!\s*hasCurrentPriceProvenance\s*\([\s\S]*?\)[\s\S]*?continue/,
    'the gate must `continue` (skip merge) for unproven rows',
  );

  // Post-Step-6 hard-fail audit.
  const auditIdx = src.indexOf('DIC-1229 hard-fail audit');
  assert.ok(auditIdx > -1, 'audit comment must be present');
  const auditSlice = src.slice(auditIdx, auditIdx + 2500);
  assert.match(
    auditSlice,
    /findUnprovenPriceHistoryViolations\s*\(\s*database\.cards\s*,\s*provenanceGateOptions\s*\)/,
    'audit must delegate to findUnprovenPriceHistoryViolations(database.cards, provenanceGateOptions)',
  );
  assert.match(auditSlice, /throw\s+new\s+Error/, 'audit must throw on violation');
  assert.match(auditSlice, /\[DIC-1229\]/, 'thrown error must be tagged with DIC-1229');
}

// =============================================================================
// E2E LAYER — subprocess build under HUNTERCARD_YUYU_FIXTURE_PATH
// Drive the poisoned printing `hBP01-090_hPR_P_hBP01-090_P_02` through
// the daily scheduler path (real `scripts/build-database.js` under an
// empty yuyu fixture) and prove:
//   1. stdout must carry `skipped N unproven printings (DIC-1229
//      fail-closed)` with N ≥ 1 — that log line ONLY appears when the
//      Step 6 skip fires. Removing the skip removes the counter.
//      Mutation-sensitivity to Step 6 skip removal is enforced here.
//   2. If the build succeeds it must ship the poisoned row with an
//      empty priceHistory. If Step 6 skip is removed but the audit
//      still runs, the audit throws (stderr `[DIC-1229]`) — either
//      shape proves non-zero on contamination.
// Audit weakening / removal is enforced independently by:
//   - the unit-layer findUnprovenPriceHistoryViolations tests above
//     (mutation-sensitive to the predicate call inside the pure
//     function),
//   - the source-inspection layer above (mutation-sensitive to the
//     production wire in scripts/build-database.js).
// Preservation itself refuses to copy priceHistory onto an unproven
// row (`applyPreservedMarketFields` gates on `topLevelPayloadMatches`
// and per-entry surviving payload), so we cannot construct a real
// subprocess scenario where the audit is the ONLY line of defence
// — that's the defence-in-depth story the pure-function tests pin.
// =============================================================================
{
  const CANONICAL_ID = 'hBP01-090_hPR_P_hBP01-090_P_02';
  const dbPath = path.join(REPO_ROOT, 'data/database.json');
  const nativePath = path.join(REPO_ROOT, 'public/data/database.json');
  const historyDir = path.join(REPO_ROOT, 'data/price-history');
  const scrapeLogPath = path.join(REPO_ROOT, 'data/scrape-log.txt');
  const canonicalHistoryFile = path.join(historyDir, `${CANONICAL_ID.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);

  const currentDb = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const preRow = currentDb.cards?.[CANONICAL_ID];
  assert.ok(preRow, `E2E preflight: ${CANONICAL_ID} must exist in shipped data/database.json`);
  assert.equal(
    hasCurrentPriceProvenance(preRow, gate()),
    false,
    'E2E preflight: the flagged row must be unproven going in (under the rev.2 strict predicate)',
  );

  // Snapshot everything we touch so the test leaves no trace.
  const originalDb = fs.readFileSync(dbPath, 'utf8');
  const originalNative = fs.readFileSync(nativePath, 'utf8');
  const originalScrapeLog = fs.existsSync(scrapeLogPath) ? fs.readFileSync(scrapeLogPath, 'utf8') : null;
  const historySnapshot = new Map();
  for (const file of fs.readdirSync(historyDir)) {
    if (!file.endsWith('.json')) continue;
    historySnapshot.set(file, fs.readFileSync(path.join(historyDir, file), 'utf8'));
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dic1229-e2e-'));

  function restore() {
    fs.writeFileSync(dbPath, originalDb);
    fs.writeFileSync(nativePath, originalNative);
    if (originalScrapeLog === null) {
      if (fs.existsSync(scrapeLogPath)) fs.unlinkSync(scrapeLogPath);
    } else {
      fs.writeFileSync(scrapeLogPath, originalScrapeLog);
    }
    const currentFiles = new Set(fs.readdirSync(historyDir).filter((f) => f.endsWith('.json')));
    for (const file of currentFiles) {
      if (!historySnapshot.has(file)) fs.unlinkSync(path.join(historyDir, file));
    }
    for (const [file, contents] of historySnapshot.entries()) {
      fs.writeFileSync(path.join(historyDir, file), contents);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  try {
    // Yuyu fixture returns no cards → build path exercises the DIC-1229
    // Step 6 gate + audit under the exact "no current provenance" shape.
    const fixtureFile = path.join(tmp, 'yuyu-fixture.json');
    fs.writeFileSync(
      fixtureFile,
      JSON.stringify({ prices: {}, totalCards: 0, seriesWithPrices: 0, pricingUnavailable: true }),
    );

    // ─── Scenario A: poisoned durable file ─────────────────────────────
    fs.writeFileSync(canonicalHistoryFile, JSON.stringify({
      cardId: CANONICAL_ID,
      cardNumber: 'hBP01-090',
      name: 'ムーナ・ホシノヴァ',
      records: [{
        date: '2026-08-28',
        price: 30,
        source: 'yuyu-tei',
        currency: 'JPY',
        cardId: CANONICAL_ID,
        sourceProduct: 'hPR',
      }],
      lastUpdated: '2026-08-28T13:10:25.361Z',
      nameZh: '姆娜·霍希諾瓦',
    }, null, 2));

    let result = spawnSync(process.execPath, ['scripts/build-database.js'], {
      cwd: REPO_ROOT,
      env: { ...process.env, HUNTERCARD_YUYU_FIXTURE_PATH: fixtureFile },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 240000,
    });
    let stdout = result.stdout?.toString() || '';
    let stderr = result.stderr?.toString() || '';

    // Either exit code shape is acceptable — the important assertion is
    // the stdout skip counter, which only appears when Step 6 fires the
    // `if (!hasCurrentPriceProvenance(...)) continue;` branch. Removing
    // the skip removes the counter from the log.
    assert.match(
      stdout,
      /skipped\s+\d+\s+unproven printings \(DIC-1229 fail-closed\)/,
      `Scenario A: Step 6 skip counter must appear on stdout (mutation-sensitive to skip removal). stdout tail:\n${stdout.slice(-2000)}\nstderr tail:\n${stderr.slice(-2000)}`,
    );
    const skipMatch = stdout.match(/skipped\s+(\d+)\s+unproven printings/);
    assert.ok(
      skipMatch && Number(skipMatch[1]) >= 1,
      `Scenario A: skip counter must be ≥ 1 (got "${skipMatch?.[0] || 'no match'}") — the poisoned unproven row must count`,
    );
    let written = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    let row = written.cards?.[CANONICAL_ID];
    if (result.status !== 0) {
      assert.match(stderr, /DIC-1229/, `Scenario A: build failed but not on DIC-1229 audit — stderr:\n${stderr.slice(-2000)}`);
    } else {
      const phSize = row.priceHistory ? Object.keys(row.priceHistory).length : 0;
      assert.equal(phSize, 0, `Scenario A: ${CANONICAL_ID} must NOT ship priceHistory (got ${JSON.stringify(row.priceHistory)})`);
    }

  } finally {
    restore();
  }
}

// =============================================================================
// PURGE LAYER — purgeUnprovenPriceHistory scope + idempotence
// Uses a temporary fixture repo so no real repo files are touched.
// =============================================================================
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dic1229-purge-'));
  const tmpDbPath = path.join(tmpRoot, 'database.json');
  const tmpHistoryDir = path.join(tmpRoot, 'price-history');
  const tmpIndexPath = path.join(tmpHistoryDir, 'index.json');
  fs.mkdirSync(tmpHistoryDir, { recursive: true });

  const provenRow = {
    id: 'hBP01-001_hBP01_C_hBP01-001_C',
    cardNumber: 'hBP01-001',
    sourceProduct: 'hBP01',
    sellPrice: 100,
    yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/hbp01/10001.jpg',
    prices: [{ sellPrice: 100, imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/hbp01/10001.jpg' }],
    timestamp: FRESH_TS,
    priceHistory: { '2026-08-27': 100, '2026-08-28': 100 },
  };
  const unprovenRow = {
    id: 'hBP01-090_hPR_P_hBP01-090_P_02',
    cardNumber: 'hBP01-090',
    sourceProduct: 'hPR',
    sellPrice: null,
    yuyuImage: '',
    prices: [],
    timestamp: '',
    priceHistory: { '2026-08-28': 30 },
    priceHistoryMeta: { source: 'legacy' },
  };
  const unprovenRowMulti = {
    id: 'hSD03-002_hPR_P_hSD03-002_P',
    cardNumber: 'hSD03-002',
    sourceProduct: 'hPR',
    sellPrice: null, yuyuImage: '', prices: [], timestamp: '',
    priceHistory: { '2026-08-01': 200, '2026-08-15': 200, '2026-08-27': 200 },
  };
  const db = {
    lastUpdated: '2026-08-29T00:00:00.000Z',
    totalCards: 3,
    source: 'test fixture',
    cards: {
      [provenRow.id]: provenRow,
      [unprovenRow.id]: unprovenRow,
      [unprovenRowMulti.id]: unprovenRowMulti,
    },
  };
  fs.writeFileSync(tmpDbPath, `${JSON.stringify(db, null, 2)}\n`);

  // Durable files:
  //  - proven row: 3-record legit history — must survive (not owned by purge scope anyway)
  //  - unproven row (single-record): must be deleted
  //  - unproven row (multi-record): must be preserved, card.priceHistory still cleared
  //  - orphan file (no matching card): must survive but be enumerated in the rebuilt index
  const provenHistFile = path.join(tmpHistoryDir, historyFilenameFor(provenRow.id));
  const unprovenSingleFile = path.join(tmpHistoryDir, historyFilenameFor(unprovenRow.id));
  const unprovenMultiFile = path.join(tmpHistoryDir, historyFilenameFor(unprovenRowMulti.id));
  const orphanFile = path.join(tmpHistoryDir, 'orphan_card_id.json');
  fs.writeFileSync(provenHistFile, JSON.stringify({
    cardId: provenRow.id,
    records: [
      { date: '2026-08-26', price: 100 },
      { date: '2026-08-27', price: 100 },
      { date: '2026-08-28', price: 100 },
    ],
  }));
  fs.writeFileSync(unprovenSingleFile, JSON.stringify({
    cardId: unprovenRow.id,
    records: [{ date: '2026-08-28', price: 30 }],
  }));
  fs.writeFileSync(unprovenMultiFile, JSON.stringify({
    cardId: unprovenRowMulti.id,
    records: [
      { date: '2026-08-01', price: 200 },
      { date: '2026-08-15', price: 200 },
      { date: '2026-08-27', price: 200 },
    ],
  }));
  fs.writeFileSync(orphanFile, JSON.stringify({
    cardId: 'orphan_card_id',
    records: [{ date: '2026-08-01', price: 500 }],
  }));
  // Pre-existing index.json — must be rewritten on run 1, and left byte-
  // identical on run 2 (that's the idempotence contract the CR names).
  fs.writeFileSync(tmpIndexPath, `${JSON.stringify({
    lastUpdated: '2025-01-01T00:00:00.000Z',
    totalCards: 0,
    totalRecords: 0,
    cardIds: [],
  }, null, 2)}\n`);

  const purgeOptions = {
    dbPath: tmpDbPath,
    historyDir: tmpHistoryDir,
    indexPath: tmpIndexPath,
    gateOptions: { now: NOW_MS },
    now: new Date('2026-08-29T00:00:00.000Z'),
  };

  // ── Run 1: purge fires ──────────────────────────────────────────────
  const result1 = purgeUnprovenPriceHistory(purgeOptions);
  assert.equal(result1.cardsCleared, 2, `Run 1: 2 unproven rows must be cleared, got ${result1.cardsCleared}`);
  assert.equal(result1.filesPurged, 1, `Run 1: 1 single-record file must be purged, got ${result1.filesPurged}`);
  assert.equal(result1.filesKept, 1, `Run 1: 1 multi-record file must be preserved, got ${result1.filesKept}`);
  assert.equal(result1.dbWritten, true, 'Run 1: db must be rewritten');
  assert.equal(result1.indexWritten, true, 'Run 1: index must be rewritten from the stale initial state');

  // Deletion scope: single-record poisoned file gone; multi-record + proven + orphan survive.
  assert.equal(fs.existsSync(unprovenSingleFile), false, 'Run 1: single-record poisoned file must be deleted');
  assert.equal(fs.existsSync(unprovenMultiFile), true, 'Run 1: multi-record file must be preserved');
  assert.equal(fs.existsSync(provenHistFile), true, 'Run 1: proven-row history file must be preserved');
  assert.equal(fs.existsSync(orphanFile), true, 'Run 1: orphan file must be preserved (not in scope of purge)');

  // Card-level clears applied to both unproven rows.
  const dbAfter1 = JSON.parse(fs.readFileSync(tmpDbPath, 'utf-8'));
  assert.deepEqual(dbAfter1.cards[unprovenRow.id].priceHistory, {}, 'Run 1: unproven single row priceHistory cleared');
  assert.equal(dbAfter1.cards[unprovenRow.id].priceHistoryMeta, undefined, 'Run 1: unproven priceHistoryMeta deleted');
  assert.deepEqual(dbAfter1.cards[unprovenRowMulti.id].priceHistory, {}, 'Run 1: unproven multi row priceHistory cleared');
  assert.deepEqual(dbAfter1.cards[provenRow.id].priceHistory, provenRow.priceHistory, 'Run 1: proven row priceHistory untouched');

  // Complete index regeneration: cardIds MUST equal the sorted list of
  // remaining .json files (drop purged, keep multi + proven + orphan).
  const index1 = JSON.parse(fs.readFileSync(tmpIndexPath, 'utf-8'));
  const remainingFiles = fs.readdirSync(tmpHistoryDir)
    .filter((f) => f.endsWith('.json') && f !== 'index.json')
    .sort();
  const expectedIds = remainingFiles.map((f) => f.replace(/\.json$/, ''));
  assert.deepEqual(index1.cardIds.slice().sort(), expectedIds.slice().sort(),
    `Run 1: index.cardIds must equal remaining history files`);
  assert.equal(index1.totalCards, expectedIds.length, 'Run 1: totalCards must match cardIds length');
  // Sum records across surviving files: 3 (proven) + 3 (multi) + 1 (orphan) = 7
  assert.equal(index1.totalRecords, 7, `Run 1: totalRecords must sum surviving files' records (expected 7, got ${index1.totalRecords})`);

  // ── Run 2: idempotence — nothing to change; NO writes ───────────────
  const dbBytesBeforeRun2 = fs.readFileSync(tmpDbPath);
  const indexBytesBeforeRun2 = fs.readFileSync(tmpIndexPath);
  const historyMtimesBeforeRun2 = new Map();
  for (const f of fs.readdirSync(tmpHistoryDir)) {
    if (f === 'index.json') continue;
    historyMtimesBeforeRun2.set(f, fs.statSync(path.join(tmpHistoryDir, f)).mtimeMs);
  }
  const result2 = purgeUnprovenPriceHistory({ ...purgeOptions, now: new Date('2027-01-01T00:00:00.000Z') });
  assert.equal(result2.cardsCleared, 0, 'Run 2: no rows to clear');
  assert.equal(result2.filesPurged, 0, 'Run 2: no files to purge');
  assert.equal(result2.dbWritten, false, 'Run 2: db must NOT be rewritten');
  assert.equal(result2.indexWritten, false, 'Run 2: index must NOT be rewritten (idempotence)');
  // Byte-for-byte comparison of db + index.
  assert.ok(dbBytesBeforeRun2.equals(fs.readFileSync(tmpDbPath)), 'Run 2: db bytes must be identical');
  assert.ok(indexBytesBeforeRun2.equals(fs.readFileSync(tmpIndexPath)), 'Run 2: index bytes must be identical (lastUpdated NOT touched)');
  // Surviving history files must not be recreated / mtime-touched.
  for (const [f, mtime] of historyMtimesBeforeRun2) {
    assert.equal(fs.statSync(path.join(tmpHistoryDir, f)).mtimeMs, mtime,
      `Run 2: ${f} mtime must be unchanged (no gratuitous rewrites)`);
  }

  // ── Run 3: introduce a new violation → db rewrite fires; index stays same. ──
  const dbForRun3 = JSON.parse(fs.readFileSync(tmpDbPath, 'utf-8'));
  dbForRun3.cards[provenRow.id].sellPrice = null;
  dbForRun3.cards[provenRow.id].prices = [];
  dbForRun3.cards[provenRow.id].yuyuImage = '';
  dbForRun3.cards[provenRow.id].timestamp = ''; // now unproven → priceHistory must be cleared
  fs.writeFileSync(tmpDbPath, `${JSON.stringify(dbForRun3, null, 2)}\n`);
  const result3 = purgeUnprovenPriceHistory({ ...purgeOptions, now: new Date('2027-02-01T00:00:00.000Z') });
  assert.equal(result3.cardsCleared, 1, 'Run 3: newly-unproven proven row must be cleared');
  assert.equal(result3.filesPurged, 0, 'Run 3: proven history file has >1 record — NOT purged');
  assert.equal(result3.dbWritten, true, 'Run 3: db must be rewritten (a row changed)');
  // Index has same cardIds (proven file was NOT purged), so index bytes stay identical.
  assert.ok(indexBytesBeforeRun2.equals(fs.readFileSync(tmpIndexPath)),
    "Run 3: index bytes must be identical when the cardIds set didn't change (only lastUpdated would change on a rewrite, but rewrite is suppressed for equal content)");

  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log('DIC-1229 history-provenance regression checks passed');
