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
 * Provenance fields that must agree between the latest snapshot and any past
 * snapshot we're about to compare against (DIC-1140 blocker #2). A comparison
 * across a channelId change, a scraper source swap, or a parser version bump
 * mixes measurements taken by different processes — the resulting delta is
 * not a proven single-channel single-parser observation and must fail closed.
 */
const PROVENANCE_FIELDS = ['channelId', 'source', 'parser'];

/**
 * True when `latest` and `past` share proveable provenance: every provenance
 * field is present (non-null, non-empty) on BOTH sides and the two sides
 * agree. Missing provenance on either side is treated as untrusted rather
 * than "assumed equal" — a legacy snapshot from before the scraper stamped
 * channelId/source/parser is not proof that today's snapshot came from the
 * same pipeline.
 */
export function hasProvenanceMatch(latest, past) {
  if (!latest || !past) return false;
  for (const f of PROVENANCE_FIELDS) {
    const a = latest[f];
    const b = past[f];
    if (a == null || a === '' || b == null || b === '') return false;
    if (a !== b) return false;
  }
  return true;
}

/**
 * Value of `field` from the snapshot nearest N days before `latestDate`, or
 * null if none falls within the required window. `sorted` must be
 * date-ascending. When `strictContiguous` is true (1-day deltas), the gap
 * must be exactly N; otherwise the ±growthWindow(n) tolerance applies.
 *
 * When a `reference` snapshot is supplied (the latest one), candidate past
 * snapshots must share its provenance (channelId + source + parser). This
 * closes the DIC-1140 hole where a cross-channel or cross-parser snapshot
 * in the same history array would compute a numeric 1d delta.
 */
