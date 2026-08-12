#!/usr/bin/env node
/**
 * DIC-972 regression: the guest Android/native home must load series/card data.
 *
 * The bug: HomeScreen/SearchResultsScreen fetched '/data/database.json' and
 * '/data/series-names.json' by ROOT-RELATIVE URL. Web resolves those same-origin,
 * but React Native's fetch cannot resolve a relative URL — so every native guest
 * data load threw and the home rendered "無法載入系列資料".
 *
 * The fix: native reads the data it already SHIPS in its bundle. src/utils/
 * staticData.ts (the base variant Metro serves to native, and tsc/Node) requires
 * the committed, pre-sanitized public/data/database.json plus data/series-names.json;
 * src/utils/staticData.web.ts keeps the same-origin fetch for web. This test pins
 * that native runtime data path end to end WITHOUT a device:
 *   1. native binds to the SANITIZED asset (never the canonical DB, never fetch),
 *   2. the exact bytes native loads are fail-closed (0 forbidden fields, sellPrice
 *      kept, byte-equal sanitizeDatabase(data/database.json)),
 *   3. the real HomeScreen extraction over those bytes yields non-empty series —
 *      i.e. the guest home populates instead of showing 無法載入系列資料,
 *   4. no screen reintroduces the relative fetch('/data/...') that broke native.
 *
 * The real-export fail-closed audit lives in test-store-mvp-native-export.mjs; this
 * complements it by proving the runtime LOADER reads that sanitized asset and the
 * guest UI data actually materialises from it.
 *
 * Run: node scripts/test-native-guest-series-data.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORBIDDEN_CARD_FIELDS } from './lib/store-mvp-sanitize.mjs';
import { buildNativeDatabaseString } from './generate-native-database.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
// Strip block + line comments so "must NOT" checks inspect real code, not prose.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// ── 1. Native loader binds to the sanitized bundle asset, never network/canonical ──
const nativeLoader = read('src/utils/staticData.ts');
const nativeLoaderCode = stripComments(nativeLoader);
assert.match(
  nativeLoader,
  /require\('\.\.\/\.\.\/public\/data\/database\.json'\)/,
  'staticData.ts (native) must require the SANITIZED public/data/database.json',
);
assert.match(
  nativeLoader,
  /require\('\.\.\/\.\.\/data\/series-names\.json'\)/,
  'staticData.ts (native) must require data/series-names.json',
);
assert.doesNotMatch(
  nativeLoaderCode,
  /'\.\.\/\.\.\/data\/database\.json'/,
  'staticData.ts (native) must NOT read the canonical data/database.json — it can carry forbidden fields',
);
assert.doesNotMatch(
  nativeLoaderCode,
  /fetch\(/,
  'staticData.ts (native) must NOT fetch — RN cannot resolve the relative /data URL (the DIC-972 bug)',
);

// Web variant keeps the same-origin relative fetch (unchanged web behavior).
const webLoader = read('src/utils/staticData.web.ts');
assert.match(webLoader, /fetch\(/, 'staticData.web.ts must fetch the same-origin assets on web');
assert.match(webLoader, /'\/data\/database\.json'/, 'staticData.web.ts targets /data/database.json');
assert.match(webLoader, /'\/data\/series-names\.json'/, 'staticData.web.ts targets /data/series-names.json');
console.log('Native loader binds to sanitized bundle asset; web loader keeps same-origin fetch.');

// ── 2. The exact bytes native loads are fail-closed ──
const committedBytes = read('public/data/database.json');
const nativeDb = JSON.parse(committedBytes);
const cards = Object.values(nativeDb.cards ?? {});
assert.ok(cards.length > 0, 'native bundled asset contains cards');
for (const field of FORBIDDEN_CARD_FIELDS) {
  const leaks = cards.filter((c) => field in c).length;
  assert.equal(leaks, 0, `native bundled asset must not carry ${field}`);
}
const nestedBuyPrice = cards.filter(
  (c) => Array.isArray(c.prices) && c.prices.some((p) => p && typeof p === 'object' && 'buyPrice' in p),
).length;
assert.equal(nestedBuyPrice, 0, 'native bundled asset must not carry prices[].buyPrice');
const sellPriceKept = cards.filter((c) => 'sellPrice' in c).length;
assert.equal(sellPriceKept, cards.length, 'native bundled asset keeps retail sellPrice on every card');
assert.equal(
  committedBytes,
  buildNativeDatabaseString(),
  'native bundled asset must byte-equal sanitizeDatabase(data/database.json) — run scripts/generate-native-database.mjs',
);
console.log(`Native bytes fail-closed: ${cards.length} cards, 0 forbidden fields, ${sellPriceKept} keep sellPrice.`);

// ── 3. Real HomeScreen extraction over the native bytes yields non-empty series ──
// Mirrors src/screens/HomeScreen.tsx fetchSeriesData exactly.
const seriesNames = JSON.parse(read('data/series-names.json'));
const seriesSet = new Set();
for (const card of cards) {
  const s = card.series || '';
  if (s) seriesSet.add(s);
}
const allSeries = Array.from(seriesSet)
  .sort()
  .map((code) => ({ label: code, query: code, name: seriesNames[code] || code }));
const boosters = allSeries.filter((s) => s.label.startsWith('hBP'));
const starters = allSeries.filter((s) => s.label.startsWith('hSD'));
const special = allSeries.filter((s) => !s.label.startsWith('hBP') && !s.label.startsWith('hSD'));
assert.ok(allSeries.length > 0, 'guest home must derive at least one series (else it shows 無法載入系列資料)');
assert.ok(boosters.length > 0, 'guest home must derive booster packs (hBP) from the native asset');
assert.ok(starters.length > 0, 'guest home must derive starter decks (hSD) from the native asset');
console.log(
  `Guest home populates on native: ${allSeries.length} series (${boosters.length} boosters, ${starters.length} starters, ${special.length} special).`,
);

// ── 4. No screen reintroduces the relative fetch('/data/...') that broke native ──
for (const screen of ['src/screens/HomeScreen.tsx', 'src/screens/SearchResultsScreen.tsx']) {
  assert.doesNotMatch(
    stripComments(read(screen)),
    /fetch\('\/data\//,
    `${screen} must load via staticData, not a relative fetch('/data/...') that fails on native`,
  );
}
console.log('No guest-browse screen reintroduces the relative /data fetch.');

console.log('DIC-972 native guest series-data regression checks passed');
