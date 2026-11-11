#!/usr/bin/env node
// Last-known price (2026-11-07 user requirement): when the source stops quoting a printing,
// keep that EXACT printing's last proven price with its ORIGINAL source and time, label it
// clearly as an old price (最近已知售價（舊價）), and never fake a fresh quote or a today
// history record. A new verified quote of the same printing resumes the fresh state.
//
// Isolated synthetic fixtures only (card number hZZ98-001 does not exist in the catalog):
// no network, no data/ or public/ file is read for fixtures or written, no shared cache.
//
//   A. pure freshness classifier (fresh / last-known / unknown-date / no-quote; exact
//      boundaries; the original time string is never rewritten) + its window is pinned to
//      the generator's DIC-1229 constants.
//   B. generator (real scripts/lib functions): a dropped/rotated-out proven payload is
//      kept with its exact timestamp; a silent erase is refused by the DIC-1482 gate; a
//      proven explicit rejection stays rejected and cannot be resurrected; no sibling /
//      different-printing payload is borrowed; a fresh quote wins over the old one; Step 5
//      writes no `date: today` record for a row the run did not re-observe (source pin).
//   C. runtime adapter (canonicalCardRecord / deckCardData): each printing carries ITS OWN
//      quote time; the exact-printing payload uses the printing's own record time, never
//      the representative row's; an ambiguous printing has no quote; a recovered quote
//      replaces the old time.
//   D. privacy: sentinel buy/history/ytStats/variant-buy fields never survive the public
//      native/web projection or the Store MVP mapper, and quote times are sell times only.
//   E/F. (2026-11-10 user override) CardDetail / search tile / list row render the exact-printing
//      price with NO quote-date / 舊價 / 無新報價 / 報價日期不明 hint, in fresh / old / retained /
//      unknown states, while the payload keeps each printing's own quote time + retained flag.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

process.env.EXPO_PUBLIC_STORE_MVP = '0';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://holohunter.dicoge.com/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key in globalThis) continue;
  try { globalThis[key] = dom.window[key]; } catch {}
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = TestResizeObserver;
dom.window.ResizeObserver = TestResizeObserver;

const {
  applyPreservedMarketFields, buildPreservationIndex, findPreservedMatch, hasCurrentPriceProvenance,
  DIC1229_MAX_TIMESTAMP_AGE_MS, DIC1229_MAX_TIMESTAMP_CLOCK_SKEW_MS,
} = await import('./lib/preserve-market-fields.js');
const { classifyExactPrintPayload, evaluatePriceRegressionGate, makeRejection } = await import('./lib/price-regression-gate.mjs');
const { sanitizeDatabase, stripInternalAuditDatabase } = await import('./lib/store-mvp-sanitize.mjs');
const { findForbiddenField } = await import('../src/services/catalog/catalogContract.ts');
const {
  classifyPriceFreshness, printingQuoteTimes, PRICE_FRESH_MAX_AGE_MS, PRICE_FRESH_CLOCK_SKEW_MS,
} = await import('../src/utils/priceFreshness.ts');
const { toCanonicalCardRecord, buildCanonicalCardIndex, dedupeListings } = await import('../src/utils/canonicalCardRecord.ts');
const { adaptCardNumber } = await import('../src/utils/deckCardData.ts');
const { buildPrintingVersions, provenanceFromRow } = await import('../src/utils/printingQuotes.ts');
const { scanQuoteProvenance } = await import('../src/utils/scanQuoteProvenance.ts');
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const CardDetailScreen = (await import('../src/screens/CardDetailScreen.tsx')).default;

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    process.exitCode = 1;
    console.error(`  ✗ ${name} — ${err.stack || err.message}`);
  }
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const FRESH = iso(NOW - 1 * DAY);
const FRESH2 = iso(NOW - 2 * 60 * 60 * 1000);
const OLD = iso(NOW - 30 * DAY);
const day = (s) => s.slice(0, 10);
const IMG = (product, n) => `https://card.yuyu-tei.jp/hocg/100_140/${product}/${n}.jpg`;
const FULL = { buyPrice: true, trendPrediction: true, ytStats: true };
const STORE = { buyPrice: false, trendPrediction: false, ytStats: false };

console.log('── last-known price: exact printing, original time, clearly old (2026-11-07) ──');

// ── A. classifier ─────────────────────────────────────────────────────────
await test('A1 classifier: fresh / last-known / unknown-date / no-quote, with the original time verbatim', () => {
  const now = Date.parse('2026-11-07T00:00:00.000Z');
  const at = (ms) => iso(now - ms);
  assert.equal(classifyPriceFreshness({ price: 980, quotedAt: at(DAY), now }).state, 'fresh');
  assert.equal(classifyPriceFreshness({ price: 980, quotedAt: at(PRICE_FRESH_MAX_AGE_MS), now }).state, 'fresh', 'exactly 7 days is still inside the window');
  assert.equal(classifyPriceFreshness({ price: 980, quotedAt: at(PRICE_FRESH_MAX_AGE_MS + 1), now }).state, 'last-known');
  const old = classifyPriceFreshness({ price: 980, quotedAt: '2026-08-25T03:04:05.678Z', now });
  assert.deepEqual(old, { state: 'last-known', quotedAt: '2026-08-25T03:04:05.678Z', quoteDate: '2026-08-25', retained: false }, 'original time string and date kept verbatim');
  for (const bad of [null, undefined, '', '   ', 'yesterday', '25/08/2026']) {
    assert.equal(classifyPriceFreshness({ price: 980, quotedAt: bad, now }).state, 'unknown-date', `unknown date stays unknown: ${bad}`);
  }
  assert.equal(classifyPriceFreshness({ price: 980, quotedAt: iso(now + PRICE_FRESH_CLOCK_SKEW_MS), now }).state, 'fresh', '5-minute skew allowed');
  const future = classifyPriceFreshness({ price: 980, quotedAt: '2099-01-01T00:00:00.000Z', now });
  assert.equal(future.state, 'unknown-date', 'a future quote is never shown as fresh');
  assert.equal(future.quoteDate, null, 'and its bogus date is not displayed');
  for (const p of [null, undefined, 0, -5, NaN]) {
    assert.equal(classifyPriceFreshness({ price: p, quotedAt: at(DAY), now }).state, 'no-quote', `no positive price → no quote (${p})`);
  }
});

