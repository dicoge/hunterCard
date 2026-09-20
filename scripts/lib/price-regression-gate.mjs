/**
 * price-regression-gate.mjs — DIC-1482 exact-print price-regression contract.
 *
 * Production shipped two complementary failure shapes around the 2026-09-19
 * scrape candidate (bot/scrape/2026-09-19 @ 1a35e14b):
 *
 *   1. hBP09 (244 printing rows) sat at 0 priced unique cardNumbers on main
 *      while the candidate proved 111 of them from exact /hbp09/ yuyu-tei
 *      listings — the recovery direction.
 *   2. The same candidate silently nulled all 29 source-proven hBD24 promo
 *      rows (each carrying an exact /promo-hbd20/ listing for its hPR
 *      printing, last proven 2026-08-25). On a HEALTHY scrape the build only
 *      preserved rows that still had current yuyu payload, so a listing
 *      that rotates out of yuyu-tei's index dropped its last-known-good
 *      payload with no evidence of removal — the 0↔N snapshot oscillation.
 *
 * This module is the single contract both refresh writers
 * (`scripts/build-database.js` and `scripts/sync-official-catalog-to-database.mjs`)
 * and the one-shot recovery (`scripts/recover-dic1482-exact-print-prices.mjs`)
 * share:
 *
 *   - `classifyExactPrintPayload` — strict, per-printing source-provenance
 *     verdict over a row's own priced payload. Proven means the row's OWN
 *     yuyu evidence (top-level yuyuImage or at least one prices[] entry)
 *     resolves to a lawful card.yuyu-tei.jp URL whose product path matches
 *     the row's exact sourceProduct (with only the shipped promo-*→hPR
 *     carve-out). No cross-printing, no cardNumber fallback, and no
 *     aggregation-label (ent07) vouching. Printing identity is never
 *     inferred from the row-level `rarity` (DIC-1013) — a rarity describes
 *     the card number as a whole, so it cannot decide which printing a
 *     price belongs to; only the row's own listing evidence can.
 *   - `evaluatePriceRegressionGate` — the hard decrease gate. ANY decrease in
 *     priced printing rows, priced unique cardNumbers, or price entries
 *     between the previous and next cards map must be covered by a
 *     per-printing rejection whose reason the gate can independently
 *     re-verify (re-running the classifier for provenance reasons, or
 *     checking caller-supplied context sets for ambiguity/prune reasons).
 *     A manifest entry that does not re-verify is itself a violation, so a
 *     writer cannot rubber-stamp a collapse with blanket rejections.
 *   - `buildPriceRejectionManifest` — the machine-readable manifest
 *     (data/price-rejections.json) that makes every allowed decrease
 *     auditable per printing, with the evidence that justified it.
 *
 * Pure module except `writeJsonAtomic` (temp-file + rename in the target
 * directory, so a crash can never leave a torn artifact).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  yuyuPayloadMatchesSource,
  pricesEntryExactPrintMatchesSource,
  pricesEntryMatchesSource,
  yuyuImageProductPath,
} from './preserve-market-fields.js';

export const PRICE_REJECTION_MANIFEST_SCHEMA = 'huntercard.price-rejections/v1';

/**
 * Reasons the gate accepts, split by how they are independently verified.
 * Provenance reasons are re-derived from the PREVIOUS row via
 * `classifyExactPrintPayload` — the manifest claim must equal the
 * classifier's own verdict. Context reasons are verified against caller-
 * supplied sets computed by the same code path that performed the drop.
 */
export const PROVENANCE_REJECTION_REASONS = Object.freeze([
  'cross-product-image',
  'no-yuyu-image-provenance',
  'missing-source-product',
]);
export const CONTEXT_REJECTION_REASONS = Object.freeze([
  'ambiguous-promo-identity',
  'pruned-not-in-official-catalog',
  'printing-removed-from-catalog',
]);
const ALL_REASONS = new Set([...PROVENANCE_REJECTION_REASONS, ...CONTEXT_REJECTION_REASONS]);

export function isPricedRow(card) {
  return Boolean(card) && Number.isFinite(card.sellPrice) && card.sellPrice > 0;
}

