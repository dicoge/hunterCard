#!/usr/bin/env node
// test-yuyu-provenance-preservation.mjs — mutation-sensitive coverage for the
// DIC-1227 yuyu-provenance gate that stops applyPreservedMarketFields from
// carrying an hEB01-listing yuyu payload onto an hPR promo variant. Mac-Codex
// CR on main 9f4b63bac flagged hBP01-090_hPR_P_hBP01-090_P_02 inheriting
// sellPrice=30 + yuyuName ムーナ・ホシノヴァ(hEB01) + yuyuImage=/heb01/ +
// priceHistory 2026-08-28=30 onto an hPR promo row.
//
// Contract locked in below (matches
// preserve-market-fields.js::yuyuPayloadMatchesSource):
//   1. Previous row's yuyuImage URL product path MUST equal current row's
//      sourceProduct before ANY yuyu-derived preservation runs. Fields gated:
//      sellPrice, prices, yuyuName, yuyuImage, timestamp, priceHistory,
//      priceHistoryMeta, _rawPricesArchive.
//   2. promo-* yuyu-tei product paths legitimately belong to hPR — a promo-
//      hbp10 previous URL still matches an hPR current row.
//   3. A missing / unparseable yuyuImage fails the gate: no yuyu payload
//      carries forward without provable provenance.
//   4. ytStats is not yuyu-derived and stays subject to its own guard — the
//      DIC-1227 gate must NOT drop it.
//
// Mutation sensitivity: fixture A is the exact Mac-Codex-flagged shape
// (hPR row + hEB01-provenance previous). Fixture B is the two-variant hPR P
// pair PM asked for. Fixture C is the legitimate exact-id match. Fixture D
// exercises the promo-*/hpr carve-out. Removing the gate call, dropping the
// promo carve-out, or letting an empty yuyuImage pass all trip a distinct
// assertion.
import assert from 'node:assert/strict';
import {
  yuyuImageProductPath,
  yuyuPayloadMatchesSource,
  applyPreservedMarketFields,
} from './lib/preserve-market-fields.js';

// ---- unit: URL product path extraction -------------------------------------
assert.equal(yuyuImageProductPath('https://card.yuyu-tei.jp/hocg/100_140/heb01/10100.jpg'), 'heb01');
assert.equal(yuyuImageProductPath('https://card.yuyu-tei.jp/hocg/100_140/hbp01/10041.jpg'), 'hbp01');
assert.equal(yuyuImageProductPath('https://card.yuyu-tei.jp/hocg/100_140/promo-hbp10/10051.jpg'), 'promo-hbp10');
assert.equal(yuyuImageProductPath(''), '');
assert.equal(yuyuImageProductPath(null), '');
assert.equal(yuyuImageProductPath('not-a-url'), '');