await test('A2 the app window is the generator\'s existing DIC-1229 window (no invented threshold)', () => {
  assert.equal(PRICE_FRESH_MAX_AGE_MS, DIC1229_MAX_TIMESTAMP_AGE_MS);
  assert.equal(PRICE_FRESH_CLOCK_SKEW_MS, DIC1229_MAX_TIMESTAMP_CLOCK_SKEW_MS);
  const src = readFileSync(new URL('../src/utils/priceFreshness.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^\s*import\s/m, 'pure module: no store / account / network import');
  assert.doesNotMatch(src, /lastUpdated\b\s*[,)]|dataObservedAt\b\s*[,)]/, 'catalog publish time is never an input');
});

// ── B. generator ──────────────────────────────────────────────────────────
const provenRow = (over = {}) => ({
  id: 'hZZ98-001_hBP01_R_hZZ98-001_R', cardNumber: 'hZZ98-001', sourceProduct: 'hBP01', series: 'hBP01', rarity: 'R',
  sellPrice: 980, yuyuName: 'テスト', yuyuImage: IMG('hbp01', 10001), timestamp: OLD,
  prices: [{ name: 'テスト', sellPrice: 980, rarity: 'R', imageUrl: IMG('hbp01', 10001) }],
  ...over,
});
const rebuiltEmpty = (over = {}) => ({
  id: 'hZZ98-001_hBP01_R_hZZ98-001_R', cardNumber: 'hZZ98-001', sourceProduct: 'hBP01', series: 'hBP01', rarity: 'R',
  sellPrice: null, prices: [], yuyuName: '', yuyuImage: '', timestamp: '', ...over,
});
// The exact build-database.js preservation predicate for a HEALTHY scrape (no outage, not
// partial): payload is kept only when the current row has payload or the previous one is
// exact-print proven. Pinned against the source below.
const healthyPreserve = (current, previous) => (
  (Number.isFinite(current?.sellPrice) && current.sellPrice > 0)
  || (Array.isArray(current?.prices) && current.prices.length > 0)
  || Boolean(current?.yuyuName || current?.yuyuImage || current?.timestamp)
  || classifyExactPrintPayload(previous).proven
);

await test('B1 source drops a proven listing: same printing keeps its price AND its exact original timestamp', () => {
  const prev = provenRow();
  assert.equal(classifyExactPrintPayload(prev).proven, true);
  const cur = rebuiltEmpty();
  const match = findPreservedMatch(buildPreservationIndex({ [prev.id]: prev }), cur.id, cur);
  assert.equal(match.matchKind, 'exact-id');
  applyPreservedMarketFields(cur, match.card, { matchKind: match.matchKind, preserveYuyuPayload: healthyPreserve(cur, match.card) });
  assert.equal(cur.sellPrice, 980, 'last-known price kept');
  assert.equal(cur.timestamp, OLD, 'timestamp kept byte-for-byte — never restamped to now');
  assert.deepEqual(cur.prices, prev.prices, 'its own listing kept');
  const gate = evaluatePriceRegressionGate({ previousCards: { [prev.id]: prev }, nextCards: { [cur.id]: cur } });
  assert.equal(gate.ok, true, 'no decrease: the printing is still priced');
  assert.equal(hasCurrentPriceProvenance(cur, { now: NOW }), false,
    'an old last-known payload is NOT current provenance — Step 5 / Step 6 / the audit keep it out of history');
  assert.equal(classifyPriceFreshness({ price: cur.sellPrice, quotedAt: cur.timestamp }).state, 'last-known');
});

await test('B2 a silent erase of a proven price is refused (missing ≠ rejection)', () => {
  const prev = provenRow();
  const gate = evaluatePriceRegressionGate({ previousCards: { [prev.id]: prev }, nextCards: { [prev.id]: rebuiltEmpty() } });
  assert.equal(gate.ok, false);
  assert.equal(gate.violations[0].kind, 'priced-row-lost');
  const rubberStamp = evaluatePriceRegressionGate({
    previousCards: { [prev.id]: prev }, nextCards: { [prev.id]: rebuiltEmpty() },
    rejections: [makeRejection(prev.id, prev, 'no-yuyu-image-provenance')],
  });
  assert.equal(rubberStamp.ok, false, 'a rejection cannot be claimed for a proven payload');
  assert.equal(rubberStamp.violations[0].kind, 'rejection-not-verifiable');
});

await test('B3 a proven explicit rejection stays rejected; its payload is never resurrected', () => {
  // hBP01 row whose own listing image is an hBP08 product: cross-product, unproven.
  const rejected = provenRow({
    yuyuImage: IMG('hbp08', 20001), prices: [{ name: 'テスト', sellPrice: 300, rarity: 'R', imageUrl: IMG('hbp08', 20001) }], sellPrice: 300,
  });
  assert.deepEqual(classifyExactPrintPayload(rejected), { proven: false, reason: 'cross-product-image' });
  const cur = rebuiltEmpty();
  applyPreservedMarketFields(cur, rejected, { matchKind: 'exact-id', preserveYuyuPayload: healthyPreserve(cur, rejected) });
  assert.equal(cur.sellPrice, null, 'rejected unproven price stays rejected on a healthy scrape');
  assert.equal(cur.timestamp, '', 'and no timestamp is carried for it');
  const covered = evaluatePriceRegressionGate({
    previousCards: { [rejected.id]: rejected }, nextCards: { [cur.id]: cur },
    rejections: [makeRejection(rejected.id, rejected, 'cross-product-image')],
  });
  assert.equal(covered.ok, true, 'the decrease is covered only by the re-verifiable per-printing rejection');
  const wrongReason = evaluatePriceRegressionGate({
    previousCards: { [rejected.id]: rejected }, nextCards: { [cur.id]: cur },
    rejections: [makeRejection(rejected.id, rejected, 'no-yuyu-image-provenance')],
  });
  assert.equal(wrongReason.ok, false, 'a rejection whose reason does not re-derive is refused');
});

