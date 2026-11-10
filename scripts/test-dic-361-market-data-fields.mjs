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
const canonicalRecord = read('src/utils/canonicalCardRecord.ts');
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
  // Last-known price (2026-11-07): the WHOLE session card still travels (spread first,
  // so buyPrice/priceHistory/ytStats are untouched) plus that printing's own quote time.
  "onViewCard={(card) => navigation?.navigate('CardDetail', { card: { ...card, ...scanQuoteProvenance(card) } })}",
  "import { scanQuoteProvenance } from '../utils/scanQuoteProvenance'",
], 'src/screens/ScanScreen');

// Search/favorites route regression: DIC-1430 moved the record → CardDetail
// mapper into one shared pure module so the two routes cannot drift. Assert the
// market fields where they are now produced, and assert the search route really
// routes through that mapper instead of keeping a bespoke duplicate.
assertSourceIncludes(canonicalRecord, [
  'export function toCanonicalCardRecord',
  'sellPrice: c.sellPrice ?? null',
  'buyPrice: c.buyPrice ?? null',
  'ytStats: c.ytStats ?? null',
  'priceHistory: c.priceHistory || {}',
], 'src/utils/canonicalCardRecord');

// Last-known price (2026-11-07): the 4th argument is the card number's own rows (or the
// lone row), from which per-printing quote times are derived — never a sibling's.
assertSourceIncludes(searchResults, [
  "from '../utils/canonicalCardRecord'",
  'toCanonicalCardRecord(c, nameMap, cardFlags, siblings && siblings.length > 0 ? siblings : [row])',
], 'src/screens/SearchResultsScreen');
// The per-printing records are derived ONCE from the card number's own rows through the deck
// adapter, and BOTH the quote times and the retained status are taken from those same records
// (2026-11-07 retained-status refactor; previously the adapter call was inlined in
// printingQuoteTimes(...)). The runtime control below proves the behaviour, not just the text.
assertSourceIncludes(canonicalRecord, [
  'quoteRows?: ReadonlyArray<CardRecord>',
  'const quoteRecords = hasRows ? adaptCardNumber(quoteRows!.map(asQuoteRow)).priceRecords : [];',
  'printingQuotedAt: hasRows ? printingQuoteTimes(quoteRecords) : undefined,',
  'printingRetained: hasRows ? printingRetainedMap(quoteRows!, quoteRecords) : undefined,',
  'const base = toCanonicalCardRecord(merged, nameMap, undefined, rows);',
], 'src/utils/canonicalCardRecord last-known quote provenance');

