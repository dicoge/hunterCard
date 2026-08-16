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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATABASE_PATH = path.join(path.resolve(__dirname, '..'), 'data', 'database.json');

const RUN_URL = process.env.PUSH_PRICE_ALERT_URL
  || 'https://holocard-hunter.vercel.app/api/push/price-alert-run';
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

function parseAlert(value) {
  const alert = typeof value === 'string' ? JSON.parse(value) : value;
  if (!alert || typeof alert.cardNumber !== 'string' || typeof alert.printing !== 'string') return null;
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
  for (const token of Array.isArray(tokens) ? tokens : []) {
    if (typeof token !== 'string' || !token) continue;
    for (const value of hashValues(await kvGet('hgetall', `${PRICE_ALERT_PREFIX}${token}`))) {
      const alert = parseAlert(value);
      if (!alert) continue;
      watched.set(priceAlertKey(alert.cardNumber, alert.printing), {
        cardNumber: alert.cardNumber.trim(),
        printing: alert.printing.trim(),
      });
    }
  }
  return [...watched.values()];
}

function buildPriceIndex() {
  const raw = JSON.parse(fs.readFileSync(DATABASE_PATH, 'utf8'));
  const { priceRecords } = adaptDatabase(Object.values(raw.cards || {}));
  const index = new Map();
  for (const record of priceRecords) {
    index.set(priceAlertKey(record.cardNumber, record.version), record);
  }
  return index;
}

async function main() {
  if (!NOTIFY_SECRET) {
    throw new Error('PUSH_NOTIFY_SECRET not set — /api/push/price-alert-run would reject the request');
  }
  const watched = await fetchWatchedPrintings();
  if (watched.length === 0) {
    console.log('[price-alerts] No exact-version price alerts registered');
    return;
  }

  const index = buildPriceIndex();
  const prices = [];
  for (const { cardNumber, printing } of watched) {
    const record = index.get(priceAlertKey(cardNumber, printing));
    // An unpriced / ambiguous printing contributes nothing rather than
    // borrowing a sibling version's price.
    if (!record) continue;
    prices.push({ cardNumber, printing, price: record.price, currency: record.currency });
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
