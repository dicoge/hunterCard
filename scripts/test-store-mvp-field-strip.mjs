#!/usr/bin/env node
/**
 * QA DIC-915 / CR DIC-913 regression: Store MVP must fail-close the disabled
 * advanced fields (buyPrice, priceHistory, ytStats, prices[].buyPrice) at EVERY
 * boundary they can cross — not only the in-app card mapping, but the shipped web
 * export artifact and the recognize-card API response bytes — while full / non-MVP
 * mode preserves every field. Exercises the real profile resolution, the real API
 * ranking boundary, and the real built-artifact copy path (CR DIC-913 #3).
 *
 * Run: node --experimental-strip-types scripts/test-store-mvp-field-strip.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripDisabledCardFields } from '../src/utils/cardReleaseFilter.ts';
import {
  resolveStoreMvpFromEnv,
  sanitizeDatabase,
  stripForbiddenCardFields,
  copyDatabaseFile,
  FORBIDDEN_CARD_FIELDS,
} from './lib/store-mvp-sanitize.mjs';
import { rankCandidates } from '../api/recognize-card.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sampleCard = () => ({
  id: 'hBP04-005',
  cardNumber: 'hBP04-005',
  name: 'Test Card',
  sellPrice: 1200,
  buyPrice: 800,
  prices: [
    { name: 'ノーマル', sellPrice: 1200, rarity: 'R', buyPrice: 800, buyPriceVersion: 'BASE', buyPriceSource: 'torecolo', buyPriceTimestamp: '2026-08-14T12:15:00Z' },
    { name: 'サイン', sellPrice: 5000, rarity: 'SR', buyPrice: 3600, buyPriceVersion: 'SR', buyPriceSource: 'fullahead', buyPriceTimestamp: '2026-08-14T12:15:00Z' },
  ],
  priceHistory: { '2026-07-01': 1100, '2026-07-08': 1200 },
  buyPriceHistory: { '2026-07-01': 750, '2026-07-08': 800 },
  ytStats: { subscribers: 1000000, views: 5000000 },
});

const FULL_FLAGS = { buyPrice: true, trendPrediction: true, ytStats: true };
const MVP_FLAGS = { buyPrice: false, trendPrediction: false, ytStats: false };

// ── Full / non-MVP mode: every field preserved, input not mutated ──
const original = sampleCard();
const full = stripDisabledCardFields(sampleCard(), FULL_FLAGS);
assert.equal(full.buyPrice, 800, 'full mode keeps buyPrice');
assert.deepEqual(full.priceHistory, original.priceHistory, 'full mode keeps priceHistory');
assert.deepEqual(full.buyPriceHistory, original.buyPriceHistory, 'full mode keeps buyPriceHistory');
assert.deepEqual(full.ytStats, original.ytStats, 'full mode keeps ytStats');
assert.equal(full.prices[0].buyPrice, 800, 'full mode keeps prices[].buyPrice');
assert.equal(full.prices[1].buyPrice, 3600, 'full mode keeps every version buyPrice');
assert.equal(full.prices[0].buyPriceVersion, 'BASE', 'full mode keeps prices[].buyPriceVersion');
assert.equal(full.prices[1].buyPriceSource, 'fullahead', 'full mode keeps prices[].buyPriceSource');
assert.ok('buyPriceTimestamp' in full.prices[0], 'full mode keeps prices[].buyPriceTimestamp');

// ── Store MVP mode: disabled fields removed, sale price preserved ──
const input = sampleCard();
const mvp = stripDisabledCardFields(input, MVP_FLAGS);
assert.ok(!('buyPrice' in mvp), 'Store MVP strips card buyPrice');
assert.ok(!('buyPriceHistory' in mvp), 'Store MVP strips card buyPriceHistory (buy-back history)');
assert.ok(!('priceHistory' in mvp), 'Store MVP strips priceHistory');
assert.ok(!('ytStats' in mvp), 'Store MVP strips ytStats');
for (const p of mvp.prices) {
  assert.ok(!('buyPrice' in p), 'Store MVP strips prices[].buyPrice');
  assert.ok(!('buyPriceVersion' in p), 'Store MVP strips prices[].buyPriceVersion');
  assert.ok(!('buyPriceSource' in p), 'Store MVP strips prices[].buyPriceSource');
  assert.ok(!('buyPriceTimestamp' in p), 'Store MVP strips prices[].buyPriceTimestamp');
  assert.ok('sellPrice' in p, 'Store MVP keeps prices[].sellPrice (sale reference)');
}
// Sale reference price is a must-show field — never stripped.
assert.equal(mvp.sellPrice, 1200, 'Store MVP keeps sellPrice');
assert.equal(mvp.name, 'Test Card', 'Store MVP keeps non-market fields');
// Input object must not be mutated (shallow clone contract).
assert.equal(input.buyPrice, 800, 'strip does not mutate the input card');
assert.equal(input.prices[0].buyPrice, 800, 'strip does not mutate input prices');

// ── Per-flag independence ──
const onlyYt = stripDisabledCardFields(sampleCard(), { buyPrice: true, trendPrediction: true, ytStats: false });
assert.ok(!('ytStats' in onlyYt), 'ytStats-off strips ytStats only');
assert.equal(onlyYt.buyPrice, 800, 'ytStats-off keeps buyPrice');
assert.ok('buyPriceHistory' in onlyYt, 'ytStats-off keeps buyPriceHistory (buyPrice group still on)');
assert.ok('priceHistory' in onlyYt, 'ytStats-off keeps priceHistory');

// buyPrice-off strips the whole buy-back group (buyPrice + buyPriceHistory) but
// leaves the other advanced groups untouched.
const noBuy = stripDisabledCardFields(sampleCard(), { buyPrice: false, trendPrediction: true, ytStats: true });
assert.ok(!('buyPrice' in noBuy), 'buyPrice-off strips buyPrice');
assert.ok(!('buyPriceHistory' in noBuy), 'buyPrice-off strips buyPriceHistory');
assert.ok('priceHistory' in noBuy, 'buyPrice-off keeps priceHistory');
assert.ok('ytStats' in noBuy, 'buyPrice-off keeps ytStats');

// ── Build-context profile resolution (fail-closed opt-out, explicit opt-in) ──
assert.equal(resolveStoreMvpFromEnv({ EXPO_PUBLIC_STORE_MVP: '1' }), true, "env '1' → Store MVP on");
assert.equal(resolveStoreMvpFromEnv({ EXPO_PUBLIC_STORE_MVP: 'true' }), true, "env 'true' → on");
assert.equal(resolveStoreMvpFromEnv({ EXPO_PUBLIC_STORE_MVP: '0' }), false, "env '0' → off");
assert.equal(resolveStoreMvpFromEnv({ EXPO_PUBLIC_STORE_MVP: 'false' }), false, "env 'false' → off");
assert.equal(resolveStoreMvpFromEnv({}), false, 'unset → full web export preserved');
assert.equal(resolveStoreMvpFromEnv({ EXPO_PUBLIC_STORE_MVP: 'yes' }), false, "malformed 'yes' → off (web build has no native platform)");
assert.equal(resolveStoreMvpFromEnv({ EXPO_PUBLIC_STORE_MVP: '  ' }), false, 'whitespace → off');

// ── Shared DB sanitizer parity with the in-app mapping choke point ──
// The two independent code paths (data-asset sanitizer vs mapping filter) MUST
// remove the exact same field set, or one boundary drifts open. This pins them.
const sanitizedEntry = stripForbiddenCardFields(sampleCard());
const mappedEntry = stripDisabledCardFields(sampleCard(), MVP_FLAGS);
for (const field of [...FORBIDDEN_CARD_FIELDS]) {
  assert.ok(!(field in sanitizedEntry), `DB sanitizer strips card ${field}`);
  assert.ok(!(field in mappedEntry), `mapping filter strips card ${field}`);
}
assert.deepEqual(
  Object.keys(sanitizedEntry).sort(),
  Object.keys(mappedEntry).sort(),
  'DB sanitizer and mapping filter must expose the identical card key set (no drift)',
);
for (const p of sanitizedEntry.prices) {
  assert.ok(!('buyPrice' in p), 'DB sanitizer strips prices[].buyPrice');
  assert.ok(!('buyPriceVersion' in p), 'DB sanitizer strips prices[].buyPriceVersion');
  assert.ok(!('buyPriceSource' in p), 'DB sanitizer strips prices[].buyPriceSource');
  assert.ok(!('buyPriceTimestamp' in p), 'DB sanitizer strips prices[].buyPriceTimestamp');
  assert.ok('sellPrice' in p, 'DB sanitizer keeps prices[].sellPrice');
}
assert.equal(sanitizedEntry.sellPrice, 1200, 'DB sanitizer keeps card sellPrice');

// sanitizeDatabase walks the whole { cards } map without mutating the input.
const dbInput = { version: 3, cards: { 'hBP04-005::base': sampleCard() } };
const sanitizedDb = sanitizeDatabase(dbInput);
assert.equal(sanitizedDb.version, 3, 'sanitizeDatabase preserves top-level metadata');
assert.ok(!('buyPrice' in sanitizedDb.cards['hBP04-005::base']), 'sanitizeDatabase strips nested card buyPrice');
assert.ok(!('buyPriceHistory' in sanitizedDb.cards['hBP04-005::base']), 'sanitizeDatabase strips nested card buyPriceHistory');
assert.equal(dbInput.cards['hBP04-005::base'].buyPrice, 800, 'sanitizeDatabase does not mutate input db');

// ── Real recognize-card API response boundary (over-the-wire fields) ──
const apiCards = {
  'hBP04-005::base': {
    cardNumber: 'hBP04-005',
    name: 'Test Card',
    sellPrice: 1200,
    buyPrice: 800,
    rarity: 'R',
    series: 'hbp',
    officialImage: 'https://example/x.png',
    prices: [
      { name: 'ノーマル', sellPrice: 1200, rarity: 'R', buyPrice: 800, buyPriceVersion: 'BASE', buyPriceSource: 'torecolo', buyPriceTimestamp: '2026-08-14T12:15:00Z' },
      { name: 'サイン', sellPrice: 5000, rarity: 'SR', buyPrice: 3600, buyPriceVersion: 'SR', buyPriceSource: 'fullahead', buyPriceTimestamp: '2026-08-14T12:15:00Z' },
    ],
    priceHistory: { '2026-07-01': 1100, '2026-07-08': 1200 },
    buyPriceHistory: { '2026-07-01': 750, '2026-07-08': 800 },
    ytStats: { subscribers: 1000000, views: 5000000 },
  },
};
const extracted = { cardNumberRaw: 'hBP04-005', characterName: 'Test Card', rarity: 'R', hp: '', bloom: '', cardTitle: '' };

// Full / web / non-MVP request (no storeMvp): the API still returns advanced fields.
const fullRanking = rankCandidates(apiCards, extracted);
const fullBest = fullRanking.candidates[0];
assert.ok(fullBest, 'API ranks the exact-number match');
assert.equal(fullBest.sellPrice, 1200, 'API keeps sellPrice');
assert.equal(fullBest.buyPrice, 800, 'non-MVP API response carries buyPrice');
assert.deepEqual(fullBest.priceHistory, apiCards['hBP04-005::base'].priceHistory, 'non-MVP API carries priceHistory');
assert.ok(fullBest.ytStats, 'non-MVP API carries ytStats');
assert.equal(fullBest.prices[0].buyPrice, 800, 'non-MVP API carries prices[].buyPrice');
// buyPriceHistory is never part of the recognize-card response whitelist (fmt()),
// so it must not surface in either profile — including the non-MVP one.
assert.ok(!('buyPriceHistory' in fullBest), 'API whitelist never surfaces buyPriceHistory');

// Store MVP request: the response bytes must NOT contain the forbidden fields.
const mvpRanking = rankCandidates(apiCards, extracted, true);
const mvpBest = mvpRanking.candidates[0];
assert.ok(mvpBest, 'API still ranks the match under Store MVP');
assert.equal(mvpBest.sellPrice, 1200, 'Store MVP API keeps sellPrice');
assert.ok(!('buyPrice' in mvpBest), 'Store MVP API response omits buyPrice');
assert.ok(!('buyPriceHistory' in mvpBest), 'Store MVP API response omits buyPriceHistory');
assert.ok(!('priceHistory' in mvpBest), 'Store MVP API response omits priceHistory');
assert.ok(!('ytStats' in mvpBest), 'Store MVP API response omits ytStats');
for (const p of mvpBest.prices) {
  assert.ok(!('buyPrice' in p), 'Store MVP API response omits prices[].buyPrice');
  assert.ok(!('buyPriceVersion' in p), 'Store MVP API response omits prices[].buyPriceVersion');
  assert.ok(!('buyPriceSource' in p), 'Store MVP API response omits prices[].buyPriceSource');
  assert.ok(!('buyPriceTimestamp' in p), 'Store MVP API response omits prices[].buyPriceTimestamp');
  assert.ok('sellPrice' in p, 'Store MVP API response keeps prices[].sellPrice');
}

// ── Real built-artifact copy path against the shipped database.json ──
const realDb = path.join(__dirname, '..', 'data', 'database.json');
if (fs.existsSync(realDb)) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-mvp-artifact-'));
  try {
    // Full web export: byte-identical copy (existing web production unchanged).
    const fullDest = path.join(tmpDir, 'full', 'database.json');
    copyDatabaseFile(realDb, fullDest, false);
    assert.ok(
      fs.readFileSync(fullDest).equals(fs.readFileSync(realDb)),
      'non-MVP export copies database.json byte-identically',
    );

    // Store MVP export: forbidden fields stripped from every real card.
    const mvpDest = path.join(tmpDir, 'mvp', 'database.json');
    const { sanitized } = copyDatabaseFile(realDb, mvpDest, true);
    assert.equal(sanitized, true, 'Store MVP export reports sanitized');
    // Count forbidden fields in the SOURCE so the audit proves it removed real
    // data (not a vacuous pass) — CR DIC-913 flagged buyPriceHistory specifically.
    const srcDb = JSON.parse(fs.readFileSync(realDb, 'utf-8'));
    const srcForbidden = Object.fromEntries(FORBIDDEN_CARD_FIELDS.map((f) => [f, 0]));
    for (const entry of Object.values(srcDb.cards ?? {})) {
      for (const field of FORBIDDEN_CARD_FIELDS) if (field in entry) srcForbidden[field]++;
    }
    assert.ok(srcForbidden.buyPriceHistory > 0, 'source database actually contains buyPriceHistory to strip');

    const builtDb = JSON.parse(fs.readFileSync(mvpDest, 'utf-8'));
    let inspected = 0;
    let sellPricesKept = 0;
    const builtForbidden = Object.fromEntries(FORBIDDEN_CARD_FIELDS.map((f) => [f, 0]));
    for (const entry of Object.values(builtDb.cards ?? {})) {
      inspected++;
      for (const field of FORBIDDEN_CARD_FIELDS) {
        if (field in entry) builtForbidden[field]++;
        assert.ok(!(field in entry), `built Store MVP artifact must not retain card ${field}`);
      }
      if (Array.isArray(entry.prices)) {
        for (const p of entry.prices) {
          assert.ok(!('buyPrice' in p), 'built Store MVP artifact must not retain prices[].buyPrice');
          assert.ok(!('buyPriceVersion' in p), 'built artifact must not retain prices[].buyPriceVersion');
          assert.ok(!('buyPriceSource' in p), 'built artifact must not retain prices[].buyPriceSource');
          assert.ok(!('buyPriceTimestamp' in p), 'built artifact must not retain prices[].buyPriceTimestamp');
        }
      }
      if ('sellPrice' in entry) sellPricesKept++;
    }
    assert.ok(inspected > 0, 'built artifact contains cards to inspect');
    assert.ok(sellPricesKept > 0, 'built Store MVP artifact preserves retail sellPrice');
    for (const field of FORBIDDEN_CARD_FIELDS) {
      assert.equal(builtForbidden[field], 0, `zero ${field} occurrences in Store MVP artifact`);
    }
    console.log(`Inspected ${inspected} built Store MVP cards; ${sellPricesKept} retain sellPrice.`);
    console.log(`Source forbidden-field counts stripped: ${JSON.stringify(srcForbidden)} → all 0 in artifact.`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
} else {
  console.log('  ⚠️ data/database.json not present — skipped built-artifact inspection');
}

// ── At-rest committed native asset (public/data/database.json) — DIC-916 ──
// A native export (expo export/prebuild) copies public/ verbatim with NO post-hook,
// so the ONLY fail-closed guarantee for the store bundle is that this committed file
// is already sanitized. It is env-independent, so this one check covers every native
// Store MVP profile (unset/unknown/malformed/explicit). The real end-to-end export
// audit lives in test:store-mvp-native-export; this keeps a cheap guard in the fast
// suite so a re-generated full public asset can never land unnoticed.
const nativeAsset = path.join(__dirname, '..', 'public', 'data', 'database.json');
if (fs.existsSync(nativeAsset)) {
  const nativeDb = JSON.parse(fs.readFileSync(nativeAsset, 'utf-8'));
  let nativeCards = 0;
  let nativeSellKept = 0;
  const nativeForbidden = Object.fromEntries(FORBIDDEN_CARD_FIELDS.map((f) => [f, 0]));
  for (const entry of Object.values(nativeDb.cards ?? {})) {
    nativeCards++;
    for (const field of FORBIDDEN_CARD_FIELDS) if (field in entry) nativeForbidden[field]++;
    if (Array.isArray(entry.prices)) {
      for (const p of entry.prices) {
        assert.ok(!('buyPrice' in p), 'committed native asset must not retain prices[].buyPrice');
        assert.ok(!('buyPriceVersion' in p), 'committed native asset must not retain prices[].buyPriceVersion');
        assert.ok(!('buyPriceSource' in p), 'committed native asset must not retain prices[].buyPriceSource');
        assert.ok(!('buyPriceTimestamp' in p), 'committed native asset must not retain prices[].buyPriceTimestamp');
      }
    }
    if ('sellPrice' in entry) nativeSellKept++;
  }
  assert.ok(nativeCards > 0, 'committed native asset contains cards');
  for (const field of FORBIDDEN_CARD_FIELDS) {
    assert.equal(nativeForbidden[field], 0, `committed public/data/database.json must not retain ${field}`);
  }
  assert.equal(nativeSellKept, nativeCards, 'committed native asset preserves retail sellPrice on every card');
  console.log(`Committed native asset: ${nativeCards} cards, 0 forbidden fields, ${nativeSellKept} retain sellPrice.`);
} else {
  console.log('  ⚠️ public/data/database.json not present — skipped native at-rest inspection');
}

console.log('Store MVP field-strip regression checks passed');