// ---- unit: provenance match --------------------------------------------------
assert.equal(yuyuPayloadMatchesSource({ yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/hpr/10200.jpg' }, 'hPR'), true);
assert.equal(yuyuPayloadMatchesSource({ yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/heb01/10100.jpg' }, 'hPR'), false, 'hEB01 -> hPR must NOT match');
assert.equal(yuyuPayloadMatchesSource({ yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/promo-hbp10/10051.jpg' }, 'hPR'), true, 'promo-* carve-out for hPR');
assert.equal(yuyuPayloadMatchesSource({ yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/promo-hbp10/10051.jpg' }, 'hBP08'), false, 'promo-* does not carve out non-hPR products');
assert.equal(yuyuPayloadMatchesSource({ yuyuImage: '' }, 'hPR'), false, 'empty yuyuImage fails gate');
assert.equal(yuyuPayloadMatchesSource({}, 'hPR'), false, 'missing yuyuImage fails gate');
assert.equal(yuyuPayloadMatchesSource({ yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/hbp08/10240.jpg' }, ''), false, 'empty sourceProduct fails gate');

// ---- Fixture A: Mac-Codex CR shape — hPR promo inheriting hEB01 payload -----
{
  const previous = {
    id: 'hBP01-090_hPR_P_hBP01-090_P',
    cardNumber: 'hBP01-090',
    sourceProduct: 'hPR',
    rarity: 'P',
    sellPrice: 30,
    yuyuName: 'ムーナ・ホシノヴァ(hEB01)',
    yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/heb01/10100.jpg',
    timestamp: '2026-08-25T12:11:40.889Z',
    prices: [
      { name: 'ムーナ・ホシノヴァ', sellPrice: 220, rarity: '', imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/hbp01/10109.jpg' },
      { name: 'ムーナ・ホシノヴァ(hEB01)', sellPrice: 30, rarity: '', imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/heb01/10100.jpg' },
    ],
    priceHistory: { '2026-08-28': 30 },
    ytStats: { subscriberCount: 500000, fetchedAt: '2026-08-28T00:00:00.000Z' },
  };
  const current = {
    id: 'hBP01-090_hPR_P_hBP01-090_P_02',
    cardNumber: 'hBP01-090',
    sourceProduct: 'hPR',
    rarity: 'P',
    sellPrice: null,
    prices: [],
    priceHistory: {},
  };
  const summary = applyPreservedMarketFields(current, previous, { matchKind: 'signature', preserveYuyuPayload: true });
  // Every yuyu-derived field must stay null/empty because previous's yuyu
  // provenance is /heb01/ and current's sourceProduct is hPR.
  assert.equal(summary.sellPrice, false, 'sellPrice must NOT preserve from cross-product previous');
  assert.equal(summary.prices, false, 'prices must NOT preserve from cross-product previous');
  assert.equal(summary.yuyu, false, 'yuyuName/yuyuImage must NOT preserve from cross-product previous');
  assert.equal(summary.priceHistory, false, 'priceHistory must NOT preserve from cross-product previous');
  assert.equal(current.sellPrice, null);
  assert.deepEqual(current.prices, []);
  assert.equal(current.yuyuImage, undefined);
  assert.equal(current.yuyuName, undefined);
  assert.equal(Object.keys(current.priceHistory).length, 0);
  // ytStats is NOT yuyu-derived — must still carry across.
  assert.equal(summary.ytStats, true, 'ytStats must still preserve (not yuyu-derived)');
  assert.equal(current.ytStats?.subscriberCount, 500000);
}

// ---- Fixture B: two hPR P variants of the same base cardNumber -------------
// PM asked for coverage of two hPR P variants. Same signature (hBP02-011|hPR|P)
// but different exact IDs (one primary + one _03 sibling from the DIC-1167 hPR
// backfill). Both must reject a cross-product previous payload.
{
  const previous = {
    id: 'hBP02-011_hPR_P_hBP02-011_P',
    cardNumber: 'hBP02-011',
    sourceProduct: 'hPR',
    rarity: 'P',
    sellPrice: 50,
    yuyuName: 'XYZ(hBP08)',
    yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/hbp08/99999.jpg',
    prices: [{ name: 'XYZ(hBP08)', sellPrice: 50, rarity: '', imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/hbp08/99999.jpg' }],
    priceHistory: { '2026-08-27': 50, '2026-08-28': 50 },
  };
  for (const currentId of ['hBP02-011_hPR_P_hBP02-011_P', 'hBP02-011_hPR_P_hBP02-011_P_03']) {
    const current = {
      id: currentId, cardNumber: 'hBP02-011', sourceProduct: 'hPR', rarity: 'P',
      sellPrice: null, prices: [], priceHistory: {},
    };
    const summary = applyPreservedMarketFields(current, previous, {
      matchKind: currentId === previous.id ? 'exact-id' : 'signature',
      preserveYuyuPayload: true,
    });
    assert.equal(summary.sellPrice, false, `${currentId}: sellPrice must not inherit cross-product hBP08 payload`);
    assert.equal(summary.prices, false, `${currentId}: prices must not inherit cross-product hBP08 payload`);
    assert.equal(summary.yuyu, false, `${currentId}: yuyu identity must not inherit cross-product hBP08 payload`);
    assert.equal(summary.priceHistory, false, `${currentId}: priceHistory must not inherit cross-product hBP08 payload`);
    assert.equal(current.sellPrice, null);
    assert.deepEqual(current.prices, []);
  }
}

// ---- Fixture C: legitimate exact-id match with matching provenance ---------
// hPR row whose previous yuyuImage is /hpr/ — the gate must NOT block.
{
  const previous = {
    id: 'hPR-P-example',
    cardNumber: 'hPR-014',
    sourceProduct: 'hPR',
    rarity: 'P',
    sellPrice: 200,
    yuyuName: 'Legit hPR listing',
    yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/hpr/01000.jpg',
    timestamp: '2026-08-27T00:00:00.000Z',
    prices: [{ name: 'Legit hPR listing', sellPrice: 200, rarity: '', imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/hpr/01000.jpg' }],
    priceHistory: { '2026-08-27': 200, '2026-08-28': 200 },
  };
  const current = {
    id: 'hPR-P-example', cardNumber: 'hPR-014', sourceProduct: 'hPR', rarity: 'P',
    sellPrice: null, prices: [], priceHistory: {},
  };
  const summary = applyPreservedMarketFields(current, previous, { matchKind: 'exact-id', preserveYuyuPayload: true });
  assert.equal(summary.sellPrice, true, 'same-provenance previous must preserve sellPrice');
  assert.equal(summary.prices, true, 'same-provenance previous must preserve prices');
  assert.equal(summary.yuyu, true, 'same-provenance previous must preserve yuyu identity');
  assert.equal(summary.priceHistory, true, 'same-provenance previous must preserve priceHistory');
  assert.equal(current.sellPrice, 200);
  assert.equal(current.yuyuImage, previous.yuyuImage);
}

// ---- Fixture D: promo-* carve-out preserves onto hPR ----------------------
{
  const previous = {
    id: 'hBP01-028_hPR_P_hBP01-028_P',
    cardNumber: 'hBP01-028',
    sourceProduct: 'hPR',
    rarity: 'P',
    sellPrice: 320,
    yuyuName: 'IRyS(パラレル/エントリーPRパック vol.3)',
    yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/promo-hbp10/10051.jpg',
    prices: [{ name: 'IRyS(パラレル/エントリーPRパック vol.3)', sellPrice: 320, rarity: '', imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/promo-hbp10/10051.jpg' }],
    priceHistory: { '2026-08-27': 320, '2026-08-28': 320 },
  };
  const current = {
    id: 'hBP01-028_hPR_P_hBP01-028_P', cardNumber: 'hBP01-028', sourceProduct: 'hPR', rarity: 'P',
    sellPrice: null, prices: [], priceHistory: {},
  };
  const summary = applyPreservedMarketFields(current, previous, { matchKind: 'exact-id', preserveYuyuPayload: true });
  assert.equal(summary.sellPrice, true, 'promo-* URL must carve out and match hPR');
  assert.equal(current.sellPrice, 320);
  assert.equal(current.yuyuImage, previous.yuyuImage);
}

// ---- Fixture E: mixed payload — wrong top-level image + valid nested promo -
// Mac-Codex CR follow-up on 3be32715 flagged: my first pass rejected the
// entire previous payload from top-level yuyuImage, erasing the sole official
// hPR printing hBP01-048_hPR_P_hBP01-048_P's valid ¥980 /promo-hbp10/10013.jpg
// entry inside prices[] because an unrelated /hbp06/ ¥80 entry had become
// top-level yuyuImage. The fix must filter prices[] entry-by-entry and
// derive top-level from surviving entries. This fixture is that exact shape.
{
  const previous = {
    id: 'hBP01-048_hPR_P_hBP01-048_P',
    cardNumber: 'hBP01-048',
    sourceProduct: 'hPR',
    rarity: 'P',
    sellPrice: 80, // came from the /hbp06/ ¥80 entry
    yuyuName: '風真いろは(パラレル/hBP06)',
    yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/hbp06/10217.jpg',
    timestamp: '2026-08-25T12:11:18.894Z',
    prices: [
      { name: '風真いろは', sellPrice: 120, rarity: '', imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/hbp01/10063.jpg' },
      { name: '風真いろは(パラレル/HR)', sellPrice: 9980, rarity: '', imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/hbp06/10229.jpg' },
      { name: '風真いろは(パラレル/hBP06)', sellPrice: 80, rarity: '', imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/hbp06/10217.jpg' },
      { name: '風真いろは(パラレル/hSD06)', sellPrice: 120, rarity: '', imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/hsd06/10013.jpg' },
      // The single legit entry — hPR promo-* provenance.
      { name: '風真いろは(パラレル/ベーシックPRパック vol.1)', sellPrice: 980, rarity: '', imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/promo-hbp10/10013.jpg' },
    ],
    priceHistory: { '2026-08-28': 80 },
    _rawPricesArchive: [
      { name: 'archive-hBP06-entry', sellPrice: 80, imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/hbp06/10217.jpg' },
      { name: 'archive-promo-entry', sellPrice: 980, imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/promo-hbp10/10013.jpg' },
    ],
  };
  const current = {
    id: 'hBP01-048_hPR_P_hBP01-048_P',
    cardNumber: 'hBP01-048',
    sourceProduct: 'hPR',
    rarity: 'P',
    sellPrice: null,
    prices: [],
    priceHistory: {},
  };
  const summary = applyPreservedMarketFields(current, previous, { matchKind: 'exact-id', preserveYuyuPayload: true });
  // The legit /promo-hbp10/ entry MUST survive; the /hbp01/, /hbp06/, /hsd06/ entries MUST be dropped.
  assert.equal(current.prices.length, 1, `only the /promo-hbp10/ entry must survive; got ${current.prices.length}`);
  assert.equal(current.prices[0].sellPrice, 980);
  assert.equal(current.prices[0].imageUrl, 'https://card.yuyu-tei.jp/hocg/100_140/promo-hbp10/10013.jpg');
  // Top-level fields derived from the surviving entry (NOT from the wrong /hbp06/ ¥80).
  assert.equal(current.sellPrice, 980, 'top-level sellPrice must derive from the surviving promo entry, not the /hbp06/ ¥80');
  assert.equal(current.yuyuImage, 'https://card.yuyu-tei.jp/hocg/100_140/promo-hbp10/10013.jpg', 'yuyuImage must be the surviving promo URL, not the /hbp06/ URL');
  assert.equal(current.yuyuName, '風真いろは(パラレル/ベーシックPRパック vol.1)', 'yuyuName must be the surviving entry name');
  assert.equal(current.timestamp, previous.timestamp, 'timestamp preserved since surviving entries exist');
  assert.deepEqual(Object.keys(current.priceHistory), ['2026-08-28'], 'priceHistory preserved: at least one surviving entry establishes provenance');
  // _rawPricesArchive entry-level filtered too.
  assert.equal(current._rawPricesArchive.length, 1);
  assert.equal(current._rawPricesArchive[0].imageUrl, 'https://card.yuyu-tei.jp/hocg/100_140/promo-hbp10/10013.jpg');
  // The DIC-1227 CR summary must reflect what was preserved.
  assert.equal(summary.sellPrice, true);
  assert.equal(summary.prices, true);
  assert.equal(summary.yuyu, true);
  assert.equal(summary.priceHistory, true);
}

// ---- Fixture F: prior blocker stays fail-closed under the new filter ------
// hBP01-090_hPR_P_hBP01-090_P_02 has NO /hpr/ or /promo-*/ entry inside
// prices[]. Entry-level filtering must therefore drop everything and leave
// the row fully null/empty — the DIC-1227 primary blocker outcome is
// preserved.
{
  const previous = {
    id: 'hBP01-090_hPR_P_hBP01-090_P_02',
    cardNumber: 'hBP01-090',
    sourceProduct: 'hPR',
    rarity: 'P',
    sellPrice: 30,
    yuyuName: 'ムーナ・ホシノヴァ(hEB01)',
    yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/heb01/10100.jpg',
    prices: [
      { name: 'ムーナ・ホシノヴァ', sellPrice: 220, rarity: '', imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/hbp01/10109.jpg' },
      { name: 'ムーナ・ホシノヴァ(パラレル/hEB01)', sellPrice: 120, rarity: '', imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/heb01/10101.jpg' },
      { name: 'ムーナ・ホシノヴァ(hEB01)', sellPrice: 30, rarity: '', imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/heb01/10100.jpg' },
    ],
    priceHistory: { '2026-08-28': 30 },
  };
  const current = {
    id: 'hBP01-090_hPR_P_hBP01-090_P_02',
    cardNumber: 'hBP01-090',
    sourceProduct: 'hPR',
    rarity: 'P',
    sellPrice: null, prices: [], priceHistory: {},
  };
  const summary = applyPreservedMarketFields(current, previous, { matchKind: 'signature', preserveYuyuPayload: true });
  assert.equal(current.prices.length, 0, 'no /hpr/ or /promo-*/ entry means no survivor');
  assert.equal(current.sellPrice, null);
  assert.equal(current.yuyuImage, undefined);
  assert.equal(current.yuyuName, undefined);
  assert.equal(Object.keys(current.priceHistory).length, 0);
  assert.equal(summary.sellPrice, false);
  assert.equal(summary.prices, false);
  assert.equal(summary.yuyu, false);
  assert.equal(summary.priceHistory, false);
}

console.log('DIC-1227 yuyu-provenance preservation regression checks passed');
