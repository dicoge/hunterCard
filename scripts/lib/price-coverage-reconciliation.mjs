/**
 * price-coverage-reconciliation.mjs — DIC-1167 (2026-09-28) scraped-vs-shipped
 * price coverage reconciliation.
 *
 * The 2026-09-28 scrape freshly listed 1,331 cardNumbers yet the build only
 * printed "45 not priced", while 71 cardNumbers had silently fallen through
 * the yuyu-only fallback's fail-closed branch (a console.log, nowhere
 * durable). 26 of those kept their own last source-proven payload through
 * DIC-1482 preservation; 45 shipped null. Both outcomes were correct — but no
 * artifact could prove it, and a real loss of the same shape would have
 * exited 0 just the same.
 *
 * This module makes that accounting exact and fail-closed. Every scraped
 * cardNumber must land in exactly one category, measured on the artifact that
 * actually ships (after the DIC-1167 increase-strip):
 *
 *   - fresh                 — some row of the cardNumber was priced by THIS
 *                             run's scrape and is still priced.
 *   - preserved             — still priced only through last-known-good
 *                             preservation (not freshly proven).
 *   - refusedFallback       — unpriced; the yuyu-only fallback refused every
 *                             listing (no exact printing / ambiguous
 *                             printings / no row to bind). Per-cardNumber
 *                             evidence lives in `listingRefusals`.
 *   - refusedIncrease       — unpriced; the DIC-1167 increase gate stripped a
 *                             fresh price lacking exact-print provenance.
 *   - ambiguityNulled       — unpriced; DIC-1227 promo-ambiguity nulled it.
 *   - noSellListing         — unpriced; no scraped listing carried a positive
 *                             sellPrice, so there was nothing to publish.
 *   - unaccounted           — unpriced with none of the reasons above. This is
 *                             a silent loss and the build must refuse to ship.
 *
 * Pure module: no I/O, no mutation of its inputs.
 */

export const LISTING_REFUSAL_REASONS = Object.freeze([
  'no-exact-printing-proven',
  'ambiguous-official-printings',
  'proven-printing-missing-row',
]);

function isPositivePrice(value) {
  return Number.isFinite(value) && value > 0;
}

function listingHasSellPrice(priceData) {
  const entries = Array.isArray(priceData) ? priceData : [priceData];
  return entries.some((entry) => isPositivePrice(entry?.sellPrice));
}

/**
 * @param {object} args
 * @param {object} args.prices            raw scrape map (raw cardNumber → listing(s))
 * @param {(n: string) => string} args.canonicalizeCardNumber
 * @param {object} args.cards             the final (post-strip) cards map
 * @param {Set<string>} args.freshlyPricedRowIds  row ids priced before preservation
 * @param {Map<string, object>} args.listingRefusals  canonical cardNumber → refusal record
 * @param {Array<{cardNumber: string}>} args.increaseRejections
 * @param {Set<string>} args.ambiguityNulledIds
 */
