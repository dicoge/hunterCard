#!/usr/bin/env node
// Last-known BUY quote + explicit retained status (2026-11-07 follow-up to ef4f0fae).
//
// PR 2834252d46f dropped proven buy quotes: a rebuild erased the per-variant tuple, and the
// merge cleared every variant without a fresh (18h) source match, so a Torecolo 403 / stale
// or missing file erased them. This suite pins the fix with isolated synthetic fixtures only
// (card number hZZ98-001 does not exist; source files live in os.tmpdir(); no network; no
// data/ or public/ file is read for fixtures or written):
//
//   A. classifier: the writer's `retained` flag is "no new quote this run" regardless of age
//      (a one-day-old sell quote and a one-hour-old buy quote are both NOT fresh when
//      retained); the buy age window mirrors merge-buy-prices' 18h; label keys.
//   B. merge reconcile (real merge-buy-prices.js + preserve-market-fields.js):
//      fresh → missing → missing (+ full rebuild holder) → new; a quote from before this run
//      (403 left yesterday's file) is not "new"; mixed fresh/stale sources (a LOWER fresh
//      quote wins, the stale cache never does; max among fresh quotes kept); base / SEC /
//      plain parallel / reprint / unknown / alias / conflict / corrupt / missing source /
//      future / source-mismatched / malformed evidence; never recovered from the history
//      scalar; history only for real observations at their own date; no holder ever ships.
//   C. regen: same reconcile, fresh output unchanged (no new fields), retained writes no
//      snapshot-date record.
//   D. privacy: nested sentinels of every new buy field never survive the public projection,
//      the Store MVP mapper or the remote-catalog contract; the full web copy keeps the
//      retained flag but never the holder; sellQuoteRetained is sell metadata only.
//   E. UI (full profile): buy line inside 市場數據 shows source + original time + the
//      retained label; sell headline / compact marker / scan say 無新報價 for a retained
//      one-day-old quote and nothing old for a fresh one; Store MVP payload has no buy line.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';

process.env.EXPO_PUBLIC_STORE_MVP = '0';
delete process.env.HUNTERCARD_RUN_STARTED_AT;

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
  mergeBuyPricesInto, runStartedAtMs, lastKnownBuyCandidate, reconcileCardBuyQuotes, MAX_SOURCE_AGE_HOURS,
} = await import('./merge-buy-prices.js');
const { capturePriorBuySources } = await import('./lib/buy-source-cache.js');
const { regenerateBuyAlignment } = await import('./regen-buy-alignment.mjs');
const { restoreBuyQuotes, restoreBuyPriceHistory } = await import('./lib/preserve-market-fields.js');
const { sanitizeDatabase, stripInternalAuditDatabase } = await import('./lib/store-mvp-sanitize.mjs');
const { findForbiddenField } = await import('../src/services/catalog/catalogContract.ts');
const { stripDisabledCardFields } = await import('../src/utils/cardReleaseFilter.ts');
const {
  classifyPriceFreshness, quoteLineKey, quoteTagKey, BUY_QUOTE_FRESH_MAX_AGE_MS,
} = await import('../src/utils/priceFreshness.ts');
const { buildPriceVersions } = await import('../src/utils/versionAlignment.ts');
const { toCanonicalCardRecord, dedupeListings } = await import('../src/utils/canonicalCardRecord.ts');
const { provenanceFromRow } = await import('../src/utils/printingQuotes.ts');
const { scanQuoteProvenance } = await import('../src/utils/scanQuoteProvenance.ts');
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const CardDetailScreen = (await import('../src/screens/CardDetailScreen.tsx')).default;
const { compactPriceMarker } = await import('../src/screens/SearchResultsScreen.tsx');

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

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();
const localDay = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const clone = (v) => JSON.parse(JSON.stringify(v));
const FULL = { buyPrice: true, trendPrediction: true, ytStats: true };
const STORE = { buyPrice: false, trendPrediction: false, ytStats: false };

// ── fixtures ──────────────────────────────────────────────────────────────
const tmpDirs = [];
function sourceDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'last-known-buy-'));
  tmpDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}
const entry = (buyPrice, rarity, timestamp) => ({ buyPrice, rarity, timestamp });
const BASE_NAME = 'テスト';
const PAR_NAME = 'テスト(パラレル)';
const SIGN_NAME = 'テスト(パラレル/サイン)';
const OWN = 'hZZ98-001_hZZ98_C';
const REPRINT = 'hZZ98-001_hBP07_C';
const card = (id, series, over = {}) => ({
  id, cardNumber: 'hZZ98-001', rarity: 'C', series, name: 'テスト',
  prices: [
    { name: BASE_NAME, sellPrice: 100 },
    { name: PAR_NAME, sellPrice: 3000 },
    { name: SIGN_NAME, sellPrice: 9000 },
  ],
  ...over,
});
const freshDb = () => ({ cards: { [OWN]: card(OWN, 'hZZ98'), [REPRINT]: card(REPRINT, 'hBP07') } });
const v = (db, id, name) => db.cards[id].prices.find((p) => p.name === name);
const tuple = (p) => (p ? {
  buyPrice: p.buyPrice, buyPriceVersion: p.buyPriceVersion, buyPriceSource: p.buyPriceSource,
  buyPriceTimestamp: p.buyPriceTimestamp, buyPriceRetained: p.buyPriceRetained,
} : null);
const noHolderAnywhere = (db) => Object.values(db.cards).every((c) => (c.prices || []).every((p) => !('buyLastKnown' in p)));

// Day 1 run: torecolo quotes base 50, SR (plain parallel) 1200, SEC 5000.
const R1 = Date.parse('2026-11-01T01:00:00.000Z');
const T1 = iso(R1 + 10 * 60 * 1000);
const N1 = R1 + 30 * 60 * 1000;
const day1Files = {
  'torecolo-prices.json': {
    'hZZ98-001': entry(50, null, T1),
    'hZZ98-001-SR': entry(1200, 'SR', T1),
    'hZZ98-001-SEC': entry(5000, 'SEC', T1),
  },
};

console.log('── last-known BUY quote + explicit retained status (2026-11-07) ──');

