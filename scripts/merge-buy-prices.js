/**
 * merge-buy-prices.js — 把回收（買取）價格 merge 進 data/database.json
 *
 * DIC-155:
 *   - 讀 data/buy-prices/torecolo-prices.json + fullahead-prices.json
 *     （格式: { "hBP01-001": { "buyPrice": 500, "timestamp": "..." } }）
 *   - 每張卡（依卡號）取最高的 buyPrice 作為代表值
 *   - 寫入 database.json 每張卡的 `buyPrice` 欄位
 *   - 同時累積 `buyPriceHistory`（格式同 priceHistory：{"2026-07-08": 500}）
 *
 * database.json 以 cardId（如 "hBP01-001_hBP01"）為 key，每張卡有 cardNumber 欄位；
 * 同一卡號可能對應多個 cardId（不同系列/版本），代表價會套用到所有相符的卡。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractCardNumber } from './lib/card-number.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, '../data/database.json');
const BUY_DIR = path.join(__dirname, '../data/buy-prices');
const SOURCE_FILES = ['torecolo-prices.json', 'fullahead-prices.json'];

// 來源檔的 timestamp 超過這個時數就視為過期。daily cron 下新鮮檔案只有幾分鐘舊，
// 昨天殘留的檔案約 24h 舊；若當次爬蟲沒產出、舊檔還留在磁碟上，這道檢查會擋下把
// 昨天資料當今天寫進 buyPrice/buyPriceHistory（DIC-187）。
const MAX_SOURCE_AGE_HOURS = 18;

function localDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 讀一個來源檔，回傳 { 來源 key -> buyPrice }。key 可能是「卡號-稀有度」（新格式）
// 或純卡號（舊格式），一律轉大寫。檔案不存在或壞掉就當空的。每筆 entry 帶 timestamp
//（來源爬蟲寫入當次的 ISO 時間）；缺失或超過 MAX_SOURCE_AGE_HOURS 的 entry 一律跳過，
// 避免 merge 到過期的殘留資料。
function loadSource(file, now = Date.now()) {
  const p = path.join(BUY_DIR, file);
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const map = new Map();
    let stale = 0;
    for (const [srcKey, entry] of Object.entries(raw || {})) {
      const price = entry && Number(entry.buyPrice);
      if (!Number.isFinite(price) || price <= 0) continue;
      const t = Date.parse(entry && entry.timestamp);
      if (!Number.isFinite(t) || now - t > MAX_SOURCE_AGE_HOURS * 3600 * 1000) {
        stale += 1;
        continue;
      }
      map.set(srcKey.toUpperCase(), price);
    }
    if (stale > 0) {
      console.warn(
        `[merge-buy] ${file}: 略過 ${stale} 筆過期／無時間戳資料（timestamp 缺失或超過 ${MAX_SOURCE_AGE_HOURS}h）`
      );
    }
    console.log(`[merge-buy] ${file}: ${map.size} 張卡（新鮮）`);
    return map;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[merge-buy] 讀取 ${file} 失敗（跳過）: ${err.message}`);
    } else {
      console.log(`[merge-buy] ${file} 不存在，跳過`);
    }
    return new Map();
  }
}

function main() {
  console.log('[merge-buy] Starting...');

  // 各來源合併，維護兩張表：
  //   bestByKey    —「卡號-稀有度」精確 key -> 最高買取價（用來按稀有度對齊）
  //   bestByNumber — 純卡號 -> 最高買取價（抓不到稀有度或舊格式時的 fallback）
  const now = Date.now();
  const bestByKey = new Map();
  const bestByNumber = new Map();
  for (const file of SOURCE_FILES) {
    const src = loadSource(file, now);
    for (const [key, price] of src.entries()) {
      if (!bestByKey.has(key) || price > bestByKey.get(key)) {
        bestByKey.set(key, price);
      }
      const num = extractCardNumber(key);
      if (num) {
        const numKey = num.toUpperCase();
        if (!bestByNumber.has(numKey) || price > bestByNumber.get(numKey)) {
          bestByNumber.set(numKey, price);
        }
      }
    }
  }

  if (bestByKey.size === 0) {
    console.log('[merge-buy] 沒有任何買取價可 merge，database.json 不變。');
    return;
  }

  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  const date = localDateStr();
  let updated = 0;

  for (const card of Object.values(db.cards || {})) {
    if (!card.cardNumber) continue;
    // 先用「卡號-稀有度」精確對齊，找不到再 fallback 到純卡號（取該卡號最高買取價）。
    const numKey = card.cardNumber.toUpperCase();
    const exactKey = card.rarity ? `${numKey}-${card.rarity.toUpperCase()}` : null;
    const price = (exactKey != null ? bestByKey.get(exactKey) : undefined) ?? bestByNumber.get(numKey);
    if (price == null) continue;

    card.buyPrice = price;
    if (!card.buyPriceHistory || typeof card.buyPriceHistory !== 'object') {
      card.buyPriceHistory = {};
    }
    card.buyPriceHistory[date] = price;
    updated += 1;
  }

  fs.writeFileSync(DB_PATH, `${JSON.stringify(db, null, 2)}\n`, 'utf-8');
  console.log(
    `[merge-buy] ✅ Done — 來源 key ${bestByKey.size} 個（卡號 ${bestByNumber.size} 個），更新 database ${updated} 張卡（date ${date}）`
  );
}

const isMain = process.argv[1] && process.argv[1].includes('merge-buy-prices');
if (isMain) {
  try {
    main();
    process.exit(0);
  } catch (err) {
    // 不讓整個流程中斷
    console.error('[merge-buy] fatal:', err);
    process.exit(0);
  }
}

export { main as mergeBuyPrices };
