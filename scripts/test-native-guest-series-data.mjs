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
 * staticData.ts (the base variant Metro serves to native, and Node/tsc resolve
 * to) imports the committed, pre-sanitized public/data/database.json plus
 * data/series-names.json; staticData.web.ts keeps the same-origin fetch for web.
 *
 * This test is trustworthy because it EXECUTES the real runtime path, not a
 * reimplementation (CR DIC-973):
 *   - it calls the native loader itself — loadDatabaseJson / loadSeriesNamesJson
 *     from staticData.ts — so a dead/removed import or a loader that returns
 *     unusable data fails here;
 *   - it feeds that output into buildSeriesCatalog, the SAME shared function
 *     HomeScreen renders from, so a regression in the screen's real extraction
 *     fails here too;
 *   - it audits the bytes the loader actually returned and pins them to
 *     sanitizeDatabase(data/database.json), so native stays Store-MVP fail-closed.
 *
 * The real Metro `expo export --platform android` audit lives in
 * scripts/test-store-mvp-native-export.mjs (retained, run separately in CI);
 * this complements it at the loader+screen runtime layer.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-ts.mjs \
 *        scripts/test-native-guest-series-data.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDatabaseJson, loadSeriesNamesJson } from '../src/utils/staticData.ts';
import { buildSeriesCatalog } from '../src/utils/seriesCatalog.ts';
import { FORBIDDEN_CARD_FIELDS, sanitizeDatabase } from './lib/store-mvp-sanitize.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf-8');

// ── 1. Execute the real native loader (the exact modules the native bundle runs) ──
const db = await loadDatabaseJson();
const seriesNames = await loadSeriesNamesJson();
assert.ok(db && typeof db === 'object', 'loadDatabaseJson() must return the parsed database object');
assert.ok(
  seriesNames && typeof seriesNames === 'object' && Object.keys(seriesNames).length > 0,
  'loadSeriesNamesJson() must return a non-empty series-name map',
);

// ── 2. The bytes the loader ACTUALLY returned are Store-MVP fail-closed ──
// Native runs no mapping/post-hook, so the loader output must itself be sanitized.
const cards = Object.values(db.cards ?? {});
assert.ok(cards.length > 0, 'loader database must contain cards');
for (const field of FORBIDDEN_CARD_FIELDS) {
  const leaks = cards.filter((c) => field in c).length;
  assert.equal(leaks, 0, `loader database must not carry ${field}`);
}
const nestedBuyPrice = cards.filter(
  (c) => Array.isArray(c.prices) && c.prices.some((p) => p && typeof p === 'object' && 'buyPrice' in p),
).length;
assert.equal(nestedBuyPrice, 0, 'loader database must not carry prices[].buyPrice');
const sellPriceKept = cards.filter((c) => 'sellPrice' in c).length;
assert.equal(sellPriceKept, cards.length, 'loader database keeps retail sellPrice on every card');

// Pin the loader output to sanitizeDatabase(canonical): if the import ever points
// at the raw canonical DB (or drifts), this deep-equal fails.
const canonical = JSON.parse(read('data/database.json'));
assert.deepEqual(db, sanitizeDatabase(canonical), 'loader must return exactly sanitizeDatabase(data/database.json)');
console.log(`Loader output fail-closed: ${cards.length} cards, 0 forbidden fields, ${sellPriceKept} keep sellPrice.`);

// ── 3. Run the SHARED production extraction HomeScreen renders from ──
const catalog = buildSeriesCatalog(db, seriesNames);
const totalSeries = catalog.boosters.length + catalog.starters.length + catalog.special.length;
assert.ok(totalSeries > 0, 'guest home must derive at least one series (else it shows 無法載入系列資料)');
assert.ok(catalog.boosters.length > 0, 'guest home must derive booster packs (hBP) from the loader data');
assert.ok(catalog.starters.length > 0, 'guest home must derive starter decks (hSD) from the loader data');
// Every catalog entry carries a resolved display name, and the series-name map is
// actually applied (not just the fallback code) for at least one known series.
for (const item of [...catalog.boosters, ...catalog.starters, ...catalog.special]) {
  assert.ok(item.label && item.query === item.label && item.name, `series item ${item.label} is well-formed`);
}
const namedFromMap = [...catalog.boosters, ...catalog.starters, ...catalog.special].some(
  (item) => seriesNames[item.label] && item.name === seriesNames[item.label],
);
assert.ok(namedFromMap, 'buildSeriesCatalog must apply the series-name map, not only fall back to the code');
console.log(
  `Guest home populates via shared extraction: ${totalSeries} series ` +
    `(${catalog.boosters.length} boosters, ${catalog.starters.length} starters, ${catalog.special.length} special).`,
);

// ── 4. Guard the executed path is the production path (no divergence, no relative fetch) ──
// HomeScreen must render from the same buildSeriesCatalog this test executes; the
// guest-browse screens must not reintroduce the relative fetch('/data/...') that
// broke native; the native loader must not fetch.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
assert.match(
  read('src/screens/HomeScreen.tsx'),
  /buildSeriesCatalog\(/,
  'HomeScreen must render from the shared buildSeriesCatalog this test exercises',
);
assert.doesNotMatch(
  stripComments(read('src/utils/staticData.ts')),
  /fetch\(/,
  'staticData.ts (native) must not fetch — RN cannot resolve the relative /data URL (the DIC-972 bug)',
);
for (const screen of ['src/screens/HomeScreen.tsx', 'src/screens/SearchResultsScreen.tsx']) {
  assert.doesNotMatch(
    stripComments(read(screen)),
    /fetch\('\/data\//,
    `${screen} must load via staticData, not a relative fetch('/data/...') that fails on native`,
  );
}
console.log('Executed path matches production HomeScreen extraction; no relative /data fetch reintroduced.');

console.log('DIC-972 native guest series-data regression checks passed');