function entryCount(card) {
  return Array.isArray(card?.prices) ? card.prices.length : 0;
}

/**
 * Aggregate priced metrics for a cards map — the three quantities the
 * DIC-1482 gate refuses to let silently decrease.
 */
export function priceMetrics(cards) {
  let pricedRows = 0;
  let priceEntries = 0;
  const pricedCardNumbers = new Set();
  for (const card of Object.values(cards || {})) {
    if (!card || typeof card !== 'object') continue;
    priceEntries += entryCount(card);
    if (isPricedRow(card)) {
      pricedRows += 1;
      if (card.cardNumber) pricedCardNumbers.add(card.cardNumber);
    }
  }
  return {
    pricedRows,
    pricedUniqueCardNumbers: pricedCardNumbers.size,
    priceEntries,
  };
}

/**
 * Strict exact-print provenance verdict for a row's own priced payload.
 *
 * Returns `{ proven: true, reason: null }` only when the row's own yuyu
 * evidence proves this exact printing:
 *   - top-level: positive sellPrice AND yuyuImage product path equals the
 *     row's sourceProduct (promo-*→hPR carve-out only), OR
 *   - entry-level: at least one prices[] entry with positive sellPrice whose
 *     imageUrl passes `pricesEntryExactPrintMatchesSource` (the DIC-1229
 *     strict matcher — no reprint origin-prefix carve-out, no ent07
 *     aggregation pass).
 *
 * The row-level `rarity` is NEVER consulted. It describes the card number as
 * a whole — hBP04-005 is SEC on the very row that carries its plain ¥980
 * listing — so refusing a payload because its row is SEC does two wrong
 * things at once: it nulls genuinely-proven PLAIN printings, and it refuses
 * signed rows whose own listing image resolves to the exact product path.
 * Identity comes from the listing label, provenance from that listing's own
 * image (src/utils/printingIdentity.ts, DIC-1013). A signed printing that
 * cannot prove itself still fails closed — just under the reason its own
 * evidence derives, not under an assumption made from its rarity.
 *
 * Everything else fails closed with a machine-readable reason:
 *   - 'unpriced'                     — nothing to prove (not a rejection).
 *   - 'missing-source-product'       — no sourceProduct to prove against.
 *   - 'cross-product-image'          — evidence parses to a lawful yuyu-tei
 *     URL, but for a DIFFERENT product than this exact printing.
 *   - 'no-yuyu-image-provenance'     — no evidence URL parses at all
 *     (missing, noimage placeholder, lookalike host, malformed).
 */
export function classifyExactPrintPayload(card) {
  if (!isPricedRow(card)) return { proven: false, reason: 'unpriced' };
  const sourceProduct = String(card.sourceProduct || card.series || '').trim();
  if (!sourceProduct) return { proven: false, reason: 'missing-source-product' };
  if (yuyuPayloadMatchesSource(card, sourceProduct)) return { proven: true, reason: null };
  const entries = Array.isArray(card.prices) ? card.prices : [];
  for (const entry of entries) {
    if (!entry || !Number.isFinite(entry.sellPrice) || entry.sellPrice <= 0) continue;
    if (pricesEntryExactPrintMatchesSource(entry, sourceProduct)) {
      return { proven: true, reason: null };
    }
  }
  const anyParseable = Boolean(yuyuImageProductPath(card.yuyuImage))
    || entries.some((entry) => Boolean(yuyuImageProductPath(entry?.imageUrl)));
  return {
    proven: false,
    reason: anyParseable ? 'cross-product-image' : 'no-yuyu-image-provenance',
  };
}

/** Evidence block attached to every manifest rejection — auditable per print. */
export function rejectionEvidence(card) {
  return {
    sellPrice: card?.sellPrice ?? null,
    yuyuImage: card?.yuyuImage || '',
    imageProduct: yuyuImageProductPath(card?.yuyuImage) || '',
    entryImageProducts: (Array.isArray(card?.prices) ? card.prices : [])
      .map((entry) => yuyuImageProductPath(entry?.imageUrl) || '')
      .filter(Boolean),
    timestamp: card?.timestamp || '',
  };
}