export function reconcileScrapedCoverage({
  prices = {},
  canonicalizeCardNumber = (n) => n,
  cards = {},
  freshlyPricedRowIds = new Set(),
  listingRefusals = new Map(),
  increaseRejections = [],
  ambiguityNulledIds = new Set(),
} = {}) {
  // Canonical cardNumber → whether ANY raw key for it listed a sell price.
  // Two raw keys (hY01-14 / hY01-014) can canonicalize to one cardNumber.
  const scraped = new Map();
  for (const [rawCardNum, priceData] of Object.entries(prices || {})) {
    const cardNum = canonicalizeCardNumber(rawCardNum);
    scraped.set(cardNum, Boolean(scraped.get(cardNum)) || listingHasSellPrice(priceData));
  }

  const freshPriced = new Set();
  const anyPriced = new Set();
  const ambiguityCardNums = new Set();
  for (const [id, card] of Object.entries(cards || {})) {
    const cardNum = card?.cardNumber;
    if (!cardNum) continue;
    if (ambiguityNulledIds?.has?.(id)) ambiguityCardNums.add(cardNum);
    if (!isPositivePrice(card?.sellPrice)) continue;
    anyPriced.add(cardNum);
    if (freshlyPricedRowIds?.has?.(id)) freshPriced.add(cardNum);
  }
  const increaseCardNums = new Set(
    (increaseRejections || []).map((r) => r?.cardNumber).filter(Boolean),
  );

  const categories = {
    fresh: [],
    preserved: [],
    refusedFallback: [],
    refusedIncrease: [],
    ambiguityNulled: [],
    noSellListing: [],
    unaccounted: [],
  };
  // Refused by the fallback but still priced through preservation — the
  // 2026-09-28 hBD24 hPR/P shape. Reported separately so a preserved row is
  // never mistaken for a loss, nor a loss for a preserved row.
  const preservedAfterFallbackRefusal = [];

  for (const [cardNum, hasSellListing] of scraped) {
    if (freshPriced.has(cardNum)) {
      categories.fresh.push(cardNum);
    } else if (anyPriced.has(cardNum)) {
      categories.preserved.push(cardNum);
      if (listingRefusals?.has?.(cardNum)) preservedAfterFallbackRefusal.push(cardNum);
    } else if (listingRefusals?.has?.(cardNum)) {
      categories.refusedFallback.push(cardNum);
    } else if (increaseCardNums.has(cardNum)) {
      categories.refusedIncrease.push(cardNum);
    } else if (ambiguityCardNums.has(cardNum)) {
      categories.ambiguityNulled.push(cardNum);
    } else if (!hasSellListing) {
      categories.noSellListing.push(cardNum);
    } else {
      categories.unaccounted.push(cardNum);
    }
  }
  for (const list of Object.values(categories)) list.sort();
  preservedAfterFallbackRefusal.sort();

  const counts = Object.fromEntries(
    Object.entries(categories).map(([k, v]) => [k, v.length]),
  );
  const unpriced = counts.refusedFallback + counts.refusedIncrease
    + counts.ambiguityNulled + counts.noSellListing + counts.unaccounted;
  return {
    scrapedCardNumbers: scraped.size,
    pricedCardNumbers: counts.fresh + counts.preserved,
    unpricedCardNumbers: unpriced,
    counts: { ...counts, preservedAfterFallbackRefusal: preservedAfterFallbackRefusal.length },
    categories,
    preservedAfterFallbackRefusal,
    ok: counts.unaccounted === 0,
  };
}

/** Compact, committed-manifest form of a reconciliation (cardNumbers only for non-fresh buckets). */
export function reconciliationManifestBlock(reconciliation) {
  if (!reconciliation) return null;
  const { categories } = reconciliation;
  return {
    scrapedCardNumbers: reconciliation.scrapedCardNumbers,
    pricedCardNumbers: reconciliation.pricedCardNumbers,
    unpricedCardNumbers: reconciliation.unpricedCardNumbers,
    counts: reconciliation.counts,
    preserved: categories.preserved,
    preservedAfterFallbackRefusal: reconciliation.preservedAfterFallbackRefusal,
    refusedFallback: categories.refusedFallback,
    refusedIncrease: categories.refusedIncrease,
    ambiguityNulled: categories.ambiguityNulled,
    noSellListing: categories.noSellListing,
    unaccounted: categories.unaccounted,
  };
}

export function formatReconciliationFailure(reconciliation, limit = 10) {
  const lost = reconciliation.categories.unaccounted;
  const sample = lost.slice(0, limit).join(', ');
  return `[DIC-1167] scraped-vs-shipped price coverage does not reconcile: ${lost.length} scraped cardNumber(s) `
    + `with a positive sell listing shipped unpriced with no recorded refusal/rejection: ${sample}`
    + `${lost.length > limit ? ` +${lost.length - limit} more` : ''}. Refusing to ship a silent price loss.`;
}