await test('B4 a different printing\'s price (sibling / reprint / other rarity) is never borrowed', () => {
  const reprint = provenRow({
    id: 'hZZ98-001_hBP08_R_hZZ98-001_R_02', sourceProduct: 'hBP08', series: 'hBP08', sellPrice: 50,
    yuyuImage: IMG('hbp08', 20001), prices: [{ name: 'テスト(hBP08)', sellPrice: 50, rarity: 'R', imageUrl: IMG('hbp08', 20001) }],
  });
  const cur = rebuiltEmpty();
  assert.equal(findPreservedMatch(buildPreservationIndex({ [reprint.id]: reprint }), cur.id, cur), null, 'no cardNumber-level fallback');
  applyPreservedMarketFields(cur, reprint, { matchKind: 'signature', preserveYuyuPayload: true });
  assert.equal(cur.sellPrice, null, 'even a forced copy refuses a foreign product\'s payload');
  const otherRarity = provenRow({ id: 'other', rarity: 'SR' });
  assert.equal(findPreservedMatch(buildPreservationIndex({ other: otherRarity }), 'renamed', rebuiltEmpty({ id: 'renamed' })), null,
    'a renamed id only matches the exact cardNumber|sourceProduct|rarity signature');
});

await test('B5 stale → new cycle: a fresh verified quote wins and carries its own time', () => {
  const prev = provenRow();
  const cur = provenRow({ sellPrice: 1100, timestamp: FRESH, prices: [{ name: 'テスト', sellPrice: 1100, rarity: 'R', imageUrl: IMG('hbp01', 10001) }] });
  applyPreservedMarketFields(cur, prev, { matchKind: 'exact-id', preserveYuyuPayload: true });
  assert.equal(cur.sellPrice, 1100);
  assert.equal(cur.timestamp, FRESH, 'the old time is never merged onto the new quote');
  assert.equal(classifyPriceFreshness({ price: cur.sellPrice, quotedAt: cur.timestamp }).state, 'fresh');
});

