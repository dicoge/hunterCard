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
 *   3. Within each rank stable-sort keeps the caller's input order — new rows
 *      appended by the daily official-catalog scrape stay behind older ones.
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
export function detailAlignmentRowRank(card) {
  const prefix = cardNumberOriginPrefix(card?.cardNumber);
  const source = String(card?.sourceProduct || card?.series || '');
  const hasPrices = Array.isArray(card?.prices) && card.prices.length > 0;
  // Origin-product priority DOMINATES prices-non-empty priority. Under DIC-1227
  // the origin row may legitimately ship prices=[] once contamination is
  // stripped; detail still needs to see it first so buildPriceVersions falls
  // back to a single BASE entry that matches deck aggregation.
  let rank = 0;
  if (!prefix || source !== prefix) rank += 100;
  if (!hasPrices) rank += 10;
  return rank;
}

/**
 * Reorder a cards map (id → card) so that within each cardNumber group, the
 * origin-product base row comes first. Cross-cardNumber insertion order is
 * preserved via the first-seen entry per cardNumber. Callers get back a fresh
 * object; the input is not mutated.
 */
export function orderCardsForDetailAlignment(cards) {
  if (!cards || typeof cards !== 'object') return cards;
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
      .sort((a, b) => (a.rank - b.rank) || (a.position - b.position));
    if (rankedIds.some(({ id }, idx) => id !== groupIds[idx])) reordered++;
    for (const { id } of rankedIds) out[id] = cards[id];
  }
  return { cards: out, reorderedCardNumbers: reordered };
}
