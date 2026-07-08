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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, '../data/database.json');
const BUY_DIR = path.join(__dirname, '../data/buy-prices');
const SOURCE_FILES = ['torecolo-prices.json', 'fullahead-prices.json'];

function localDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 讀一個來源檔，回傳 { 正規化卡號 -> buyPrice }。檔案不存在或壞掉就當空的。
function loadSource(file) {
  const p = path.join(BUY_DIR, file);
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const map = new Map();
    for (const [cardNumber, entry] of Object.entries(raw || {})) {
      const price = entry && Number(entry.buyPrice);
      if (Number.isFinite(price) && price > 0) map.set(cardNumber.toUpperCase(), price);
    }
    console.log(`[merge-buy] ${file}: ${map.size} 張卡`);
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

  // 各來源合併：每個卡號取最高買取價
  const bestByNumber = new Map();
  for (const file of SOURCE_FILES) {
    const src = loadSource(file);
    for (const [key, price] of src.entries()) {
      if (!bestByNumber.has(key) || price > bestByNumber.get(key)) {
        bestByNumber.set(key, price);
      }
    }
  }

  if (bestByNumber.size === 0) {
    console.log('[merge-buy] 沒有任何買取價可 merge，database.json 不變。');
    return;
  }

  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  const date = localDateStr();
  let updated = 0;

  for (const card of Object.values(db.cards || {})) {
    if (!card.cardNumber) continue;
    const price = bestByNumber.get(card.cardNumber.toUpperCase());
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
    `[merge-buy] ✅ Done — 卡號來源 ${bestByNumber.size} 個，更新 database ${updated} 張卡（date ${date}）`
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
