/**
 * preserve-market-fields.js — signature-based market-field preservation across
 * canonical printing-ID rebuilds (DIC-1204).
 *
 * Background. `scripts/build-database.js` and `scripts/sync-official-catalog-to-database.mjs`
 * both look up the previous database row by exact card id when they need to
 * carry proven market data forward into the freshly rebuilt row. DIC-1084's
 * printing-ID canonicalization renames existing printings (e.g. `hSD03-011_hSD03`
 * → `hSD03-011_hSD03_U_hSD03-011_U`), so the exact-id lookup misses every
 * renamed row and the freshly rebuilt DB ships with sellPrice/priceHistory/
 * ytStats emptied out. That is the shipped DIC-1204 regression the market-
 * fields test caught on main.
 *
 * Preservation contract (issue-owner spec, kept fail-closed):
 *   - Same exact card id wins first (bit-for-bit compatible with prior behaviour).
 *   - When the id has been renamed, fall back to a **strict** signature match:
 *     `cardNumber | sourceProduct | rarity` MUST all match, non-empty on both
 *     sides. Ambiguous signatures (multiple previous rows collapsing onto the
 *     same signature — the DIC-1013 case) are dropped rather than picked from,
 *     so no cross-printing or cross-rarity leakage can occur.
 *   - Only carry forward proven market payload; never a saved `sellPrice: null`
 *     over a freshly proven yuyu price. Freshly written non-null fields on the
 *     current card always win.
 *
 * Pure module, no filesystem or network access; both build-database.js and
 * sync-official-catalog-to-database.mjs import from here.
 */

function toStr(value) {
  return value == null ? '' : String(value).trim();
}

function cardSignatureParts(card) {
  return {
    cardNumber: toStr(card?.cardNumber),
    sourceProduct: toStr(card?.sourceProduct || card?.series || card?.expansion),
    rarity: toStr(card?.rarity),
  };
}

/**
 * Strict signature used for signature-based fallback. All three tokens must be
 * present. When any token is missing we return null so the row is not indexed
 * — an under-specified signature must never provide a match.
 */
export function cardSignature(card) {
  const { cardNumber, sourceProduct, rarity } = cardSignatureParts(card);
  if (!cardNumber || !sourceProduct || !rarity) return null;
  return `${cardNumber}|${sourceProduct}|${rarity}`;
}

/**
 * Build the preservation index over the previous database's cards map.
 * Ambiguous signatures (>1 previous row) are marked ambiguous so the lookup
 * refuses to guess between them.
 */
export function buildPreservationIndex(prevCards) {
  const byId = new Map();
  const bySignature = new Map();
  if (!prevCards || typeof prevCards !== 'object') return { byId, bySignature };
  for (const [id, card] of Object.entries(prevCards)) {
    if (!card || typeof card !== 'object') continue;
    byId.set(String(id), card);
    const sig = cardSignature(card);
    if (!sig) continue;
    const existing = bySignature.get(sig);
    if (existing) {
      existing.ambiguous = true;
      existing.cards.push(card);
    } else {
      bySignature.set(sig, { ambiguous: false, cards: [card] });
    }
  }
  return { byId, bySignature };
}

/**
 * Return the previous row whose market fields should be carried onto
 * `currentCard` (identified by `currentId`), or `null` when nothing safely
 * matches. Exact-id wins over signature; ambiguous signatures refuse.
 * Also returns a `matchKind` describing which lookup strategy hit so the
 * caller can gate copy-out of printing-specific arrays (prices[] and the
 * raw yuyu archive) on an exact-id match. When the id has been renamed by
 * canonicalization, the fresh row's canonicalization decisions (e.g. the
 * DIC-1013/1140 signed-printing empty-prices contract) must not be
 * overridden by a bulk copy of the old row's arrays.
 */
export function findPreservedRow(index, currentId, currentCard) {
  const match = findPreservedMatch(index, currentId, currentCard);
  return match ? match.card : null;
}

export function findPreservedMatch(index, currentId, currentCard) {
  if (!index) return null;
  const exact = index.byId?.get(String(currentId));
  if (exact) return { card: exact, matchKind: 'exact-id' };
  const sig = cardSignature(currentCard);
  if (!sig) return null;
  const hit = index.bySignature?.get(sig);
  if (!hit || hit.ambiguous) return null;
  return { card: hit.cards[0] || null, matchKind: 'signature' };
}

/**
 * Extract the market payload we want to carry forward. Only proven values
 * survive; null/undefined/empty structures are dropped so the caller can
 * spread the payload without overwriting freshly proven data with a stale
 * "we didn't have it either" default.
 */