export function snapshotValueNDaysAgo(sorted, latestDate, n, field, strictContiguous = false, reference = null) {
  const window = strictContiguous ? 0 : growthWindow(n);
  let best = null;
  let bestDiff = Infinity;
  for (const s of sorted) {
    if (s.date === latestDate) continue; // never compare latest to itself
    if (s[field] == null) continue;
    if (reference && !hasProvenanceMatch(reference, s)) continue;
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
const DELTA_FIELDS = [
  'subscriberGrowth_1d', 'subscriberGrowth_7d', 'subscriberGrowth_15d', 'subscriberGrowth_30d',
  'viewCount_1d', 'viewCount_7d', 'viewCount_15d', 'viewCount_30d',
];

function snapshotHasProvenance(snapshot) {
  return PROVENANCE_FIELDS.every((f) => {
    const v = snapshot?.[f];
    return v != null && v !== '';
  });
}

function comparableBaseline(sorted, latest, n, field, strictContiguous) {
  const window = strictContiguous ? 0 : growthWindow(n);
  let nearest = null;
  let nearestDiff = Infinity;
  let comparable = null;
  let comparableDiff = Infinity;
  for (const s of sorted) {
    if (s.date === latest.date || s[field] == null) continue;
    const gap = daysBetween(s.date, latest.date);
    if (gap <= 0) continue;
    const diff = Math.abs(gap - n);
    if (diff < nearestDiff) {
      nearestDiff = diff;
      nearest = s;
    }
    if (hasProvenanceMatch(latest, s) && diff < comparableDiff) {
      comparableDiff = diff;
      comparable = s;
    }
  }
  const candidate = comparable || nearest;
  if (!candidate) return { baselineDate: null, comparable: false, reason: 'missing_baseline' };
  const gap = daysBetween(candidate.date, latest.date);
  if (!hasProvenanceMatch(latest, candidate)) {
    return { baselineDate: candidate.date, comparable: false, reason: 'provenance_mismatch', gapDays: gap };
  }
  if (Math.abs(gap - n) > window) {
    return { baselineDate: candidate.date, comparable: false, reason: 'outside_window', gapDays: gap };
  }
  return { baselineDate: candidate.date, comparable: true, reason: 'same_provenance_in_window', gapDays: gap };
}

export function auditRecentSnapshots(history, { limit = 7 } = {}) {
  if (!Array.isArray(history)) return [];
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const subscriberPrecision = detectFieldPrecision(sorted, 'subscriberCount');
  return sorted.slice(-limit).map((snapshot, index, recent) => {
    const prefix = sorted.slice(0, sorted.length - recent.length + index + 1);
    const computed = computeGrowthDeltas(prefix);
    const latestHasProvenance = snapshotHasProvenance(snapshot);
    const decisions = {};
    for (const n of GROWTH_DAYS) {
      const strict = n === 1;
      const sub = comparableBaseline(prefix, snapshot, n, 'subscriberCount', strict);
      const view = comparableBaseline(prefix, snapshot, n, 'totalViewCount', strict);
      const subDelta = computed[`subscriberGrowth_${n}d`];
      const viewDelta = computed[`viewCount_${n}d`];
      decisions[`subscriberGrowth_${n}d`] = {
        ...sub,
        rendered: subDelta != null,
        delta: subDelta ?? null,
        reason: !latestHasProvenance ? 'latest_missing_provenance'
          : sub.comparable && subDelta == null ? 'rounded_or_below_precision'
            : sub.reason,
      };
      decisions[`viewCount_${n}d`] = {
        ...view,
        rendered: viewDelta != null,
        delta: viewDelta ?? null,
        reason: !latestHasProvenance ? 'latest_missing_provenance'
          : view.comparable && viewDelta == null ? 'stale_or_zero_view_snapshot'
            : view.reason,
      };
    }
    const stampedMismatch = DELTA_FIELDS.filter((key) => (snapshot[key] ?? null) !== (computed[key] ?? null));
    return {
      date: snapshot.date ?? null,
      rawTimestamp: snapshot.date ?? null,
      views: snapshot.totalViewCount ?? null,
      subscribers: snapshot.subscriberCount ?? null,
      channelId: snapshot.channelId ?? null,
      source: snapshot.source ?? null,
      parser: snapshot.parser ?? null,
      fetchedAt: snapshot.fetchedAt ?? null,
      valid: latestHasProvenance && (snapshot.subscriberCount != null || snapshot.totalViewCount != null),
      subscriberPrecision,
      stampedDeltaMatchesCurrentAlgorithm: stampedMismatch.length === 0,
      stampedMismatch,
      derivedDeltaDecision: decisions,
    };
  });
}

// Compute subscriber/view growth deltas for the LATEST snapshot in `history`.
// Returns { subscriberGrowth_1d/7d/15d/30d, viewCount_1d/7d/15d/30d } — each
// value is a delta or null. `history` may be unsorted; a fresh copy is sorted.
//
// Latest-snapshot provenance gate (DIC-1140 blocker #2): the newest snapshot
// itself must carry channelId + source + parser. A blank trailing snapshot
// (e.g. news-only stamp when the stats scraper failed) is not proof of a
// successful current-day observation, so every delta stays null. Past
// snapshots then have to match that provenance triple (see snapshotValueNDaysAgo).
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

  // Fail closed on latest-snapshot provenance holes — no channelId / source /
  // parser means we cannot verify that today's row was produced by the same
  // pipeline as any past row, so no comparison is provable.
  const latestHasProvenance = snapshotHasProvenance(latest);
  if (!latestHasProvenance) return out;

  // Source-side precision for the rounded subscriberCount. If the channel's
  // history shows every value divisible by 10k, then a delta of 0 does not
  // prove no growth — the true delta could be anywhere in [-9999, 9999].
  const subscriberPrecision = detectFieldPrecision(sorted, 'subscriberCount');

  for (const n of GROWTH_DAYS) {
    const strict = n === 1;
    if (latest.subscriberCount != null) {
      const past = snapshotValueNDaysAgo(sorted, latestDate, n, 'subscriberCount', strict, latest);
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
      const past = snapshotValueNDaysAgo(sorted, latestDate, n, 'totalViewCount', strict, latest);
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