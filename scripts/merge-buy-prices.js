/**
 * merge-buy-prices.js — 把店家收購（買取）價 merge 進 data/database.json（DIC-856 版本精確對齊）
 *
 * 收購價「有分版本」。過去版本把每張卡塌成單一 card.buyPrice（同卡號取最高、對不到再退回
 * 純卡號最低價），造成 UI 每個版本都顯示同一個（常是最高的）收購價。本版改為：
 *   - 依 canonical 版本類別（base / parallel / signed，見 lib/variant-key.js）把每一筆買取價
 *     對齊到 database.json 每張卡 prices[] 內對應版本，寫入 `prices[i].buyPrice`。
 *   - card 層級 `card.buyPrice` 只取「該卡自身 rarity 所屬版本」的買取價，對不到即 null。
 *   - **絕不**跨版本借價：不用同卡號所有版本最高價 fallback，也不退回純卡號價；對不到 → null。
 *
 * 來源檔格式（爬蟲輸出）：
 *   { "hBP04-005-SEC": { buyPrice, rarity:"SEC", timestamp }, "hBP04-005": { buyPrice, rarity:null, ... } }
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  normalizeCardNumber,
  normalizeRarity,
  versionClassFromRarity,
  PARALLEL_RARITIES,
  classifyVariant,
  sourceToken,
} from './lib/variant-key.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, '../data/database.json');
const BUY_DIR = path.join(__dirname, '../data/buy-prices');
const SOURCE_FILES = ['torecolo-prices.json', 'fullahead-prices.json'];

// 來源檔的 timestamp 超過這個時數就視為過期，避免把昨天殘留檔當今天資料寫入（DIC-187）。
const MAX_SOURCE_AGE_HOURS = 18;

function localDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 讀所有來源檔，建 numKey(正規化卡號) -> 該卡號的買取版本清單。
 * 每筆版本：{ token(精確 rarity/產品碼，bare='' ), price }。同一 (numKey, token) 多筆
 *（例如 fullahead 與 torecolo 都收 SEC）取較高價——那是「同一版本」的兩個報價，非跨版本。
 */
