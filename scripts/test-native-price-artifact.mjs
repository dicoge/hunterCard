#!/usr/bin/env node
/**
 * DIC-1319 regression: the catalog a native build SHIPS must carry real sale
 * prices, and it must carry them per printing.
 *
 * The v21 closed test reported "all card prices are absent", and the first
 * hypothesis was a price-less bundled artifact. That hypothesis was wrong — the
 * committed artifact was fine and the blank prices came from a UI gate (see
 * scripts/test-store-mvp-ui-gates.mjs). But nothing in the suite actually
 * asserted the shipped artifact's price coverage, so the hypothesis could not
 * be ruled out from CI. This test closes that gap: if a scrape, a sanitizer, or
 * a catalog sync ever lands a catalog whose prices collapsed, it fails here
 * instead of in a store review.
 *
 * It reads through `src/utils/staticData.ts` — the exact loader Metro resolves
 * for native — rather than reading the JSON path directly, so a loader that
 * silently returns the wrong file also fails.
 *
 * Printing isolation is asserted alongside coverage: a card's `prices[]`
 * entries are per-printing, and the price the scan flow shows must come from
 * the matching printing, never borrowed from a sibling.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-ts.mjs \
 *        scripts/test-native-price-artifact.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadDatabaseJson } from '../src/utils/staticData.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

let passed = 0;
function check(label, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

const db = await loadDatabaseJson();
const cardsMap = db?.cards;

check(
  'native loader returns a catalog with a cards map',
  cardsMap && typeof cardsMap === 'object' && !Array.isArray(cardsMap),
  `got ${Object.prototype.toString.call(cardsMap)}`,
);

// `cards` is an OBJECT keyed by card id, not an array. Iterating it directly
// yields key strings, which is how a naive coverage count reports zero priced
// cards on a perfectly healthy catalog — worth stating in the test that guards
// the number.
const cards = Object.values(cardsMap);

const withSellPrice = cards.filter((c) => typeof c.sellPrice === 'number' && c.sellPrice > 0);
const withPrices = cards.filter((c) => Array.isArray(c.prices) && c.prices.length > 0);

console.log(
  `  … catalog: ${cards.length} cards, ${withSellPrice.length} with sellPrice, ${withPrices.length} with prices[]`,
);

// ── Erosion ratchet, not a loose floor ───────────────────────────────────────
//
// The first version of this test used a floor of 500, chosen only to be "far
// above zero". PM's evidence (DIC-1319 thread) showed that is useless: price
// coverage has been eroding steadily and a floor of 500 sails straight through
// it. Measured from the committed catalog:
//
//   e8322c8003  2026-08-26   2,011 priced rows / 2,318 cards   1,179 priced cardNumbers
//   fbe0a13821  2026-08-29   1,885 priced rows / 3,622 cards   1,171 priced cardNumbers
//   f156bb7cf   2026-09-02   1,547 priced rows / 3,622 cards   1,124 priced cardNumbers  ← v21 shipped this
//   HEAD        2026-09-03   1,547 priced rows / 3,622 cards   1,124 priced cardNumbers
//
// 55 cardNumbers that were priced on 08-26 are now entirely unpriced. Part of
// that is deliberate (DIC-1227 gated price preservation on yuyu-provenance
// match, filtering unproven rows); part is a stalled scrape. Recovering it is
// DIC-1321's job, not this test's. This test's job is to stop the SHIPPED
// artifact degrading further while that recovery is in flight.
//
// So these are STATIC baselines pinned to today's known-degraded state, not a
// moving average — a moving baseline would re-bless each day's erosion. They
// are a ceiling on damage, NOT a statement that this coverage is healthy: it is
// not. When DIC-1321 lands a recovered artifact, RAISE these deliberately in
// the same PR. Coverage going UP never fails.
//
// The small tolerance absorbs genuine churn — a listing selling out legitimately
// drops a row — without absorbing a purge.
const PRICED_ROWS_BASELINE = 1547;
const PRICED_CARDNUMBERS_BASELINE = 1124;
const EROSION_TOLERANCE = 0.02; // 2%
const rowsFloor = Math.floor(PRICED_ROWS_BASELINE * (1 - EROSION_TOLERANCE));
const numbersFloor = Math.floor(PRICED_CARDNUMBERS_BASELINE * (1 - EROSION_TOLERANCE));

// A cardNumber is the identity a player reads off the card in hand. Counting
// distinct priced cardNumbers — not just rows — is what catches "this card has
// no price at all any more", which is the failure a scanning user actually hits.
const pricedCardNumbers = new Set(withSellPrice.map((c) => c.cardNumber).filter(Boolean));

console.log(`  … priced cardNumbers: ${pricedCardNumbers.size} (baseline ${PRICED_CARDNUMBERS_BASELINE}, floor ${numbersFloor})`);

check(
  'the shipped catalog is not empty',
  cards.length > 1000,
  `got ${cards.length} cards`,
);
check(
  `priced rows have not eroded below ${rowsFloor} (baseline ${PRICED_ROWS_BASELINE})`,
  withSellPrice.length >= rowsFloor,
  `got ${withSellPrice.length} — coverage dropped; do not raise the baseline to make this pass, find what removed the prices`,
);
check(
  `cards with a non-empty prices[] have not eroded below ${rowsFloor}`,
  withPrices.length >= rowsFloor,
  `got ${withPrices.length}`,
);
check(
  `distinct priced cardNumbers have not eroded below ${numbersFloor} (baseline ${PRICED_CARDNUMBERS_BASELINE})`,
  pricedCardNumbers.size >= numbersFloor,
  `got ${pricedCardNumbers.size} — some card numbers lost every priced printing`,
);

// ── Per-printing integrity ───────────────────────────────────────────────────
// Every prices[] row must name its printing and carry its own number. A row
// that lost its name is a row the scan result cannot attribute to a printing,
// which is how cross-printing prices leak into a result card.
{
  const rows = withPrices.flatMap((c) => c.prices.map((p) => ({ card: c, p })));
  const namelessRows = rows.filter(({ p }) => typeof p.name !== 'string' || p.name.length === 0);
  check(
    'every prices[] row names the printing it belongs to (no unattributable price)',
    namelessRows.length === 0,
    `${namelessRows.length} nameless rows, e.g. ${JSON.stringify(namelessRows[0]?.card?.cardNumber)}`,
  );

  const pricedRows = rows.filter(({ p }) => typeof p.sellPrice === 'number' && p.sellPrice > 0);
  check(
    'priced printing rows exist in bulk, not as a handful of stragglers',
    pricedRows.length >= rowsFloor,
    `got ${pricedRows.length}`,
  );

  // sellPrice is the card-level headline. Where a card has priced printings it
  // must equal one of them — if it does not, the headline is an aggregate
  // synthesised across printings, exactly the cross-printing fallback the
  // product forbids.
  const mismatched = withSellPrice
    .filter((c) => Array.isArray(c.prices) && c.prices.some((p) => typeof p.sellPrice === 'number' && p.sellPrice > 0))
    .filter((c) => !c.prices.some((p) => p.sellPrice === c.sellPrice));
  check(
    'card-level sellPrice always equals one of its own printings (no cross-printing synthesis)',
    mismatched.length === 0,
    `${mismatched.length} cards, e.g. ${mismatched[0]?.cardNumber} sellPrice=${mismatched[0]?.sellPrice} printings=${JSON.stringify(mismatched[0]?.prices?.map((p) => p.sellPrice))}`,
  );
}

// ── The bundled bytes are the ones the loader hands out ──────────────────────
// staticData.ts imports public/data/database.json, which is what an expo native
// export copies verbatim. Prove the loader's price payload matches that file,
// so a future loader change cannot serve a different (e.g. stripped) catalog
// while these coverage checks keep passing against the good one.
{
  const shipped = JSON.parse(fs.readFileSync(path.join(repoRoot, 'public/data/database.json'), 'utf-8'));
  const shippedCards = Object.values(shipped.cards ?? {});
  const shippedPriced = shippedCards.filter((c) => typeof c.sellPrice === 'number' && c.sellPrice > 0);
  check(
    'loader price coverage matches the bundled public/data/database.json exactly',
    shippedCards.length === cards.length && shippedPriced.length === withSellPrice.length,
    `loader ${cards.length}/${withSellPrice.length} vs bundled ${shippedCards.length}/${shippedPriced.length}`,
  );
}

// ── Mutation sensitivity ─────────────────────────────────────────────────────
// A catalog whose prices were blanked must fail the coverage assertions. Prove
// the checks are load-bearing rather than trivially satisfiable.
{
  const blanked = cards.map((c) => ({ ...c, sellPrice: null, prices: [] }));
  const blankedPriced = blanked.filter((c) => typeof c.sellPrice === 'number' && c.sellPrice > 0);
  check(
    'mutation: a price-blanked catalog would fail the sellPrice coverage floor',
    blankedPriced.length < rowsFloor && blanked.length === cards.length,
  );

  // The defect the ratchet exists for is NOT a total blanking — it is quiet
  // erosion. Replay the real 08-29 → 09-02 drop (1,885 → 1,547 priced rows,
  // an 18% loss) against today's catalog and prove the ratchet trips on it.
  // The old floor of 500 passed this, which is exactly why it was replaced.
  const erodedRows = Math.round(withSellPrice.length * (1547 / 1885));
  check(
    'mutation: replaying the observed 08-29 → 09-02 erosion (-18% priced rows) trips the ratchet',
    erodedRows < rowsFloor,
    `eroded to ${erodedRows}, floor ${rowsFloor}`,
  );
  check(
    'mutation: the retired floor of 500 would NOT have caught that erosion',
    erodedRows >= 500,
    `eroded to ${erodedRows}`,
  );

  // Losing every priced printing for a set of cardNumbers — the 55-cardNumber
  // regression PM measured — must trip the cardNumber ratchet too.
  const doomed = new Set([...pricedCardNumbers].slice(0, 60));
  const survivors = new Set([...pricedCardNumbers].filter((n) => !doomed.has(n)));
  check(
    'mutation: dropping 60 priced cardNumbers trips the cardNumber ratchet',
    survivors.size < numbersFloor,
    `survivors ${survivors.size}, floor ${numbersFloor}`,
  );

  // And the naive-iteration trap that reports zero on a healthy catalog: keys,
  // not card objects. Documented so the next coverage measurement is not read
  // as a data outage.
  const naive = Object.keys(cardsMap).filter((k) => typeof k.sellPrice === 'number');
  check(
    'iterating the cards MAP without .values() yields zero prices on a healthy catalog',
    naive.length === 0 && withSellPrice.length > 0,
  );
}

// ── CI actually runs this ────────────────────────────────────────────────────
{
  const ci = fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf-8');
  check('CI executes the native price-artifact regression', ci.includes('test:native-price-artifact'));
}

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ Native price artifact regression: ${passed} checks passed`);
} else {
  console.error('\n❌ Native price artifact regression failed');
}