export function preservedMarketPayload(previous) {
  const payload = {};
  if (!previous || typeof previous !== 'object') return payload;
  if (Number.isFinite(previous.sellPrice) && previous.sellPrice > 0) payload.sellPrice = previous.sellPrice;
  if (Array.isArray(previous.prices) && previous.prices.length > 0) payload.prices = previous.prices;
  if (previous.yuyuName) payload.yuyuName = previous.yuyuName;
  if (previous.yuyuImage) payload.yuyuImage = previous.yuyuImage;
  if (previous.timestamp) payload.timestamp = previous.timestamp;
  if (
    previous.priceHistory
    && typeof previous.priceHistory === 'object'
    && Object.keys(previous.priceHistory).length > 0
  ) {
    payload.priceHistory = previous.priceHistory;
  }
  if (previous.priceHistoryMeta && typeof previous.priceHistoryMeta === 'object') {
    payload.priceHistoryMeta = previous.priceHistoryMeta;
  }
  if (
    Array.isArray(previous._rawPricesArchive)
    && previous._rawPricesArchive.length > 0
  ) {
    payload._rawPricesArchive = previous._rawPricesArchive;
  }
  if (previous.ytStats && typeof previous.ytStats === 'object') {
    payload.ytStats = previous.ytStats;
  }
  return payload;
}

// DIC-1140 / DIC-1013 fail-closed: signed-printing rows must ship with an
// empty prices[] — yuyu-tei listings never prove the signed printing's
// identity, so a bulk copy of the previous row's prices[] would revert that
// canonicalization decision. Also handles OSR/OUR overprint variants for
// the same reason: prev's yuyu-derived prices[] frequently came from a
// pre-DIC-1140 build that had not yet split those printings.
const SIGNED_ONLY_RARITIES = new Set(['SEC']);

function isSignedPrinting(card) {
  return SIGNED_ONLY_RARITIES.has(String(card?.rarity || '').trim().toUpperCase());
}

/**
 * Apply preserved market fields onto `currentCard` in-place, never
 * overwriting freshly proven non-empty values. Returns a summary of what
 * was restored so callers can log.
 *
 * `matchKind` gates the printing-specific arrays `prices[]`,
 * `_rawPricesArchive`, plus `yuyuName` / `yuyuImage`. On an exact-id
 * match these are safe: the previous row and the fresh row describe the
 * same printing under the same canonicalization decisions. On a signature
 * fallback we still restore them for ordinary printings (BASE / PARALLEL
 * / RR / SR / U / C …) so the deck / detail UI keeps rendering per-variant
 * sell + buy prices after a canonicalization rename, but we refuse to
 * restore them onto SEC signed printings — the DIC-1013/1140 fail-closed
 * contract requires their prices[] stay empty. `sellPrice`, `priceHistory`,
 * `priceHistoryMeta`, `ytStats` and `timestamp` are per-printing scalars/
 * history and always safe to preserve — those were the fields the shipped
 * regression was wiping.
 */
export function applyPreservedMarketFields(currentCard, previous, { matchKind = 'exact-id' } = {}) {
  const summary = { sellPrice: false, prices: false, priceHistory: false, ytStats: false, yuyu: false };
  if (!currentCard || !previous) return summary;
  const payload = preservedMarketPayload(previous);
  if (Object.keys(payload).length === 0) return summary;
  const preservePrintingArrays = matchKind === 'exact-id' || !isSignedPrinting(currentCard);
  if (payload.sellPrice != null && !(Number.isFinite(currentCard.sellPrice) && currentCard.sellPrice > 0)) {
    currentCard.sellPrice = payload.sellPrice;
    summary.sellPrice = true;
  }
  if (preservePrintingArrays && payload.prices && !(Array.isArray(currentCard.prices) && currentCard.prices.length > 0)) {
    currentCard.prices = payload.prices;
    summary.prices = true;
  }
  if (payload.priceHistory && !(currentCard.priceHistory && Object.keys(currentCard.priceHistory).length > 0)) {
    currentCard.priceHistory = payload.priceHistory;
    summary.priceHistory = true;
  }
  if (payload.priceHistoryMeta && !currentCard.priceHistoryMeta) {
    currentCard.priceHistoryMeta = payload.priceHistoryMeta;
  }
  if (payload.ytStats && !currentCard.ytStats) {
    currentCard.ytStats = payload.ytStats;
    summary.ytStats = true;
  }
  if (preservePrintingArrays && payload._rawPricesArchive && !(Array.isArray(currentCard._rawPricesArchive) && currentCard._rawPricesArchive.length > 0)) {
    currentCard._rawPricesArchive = payload._rawPricesArchive;
  }
  if (preservePrintingArrays && payload.yuyuName && !currentCard.yuyuName) {
    currentCard.yuyuName = payload.yuyuName;
    summary.yuyu = true;
  }
  if (preservePrintingArrays && payload.yuyuImage && !currentCard.yuyuImage) {
    currentCard.yuyuImage = payload.yuyuImage;
    summary.yuyu = true;
  }
  if (payload.timestamp && !currentCard.timestamp) {
    currentCard.timestamp = payload.timestamp;
  }
  return summary;
}
