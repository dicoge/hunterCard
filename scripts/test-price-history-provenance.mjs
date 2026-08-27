#!/usr/bin/env node
/**
 * test-price-history-provenance.mjs — mutation-sensitive coverage for the
 * DIC-1219 cross-product price-history contamination fix.
 *
 * Scenario Mac-Codex flagged on PR #157 head 2d0b31a3:
 *   `hBP04-028_hBP08_C_hBP04-028_C_02` has a legitimate current hBP08
 *   listing but its canonical-ID durable file was seeded by DIC-1204 with
 *   64 days of the hBP04 base printing's records. Every subsequent build
 *   re-materialised those records onto card.priceHistory. Legacy records
 *   carry no per-record provenance stamp, so the merge step cannot detect
 *   the contamination without a structural rule.
 *
 * Contract this test locks in (matches the runtime filter in
 * `preserve-market-fields.js::filterProvenanceMatchedRecords`):
 *   1. Stamped records survive only when `sourceProduct` equals the card.
 *   2. Unstamped legacy records survive only on origin-product rows (where
 *      the row's sourceProduct equals the cardNumber's origin prefix).
 *      Reprint rows drop unstamped records because DIC-1204's seed script
 *      wrote origin-product base records onto their canonical-ID files.
 *   3. `seedCanonicalHistoryFiles` refuses to re-seed a reprint row's
 *      durable file — the in-memory preserved priceHistory carries no
 *      per-date stamp and would re-write the same cross-product records.
 *   4. `applyPreservedMarketFields` copies priceHistory only when the
 *      previous row's sourceProduct matches the current row (exact-id is
 *      provenance-safe by construction; signature match verifies it).
 *
 * Mutation sensitivity: each numbered clause has an assertion below that
 * fails if the rule is dropped or inverted. Flipping the reprint-row check
 * in `filterProvenanceMatchedRecords` OR removing the `isReprintRow` bail
 * in `seedCanonicalHistoryFiles` OR dropping the sourceProduct comparison
 * in `applyPreservedMarketFields` all trip the corresponding assertion.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  cardNumberOriginPrefix,
  isReprintRow,
  stampHistoryRecord,
  filterProvenanceMatchedRecords,
  seedCanonicalHistoryFiles,
  applyPreservedMarketFields,
  historyFilenameFor,
} from './lib/preserve-market-fields.js';

// ---- unit: prefix + reprint detection --------------------------------------
assert.equal(cardNumberOriginPrefix('hBP04-028'), 'hBP04');
assert.equal(cardNumberOriginPrefix('hEB01-001'), 'hEB01');
assert.equal(cardNumberOriginPrefix('hSD2025summer-001'), 'hSD2025summer');
assert.equal(cardNumberOriginPrefix('bogus'), '');

assert.equal(isReprintRow({ cardNumber: 'hBP04-028', sourceProduct: 'hBP08' }), true);
assert.equal(isReprintRow({ cardNumber: 'hBP04-028', sourceProduct: 'hBP04' }), false);
assert.equal(isReprintRow({ cardNumber: 'hEB01-001', sourceProduct: 'hEB01' }), false);
assert.equal(isReprintRow({ cardNumber: 'hBP02-026', sourceProduct: 'hCO01' }), true);
assert.equal(isReprintRow({ cardNumber: '', sourceProduct: 'hBP08' }), false); // no prefix → no verdict
assert.equal(isReprintRow({ cardNumber: 'hBP04-028', sourceProduct: '' }), false);

// ---- unit: stamp emits sourceProduct ---------------------------------------
const stamped = stampHistoryRecord({ date: '2026-08-27', price: 50, cardId: 'x' }, { sourceProduct: 'hBP08' });
assert.equal(stamped.sourceProduct, 'hBP08');
assert.equal(stamped.price, 50);

// ---- integration: filter drops cross-product + unstamped-on-reprint --------
const contaminatedFile = {
  cardId: 'hBP04-028_hBP08_C_hBP04-028_C_02',
  records: [
    // 64 legacy unstamped ¥30 records (hBP04 base seed)
    ...Array.from({ length: 64 }, (_, i) => ({
      date: `2026-06-${String(18 + (i % 12)).padStart(2, '0')}`,
      price: 30,
      source: 'yuyu-tei',
      currency: 'JPY',
      cardId: 'hBP04-028_hBP08_C_hBP04-028_C_02',
    })),
    // one legitimate hBP08 stamped record (fresh Step 5 write)
    { date: '2026-08-27', price: 50, source: 'yuyu-tei', currency: 'JPY', cardId: 'hBP04-028_hBP08_C_hBP04-028_C_02', sourceProduct: 'hBP08' },
    // one stray stamped hBP04 record — different product, must be dropped
    { date: '2026-08-01', price: 30, source: 'yuyu-tei', currency: 'JPY', cardId: 'hBP04-028_hBP08_C_hBP04-028_C_02', sourceProduct: 'hBP04' },
  ],
};

const reprintCard = { cardNumber: 'hBP04-028', sourceProduct: 'hBP08', rarity: 'C' };
const filteredReprint = filterProvenanceMatchedRecords(contaminatedFile.records, reprintCard);
assert.equal(filteredReprint.length, 1, `reprint filter must keep only the stamped hBP08 record; got ${filteredReprint.length}`);
assert.equal(filteredReprint[0].sourceProduct, 'hBP08');
assert.equal(filteredReprint[0].price, 50);

// The same contaminated payload on an origin-product row (hBP04 base) — the
// 64 legacy records grandfather in, the stray hBP04-stamped record survives
// (its stamp matches), the stamped hBP08 record does not survive.
const originCard = { cardNumber: 'hBP04-028', sourceProduct: 'hBP04', rarity: 'C' };
const filteredOrigin = filterProvenanceMatchedRecords(contaminatedFile.records, originCard);
assert.equal(filteredOrigin.length, 64 + 1, `origin row must grandfather ${64} legacy + 1 stamped-hBP04 records; got ${filteredOrigin.length}`);
assert.ok(
  filteredOrigin.every((r) => !r.sourceProduct || r.sourceProduct === 'hBP04'),
  'origin-row filter must drop the stray stamped hBP08 record',
);

// ---- integration: seedCanonicalHistoryFiles refuses reprint-row seed -------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dic-1219-'));
try {
  const cardsForSeed = {
    // reprint row: even a valid in-memory priceHistory must NOT seed the file
    // because the preserved map has no per-date provenance and would just re-
    // stamp the same cross-product records DIC-1219 migrated out.
    'hBP04-028_hBP08_C_hBP04-028_C_02': {
      cardNumber: 'hBP04-028', sourceProduct: 'hBP08', rarity: 'C',
      priceHistory: { '2026-08-25': 50, '2026-08-26': 50, '2026-08-27': 50 },
    },
    // origin row: same shape must seed normally (control).
    'hBP04-028_hBP04_C_hBP04-028_C': {
      cardNumber: 'hBP04-028', sourceProduct: 'hBP04', rarity: 'C',
      priceHistory: { '2026-08-25': 30, '2026-08-26': 30, '2026-08-27': 30 },
    },
  };
  const result = seedCanonicalHistoryFiles({
    cards: cardsForSeed,
    historyDir: tmp,
    fsAdapter: { fs, path },
  });
  assert.equal(result.seededFiles, 1, 'exactly one origin-row file should be seeded');

  const reprintFile = path.join(tmp, historyFilenameFor('hBP04-028_hBP08_C_hBP04-028_C_02'));
  assert.equal(fs.existsSync(reprintFile), false, 'seedCanonicalHistoryFiles must not create a reprint-row file');

  const originFile = path.join(tmp, historyFilenameFor('hBP04-028_hBP04_C_hBP04-028_C'));
  assert.equal(fs.existsSync(originFile), true, 'origin-row file should be created');
  const originDoc = JSON.parse(fs.readFileSync(originFile, 'utf-8'));
  assert.equal(originDoc.records.length, 3);
  // Every record must now carry the origin sourceProduct stamp — this is the
  // going-forward provenance the filter needs on the next build.
  assert.ok(
    originDoc.records.every((r) => r.sourceProduct === 'hBP04'),
    `all seeded records must carry sourceProduct: 'hBP04'`,
  );
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- integration: applyPreservedMarketFields refuses cross-product history -
{
  const previous = {
    cardNumber: 'hBP04-028', sourceProduct: 'hBP04', rarity: 'C',
    priceHistory: { '2026-06-18': 30, '2026-06-19': 30 },
  };
  const currentReprint = {
    cardNumber: 'hBP04-028', sourceProduct: 'hBP08', rarity: 'C',
    priceHistory: {},
  };
  // signature match (sourceProduct differs) → priceHistory must NOT copy
  const summary = applyPreservedMarketFields(currentReprint, previous, {
    matchKind: 'signature',
    preserveYuyuPayload: true,
  });
  assert.equal(summary.priceHistory, false, 'cross-product signature match must refuse priceHistory');
  assert.equal(Object.keys(currentReprint.priceHistory).length, 0, 'currentCard.priceHistory must remain empty');
}
{
  // exact-id match is provenance-safe by construction — priceHistory copies.
  const previous = {
    cardNumber: 'hBP04-028', sourceProduct: 'hBP08', rarity: 'C',
    priceHistory: { '2026-08-25': 50, '2026-08-26': 50 },
  };
  const currentReprint = {
    cardNumber: 'hBP04-028', sourceProduct: 'hBP08', rarity: 'C',
    priceHistory: {},
  };
  const summary = applyPreservedMarketFields(currentReprint, previous, {
    matchKind: 'exact-id',
    preserveYuyuPayload: true,
  });
  assert.equal(summary.priceHistory, true, 'exact-id match must preserve priceHistory');
  assert.equal(Object.keys(currentReprint.priceHistory).length, 2);
}

console.log('DIC-1219 price-history provenance regression checks passed');
