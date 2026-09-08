#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncOfficialCatalogToDatabase } from './sync-official-catalog-to-database.mjs';
import { regenerateBuyAlignment } from './regen-buy-alignment.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huntercard-official-sync-'));
const dbPath = path.join(tmp, 'database.json');
const officialDir = path.join(tmp, 'official');
fs.mkdirSync(officialDir, { recursive: true });

const id = 'hBP01-081_hEB01_RR_hBP01-081_RR_02';
// DIC-1321: the previous yuyu payload must carry a yuyuImage whose URL product
// path matches the row's sourceProduct (hEB01) for the DIC-1227 provenance
// gate to let it survive an official-sync mutation. The old fixture used a
// `test` product path that never matched, which the previous ungated
// `preservedMarketPayload` spread preserved anyway — that cross-product
// restore is exactly the 0↔1547 oscillation / printing-isolation bug being
// fixed here.
const provenSellPayload = {
  sellPrice: 980,
  yuyuName: '星街すいせい(サマー・ホログラム)',
  yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/heb01/2525.jpg',
  prices: [{ name: '星街すいせい(サマー・ホログラム)', sellPrice: 980, rarity: 'RR', imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/heb01/2525.jpg' }],
  timestamp: '2026-08-24T12:00:00.000Z',
  priceHistory: { '2026-08-24': 980 },
  _rawPricesArchive: [{ name: '星街すいせい(サマー・ホログラム)', sellPrice: 980, imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/heb01/2525.jpg' }],
};

fs.writeFileSync(dbPath, `${JSON.stringify({
  lastUpdated: '2026-08-24T12:00:00.000Z',
  totalCards: 2,
  cards: {
    [id]: {
      id,
      cardNumber: 'hBP01-081',
      name: 'old name that official should refresh',
      type: 'ホロメン',
      color: 'blue',
      rarity: 'RR',
      series: 'hEB01',
      sourceProduct: 'hEB01',
      officialImage: 'https://old.example/hBP01-081_RR_02.png',
      buyPrice: 250,
      buyPriceHistory: { '2026-08-24': 250 },
      ...provenSellPayload,
    },
    'hBP01-021_hEB01_C_hBP01-021': {
      id: 'hBP01-021_hEB01_C_hBP01-021',
      cardNumber: 'hBP01-021',
      name: 'unpriced official printing',
      type: 'ホロメン',
      rarity: 'C',
      series: 'hEB01',
      sourceProduct: 'hEB01',
      sellPrice: null,
      prices: [],
    },
    'hBP01-999_hEB01_C_legacy': {
      id: 'hBP01-999_hEB01_C_legacy',
      cardNumber: 'hBP01-999',
      name: 'legacy duplicate that canonical official no longer lists',
      rarity: 'C',
      series: 'hEB01',
      sourceProduct: 'hEB01',
    },
  },
}, null, 2)}\n`, 'utf8');

fs.writeFileSync(path.join(officialDir, '_meta.json'), `${JSON.stringify({ seriesStats: [{ code: 'hEB01', expectedCount: 2, ingestedCount: 2 }] }, null, 2)}\n`, 'utf8');

fs.writeFileSync(path.join(officialDir, 'hEB01.json'), `${JSON.stringify([
  {
    cardNumber: 'hBP01-081',
    name: '星街すいせい',
    cardType: 'ホロメン',
    color: 'blue',
    rarity: 'RR',
    expansion: 'hEB01',
    sourceProduct: 'hEB01',
    sourceProductName: 'エクストラブースター サマー・ホログラム',
    imageUrl: 'https://hololive-official-cardgame.com/wp-content/images/cardlist/hEB01/hBP01-081_RR_02.png',
    hp: '120',
    bloomLevel: '1st',
  },
  {
    cardNumber: 'hBP01-021',
    name: '白上フブキ',
    cardType: 'ホロメン',
    color: 'green',
    rarity: 'C',
    expansion: 'hEB01',
    sourceProduct: 'hEB01',
    imageUrl: 'https://hololive-official-cardgame.com/wp-content/images/cardlist/hEB01/hBP01-021.png',
  },
], null, 2)}\n`, 'utf8');

const result = syncOfficialCatalogToDatabase({ databasePath: dbPath, officialDirectory: officialDir });
assert.equal(result.upserted, 2);
assert.equal(result.sellPreserved, 1);
assert.equal(result.pruned, 1);

const afterSync = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
assert.equal(afterSync.cards[id].name, '星街すいせい', 'official metadata refresh still applies');
assert.equal(afterSync.cards[id].officialImage, 'https://hololive-official-cardgame.com/wp-content/images/cardlist/hEB01/hBP01-081_RR_02.png');
for (const [key, value] of Object.entries(provenSellPayload)) {
  assert.deepEqual(afterSync.cards[id][key], value, `${key} must survive official sync exact-id mutation`);
}
assert.equal(afterSync.cards['hBP01-021_hEB01_C_hBP01-021'].sellPrice, null, 'unproven printings remain null');
assert.deepEqual(afterSync.cards['hBP01-021_hEB01_C_hBP01-021'].prices, [], 'unproven printings do not borrow sibling prices');
assert.equal(afterSync.cards['hBP01-999_hEB01_C_legacy'], undefined, 'canonical sync prunes legacy rows absent from official expansion JSON');

regenerateBuyAlignment(afterSync, { now: Date.parse('2026-08-24T12:00:01.000Z'), date: '2026-08-24' });
assert.deepEqual(afterSync.cards[id].sellPrice, provenSellPayload.sellPrice, 'regen-buy scheduled step must not wipe sellPrice');
assert.equal(afterSync.cards[id].prices[0]?.sellPrice, provenSellPayload.prices[0].sellPrice, 'regen-buy scheduled step must not wipe prices[].sellPrice');
assert.equal(afterSync.cards[id].prices[0]?.name, provenSellPayload.prices[0].name, 'regen-buy scheduled step must not wipe prices[].name');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('✓ official catalog mutation preserves exact-id sell payloads');