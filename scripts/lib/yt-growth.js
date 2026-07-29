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

// Value of `field` from the snapshot nearest N days before latestDate, or null
// if none falls within N ± growthWindow(n). `sorted` must be date-ascending.
export function snapshotValueNDaysAgo(sorted, latestDate, n, field) {
  const window = growthWindow(n);
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

  for (const n of GROWTH_DAYS) {
    if (latest.subscriberCount != null) {
      const past = snapshotValueNDaysAgo(sorted, latestDate, n, 'subscriberCount');
      if (past != null) out[`subscriberGrowth_${n}d`] = latest.subscriberCount - past;
    }
    if (latest.totalViewCount != null) {
      const past = snapshotValueNDaysAgo(sorted, latestDate, n, 'totalViewCount');
      if (past != null) out[`viewCount_${n}d`] = latest.totalViewCount - past;
    }
  }
  return out;
}