function buildBuyIndex(now = Date.now()) {
  const byNum = new Map(); // numKey -> Map(token -> price)
  for (const file of SOURCE_FILES) {
    const p = path.join(BUY_DIR, file);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[merge-buy] 讀取 ${file} 失敗（跳過）: ${err.message}`);
      else console.log(`[merge-buy] ${file} 不存在，跳過`);
      continue;
    }
    let fresh = 0;
    let stale = 0;
    for (const [srcKey, entry] of Object.entries(raw || {})) {
      const price = entry && Number(entry.buyPrice);
      if (!Number.isFinite(price) || price <= 0) continue;
      const t = Date.parse(entry && entry.timestamp);
      if (!Number.isFinite(t) || now - t > MAX_SOURCE_AGE_HOURS * 3600 * 1000) {
        stale += 1;
        continue;
      }
      const numKey = normalizeCardNumber(srcKey);
      if (!numKey) continue;
      // 精確 token：以 entry.rarity 為準，缺失時退而由 key 尾綴推斷（純卡號 key → '' bare）。
      const token = sourceToken(entry.rarity, srcKey.slice(numKey.length));
      if (!byNum.has(numKey)) byNum.set(numKey, new Map());
      const perNum = byNum.get(numKey);
      const prev = perNum.get(token);
      if (prev == null || price > prev) perNum.set(token, price);
      fresh += 1;
    }
    if (stale > 0) {
      console.warn(`[merge-buy] ${file}: 略過 ${stale} 筆過期／無時間戳資料（>${MAX_SOURCE_AGE_HOURS}h）`);
    }
    console.log(`[merge-buy] ${file}: ${fresh} 筆新鮮買取價`);
  }
  // 攤平成 numKey -> array of { token, price }
  const out = new Map();
  for (const [numKey, perNum] of byNum.entries()) {
    out.set(numKey, [...perNum.entries()].map(([token, price]) => ({ token, price })));
  }
  return out;
}

/** 由買取版本清單建 token→最高價（同 token＝同版本兩報價取高，非跨版本）。 */
function buyPriceByToken(buyEntries) {
  const map = new Map();
  for (const b of Array.isArray(buyEntries) ? buyEntries : []) {
    const prev = map.get(b.token);
    if (prev == null || b.price > prev) map.set(b.token, b.price);
  }
  return map;
}

/**
 * 把某卡號的買取版本清單，精確對齊到該卡 prices[] 的每個版本，回傳與 variants 等長的 buyPrice
 * 陣列（對不到 / 版本不精確 → null，fail closed，絕不借別版價、絕不 Math.max 跨版本）。純函式。
 *
 * 規則（精確 token 比對）：
 *   - base（''）      只吃來源 bare('')；signed（'SEC'）只吃 'SEC'；帶標籤替代版只吃完全相同 token。
 *   - 純 (パラレル)（token=null）：唯一一個純平行版本、且唯一一個「未被具體 token 宣告的標準平行來源」
 *     才可對齊，否則 fail closed（避免 hBP02-017 兩個 (パラレル) 對 {SR,UR} 塌成同價）。
 *   - 任一具體 token 被兩個以上版本宣告（含同名重複）→ 全部 null（歧義，無法證明精確 provenance）。
 *
 * @param {Array<{name?:string}>} variants  database 卡片的 prices[]（至少含 name）
 * @param {Array<{token:string, price:number}>} buyEntries 該卡號買取版本
 */
function assignVariantBuyPrices(variants, buyEntries) {
  const list = Array.isArray(variants) ? variants : [];
  const srcByToken = buyPriceByToken(buyEntries);
  const cls = list.map((v) => classifyVariant(v && v.name));

  const tokenCount = new Map(); // 具體 token 出現次數 → 判重複歧義
  for (const c of cls) if (c.token != null) tokenCount.set(c.token, (tokenCount.get(c.token) || 0) + 1);

  // 被具體版本宣告的標準平行 rarity；純 (パラレル) 不可再吃這些。
  const claimed = new Set();
  for (const c of cls) if (c.token && PARALLEL_RARITIES.has(c.token)) claimed.add(c.token);

  // 可供純 (パラレル) 對齊的標準平行來源（未被具體版本宣告）。
  const parallelPool = [...srcByToken.keys()].filter((t) => PARALLEL_RARITIES.has(t) && !claimed.has(t));
  const plainCount = cls.filter((c) => c.versionClass === 'parallel' && c.token === null).length;

  return cls.map((c) => {
    if (c.token === null) {
      if (plainCount === 1 && parallelPool.length === 1) return srcByToken.get(parallelPool[0]);
      return null; // 0 個或多個平行來源／多個純平行版本 → 無法精確判定
    }
    if ((tokenCount.get(c.token) || 0) > 1) return null; // 重複宣告同 token → 歧義
    const p = srcByToken.get(c.token);
    return p != null ? p : null;
  });
}

/**
 * card 層級代表買取價：只取「該卡自身 rarity 精確 token 所屬版本」的價，對不到即 null。
 * 精確比對，絕不 class fallback、絕不跨版本 Math.max。
 */
function representativeBuyPrice(cardRarity, buyEntries) {
  const srcByToken = buyPriceByToken(buyEntries);
  if (srcByToken.size === 0) return null;
  // 原印/普卡（base class）對應來源的「無 rarity 純卡號」價（token ''）；平行/簽名用精確 rarity token。
  const token = versionClassFromRarity(cardRarity) === 'base' ? '' : normalizeRarity(cardRarity);
  const p = srcByToken.get(token);
  return p != null ? p : null;
}

function main() {
  console.log('[merge-buy] Starting...');
  const buyIndex = buildBuyIndex(Date.now());
  if (buyIndex.size === 0) {
    console.log('[merge-buy] 沒有任何買取價可 merge，database.json 不變。');
    return;
  }

  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  const date = localDateStr();
  let cardsUpdated = 0;
  let variantsMatched = 0;

  for (const card of Object.values(db.cards || {})) {
    if (!card.cardNumber) continue;
    const numKey = normalizeCardNumber(card.cardNumber);
    const buyEntries = (numKey && buyIndex.get(numKey)) || [];

    // 1) 每個版本自帶 matched buyPrice（對不到 → null）。
    if (Array.isArray(card.prices) && card.prices.length > 0) {
      const perVariant = assignVariantBuyPrices(card.prices, buyEntries);
      card.prices.forEach((v, i) => {
        const bp = perVariant[i];
        if (bp != null) {
          v.buyPrice = bp;
          variantsMatched += 1;
        } else {
          delete v.buyPrice; // fail closed：此版本暫無收購價
        }
      });
    }

    // 2) card 層級只放「本卡 rarity 版本」的價（無則清掉，不留舊的混版值）。
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
  console.log(
    `[merge-buy] ✅ Done — 買取卡號 ${buyIndex.size} 個；card 層級對齊 ${cardsUpdated} 張，版本層級對齊 ${variantsMatched} 筆（date ${date}）`
  );
}

const isMain = process.argv[1] && process.argv[1].includes('merge-buy-prices');
if (isMain) {
  try {
    main();
    process.exit(0);
  } catch (err) {
    console.error('[merge-buy] fatal:', err);
    process.exit(0);
  }
}

export { main as mergeBuyPrices, buildBuyIndex, buyPriceByToken, assignVariantBuyPrices, representativeBuyPrice };
