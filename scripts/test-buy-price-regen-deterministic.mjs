#!/usr/bin/env node
/**
 * test-buy-price-regen-deterministic.mjs — DIC-856 CR determinism invariant.
 *
 * Proves the committed data/database.json is a FIXED POINT of the buy-price
 * regeneration: running regen once on a fresh checkout reproduces the exact
 * committed bytes (no wall-clock drift, no "only stabilizes on the second run").
 *
 * Checks:
 *   1. Byte-identity — regen(committed) === committed bytes (first run is a no-op).
 *   2. Invariant — for every card that has a card-level buyPrice,
 *      buyPriceHistory[snapshotDate] === buyPrice (history's latest point is the
 *      exact aligned buy price, never a stale/other value).
 *   3. No future keys — no buyPriceHistory date is newer than the source snapshot
 *      date (future-dated keys are wall-clock regen artifacts unbacked by sources).
 *
 * Run: node scripts/test-buy-price-regen-deterministic.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { snapshotInfo, regenerateBuyAlignment } from './regen-buy-alignment.mjs';

const root = process.cwd();
const DB_PATH = path.join(root, 'data/database.json');

const committedBytes = fs.readFileSync(DB_PATH, 'utf-8');

// 1) Byte-identity: regen a deep copy with the same deterministic snapshot the
//    CLI uses, then re-serialize exactly as the CLI writes it.
const { ts, date } = snapshotInfo();
const db = JSON.parse(committedBytes);
const stats = regenerateBuyAlignment(db, { now: (ts || Date.now()) + 1000, date });
const regenBytes = `${JSON.stringify(db, null, 2)}\n`;

assert.strictEqual(
  regenBytes,
  committedBytes,
  'first regeneration must be byte-identical to committed database.json (regen is not deterministic / artifact is stale — run `node scripts/regen-buy-alignment.mjs` and commit)',
);

// 2) + 3) Invariants on the committed artifact itself.
const committed = JSON.parse(committedBytes);
let invariantChecked = 0;
for (const card of Object.values(committed.cards || {})) {
  const bh = card.buyPriceHistory;
  if (bh && typeof bh === 'object') {
    for (const k of Object.keys(bh)) {
      assert.ok(k <= date, `${card.cardNumber}: buyPriceHistory has future-dated key ${k} > snapshot ${date}`);
    }
  }
  if (card.buyPrice != null) {
    assert.ok(bh && typeof bh === 'object', `${card.cardNumber}: has buyPrice ${card.buyPrice} but no buyPriceHistory`);
    assert.strictEqual(
      bh[date],
      card.buyPrice,
      `${card.cardNumber}: buyPriceHistory[${date}] (${bh[date]}) !== card.buyPrice (${card.buyPrice})`,
    );
    invariantChecked += 1;
  }
}

console.log(
  `buy-price regen determinism OK — byte-identical fresh regen (snapshot ${date}); ` +
  `${invariantChecked} cards satisfy buyPriceHistory[${date}]===buyPrice; no future-dated keys ` +
  `(regen aligned ${stats.cardsUpdated} cards / ${stats.variantsMatched} variants).`,
);