// ── A. classifier ─────────────────────────────────────────────────────────
await test('A1 retained is independent of age: 1-day sell and 1-hour buy quotes are NOT fresh when retained', () => {
  const now = Date.parse('2026-11-07T00:00:00.000Z');
  const sell = classifyPriceFreshness({ price: 980, quotedAt: iso(now - DAY), now, retained: true });
  assert.deepEqual(sell, { state: 'last-known', quotedAt: iso(now - DAY), quoteDate: iso(now - DAY).slice(0, 10), retained: true });
  assert.equal(classifyPriceFreshness({ price: 980, quotedAt: iso(now - DAY), now }).state, 'fresh', 'same age, writer says new → fresh');
  const buyNew = classifyPriceFreshness({ price: 50, quotedAt: iso(now - HOUR), now, maxAgeMs: BUY_QUOTE_FRESH_MAX_AGE_MS });
  assert.equal(buyNew.state, 'fresh');
  assert.equal(classifyPriceFreshness({ price: 50, quotedAt: iso(now - HOUR), now, maxAgeMs: BUY_QUOTE_FRESH_MAX_AGE_MS, retained: true }).state, 'last-known');
  assert.equal(classifyPriceFreshness({ price: 50, quotedAt: iso(now - 20 * HOUR), now, maxAgeMs: BUY_QUOTE_FRESH_MAX_AGE_MS }).state, 'last-known', '18h buy window');
  const unknown = classifyPriceFreshness({ price: 50, quotedAt: null, now, retained: true });
  assert.equal(unknown.state, 'unknown-date');
  assert.equal(unknown.retained, true);
  assert.equal(classifyPriceFreshness({ price: 0, quotedAt: iso(now), now, retained: true }).retained, false, 'no price → nothing claimed');
  assert.equal(BUY_QUOTE_FRESH_MAX_AGE_MS, MAX_SOURCE_AGE_HOURS * HOUR, 'client buy window mirrors merge-buy-prices');
});