await test('B6 build-database.js wiring: healthy-scrape predicate, and Step 5 writes no today record for an un-re-observed row', () => {
  const src = readFileSync(new URL('./build-database.js', import.meta.url), 'utf8');
  assert.match(src, /preserveYuyuPayload:\s*pricingUnavailable\s*\|\|\s*partialScrape\s*\|\|\s*hasCurrentYuyuPayload\(card\)\s*\|\|\s*classifyExactPrintPayload\(match\.card\)\.proven/,
    'the predicate mirrored by healthyPreserve() is the one the builder runs');
  const freshIdx = src.indexOf('const freshlyPricedRowIds = new Set(');
  const preserveIdx = src.indexOf('applyPreservedMarketFields(card, match.card');
  assert.ok(freshIdx > -1 && preserveIdx > freshIdx, 'fresh set is captured BEFORE preservation tops rows up');
  const step5 = src.slice(src.indexOf('── Step 5: Save price history'));
  const loop = step5.slice(step5.indexOf('const priceRecords = [];'), step5.indexOf('priceRecords.push(stampHistoryRecord('));
  assert.ok(loop.length > 0, 'Step 5 record loop found');
  const gateIdx = loop.search(/!\s*hasCurrentPriceProvenance\s*\(\s*card\s*,\s*step5GateOptions\s*\)/);
  const lastKnownIdx = loop.search(/if\s*\(\s*!\s*freshlyPricedRowIds\.has\(\s*cardId\s*\)\s*\)\s*\{[\s\S]*?continue;/);
  assert.ok(gateIdx > -1, 'DIC-1229 provenance gate kept');
  assert.ok(lastKnownIdx > gateIdx, 'a last-known row is skipped AFTER the provenance gate (its counter stays unchanged) and BEFORE the today record');
  assert.match(step5, /date:\s*today/, 'fresh rows still get today\'s record');
});

await test('B7 review R1: a preserved price carries the PRESERVED payload\'s time — never the current scrape\'s', () => {
  const prev = provenRow();
  // (a) healthy scrape MATCHED the exact printing but the listing had no positive price:
  //     build-database.js stamps `timestamp: yuyu.firstTimestamp` (this run) on the row.
  const matched = rebuiltEmpty({
    timestamp: FRESH, yuyuName: 'テスト', yuyuImage: IMG('hbp01', 10001),
    prices: [{ name: 'テスト', sellPrice: null, rarity: 'R', imageUrl: IMG('hbp01', 10001) }],
  });
  applyPreservedMarketFields(matched, prev, { matchKind: 'exact-id', preserveYuyuPayload: healthyPreserve(matched, prev) });
  assert.equal(matched.sellPrice, 980, 'original price kept');
  assert.equal(matched.timestamp, OLD, 'original date kept — the fresh scrape time is NOT attached to the old price');
  assert.equal(classifyPriceFreshness({ price: matched.sellPrice, quotedAt: matched.timestamp }).state, 'last-known');
  assert.equal(hasCurrentPriceProvenance(matched, { now: NOW }), false, 'so Step 6 / the audit treat it as not current either');
  // (b) yuyu-only fallback bound onto the official row with `firstTimestamp` defaulted to now.
  const defaultedNow = rebuiltEmpty({ timestamp: new Date().toISOString() });
  applyPreservedMarketFields(defaultedNow, prev, { matchKind: 'exact-id', preserveYuyuPayload: true });
  assert.equal(defaultedNow.sellPrice, 980);
  assert.equal(defaultedNow.timestamp, OLD);
  // (c) a proven payload with NO recorded time stays unknown — never the scrape time.
  const untimed = rebuiltEmpty({ timestamp: FRESH, prices: [{ name: 'テスト', sellPrice: null, rarity: 'R', imageUrl: IMG('hbp01', 10001) }] });
  applyPreservedMarketFields(untimed, provenRow({ timestamp: '' }), { matchKind: 'exact-id', preserveYuyuPayload: true });
  assert.equal(untimed.sellPrice, 980);
  assert.equal(untimed.timestamp, '');
  assert.equal(classifyPriceFreshness({ price: untimed.sellPrice, quotedAt: untimed.timestamp }).state, 'unknown-date');
  // (d) a FRESH sell price is untouched when only ytStats / history come from the previous row.
  const fresh = provenRow({ sellPrice: 1100, timestamp: FRESH, prices: [{ name: 'テスト', sellPrice: 1100, rarity: 'R', imageUrl: IMG('hbp01', 10001) }] });
  applyPreservedMarketFields(fresh, provenRow({ ytStats: { subscriberCount: 1 }, priceHistory: { '2026-10-01': 900 } }), { matchKind: 'exact-id', preserveYuyuPayload: true });
  assert.equal(fresh.sellPrice, 1100);
  assert.equal(fresh.timestamp, FRESH, 'fresh quote time unchanged');
  // (e) the fix widens nothing: a cross-product previous payload is still not copied.
  const foreign = rebuiltEmpty({ timestamp: FRESH });
  applyPreservedMarketFields(foreign, provenRow({ yuyuImage: IMG('hbp08', 1), prices: [{ name: 'テスト', sellPrice: 300, rarity: 'R', imageUrl: IMG('hbp08', 1) }] }), { matchKind: 'exact-id', preserveYuyuPayload: true });
  assert.equal(foreign.sellPrice, null);
  assert.equal(foreign.timestamp, FRESH, 'nothing preserved → the row\'s own (unpriced) scrape time is left alone');
});

await test('B8 review B1: value, time AND listings are restored as one bundle and survive repeated missing cycles', () => {
  const positive = (list) => (list || []).filter((e) => Number.isFinite(e?.sellPrice) && e.sellPrice > 0);
  const matchedUnpriced = (price) => rebuiltEmpty({
    timestamp: iso(Date.now()), yuyuName: 'テスト', yuyuImage: IMG('hbp01', 10001),
    prices: [{ name: 'テスト', sellPrice: price, rarity: 'R', imageUrl: IMG('hbp01', 10001) }],
  });
  let prev = provenRow();
  for (const [cycle, unpriced] of [[1, null], [2, 0], [3, null]]) {
    const cur = matchedUnpriced(unpriced);
    applyPreservedMarketFields(cur, prev, { matchKind: 'exact-id', preserveYuyuPayload: healthyPreserve(cur, prev) });
    assert.equal(cur.sellPrice, 980, `cycle ${cycle}: value kept`);
    assert.equal(cur.timestamp, OLD, `cycle ${cycle}: original time kept`);
    assert.deepEqual(positive(cur.prices).map((e) => e.sellPrice), [980], `cycle ${cycle}: the variant list prices the same value (headline = variant)`);
    assert.equal(Math.min(...positive(cur.prices).map((e) => e.sellPrice)), cur.sellPrice);
    assert.equal(classifyExactPrintPayload(cur).proven, true, `cycle ${cycle}: the shipped bundle stays exact-print proven for the next build`);
    const gate = evaluatePriceRegressionGate({ previousCards: { [prev.id]: prev }, nextCards: { [cur.id]: cur } });
    assert.equal(gate.ok, true, `cycle ${cycle}: DIC-1482 passes without any rejection`);
    prev = cur; // the next build reads this artifact
  }
  // top-level-only proven payload (no listings): unpriced current entries are dropped, not
  // shipped beside the value, so the next cycle still re-derives from the top level.
  let topOnly = provenRow({ prices: [] });
  for (const cycle of [1, 2]) {
    const cur = matchedUnpriced(null);
    applyPreservedMarketFields(cur, topOnly, { matchKind: 'exact-id', preserveYuyuPayload: true });
    assert.equal(cur.sellPrice, 980, `top-level cycle ${cycle}: value kept`);
    assert.equal(cur.timestamp, OLD);
    assert.deepEqual(cur.prices, [], `top-level cycle ${cycle}: no unpriced entry beside a retained price`);
    topOnly = cur;
  }
  // legacy artifact shape (pre-B1 builds): positive top-level price over listings that price
  // nothing. It must not be lost on the next builds, whether the source omits the printing or
  // matches it unpriced again. Omitted → carried unchanged (dropping its entries would be an
  // un-rejected DIC-1482 entry decrease); matched again → the fresh matched row ships the
  // value with no unpriced entry (that printing was freshly scraped, as in the builder).
  const legacyEntries = [{ name: 'テスト', sellPrice: null, rarity: 'R', imageUrl: IMG('hbp01', 10001) }];
  for (const [shape, current, fresh] of [['omitted', () => rebuiltEmpty(), false], ['matched-unpriced', () => matchedUnpriced(null), true]]) {
    let legacy = provenRow({ prices: legacyEntries });
    assert.equal(classifyExactPrintPayload(legacy).proven, true, 'legacy shape is proven by its top level');
    for (const cycle of [1, 2]) {
      const cur = current();
      applyPreservedMarketFields(cur, legacy, { matchKind: 'exact-id', preserveYuyuPayload: healthyPreserve(cur, legacy) });
      assert.equal(cur.sellPrice, 980, `legacy ${shape} cycle ${cycle}: value kept`);
      assert.equal(cur.timestamp, OLD, `legacy ${shape} cycle ${cycle}: original time kept`);
      if (fresh) assert.deepEqual(cur.prices, [], `legacy ${shape} cycle ${cycle}: no unpriced listing beside the retained value`);
      else assert.deepEqual(cur.prices, legacyEntries, `legacy ${shape} cycle ${cycle}: entries carried, not silently dropped`);
      const gate = evaluatePriceRegressionGate({
        previousCards: { [legacy.id]: legacy }, nextCards: { [cur.id]: cur },
        freshlyScrapedPrintingIds: fresh ? new Set([cur.id]) : new Set(),
      });
      assert.equal(gate.ok, true, `legacy ${shape} cycle ${cycle}: DIC-1482 passes without rejection`);
      legacy = cur;
    }
  }
  // a FRESH positive current listing is never replaced
  const fresh = rebuiltEmpty({ sellPrice: 1100, timestamp: FRESH, yuyuImage: IMG('hbp01', 10001),
    prices: [{ name: 'テスト', sellPrice: 1100, rarity: 'R', imageUrl: IMG('hbp01', 10001) }] });
  applyPreservedMarketFields(fresh, provenRow(), { matchKind: 'exact-id', preserveYuyuPayload: true });
  assert.deepEqual(fresh.prices.map((e) => e.sellPrice), [1100]);
  assert.equal(fresh.timestamp, FRESH);
  // rejected / cross-printing payloads are still never resurrected into the bundle
  const crossOnto = matchedUnpriced(null);
  applyPreservedMarketFields(crossOnto, provenRow({ yuyuImage: IMG('hbp08', 1), prices: [{ name: 'テスト', sellPrice: 300, rarity: 'R', imageUrl: IMG('hbp08', 1) }] }),
    { matchKind: 'exact-id', preserveYuyuPayload: true });
  assert.equal(crossOnto.sellPrice, null);
  assert.deepEqual(positive(crossOnto.prices), [], 'no foreign listing copied');
  const rejectedOnto = matchedUnpriced(null);
  const rejected = provenRow({ yuyuImage: IMG('hbp08', 20001), sellPrice: 300, prices: [{ name: 'テスト', sellPrice: 300, rarity: 'R', imageUrl: IMG('hbp08', 20001) }] });
  applyPreservedMarketFields(rejectedOnto, rejected, { matchKind: 'exact-id', preserveYuyuPayload: healthyPreserve(rejectedOnto, rejected) });
  assert.equal(rejectedOnto.sellPrice, null);
  assert.deepEqual(positive(rejectedOnto.prices), []);
  // a different printing (renamed id, other rarity) is still not matched at all
  assert.equal(findPreservedMatch(buildPreservationIndex({ other: provenRow({ id: 'other', rarity: 'SR' }) }), 'renamed', matchedUnpriced(null)), null);
});

// ── C. runtime adapter ────────────────────────────────────────────────────
const detailRow = (over) => ({
  cardNumber: 'hZZ98-001', name: 'テスト', nameZh: '測試卡', type: 'ホロメン', color: 'white', hp: '100',
  officialImage: '', localImage: '', yuyuName: '', yuyuImage: '', ...over,
});
const rowBase = detailRow({ id: 'hZZ98-001_hBP01_R', series: 'hBP01', sourceProduct: 'hBP01', rarity: 'R', sellPrice: 120, timestamp: FRESH,
  prices: [{ name: 'テスト', sellPrice: 120, rarity: 'R', imageUrl: IMG('hbp01', 1) }] });
const rowParallel = detailRow({ id: 'hZZ98-001_hBP08_SR', series: 'hBP08', sourceProduct: 'hBP08', rarity: 'SR', sellPrice: 3480, timestamp: OLD,
  prices: [{ name: 'テスト(パラレル)', sellPrice: 3480, rarity: 'SR', imageUrl: IMG('hbp08', 2) }] });
const rowNoTime = detailRow({ id: 'hZZ98-001_hEB01_R', series: 'hEB01', sourceProduct: 'hEB01', rarity: 'R', sellPrice: 50,
  prices: [{ name: 'テスト(hEB01)', sellPrice: 50, rarity: 'R', imageUrl: IMG('heb01', 3) }] });
const rowSignA = detailRow({ id: 'hZZ98-001_hPR_A', series: 'hPR', sourceProduct: 'hPR', rarity: 'P', sellPrice: 9000, timestamp: FRESH,
  prices: [{ name: 'テスト(パラレル/サイン)', sellPrice: 9000, rarity: 'P', imageUrl: IMG('hpr', 4) }] });
const rowSignB = detailRow({ id: 'hZZ98-001_hPR_B', series: 'hPR', sourceProduct: 'hPR', rarity: 'P', sellPrice: 9500, timestamp: FRESH,
  prices: [{ name: 'テスト(パラレル/サイン)', sellPrice: 9500, rarity: 'P', imageUrl: IMG('hpr', 4) }] });
const ROWS = [rowBase, rowParallel, rowNoTime, rowSignA, rowSignB];
const searchPayload = (rows, rep = rows[0], flags = FULL) => toCanonicalCardRecord(
  { ...rep, prices: dedupeListings(rows.flatMap((r) => r.prices ?? [])) }, {}, flags, rows,
);

await test('C1 every printing carries ITS OWN quote time — never a sibling\'s, never the catalog time', () => {
  const times = printingQuoteTimes(adaptCardNumber(ROWS).priceRecords);
  assert.equal(times.BASE, FRESH);
  assert.equal(times.PARALLEL, OLD, 'the August-style parallel does not look current because the base row was scraped today');
  assert.equal(times.HEB01, undefined, 'a row with no timestamp states no time (unknown, not invented)');
  assert.equal(times['PARALLEL/SIGN'], undefined, 'an ambiguous printing (¥9,000 vs ¥9,500) has no quote at all');
  const card = searchPayload(ROWS);
  assert.deepEqual(card.printingQuotedAt, times);
  assert.equal(card.priceQuotedAt, FRESH, 'headline (the elected row\'s own price) carries that row\'s own time');
});

await test('C2 exact-printing payload (favorites route) uses that printing\'s own record time', () => {
  const index = buildCanonicalCardIndex(ROWS, {});
  const parallel = index.resolve('hZZ98-001', 'PARALLEL');
  assert.equal(parallel.status, 'ok');
  assert.equal(parallel.card.sellPrice, 3480);
  assert.equal(parallel.card.priceQuotedAt, OLD, 'not the representative BASE row\'s fresh time');
  const base = index.resolve('hZZ98-001', 'BASE');
  assert.equal(base.card.priceQuotedAt, FRESH);
  const sign = index.resolve('hZZ98-001', 'PARALLEL/SIGN');
  assert.equal(sign.card.sellPrice, null, 'ambiguous printing stays unpriced');
  assert.equal(sign.card.priceQuotedAt, null, 'and has no quote time');
  const unknown = index.resolve('hZZ98-001', 'HEB01');
  assert.equal(unknown.card.sellPrice, 50);
  assert.equal(unknown.card.priceQuotedAt, null, 'a price with unknown time keeps an unknown time');
  assert.equal(classifyPriceFreshness({ price: unknown.card.sellPrice, quotedAt: unknown.card.priceQuotedAt }).state, 'unknown-date');
});

await test('C3 recovery: a new verified quote of the same printing replaces the old time and is fresh again', () => {
  const recovered = { ...rowParallel, sellPrice: 3600, timestamp: FRESH2,
    prices: [{ name: 'テスト(パラレル)', sellPrice: 3600, rarity: 'SR', imageUrl: IMG('hbp08', 2) }] };
  const index = buildCanonicalCardIndex([rowBase, recovered], {});
  const parallel = index.resolve('hZZ98-001', 'PARALLEL');
  assert.equal(parallel.card.sellPrice, 3600);
  assert.equal(parallel.card.priceQuotedAt, FRESH2);
  assert.equal(classifyPriceFreshness({ price: 3600, quotedAt: FRESH2 }).state, 'fresh');
});

await test('C4 a same-time conflict on one proven printing stays fail-closed (no current price)', () => {
  const at = FRESH;
  const v = buildPrintingVersions([
    { id: 'a', cardNumber: 'hZZ98-001', physicalPrinting: 'P1', sellPrice: 100, provenance: provenanceFromRow({ timestamp: at, sourceProduct: 'hBP01' }) },
    { id: 'b', cardNumber: 'hZZ98-001', physicalPrinting: 'P1', sellPrice: 200, provenance: provenanceFromRow({ timestamp: at, sourceProduct: 'ent07' }) },
  ]);
  assert.equal(v.length, 1);
  assert.equal(v[0].currentSell, null);
  assert.equal(v[0].sellConflict, true);
});

await test('C5 a payload built without the number\'s rows claims no quote provenance (legacy routes unchanged)', () => {
  const card = toCanonicalCardRecord(rowParallel, {}, FULL);
  assert.equal(card.priceQuotedAt, undefined);
  assert.equal(card.printingQuotedAt, undefined);
});

await test('C6 scan → detail carries the scanned printing\'s OWN quote time; no provenance → unknown, never fresh', () => {
  const scanCard = {
    id: 'hZZ98-001_hBP08_SR', cardNumber: 'hZZ98-001', sellPrice: 3480,
    prices: [
      { name: 'テスト(パラレル)', sellPrice: 3480, rarity: 'SR', imageUrl: IMG('hbp08', 2) },
      { name: 'テスト(パラレル/サイン)', sellPrice: 9000 }, { name: 'テスト(パラレル/サイン)', sellPrice: 9500 },
    ],
    provenance: provenanceFromRow({ timestamp: OLD, sourceProduct: 'hBP08', yuyuImage: IMG('hbp08', 2) }),
  };
  assert.deepEqual(scanQuoteProvenance(scanCard), { priceQuotedAt: OLD, printingQuotedAt: { PARALLEL: OLD } },
    'ambiguous printing gets no time; no representative or catalog time');
  assert.deepEqual(scanQuoteProvenance({ ...scanCard, provenance: null }), { priceQuotedAt: null, printingQuotedAt: {} });
  assert.deepEqual(scanQuoteProvenance({ prices: scanCard.prices }), { priceQuotedAt: null, printingQuotedAt: {} },
    'an account-synced session entry (no provenance) states no time');
  const src = readFileSync(new URL('../src/screens/ScanScreen.tsx', import.meta.url), 'utf8');
  assert.match(src, /onViewCard=\{\(card\) => navigation\?\.navigate\('CardDetail', \{ card: \{ \.\.\.card, \.\.\.scanQuoteProvenance\(card\) \} \}\)\}/,
    'the scan session → CardDetail route attaches it');
});

// ── D. privacy ────────────────────────────────────────────────────────────
const SENTINEL = { buy: 77777, buyHist: 88888, hist: 55555, yt: 99999, vBuy: 66666, vVer: 'SENTINEL_BPV', vSrc: 'SENTINEL_BPS', vTs: '2099-12-31T23:59:59.000Z', raw: 'SENTINEL_RAW' };
const privateRow = {
  ...rowParallel,
  buyPrice: SENTINEL.buy, buyPriceHistory: { '2026-10-01': SENTINEL.buyHist }, priceHistory: { '2026-10-01': SENTINEL.hist },
  ytStats: { subscriberCount: SENTINEL.yt },
  prices: [{ ...rowParallel.prices[0], buyPrice: SENTINEL.vBuy, buyPriceVersion: SENTINEL.vVer, buyPriceSource: SENTINEL.vSrc, buyPriceTimestamp: SENTINEL.vTs }],
  _rawPricesArchive: [{ name: SENTINEL.raw, sellPrice: 1 }],
};
const sentinelsIn = (text, list) => list.filter((s) => text.includes(String(s)));

await test('D1 public native/web projection: nested market sentinels never ship; no new row field is added', () => {
  const db = { cards: { [privateRow.id]: privateRow }, totalCards: 1, lastUpdated: FRESH };
  const native = sanitizeDatabase(db); // public/data/database.json + Store MVP web copy
  const nativeText = JSON.stringify(native);
  assert.deepEqual(sentinelsIn(nativeText, Object.values(SENTINEL)), []);
  assert.equal(findForbiddenField(native.cards[privateRow.id]), null, 'the remote catalog contract accepts it');
  assert.ok(Object.keys(native.cards[privateRow.id]).every((k) => Object.hasOwn(privateRow, k)), 'the projection adds no last-known metadata field');
  assert.equal(native.cards[privateRow.id].timestamp, OLD, 'the sell quote time is the only time that ships');
  const fullWeb = JSON.stringify(stripInternalAuditDatabase(db));
  assert.deepEqual(sentinelsIn(fullWeb, [SENTINEL.raw]), [], 'internal audit archive never ships, even on full web');
});

await test('D2 Store MVP mapper: no buy / history / ytStats leak, and quote times are sell times only', () => {
  const rows = [rowBase, privateRow];
  for (const flags of [STORE, FULL]) {
    const card = searchPayload(rows, rowBase, flags);
    const times = [card.priceQuotedAt, ...Object.values(card.printingQuotedAt || {})];
    assert.ok(!times.includes(SENTINEL.vTs), 'buyPriceTimestamp is never presented as a sell quote time');
    assert.deepEqual(new Set(times), new Set([FRESH, OLD]), 'only the rows\' own sell timestamps');
    const index = buildCanonicalCardIndex(rows, {});
    assert.equal(index.resolve('hZZ98-001', 'PARALLEL').card.priceQuotedAt, OLD);
  }
  const storeText = JSON.stringify(searchPayload(rows, privateRow, STORE));
  assert.deepEqual(sentinelsIn(storeText, [SENTINEL.buy, SENTINEL.buyHist, SENTINEL.hist, SENTINEL.yt, SENTINEL.vBuy, SENTINEL.vVer, SENTINEL.vSrc, SENTINEL.vTs]), []);
  const src = readFileSync(new URL('../src/utils/canonicalCardRecord.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from '\.\.\/store\/|accountSync|favoritesStore|watchlist/i, 'favorites / account / sync are never a market source');
});

// ── E. CardDetail rendering ───────────────────────────────────────────────
async function renderDetail(card) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(CardDetailScreen, {
    route: { params: { card } },
    navigation: { navigate() {}, goBack() {} },
  })));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { container, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}
