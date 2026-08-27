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
 * Origin-product prefix of a cardNumber. `hBP04-028` → `hBP04`,
 * `hEB01-001` → `hEB01`, `hPR-014` → `hPR`. Returns '' when the input is
 * unparsable so the caller treats it as "no prefix match" (never wildcard).
 */
export function cardNumberOriginPrefix(cardNumber) {
  const m = String(cardNumber || '').match(/^([A-Za-z]+[0-9A-Za-z]*)-\d+/);
  return m ? m[1] : '';
}

/**
 * A "reprint row" is a printing whose sourceProduct differs from the origin-
 * product prefix of its cardNumber — hBP04-028 shipped in hBP08 as a reprint,
 * hBP02-026 shipped in hCO01 as a reprint, etc. Reprint rows are the exact
 * pool where cross-product price-history contamination surfaced (DIC-1219):
 * DIC-1204's seed script wrote origin-product records into these rows'
 * canonical-ID history files and every subsequent build cycle carried them
 * forward. Unstamped legacy records on a reprint row cannot be proven to
 * belong to the reprint printing, so we treat them as unverified.
 */
export function isReprintRow(card) {
  const prefix = cardNumberOriginPrefix(card?.cardNumber);
  const source = String(card?.sourceProduct || card?.series || '');
  if (!prefix || !source) return false;
  return prefix !== source;
}

/**
 * DIC-1219 provenance stamp for a durable price-history record. Every record
 * written from `scripts/build-database.js` Step 5 carries this stamp so a
 * later Step 6 read (or a preservation copy-over) can prove the record was
 * produced under this exact printing's yuyu listing rather than a cross-
 * product base's history that a seed script accidentally wrote onto this
 * canonical-ID file. Existing records without the stamp are treated as
 * unverified: origin-product rows grandfather them in (their durable files
 * are structurally clean), reprint rows drop them (their unstamped payload
 * was seeded from cross-product base data).
 */
export function stampHistoryRecord(record, card) {
  const sp = toStr(card?.sourceProduct || card?.series);
  if (!record || !sp) return record;
  return { ...record, sourceProduct: sp };
}

/**
 * Provenance filter for durable price-history records. Returns the records
 * safe to merge onto `card` under the DIC-1219 fail-closed contract:
 *   - Stamped records survive only when `sourceProduct` equals the card's
 *     current sourceProduct.
 *   - Unstamped legacy records survive only on origin-product rows (where
 *     the row's own sourceProduct equals the cardNumber's origin prefix);
 *     reprint rows drop them because DIC-1204's seed script wrote origin-
 *     product base records onto reprint canonical-ID files.
 * The rule is deliberately structural — it never inspects prices or dates —
 * so a mutation that flattens either arm (e.g. "always keep unstamped
 * records" OR "always keep stamped records") is immediately caught by the
 * DIC-1219 mutation test.
 */