await test('A2 label keys: retained → 無新報價 lines/tags; old-but-not-retained keeps the old-price key; buy lines use buy wording', async () => {
  const now = Date.parse('2026-11-07T00:00:00.000Z');
  const f = (o) => classifyPriceFreshness({ price: 1, now, ...o });
  assert.deepEqual(quoteLineKey(f({ quotedAt: iso(now - DAY), retained: true })), { key: 'price_quote_retained', stale: true });
  assert.deepEqual(quoteLineKey(f({ quotedAt: null, retained: true })), { key: 'price_quote_retained_unknown_date', stale: true });
  assert.deepEqual(quoteLineKey(f({ quotedAt: iso(now - 30 * DAY) })), { key: 'price_quote_last_known', stale: true });
  assert.deepEqual(quoteLineKey(f({ quotedAt: iso(now - DAY) })), { key: 'price_quote_fresh', stale: false });
  // buy context: the two price-type-worded states use buy keys; neutral states are shared
  assert.deepEqual(quoteLineKey(f({ quotedAt: iso(now - 30 * DAY) }), 'buy'), { key: 'price_buy_quote_last_known', stale: true });
  assert.deepEqual(quoteLineKey(f({ quotedAt: null }), 'buy'), { key: 'price_buy_quote_unknown_date', stale: true });
  assert.deepEqual(quoteLineKey(f({ quotedAt: iso(now - DAY), retained: true }), 'buy'), { key: 'price_quote_retained', stale: true });
  assert.deepEqual(quoteLineKey(f({ quotedAt: null, retained: true }), 'buy'), { key: 'price_quote_retained_unknown_date', stale: true });
  assert.deepEqual(quoteLineKey(f({ quotedAt: iso(now - DAY) }), 'buy'), { key: 'price_quote_fresh', stale: false });
  // locale wording: every string a BUY line can show is neutral (報價) or buy-specific — never 售價 / 販売
  const { zh } = await import('../src/i18n/locales/zh.ts');
  const { ja } = await import('../src/i18n/locales/ja.ts');
  const buyKeys = ['price_quote_fresh', 'price_buy_quote_last_known', 'price_buy_quote_unknown_date', 'price_quote_retained', 'price_quote_retained_unknown_date', 'price_buy_quote_source'];
  for (const k of buyKeys) {
    assert.ok(typeof zh[k] === 'string' && typeof ja[k] === 'string', `${k} exists in zh and ja`);
    assert.doesNotMatch(zh[k], /售價/, `zh ${k} must not call a buy quote a selling price`);
    assert.doesNotMatch(ja[k], /販売/, `ja ${k} must not call a buy quote a selling price`);
  }
  assert.match(zh.price_buy_quote_last_known, /收購價/);
  assert.match(zh.price_buy_quote_unknown_date, /收購價/);
  assert.match(ja.price_buy_quote_last_known, /買取/);
  assert.match(ja.price_buy_quote_unknown_date, /買取/);
  assert.match(zh.price_quote_last_known, /售價/, 'sell wording unchanged');
  assert.equal(quoteTagKey(f({ quotedAt: iso(now - DAY), retained: true })), 'price_quote_retained_tag');
  assert.equal(quoteTagKey(f({ quotedAt: iso(now - 30 * DAY) })), 'price_quote_old_tag');
  assert.equal(quoteTagKey(f({ quotedAt: iso(now - DAY) })), null);
  const src = fs.readFileSync(new URL('../src/utils/priceFreshness.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^import /m, 'classifier stays import-free');
});

// ── B. merge reconcile ────────────────────────────────────────────────────
await test('B1 fresh → missing → missing (full rebuild) → new: exact tuple kept with original source/time, retained; history only for real observations', () => {
  const db = freshDb();
  // run 1: fresh
  mergeBuyPricesInto(db, { now: N1, runStartedAt: R1, dir: sourceDir(day1Files) });
  assert.deepEqual(tuple(v(db, OWN, BASE_NAME)), { buyPrice: 50, buyPriceVersion: 'BASE', buyPriceSource: 'torecolo', buyPriceTimestamp: T1, buyPriceRetained: undefined });
  assert.deepEqual(tuple(v(db, OWN, PAR_NAME)), { buyPrice: 1200, buyPriceVersion: 'SR', buyPriceSource: 'torecolo', buyPriceTimestamp: T1, buyPriceRetained: undefined });
  assert.equal(v(db, OWN, SIGN_NAME).buyPriceVersion, 'SEC');
  assert.equal(db.cards[OWN].buyPrice, 50);
  assert.equal(db.cards[OWN].buyPriceRetained, undefined);
  assert.deepEqual(db.cards[OWN].buyPriceHistory, { [localDay(Date.parse(T1))]: 50 });
  assert.equal(db.cards[REPRINT].buyPrice, undefined, 'reprint row never takes the bare (original-printing) listing');
  const historyAfter1 = clone(db.cards[OWN].buyPriceHistory);

  // run 2 (next day): Torecolo 403 → no source file at all.
  const R2 = R1 + DAY;
  mergeBuyPricesInto(db, { now: R2 + HOUR, runStartedAt: R2, dir: sourceDir({}) });
  for (const [name, want] of [[BASE_NAME, [50, 'BASE']], [PAR_NAME, [1200, 'SR']], [SIGN_NAME, [5000, 'SEC']]]) {
    const p = v(db, OWN, name);
    assert.deepEqual(tuple(p), { buyPrice: want[0], buyPriceVersion: want[1], buyPriceSource: 'torecolo', buyPriceTimestamp: T1, buyPriceRetained: true }, name);
  }
  assert.equal(db.cards[OWN].buyPrice, 50);
  assert.equal(db.cards[OWN].buyPriceRetained, true, 'card-level last-known is explicit');
  assert.deepEqual(db.cards[OWN].buyPriceHistory, historyAfter1, 'no today record for a retained quote');
  assert.equal(db.cards[REPRINT].buyPrice, undefined, 'reprint still has no card-level buy price');
  assert.equal(v(db, REPRINT, BASE_NAME).buyPriceRetained, true, 'the reprint row\'s own variant tuple is retained as its own evidence');

  // run 3 (day 3): full rebuild from scratch (no buy fields) + holder carry, source file stale.
  const prev = clone(db.cards);
  const rebuilt = freshDb();
  rebuilt.cards[OWN].buyPriceHistory = undefined;
  restoreBuyPriceHistory(rebuilt.cards, prev);
  const held = restoreBuyQuotes(rebuilt.cards, prev);
  assert.equal(held.variants, 6, 'every exact variant of both rows held');
  assert.equal(rebuilt.cards[OWN].buyPrice, undefined, 'the rebuild never restores a current claim');
  assert.equal(v(rebuilt, OWN, BASE_NAME).buyPrice, undefined);
  assert.deepEqual(v(rebuilt, OWN, BASE_NAME).buyLastKnown, { price: 50, version: 'BASE', source: 'torecolo', timestamp: T1 });
  const R3 = R1 + 2 * DAY;
  mergeBuyPricesInto(rebuilt, { now: R3 + HOUR, runStartedAt: R3, dir: sourceDir(day1Files) });
  assert.deepEqual(tuple(v(rebuilt, OWN, PAR_NAME)), { buyPrice: 1200, buyPriceVersion: 'SR', buyPriceSource: 'torecolo', buyPriceTimestamp: T1, buyPriceRetained: true });
  assert.equal(rebuilt.cards[OWN].buyPriceRetained, true);
  assert.deepEqual(rebuilt.cards[OWN].buyPriceHistory, historyAfter1, 'stale file is not a new observation');
  assert.ok(noHolderAnywhere(rebuilt), 'the merge converts every holder; none ships');

  // run 4: a NEW quote of the same value — counts as new because it was observed this run.
  const R4 = R1 + 3 * DAY;
  const T4 = iso(R4 + 5 * 60 * 1000);
  mergeBuyPricesInto(rebuilt, {
    now: R4 + HOUR, runStartedAt: R4,
    dir: sourceDir({ 'torecolo-prices.json': { 'hZZ98-001': entry(50, null, T4), 'hZZ98-001-SR': entry(1200, 'SR', T4) } }),
  });
  assert.deepEqual(tuple(v(rebuilt, OWN, BASE_NAME)), { buyPrice: 50, buyPriceVersion: 'BASE', buyPriceSource: 'torecolo', buyPriceTimestamp: T4, buyPriceRetained: undefined });
  assert.equal(rebuilt.cards[OWN].buyPriceRetained, undefined, 'a new quote clears the retained status');
  assert.deepEqual(rebuilt.cards[OWN].buyPriceHistory, { ...historyAfter1, [localDay(Date.parse(T4))]: 50 }, 'earlier records unchanged; one record at the new observation date');
  assert.equal(v(rebuilt, OWN, SIGN_NAME).buyPriceRetained, true, 'SEC got no new quote → still retained with its own time');
  assert.equal(v(rebuilt, OWN, SIGN_NAME).buyPriceTimestamp, T1);
});

await test('B2 yesterday\'s file (403 today) is NOT a new quote even though it is < 18h old', () => {
  const db = freshDb();
  mergeBuyPricesInto(db, { now: N1, runStartedAt: R1, dir: sourceDir(day1Files) });
  const R2 = Date.parse(T1) + 6 * HOUR; // within 18h of T1, but after it
  mergeBuyPricesInto(db, { now: R2 + 10 * 60 * 1000, runStartedAt: R2, dir: sourceDir(day1Files) });
  assert.equal(v(db, OWN, BASE_NAME).buyPriceRetained, true, 'not observed this run → retained, original time');
  assert.equal(v(db, OWN, BASE_NAME).buyPriceTimestamp, T1);
  assert.equal(db.cards[OWN].buyPriceRetained, true);
  // without an explicit run start nothing can be proven new
  assert.equal(runStartedAtMs(N1, undefined), null);
  assert.equal(runStartedAtMs(N1, 'abc'), null);
  assert.equal(runStartedAtMs(N1, String(Math.floor((N1 + DAY) / 1000))), null, 'future start is a leaked env');
  assert.equal(runStartedAtMs(N1, String(Math.floor((N1 - 2 * DAY) / 1000))), null, '>1 day old start is a leaked env');
  assert.equal(runStartedAtMs(N1, String(Math.floor(R1 / 1000))), R1);
  // Manual run without a marker: the valid (unmarked) source cache is RETAINED, never fresh.
  const db2 = freshDb();
  mergeBuyPricesInto(db2, { now: N1, runStartedAt: null, dir: sourceDir(day1Files) });
  assert.deepEqual(tuple(v(db2, OWN, BASE_NAME)), { buyPrice: 50, buyPriceVersion: 'BASE', buyPriceSource: 'torecolo', buyPriceTimestamp: T1, buyPriceRetained: true },
    'no run marker → the cache is kept as last-known with its own time, never presented as new');
  assert.equal(db2.cards[OWN].buyPriceRetained, true);
  assert.deepEqual(db2.cards[OWN].buyLastKnown, { price: 50, version: 'BASE', source: 'torecolo', timestamp: T1, sourceKey: 'hZZ98-001' });
  assert.equal(db2.cards[OWN].buyPriceHistory, undefined, 'no history without a proven observation');
  // and a stale (>18h) cache entry with a marker is retained too, not ignored
  const db3 = freshDb();
  mergeBuyPricesInto(db3, { now: N1 + 3 * DAY, runStartedAt: N1 + 3 * DAY - HOUR, dir: sourceDir(day1Files) });
  assert.equal(v(db3, OWN, PAR_NAME).buyPriceRetained, true);
  assert.equal(v(db3, OWN, PAR_NAME).buyPriceTimestamp, T1);
  assert.equal(db3.cards[OWN].buyPriceHistory, undefined);
});

await test('B7 PR283 shape — card-level-only quote: prior source cache captured at rebuild → partial fresh file → retained with exact source/time; survives rebuild + repeated misses; fresh lower wins', () => {
  // A card-level-only row: own-set C printing whose prices[] has NO base listing (no tuple to carry).
  const ONLY = 'hZZ97-004_hZZ97_U';
  const mk = () => ({ cards: { [ONLY]: { id: ONLY, cardNumber: 'hZZ97-004', rarity: 'U', series: 'hZZ97', prices: [{ name: 'テスト(パラレル/SR)', sellPrice: 900 }] } } });
  const TP = '2026-11-06T12:09:18.847Z';
  const prior = sourceDir({ 'fullahead-prices.json': { 'hZZ97-004': entry(10, null, TP), 'hZZ99-001': entry(3, null, TP) } });
  const partial = sourceDir({ 'fullahead-prices.json': { 'hZZ99-001': entry(4, null, iso(Date.parse(TP) + DAY)) } }); // key omitted
  const now = Date.parse(TP) + DAY + HOUR;
  // run A: rebuild captures the on-disk cache BEFORE the scrape overwrites it
  const db = mk();
  const cap = capturePriorBuySources(db.cards, { dir: prior, now });
  assert.equal(cap.records, 1);
  assert.deepEqual(db.cards[ONLY].buyPriorSource, [{ sourceKey: 'hZZ97-004', token: '', price: 10, source: 'fullahead', timestamp: TP }]);
  assert.equal(db.cards[ONLY].buyPrice, undefined, 'capture is evidence, never a claim');
  mergeBuyPricesInto(db, { now, runStartedAt: now - 2 * HOUR, dir: partial });
  assert.equal(db.cards[ONLY].buyPrice, 10);
  assert.equal(db.cards[ONLY].buyPriceRetained, true);
  assert.deepEqual(db.cards[ONLY].buyLastKnown, { price: 10, version: 'BASE', source: 'fullahead', timestamp: TP, sourceKey: 'hZZ97-004' });
  assert.equal(db.cards[ONLY].buyPriorSource, undefined, 'raw capture consumed by the merge');
  assert.equal(db.cards[ONLY].buyPriceHistory, undefined, 'no history for a retained quote');
  assert.equal(db.cards[ONLY].prices[0].buyPrice, undefined, 'the SR variant never takes the bare listing');
  // run B: full rebuild (no buy fields), cache is now the PARTIAL file → card holder carries it
  const rebuilt = mk();
  restoreBuyQuotes(rebuilt.cards, clone(db.cards));
  assert.deepEqual(rebuilt.cards[ONLY].buyLastKnown, db.cards[ONLY].buyLastKnown, 'card holder carried by exact printing');
  assert.equal(rebuilt.cards[ONLY].buyPrice, undefined, 'card scalar never restored');
  capturePriorBuySources(rebuilt.cards, { dir: partial, now: now + DAY });
  mergeBuyPricesInto(rebuilt, { now: now + DAY, runStartedAt: now + DAY - HOUR, dir: sourceDir({}) });
  assert.equal(rebuilt.cards[ONLY].buyPrice, 10);
  assert.equal(rebuilt.cards[ONLY].buyPriceRetained, true);
  assert.equal(rebuilt.cards[ONLY].buyLastKnown.timestamp, TP, 'original observation time across rebuild + second miss');
  // run C: a FRESH lower quote of the same token wins and clears the holder
  const TF = iso(now + 2 * DAY - 30 * 60 * 1000);
  mergeBuyPricesInto(rebuilt, { now: now + 2 * DAY, runStartedAt: now + 2 * DAY - HOUR, dir: sourceDir({ 'torecolo-prices.json': { 'hZZ97-004': entry(7, null, TF) } }) });
  assert.equal(rebuilt.cards[ONLY].buyPrice, 7);
  assert.equal(rebuilt.cards[ONLY].buyPriceRetained, undefined);
  assert.equal(rebuilt.cards[ONLY].buyLastKnown, undefined);
  assert.deepEqual(rebuilt.cards[ONLY].buyPriceHistory, { [localDay(Date.parse(TF))]: 7 });
});

await test('B8 card-level prior source: reprint / unknown rarity / premium token / conflicts / future / non-market keys fail closed or match exactly', () => {
  const now = Date.parse('2026-11-07T12:00:00.000Z');
  const T = '2026-11-06T12:09:18.847Z';
  const run = (cardsIn, files) => {
    const db = { cards: clone(cardsIn) };
    capturePriorBuySources(db.cards, { dir: sourceDir(files), now });
    const reasons = {};
    for (const [id, c] of Object.entries(db.cards)) {
      reasons[id] = reconcileCardBuyQuotes(c, [], now).cardReason;
    }
    return { db, reasons };
  };
  const row = (id, rarity, series, prices = []) => ({ id, cardNumber: 'hZZ96-010', rarity, series, prices });
  {
    const { db, reasons } = run({
      own: row('own', 'C', 'hZZ96'), reprint: row('reprint', 'C', 'hBP07'), unknown: row('unknown', 'XYZ', 'hZZ96'), hr: row('hr', '02_HR', 'ent07'),
    }, { 'fullahead-prices.json': { 'hZZ96-010': entry(10, null, T), 'hZZ96-010-HR': entry(900, 'HR', T), 'hZZ96-010-ZZ': entry(5, 'ZZ', T) } });
    assert.equal(db.cards.own.buyPrice, 10);
    assert.equal(db.cards.reprint.buyPrice, undefined);
    assert.equal(reasons.reprint, 'reprint-row-cannot-take-bare-listing');
    assert.equal(db.cards.unknown.buyPrice, undefined);
    assert.match(reasons.unknown, /^unknown-rarity/);
    assert.equal(db.cards.hr.buyPrice, 900, 'premium printing takes only its exact token (02_HR → HR)');
    assert.equal(db.cards.hr.buyLastKnown.version, 'HR');
    assert.ok(Object.values(db.cards).every((c) => !('buyPriorSource' in c)));
  }
  {
    // same token, two shops, same newest time, different value → conflict, nothing retained
    const { db, reasons } = run({ own: row('own', 'C', 'hZZ96') }, {
      'fullahead-prices.json': { 'hZZ96-010': entry(10, null, T) }, 'torecolo-prices.json': { 'hZZ96-010': entry(12, null, T) },
    });
    assert.equal(db.cards.own.buyPrice, undefined);
    assert.equal(reasons.own, 'conflicting-evidence:BASE');
  }
  {
    // newer observation wins over an older one (unique newest); bare + own-code listing → conflict rule
    const { db } = run({ own: row('own', 'C', 'hZZ96') }, {
      'fullahead-prices.json': { 'hZZ96-010': entry(10, null, T) }, 'torecolo-prices.json': { 'hZZ96-010': entry(12, null, '2026-11-05T00:00:00.000Z') },
    });
    assert.equal(db.cards.own.buyPrice, 10);
    const { reasons: r2 } = run({ own: row('own', 'C', 'hZZ96') }, { 'fullahead-prices.json': { 'hZZ96-010': entry(10, null, T), 'hZZ96-010-C': entry(11, 'C', T) } });
    assert.equal(r2.own, 'bare-and-C-listings-both-present');
  }
  {
    // future-dated / malformed cache entries are never evidence
    const { db, reasons } = run({ own: row('own', 'C', 'hZZ96') }, {
      'fullahead-prices.json': { 'hZZ96-010': entry(10, null, iso(now + DAY)), 'hZZ96-010-SEC': { buyPrice: 'x', rarity: 'SEC', timestamp: T } },
    });
    assert.equal(db.cards.own.buyPrice, undefined);
    assert.equal(reasons.own, 'no-evidence-for-token:BASE');
  }
  // capture keeps only market-data keys
  const db = { cards: { own: row('own', 'C', 'hZZ96') } };
  capturePriorBuySources(db.cards, { dir: sourceDir({ 'fullahead-prices.json': { 'hZZ96-010': { ...entry(10, null, T), account: 'x', userCost: 1 } } }), now });
  assert.deepEqual(Object.keys(db.cards.own.buyPriorSource[0]).sort(), ['price', 'source', 'sourceKey', 'timestamp', 'token']);
});

await test('B3 mixed fresh + stale sources: a LOWER fresh quote wins over the stale cache; max among fresh quotes kept', () => {
  const db = freshDb();
  mergeBuyPricesInto(db, { now: N1, runStartedAt: R1, dir: sourceDir(day1Files) }); // SR 1200 torecolo
  const R2 = R1 + DAY;
  const T2 = iso(R2 + 60 * 1000);
  mergeBuyPricesInto(db, {
    now: R2 + HOUR, runStartedAt: R2,
    dir: sourceDir({
      'torecolo-prices.json': { 'hZZ98-001-SR': entry(1500, 'SR', T1) }, // stale/earlier, higher
      'fullahead-prices.json': { 'hZZ98-001-SR': entry(900, 'SR', T2) }, // fresh, lower
    }),
  });
  assert.deepEqual(tuple(v(db, OWN, PAR_NAME)), { buyPrice: 900, buyPriceVersion: 'SR', buyPriceSource: 'fullahead', buyPriceTimestamp: T2, buyPriceRetained: undefined });
  const R3 = R1 + 2 * DAY;
  const T3a = iso(R3 + 60 * 1000);
  const T3b = iso(R3 + 2 * 60 * 1000);
  mergeBuyPricesInto(db, {
    now: R3 + HOUR, runStartedAt: R3,
    dir: sourceDir({
      'torecolo-prices.json': { 'hZZ98-001-SR': entry(1000, 'SR', T3a) },
      'fullahead-prices.json': { 'hZZ98-001-SR': entry(950, 'SR', T3b) },
    }),
  });
  assert.deepEqual(tuple(v(db, OWN, PAR_NAME)), { buyPrice: 1000, buyPriceVersion: 'SR', buyPriceSource: 'torecolo', buyPriceTimestamp: T3a, buyPriceRetained: undefined }, 'existing policy: max among FRESH quotes of the same version, with its own source/time');
});

await test('B4 version identity: base / SEC / plain parallel kept; different printing, unknown, alias, conflict refused', () => {
  const now = Date.parse('2026-11-07T00:00:00.000Z');
  const held = (price, version, source = 'torecolo', timestamp = iso(now - 3 * DAY)) => ({ buyLastKnown: { price, version, source, timestamp } });
  const db = {
    cards: {
      [OWN]: card(OWN, 'hZZ98', {
        prices: [
          { name: BASE_NAME, sellPrice: 100, ...held(50, 'BASE') },
          { name: PAR_NAME, sellPrice: 3000, ...held(1200, 'BASE') }, // different printing's evidence
          { name: SIGN_NAME, sellPrice: 9000, ...held(5000, 'SEC') },
          { name: 'テスト(パラレル/HR)', sellPrice: 7000, ...held(3000, 'XYZ') }, // unknown suffix
          { name: 'テスト(パラレル/hSD06)', sellPrice: 800, ...held(70, 'PR') }, // alias, not exact
        ],
      }),
      dup: card('dup', 'hZZ98', {
        prices: [
          { name: 'テスト(パラレル/UR)', sellPrice: 5000, ...held(2000, 'UR') },
          { name: 'テスト(パラレル/UR)', sellPrice: 5100, ...held(2100, 'UR') }, // same label twice → ambiguous
          { name: PAR_NAME, sellPrice: 3000, ...held(1200, 'SR') },
          { name: PAR_NAME, sellPrice: 3100, ...held(1300, 'OUR') }, // two plain parallels → ambiguous
        ],
      }),
    },
  };
  mergeBuyPricesInto(db, { now, runStartedAt: now - HOUR, dir: sourceDir({}) });
  const own = db.cards[OWN].prices;
  assert.equal(own[0].buyPrice, 50);
  assert.equal(own[0].buyPriceRetained, true);
  assert.equal(own[1].buyPrice, undefined, 'BASE evidence never lands on the parallel');
  assert.equal(own[2].buyPrice, 5000);
  assert.equal(own[2].buyPriceVersion, 'SEC');
  assert.equal(own[3].buyPrice, undefined, 'unknown suffix refused');
  assert.equal(own[4].buyPrice, undefined, 'alias PR is not the exact token');
  assert.ok(db.cards.dup.prices.every((p) => p.buyPrice === undefined), 'conflicts carry nothing');
  assert.ok(noHolderAnywhere(db));
  // a refused one stays refused next run (no holder left to resurrect it)
  mergeBuyPricesInto(db, { now: now + DAY, runStartedAt: now + DAY - HOUR, dir: sourceDir({}) });
  assert.equal(db.cards[OWN].prices[1].buyPrice, undefined);
  assert.equal(db.cards[OWN].prices[0].buyPrice, 50, 'the valid retained quote survives repeated missing runs');
});

await test('B5 corrupt / missing source, future / source-mismatched / malformed evidence fail closed', () => {
  const now = Date.parse('2026-11-07T00:00:00.000Z');
  const T = iso(now - 2 * DAY);
  const mk = (over) => ({ cards: { [OWN]: card(OWN, 'hZZ98', { prices: [{ name: BASE_NAME, sellPrice: 100, ...over }] }) } });
  // corrupt / non-object / missing source files → held quote retained
  for (const files of [{ 'torecolo-prices.json': '{not json' }, { 'torecolo-prices.json': '[1,2]' }, {}]) {
    const db = mk({ buyPrice: 50, buyPriceVersion: 'BASE', buyPriceSource: 'torecolo', buyPriceTimestamp: T });
    mergeBuyPricesInto(db, { now, runStartedAt: now - HOUR, dir: sourceDir(files) });
    assert.equal(db.cards[OWN].prices[0].buyPriceRetained, true, JSON.stringify(files));
    assert.equal(db.cards[OWN].prices[0].buyPriceTimestamp, T);
  }
  // a future-dated SOURCE entry is not fresh
  const fut = mk({});
  mergeBuyPricesInto(fut, { now, runStartedAt: now - HOUR, dir: sourceDir({ 'torecolo-prices.json': { 'hZZ98-001': entry(60, null, iso(now + DAY)) } }) });
  assert.equal(fut.cards[OWN].prices[0].buyPrice, undefined);
  assert.equal(fut.cards[OWN].buyPriceHistory, undefined);
  // invalid held evidence
  for (const bad of [
    { price: 50, version: 'BASE', source: 'torecolo', timestamp: iso(now + DAY) }, // future
    { price: 50, version: 'BASE', source: 'mercari', timestamp: T }, // unknown source
    { price: 50, version: 'BASE', source: '', timestamp: T },
    { price: '50', version: 'BASE', source: 'torecolo', timestamp: T }, // malformed value
    { price: 0, version: 'BASE', source: 'torecolo', timestamp: T },
    { price: 50, version: 'BASE', source: 'torecolo', timestamp: 'yesterday' },
    { price: 50, version: '', source: 'torecolo', timestamp: T },
    { price: 50, version: '#UNKNOWN', source: 'torecolo', timestamp: T },
  ]) {
    assert.equal(lastKnownBuyCandidate({ buyLastKnown: bad }, now), null, JSON.stringify(bad));
    const db = mk({ buyLastKnown: bad });
    mergeBuyPricesInto(db, { now, runStartedAt: now - HOUR, dir: sourceDir({}) });
    assert.equal(db.cards[OWN].prices[0].buyPrice, undefined, JSON.stringify(bad));
    assert.ok(noHolderAnywhere(db));
  }
});

await test('B6 never recovered from the history scalar or user/account data; history records never rewritten', () => {
  const now = Date.parse('2026-11-07T00:00:00.000Z');
  const db = { cards: { [OWN]: card(OWN, 'hZZ98', { buyPriceHistory: { '2026-10-01': 50 }, myCost: 999, purchasePrice: 999 }) } };
  mergeBuyPricesInto(db, { now, runStartedAt: now - HOUR, dir: sourceDir({}) });
  assert.equal(db.cards[OWN].buyPrice, undefined, 'a history value is not a current or last-known quote');
  assert.ok(db.cards[OWN].prices.every((p) => p.buyPrice === undefined));
  assert.deepEqual(db.cards[OWN].buyPriceHistory, { '2026-10-01': 50 });
  // same observation date already recorded with another value → kept, not rewritten
  const T = iso(now - 30 * 60 * 1000);
  const db2 = { cards: { [OWN]: card(OWN, 'hZZ98', { buyPriceHistory: { [localDay(Date.parse(T))]: 40 } }) } };
  mergeBuyPricesInto(db2, { now, runStartedAt: now - HOUR, dir: sourceDir({ 'torecolo-prices.json': { 'hZZ98-001': entry(55, null, T) } }) });
  assert.equal(db2.cards[OWN].buyPrice, 55);
  assert.equal(db2.cards[OWN].buyPriceHistory[localDay(Date.parse(T))], 40);
});

// ── C. regen ──────────────────────────────────────────────────────────────
await test('C1 regen: fresh snapshot output has no new field; retained writes no snapshot-date record', () => {
  const dir = sourceDir(day1Files);
  const db = freshDb();
  const date = T1.slice(0, 10);
  regenerateBuyAlignment(db, { now: Date.parse(T1) + 1000, date, buyDir: dir });
  const keys = new Set(db.cards[OWN].prices.flatMap((p) => Object.keys(p)));
  assert.ok(!keys.has('buyPriceRetained') && !keys.has('buyLastKnown'), 'fresh regen output is unchanged in shape');
  assert.equal(db.cards[OWN].buyPriceHistory[date], 50);
  const once = JSON.stringify(db);
  regenerateBuyAlignment(db, { now: Date.parse(T1) + 1000, date, buyDir: dir });
  assert.equal(JSON.stringify(db), once, 'regen is a fixed point');
  const later = T1.slice(0, 10) === '2026-11-01' ? '2026-11-03' : '2099-01-01';
  regenerateBuyAlignment(db, { now: Date.parse(T1) + 2 * DAY, date: later, buyDir: dir });
  assert.equal(db.cards[OWN].buyPriceRetained, true);
  assert.equal(db.cards[OWN].buyPriceHistory[later], undefined, 'no fabricated snapshot record for a retained quote');
});

// ── D. privacy ────────────────────────────────────────────────────────────
const SENT = { lkPrice: 71717, lkVer: 'SENT_LK_VER', lkSrc: 'SENT_LK_SRC', lkTs: '2099-01-02T03:04:05.000Z', vBuy: 61616, cBuy: 51515 };
const privateCard = {
  ...card(OWN, 'hZZ98'),
  sellPrice: 100, timestamp: '2026-11-06T00:00:00.000Z', sellQuoteRetained: true,
  buyPrice: SENT.cBuy, buyPriceRetained: true,
  // card-level internal holders (review N1): verified card evidence + raw prior-source capture
  buyLastKnown: { price: SENT.lkPrice, version: SENT.lkVer, source: SENT.lkSrc, timestamp: SENT.lkTs },
  buyPriorSource: [{ sourceKey: SENT.lkVer, token: '', price: SENT.lkPrice, source: SENT.lkSrc, timestamp: SENT.lkTs }],
  prices: [{
    name: BASE_NAME, sellPrice: 100, buyPrice: SENT.vBuy, buyPriceVersion: 'BASE', buyPriceSource: 'torecolo',
    buyPriceTimestamp: '2026-11-05T00:00:00.000Z', buyPriceRetained: true,
    buyLastKnown: { price: SENT.lkPrice, version: SENT.lkVer, source: SENT.lkSrc, timestamp: SENT.lkTs },
  }],
};
const sentinelsIn = (text, list) => list.filter((s) => text.includes(String(s)));

await test('D1 public projection / Store MVP mapper / remote contract: every new buy field stripped, nested sentinels never ship', () => {
  const db = { cards: { [OWN]: privateCard }, totalCards: 1, lastUpdated: '2026-11-07T00:00:00.000Z' };
  const pub = sanitizeDatabase(db);
  const text = JSON.stringify(pub);
  assert.deepEqual(sentinelsIn(text, Object.values(SENT)), []);
  assert.ok(!/buyPriceRetained|buyLastKnown|buyPrice/.test(text), 'no buy key at any depth');
  assert.equal(findForbiddenField(pub.cards[OWN]), null);
  assert.equal(pub.cards[OWN].sellQuoteRetained, true, 'sell status is sell metadata and ships with the sell price');
  for (const [field, at] of [['buyPriceRetained', 'card'], ['buyPriceRetained', 'variant'], ['buyLastKnown', 'variant']]) {
    const c = at === 'card' ? { [field]: true } : { prices: [{ name: 'x', [field]: true }] };
    assert.ok(findForbiddenField(c), `remote catalog contract rejects ${at} ${field}`);
  }
  const fullWeb = stripInternalAuditDatabase(db);
  assert.equal(fullWeb.cards[OWN].prices[0].buyPriceRetained, true, 'full web keeps the retained flag for the full market view');
  assert.ok(!('buyLastKnown' in fullWeb.cards[OWN].prices[0]), 'the unverified holder never ships, on any profile');
  assert.ok(!('buyLastKnown' in fullWeb.cards[OWN]) && !('buyPriorSource' in fullWeb.cards[OWN]), 'card-level holders never ship, on any profile');
  assert.deepEqual(sentinelsIn(JSON.stringify(fullWeb), [SENT.lkPrice, SENT.lkVer, SENT.lkSrc, SENT.lkTs]), []);
  const fullMapped = stripDisabledCardFields(privateCard, FULL);
  assert.ok(!('buyLastKnown' in fullMapped) && !('buyPriorSource' in fullMapped) && !('buyLastKnown' in fullMapped.prices[0]), 'full-profile mapper never exposes holders');
  const mapped = stripDisabledCardFields(privateCard, STORE);
  assert.deepEqual(sentinelsIn(JSON.stringify(mapped), Object.values(SENT)), []);
  assert.ok(!/buyPriceRetained|buyLastKnown|"buyPrice/.test(JSON.stringify(mapped)));
  const storePayload = toCanonicalCardRecord(privateCard, {}, STORE, [privateCard]);
  assert.ok(!/buyPriceRetained|buyLastKnown|"buyPrice"\s*:\s*\d/.test(JSON.stringify(storePayload)));
  assert.equal(buildPriceVersions(storePayload)[0].buyQuote, undefined, 'Store MVP: no buy provenance reaches the version model');
  const apiSrc = fs.readFileSync(new URL('../api/recognize-card.ts', import.meta.url), 'utf8');
  assert.match(apiSrc, /delete out\.buyPriceRetained/);
  assert.match(apiSrc, /'buyPriceRetained', 'buyLastKnown'\]/);
});

// ── E. UI ─────────────────────────────────────────────────────────────────
async function renderDetail(cardPayload) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(CardDetailScreen, {
    route: { params: { card: cardPayload } },
    navigation: { navigate() {}, goBack() {} },
  })));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { container, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}