const textOf = (container, id) => container.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;

// 2026-11-10 USER OVERRIDE (Android report: 「本次更新無新報價・沿用 2026-08-25 的原報價（舊價）」
// — 「如果會請拿掉 我可沒叫你這樣顯示」): no quote-date / 舊價 / 無新報價 / 報價日期不明 hint is
// rendered on any price surface. The exact-printing price, its own picture / version / shop
// name still render, and the payload keeps each printing's own quote time + retained flag
// internally (asserted below) — the hint is removed, the provenance is not.
const QUOTE_HINT_RE = /舊價|無新報價|報價日期不明|日期不明|最近已知|非即時行情|沿用|\d{4}-\d{2}-\d{2}\s*報價|旧価格|新しい価格なし|取得日不明|時点/;
const QUOTE_TESTIDS = ['card-detail-price-quote', 'card-detail-market-quote', 'card-detail-quote-BASE', 'card-detail-quote-PARALLEL',
  'card-detail-quote-HEB01', 'card-detail-quote-PARALLEL/SIGN', 'search-card-tile-price-note', 'search-result-price-age'];
function assertNoQuoteHint(container, quoteTimes, label) {
  const text = container.textContent;
  assert.doesNotMatch(text, QUOTE_HINT_RE, `${label}: no quote-age / retained / unknown-date wording`);
  for (const at of quoteTimes) if (at) assert.ok(!text.includes(day(at)), `${label}: quote date ${day(at)} is not rendered`);
  for (const id of QUOTE_TESTIDS) assert.equal(textOf(container, id), null, `${label}: no ${id} node`);
}
const rowParallelRetained = { ...rowParallel, timestamp: FRESH2, sellQuoteRetained: true };

