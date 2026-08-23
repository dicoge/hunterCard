/**
 * Shared YouTube-stats growth math for the hololive scrapers/builder.
 *
 * A snapshot's "1d/7d/15d/30d" delta = latest value − the value from the
 * snapshot nearest N days ago. Cron can miss days, so we pick the closest
 * snapshot to N days and reject it (→ null) if its gap is outside N ± window.
 * Otherwise growth_1d could silently be computed from a 10-day-old snapshot and
 * be badly misleading (DIC-250). null (never 0) means "no comparable snapshot",
 * so the UI can distinguish "no data" from "genuinely flat".
 *
 * DIC-1139 tightens the "genuinely flat" claim: a delta of 0 must be PROVEN,
 * not merely observed.
 *   - 1-day deltas require an EXACTLY adjacent snapshot (gap === 1). A 2-day
 *     jump matching the ±1 window is not contiguous enough to render a 1d
 *     change.
 *   - `totalViewCount` is monotonically increasing at YouTube scale; two
 *     consecutive snapshots with the SAME totalViewCount imply the source
 *     snapshot didn't tick (stale scrape / cached SSR) — that is not proof
 *     of zero viewing, so the delta stays null.
 *   - `subscriberCount` is rounded at source (typically to the nearest
 *     10,000 for the popular holomen channels). A delta of 0 or one below
 *     the detected rounding step doesn't prove no growth — it only proves
 *     the true growth was below the source's precision. Deltas smaller than
 *     the detected precision fold to null.
 *
 * Keep this in ONE place: scrape-yt-stats.js stamps the deltas into each daily
 * snapshot and build-database.js reads them back, so both MUST agree on the
 * algorithm.
 */

export function daysBetween(earlierYmd, laterYmd) {
  const [y1, m1, d1] = earlierYmd.split('-').map(Number);
  const [y2, m2, d2] = laterYmd.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

export function growthWindow(n) {
  return Math.max(1, Math.round(n * 0.25));
}

/**
 * Detect the source-side rounding step for a field across a channel's
 * history. Returns the largest power-of-10 that divides EVERY non-zero
 * observation of the field (capped at 10_000 — YouTube never publishes
 * finer than integer counts, but rounds public displays to buckets). A
 * step of 1 means the source shows exact integers.
 *
 * subscriberCount rounds at source; totalViewCount is exact, so this
 * function is only called for subscriberCount today.
 */
export function detectFieldPrecision(sorted, field) {
  const steps = [10000, 1000, 100, 10, 1];
  for (const step of steps) {
    let ok = true;
    for (const s of sorted) {
      const v = s[field];
      if (v == null || v === 0) continue;
      if (v % step !== 0) { ok = false; break; }
    }
    if (ok) return step;
  }
  return 1;
}

/**
 * Value of `field` from the snapshot nearest N days before `latestDate`, or
 * null if none falls within the required window. `sorted` must be
 * date-ascending. When `strictContiguous` is true (1-day deltas), the gap
 * must be exactly N; otherwise the ±growthWindow(n) tolerance applies.
 */
export function snapshotValueNDaysAgo(sorted, latestDate, n, field, strictContiguous = false) {
  const window = strictContiguous ? 0 : growthWindow(n);
  let best = null;
  let bestDiff = Infinity;
  for (const s of sorted) {
    if (s.date === latestDate) continue; // never compare latest to itself
    if (s[field] == null) continue;
    const gap = daysBetween(s.date, latestDate);
    if (gap <= 0) continue;
    const diff = Math.abs(gap - n);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = s;
    }
  }
  if (!best) return null;
  const gap = daysBetween(best.date, latestDate);
  if (Math.abs(gap - n) > window) return null; // nearest snapshot too far from N days ago
  return best[field];
}

const GROWTH_DAYS = [1, 7, 15, 30];

// Compute subscriber/view growth deltas for the LATEST snapshot in `history`.
// Returns { subscriberGrowth_1d/7d/15d/30d, viewCount_1d/7d/15d/30d } — each
// value is a delta or null. `history` may be unsorted; a fresh copy is sorted.
export function computeGrowthDeltas(history) {
  const out = {};
  for (const n of GROWTH_DAYS) {
    out[`subscriberGrowth_${n}d`] = null;
    out[`viewCount_${n}d`] = null;
  }
  if (!Array.isArray(history) || history.length === 0) return out;
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const latest = sorted[sorted.length - 1];
  const latestDate = latest.date;

  // Source-side precision for the rounded subscriberCount. If the channel's
  // history shows every value divisible by 10k, then a delta of 0 does not
  // prove no growth — the true delta could be anywhere in [-9999, 9999].
  const subscriberPrecision = detectFieldPrecision(sorted, 'subscriberCount');

  for (const n of GROWTH_DAYS) {
    const strict = n === 1;
    if (latest.subscriberCount != null) {
      const past = snapshotValueNDaysAgo(sorted, latestDate, n, 'subscriberCount', strict);
      if (past != null) {
        const delta = latest.subscriberCount - past;
        // Reject deltas smaller than the source's rounding step — those are
        // indistinguishable from noise inside a single bucket, not a proven
        // "no growth" reading.
        if (Math.abs(delta) >= subscriberPrecision) {
          out[`subscriberGrowth_${n}d`] = delta;
        }
      }
    }
    if (latest.totalViewCount != null) {
      const past = snapshotValueNDaysAgo(sorted, latestDate, n, 'totalViewCount', strict);
      if (past != null && past !== latest.totalViewCount) {
        // Identical consecutive totalViewCount ⇒ source snapshot didn't tick
        // (stale scrape) — a channel of holomen scale never truly has zero
        // views over a full day, so the reading is not proven.
        out[`viewCount_${n}d`] = latest.totalViewCount - past;
      }
    }
  }
  return out;
}
