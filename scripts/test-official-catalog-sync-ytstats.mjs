#!/usr/bin/env node
// DIC-1421: Official Catalog Sync must broadcast owned, source-proven ytStats
// onto every newly added printing whose name/nameZh maps to a tracked holomen,
// or the DIC-1084 Validate audit (DIC-1153/1204 broadcast contract) fails
// closed. Before the fix, sync only carried ytStats forward from a pre-existing
// row via `applyPreservedMarketFields` (exact id or cardNumber|sourceProduct|
// rarity signature) — a brand-new hBP09 reprint of an already-tracked member
// (new id, new sourceProduct) had no match, so it shipped without ytStats and
// the scheduled 2026-09-12 sync PR (#191) died at Validate: expected 2136 rows
// to carry ytStats; got 2072.
//
// This suite pins the broadcast behavior with deterministic fixtures:
//   1. Green path      — a newly introduced printing of a tracked holomen whose
//      existing row carries proven ytStats receives that exact proven object
//      (matching by name and by nameZh).
//   2. Malformed path  — a newly introduced printing of a tracked holomen whose
//      only existing ytStats lacks the audit's structural provenance shape
//      must NOT receive it; nothing malformed is ever copied (fail-closed).
//   3. Untracked path  — a newly introduced printing whose name maps to no
//      tracked holomen must NOT receive ytStats.
//   4. Preservation    — pre-existing rows keep the ytStats they already had;
//      the broadcast is fill-only and never displaces a preserved object.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncOfficialCatalogToDatabase } from './sync-official-catalog-to-database.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huntercard-official-sync-ytstats-'));
const dbPath = path.join(tmp, 'database.json');
const officialDir = path.join(tmp, 'official');
const translationPath = path.join(tmp, 'character-names-zh.json');
fs.mkdirSync(officialDir, { recursive: true });

const PROVEN_STATS = {
  subscriberCount: 1590000,
  totalViewCount: 292079412,
  date: '2026-08-26',
  channelId: 'UC5CwaMl1e4mOMd5hCm0AUgQ',
  source: 'youtube_about_ssr',
  parser: 'ytInitialData.aboutChannelViewModel/v1',
  fetchedAt: '2026-08-26T12:14:40.432Z',
  subscriberDate: '2026-08-26',
  viewChannelId: 'UC5CwaMl1e4mOMd5hCm0AUgQ',
  viewSource: 'youtube_about_ssr',
  viewParser: 'ytInitialData.aboutChannelViewModel/v1',
  viewFetchedAt: '2026-08-26T12:14:40.432Z',
  subscriberGrowth_1d: 0,
  subscriberGrowth_7d: null,
  subscriberGrowth_15d: null,
  subscriberGrowth_30d: null,
  viewCount_1d: 100,
  viewCount_7d: null,
  viewCount_15d: null,
  viewCount_30d: null,
  newsCount: 0,
  newsPositive: 0,
  newsNegative: 0,
};

// MALFORMED_STATS mirrors a row whose ytStats fails the DIC-1084 structural
// provenance gate in `cardNormalization.ts::hasDisplayableSubscriberStats`:
// the source/parser are not the authoritative YouTube SSR pair.
const MALFORMED_STATS = {
  subscriberCount: 1234567,
  totalViewCount: 0,
  date: '2026-08-26',
  channelId: 'UCyes',
  source: 'youtube_unknown_endpoint',
  parser: 'noSuchParser/v9',
  fetchedAt: 'not-a-date',
};

fs.writeFileSync(translationPath, `${JSON.stringify({
  '星街すいせい': '星街菫',
  '大空スバル': '大空昴',
}, null, 2)}\n`, 'utf8');

// Deterministic DB with two pre-existing tracked holomen rows:
//  - hBP01-081 (星街すいせい) carrying PROVEN ytStats,
//  - hBP01-072 (大空スバル) carrying MALFORMED ytStats.
const existingProvenId = 'hBP01-081_hEB01_RR_hBP01-081_RR_02';
const existingMalformedId = 'hBP01-072_hEB01_C_hBP01-072_C_02';
fs.writeFileSync(dbPath, `${JSON.stringify({
  lastUpdated: '2026-09-11T20:54:25.000Z',
  totalCards: 2,
  cards: {
    [existingProvenId]: {
      id: existingProvenId,
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
      ytStats: PROVEN_STATS,
    },
    [existingMalformedId]: {
      id: existingMalformedId,
      cardNumber: 'hBP01-072',
      name: '大空スバル',
      type: 'Holomen',
      color: 'purple',
      rarity: 'C',
      series: 'hEB01',
      sourceProduct: 'hEB01',
      nameZh: '大空昴',
      sellPrice: null,
      prices: [],
      officialImage: 'https://hololive-official-cardgame.com/wp-content/images/cardlist/hEB01/hBP01-072_C_02.png',
      ytStats: MALFORMED_STATS,
    },
  },
}, null, 2)}\n`, 'utf8');

