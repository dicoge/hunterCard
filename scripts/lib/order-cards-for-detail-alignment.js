/**
 * order-cards-for-detail-alignment.js — deterministic per-cardNumber row order
 * that keeps the CardDetail pipeline aligned with the deck pipeline (DIC-1167).
 *
 * Why. verify-version-alignment.js encodes the shipped contract that for every
 * cardNumber the CardDetail pipeline (first-seen row → buildPriceVersions →
 * resolveVersionForCard) must resolve the same default printing as the deck
 * pipeline (adaptDatabase → groupVariantsByCardNumber). The two pipelines see
 * different views of the same cardNumber: CardDetail reads ONE row's prices[],
 * deck aggregates prices[] across every row. When a row that ships only a
 * PARALLEL subset happens to be first, CardDetail picks PARALLEL while deck
 * still picks BASE — 14 cardNumbers regressed exactly like that on
 * `test:version-alignment` for PR #157 head 66156f78 (e.g. hBP01-028 detail
 * PARALLEL/HBP08 vs deck BASE).
 *
 * Fix. Order rows within each cardNumber so the row whose prices[] carries the
 * base printing is first. Ranking is intentionally structural, not price-value
 * dependent:
 *   1. `sourceProduct` equal to the cardNumber's origin-product prefix wins
 *      (dominant rule), because base printings live in the product that
 *      introduced the card number and reprints live in later products
 *      (hBP08, hEB01, hPR, …). This is the load-bearing tie-breaker even
 *      after the DIC-1227 provenance clean-up strips cross-product yuyu
 *      payloads off origin rows — an empty-prices origin row lets
 *      buildPriceVersions fall back to a single BASE-printing entry, which
 *      is exactly what deck aggregation picks for the same cardNumber.
 *   2. Rows with non-empty prices[] beat empty-prices reprints (secondary),
 *      preserving PR #154's original ordering intent within each origin-vs-
 *      reprint bucket.
 *   3. Within each rank, rows that both existed in the previous committed
 *      database keep their PREVIOUS relative order (DIC-1167 / PR #215): the
 *      daily scrape rebuilds `cards` in official-site listing order, which can
 *      invert same-rank reprint siblings (hBP01-024 `02_C` listed before `HR`
 *      flipped 724 pairs on the 2026-09-23 rebuild and broke the DIC-1430
 *      exact-print search election). Rows absent from the previous database
 *      fall back to the caller's input order — new rows appended by the daily
 *      official-catalog scrape stay behind older ones.
 * Cross-cardNumber insertion order is preserved (first appearance of each
 * cardNumber pins its position), so the top-of-DB well-known first cardNumber
 * still ships first.
 *
 * Pure module, no filesystem or database dependency: both build-database.js and
 * the test suite import from here.
 */

/**
 * Extract the origin-product prefix from a cardNumber (`hBP01-028` → `hBP01`,
 * `hEB01-001` → `hEB01`, `hSD2025summer-001` → `hSD2025summer`). Returns an
 * empty string when the input cannot be parsed — the caller treats that as "no
 * prefix match" (never a wildcard match).
 */
export function cardNumberOriginPrefix(cardNumber) {
  const m = String(cardNumber || '').match(/^([A-Za-z]+[0-9A-Za-z]*)-\d+/);
  return m ? m[1] : '';
}

/**
 * Row rank inside its own cardNumber group. Lower rank wins. Structural, not
 * price-value: two rows with the same rank keep their input order.
 */
// A BASE-printing entry is any prices[] name without a (パラレル/…) or
// (サイン/…) suffix — i.e. the entry name is only the character name, no
// parenthesised variant marker. Deck aggregation picks BASE whenever any
// row's prices[] contains such an entry, so detail must READ from a row
// whose own prices[] also contains one.
const BASE_LABEL_RE = /^[^()]+$/;
function pricesContainsBaseEntry(card) {
  if (!Array.isArray(card?.prices)) return false;
  return card.prices.some((entry) => {
    const name = String(entry?.name || '').trim();
    return name.length > 0 && BASE_LABEL_RE.test(name);
  });
}

export function detailAlignmentRowRank(card) {
  const prefix = cardNumberOriginPrefix(card?.cardNumber);
  const source = String(card?.sourceProduct || card?.series || '');
  const pricesLen = Array.isArray(card?.prices) ? card.prices.length : 0;
  const containsBase = pricesContainsBaseEntry(card);
  // DIC-1227 CR follow-up: rank rows by
  //   1. containsBaseEntry first (deck-side aggregation picks BASE whenever
  //      any row contributes a BASE entry; detail must read from a row that
  //      also contains one so buildPriceVersions can produce the BASE
  //      candidate),
  //   2. prices[] richness (a legacy yuyu-scraper aggregation row like
  //      `_ent07` may still carry every cardNumber variant even after the
  //      DIC-1227 clean strips cross-product entries off origin rows —
  //      putting the richer row first lets detail see the same option set
  //      deck already sees),
  //   3. origin-product-match as the final tiebreaker.
  let rank = 0;
  if (!containsBase) rank += 1000;
  rank -= pricesLen * 100;
  if (!prefix || source !== prefix) rank += 10;
  return rank;
}

/**
 * Reorder a cards map (id → card) so that within each cardNumber group, the
 * origin-product base row comes first. Cross-cardNumber insertion order is
 * preserved via the first-seen entry per cardNumber. Callers get back a fresh
 * object; the input is not mutated.
 *
 * `previousCards` (optional) is the cards map of the previous committed
 * database. When two rows tie on rank AND both ids exist in `previousCards`,
 * their previous relative order wins over the rebuild's input order; any row
 * missing from `previousCards` keeps the input-order tie-break.
 */
export function orderCardsForDetailAlignment(cards, previousCards) {
  if (!cards || typeof cards !== 'object') return cards;
  const prevIndex = new Map();
  if (previousCards && typeof previousCards === 'object') {
    Object.keys(previousCards).forEach((id, idx) => prevIndex.set(id, idx));
  }
  const ids = Object.keys(cards);
  const cardNumberOrder = [];
  const seen = new Set();
  const idsByCardNumber = new Map();
  for (const id of ids) {
    const num = String(cards[id]?.cardNumber || '');
    if (!seen.has(num)) { seen.add(num); cardNumberOrder.push(num); }
    if (!idsByCardNumber.has(num)) idsByCardNumber.set(num, []);
    idsByCardNumber.get(num).push(id);
  }
  const out = {};
  let reordered = 0;
  for (const num of cardNumberOrder) {
    const groupIds = idsByCardNumber.get(num) || [];
    const rankedIds = groupIds
      .map((id, position) => ({ id, position, rank: detailAlignmentRowRank(cards[id]) }))
      .sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank;
        const pa = prevIndex.get(a.id);
        const pb = prevIndex.get(b.id);
        if (pa !== undefined && pb !== undefined && pa !== pb) return pa - pb;
        return a.position - b.position;
      });
    if (rankedIds.some(({ id }, idx) => id !== groupIds[idx])) reordered++;
    for (const { id } of rankedIds) out[id] = cards[id];
  }
  return { cards: out, reorderedCardNumbers: reordered };
}
