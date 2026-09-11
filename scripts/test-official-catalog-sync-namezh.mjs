#!/usr/bin/env node
// DIC-1415: Official Catalog Sync must apply controlled Traditional-Chinese
// names (data/character-names-zh.json) to brand-new printings instead of
// silently shipping rows with no nameZh. Before the fix, a new expansion
// (upstream hBP09 「ボリュームヴォルテックス」) upserted 125 fresh printings with
// zero nameZh because sync only carried nameZh forward from a pre-existing row
// (`previous.nameZh`), so even fully translatable rows lost their Chinese name
// and the scheduled run died at the fail-closed Validate gate.
//
// This suite pins three properties with deterministic fixtures:
//   1. Green path      — a new printing whose name has a controlled translation
//      (exact match, or HTML-decoded) must receive that nameZh during sync;
//      reprint/prior-printing variants behave the same.
//   2. Fail-closed     — a new printing whose name has NO controlled
//      translation must NOT get an invented/guessed nameZh; the Validate gate
//      predicate `!card.nameZh` must still trip on it (no weakened gate).
//   3. Preservation    — a pre-existing row keeps the nameZh it already had.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncOfficialCatalogToDatabase } from './sync-official-catalog-to-database.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huntercard-official-sync-namezh-'));
const dbPath = path.join(tmp, 'database.json');
const officialDir = path.join(tmp, 'official');
const translationPath = path.join(tmp, 'character-names-zh.json');
fs.mkdirSync(officialDir, { recursive: true });

// Controlled translation map fixture — mirrors the real data/character-names-zh.json
// entries for the hBP09-afflicted names (大空スバル→大空昴, 轟はじめ→轟一) plus the
// genuine HTML-encoded key (WHAT&#039;S…) to prove decodeHtml matching.
const encodedUpKey = 'WHAT&#039;S UP!!!!! KEEEEEP GROWING!!!!!';
const decodedUpKey = 'WHAT\'S UP!!!!! KEEEEEP GROWING!!!!!';
const translationMap = {
  '大空スバル': '大空昴',
  '轟はじめ': '轟一',
  'ハコス・ベールズ': '哈可斯·貝爾姿',
  '星街すいせい': '星街菫',
  [decodedUpKey]: 'WHAT\'S UP!!!!! KEEEEEP GROWING!!!!!',
};
fs.writeFileSync(translationPath, `${JSON.stringify(translationMap, null, 2)}\n`, 'utf8');

// Deterministic DB with a single pre-existing printing so we can also assert
// preservation is unaffected while new hBP09-like printings land.
const existingId = 'hBP01-081_hEB01_RR_hBP01-081_RR_02';
fs.writeFileSync(dbPath, `${JSON.stringify({
  lastUpdated: '2026-09-10T20:54:25.000Z',
  totalCards: 1,
  cards: {
    [existingId]: {
      id: existingId,
      cardNumber: 'hBP01-081',
      name: '星街すいせい',
      type: 'Holomen',
      color: 'blue',
      rarity: 'RR',
      series: 'hEB01',
      sourceProduct: 'hEB01',
      nameZh: '星街菫',
      sellPrice: null,
      prices: [],
      officialImage: 'https://hololive-official-cardgame.com/wp-content/images/cardlist/hEB01/hBP01-081_RR_02.png',
    },
  },
}, null, 2)}\n`, 'utf8');

fs.writeFileSync(path.join(officialDir, '_meta.json'), `${JSON.stringify({
  seriesStats: [
    { code: 'hEB01', expectedCount: 2, ingestedCount: 2 },
    { code: 'hBP09', expectedCount: 5, ingestedCount: 5 },
  ],
}, null, 2)}\n`, 'utf8');

fs.writeFileSync(path.join(officialDir, 'hEB01.json'), `${JSON.stringify([
  {
    cardNumber: 'hBP01-081',
    name: '星街すいせい',
    cardType: 'Holomen',
    color: 'blue',
    rarity: 'RR',
    expansion: 'hEB01',
    sourceProduct: 'hEB01',
    imageUrl: 'https://hololive-official-cardgame.com/wp-content/images/cardlist/hEB01/hBP01-081_RR_02.png',
  },
], null, 2)}\n`, 'utf8');