fs.writeFileSync(path.join(officialDir, '_meta.json'), `${JSON.stringify({
  seriesStats: [
    { code: 'hEB01', expectedCount: 2, ingestedCount: 2 },
    { code: 'hBP09', expectedCount: 4, ingestedCount: 4 },
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
  {
    cardNumber: 'hBP01-072',
    name: '大空スバル',
    cardType: 'Holomen',
    color: 'purple',
    rarity: 'C',
    expansion: 'hEB01',
    sourceProduct: 'hEB01',
    imageUrl: 'https://hololive-official-cardgame.com/wp-content/images/cardlist/hEB01/hBP01-072_C_02.png',
  },
], null, 2)}\n`, 'utf8');

fs.writeFileSync(path.join(officialDir, 'hBP09.json'), `${JSON.stringify([
  {
    // 1. Green path: brand-new hBP09 printing of a tracked holomen whose
    // existing row carries PROVEN ytStats — must receive that exact object.
    cardNumber: 'hBP09-100',
    name: '星街すいせい',
    cardType: 'OshiHolomen',
    color: 'white',
    rarity: 'OSR',
    expansion: 'hBP09',
    sourceProduct: 'hBP09',
    sourceProductName: 'ブースターパック「ボリュームヴォルテックス」',
    imageUrl: 'https://hololive-official-cardgame.com/wp-content/images/cardlist/hBP09/hBP09-100_OSR.png',
  },
  {
    // 1b. Green path via prior-printing variant reprint (hBP09 printing of an
    // hBP01 base card) — the shape the real PR #191 added forty-plus times.
    cardNumber: 'hBP01-081',
    name: '星街すいせい',
    cardType: 'Holomen',
    color: 'blue',
    rarity: 'C',
    expansion: 'hBP09',
    sourceProduct: 'hBP09',
    sourceProductName: 'ブースターパック「ボリュームヴォルテックス」',
    imageUrl: 'https://hololive-official-cardgame.com/wp-content/images/cardlist/hBP09/hBP01-081_C_02.png',
  },
  {
    // 2. Malformed path: new hBP09 printing of 大空スバル whose only existing
    // ytStats fails the structural provenance gate — must stay ytStats-less.
    cardNumber: 'hBP09-101',
    name: '大空スバル',
    cardType: 'OshiHolomen',
    color: 'white',
    rarity: 'OSR',
    expansion: 'hBP09',
    sourceProduct: 'hBP09',
    sourceProductName: 'ブースターパック「ボリュームヴォルテックス」',
    imageUrl: 'https://hololive-official-cardgame.com/wp-content/images/cardlist/hBP09/hBP09-101_OSR.png',
  },
  {
    // 3. Untracked path: brand-new printing whose name maps to no tracked
    // holomen — must never receive ytStats.
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
], null, 2)}\n`, 'utf8');

const result = syncOfficialCatalogToDatabase({ databasePath: dbPath, officialDirectory: officialDir, translationPath });
assert.equal(result.pruned, 0);
assert.equal(typeof result.ytStatsBroadcast, 'number', 'sync must report how many ytStats it broadcast onto new printings');
assert.equal(result.ytStatsBroadcast, 2, 'two new tracked-holomen printings must receive broadcast ytStats');

const afterSync = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
const byCard = (num, src = 'hBP09') => Object.values(afterSync.cards).find((c) => c.cardNumber === num && c.sourceProduct === src);

// 1. Green path — a newly introduced printing of a proven tracked holomen
// receives the exact proven ytStats object its member already carries.
const newOshiSui = byCard('hBP09-100');
assert.ok(newOshiSui, 'hBP09-100 must be upserted');
assert.ok(newOshiSui.ytStats, 'new tracked-holomen printing must receive ytStats (DIC-1153/1204 broadcast contract)');
assert.deepEqual(newOshiSui.ytStats, PROVEN_STATS, 'broadcast must copy the owned, source-proven ytStats object already carried by the member');

const newReprintSui = byCard('hBP01-081');
assert.ok(newReprintSui, 'hBP01-081_hBP09 reprint variant must be upserted');
assert.ok(newReprintSui.ytStats, 'prior-printing reprint of a tracked holomen must receive ytStats too');

// 2. Malformed path — nothing malformed is ever copied.
const newOshiSubaru = byCard('hBP09-101');
assert.ok(newOshiSubaru, 'hBP09-101 must be upserted');
assert.ok(!newOshiSubaru.ytStats, 'malformed-provenance row must NOT be broadcast onto new printings (fail-closed)');

// 3. Untracked path — no invented broadcast.
const untracked = byCard('hBP09-090');
assert.ok(untracked, 'hBP09-090 must be upserted');
assert.ok(!untracked.ytStats, 'untracked printing must NOT receive invented ytStats');

// 4. Preservation non-regression — pre-existing rows keep their own ytStats.
assert.deepEqual(afterSync.cards[existingProvenId].ytStats, PROVEN_STATS, 'preserved proven row must keep its ytStats');
assert.deepEqual(afterSync.cards[existingMalformedId].ytStats, MALFORMED_STATS, 'preserved malformed row must keep its ytStats (fill-only; never displaced)');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('✓ official catalog sync broadcasts proven ytStats onto new tracked-holomen printings (and never onto untracked/malformed provenance)');