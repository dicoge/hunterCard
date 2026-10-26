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
 *   - unaccounted           — unpriced with none of the reasons above, or
 *                             priced only through preservation while its
 *                             positive listing neither matched an exact
 *                             printing nor was refused. This is a silent loss
 *                             and the build must refuse to ship.
 *
 * The cardNumber buckets alone cannot prove exact-printing coverage: one priced
 * sibling put the whole cardNumber in `fresh` / `preserved`, masking a sibling
 * printing that THIS scrape priced and the pipeline then lost (CR 1924ef80).
 * So every printing the scrape freshly priced is also accounted for by its
 * compound-key row id — the official printing identity — in `printingLedger`:
 * it ships priced, was stripped by the increase gate, was ambiguity-nulled, or
 * is an `unaccountedPrinting`, which fails the build like an unaccounted
 * cardNumber does. A printing no listing proved to has no scraped price to
 * lose; binding a sibling's listing onto it would be the forbidden
 * cardNumber-wide fallback.
 *
 * "Freshly priced" alone still misses the matched-but-unpriced loss (CR
 * 81802b00): a listing with a positive sellPrice ties to an exact printing,
 * yet the printing never received a fresh price, and a priced sibling kept the
 * cardNumber in `fresh` / `preserved`. So the ledger also covers every printing
 * a POSITIVE listing matched (`positiveListingRowIds`). Such a printing that
 * was not freshly priced must carry a per-printing disposition in
 * `printingListingRefusals` (e.g. its only positive price was a retired
 * pre-errata listing that canonicalisation drops) — otherwise it is an
 * `unaccountedPrinting`. A printing matched only by non-positive listings had
 * no price to lose and stays lawful. The cardNumber-level preserved guard is
 * likewise scoped to positive-listing matches: a non-positive match never
 * stands in for an unhandled positive listing.
 *
 * Printing-level accounting still only sees listings that reached SOME
 * printing (CR e0a089af): one exactly-priced printing (U ¥100) kept the
 * cardNumber `fresh` while a sibling positive listing proved to no printing
 * (SR ¥2,480) vanished with no record. So every scraped listing with a
 * positive sellPrice is also accounted for individually, by its
 * `scrapedListingId` (raw key + index), in `listingLedger`: it matched an exact
 * printing (`matchedListingIds`, then ledgered per printing above) or it is
 * named in the `refusedListingIds` of its cardNumber's `listingRefusals`
 * record. Anything else is an `unaccountedListing`: its cardNumber is
 * `unaccounted` — never `fresh` / `preserved` — and the build fails. A refusal
 * record for the cardNumber that does not name the listing does not cover it.
 *
 * Pure module: no I/O, no mutation of its inputs.
 */

export const LISTING_REFUSAL_REASONS = Object.freeze([
  'no-exact-printing-proven',
  'ambiguous-official-printings',
  'proven-printing-missing-row',
  // The fallback bound the listing(s) proved to one printing; the positive
  // listing(s) that proved to no printing were not bound anywhere, so the
  // refusal must be recorded like the others.
  'positive-listings-unproven',
  // A sibling printing of the cardNumber was already priced by exact match, so
  // the fallback never runs; the positive listing(s) that matched no printing
  // are refused rather than dropped (CR e0a089af).
  'positive-listings-unbound-priced-sibling',
]);

// Per-printing dispositions for a printing a positive listing matched but that
// received no fresh price.
export const PRINTING_LISTING_REFUSAL_REASONS = Object.freeze([
  // Every positive sellPrice among the matched listings sat on a retired
  // (pre-errata) row that DIC-1139 canonicalisation drops; the corrected row
  // is unpriced, so the DIC-1167 canonical top-level contract ships null.
  'no-positive-canonical-price',
]);

