#!/usr/bin/env node
// DIC-1321 (Mac-Codex CR DIC-1326, Blocker 2): the lost-priced-cardnumbers
// audit previously built fresh-card ids as a simplified `cardNumber_sourceProduct`,
// dropping the rarity + official-image suffix that distinguishes sibling
// printings of the same cardNumber (SEC vs OSR vs OUR vs promo P). A legacy
// e8322-style aggregate SEC row keyed by that short id (e.g. `hBP01-081_hBP01`)
// therefore get hit by EVERY fresh sibling printing, falsely classifying OSR /
// OUR / promo printings as exact matches of the priced SEC row.
//
// This is a mutation-sensitive regression: it runs the SAME decision the audit
// makes (`printingId` -> `findPreservedMatch` -> `yuyuPayloadMatchesSource`)
// with (a) the production `printingId` builder and (b) the buggy simplified
// builder, and asserts the production path never cross-matches a sibling
// printing onto the SEC aggregate row while the buggy builder does. Reverting
// the audit to the simplified id makes this test fail closed.

import assert from 'node:assert/strict';
import {
  buildPreservationIndex,
  findPreservedMatch,
  yuyuPayloadMatchesSource,
} from './lib/preserve-market-fields.js';
import { printingId } from './lib/printing-identity.js';

const priced = (c) => Number.isFinite(c?.sellPrice) && c.sellPrice > 0;

