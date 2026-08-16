// Pure request validation for the exact-version price-alert endpoints
// (DIC-1023). Kept free of `@vercel/kv` so the security/validation matrix can be
// regression-tested in plain Node without KV credentials.
//
// The interval rule itself is NOT re-implemented here: it is imported from the
// same module the editor uses, so a payload the UI would have rejected cannot be
// smuggled in over HTTP.

import {
  validateInterval, priceAlertKey, MAX_ALERT_PRICE, type PriceAlert,
} from '../../src/utils/priceAlerts';
import { normalizePrinting } from '../../src/utils/printingIdentity';

export const EXPO_TOKEN_RE = /^ExponentPushToken\[[^\]]+\]$|^ExpoPushToken\[[^\]]+\]$/;

const MAX_CARD_NUMBER = 80;
const MAX_PRINTING = 120;
const MAX_TEXT = 160;
/** Cap on how many alerts one device may hold, so a single token cannot grow
 * KV without bound. */
export const MAX_ALERTS_PER_TOKEN = 200;

export function isExpoToken(token: unknown): token is string {
  return typeof token === 'string' && EXPO_TOKEN_RE.test(token);
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

export type ParsedRequest =
  | { ok: true; action: 'list'; token: string }
  | { ok: true; action: 'remove'; token: string; key: string }
  | { ok: true; action: 'upsert'; token: string; key: string; alert: PriceAlert }
  | { ok: false; status: number; error: string };

function fail(error: string, status = 400): ParsedRequest {
  return { ok: false, status, error };
}

/**
 * Validate an /api/push/price-alerts body.
 *
 * An alert is only accepted with a non-empty printing: a card-number-only
 * subscription is a different product (the trend watchlist) and must never
 * reach the exact-version pipeline.
 */
export function parsePriceAlertRequest(body: any): ParsedRequest {
  const token = body?.token;
  if (!isExpoToken(token)) return fail('Invalid Expo push token');

  const action = body?.action;
  if (action !== 'upsert' && action !== 'remove' && action !== 'list') {
    return fail('Invalid action');
  }
  if (action === 'list') return { ok: true, action, token };

  const raw = body?.alert ?? {};
  const cardNumber = text(raw.cardNumber, MAX_CARD_NUMBER);
  if (!cardNumber) return fail('Invalid cardNumber');

  const printingRaw = text(raw.printing, MAX_PRINTING);
  const printing = printingRaw ? normalizePrinting(printingRaw) : '';
  if (!printing) return fail('Invalid printing — an exact version is required');

  const key = priceAlertKey(cardNumber, printing);
  if (action === 'remove') return { ok: true, action, token, key };

  const currency = text(raw.currency, 8);
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return fail('Invalid currency');

  const name = text(raw.name, MAX_TEXT) ?? cardNumber;
  const printingLabel = typeof raw.printingLabel === 'string'
    ? raw.printingLabel.trim().slice(0, MAX_TEXT)
    : '';

  // Reject `"1200"` / `1200.5` / `-1` / `1e9` through the shared rule.
  if (raw.upperPrice !== null && raw.upperPrice !== undefined && typeof raw.upperPrice !== 'number') {
    return fail('Invalid upperPrice');
  }
  if (raw.lowerPrice !== null && raw.lowerPrice !== undefined && typeof raw.lowerPrice !== 'number') {
    return fail('Invalid lowerPrice');
  }
  const interval = validateInterval(
    raw.lowerPrice === null || raw.lowerPrice === undefined ? null : String(raw.lowerPrice),
    raw.upperPrice === null || raw.upperPrice === undefined ? null : String(raw.upperPrice),
  );
  if (!interval.ok) return fail(`Invalid interval: ${interval.code}`);
  if (interval.upperPrice > MAX_ALERT_PRICE) return fail('Invalid interval: TOO_LARGE');

  const now = new Date().toISOString();
  return {
    ok: true,
    action,
    token,
    key,
    alert: {
      cardNumber,
      printing,
      printingLabel,
      name,
      currency,
      lowerPrice: interval.lowerPrice,
      upperPrice: interval.upperPrice,
      createdAt: now,
      updatedAt: now,
    },
  };
}

/** One exact-version reference SELL price supplied by the scheduled feeder. */
export interface PriceSnapshotEntry {
  cardNumber: string;
  printing: string;
  price: number;
  currency: string;
}

/**
 * Validate the price snapshot posted to /api/push/price-alert-run. Malformed
 * entries are dropped rather than rejecting the whole run, but a non-array body
 * is an error: silently treating it as "no prices" would look like a healthy run
 * that notified nobody.
 */
export function parsePriceSnapshot(
  raw: unknown,
): { ok: true; prices: PriceSnapshotEntry[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'prices must be an array' };
  const prices: PriceSnapshotEntry[] = [];
  for (const entry of raw) {
    const cardNumber = text(entry?.cardNumber, MAX_CARD_NUMBER);
    const printingRaw = text(entry?.printing, MAX_PRINTING);
    const currency = text(entry?.currency, 8);
    const price = entry?.price;
    if (!cardNumber || !printingRaw || !currency || !/^[A-Z]{3}$/.test(currency)) continue;
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) continue;
    prices.push({ cardNumber, printing: normalizePrinting(printingRaw), price, currency });
  }
  return { ok: true, prices };
}

/** Index a snapshot for exact (cardNumber, printing) lookup. Same key as the
 * alert, so a PARALLEL price can never answer a BASE alert. */
export function indexPrices(prices: readonly PriceSnapshotEntry[]): Map<string, PriceSnapshotEntry> {
  const map = new Map<string, PriceSnapshotEntry>();
  for (const p of prices) map.set(priceAlertKey(p.cardNumber, p.printing), p);
  return map;
}
