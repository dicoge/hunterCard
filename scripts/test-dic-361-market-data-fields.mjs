#!/usr/bin/env node
/**
 * Regression checks for DIC-361 / DIC-359:
 * ensure scan, API fallback, and search paths preserve MarketDataPanel fields.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const apiRecognize = read('api/recognize-card.ts');
const cardRecognition = read('src/services/cardRecognition.ts');
const scanScreen = read('src/screens/ScanScreen.tsx');
const apiCardMapper = read('src/utils/apiCardMapper.ts');
const searchResults = read('src/screens/SearchResultsScreen.tsx');
const cardDetail = read('src/screens/CardDetailScreen.tsx');
const zhLocale = read('src/i18n/locales/zh.ts');
const jaLocale = read('src/i18n/locales/ja.ts');
const database = JSON.parse(read('data/database.json'));

function assertSourceIncludes(source, needles, label) {
  for (const needle of needles) {
    assert.ok(
      source.includes(needle),
      `${label} should include: ${needle}`,
    );
  }
}

// Test fixture: at least one real card must exercise every MarketDataPanel section.
const marketFixture = Object.values(database.cards ?? {}).find((card) =>
  Number(card.sellPrice) > 0 &&
  Number(card.buyPrice) > 0 &&
  card.priceHistory &&
  Object.keys(card.priceHistory).length >= 2 &&
  card.ytStats &&
  Object.values(card.ytStats).some((value) => value != null)
);

assert.ok(marketFixture, 'database should contain a card with sellPrice, buyPrice, priceHistory, and ytStats');

// API recognize-card response must expose all fields consumed by MarketDataPanel.
assertSourceIncludes(apiRecognize, [
  'buyPrice: entry.buyPrice ?? null',
  'priceHistory: entry.priceHistory || {}',
  'ytStats: entry.ytStats ?? null',
], 'api/recognize-card fmt()');

// The single shared pure mapper (unit-tested directly in test-api-card-mapper.mjs)
// is the one place the scan/API fields are produced. Assert it passes them through.
assertSourceIncludes(apiCardMapper, [
  'export function mapApiCardToCardInfo',
  'buyPrice: raw.buyPrice ?? null',
  'priceHistory: raw.priceHistory || {}',
  'ytStats: raw.ytStats ?? null',
], 'src/utils/apiCardMapper');

// Local recognition / Tesseract fallback path must preserve the same fields, and
// the API path must route through the shared mapper (no bespoke duplicate mapper).
assertSourceIncludes(cardRecognition, [
  'buyPrice?: number | null',
  'priceHistory?: Record<string, number>',
  'ytStats?: any',
  'buyPrice: (entry as any).buyPrice ?? null',
  'priceHistory: (entry as any).priceHistory || {}',
  'ytStats: (entry as any).ytStats ?? null',
  "import { mapApiCardToCardInfo } from '../utils/apiCardMapper'",
  'stripDisabledCardFields(mapApiCardToCardInfo(apiCard), releaseCardFlags())',
], 'src/services/cardRecognition');

// Camera/API success + candidates path must route through the shared mapper (so the
// session card carries buyPrice/priceHistory/ytStats) and navigate it to CardDetail.
assertSourceIncludes(scanScreen, [
  "import { mapApiCardToCardInfo } from '../utils/apiCardMapper'",
  'stripDisabledCardFields(mapApiCardToCardInfo(c), releaseCardFlags())',
  "onViewCard={(card) => navigation?.navigate('CardDetail', { card })}",
], 'src/screens/ScanScreen');

// Search route regression: search cards still carry the same market fields.
assertSourceIncludes(searchResults, [
  'sellPrice: c.sellPrice ?? null',
  'buyPrice: c.buyPrice ?? null',
  'ytStats: c.ytStats ?? null',
  'priceHistory: c.priceHistory || {}',
], 'src/screens/SearchResultsScreen');

// MarketDataPanel should render all requested sections when fields exist.
// DIC-856: buyPrice is no longer read from the card level; it is derived from the
// *selected version* (selectedVersion.buyPrice) and fails closed to null when the
// version is unaligned or has no matched buy price — never a card-number/max fallback.
// The assertion tracks that exact derivation so this regression stays consistent with
// DIC-856's exact-variant alignment instead of the pre-DIC-856 card-level read.
assertSourceIncludes(cardDetail, [
  'function MarketDataPanel',
  'const buyPrice = aligned ? (selectedVersion?.buyPrice ?? null) : null',
  'const ytStats = card?.ytStats ?? null',
  'const priceHistory = card?.priceHistory ?? null',
  "t('card_detail_spread_title', { version: versionLabel })",
  "t('card_detail_youtube_data')",
  'priceTrend',
], 'src/screens/CardDetailScreen MarketDataPanel');

// The labels are localized, so keep the DIC-361 copy contract mutation-sensitive
// at both ends: MarketDataPanel must request these keys (above), and each locale
// must retain the approved user-facing text.
assertSourceIncludes(zhLocale, [
  "card_detail_spread_title: '💱 買賣差價（{{version}}）'",
  "card_detail_youtube_data: '📺 YouTube 成員數據'",
], 'src/i18n/locales/zh DIC-361 labels');

assertSourceIncludes(jaLocale, [
  "card_detail_spread_title: '💱 売買価格差（{{version}}）'",
  "card_detail_youtube_data: '📺 YouTube メンバーデータ'",
], 'src/i18n/locales/ja DIC-361 labels');

console.log('DIC-361 market data field regression checks passed');
console.log(JSON.stringify({
  fixture: {
    id: marketFixture.id,
    cardNumber: marketFixture.cardNumber,
    name: marketFixture.name,
    sellPrice: marketFixture.sellPrice,
    buyPrice: marketFixture.buyPrice,
    priceHistoryDays: Object.keys(marketFixture.priceHistory ?? {}).length,
    ytStatsKeys: Object.keys(marketFixture.ytStats ?? {}).filter((key) => marketFixture.ytStats[key] != null),
  },
}, null, 2));
