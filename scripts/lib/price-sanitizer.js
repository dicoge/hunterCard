// scripts/lib/price-sanitizer.js
//
// Price-history sanitizer shared by build-database.js and
// backfill-price-history.js (DIC-412 / DIC-414 / DIC-419).
//
// A "dirty" spike must be rejected (return null) so the caller skips the
// record entirely — it must NOT be capped to the baseline, otherwise a spike
// date still produces a bogus record. With < 3 prior records the median is
// taken over ALL existing prices; the candidate is never part of its own
// baseline, so a spike can't inflate the reference and slip through.

export function medianOf(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

export function sanitizePriceHistory(existingRecords, candidatePrice) {
  const SPIKE_FACTOR = 5;
  const ABSOLUTE_CAP = 50000;

  if (!Number.isFinite(candidatePrice) || candidatePrice <= 0) return null;

  if (!existingRecords || existingRecords.length === 0) {
    if (candidatePrice > ABSOLUTE_CAP) {
      console.warn(`  [sanitize] Price ${candidatePrice} > absolute cap ${ABSOLUTE_CAP} — no history, capping`);
      return ABSOLUTE_CAP;
    }
    return candidatePrice;
  }

  const oldPrices = existingRecords
    .map(r => r.price)
    .filter(p => Number.isFinite(p) && p > 0);

  if (oldPrices.length === 0) return candidatePrice;

  const sorted = [...oldPrices].sort((a, b) => a - b);

  let referencePrices;
  if (oldPrices.length < 3) {
    referencePrices = sorted;
  } else {
    const halfLen = Math.ceil(sorted.length / 2);
    referencePrices = sorted.slice(sorted.length - halfLen);
  }

  // baseline is derived only from existingRecords, never candidatePrice, so a
  // spike can't inflate its own reference and slip through.
  const baseline = medianOf(referencePrices);

  if (candidatePrice > baseline * SPIKE_FACTOR || candidatePrice > ABSOLUTE_CAP) {
    console.warn(
      `  [sanitize] Spike rejected: candidate=${candidatePrice} ` +
      `(baseline=${baseline}, records=${oldPrices.length}) — dropping record`
    );
    return null;
  }

  return candidatePrice;
}