export function makeRejection(id, card, reason) {
  return {
    id,
    cardNumber: card?.cardNumber || '',
    sourceProduct: card?.sourceProduct || card?.series || '',
    rarity: card?.rarity || '',
    reason,
    evidence: rejectionEvidence(card),
  };
}

/**
 * Multiset diff of prices[] entries between the previous and next row,
 * keyed on the entry's own identity (name, sellPrice, rarity, imageUrl).
 * Returns true only when every dropped entry individually FAILS the row's
 * relaxed provenance matcher — i.e. its own imageUrl proves the entry never
 * belonged to this printing, so dropping it is source-proven per entry.
 * An empty drop set returns false: there is nothing to justify.
 */
function droppedEntriesAllProvenForeign(prev, next) {
  const key = (entry) => JSON.stringify([
    entry?.name ?? '', entry?.sellPrice ?? null, entry?.rarity ?? '', entry?.imageUrl ?? '',
  ]);
  const remaining = new Map();
  for (const entry of Array.isArray(next?.prices) ? next.prices : []) {
    const k = key(entry);
    remaining.set(k, (remaining.get(k) || 0) + 1);
  }
  const dropped = [];
  for (const entry of Array.isArray(prev?.prices) ? prev.prices : []) {
    const k = key(entry);
    const count = remaining.get(k) || 0;
    if (count > 0) remaining.set(k, count - 1);
    else dropped.push(entry);
  }
  if (dropped.length === 0) return false;
  const sourceProduct = String(prev?.sourceProduct || prev?.series || '');
  return dropped.every(
    (entry) => !pricesEntryMatchesSource(entry, sourceProduct, prev?.cardNumber || null),
  );
}

/**
 * The DIC-1482 hard gate. Compares the previous cards map against the next
 * one and returns every uncovered decrease as a violation.
 *
 * A decrease is covered ONLY by a rejection entry whose reason the gate can
 * independently re-verify:
 *   - provenance reasons: `classifyExactPrintPayload(previousRow).reason`
 *     must equal the claimed reason (a proven row can never be "rejected").
 *   - 'ambiguous-promo-identity': id must be in `options.ambiguousIds`.
 *   - 'pruned-not-in-official-catalog' / 'printing-removed-from-catalog':
 *     the id must actually be absent from `nextCards` (plus membership in
 *     `options.prunedIds` for the prune reason when the caller supplies it).
 *
 * Price-entry decreases on a still-priced row are additionally allowed when
 * the row's cardNumber is in `freshlyScrapedCardNumbers` — a fresh scrape of
 * that cardNumber IS the current source listing, so fewer entries is the
 * source's own claim, not a silent drop.
 */