fs.writeFileSync(path.join(officialDir, 'hBP09.json'), `${JSON.stringify([
  {
    // brand-new OSR printing of a well-known member — must pick up 大空昴
    cardNumber: 'hBP09-001',
    name: '大空スバル',
    cardType: 'OshiHolomen',
    color: 'white',
    rarity: 'OSR',
    expansion: 'hBP09',
    sourceProduct: 'hBP09',
    sourceProductName: 'ブースターパック「ボリュームヴォルテックス」',
    imageUrl: 'https://hololive-official-cardgame.com/wp-content/images/cardlist/hBP09/hBP09-001_OSR.png',
  },
  {
    // prior-printing variant reprint (hBP09 printing of an hBP01 base card)
    cardNumber: 'hBP01-072',
    name: 'ハコス・ベールズ',
    cardType: 'Holomen',
    color: 'purple',
    rarity: 'C',
    expansion: 'hBP09',
    sourceProduct: 'hBP09',
    sourceProductName: 'ブースターパック「ボリュームヴォルテックス」',
    imageUrl: 'https://hololive-official-cardgame.com/wp-content/images/cardlist/hBP09/hBP01-072_C_02.png',
  },
  {
    // support card with a name that has NO controlled translation yet — the
    // fail-closed gate must keep tripping; the pipeline must not fabricate one.
    cardNumber: 'hBP09-090',
    name: 'コラボパソコン',
    cardType: 'SupportItem',
    color: 'colorless',
    rarity: 'C',
    expansion: 'hBP09',
    sourceProduct: 'hBP09',
    sourceProductName: 'ブースターパック「ボリュームヴォルテックス」',
    imageUrl: 'https://hololive-official-cardgame.com/wp-content/images/cardlist/hBP09/hBP09-090.png',
  },
  {
    // HTML-encoded name — the official cardlist emits &#039; for apostrophes;
    // the controlled map stores the decoded key, so enrichment must decode.
    cardNumber: 'hBP09-112',
    name: encodedUpKey,
    cardType: 'Yell',
    color: 'green',
    rarity: 'U',
    expansion: 'hBP09',
    sourceProduct: 'hBP09',
    sourceProductName: 'ブースターパック「ボリュームヴォルテックス」',
    imageUrl: 'https://hololive-official-cardgame.com/wp-content/images/cardlist/hBP09/hBP09-112.png',
  },
], null, 2)}\n`, 'utf8');

const result = syncOfficialCatalogToDatabase({ databasePath: dbPath, officialDirectory: officialDir, translationPath });
assert.equal(result.upserted, 5, 'hEB01 existing row is refreshed, 4 new hBP09 printings land');
assert.equal(result.pruned, 0);

const afterSync = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
const byCard = (num, src = 'hBP09') => Object.values(afterSync.cards).find((c) => c.cardNumber === num && c.sourceProduct === src);

// 1. Green path — brand-new printings receive their controlled Chinese name.
const subaru = byCard('hBP09-001');
assert.ok(subaru, 'hBP09-001 must be upserted');
assert.equal(subaru.nameZh, '大空昴', 'new printing with a controlled translation must receive its nameZh');

const baelz = byCard('hBP01-072');
assert.ok(baelz, 'hBP01-072_hBP09 reprint variant must be upserted');
assert.equal(baelz.nameZh, '哈可斯·貝爾姿', 'reprint/prior-printing variant must receive its controlled nameZh');

const rene = byCard('hBP09-112');
assert.ok(rene, 'hBP09-112 must be upserted');
assert.equal(rene.nameZh, decodedUpKey, 'HTML-encoded official name must decode onto the controlled map entry');

// 2. Fail-closed — no translation, no invented nameZh.
const untranslated = byCard('hBP09-090');
assert.ok(untranslated, 'hBP09-090 must be upserted');
assert.ok(!untranslated.nameZh, 'untranslated name must NOT receive an invented nameZh');

// The Validate gate predicate (`database must fail closed instead of shipping
// empty Traditional-Chinese names`) must still trip: the database is incomplete.
const missingNameZh = Object.values(afterSync.cards).filter((c) => !c.nameZh);
assert.ok(missingNameZh.some((c) => c.id === untranslated.id), 'fail-closed gate must still flag the untranslated row');

// 3. Preservation non-regression: the pre-existing hEB01 row keeps its nameZh.
assert.equal(afterSync.cards[existingId].nameZh, '星街菫', 'preserved row must keep its existing nameZh');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('✓ official catalog sync enriches new printings with controlled Traditional-Chinese names (and fails closed without one)');