await test('E1 one printing, source stopped quoting (old) or retained this run: price shown, NO hint; quote time + retained kept internally', async () => {
  for (const [card, at, retained, label] of [
    [searchPayload([rowParallel]), OLD, false, 'old (30 days)'],
    [searchPayload([rowParallelRetained]), FRESH2, true, 'retained (2h old, no new quote this run)'],
  ]) {
    assert.equal(card.priceQuotedAt, at, `${label}: the printing's own quote time stays on the payload`);
    assert.equal(card.priceRetained === true, retained, `${label}: the writer's retained flag stays on the payload`);
    const { container, cleanup } = await renderDetail(card);
    try {
      assert.ok(container.textContent.includes('¥3,480'), `${label}: the exact-printing value itself`);
      assertNoQuoteHint(container, [at, iso(NOW)], label);
    } finally { await cleanup(); }
  }
});

await test('E2 fresh quote and unknown time: price shown, no date / unknown-date hint', async () => {
  for (const [card, price, at, label] of [
    [searchPayload([rowBase]), '¥120', FRESH, 'fresh'],
    [searchPayload([rowNoTime]), '¥50', null, 'unknown time'],
  ]) {
    assert.equal(card.priceQuotedAt, at, `${label}: internal quote time (null = unknown) unchanged`);
    const { container, cleanup } = await renderDetail(card);
    try {
      assert.ok(container.textContent.includes(price), `${label}: price ${price} shown`);
      assertNoQuoteHint(container, [at], label);
    } finally { await cleanup(); }
  }
});

