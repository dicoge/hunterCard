/**
 * regen-buy-alignment.mjs — 一次性重跑買取價「版本精確對齊」到 committed database.json（DIC-856）。
 *
 * 日常 cron 是 scrape → merge-buy-prices.js（含 18h 新鮮度檢查）。這支只在 PR 內重建
 * committed 資料用：直接以「來源檔自身 timestamp」當 now，讓既有 committed 來源不被新鮮度
 * 檢查擋掉，套用與 merge-buy-prices.js 完全相同的純函式對齊邏輯。日常流程不使用本檔。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalizeCardNumber } from './lib/variant-key.js';
import { buildBuyIndex, assignVariantBuyPrices, representativeBuyPrice } from './merge-buy-prices.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../data/database.json');
const BUY_DIR = path.join(__dirname, '../data/buy-prices');

// 取兩個來源檔中最新的 timestamp 當 now，保證 committed 來源一律視為新鮮。
function latestSourceTs() {
  let latest = 0;
  for (const f of ['torecolo-prices.json', 'fullahead-prices.json']) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(BUY_DIR, f), 'utf-8'));
      for (const e of Object.values(raw || {})) {
        const t = Date.parse(e && e.timestamp);
        if (Number.isFinite(t) && t > latest) latest = t;
      }
    } catch {}
  }
  return latest || Date.now();
}

const now = latestSourceTs() + 1000;
const buyIndex = buildBuyIndex(now);
const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
const date = new Date().toISOString().slice(0, 10);

let cardsUpdated = 0;
let variantsMatched = 0;
for (const card of Object.values(db.cards || {})) {
  if (!card.cardNumber) continue;
  const numKey = normalizeCardNumber(card.cardNumber);
  const buyEntries = (numKey && buyIndex.get(numKey)) || [];
  if (Array.isArray(card.prices) && card.prices.length > 0) {
    const perVariant = assignVariantBuyPrices(card.prices, buyEntries);
    card.prices.forEach((v, i) => {
      if (perVariant[i] != null) { v.buyPrice = perVariant[i]; variantsMatched += 1; }
      else delete v.buyPrice;
    });
  }
  const rep = representativeBuyPrice(card.rarity, buyEntries);
  if (rep != null) {
    card.buyPrice = rep;
    if (!card.buyPriceHistory || typeof card.buyPriceHistory !== 'object') card.buyPriceHistory = {};
    card.buyPriceHistory[date] = rep;
    cardsUpdated += 1;
  } else {
    delete card.buyPrice;
  }
}

fs.writeFileSync(DB_PATH, `${JSON.stringify(db, null, 2)}\n`, 'utf-8');
console.log(`[regen] card 層級 ${cardsUpdated} 張、版本層級 ${variantsMatched} 筆對齊（買取卡號 ${buyIndex.size} 個）`);
