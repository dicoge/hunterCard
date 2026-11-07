#!/usr/bin/env node
/**
 * test-buy-price-regen-deterministic.mjs — DIC-856 CR determinism invariant (+ review N5).
 *
 * Proves the committed data/database.json is a FIXED POINT of the buy-price
 * regeneration: running regen once on a fresh checkout reproduces the exact
 * committed bytes (no wall-clock drift, no "only stabilizes on the second run").
 *
 * The regeneration is `regenerateCommitted` — exactly what the CLI runs:
 *   - artifact WITHOUT a valid merge run proof (or sources changed since it) → the original
 *     snapshot regen, with the original invariants:
 *       1. byte-identity;
 *       2. every fresh card-level buyPrice has buyPriceHistory[snapshotDate] === buyPrice;
 *       3. no history key newer than the snapshot date.
 *   - artifact WITH a valid run proof (written by merge-buy-prices.js, bound to these exact
 *     source bytes) → the merge is reproduced (fresh by its own run start, retained by identity):
 *       1. byte-identity (retained status, source, time and history unchanged);
 *       2. every fresh card-level buyPrice has a record at its observation's date (merge zone);
 *       3. no history key newer than the run's own date (in the merge's zone) — real later-zone
 *          observations are NOT pruned;
 *       4. every retained quote carries complete provenance (value + version + known shop +
 *          parseable own time; card-level via its holder, price equal);
 *       5. (review N7) every retained quote is bound to evidence: where the digest-verified
 *          source files cover its exact token, it must BE the merge's newest-unique bound entry
 *          (an edited value / shop / time, an older quote or a conflict is cleared by the regen,
 *          so the bytes differ); a quote newer than every bound entry is a carried capture and
 *          must match the carry digest the merge recorded (an edit voids the proof → strict
 *          snapshot regen → bytes differ); any retained quote at/after the run start (or the
 *          merge clock with no marker) is cleared;
 *       6. (review N8) a retained quote newer than a bound entry of its OWN provider for the same
 *          token is cleared (never "carried"); (review N9) every retained quote must be exactly
 *          what the merge's own reconcile assigns for this row from the retained quotes + bound
 *          evidence (card printing rule; variant uniqueness).
 *     `retainedCarryDigest` is a CONSISTENCY checksum over artifact content, not an authenticity
 *     proof: carried quotes whose evidence no longer exists in the files can only be pinned by it
 *     (inherent; covered by the hermetic pipeline / replay tests, not by this gate).
 *     Invariant 2 checks that the record EXISTS at the observation date, not that it equals
 *     buyPrice: the merge never rewrites an existing date (an earlier same-day value is kept).
 *     Limitation: a history record ADDED for a retained card on a date ≤ the run date cannot be
 *     detected from the committed artifact alone (it needs the previous artifact); that is
 *     covered by the hermetic fallback / pipeline / replay tests, not by this gate.
 *
 * Run: node scripts/test-buy-price-regen-deterministic.mjs   (honours HUNTERCARD_BUY_PRICES_DIR)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { regenerateCommitted } from './regen-buy-alignment.mjs';
import { historyDateKey } from './merge-buy-prices.js';

const root = process.cwd();
const DB_PATH = path.join(root, 'data/database.json');
const SHOPS = new Set(['torecolo', 'fullahead', 'yuyu']);

const committedBytes = fs.readFileSync(DB_PATH, 'utf-8');

// 1) Byte-identity: regen a deep copy exactly as the CLI does, re-serialized as the CLI writes it.
const db = JSON.parse(committedBytes);
const stats = regenerateCommitted(db);
const regenBytes = `${JSON.stringify(db, null, 2)}\n`;

assert.strictEqual(
  regenBytes,
  committedBytes,
  `first regeneration (mode=${stats.mode}) must be byte-identical to committed database.json (regen is not deterministic / artifact is stale — run \`node scripts/regen-buy-alignment.mjs\` and commit)`
  + (stats.retainedViolations && stats.retainedViolations.length ? `; retained quotes not bound to evidence: ${stats.retainedViolations.slice(0, 5).join(', ')}` : ''),
);
if (stats.mode === 'run-proof') {
  assert.deepEqual(stats.retainedViolations, [], 'every retained quote is bound to its evidence');
}

// 2) + 3) (+ 4) Invariants on the committed artifact itself.
const committed = JSON.parse(committedBytes);
let invariantChecked = 0;
let retainedChecked = 0;
const ceiling = stats.mode === 'snapshot' ? stats.date : historyDateKey(stats.proof.now, stats.proof.timeZone);
for (const [id, card] of Object.entries(committed.cards || {})) {
  const bh = card.buyPriceHistory;
  if (bh && typeof bh === 'object') {
    for (const k of Object.keys(bh)) {
      assert.ok(k <= ceiling, `${card.cardNumber}: buyPriceHistory has future-dated key ${k} > ${stats.mode === 'snapshot' ? 'snapshot' : 'run date'} ${ceiling}`);
    }
  }
  // A retained (last-known) quote is explicitly NOT an observation of this artifact's run: it
  // keeps its own original source/time and never writes a record — its provenance is checked.
  if (card.buyPrice != null && card.buyPriceRetained === true) {
    if (stats.mode === 'run-proof') {
      const h = card.buyLastKnown;
      assert.ok(h && h.price === card.buyPrice && typeof h.version === 'string' && SHOPS.has(h.source) && Number.isFinite(Date.parse(h.timestamp)),
        `${id}: retained card buy ${card.buyPrice} lacks complete provenance`);
      retainedChecked += 1;
    }
    continue;
  }
  if (card.buyPrice != null) {
    assert.ok(bh && typeof bh === 'object', `${card.cardNumber}: has buyPrice ${card.buyPrice} but no buyPriceHistory`);
    if (stats.mode === 'snapshot') {
      assert.strictEqual(bh[ceiling], card.buyPrice, `${card.cardNumber}: buyPriceHistory[${ceiling}] (${bh[ceiling]}) !== card.buyPrice (${card.buyPrice})`);
    } else {
      const key = stats.freshHistoryKeys[id];
      assert.ok(key && bh[key] != null, `${card.cardNumber}: fresh buyPrice ${card.buyPrice} has no record at its observation date ${key}`);
    }
    invariantChecked += 1;
  }
  if (stats.mode === 'run-proof') {
    for (const v of card.prices || []) {
      if (!v || v.buyPriceRetained !== true) continue;
      assert.ok(v.buyPrice > 0 && typeof v.buyPriceVersion === 'string' && SHOPS.has(v.buyPriceSource) && Number.isFinite(Date.parse(v.buyPriceTimestamp)),
        `${id} :: ${v.name}: retained variant lacks complete provenance`);
      retainedChecked += 1;
    }
  }
}

console.log(
  `buy-price regen determinism OK — mode=${stats.mode}, byte-identical regen (${stats.mode === 'snapshot' ? `snapshot ${ceiling}` : `run date ${ceiling} @ ${stats.proof.timeZone}`}); `
  + `${invariantChecked} fresh cards have their observation record; ${retainedChecked} retained quotes carry complete provenance`
  + (stats.mode === 'run-proof' ? ` (source-covered ${stats.retainedCovered}, carried ${stats.retainedCarried})` : '')
  + '; no future-dated keys '
  + `(regen aligned ${stats.cardsUpdated} cards / ${stats.variantsMatched} variants).`,
);
