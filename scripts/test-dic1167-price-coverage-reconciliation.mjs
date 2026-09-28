#!/usr/bin/env node
/**
 * test-dic1167-price-coverage-reconciliation.mjs — DIC-1167 (2026-09-28).
 *
 * The 2026-09-28 scrape freshly listed 1,331 cardNumbers; the build exited 0
 * printing "1260 freshly-proven (1289 incl. preservation); 45 not priced"
 * while it actually shipped 1259 / 1288, and 71 yuyu-only fallback refusals
 * existed only as console lines. This regression pins, red-before-green:
 *
 *   1. Every refused listing set is recorded per cardNumber in
 *      data/price-rejections.json `listingRefusals`, with its candidate
 *      official printings (the hY01-001 nine-printing shape and the hBD24
 *      promo shape), and refused prices stay null.
 *   2. A refused cardNumber that keeps its own last source-proven payload
 *      (hBD24-001 hPR/P) is reported as preserved — never as a loss.
 *   3. The DIC-1334 audit reports the SHIPPED coverage: hBD24-064's only
 *      priced row (hBD24-064_ent07, cross-product promo-hbd20 image) is
 *      stripped before the audit, so "total incl. preservation" equals the
 *      manifest's `after.pricedUniqueCardNumbers` (was off by one).
 *   4. The scraped-vs-shipped reconciliation accounts for every scraped
 *      cardNumber, and a scraped positive-price cardNumber that ships
 *      unpriced with no recorded reason fails closed.
 *
 * Fixture listings for hY01-001 / hBD24-001 / hBD24-018 / hBD24-064 are the
 * real yuyu-tei rows captured by the 2026-09-26 scrape.
 *
 * Run: node scripts/test-dic1167-price-coverage-reconciliation.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  reconcileScrapedCoverage,
  reconciliationManifestBlock,
  formatReconciliationFailure,
} from './lib/price-coverage-reconciliation.mjs';
import { canonicalizeCardNumber } from './lib/card-number.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..');

// ── Unit: pure reconciliation ─────────────────────────────────────────────
{
  const listing = (sellPrice) => [{ sellPrice, rarity: 'C', yuyuImage: '' }];
  const prices = {
    'hA01-001': listing(100), // fresh
    'hA01-002': listing(100), // preserved (not fresh)
    'hA01-003': listing(100), // refused by fallback, unpriced
    'hA01-004': listing(100), // refused increase
    'hA01-005': listing(100), // ambiguity nulled
    'hA01-006': listing(0), //   no positive sell listing
    'hA01-007': listing(100), // silent loss
    'hA01-08': listing(0), //    short suffix — merges with hA01-008 below
    'hA01-008': listing(100), // refused by fallback but preserved
  };
  const cards = {
    a1: { cardNumber: 'hA01-001', sellPrice: 100 },
    a2: { cardNumber: 'hA01-002', sellPrice: 90 },
    a3: { cardNumber: 'hA01-003', sellPrice: null },
    a4: { cardNumber: 'hA01-004', sellPrice: null },
    a5: { cardNumber: 'hA01-005', sellPrice: null },
    a6: { cardNumber: 'hA01-006', sellPrice: null },
    a7: { cardNumber: 'hA01-007', sellPrice: null },
    a8: { cardNumber: 'hA01-008', sellPrice: 70 },
  };
  const base = {
    prices,
    canonicalizeCardNumber,
    cards,
    freshlyPricedRowIds: new Set(['a1', 'a4']),
    listingRefusals: new Map([['hA01-003', {}], ['hA01-008', {}]]),
    increaseRejections: [{ id: 'a4', cardNumber: 'hA01-004' }],
    ambiguityNulledIds: new Set(['a5']),
  };
  const r = reconcileScrapedCoverage(base);
  assert.equal(r.scrapedCardNumbers, 8, 'raw keys canonicalizing to one cardNumber count once');
  assert.deepEqual(r.categories.fresh, ['hA01-001']);
  assert.deepEqual(r.categories.preserved, ['hA01-002', 'hA01-008']);
  assert.deepEqual(r.preservedAfterFallbackRefusal, ['hA01-008']);
  assert.deepEqual(r.categories.refusedFallback, ['hA01-003']);
  assert.deepEqual(r.categories.refusedIncrease, ['hA01-004'], 'a fresh row stripped by the increase gate is not fresh');
  assert.deepEqual(r.categories.ambiguityNulled, ['hA01-005']);
  assert.deepEqual(r.categories.noSellListing, ['hA01-006']);
  assert.deepEqual(r.categories.unaccounted, ['hA01-007']);
  assert.equal(r.ok, false, 'a scraped positive-price cardNumber lost without a reason must fail closed');
  assert.match(formatReconciliationFailure(r), /1 scraped cardNumber\(s\).*hA01-007/);
  assert.equal(r.pricedCardNumbers + r.unpricedCardNumbers, r.scrapedCardNumbers, 'categories partition the scraped set');

  // Removing the refusal record turns a lawful refusal into a silent loss.
  const withoutRefusal = reconcileScrapedCoverage({ ...base, listingRefusals: new Map([['hA01-008', {}]]) });
  assert.ok(withoutRefusal.categories.unaccounted.includes('hA01-003'));

  // Once the loss is accounted for, the reconciliation passes.
  const clean = reconcileScrapedCoverage({
    ...base,
    prices: Object.fromEntries(Object.entries(prices).filter(([k]) => k !== 'hA01-007')),
  });
  assert.equal(clean.ok, true);
  const block = reconciliationManifestBlock(clean);
  assert.equal(block.counts.unaccounted, 0);
  assert.equal(block.fresh, undefined, 'the manifest block does not enumerate fresh cardNumbers');
  assert.equal(reconciliationManifestBlock(null), null);
  console.log('  ✓ unit: reconciliation partitions the scraped set and fails closed on a silent loss');
}

// ── Integration: real build-database.js run on real-shape listings ────────
const dbPath = path.join(repo, 'data/database.json');
const publicDbPath = path.join(repo, 'public/data/database.json');
const historyDir = path.join(repo, 'data/price-history');
const scrapeLogPath = path.join(repo, 'data/scrape-log.txt');
const manifestPath = path.join(repo, 'data/price-rejections.json');
const originalDb = fs.readFileSync(dbPath, 'utf8');
const originalPublicDb = fs.readFileSync(publicDbPath, 'utf8');
const preRunBytes = new Map();
for (const f of fs.readdirSync(historyDir)) {
  const p = path.join(historyDir, f);
  if (fs.statSync(p).isFile()) preRunBytes.set(p, fs.readFileSync(p));
}
for (const p of [scrapeLogPath, manifestPath]) {
  if (fs.existsSync(p)) preRunBytes.set(p, fs.readFileSync(p));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dic1167-reconcile-'));
let passed = false;
try {
  const prevCards = JSON.parse(originalDb).cards;
  const row = (id) => prevCards[id];
  // Preconditions on the committed baseline the scenario relies on.
  assert.equal(row('hBD24-064_ent07')?.sellPrice ?? null, null, 'baseline: hBD24-064_ent07 unpriced');
  assert.ok(row('hBD24-001_hPR_P_hBD24-001_P')?.sellPrice > 0, 'baseline: hBD24-001 hPR/P priced (last-known-good)');
  assert.equal(row('hBD24-018_hPR_P_hBD24-018_P_02')?.sellPrice ?? null, null, 'baseline: hBD24-018 unpriced');
  const hy01Printings = Object.keys(prevCards).filter((id) => prevCards[id].cardNumber === 'hY01-001');
  assert.ok(hy01Printings.length >= 6, `baseline: hY01-001 has many official printings (${hy01Printings.length})`);
  assert.ok(hy01Printings.every((id) => prevCards[id].sellPrice == null), 'baseline: hY01-001 unpriced');
  // hY01-014 has exactly one official printing; yuyu lists it as `hY01-14`.
  const noSellNum = 'hY01-014';
  const noSellRows = Object.keys(prevCards).filter((id) => prevCards[id].cardNumber === noSellNum);
  assert.deepEqual(noSellRows, ['hY01-014_hEB01_SY_hY01-014_SY'], 'baseline: hY01-014 has one official printing');
  assert.equal(prevCards[noSellRows[0]].sellPrice ?? null, null, 'baseline: hY01-014 unpriced');

  const promo = (cid, sellPrice, name) => ({
    sellPrice, rarity: 'P', name,
    yuyuImage: `https://card.yuyu-tei.jp/hocg/100_140/promo-hbd20/${cid}.jpg`,
    imageVersion: 'promo-hbd20', imageCid: cid, sourceSeries: 'ent07', timestamp: '2026-09-26T12:26:08.033Z',
  });
  const fixture = {
    prices: {
      'hBD24-064': [promo('10064', 8980, '大神ミオ')],
      'hBD24-001': [promo('10001', 39800, 'パヴォリア・レイネ')],
      'hBD24-018': [promo('10018', 9980, 'アユンダ・リス')],
      'hY01-001': [{
        sellPrice: 120, rarity: 'S', name: '白エール(S仕様)',
        yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/yell01/10065.jpg',
        imageVersion: 'yell01', imageCid: '10065', sourceSeries: 'hPC01', timestamp: '2026-09-26T12:26:33.037Z',
      }],
      'hBP03-025': [{
        sellPrice: 500, rarity: 'C', name: 'hBP03-025',
        yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/hbp03/dic1167.jpg',
        imageVersion: 'hbp03', imageCid: 'dic1167', sourceSeries: 'hbp03', timestamp: '2026-09-28T00:00:00.000Z',
      }],
      // Short-suffix key, a listing with no positive sell price.
      'hY01-14': [{
        sellPrice: 0, rarity: 'SY', name: '白エール',
        yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/heb01/dic1167.jpg',
        imageVersion: 'heb01', imageCid: 'dic1167', sourceSeries: 'heb01', timestamp: '2026-09-28T00:00:00.000Z',
      }],
    },
    totalCards: 100,
    seriesWithPrices: 1,
  };
  const fixturePath = path.join(tmp, 'yuyu-dic1167-reconcile.json');
  fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
  const build = spawnSync(process.execPath, ['scripts/build-database.js'], {
    cwd: repo,
    env: { ...process.env, HUNTERCARD_YUYU_FIXTURE_PATH: fixturePath, HUNTERCARD_SKIP_IMAGE_DOWNLOADS: '1' },
    encoding: 'utf8',
  });
  const out = `${build.stdout}\n${build.stderr}`;
  assert.equal(build.status, 0, `fixture build must succeed\n${out}`);

  const cards = JSON.parse(fs.readFileSync(dbPath, 'utf8')).cards;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const refusals = new Map((manifest.listingRefusals || []).map((r) => [r.cardNumber, r]));

  // 1. Refusals are durable, per cardNumber, with candidate printings; prices stay null.
  const hy = refusals.get('hY01-001');
  assert.ok(hy, 'hY01-001 listing refusal must be in the manifest');
  assert.equal(hy.reason, 'no-exact-printing-proven');
  assert.deepEqual([...hy.candidatePrintings].sort(), [...hy01Printings].sort(), 'refusal names every official candidate printing');
  assert.deepEqual(hy.listingImageProducts, ['yell01']);
  assert.deepEqual(hy.listingSellPrices, [120]);
  assert.ok(hy01Printings.every((id) => cards[id].sellPrice == null), 'hY01-001 printings stay null (no sibling fallback)');
  assert.equal(refusals.get('hBD24-018')?.reason, 'no-exact-printing-proven');
  assert.deepEqual(refusals.get('hBD24-018')?.candidatePrintings, ['hBD24-018_hPR_P_hBD24-018_P_02']);
  assert.equal(cards['hBD24-018_hPR_P_hBD24-018_P_02'].sellPrice, null);
  assert.ok(!(manifest.rejections || []).some((r) => r.id === 'hY01-001' || r.id === 'hBD24-018'),
    'listing refusals stay out of the per-printing rejections[] the DIC-1482 gate verifies');
  console.log('  ✓ fallback refusals recorded per cardNumber with candidate printings; refused prices stay null');

  // 2. Refused-but-preserved is preserved, not a loss.
  assert.ok(refusals.has('hBD24-001'), 'hBD24-001 refusal is recorded');
  assert.equal(cards['hBD24-001_hPR_P_hBD24-001_P'].sellPrice, row('hBD24-001_hPR_P_hBD24-001_P').sellPrice,
    'hBD24-001 keeps its own last source-proven price');
  assert.ok(manifest.coverage.preservedAfterFallbackRefusal.includes('hBD24-001'));
  assert.ok(!manifest.coverage.refusedFallback.includes('hBD24-001'));
  console.log('  ✓ refused-but-preserved cardNumber reported as preserved, not lost');

  // 3. The DIC-1334 audit reports what ships (post increase-strip).
  assert.ok((manifest.rejections || []).some((r) => r.id === 'hBD24-064_ent07' && r.reason === 'cross-product-image'),
    'hBD24-064_ent07 refused as cross-product-image');
  assert.equal(cards['hBD24-064_ent07'].sellPrice, null);
  assert.deepEqual(manifest.coverage.refusedIncrease, ['hBD24-064']);
  const audit = out.match(/\[DIC-1334\] final artifact keeps (\d+)\/(\d+) freshly-proven priced cardNumbers \((\d+) total incl\. preservation\)/);
  assert.ok(audit, `DIC-1334 audit line missing\n${out}`);
  assert.equal(Number(audit[3]), manifest.after.pricedUniqueCardNumbers,
    'DIC-1334 "total incl. preservation" must equal the shipped priced cardNumbers (post-strip)');
  assert.equal(Number(audit[1]), manifest.coverage.counts.fresh,
    'DIC-1334 freshly-proven coverage must exclude the stripped hBD24-064 row');
  const stripAt = out.indexOf('[DIC-1167] fail-closed 1 newly-priced row(s)');
  assert.ok(stripAt >= 0 && stripAt < out.indexOf('[DIC-1334] final artifact keeps'),
    'the increase strip must run before the DIC-1334 audit');
  console.log(`  ✓ DIC-1334 audit reports shipped coverage (${audit[1]} fresh / ${audit[3]} total = manifest)`);

  // 4. Full reconciliation of the scraped set.
  assert.deepEqual(manifest.coverage.counts, {
    fresh: 1, // hBP03-025
    preserved: 1, // hBD24-001
    refusedFallback: 2, // hBD24-018, hY01-001
    refusedIncrease: 1, // hBD24-064
    ambiguityNulled: 0,
    noSellListing: 1, // hY01-014 (scraped as hY01-14)
    unaccounted: 0,
    preservedAfterFallbackRefusal: 1,
  });
  assert.equal(manifest.coverage.scrapedCardNumbers, 6);
  assert.deepEqual(manifest.coverage.noSellListing, [noSellNum], 'short-suffix key reconciles under its canonical cardNumber');
  assert.equal(cards[noSellRows[0]].sellPrice ?? null, null, 'a zero-price listing publishes no price');
  assert.match(out, /\[DIC-1167\] price coverage reconciled: 6 scraped cardNumbers = 1 fresh \+ 1 preserved \(1 after fallback refusal\) \+ 2 refused-fallback \+ 1 refused-increase \+ 0 ambiguity-nulled \+ 1 no-sell-listing \+ 0 unaccounted; 3 listing refusal\(s\) recorded/);
  const builderSrc = fs.readFileSync(path.join(repo, 'scripts/build-database.js'), 'utf8');
  assert.match(builderSrc, /throw new Error\(formatReconciliationFailure\(coverageReconciliation\)\)/,
    'build-database.js must fail closed on an unreconciled scraped cardNumber');
  console.log('  ✓ scraped-vs-shipped reconciliation: 6 = 1 fresh + 1 preserved + 2 refused-fallback + 1 refused-increase + 1 no-sell-listing');

  console.log('✓ DIC-1167 price coverage reconciliation regression passed');
  passed = true;
} finally {
  fs.writeFileSync(dbPath, originalDb);
  fs.writeFileSync(publicDbPath, originalPublicDb);
  for (const f of fs.readdirSync(historyDir)) {
    const p = path.join(historyDir, f);
    if (!preRunBytes.has(p)) fs.rmSync(p, { recursive: true, force: true });
  }
  for (const [p, bytes] of preRunBytes) fs.writeFileSync(p, bytes);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (passed) {
    const dirty = [];
    if (fs.readFileSync(dbPath, 'utf8') !== originalDb) dirty.push(dbPath);
    if (fs.readFileSync(publicDbPath, 'utf8') !== originalPublicDb) dirty.push(publicDbPath);
    for (const f of fs.readdirSync(historyDir)) {
      const p = path.join(historyDir, f);
      if (!preRunBytes.has(p)) dirty.push(`${p} (new)`);
    }
    for (const [p, bytes] of preRunBytes) {
      if (!fs.existsSync(p) || !fs.readFileSync(p).equals(bytes)) dirty.push(p);
    }
    assert.deepEqual(dirty, [], `regression must be worktree-hermetic; still differing: ${dirty.join(', ')}`);
    console.log('  ✓ worktree-hermetic: every touched tracked file restored byte-for-byte');
  }
}
