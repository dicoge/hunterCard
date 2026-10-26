/**
 * Freshness / restoration gate for the two push feeders (v41, 2026-10-17).
 *
 * Push delivery has been dormant (the scheduler was paused on 2026-10-07 and the
 * notify secret is not provisioned). The feeders read LOCAL files — trend scores in
 * data/trends/*.json and prices in data/database.json — that may be days or weeks
 * old. Without a gate, the first run after restoration would push those old
 * signals as if they were new: a backlog blast.
 *
 * Rules (the existing criteria are unchanged; this only adds "is it current?"):
 *   • the price database must have been updated within MAX_FEED_AGE_MS, or the run
 *     sends NOTHING (both feeds — prices in a message must be current)
 *   • a trend counts only if ITS lastUpdated is within MAX_FEED_AGE_MS
 *   • optional PUSH_RESTORE_SINCE (ISO time): nothing computed before the restoration
 *     start counts; a malformed value fails closed (the run stops)
 *   • timestamps in the future (beyond a small clock skew) are not "fresh"
 * Recipients, thresholds, per-recipient 24 h cooldown (api/push/notify) and the
 * desired-price arm state (api/push/price-alert-run) are untouched.
 */
export const MAX_FEED_AGE_MS = 36 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

// Existing watchlist trend criteria (scripts/send-push-alerts.js, DIC-390) — unchanged.
export const TREND_THRESHOLD = 0.6;
export const MIN_DATA_POINTS = 3;

export function parseRestoreSince(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const t = Date.parse(String(raw));
  if (!Number.isFinite(t)) throw new Error(`PUSH_RESTORE_SINCE is not a valid time: ${raw}`);
  return t;
}

export function isFresh(iso, now, { maxAgeMs = MAX_FEED_AGE_MS, notBefore = null } = {}) {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return false;
  if (t > now + CLOCK_SKEW_MS) return false;
  if (now - t > maxAgeMs) return false;
  if (notBefore !== null && t < notBefore) return false;
  return true;
}

/** Throws (the run sends nothing) when the price database is not current. */
export function assertFreshDatabase(db, now, notBefore = null) {
  if (!isFresh(db?.lastUpdated, now, { notBefore })) {
    throw new Error(`price data not current (lastUpdated ${db?.lastUpdated ?? 'missing'}) — no push sent`);
  }
}

export function uniqueWatchlistCards(watchlist) {
  const cards = new Set();
  for (const list of Object.values(watchlist || {})) {
    if (!Array.isArray(list)) continue;
    for (const cardNumber of list) {
      if (typeof cardNumber === 'string' && cardNumber.trim()) cards.add(cardNumber.trim());
    }
  }
  return [...cards];
}

function yen(value) {
  return Number.isFinite(value) ? `¥${value.toLocaleString('ja-JP')}` : '價格未定';
}

/**
 * The watchlist trend alert candidates for this run: one per watched card (the
 * notify endpoint fans it out per recipient, with its own cooldown), existing
 * criteria AND a current trend.
 */
export function selectTrendAlerts({ watchlist, findCard, findTrend, now, notBefore = null }) {
  const alerts = [];
  let stale = 0;
  let notEligible = 0;
  for (const cardNumber of uniqueWatchlistCards(watchlist)) {
    const card = findCard(cardNumber);
    const trend = findTrend(card, cardNumber);
    const score = Number(trend?.score ?? trend?.trendScore ?? 0);
    const dataPoints = Number(trend?.dataPoints ?? 0);
    if (!trend || score <= TREND_THRESHOLD || dataPoints < MIN_DATA_POINTS) { notEligible += 1; continue; }
    if (!isFresh(trend.lastUpdated, now, { notBefore })) { stale += 1; continue; }
    const displayName = card?.nameZh || card?.name || trend.nameZh || trend.name || cardNumber;
    // A price preserved from an older scrape is not "現價": shown only when the card's
    // own price timestamp is current, otherwise 價格未定.
    const price = isFresh(card?.timestamp, now, { notBefore }) ? (card?.sellPrice ?? card?.buyPrice) : undefined;
    alerts.push({
      cardNumber,
      title: `入手時機！${displayName} ▲+${Math.round(score * 100)}%`,
      body: `預測價格上漲，現價 ${yen(price)}，建議考慮入手`,
    });
  }
  return { alerts, stale, notEligible };
}

/**
 * The desired-price snapshot to post (v41 per-price freshness). A database updated
 * today can still carry individual prices preserved from weeks ago (on 2026-10-16:
 * 72 priced rows dated 2026-08-25). Only a watched exact printing whose OWN price
 * record is current (and not from before the restoration start) is posted; a stale
 * record contributes nothing, and no other printing of the same card number can stand
 * in for it (exact key only — no sibling price).
 */
export function freshPriceSnapshot({ watched, priceRecords, now, notBefore = null, keyOf }) {
  const index = new Map();
  for (const record of priceRecords) index.set(keyOf(record.cardNumber, record.version), record);
  const prices = [];
  let stale = 0;
  let unpriced = 0;
  for (const { cardNumber, printing } of watched) {
    const record = index.get(keyOf(cardNumber, printing));
    if (!record) { unpriced += 1; continue; }
    // record.timestamp is the exact printing's own price time (adaptCardNumber, v41:
    // oldest contributing row; '' when unknown → not current).
    if (!isFresh(record.timestamp, now, { notBefore })) { stale += 1; continue; }
    prices.push({ cardNumber, printing, price: record.price, currency: record.currency });
  }
  return { prices, stale, unpriced };
}

