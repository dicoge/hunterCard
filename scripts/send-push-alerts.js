#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertFreshDatabase, parseRestoreSince, selectTrendAlerts } from './lib/push-freshness.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_DIR, 'data');
// Overridable only so the offline regression can feed controlled data (test:push-freshness).
const DATABASE_PATH = process.env.PUSH_DATABASE_PATH || path.join(DATA_DIR, 'database.json');
const TRENDS_DIR = process.env.PUSH_TRENDS_DIR || path.join(DATA_DIR, 'trends');
// Canonical production notify endpoint (DIC-1245). Overridable via env for
// preview / staging cron; the default must never be the old vercel.app alias,
// which no longer hosts /api/push/notify.
const NOTIFY_URL = process.env.PUSH_NOTIFY_URL || process.env.VERCEL_PUSH_NOTIFY_URL || 'https://holohunter.dicoge.com/api/push/notify';
const NOTIFY_SECRET = process.env.PUSH_NOTIFY_SECRET;
const KV_REST_API_URL = process.env.KV_REST_API_URL;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN;
// Watchlist is stored as per-token Redis sets (`push:watchlist:<token>`) plus a
// registry set of every token that has a watchlist (DIC-390 CR blocker 1).
const WATCHLIST_TOKENS_KEY = 'push:watchlist-tokens';
const WATCHLIST_PREFIX = 'push:watchlist:';

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function kvSmembers(key) {
  const res = await fetch(`${KV_REST_API_URL}/smembers/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_REST_API_TOKEN}` },
  });
  if (!res.ok) throw new Error(`KV smembers ${res.status}: ${await res.text()}`);
  const { result } = await res.json();
  return Array.isArray(result) ? result : [];
}

// Read the push watchlist from Vercel KV (Upstash REST API). The API stores each
// token's cards in its own Redis set (`push:watchlist:<token>`) and tracks every
// active token in a registry set, so enumerate the registry then read each set
// (DIC-390 CR blocker 1 — the old `hgetall push:watchlist` always came back empty).
async function fetchWatchlist() {
  if (!KV_REST_API_URL || !KV_REST_API_TOKEN) {
    throw new Error('KV_REST_API_URL / KV_REST_API_TOKEN not configured');
  }
  const tokens = await kvSmembers(WATCHLIST_TOKENS_KEY);
  const watchlist = {};
  for (const token of tokens) {
    if (typeof token !== 'string' || !token) continue;
    const cards = await kvSmembers(`${WATCHLIST_PREFIX}${token}`);
    if (cards.length > 0) watchlist[token] = cards;
  }
  return watchlist;
}


function findCard(db, cardNumber) {
  const cards = db.cards || {};
  if (cards[cardNumber]) return cards[cardNumber];
  return Object.values(cards).find((card) => card.cardNumber === cardNumber || card.id === cardNumber);
}

function findTrend(card, cardNumber) {
  const candidates = [card?.id, cardNumber]
    .filter(Boolean)
    .map((id) => path.join(TRENDS_DIR, `${String(id).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`));

  for (const filePath of candidates) {
    const trend = readJson(filePath, null);
    if (trend) return trend;
  }
  return null;
}

async function main() {
  if (!NOTIFY_SECRET) {
    throw new Error('PUSH_NOTIFY_SECRET not set — /api/push/notify would reject the request');
  }
  // v41 freshness / restoration gate (scripts/lib/push-freshness.mjs): stale local
  // data never reaches a device — no dormant backlog after the restore.
  const now = Date.now();
  const notBefore = parseRestoreSince(process.env.PUSH_RESTORE_SINCE);
  const db = readJson(DATABASE_PATH, { cards: {} });
  assertFreshDatabase(db, now, notBefore);
  const watchlist = await fetchWatchlist();
  const { alerts, stale } = selectTrendAlerts({
    watchlist,
    findCard: (cardNumber) => findCard(db, cardNumber),
    findTrend,
    now,
    notBefore,
  });

  if (alerts.length === 0) {
    console.log(`[push-alerts] No eligible watchlist alerts (${stale} skipped as not current)`);
    return;
  }

  const res = await fetch(NOTIFY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': NOTIFY_SECRET,
    },
    body: JSON.stringify({ alerts }),
  });
  const resultText = await res.text();
  if (!res.ok) throw new Error(`notify ${res.status}: ${resultText}`);

  console.log(`[push-alerts] Sent ${alerts.length} alert candidates: ${resultText}`);
}

main().catch((err) => {
  console.error(`[push-alerts] ${err.message}`);
  process.exit(1);
});
