/**
 * regen-buy-alignment.mjs — 一次性重跑買取價「版本精確對齊」到 committed database.json（DIC-856）。
 *
 * 日常 cron 是 scrape → merge-buy-prices.js（含 18h 新鮮度檢查，用當天日期 append 每日 history point）。
 * 這支只在 PR 內重建 committed 資料用：直接以「來源檔自身 timestamp」當 now，讓既有 committed 來源
 * 不被新鮮度檢查擋掉，套用與 merge-buy-prices.js 完全相同的純函式對齊邏輯。日常流程不使用本檔。
 *
 * 決定性（determinism, DIC-856 CR）：
 *   - `buyPriceHistory` 的日期 key 一律用「來源快照日期」（最新來源 timestamp 的 UTC 日），
 *     而非 wall-clock `new Date()`。可用環境變數 BUY_PRICE_SNAPSHOT_DATE 覆寫。這樣不論哪一天
 *     重跑，第一次 regen 就與 committed 位元完全一致（不會多寫一個「今天」的 key，也不需跑第二次才穩定）。
 *   - 修剪任何比快照日期「更新」的 history key：committed 來源最多到快照日，晚於它的 key 不可能由任何
 *     committed 來源產生，屬於過去以 wall-clock 重跑留下的假資料，予以刪除以保證可重現。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { normalizeCardNumber } from './lib/variant-key.js';
import { buildBuyIndex, assignVariantBuyMatches, applyVariantBuyProvenance, representativeBuyPrice } from './merge-buy-prices.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../data/database.json');
const BUY_DIR = path.join(__dirname, '../data/buy-prices');

// 取兩個來源檔中最新的 timestamp（保證 committed 來源一律視為新鮮，也當作快照日期來源）。
export function latestSourceTs(buyDir = BUY_DIR) {
  let latest = 0;
  for (const f of ['torecolo-prices.json', 'fullahead-prices.json']) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(buyDir, f), 'utf-8'));
      for (const e of Object.values(raw || {})) {
        const t = Date.parse(e && e.timestamp);
        if (Number.isFinite(t) && t > latest) latest = t;
      }
    } catch {}
  }
  return latest;
}

/** 由來源檔推導決定性的快照時間與日期（UTC）。BUY_PRICE_SNAPSHOT_DATE 可覆寫日期。 */
export function snapshotInfo(buyDir = BUY_DIR, override = process.env.BUY_PRICE_SNAPSHOT_DATE) {
  const ts = latestSourceTs(buyDir);
  const date = override || new Date(ts).toISOString().slice(0, 10);
  return { ts, date };
}

/**
 * 對 db（會就地修改）套用版本精確對齊，並把 buyPriceHistory 以決定性 `date` key 寫入 + 修剪未來 key。
 * 純函式（不讀寫檔案）：CLI 與測試共用同一份邏輯，避免 drift。
 * @param {object} db  已 parse 的 database（in-place 修改）
 * @param {{now:number, date:string}} opts  now=新鮮度基準時間；date=快照日期 key
 */
export function regenerateBuyAlignment(db, { now, date }) {
  const buyIndex = buildBuyIndex(now);
  let cardsUpdated = 0;
  let variantsMatched = 0;
  for (const card of Object.values(db.cards || {})) {
    if (!card.cardNumber) continue;
    const numKey = normalizeCardNumber(card.cardNumber);
    const buyEntries = (numKey && buyIndex.get(numKey)) || [];

    if (Array.isArray(card.prices) && card.prices.length > 0) {
      const perVariant = assignVariantBuyMatches(card.prices, buyEntries);
      card.prices.forEach((v, i) => {
        applyVariantBuyProvenance(v, perVariant[i]);
        if (perVariant[i] != null) variantsMatched += 1;
      });
    }

    const rep = representativeBuyPrice(card, buyEntries);
    if (rep != null) {
      card.buyPrice = rep;
      if (!card.buyPriceHistory || typeof card.buyPriceHistory !== 'object') card.buyPriceHistory = {};
      card.buyPriceHistory[date] = rep;
      cardsUpdated += 1;
    } else {
      delete card.buyPrice;
    }

    // 決定性修剪：刪除任何晚於快照日期的 history key（wall-clock 重跑留下的假資料）。
    if (card.buyPriceHistory && typeof card.buyPriceHistory === 'object') {
      for (const k of Object.keys(card.buyPriceHistory)) {
        if (k > date) delete card.buyPriceHistory[k];
      }
      if (Object.keys(card.buyPriceHistory).length === 0) delete card.buyPriceHistory;
    }
  }
  return { cardsUpdated, variantsMatched, buyIndexSize: buyIndex.size };
}

function main() {
  const { ts, date } = snapshotInfo();
  const now = (ts || Date.now()) + 1000;
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  const { cardsUpdated, variantsMatched, buyIndexSize } = regenerateBuyAlignment(db, { now, date });
  fs.writeFileSync(DB_PATH, `${JSON.stringify(db, null, 2)}\n`, 'utf-8');
  console.log(`[regen] 快照日期 ${date}；card 層級 ${cardsUpdated} 張、版本層級 ${variantsMatched} 筆對齊（買取卡號 ${buyIndexSize} 個）`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