await test('E3 several printings: each row keeps its own price / picture / shop name, no per-row hint; ambiguous row unpriced; row count unchanged', async () => {
  const card = searchPayload(ROWS);
  // internal per-printing provenance is untouched (never a sibling's time)
  assert.equal(card.printingQuotedAt.BASE, FRESH);
  assert.equal(card.printingQuotedAt.PARALLEL, OLD);
  assert.equal(Object.hasOwn(card.printingQuotedAt, 'HEB01'), false);
  const { container, cleanup } = await renderDetail(card);
  try {
    const variantRows = [...container.querySelectorAll('[data-testid^="card-detail-variant-"]')]
      .filter((el) => /^card-detail-variant-(?!image-|noimage-|hint)/.test(el.getAttribute('data-testid')));
    assert.equal(variantRows.length, 4, 'four version rows');
    const byId = Object.fromEntries(variantRows.map((el) => [el.getAttribute('data-testid').replace('card-detail-variant-', ''), el.textContent]));
    // the row price is rendered in the user's currency exactly as the screen converts it
    const { convertPrice } = await import('../src/constants/index.ts');
    const { useSettingsStore } = await import('../src/store/settingsStore.ts');
    const shown = (jpy) => { const c = convertPrice(jpy, useSettingsStore.getState().preferredCurrency); return `${c.symbol}${c.value?.toLocaleString()}`; };
    assert.ok(byId.BASE.includes(shown(120)) && byId.BASE.includes('テスト'), `BASE row: own price + shop name (${byId.BASE})`);
    assert.ok(byId.PARALLEL.includes(shown(3480)) && byId.PARALLEL.includes('テスト(パラレル)'), `PARALLEL row: own price + shop name (${byId.PARALLEL})`);
    assert.ok(byId.HEB01.includes(shown(50)), `HEB01 row: own price (${byId.HEB01})`);
    assert.ok(!byId['PARALLEL/SIGN'].includes(shown(9000)) && !byId['PARALLEL/SIGN'].includes(shown(9500)), `ambiguous printing: no price picked (${byId['PARALLEL/SIGN']})`);
    assert.ok(container.querySelector('[data-testid="card-detail-variant-image-PARALLEL"]'), 'own picture kept');
    assertNoQuoteHint(container, [FRESH, OLD], 'several printings');
  } finally { await cleanup(); }
});

