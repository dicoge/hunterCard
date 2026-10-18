#!/usr/bin/env node
/**
 * Exact-version desired-price alert feeder (DIC-1023).
 *
 * This script is ONLY a price feed. It reads which exact printings currently
 * have alerts, resolves each one's reference SELL price from the scraped
 * database through the SAME adapter the app uses, and posts that snapshot to
 * /api/push/price-alert-run. Deciding who to notify — and the arm state that
 * stops an unchanged price from notifying again — lives server-side.
 *
 * The store's buy (acquisition) price never enters the snapshot: adaptDatabase
 * only emits player-facing sell prices (DIC-1013 §5).
 *
 * Run: node --experimental-strip-types --import ./scripts/register-ts.mjs \
 *        scripts/send-price-alerts.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { adaptDatabase } from '../src/utils/deckCardData.ts';
import { priceAlertKey } from '../src/utils/priceAlerts.ts';
import { assertFreshDatabase, freshPriceSnapshot, parseRestoreSince } from './lib/push-freshness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Overridable only so the offline regression can feed controlled data (test:push-freshness).
const DATABASE_PATH = process.env.PUSH_DATABASE_PATH || path.join(path.resolve(__dirname, '..'), 'data', 'database.json');

// Canonical production price-alert-run endpoint (DIC-1245). Overridable via env
// for preview / staging cron; the default must never be the old vercel.app
// alias, which no longer hosts /api/push/price-alert-run.
const RUN_URL = process.env.PUSH_PRICE_ALERT_URL
  || 'https://holohunter.dicoge.com/api/push/price-alert-run';
const NOTIFY_SECRET = process.env.PUSH_NOTIFY_SECRET;
const KV_REST_API_URL = process.env.KV_REST_API_URL;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN;

const PRICE_ALERT_TOKENS_KEY = 'push:price-alert-tokens';
const PRICE_ALERT_PREFIX = 'push:price-alerts:';

async function kvGet(command, key) {
  const res = await fetch(`${KV_REST_API_URL}/${command}/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_REST_API_TOKEN}` },
  });
  if (!res.ok) throw new Error(`KV ${command} ${res.status}: ${await res.text()}`);
  const { result } = await res.json();
  return result;
}

// One stored alert record → { cardNumber, printing } or null. A malformed record (bad
// JSON, wrong shape) is skipped on its own: it must not stop every other device's valid
// alerts from being fed. KV / POST failures are NOT caught here and still fail the run.
function parseAlert(value) {
  let alert = value;
  if (typeof value === 'string') {
    try { alert = JSON.parse(value); } catch { return null; }
  }
  if (!alert || typeof alert !== 'object' || typeof alert.cardNumber !== 'string' || typeof alert.printing !== 'string') return null;
  if (!alert.cardNumber.trim() || !alert.printing.trim()) return null;
  return alert;
}

// Upstash returns HGETALL as a flat [field, value, field, value, …] array.
function hashValues(result) {
  if (Array.isArray(result)) {
    const out = [];
    for (let i = 1; i < result.length; i += 2) out.push(result[i]);
    return out;
  }
  return result && typeof result === 'object' ? Object.values(result) : [];
}

/** The distinct exact printings any device is currently watching. */
async function fetchWatchedPrintings() {
  if (!KV_REST_API_URL || !KV_REST_API_TOKEN) {
    throw new Error('KV_REST_API_URL / KV_REST_API_TOKEN not configured');
  }
  const tokens = await kvGet('smembers', PRICE_ALERT_TOKENS_KEY);
  const watched = new Map();
  let skipped = 0;
  for (const token of Array.isArray(tokens) ? tokens : []) {
    if (typeof token !== 'string' || !token) continue;
    for (const value of hashValues(await kvGet('hgetall', `${PRICE_ALERT_PREFIX}${token}`))) {
      const alert = parseAlert(value);
      if (!alert) { skipped += 1; continue; }
      watched.set(priceAlertKey(alert.cardNumber, alert.printing), {
        cardNumber: alert.cardNumber.trim(),
        printing: alert.printing.trim(),
      });
    }
  }
  if (skipped > 0) console.warn(`[price-alerts] skipped ${skipped} malformed alert record(s)`);
  return [...watched.values()];
}

// v41: a desired-price alert must judge a CURRENT price — a stale database (or one
// from before PUSH_RESTORE_SINCE) sends nothing, and inside a current database only
// price records whose own exact-printing time is current count
// (scripts/lib/push-freshness.mjs, adaptCardNumber price provenance).
function loadPriceRecords(now, notBefore) {
  const raw = JSON.parse(fs.readFileSync(DATABASE_PATH, 'utf8'));
  assertFreshDatabase(raw, now, notBefore);
  return adaptDatabase(Object.values(raw.cards || {})).priceRecords;
}

async function main() {
  if (!NOTIFY_SECRET) {
    throw new Error('PUSH_NOTIFY_SECRET not set — /api/push/price-alert-run would reject the request');
  }
  // Freshness first: nothing is read from KV for a run that could not send anyway.
  const now = Date.now();
  const notBefore = parseRestoreSince(process.env.PUSH_RESTORE_SINCE);
  const priceRecords = loadPriceRecords(now, notBefore);
  const watched = await fetchWatchedPrintings();
  if (watched.length === 0) {
    console.log('[price-alerts] No exact-version price alerts registered');
    return;
  }

  // An unpriced / ambiguous / stale printing contributes nothing rather than
  // borrowing a sibling version's price.
  const { prices, stale } = freshPriceSnapshot({ watched, priceRecords, now, notBefore, keyOf: priceAlertKey });
  if (prices.length === 0) {
    console.log(`[price-alerts] ${watched.length} watched printings, none with a current price (${stale} stale) — nothing posted`);
    return;
  }

  const res = await fetch(RUN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': NOTIFY_SECRET },
    body: JSON.stringify({ prices }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`price-alert-run ${res.status}: ${text}`);

  console.log(`[price-alerts] ${watched.length} watched printings, ${prices.length} priced: ${text}`);
}

main().catch((err) => {
  console.error(`[price-alerts] ${err.message}`);
  process.exit(1);
});