export function evaluatePriceRegressionGate({
  previousCards = {},
  nextCards = {},
  rejections = [],
  freshlyScrapedCardNumbers = new Set(),
  ambiguousIds = new Set(),
  prunedIds = null,
} = {}) {
  const violations = [];
  const rejectionById = new Map();
  for (const rejection of rejections) {
    if (rejection?.id) rejectionById.set(String(rejection.id), rejection);
  }

  const verifyRejection = (id, prevCard, rejection, rowRemoved) => {
    const reason = String(rejection?.reason || '');
    if (!ALL_REASONS.has(reason)) {
      return `rejection reason '${reason}' is not a recognised source-proven rejection`;
    }
    if (PROVENANCE_REJECTION_REASONS.includes(reason)) {
      const verdict = classifyExactPrintPayload(prevCard);
      if (verdict.proven) {
        return `rejection claims '${reason}' but the previous payload is exact-print proven`;
      }
      if (verdict.reason !== reason) {
        return `rejection claims '${reason}' but classifier derives '${verdict.reason}'`;
      }
      return null;
    }
    if (reason === 'ambiguous-promo-identity') {
      return ambiguousIds?.has?.(id) ? null : 'rejection claims promo ambiguity but the id is not in the ambiguous set';
    }
    // prune/removal reasons: the row must actually be gone.
    if (!rowRemoved) {
      return `rejection claims '${reason}' but the printing still exists in the next artifact`;
    }
    if (reason === 'pruned-not-in-official-catalog' && prunedIds && !prunedIds.has(id)) {
      return 'rejection claims prune but the id is not in the pruned set';
    }
    return null;
  };

  for (const [id, prev] of Object.entries(previousCards || {})) {
    if (!prev || typeof prev !== 'object') continue;
    const next = nextCards?.[id];
    const prevPriced = isPricedRow(prev);
    const rowRemoved = next == null;

    if (prevPriced && (rowRemoved || !isPricedRow(next))) {
      const rejection = rejectionById.get(id);
      if (!rejection) {
        violations.push({
          id,
          kind: rowRemoved ? 'priced-row-removed' : 'priced-row-lost',
          detail: `previously priced printing ${id} ${rowRemoved ? 'was removed' : 'lost its price'} with no source-proven rejection`,
        });
      } else {
        const problem = verifyRejection(id, prev, rejection, rowRemoved);
        if (problem) violations.push({ id, kind: 'rejection-not-verifiable', detail: problem });
      }
      continue;
    }

    // Entry-level decrease on a surviving row. Beyond a fresh scrape or an
    // explicit rejection, the gate accepts one data-verifiable case: every
    // DROPPED entry fails the row's own relaxed provenance matcher
    // (`pricesEntryMatchesSource`), i.e. each dropped entry's own imageUrl
    // proves it never belonged to this printing — the preservation filters'
    // legitimate cross-product cleanup.
    if (!rowRemoved && entryCount(next) < entryCount(prev)) {
      if (freshlyScrapedCardNumbers?.has?.(prev.cardNumber)) continue;
      if (droppedEntriesAllProvenForeign(prev, next)) continue;
      const rejection = rejectionById.get(id);
      if (!rejection) {
        violations.push({
          id,
          kind: 'price-entries-decreased',
          detail: `prices[] shrank ${entryCount(prev)}→${entryCount(next)} on ${id} without a fresh scrape of ${prev.cardNumber}, a rejection, or per-entry cross-product proof`,
        });
      } else {
        const problem = verifyRejection(id, prev, rejection, false);
        if (problem) violations.push({ id, kind: 'rejection-not-verifiable', detail: problem });
      }
    }
  }

  const before = priceMetrics(previousCards);
  const after = priceMetrics(nextCards);
  return { ok: violations.length === 0, violations, before, after };
}

/** Render gate violations into a single throwable message. */
export function formatGateViolations(label, violations, limit = 8) {
  const rendered = violations.slice(0, limit).map((v) => `${v.id} [${v.kind}] ${v.detail}`);
  const suffix = violations.length > limit ? `; +${violations.length - limit} more` : '';
  return `[DIC-1482] ${label}: ${violations.length} uncovered priced-payload decrease(s): ${rendered.join('; ')}${suffix}`;
}

/**
 * Machine-readable rejection manifest for the refresh that just ran.
 * Committed as data/price-rejections.json so every allowed decrease ships
 * with its per-printing evidence.
 */
export function buildPriceRejectionManifest({ label, previousCards = {}, nextCards = {}, rejections = [] } = {}) {
  const before = priceMetrics(previousCards);
  const after = priceMetrics(nextCards);
  return {
    schema: PRICE_REJECTION_MANIFEST_SCHEMA,
    label: String(label || 'refresh'),
    generatedAt: new Date().toISOString(),
    before,
    after,
    deltas: {
      pricedRows: after.pricedRows - before.pricedRows,
      pricedUniqueCardNumbers: after.pricedUniqueCardNumbers - before.pricedUniqueCardNumbers,
      priceEntries: after.priceEntries - before.priceEntries,
    },
    rejections,
  };
}

/**
 * Crash-safe JSON write: temp file in the destination directory, fsync-free
 * rename into place. Rename within one directory is atomic on POSIX, so a
 * reader (or an interrupted refresh) can only ever observe the old artifact
 * or the complete new one — never a torn write.
 */
export function writeJsonAtomic(filePath, value, { pretty = true } = {}) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
  const body = pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value);
  fs.writeFileSync(tmpPath, body, 'utf8');
  fs.renameSync(tmpPath, filePath);
}
