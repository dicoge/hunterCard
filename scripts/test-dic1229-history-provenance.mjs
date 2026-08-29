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
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  hasCurrentPriceProvenance,
  findUnprovenPriceHistoryViolations,
  pricesEntryExactPrintMatchesSource,
  DIC1229_MAX_TIMESTAMP_AGE_MS,
  DIC1229_MAX_TIMESTAMP_CLOCK_SKEW_MS,
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
const FUTURE_TS_FAR = '2099-01-01T00:00:00.000Z';  // Mac-Codex-flagged far-future
const FUTURE_TS_HOUR = new Date(NOW_MS + 60 * 60 * 1000).toISOString(); // 1h in future
const FUTURE_TS_MIN = new Date(NOW_MS + 60 * 1000).toISOString();       // 1min in future (within default 5-min skew)
const VALID_HBP01_URL = 'https://card.yuyu-tei.jp/hocg/100_140/hbp01/10001.jpg';
const VALID_HBP02_URL = 'https://card.yuyu-tei.jp/hocg/100_140/hbp02/10002.jpg';
const VALID_HBP04_URL = 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10004.jpg';
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

// DIC-1229 CR rev.3: bounded future clock skew. A timestamp deep in the
// future must fail closed even when every other criterion holds.
assert.equal(DIC1229_MAX_TIMESTAMP_CLOCK_SKEW_MS, 5 * 60 * 1000, 'default clock-skew allowance is 5 minutes');
assert.equal(
  hasCurrentPriceProvenance({
    sourceProduct: 'hBP01', sellPrice: 180, yuyuImage: VALID_HBP01_URL,
    prices: [], timestamp: FUTURE_TS_FAR,
  }, gate()),
  false,
  'far-future timestamp (2099 under 2026 clock) fails closed — the exact CR rev.3 blocker',
);
assert.equal(
  hasCurrentPriceProvenance({
    sourceProduct: 'hBP01', sellPrice: 180, yuyuImage: VALID_HBP01_URL,
    prices: [], timestamp: FUTURE_TS_HOUR,
  }, gate()),
  false,
  '1-hour future timestamp exceeds default 5-min clock-skew allowance',
);
assert.equal(
  hasCurrentPriceProvenance({
    sourceProduct: 'hBP01', sellPrice: 180, yuyuImage: VALID_HBP01_URL,
    prices: [], timestamp: FUTURE_TS_MIN,
  }, gate()),
  true,
  '1-minute future timestamp is within default clock-skew allowance (NTP jitter tolerance)',
);
assert.equal(
  hasCurrentPriceProvenance({
    sourceProduct: 'hBP01', sellPrice: 180, yuyuImage: VALID_HBP01_URL,
    prices: [], timestamp: FUTURE_TS_FAR,
  }, gate({ clockSkewMs: 100 * 365 * 24 * 60 * 60 * 1000 })),
  true,
  'far-future timestamp passes when caller explicitly widens clockSkewMs — proves the bound is a configurable gate, not disabled',
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
// DIC-1229 CR rev.3: the ent07 aggregation carve-out from
// `pricesEntryMatchesSource` is INTENTIONALLY not applied to the
// priceHistory gate. `ent07` is the scraper's aggregation label, not an
// official product code; a URL matching any random product path cannot
// prove which physical printing the ent07 row represents. History is
// per-printing evidence, so ent07 rows must have their OWN listing (only
// possible if urlProd === 'ent07', which no yuyu path is → always false).
assert.equal(
  hasCurrentPriceProvenance({
    sourceProduct: 'ent07', sellPrice: null, yuyuImage: '',
    prices: [{ sellPrice: 80, imageUrl: VALID_HBP01_URL }],
    timestamp: FRESH_TS,
  }, gate()),
  false,
  'ent07 aggregation: cross-product yuyu URL fails the exact-print gate (no aggregation carve-out for history)',
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

// DIC-1229 CR rev.3: the reprint origin-prefix carve-out from
// `pricesEntryMatchesSource` (deck aggregation) is INTENTIONALLY not
// applied to the priceHistory gate. A fresh hBP04 reprint whose only
// prices[] entry points at /hbp02/ (cardNumber's origin prefix but NOT
// the row's sourceProduct) currently would pass the relaxed deck-
// aggregation match and, under rev.2, wrongly return true here. The
// history gate must reject it — the exact FAIL Mac-Codex flagged.
assert.equal(
  hasCurrentPriceProvenance({
    sourceProduct: 'hBP04', sellPrice: null, yuyuImage: '',
    prices: [{ sellPrice: 180, imageUrl: VALID_HBP02_URL, name: '風真いろは' }],
    timestamp: FRESH_TS, cardNumber: 'hBP02-084',
  }, gate()),
  false,
  'reprint carve-out rejected: hBP04 reprint with only hBP02-origin entry fails the history gate (Mac-Codex rev.3 blocker)',
);
// The SAME row with its OWN /hbp04/ entry passes — the reprint carve-out
// is what was removed, not the exact-print match.
assert.equal(
  hasCurrentPriceProvenance({
    sourceProduct: 'hBP04', sellPrice: null, yuyuImage: '',
    prices: [
      { sellPrice: 180, imageUrl: VALID_HBP02_URL, name: '風真いろは' },
      { sellPrice: 220, imageUrl: VALID_HBP04_URL, name: '風真いろは(パラレル)' },
    ],
    timestamp: FRESH_TS, cardNumber: 'hBP02-084',
  }, gate()),
  true,
  'reprint row passes when it carries its OWN sourceProduct-matched entry',
);

// DIC-1229 CR rev.3: pure `pricesEntryExactPrintMatchesSource` helper.
// Directly exercise the shape so weakening it (or removing the strict
// check inside hasCurrentPriceProvenance's entry loop) fails a unit
// assertion, not just an integration one.
assert.equal(pricesEntryExactPrintMatchesSource({ imageUrl: VALID_HBP04_URL }, 'hBP04'), true);
assert.equal(pricesEntryExactPrintMatchesSource({ imageUrl: VALID_HBP02_URL }, 'hBP04'), false, 'origin-prefix carve-out NOT applied here');
assert.equal(pricesEntryExactPrintMatchesSource({ imageUrl: VALID_PROMO_HBP10_URL }, 'hPR'), true, 'known promo carve-out preserved for hPR');
assert.equal(pricesEntryExactPrintMatchesSource({ imageUrl: VALID_HBP01_URL }, 'ent07'), false, 'ent07 aggregation carve-out NOT applied here');
assert.equal(pricesEntryExactPrintMatchesSource({ imageUrl: EVIL_HOST_URL }, 'hBP01'), false, 'evil host fails at URL parse');
assert.equal(pricesEntryExactPrintMatchesSource({ imageUrl: '' }, 'hBP01'), false, 'empty URL fails');
assert.equal(pricesEntryExactPrintMatchesSource({}, 'hBP01'), false, 'missing imageUrl fails');
assert.equal(pricesEntryExactPrintMatchesSource({ imageUrl: VALID_HBP04_URL }, ''), false, 'empty sourceProduct fails');

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
// the real `scripts/build-database.js` with EXACTLY ONE defence disabled
// at a time via the test-only `HUNTERCARD_DIC1229_DISABLE_*` env hooks.
// This proves that each defence catches contamination on the SPECIFIC
// production path Mac-Codex CR rev.3 named — not merely a later
// catch-all throw:
//   Scenario A — BOTH defences enabled (baseline). Poisoned durable →
//                Step 6 skip fires → stdout carries `skipped N unproven
//                printings`, build exits 0, row.priceHistory empty.
//   Scenario B — HUNTERCARD_DIC1229_DISABLE_STEP6_SKIP=1 (only the
//                audit stands). Poisoned durable → merge writes the
//                priceHistory → audit MUST throw → build exits non-
//                zero with `[DIC-1229]` on stderr naming the poisoned
//                card id. A mutation that removes the audit lets the
//                build succeed with contaminated priceHistory — this
//                scenario then fails.
//   Scenario C — HUNTERCARD_DIC1229_DISABLE_AUDIT=1 (only Step 6 skip
//                stands). Poisoned durable → Step 6 skip prevents the
//                merge → build exits 0 with row.priceHistory empty. A
//                mutation that removes the Step 6 skip lets the merge
//                write priceHistory (audit disabled so nothing throws)
//                — this scenario then fails on the row assertion.
// The fault-injection env vars log to stdout on entry so their
// activation is auditable; they only affect Step 6 behaviour — nothing
// else in build-database.js reads them.
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
    'E2E preflight: the flagged row must be unproven going in (under the rev.3 strict predicate)',
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

  function seedPoisonedDurable() {
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
  }

  function resetShippedState() {
    fs.writeFileSync(dbPath, originalDb);
    fs.writeFileSync(nativePath, originalNative);
    for (const file of fs.readdirSync(historyDir).filter((f) => f.endsWith('.json'))) {
      if (!historySnapshot.has(file)) fs.unlinkSync(path.join(historyDir, file));
    }
    for (const [file, contents] of historySnapshot.entries()) {
      fs.writeFileSync(path.join(historyDir, file), contents);
    }
  }

  try {
    // Yuyu fixture returns no cards → build path exercises the DIC-1229
    // Step 6 gate + audit under the exact "no current provenance" shape.
    const fixtureFile = path.join(tmp, 'yuyu-fixture.json');
    fs.writeFileSync(
      fixtureFile,
      JSON.stringify({ prices: {}, totalCards: 0, seriesWithPrices: 0, pricingUnavailable: true }),
    );

    function runBuild(extraEnv = {}) {
      return spawnSync(process.execPath, ['scripts/build-database.js'], {
        cwd: REPO_ROOT,
        env: { ...process.env, HUNTERCARD_YUYU_FIXTURE_PATH: fixtureFile, ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 240000,
      });
    }

    // ─── Scenario A: baseline (both defences enabled) ─────────────────
    seedPoisonedDurable();
    let result = runBuild();
    let stdout = result.stdout?.toString() || '';
    let stderr = result.stderr?.toString() || '';
    assert.equal(
      result.status,
      0,
      `Scenario A (baseline): build should exit 0 with skip fail-closed. exit=${result.status} stderr tail:\n${stderr.slice(-1500)}`,
    );
    assert.match(
      stdout,
      /skipped\s+\d+\s+unproven printings \(DIC-1229 fail-closed\)/,
      `Scenario A (baseline): Step 6 skip counter must appear on stdout. stdout tail:\n${stdout.slice(-2000)}`,
    );
    {
      const skipMatch = stdout.match(/skipped\s+(\d+)\s+unproven printings/);
      assert.ok(
        skipMatch && Number(skipMatch[1]) >= 1,
        `Scenario A (baseline): skip counter must be ≥ 1 (got "${skipMatch?.[0] || 'no match'}")`,
      );
    }
    {
      const written = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
      const row = written.cards?.[CANONICAL_ID];
      const phSize = row?.priceHistory ? Object.keys(row.priceHistory).length : 0;
      assert.equal(phSize, 0, `Scenario A (baseline): row must ship empty priceHistory`);
    }

    // ─── Scenario B: DISABLE_STEP6_SKIP=1 → audit MUST fire ───────────
    resetShippedState();
    seedPoisonedDurable();
    result = runBuild({ HUNTERCARD_DIC1229_DISABLE_STEP6_SKIP: '1' });
    stdout = result.stdout?.toString() || '';
    stderr = result.stderr?.toString() || '';
    assert.match(
      stdout,
      /HUNTERCARD_DIC1229_DISABLE_STEP6_SKIP=1 — Step 6 skip DISABLED/,
      `Scenario B: fault-injection log line must confirm skip disabled. stdout tail:\n${stdout.slice(-1500)}`,
    );
    assert.notEqual(
      result.status,
      0,
      `Scenario B: build MUST exit non-zero when Step 6 skip is disabled (audit is the last line of defence). exit=${result.status} stderr tail:\n${stderr.slice(-1500)}`,
    );
    assert.match(
      stderr,
      /\[DIC-1229\][^\n]*unproven printing/,
      `Scenario B: build must fail with the DIC-1229 audit error. stderr tail:\n${stderr.slice(-2000)}`,
    );
    // The audit reports N unproven printings — verify N ≥ 1 (the seed
    // guarantees at least one violation; other unproven-with-durable
    // rows in the shipped DB may add to the count). This is mutation-
    // sensitive to audit removal (N would be 0 or the audit wouldn't
    // fire at all) without pinning to a specific card id, which can
    // paginate out of the top-5 rendered sample when the shipped DB
    // has other unproven rows (27 SEC signed printings whose durable
    // files carry legitimate multi-record history).
    const violationsMatch = stderr.match(/\[DIC-1229\]\s+(\d+)\s+unproven printing/);
    assert.ok(
      violationsMatch && Number(violationsMatch[1]) >= 1,
      `Scenario B: audit must report ≥ 1 violation (got "${violationsMatch?.[0] || 'no match'}"). stderr tail:\n${stderr.slice(-2000)}`,
    );

    // ─── Scenario C: DISABLE_AUDIT=1 → Step 6 skip MUST catch ─────────
    resetShippedState();
    seedPoisonedDurable();
    result = runBuild({ HUNTERCARD_DIC1229_DISABLE_AUDIT: '1' });
    stdout = result.stdout?.toString() || '';
    stderr = result.stderr?.toString() || '';
    assert.match(
      stdout,
      /HUNTERCARD_DIC1229_DISABLE_AUDIT=1 — post-Step-6 audit DISABLED/,
      `Scenario C: fault-injection log line must confirm audit disabled. stdout tail:\n${stdout.slice(-1500)}`,
    );
    assert.equal(
      result.status,
      0,
      `Scenario C: build should exit 0 when only skip fail-closes (audit disabled). exit=${result.status} stderr tail:\n${stderr.slice(-1500)}`,
    );
    assert.match(
      stdout,
      /skipped\s+\d+\s+unproven printings/,
      `Scenario C: Step 6 skip must still fire under audit-disabled. stdout tail:\n${stdout.slice(-1500)}`,
    );
    {
      const written = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
      const row = written.cards?.[CANONICAL_ID];
      const phSize = row?.priceHistory ? Object.keys(row.priceHistory).length : 0;
      assert.equal(
        phSize,
        0,
        `Scenario C: row must ship empty priceHistory even under audit disabled (skip is the last line of defence)`,
      );
    }

  } finally {
    restore();
  }
}

// =============================================================================
// SCHEDULER ENTRYPOINT LAYER — drive the poisoned printing through the
// REAL `scripts/local-scrape-and-push.sh` and prove contamination
// terminates non-zero at the SHELL boundary, not merely inside the
// direct-spawn of `scripts/build-database.js`. Mac-Codex CR rev.3
// explicitly asked for this: "prove contamination exits non-zero rather
// than only spawning scripts/build-database.js directly."
//
// Approach: build a real git repo sandbox with:
//   - the REAL `scripts/local-scrape-and-push.sh` copied in verbatim so
//     the pipeline structure (precondition / pull / scrapers / build /
//     commit / push) matches production byte-for-byte;
//   - the REAL `scripts/build-database.js` + `scripts/lib/` symlinked
//     so the DIC-1229 defences run for real, from source;
//   - `data/` seeded with a minimal but real official catalog subset
//     (data/official/, data/series-names.json, yt-stats, etc.) and the
//     shipped `data/database.json` so the fresh-build path assembles
//     the same cards map production sees;
//   - a bin/ PATH prefix that shims `git pull`, `git push`, `git
//     commit`, `npm`, and every non-build node script to trace + exit
//     0 (production-safe: no network, no commit, no push);
//   - poisoned durable file for `hBP01-090_hPR_P_hBP01-090_P_02`
//     COMMITTED into the sandbox git repo so the scheduler's clean-
//     worktree precondition passes and control reaches build-database.
//
// Scenario S (fault-injected contamination): run the scheduler with
// `HUNTERCARD_DIC1229_DISABLE_STEP6_SKIP=1` so the audit is the sole
// defence and MUST fire. Assert:
//   - shell exits non-zero (the `if ! node build-database.js` guard),
//   - the trace shows `git commit` and `git push` were NEVER invoked
//     (the build failure aborts the pipeline before mutation/commit),
//   - the log carries the `[DIC-1229]` audit error message.
// =============================================================================
{
  const CANONICAL_ID = 'hBP01-090_hPR_P_hBP01-090_P_02';
  const REAL_GIT = execSync('command -v git', { encoding: 'utf-8' }).trim();
  const REAL_NODE = process.execPath;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dic1229-sched-'));
  const repo = path.join(sandbox, 'repo');
  const bin = path.join(sandbox, 'bin');
  const trace = path.join(sandbox, 'trace.log');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(repo, 'data'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'data', 'price-history'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'data', 'buy-prices'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'public', 'data'), { recursive: true });
  fs.writeFileSync(trace, '');

  try {
    // ── Copy scripts (MUST NOT be a symlink) ────────────────────────────
    // Node resolves symlinks in `import.meta.url` by default, so a symlinked
    // scripts/ would make build-database.js's `__dirname` point back at
    // REPO_ROOT — every fs write would then hit the real repo, not the
    // sandbox. Copy the directory verbatim so the file identity stays
    // inside the sandbox and DATA_DIR resolves to sandbox/data.
    fs.cpSync(path.join(REPO_ROOT, 'scripts'), path.join(repo, 'scripts'), { recursive: true });
    // node_modules and package.json can safely stay symlinked (they are
    // read-only from build-database.js's perspective).
    fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(repo, 'node_modules'));
    fs.symlinkSync(path.join(REPO_ROOT, 'package.json'), path.join(repo, 'package.json'));
    if (fs.existsSync(path.join(REPO_ROOT, 'package-lock.json'))) {
      fs.symlinkSync(path.join(REPO_ROOT, 'package-lock.json'), path.join(repo, 'package-lock.json'));
    }

    // Data: symlink read-only inputs, copy the two files build-database
    // will overwrite (data/database.json, public/data/database.json).
    // Include every file / dir under data/ that build-database.js reads
    // during a full run — a missing bloom-levels.json, effects-*.json,
    // character-names-zh.json etc. all cause fail-closed exits that
    // mask the DIC-1229 audit we're trying to prove fires.
    for (const entry of [
      'official', 'images',
      'series-names.json', 'yt-members.json', 'yt-stats-history.json',
      'bloom-levels.json', 'effects-jp.json', 'effects-zh.json',
      'character-names-zh.json', 'deck-rules.json',
    ]) {
      const src = path.join(REPO_ROOT, 'data', entry);
      if (fs.existsSync(src)) {
        fs.symlinkSync(src, path.join(repo, 'data', entry));
      }
    }
    fs.copyFileSync(
      path.join(REPO_ROOT, 'data', 'database.json'),
      path.join(repo, 'data', 'database.json'),
    );
    fs.copyFileSync(
      path.join(REPO_ROOT, 'public', 'data', 'database.json'),
      path.join(repo, 'public', 'data', 'database.json'),
    );

    // ── Shim bin/ ───────────────────────────────────────────────────────
    // node: passes through for scripts/build-database.js only. Every other
    // script (scrape-*, trend-analysis, send-push-alerts, etc.) is shimmed
    // to trace + exit 0 so the sandbox is offline. The real build-database
    // still runs against the sandbox data.
    fs.writeFileSync(
      path.join(bin, 'node'),
      `#!/bin/bash
case "$1" in
  scripts/build-database.js|build-database.js)
    exec "${REAL_NODE}" "$@" ;;
esac
echo "[shim node] $*" >> "$TRACE_FILE"
exit 0
`,
      { mode: 0o755 },
    );
    // npm: everything traced + no-op.
    fs.writeFileSync(
      path.join(bin, 'npm'),
      `#!/bin/bash
echo "[shim npm] $*" >> "$TRACE_FILE"
exit 0
`,
      { mode: 0o755 },
    );
    // git: intercept only network / commit subcommands; everything else
    // passes to real git so `git status --porcelain` really classifies.
    fs.writeFileSync(
      path.join(bin, 'git'),
      `#!/bin/bash
echo "[shim git] $*" >> "$TRACE_FILE"
case "$1" in
  pull|push|commit) exit 0 ;;
esac
exec ${REAL_GIT} "$@"
`,
      { mode: 0o755 },
    );

    // ── Git init + initial commit ───────────────────────────────────────
    execSync(`${REAL_GIT} init -q -b main`, { cwd: repo });
    execSync(`${REAL_GIT} config user.email test@example.com`, { cwd: repo });
    execSync(`${REAL_GIT} config user.name test`, { cwd: repo });
    execSync(`${REAL_GIT} -c core.symlinks=true add .`, { cwd: repo });
    execSync(`${REAL_GIT} -c commit.gpgsign=false commit -q -m init`, { cwd: repo });

    // ── Seed the poisoned durable file inside the sandbox git repo ──────
    // Committed BEFORE running the scheduler so the clean-worktree
    // precondition passes and control reaches build-database.js. This is
    // exactly the shape Mac-Codex CR flagged: a stamped single-record
    // durable file for an unproven printing.
    const canonicalHistoryFile = path.join(repo, 'data', 'price-history', `${CANONICAL_ID.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
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
    execSync(`${REAL_GIT} add data/price-history/`, { cwd: repo });
    execSync(`${REAL_GIT} -c commit.gpgsign=false commit -q -m "seed poisoned durable"`, { cwd: repo });

    // ── Yuyu fixture for empty payload ──────────────────────────────────
    const fixtureFile = path.join(sandbox, 'yuyu-fixture.json');
    fs.writeFileSync(
      fixtureFile,
      JSON.stringify({ prices: {}, totalCards: 0, seriesWithPrices: 0, pricingUnavailable: true }),
    );

    // ── Run the REAL scheduler shell script with fault injection ────────
    // HUNTERCARD_DIC1229_DISABLE_STEP6_SKIP=1 leaves ONLY the audit
    // between the poisoned durable file and the shipped priceHistory.
    // The scheduler's `if ! node build-database.js` guard turns the
    // audit throw into shell `exit 1`.
    const result = spawnSync('bash', [path.join(repo, 'scripts', 'local-scrape-and-push.sh')], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: sandbox,
        TRACE_FILE: trace,
        HUNTERCARD_LOCK_FILE: path.join(sandbox, 'scrape.lock'),
        HUNTERCARD_YUYU_FIXTURE_PATH: fixtureFile,
        HUNTERCARD_DIC1229_DISABLE_STEP6_SKIP: '1',
      },
      encoding: 'utf-8',
      timeout: 300000,
    });
    const traceLines = fs.readFileSync(trace, 'utf-8').split('\n').filter(Boolean);
    const schedulerLog = fs.readFileSync(path.join(sandbox, '.hermes', 'logs', fs.readdirSync(path.join(sandbox, '.hermes', 'logs'))[0]), 'utf-8');

    assert.notEqual(
      result.status,
      0,
      `Scheduler: local-scrape-and-push.sh MUST exit non-zero when the poisoned durable file reaches the audit path. exit=${result.status}\ntrace:\n${traceLines.join('\n')}\nlog tail:\n${schedulerLog.slice(-3000)}`,
    );
    assert.match(
      schedulerLog,
      /build-database FAILED, exiting before downstream mutation\/commit/,
      `Scheduler: log must record the build-database failure guard firing. log tail:\n${schedulerLog.slice(-3000)}`,
    );
    assert.match(
      schedulerLog,
      /\[DIC-1229\][^\n]*unproven printing/,
      `Scheduler: log must include the DIC-1229 audit error message. log tail:\n${schedulerLog.slice(-3000)}`,
    );
    // Contamination must NOT have been committed or pushed — the
    // precondition + failure guard together mean commit/push shims
    // never fire.
    assert.equal(
      traceLines.some((l) => l.includes('[shim git] commit')),
      false,
      `Scheduler: no commit may fire when build-database aborts (trace):\n${traceLines.join('\n')}`,
    );
    assert.equal(
      traceLines.some((l) => l.includes('[shim git] push')),
      false,
      `Scheduler: no push may fire when build-database aborts (trace):\n${traceLines.join('\n')}`,
    );
    // The precondition must have PASSED (we committed the poison first)
    // so control reached build-database.js. Verify via trace / log.
    assert.match(
      schedulerLog,
      /Starting hunterCard local scrape/,
      `Scheduler: log must show entrypoint executed`,
    );
    // sanity: the shim node was actually invoked (proving we reached
    // step 2 which runs `node build-database.js`).
    assert.ok(
      traceLines.some((l) => l.includes('[shim node]')) || schedulerLog.includes('[DIC-1229]'),
      `Scheduler: build-database must have been reached (either via shim trace or DIC-1229 in log)`,
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
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
