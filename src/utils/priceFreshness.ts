/**
 * Last-known price presentation (2026-11-07 user requirement: "no new price → keep the
 * last known price of the SAME exact printing, keep its original source and time, and
 * say clearly that it is an old price; never fake a fresh quote or a today history").
 *
 * The generator already keeps a printing's last SOURCE-PROVEN payload when the source
 * stops listing it (DIC-1482 / DIC-1321 preservation in scripts/build-database.js), and
 * keeps that payload's own `timestamp` verbatim. Nothing here changes a price: this pure
 * module only classifies how a price that IS shown must be labelled, from that printing's
 * OWN quote time.
 *
 *   - 'fresh'        quote time within the existing DIC-1229 freshness window (7 days,
 *                    `DIC1229_MAX_TIMESTAMP_AGE_MS` in scripts/lib/preserve-market-fields.js
 *                    — the same window the build uses to decide whether a row's price
 *                    history is current; scripts/test-last-known-price.mjs pins the two
 *                    constants together) and not in the future beyond the same 5-minute skew.
 *   - 'last-known'   a proven price whose own quote is older than that window: shown as
 *                    最近已知售價 with its ORIGINAL date, never as today's price.
 *   - 'unknown-date' a price whose quote time is missing / unparseable / in the future:
 *                    the date stays unknown (never filled with the catalog or app time).
 *   - 'no-quote'     no positive price — nothing is shown as a price.
 *
 * The catalog-wide `lastUpdated` / `dataObservedAt` is publish metadata, not a quote time,
 * and is deliberately NOT an input: a refreshed catalog does not make an old quote fresh.
 */

/** Mirrors DIC1229_MAX_TIMESTAMP_AGE_MS (scripts/lib/preserve-market-fields.js). */
export const PRICE_FRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Mirrors DIC1229_MAX_TIMESTAMP_CLOCK_SKEW_MS (scripts/lib/preserve-market-fields.js). */
export const PRICE_FRESH_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Mirrors MAX_SOURCE_AGE_HOURS (scripts/merge-buy-prices.js): the buy-quote age window. */
export const BUY_QUOTE_FRESH_MAX_AGE_MS = 18 * 60 * 60 * 1000;

export type PriceFreshnessState = 'fresh' | 'last-known' | 'unknown-date' | 'no-quote';

export interface PriceFreshness {
  state: PriceFreshnessState;
  /** The quote time exactly as the source row carries it (never rewritten), or null. */
  quotedAt: string | null;
  /** YYYY-MM-DD taken verbatim from `quotedAt`, or null when it is not an ISO date. */
  quoteDate: string | null;
  /**
   * True when the WRITER explicitly marked this quote as retained: the latest run produced
   * no new quote for this exact printing, so the shown value is the previous quote with its
   * original source/time (`sellQuoteRetained` / `buyPriceRetained`). Independent of age —
   * a retained quote from yesterday is never 'fresh'.
   */
  retained: boolean;
}

const ISO_DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})/;

/**
 * Age is only a classification aid: `maxAgeMs` (default the DIC-1229 7-day window, 18h for
 * buy quotes) can make a quote 'last-known', never make a retained or missing quote current.
 * `retained` comes only from explicit writer metadata, never from catalog time / file mtime.
 */
export function classifyPriceFreshness(input: {
  price: number | null | undefined;
  quotedAt: string | null | undefined;
  now?: number;
  retained?: boolean;
  maxAgeMs?: number;
}): PriceFreshness {
  const raw = typeof input.quotedAt === 'string' && input.quotedAt.trim() ? input.quotedAt.trim() : null;
  const dateMatch = raw ? ISO_DATE_PREFIX.exec(raw) : null;
  const quoteDate = dateMatch ? dateMatch[1] : null;
  const retained = input.retained === true;
  const price = input.price;
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    return { state: 'no-quote', quotedAt: raw, quoteDate, retained: false };
  }
  const ms = raw ? Date.parse(raw) : NaN;
  if (!Number.isFinite(ms) || !quoteDate) return { state: 'unknown-date', quotedAt: raw, quoteDate: null, retained };
  const now = Number.isFinite(input.now) ? (input.now as number) : Date.now();
  if (ms - now > PRICE_FRESH_CLOCK_SKEW_MS) return { state: 'unknown-date', quotedAt: raw, quoteDate: null, retained };
  const maxAge = typeof input.maxAgeMs === 'number' && input.maxAgeMs > 0 ? input.maxAgeMs : PRICE_FRESH_MAX_AGE_MS;
  if (retained || now - ms > maxAge) return { state: 'last-known', quotedAt: raw, quoteDate, retained };
  return { state: 'fresh', quotedAt: raw, quoteDate, retained: false };
}

/**
 * i18n key for the full quote line (detail / buy line). Pure: returns key names only.
 *   retained + date   → price_quote_retained      (no new quote this run · original time)
 *   retained, no date → price_quote_retained_unknown_date
 *   old, not retained → price_quote_last_known      (buy: price_buy_quote_last_known)
 *   no date, not retained → price_quote_unknown_date (buy: price_buy_quote_unknown_date)
 * Fresh / retained wording is price-type neutral (報價); the two states whose wording names the
 * price type (售價 vs 收購價) have a buy-specific key, so a buy quote is never called a sell price.
 */
export function quoteLineKey(f: PriceFreshness, kind: 'sell' | 'buy' = 'sell'): { key: string; stale: boolean } | null {
  if (f.state === 'fresh') return { key: 'price_quote_fresh', stale: false };
  if (f.state === 'last-known') {
    if (f.retained) return { key: 'price_quote_retained', stale: true };
    return { key: kind === 'buy' ? 'price_buy_quote_last_known' : 'price_quote_last_known', stale: true };
  }
  if (f.state === 'unknown-date') {
    if (f.retained) return { key: 'price_quote_retained_unknown_date', stale: true };
    return { key: kind === 'buy' ? 'price_buy_quote_unknown_date' : 'price_quote_unknown_date', stale: true };
  }
  return null;
}

/** i18n key for the compact marker next to a price (tile / list row / chooser). */
export function quoteTagKey(f: PriceFreshness): string | null {
  if (f.state === 'last-known') return f.retained ? 'price_quote_retained_tag' : 'price_quote_old_tag';
  if (f.state === 'unknown-date') return f.retained ? 'price_quote_retained_tag' : 'price_quote_unknown_short';
  return null;
}

/**
 * Exact-printing quote times for one card number: printing token → that printing's own
 * quote time, taken from the PriceRecords `adaptCardNumber` already derives (the OLDEST
 * timestamp of the rows listing that printing at that price; '' = unknown). Printings
 * with no single price get no entry (unknown) — a sibling's time is never borrowed.
 */
export function printingQuoteTimes(records: ReadonlyArray<{ version: string; timestamp: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of records) {
    if (r && typeof r.version === 'string' && typeof r.timestamp === 'string' && r.timestamp) out[r.version] = r.timestamp;
  }
  return out;
}