/** Identity of one scraped listing: its raw scrape key plus its index there. */
export function scrapedListingId(rawCardNum, index) {
  return `${rawCardNum}#${index}`;
}

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
 * @param {Set<string>} [args.positiveListingRowIds]  row ids a scraped listing
 *        with a positive sellPrice matched to an exact printing (priced or
 *        not). Omitted = none, so a preserved-only cardNumber with a positive
 *        listing fails closed.
 * @param {Map<string, object>} [args.printingListingRefusals]  row id → per-printing
 *        disposition for a positive-listing match that received no fresh price
 * @param {Set<string>} [args.matchedListingIds]  `scrapedListingId`s of listings
 *        matched to an exact printing (or published on a truly yuyu-only row).
 *        Omitted = none, so every positive listing must then be refused.
 * @param {Map<string, object>} args.listingRefusals  canonical cardNumber → refusal
 *        record; only listings named in its `refusedListingIds` are covered
 * @param {Array<{cardNumber: string}>} args.increaseRejections
 * @param {Set<string>} args.ambiguityNulledIds
 */
export function reconcileScrapedCoverage({
  prices = {},
  canonicalizeCardNumber = (n) => n,
  cards = {},
  freshlyPricedRowIds = new Set(),
  positiveListingRowIds = new Set(),
  matchedListingIds = new Set(),
  printingListingRefusals = new Map(),
  listingRefusals = new Map(),
  increaseRejections = [],
  ambiguityNulledIds = new Set(),
} = {}) {
  // Canonical cardNumber → whether ANY raw key for it listed a sell price.
  // Two raw keys (hY01-14 / hY01-014) can canonicalize to one cardNumber.
  const scraped = new Map();
  // Per-listing ledger (CR e0a089af): every positive listing is matched to an
  // exact printing or individually refused.
  const listingLedger = { positiveListings: 0, matched: 0, refused: 0, unaccounted: 0 };
  const unaccountedListings = [];
  const unaccountedListingCardNums = new Set();
  const refusalNames = (cardNum, id) => {
    const named = listingRefusals?.get?.(cardNum)?.refusedListingIds;
    return Array.isArray(named) ? named.includes(id) : Boolean(named?.has?.(id));
  };
  for (const [rawCardNum, priceData] of Object.entries(prices || {})) {
    const cardNum = canonicalizeCardNumber(rawCardNum);
    scraped.set(cardNum, Boolean(scraped.get(cardNum)) || listingHasSellPrice(priceData));
    const entries = Array.isArray(priceData) ? priceData : [priceData];
    entries.forEach((entry, index) => {
      if (!isPositivePrice(entry?.sellPrice)) return;
      listingLedger.positiveListings++;
      const id = scrapedListingId(rawCardNum, index);
      if (matchedListingIds?.has?.(id)) listingLedger.matched++;
      else if (refusalNames(cardNum, id)) listingLedger.refused++;
      else {
        unaccountedListings.push(id);
        unaccountedListingCardNums.add(cardNum);
      }
    });
  }
  unaccountedListings.sort();
  listingLedger.unaccounted = unaccountedListings.length;

  const freshPriced = new Set();
  const anyPriced = new Set();
  const positiveMatchedCardNums = new Set();
  const ambiguityCardNums = new Set();
  for (const [id, card] of Object.entries(cards || {})) {
    const cardNum = card?.cardNumber;
    if (!cardNum) continue;
    if (positiveListingRowIds?.has?.(id)) positiveMatchedCardNums.add(cardNum);
    if (ambiguityNulledIds?.has?.(id)) ambiguityCardNums.add(cardNum);
    if (!isPositivePrice(card?.sellPrice)) continue;
    anyPriced.add(cardNum);
    if (freshlyPricedRowIds?.has?.(id)) freshPriced.add(cardNum);
  }
  const increaseCardNums = new Set(
    (increaseRejections || []).map((r) => r?.cardNumber).filter(Boolean),
  );
  const increaseIds = new Set((increaseRejections || []).map((r) => r?.id).filter(Boolean));

  // Exact-printing ledger: every row THIS scrape priced, and every row a
  // positive listing matched, ends in exactly one state on the shipped
  // artifact, keyed by its compound-key row id.
  const printingLedger = {
    freshlyPriced: 0,
    positiveListingUnpriced: 0,
    shippedPriced: 0,
    refusedIncrease: 0,
    ambiguityNulled: 0,
    refusedListing: 0,
    unaccounted: 0,
  };
  const unaccountedPrintings = [];
  const ledgerIds = new Set(freshlyPricedRowIds || []);
  for (const id of freshlyPricedRowIds || []) {
    printingLedger.freshlyPriced++;
    const card = cards?.[id];
    if (isPositivePrice(card?.sellPrice)) printingLedger.shippedPriced++;
    else if (increaseIds.has(id)) printingLedger.refusedIncrease++;
    else if (ambiguityNulledIds?.has?.(id)) printingLedger.ambiguityNulled++;
    else unaccountedPrintings.push(id);
  }
  for (const id of positiveListingRowIds || []) {
    if (ledgerIds.has(id)) continue;
    ledgerIds.add(id);
    printingLedger.positiveListingUnpriced++;
    // A positive listing matched this printing but no fresh price resulted.
    // A preserved last-known-good price does not explain that; only a
    // per-printing record does. Records for a sibling never cover it.
    if (printingListingRefusals?.has?.(id)) printingLedger.refusedListing++;
    else if (ambiguityNulledIds?.has?.(id)) printingLedger.ambiguityNulled++;
    else unaccountedPrintings.push(id);
  }
  unaccountedPrintings.sort();
  printingLedger.unaccounted = unaccountedPrintings.length;

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
    if (unaccountedListingCardNums.has(cardNum)) {
      // A priced printing (fresh or preserved) is no evidence that a sibling
      // positive listing was handled.
      categories.unaccounted.push(cardNum);
    } else if (freshPriced.has(cardNum)) {
      categories.fresh.push(cardNum);
    } else if (anyPriced.has(cardNum)) {
      // A preserved sibling is not evidence that this run's positive listing
      // was handled: a positive listing must have matched an exact printing
      // (then accounted per printing in the ledger above) or been refused. A
      // non-positive match proves nothing about the positive listing.
      const refused = listingRefusals?.has?.(cardNum);
      if (hasSellListing && !refused && !positiveMatchedCardNums.has(cardNum)) {
        categories.unaccounted.push(cardNum);
        continue;
      }
      categories.preserved.push(cardNum);
      if (refused) preservedAfterFallbackRefusal.push(cardNum);
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
    printingLedger,
    unaccountedPrintings,
    listingLedger,
    unaccountedListings,
    ok: counts.unaccounted === 0 && unaccountedPrintings.length === 0 && unaccountedListings.length === 0,
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
    printingLedger: reconciliation.printingLedger,
    unaccountedPrintings: reconciliation.unaccountedPrintings,
    listingLedger: reconciliation.listingLedger,
    unaccountedListings: reconciliation.unaccountedListings,
  };
}

export function formatReconciliationFailure(reconciliation, limit = 10) {
  const sample = (list) => `${list.slice(0, limit).join(', ')}${list.length > limit ? ` +${list.length - limit} more` : ''}`;
  const lost = reconciliation.categories.unaccounted;
  const lostPrintings = reconciliation.unaccountedPrintings || [];
  const lostListings = reconciliation.unaccountedListings || [];
  const parts = [];
  if (lost.length > 0) {
    parts.push(`${lost.length} scraped cardNumber(s) with a positive sell listing shipped without a fresh price `
      + `or a recorded refusal/rejection: ${sample(lost)}`);
  }
  if (lostPrintings.length > 0) {
    parts.push(`${lostPrintings.length} exact printing(s) priced by, or matched to a positive listing of, `
      + `this scrape shipped without a fresh price and with no recorded rejection: ${sample(lostPrintings)}`);
  }
  if (lostListings.length > 0) {
    parts.push(`${lostListings.length} scraped positive listing(s) neither matched an exact printing `
      + `nor were named by a recorded refusal: ${sample(lostListings)}`);
  }
  return `[DIC-1167] scraped-vs-shipped price coverage does not reconcile: ${parts.join('; ')}. `
    + 'Refusing to ship a silent price loss.';
}