const textOf = (container, id) => container.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
const NOW = Date.now();
const detailRow = (over) => ({
  id: 'hZZ98-001_hZZ98_C', cardNumber: 'hZZ98-001', name: 'テスト', nameZh: '測試卡', type: 'ホロメン', color: 'white', hp: '100',
  series: 'hZZ98', sourceProduct: 'hZZ98', rarity: 'C', sellPrice: 100, timestamp: iso(NOW - DAY),
  officialImage: '', localImage: '', yuyuName: '', yuyuImage: '', ...over,
});
const buyListing = (over = {}) => ({
  name: BASE_NAME, sellPrice: 100, rarity: 'C',
  buyPrice: 50, buyPriceVersion: 'BASE', buyPriceSource: 'torecolo', buyPriceTimestamp: iso(NOW - HOUR), ...over,
});
const payload = (row, flags = FULL) => toCanonicalCardRecord({ ...row, prices: dedupeListings(row.prices ?? []) }, {}, flags, [row]);

await test('E1 full profile buy line: original source + time; retained → 無新報價 even 1h old; 20h old → 舊價; fresh → plain date', async () => {
  const cases = [
    [buyListing({ buyPriceRetained: true }), (t) => /本次更新無新報價/.test(t) && t.includes(iso(NOW - HOUR).slice(0, 10)) && t.includes('來源：torecolo')],
    [buyListing(), (t) => !/無新報價|舊價/.test(t) && t.startsWith(`${iso(NOW - HOUR).slice(0, 10)} 報價`) && t.includes('來源：torecolo')],
    // stale buy (past the 18h window, not retained): buy wording with the original date and source — never 售價
    [buyListing({ buyPriceTimestamp: iso(NOW - 20 * HOUR) }), (t) => /最近已知收購價（舊價）/.test(t) && t.includes(iso(NOW - 20 * HOUR).slice(0, 10)) && t.includes('來源：torecolo')],
    // unknown buy time: says the date is unknown and that it is not confirmed as the latest BUY price
    [buyListing({ buyPriceTimestamp: undefined }), (t) => /報價日期不明，未確認為最新收購價/.test(t) && t.includes('來源：torecolo')],
  ];
  for (const [listing, ok] of cases) {
    const { container, cleanup } = await renderDetail(payload(detailRow({ prices: [listing] })));
    try {
      const line = textOf(container, 'card-detail-buy-quote');
      assert.ok(line && ok(line), `buy line: ${line}`);
      assert.doesNotMatch(line, /售價/, `a buy line never calls the quote a selling price: ${line}`);
      assert.ok(textOf(container, 'card-detail-spread-shop-buyback')?.includes('¥50'), 'the retained exact-version value itself');
    } finally { await cleanup(); }
  }
});

