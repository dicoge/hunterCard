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

export type PriceFreshnessState = 'fresh' | 'last-known' | 'unknown-date' | 'no-quote';

export interface PriceFreshness {
  state: PriceFreshnessState;
  /** The quote time exactly as the source row carries it (never rewritten), or null. */
  quotedAt: string | null;
  /** YYYY-MM-DD taken verbatim from `quotedAt`, or null when it is not an ISO date. */
  quoteDate: string | null;
}

const ISO_DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})/;

export function classifyPriceFreshness(input: {
  price: number | null | undefined;
  quotedAt: string | null | undefined;
  now?: number;
}): PriceFreshness {
  const raw = typeof input.quotedAt === 'string' && input.quotedAt.trim() ? input.quotedAt.trim() : null;
  const dateMatch = raw ? ISO_DATE_PREFIX.exec(raw) : null;
  const quoteDate = dateMatch ? dateMatch[1] : null;
  const price = input.price;
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    return { state: 'no-quote', quotedAt: raw, quoteDate };
  }
  const ms = raw ? Date.parse(raw) : NaN;
  if (!Number.isFinite(ms) || !quoteDate) return { state: 'unknown-date', quotedAt: raw, quoteDate: null };
  const now = Number.isFinite(input.now) ? (input.now as number) : Date.now();
  if (ms - now > PRICE_FRESH_CLOCK_SKEW_MS) return { state: 'unknown-date', quotedAt: raw, quoteDate: null };
  if (now - ms > PRICE_FRESH_MAX_AGE_MS) return { state: 'last-known', quotedAt: raw, quoteDate };
  return { state: 'fresh', quotedAt: raw, quoteDate };
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