// Runtime control (synthetic rows; no market data): each exact physical printing keeps ITS OWN
// sale quote time and retained status through the canonical adapter — never a sibling's, never
// a global / catalog date — and equals the adapter-derived records.
{
  process.env.EXPO_PUBLIC_STORE_MVP = '0';
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://holohunter.dicoge.com/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  for (const key of Object.getOwnPropertyNames(dom.window)) {
    if (key in globalThis) continue;
    try { globalThis[key] = dom.window[key]; } catch {}
  }
  let mods;
  try {
    mods = {
      ...(await import('../src/utils/canonicalCardRecord.ts')),
      ...(await import('../src/utils/deckCardData.ts')),
      ...(await import('../src/utils/priceFreshness.ts')),
    };
  } catch (err) {
    throw new Error(`DIC-361 runtime control needs the TS loader (npm run test:market-fields): ${err.message}`);
  }
  const { toCanonicalCardRecord, buildCanonicalCardIndex, dedupeListings, adaptCardNumber, printingQuoteTimes } = mods;
  const FULL = { buyPrice: true, trendPrediction: true, ytStats: true };
  const FRESH_TS = '2026-11-06T12:00:00.000Z';
  const OLD_TS = '2026-08-25T03:04:05.678Z';
  const row = (over) => ({
    cardNumber: 'hZZ97-361', name: 'テスト', nameZh: '測試卡', type: 'ホロメン', color: 'white', hp: '100',
    officialImage: '', localImage: '', yuyuName: '', yuyuImage: '', ...over,
  });
  const base = row({ id: 'hZZ97-361_hBP01_R', series: 'hBP01', sourceProduct: 'hBP01', rarity: 'R', sellPrice: 120, timestamp: FRESH_TS,
    prices: [{ name: 'テスト', sellPrice: 120, rarity: 'R' }] });
  const parallel = row({ id: 'hZZ97-361_hBP08_SR', series: 'hBP08', sourceProduct: 'hBP08', rarity: 'SR', sellPrice: 3480, timestamp: OLD_TS,
    sellQuoteRetained: true, prices: [{ name: 'テスト(パラレル)', sellPrice: 3480, rarity: 'SR' }] });
  const rows = [base, parallel];
  const merged = (rep) => ({ ...rep, prices: dedupeListings(rows.flatMap((r) => r.prices)) });

  const card = toCanonicalCardRecord(merged(base), {}, FULL, rows);
  assert.deepEqual(card.printingQuotedAt, { BASE: FRESH_TS, PARALLEL: OLD_TS }, 'each printing keeps its own quote time (no sibling borrowing)');
  assert.deepEqual(card.printingQuotedAt, printingQuoteTimes(adaptCardNumber(rows).priceRecords), 'quote times are exactly the adapter-derived records');
  assert.deepEqual(card.printingRetained, { PARALLEL: true }, 'retained status follows the printing whose own row retained it');
  assert.equal(card.priceQuotedAt, FRESH_TS, 'headline = the elected row\'s own time');
  assert.equal(card.priceRetained, false);
  assert.equal(card.sellPrice, 120, 'market field still passes through');

  const viaParallel = toCanonicalCardRecord(merged(parallel), {}, FULL, rows);
  assert.equal(viaParallel.priceQuotedAt, OLD_TS, 'electing the other printing changes the headline to ITS time');
  assert.equal(viaParallel.priceRetained, true);
  assert.deepEqual(viaParallel.printingQuotedAt, card.printingQuotedAt, 'per-printing times do not depend on the representative');

  const index = buildCanonicalCardIndex(rows, {});
  const p = index.resolve('hZZ97-361', 'PARALLEL');
  const b = index.resolve('hZZ97-361', 'BASE');
  assert.equal(p.status, 'ok');
  assert.equal(p.card.priceQuotedAt, OLD_TS, 'exact PARALLEL payload: its own time, not the representative BASE row\'s');
  assert.equal(p.card.priceRetained, true);
  assert.equal(b.card.priceQuotedAt, FRESH_TS);
  assert.equal(b.card.priceRetained, false);

  const bare = toCanonicalCardRecord(merged(base), {}, FULL);
  assert.equal(bare.priceQuotedAt, undefined, 'no rows → no invented quote time (never a catalog date)');
  assert.equal(bare.printingQuotedAt, undefined);
  assert.equal(bare.printingRetained, undefined);
  console.log('DIC-361 runtime: exact printings keep their own sale quote time / retained status through the canonical adapter');
}

// MarketDataPanel should render exact-version buy/subscriber sections, while
// CardDetail routes price history through the DIC-1084 exact-identity validator.
// DIC-856: buyPrice is no longer read from the card level; it is derived from the
// *selected version* (selectedVersion.buyPrice) and fails closed to null when the
// version is unaligned or has no matched buy price — never a card-number/max fallback.
// The assertion tracks that exact derivation so this regression stays consistent with
// DIC-856's exact-variant alignment instead of the pre-DIC-856 card-level read.
assertSourceIncludes(cardDetail, [
  'function MarketDataPanel',
  'const buyPrice = aligned ? (selectedVersion?.buyPrice ?? null) : null',
  'const ytStats = card?.ytStats ?? null',
  "t('card_detail_spread_title', { version: versionLabel })",
  "t('card_detail_youtube_data')",
  'computeValidatedPriceTrend({',
  'priceHistory: card.priceHistory',
  'meta: card.priceHistoryMeta',
  'printing: detailVersions[0].printing',
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