export function filterProvenanceMatchedRecords(records, card) {
  if (!Array.isArray(records)) return [];
  const currentSource = toStr(card?.sourceProduct || card?.series);
  const cardIsReprint = isReprintRow(card);
  return records.filter((record) => {
    if (!record || typeof record !== 'object') return false;
    const stamp = toStr(record.sourceProduct);
    if (stamp) return stamp === currentSource;
    return !cardIsReprint;
  });
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
/**
 * Canonicalize a card id into the sanitized filename that
 * `src/services/priceHistory.ts::rebuildIndex` (and `scripts/build-database.js`
 * Step 5/6) uses to name the on-disk history file. Kept in lockstep with the
 * regex in `scripts/build-database.js`.
 */
export function historyFilenameFor(cardId) {
  return `${String(cardId ?? '').replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
}

/**
 * Seed the canonical-ID `data/price-history/<id>.json` file with each card's
 * in-memory `priceHistory` so `scripts/build-database.js` Step 5 (append
 * today's record) and Step 6 (unconditionally re-read + overwrite
 * `card.priceHistory`) do not collapse a preserved multi-day history to
 * today's single record when the id was renamed by DIC-1084 canonicalization
 * and no canonical-ID history file exists yet. The reviewer measured 1,566
 * shipped rows that had preserved multi-day history but no canonical-ID
 * file — every one of them would have lost that history on the next daily
 * rebuild without this seed.
 *
 * Idempotent and additive:
 *   - Existing `records[]` entries are preserved verbatim.
 *   - A preserved `(date, price)` pair is only appended when that date is
 *     not already in the file — no cross-printing or stale-price leakage.
 *   - Non-positive / non-finite prices are dropped (fail-closed).
 *   - Rows with fewer than 2 preserved history days do not seed a file
 *     (Step 5 covers the today-only case).
 *
 * Filesystem is injected so the same function is used by build-database.js
 * (real fs), the one-shot repair (real fs) and the mutation test (tmpdir).
 */
export function seedCanonicalHistoryFiles({
  cards,
  historyDir,
  fsAdapter,
  now = new Date(),
} = {}) {
  if (!cards || typeof cards !== 'object') return { seededFiles: 0, addedRecords: 0 };
  if (!historyDir || !fsAdapter) {
    throw new Error('seedCanonicalHistoryFiles requires historyDir and fsAdapter');
  }
  const path = fsAdapter.path;
  const fs = fsAdapter.fs;
  fs.mkdirSync(historyDir, { recursive: true });
  const nowIso = now.toISOString();
  let seededFiles = 0;
  let addedRecords = 0;
  for (const [cardId, card] of Object.entries(cards)) {
    const ph = card?.priceHistory;
    if (!ph || typeof ph !== 'object') continue;
    // DIC-1219 fail-closed: only origin-product rows may re-seed their durable
    // history file from in-memory priceHistory. Reprint rows land here with an
    // in-memory priceHistory carried over from a previous build cycle whose
    // sourceProduct we cannot prove (the map has no per-date stamp), so
    // seeding would re-write the same cross-product records DIC-1219 just
    // migrated out. Fresh Step 5 records still land on reprint rows through
    // the stamped write below — the reprint history rebuilds legitimately.
    if (isReprintRow(card)) continue;
    const preservedDates = Object.entries(ph).filter(
      ([, price]) => Number.isFinite(price) && price > 0,
    );
    if (preservedDates.length < 2) continue;
    const filePath = path.join(historyDir, historyFilenameFor(cardId));
    let existing = null;
    try {
      existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      existing = null;
    }
    const records = Array.isArray(existing?.records) ? [...existing.records] : [];
    const existingDates = new Set(records.map((r) => r.date));
    let added = 0;
    for (const [date, price] of preservedDates) {
      if (existingDates.has(date)) continue;
      records.push(stampHistoryRecord({
        date,
        price,
        source: 'yuyu-tei',
        currency: 'JPY',
        cardId,
      }, card));
      existingDates.add(date);
      added += 1;
    }
    if (added === 0) continue;
    records.sort((a, b) => a.date.localeCompare(b.date));
    const doc = {
      cardId,
      cardNumber: existing?.cardNumber || card.cardNumber || '',
      name: existing?.name || card.name || '',
      nameZh: existing?.nameZh || card.nameZh || '',
      records,
      lastUpdated: nowIso,
    };
    fs.writeFileSync(filePath, JSON.stringify(doc, null, 2));
    seededFiles += 1;
    addedRecords += added;
  }
  return { seededFiles, addedRecords };
}

export function applyPreservedMarketFields(currentCard, previous, { matchKind = 'exact-id', preserveYuyuPayload = true } = {}) {
  const summary = { sellPrice: false, prices: false, priceHistory: false, ytStats: false, yuyu: false };
  if (!currentCard || !previous) return summary;
  const payload = preservedMarketPayload(previous);
  if (Object.keys(payload).length === 0) return summary;
  const preservePrintingArrays = preserveYuyuPayload && (matchKind === 'exact-id' || !isSignedPrinting(currentCard));
  if (preserveYuyuPayload && payload.sellPrice != null && !(Number.isFinite(currentCard.sellPrice) && currentCard.sellPrice > 0)) {
    currentCard.sellPrice = payload.sellPrice;
    summary.sellPrice = true;
  }
  if (preservePrintingArrays && payload.prices && !(Array.isArray(currentCard.prices) && currentCard.prices.length > 0)) {
    currentCard.prices = payload.prices;
    summary.prices = true;
  }
  // DIC-1219: priceHistory carries no per-date stamp so we cannot filter it
  // per record here. Instead refuse the copy-out whenever we cannot prove the
  // previous row's provenance equals the current row's — a reprint row must
  // never inherit an origin row's history, and vice versa. Exact-id match is
  // provenance-safe by construction (id encodes sourceProduct); signature
  // match requires `previous.sourceProduct` to equal current.
  const prevSource = String(previous?.sourceProduct || previous?.series || '');
  const currentSource = String(currentCard?.sourceProduct || currentCard?.series || '');
  const historyProvenanceMatches = matchKind === 'exact-id' || (prevSource !== '' && prevSource === currentSource);
  if (preserveYuyuPayload && historyProvenanceMatches && payload.priceHistory && !(currentCard.priceHistory && Object.keys(currentCard.priceHistory).length > 0)) {
    currentCard.priceHistory = payload.priceHistory;
    summary.priceHistory = true;
  }
  if (preserveYuyuPayload && historyProvenanceMatches && payload.priceHistoryMeta && !currentCard.priceHistoryMeta) {
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
  if (preserveYuyuPayload && payload.timestamp && !currentCard.timestamp) {
    currentCard.timestamp = payload.timestamp;
  }
  return summary;
}