await test('E2 Store MVP payload: no buy value, no buy line, no buy provenance', async () => {
  const { container, cleanup } = await renderDetail(payload(detailRow({ prices: [buyListing({ buyPriceRetained: true })] }), STORE));
  try {
    assert.equal(textOf(container, 'card-detail-buy-quote'), null);
    assert.equal(textOf(container, 'card-detail-spread-shop-buyback'), null);
    assert.ok(!container.textContent.includes('torecolo'));
  } finally { await cleanup(); }
});

await test('E3 sell: a one-day-old RETAINED quote says 無新報價 with its original date (headline, compact marker, scan); same age without the flag is fresh', async () => {
  const yesterday = iso(NOW - DAY);
  const retainedRow = detailRow({ sellQuoteRetained: true, prices: [{ name: BASE_NAME, sellPrice: 100, rarity: 'C' }] });
  {
    const { container, cleanup } = await renderDetail(payload(retainedRow));
    try {
      const line = textOf(container, 'card-detail-price-quote');
      assert.equal(line, `本次更新無新報價・沿用 ${yesterday.slice(0, 10)} 的原報價（舊價）`);
    } finally { await cleanup(); }
  }
  const freshRow = detailRow({ prices: [{ name: BASE_NAME, sellPrice: 100, rarity: 'C' }] });
  {
    const { container, cleanup } = await renderDetail(payload(freshRow));
    try {
      assert.equal(textOf(container, 'card-detail-price-quote'), `${yesterday.slice(0, 10)} 報價`, 'recovered / freshly priced → no retained label');
    } finally { await cleanup(); }
  }
  const t = (k) => ({ price_quote_retained_tag: '無新報價', price_quote_old_tag: '舊價', price_quote_unknown_short: '日期不明' }[k] ?? k);
  assert.equal(compactPriceMarker(payload(retainedRow), 100, t, NOW), '無新報價');
  assert.equal(compactPriceMarker(payload(freshRow), 100, t, NOW), undefined);
  const prov = provenanceFromRow({ timestamp: yesterday, sourceProduct: 'hZZ98', sellQuoteRetained: true });
  assert.equal(prov.retained, true);
  assert.equal('retained' in provenanceFromRow({ timestamp: yesterday }), false, 'no flag → no claim (shape unchanged)');
  const scan = scanQuoteProvenance({ provenance: prov, prices: [{ name: BASE_NAME, sellPrice: 100 }] });
  assert.equal(scan.priceRetained, true);
  assert.deepEqual(scan.printingRetained, { BASE: true });
  assert.equal(payload(retainedRow).priceRetained, true);
  assert.deepEqual(payload(retainedRow).printingRetained, { BASE: true });
  assert.equal(payload(freshRow).priceRetained, false);
});