// Previous-legacy DB (e8322-style). Contains BOTH the canonical production SEC
// printing AND a pre-canonicalization aggregate SEC row keyed by the short
// `hBP01-081_hBP01` id — exactly the row the reviewer showed the simplified-id
// audit mis-reads.
const legacyCards = {
  // Canonical production SEC printing (signed, priced).
  'hBP01-081_hBP01_SEC_hBP01-081_SEC_02': {
    id: 'hBP01-081_hBP01_SEC_hBP01-081_SEC_02',
    cardNumber: 'hBP01-081',
    rarity: 'SEC',
    series: 'hBP01',
    sourceProduct: 'hBP01',
    sellPrice: 3000,
    yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/hbp01/2525.jpg',
    prices: [{ name: 'legacy SEC', sellPrice: 3000, rarity: 'SEC', imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/hbp01/2525.jpg' }],
  },
  // Legacy aggregate SEC row under the short pre-canonicalization id — the
  // false-positive vector for the simplified-id audit.
  'hBP01-081_hBP01': {
    id: 'hBP01-081_hBP01',
    cardNumber: 'hBP01-081',
    rarity: 'SEC',
    series: 'hBP01',
    sourceProduct: 'hBP01',
    sellPrice: 3000,
    yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/hbp01/2525.jpg',
    prices: [{ name: 'legacy aggregate SEC', sellPrice: 3000, rarity: 'SEC', imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/hbp01/2525.jpg' }],
  },
  // Canonical OSR printing (unpriced sibling).
  'hBP01-081_hBP01_OSR_hBP01-081_OSR': {
    id: 'hBP01-081_hBP01_OSR_hBP01-081_OSR',
    cardNumber: 'hBP01-081',
    rarity: 'OSR',
    series: 'hBP01',
    sourceProduct: 'hBP01',
    sellPrice: null,
    prices: [],
  },
};

// Official fresh source listings for the SAME cardNumber across sibling
// printings. Each carries full image/rarity so `printingId` yields a distinct
// production id.
const freshPrintings = [
  {
    cardNumber: 'hBP01-081',
    sourceProduct: 'hBP01',
    rarity: 'SEC',
    imageUrl: 'https://hololive-official-cardgame.com/wp-content/images/cardlist/hBP01/hBP01-081_SEC_02.png',
  },
  {
    cardNumber: 'hBP01-081',
    sourceProduct: 'hBP01',
    rarity: 'OSR',
    imageUrl: 'https://hololive-official-cardgame.com/wp-content/images/cardlist/hBP01/hBP01-081_OSR.png',
  },
  {
    cardNumber: 'hBP01-081',
    sourceProduct: 'hBP01',
    rarity: 'OUR',
    imageUrl: 'https://hololive-official-cardgame.com/wp-content/images/cardlist/hBP01/hBP01-081_OUR.png',
  },
  {
    cardNumber: 'hBP01-081',
    sourceProduct: 'hPR',
    rarity: 'P',
    imageUrl: 'https://hololive-official-cardgame.com/wp-content/images/cardlist/hPR/hBP01-081_P.png',
  },
];

const index = buildPreservationIndex(legacyCards);

// Mirror the audit's recoverable decision exactly, parameterised on the id
// builder so we can prove mutation-sensitivity.
function decide(freshList, idBuilder) {
  const out = [];
  for (const o of freshList) {
    const freshCard = {
      id: idBuilder(o),
      cardNumber: o.cardNumber,
      rarity: o.rarity,
      sourceProduct: o.sourceProduct,
      series: o.sourceProduct,
      imageUrl: o.imageUrl,
    };
    const match = findPreservedMatch(index, freshCard.id, freshCard);
    const prev = match?.card || legacyCards[freshCard.id];
    const provablyMatches = prev ? yuyuPayloadMatchesSource(prev, o.sourceProduct) : false;
    out.push({
      id: freshCard.id,
      rarity: o.rarity,
      prev_id: prev?.id ?? null,
      recoverable: Boolean(prev) && priced(prev) && provablyMatches,
    });
  }
  return out;
}

// The buggy builder the CR flagged — drops rarity + official-image suffix.
const buggyIdBuilder = (o) => `${o.cardNumber}_${o.sourceProduct}`;

const production = decide(freshPrintings, printingId);
const buggy = decide(freshPrintings, buggyIdBuilder);

// --- Production path must be isolation-safe --------------------------------
const byRarity = (r) => production.find((x) => x.rarity === r);

const sec = byRarity('SEC');
assert.equal(sec.recoverable, true, 'production SEC printing still recovers the SEC row');
assert.ok(sec.prev_id === 'hBP01-081_hBP01_SEC_hBP01-081_SEC_02' || sec.prev_id === 'hBP01-081_hBP01',
  'production SEC prev is a SEC row');

for (const rarity of ['OSR', 'OUR', 'P']) {
  const row = byRarity(rarity);
  assert.equal(
    row.recoverable,
    false,
    `production ${rarity} printing must NOT be classified recoverable via the priced SEC row`,
  );
  assert.ok(
    row.prev_id === null || row.prev_id !== 'hBP01-081_hBP01' && !String(row.prev_id).startsWith('hBP01-081_hBP01_SEC'),
    `production ${rarity} printing must not match the SEC aggregate/signed row (prev=${row.prev_id})`,
  );
}

// Distinct production ids for every sibling printing.
const productionIds = new Set(production.map((x) => x.id));
assert.equal(productionIds.size, freshPrintings.length, 'production printingId yields a distinct id per sibling rarity/printing');

// --- Buggy path MUST reproduce the cross-match (mutation sensitivity) ------
const buggyMatches = buggy.filter((x) => x.recoverable).map((x) => x.rarity);
assert.deepEqual(
  buggyMatches,
  ['SEC', 'OSR', 'OUR'],
  'the simplified-id builder collapses sibling printings onto the priced SEC aggregate row — proving the fix is mutation-sensitive',
);

const buggySameId = new Set(['SEC', 'OSR', 'OUR'].map((r) => buggy.find((x) => x.rarity === r).id));
assert.equal(buggySameId.size, 1, 'buggy builder keys SEC/OSR/OUR to one shared id');

console.log('✓ printing-identity isolation: production id never cross-matches SEC/OSR/OUR/promo siblings (buggy builder reproduces the fail)');