await test('E4 a route payload without quote provenance renders the same (price, no hint)', async () => {
  const { container, cleanup } = await renderDetail(toCanonicalCardRecord(rowParallel, {}, FULL));
  try {
    assert.ok(container.textContent.includes('¥3,480'));
    assertNoQuoteHint(container, [OLD], 'no provenance');
  } finally { await cleanup(); }
});

await test('E5 scan → detail (non-Store profile 市場數據): selected version price shown, no hint; scan provenance kept on the route payload', async () => {
  const scanCard = {
    id: 'hZZ98-001_hBP08_SR', name: 'テスト', nameZh: '測試卡', cardNumber: 'hZZ98-001', type: 'ホロメン', rarity: 'SR',
    series: 'hBP08', sellPrice: 3480, yuyuName: '', color: 'white', imageUrl: '',
    prices: [{ name: 'テスト(パラレル)', sellPrice: 3480, rarity: 'SR', imageUrl: IMG('hbp08', 2) }],
    provenance: provenanceFromRow({ timestamp: OLD, sourceProduct: 'hBP08', yuyuImage: IMG('hbp08', 2) }),
  };
  for (const [card, label] of [[scanCard, 'old scanned quote'], [{ ...scanCard, provenance: null }, 'synced entry (no provenance)']]) {
    const route = { ...card, ...scanQuoteProvenance(card) };
    assert.equal(route.priceQuotedAt, card.provenance ? OLD : null, `${label}: internal quote time unchanged`);
    const { container, cleanup } = await renderDetail(route);
    try {
      assert.ok(container.textContent.includes('3,480'), `${label}: price shown`);
      assertNoQuoteHint(container, [OLD], label);
    } finally { await cleanup(); }
  }
});

// ── F. compact search price (tile + list row) ─────────────────────────────
const SearchResultsModule = await import('../src/screens/SearchResultsScreen.tsx');
const { SearchResultTile, CardListItem } = SearchResultsModule;
async function renderEl(el) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(el));
  return { container, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}
const tileOf = async (card, now, onPress = () => {}) => renderEl(React.createElement(SearchResultTile, { card, now, onPress }));
const HOUR_MS = 60 * 60 * 1000;

await test('F1 compact tile: old / retained / fresh / unknown / legacy → the same price text and NO marker', async () => {
  const old = searchPayload([rowParallel]);
  const cases = [
    [old, NOW, 'old'],
    [old, Date.parse(OLD) + HOUR_MS, 'old payload, injected clock'],
    [searchPayload([rowParallelRetained]), NOW, 'retained'],
    [searchPayload([rowBase]), NOW, 'fresh'],
    [searchPayload([rowNoTime]), NOW, 'unknown time'],
    [toCanonicalCardRecord(rowParallel, {}, FULL), NOW, 'no provenance'],
  ];
  let reference = null;
  for (const [card, now, label] of cases) {
    const { container, cleanup } = await tileOf(card, now);
    try {
      const price = textOf(container, 'search-card-tile-price');
      assert.ok(price && /\d/.test(price), `${label}: the tile still shows its price`);
      assertNoQuoteHint(container, [card.priceQuotedAt, iso(NOW)], `tile ${label}`);
      if (card.sellPrice === 3480) {
        reference ??= price;
        assert.equal(price, reference, `${label}: same price value text in every quote state`);
      }
    } finally { await cleanup(); }
  }
  assert.equal(SearchResultsModule.compactPriceMarker, undefined, 'the compact marker presentation hook is gone');
});

await test('F2 compact tile: no quote → no price; tap still navigates; list row shows the price with no marker', async () => {
  const unpriced = searchPayload([detailRow({ id: 'hZZ98-001_hPR_X', series: 'hPR', sourceProduct: 'hPR', rarity: 'P', sellPrice: null, prices: [] })]);
  {
    const { container, cleanup } = await tileOf(unpriced, NOW);
    try {
      assert.equal(textOf(container, 'search-card-tile-price'), null);
      assertNoQuoteHint(container, [], 'unpriced tile');
    } finally { await cleanup(); }
  }
  {
    let pressed = 0;
    const { container, cleanup } = await tileOf(searchPayload([rowParallel]), NOW, () => { pressed += 1; });
    try {
      const tile = container.querySelector('[data-testid="search-card-tile"]');
      await act(async () => { tile.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); await Promise.resolve(); });
      assert.equal(pressed, 1, 'navigation handler unchanged');
    } finally { await cleanup(); }
  }
  for (const [card, label] of [[searchPayload([rowParallel]), 'old'], [searchPayload([rowParallelRetained]), 'retained'], [searchPayload([rowNoTime]), 'unknown time']]) {
    const { container, cleanup } = await renderEl(React.createElement(CardListItem, { card, onPress() {} }));
    try {
      const row = textOf(container, 'search-result-price-row');
      assert.ok(row && /\d/.test(row), `list ${label}: price shown`);
      assertNoQuoteHint(container, [card.priceQuotedAt, iso(NOW)], `list ${label}`);
    } finally { await cleanup(); }
  }
  // the classifier itself stays available internally (not rendered): the same payload is still
  // classified exactly as before
  assert.equal(classifyPriceFreshness({ price: 3480, quotedAt: searchPayload([rowParallel]).priceQuotedAt, now: NOW }).state, 'last-known');
  assert.equal(classifyPriceFreshness({ price: 3480, quotedAt: FRESH2, now: NOW, retained: true }).state, 'last-known');
  assert.equal(classifyPriceFreshness({ price: 120, quotedAt: FRESH, now: NOW }).state, 'fresh');
});

console.log(`\n${process.exitCode ? '✗' : '✓'} last-known price: ${passed} checks passed`);