await test('E4 search list row with no image and no effect text renders no raw text node (pre-existing RN Web warning)', async () => {
  const { CardListItem } = await import('../src/screens/SearchResultsScreen.tsx');
  const { View } = await import('react-native');
  const textNodeWarnings = (msgs) => msgs.filter((s) => /Unexpected text node/.test(s));
  // Render `el`, capturing console.error / console.warn; returns the container's probes + messages.
  async function renderCapturing(el, probe) {
    const seen = [];
    const orig = { error: console.error, warn: console.warn };
    console.error = (...a) => { seen.push(a.map(String).join(' ')); };
    console.warn = (...a) => { seen.push(a.map(String).join(' ')); };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let probed;
    try {
      await act(async () => root.render(el));
      probed = probe(container);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      console.error = orig.error;
      console.warn = orig.warn;
    }
    return { seen, probed };
  }
  const row = payload(detailRow({ prices: [{ name: BASE_NAME, sellPrice: 100, rarity: 'C' }] }));
  const card = { ...row, searchKeywords: [] };
  // Fixture premise = the exact shape that produced the warning: empty image url, no effect text.
  assert.equal(card.imageUrl, '', 'fixture premise: empty image url');
  const { seen, probed } = await renderCapturing(
    React.createElement(CardListItem, { card, onPress() {}, now: NOW }),
    (c) => ({
      number: c.querySelector('[data-testid="search-card-number"]')?.textContent ?? null,
      priceRow: !!c.querySelector('[data-testid="search-result-price-row"]'),
    }),
  );
  // The row really rendered (its own nodes, independent of the user's display currency —
  // the price text is currency-converted, so the yen amount itself need not appear).
  assert.equal(probed.number, 'hZZ98-001', `row rendered its card number (console: ${seen.join(' | ')})`);
  assert.equal(probed.priceRow, true, 'row rendered its price line');
  assert.deepEqual(textNodeWarnings(seen), [], `no raw text node under a View: ${seen.join(' | ')}`);
  // Positive control: the detector is live — an empty-string child of a View DOES warn here,
  // so the absence above is not vacuous.
  const control = await renderCapturing(React.createElement(View, null, ''), () => null);
  assert.ok(textNodeWarnings(control.seen).length > 0, `control must reproduce the RN Web warning (got: ${control.seen.join(' | ')})`);
});

for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`last-known buy: ${passed} checks passed${process.exitCode ? ' (FAILURES above)' : ''}`);
