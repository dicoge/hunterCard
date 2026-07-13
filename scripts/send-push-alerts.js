#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_DIR, 'data');
const WATCHLIST_PATH = path.join(DATA_DIR, 'push-watchlist.json');
const DATABASE_PATH = path.join(DATA_DIR, 'database.json');
const TRENDS_DIR = path.join(DATA_DIR, 'trends');
const NOTIFY_URL = process.env.PUSH_NOTIFY_URL || process.env.VERCEL_PUSH_NOTIFY_URL || 'https://holocard-hunter.vercel.app/api/push/notify';
const THRESHOLD = 0.6;
const MIN_DATA_POINTS = 3;

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function yen(value) {
  return Number.isFinite(value) ? `¥${value.toLocaleString('ja-JP')}` : '價格未定';
}

function uniqueWatchlistCards(watchlist) {
  const cards = new Set();
  for (const list of Object.values(watchlist || {})) {
    if (!Array.isArray(list)) continue;
    for (const cardNumber of list) {
      if (typeof cardNumber === 'string' && cardNumber.trim()) cards.add(cardNumber.trim());
    }
  }
  return [...cards];
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
  const watchlist = readJson(WATCHLIST_PATH, {});
  const db = readJson(DATABASE_PATH, { cards: {} });
  const cardNumbers = uniqueWatchlistCards(watchlist);
  const alerts = [];

  for (const cardNumber of cardNumbers) {
    const card = findCard(db, cardNumber);
    const trend = findTrend(card, cardNumber);
    const score = Number(trend?.score ?? trend?.trendScore ?? 0);
    const dataPoints = Number(trend?.dataPoints ?? 0);

    if (!trend || score <= THRESHOLD || dataPoints < MIN_DATA_POINTS) continue;

    const displayName = card?.nameZh || card?.name || trend.nameZh || trend.name || cardNumber;
    const price = card?.sellPrice ?? card?.buyPrice;
    alerts.push({
      cardNumber,
      title: `入手時機！${displayName} ▲+${Math.round(score * 100)}%`,
      body: `預測價格上漲，現價 ${yen(price)}，建議考慮入手`,
    });
  }

  if (alerts.length === 0) {
    console.log('[push-alerts] No eligible watchlist alerts');
    return;
  }

  const res = await fetch(NOTIFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
