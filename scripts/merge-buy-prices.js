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
 *
 * 對齊時同時寫入 provenance：
 *   `prices[i].buyPrice`           該版本的收購價
 *   `prices[i].buyPriceVersion`    該價格的精確版本 token（base 印在 bare = 'BASE'）
 *   `prices[i].buyPriceSource`     來源店家（torecolo / fullahead）
 *   `prices[i].buyPriceTimestamp`  來源抓取時間
 * 讓資料面直接可驗證「每個價格都精確對應一個來源的特定版本」，且 build-database / 讀取層
 * 不需重複推測 provenance（DIC-856 版本來源可追溯）。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  normalizeCardNumber,
  normalizeRarityCode,
  isKnownRarityCode,
  isPremiumRarityCode,
  isOwnSetPrinting,
  PARALLEL_RARITIES,
  UNKNOWN_TOKEN,
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
 * 每筆版本：{ token(精確 rarity/產品碼，bare='' ), price, source, timestamp }。同一
 * (numKey, token) 多筆（例如 fullahead 與 torecolo 都收 SEC）取較高價——那是「同一版本」
 * 的兩個報價，非跨版本；同時記錄該報價的來源店家與抓取時間戳。
 */
function buildBuyIndex(now = Date.now()) {
  const byNum = new Map(); // numKey -> Map(token -> { price, source, timestamp })
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
    let unknown = 0;
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
      // 有標記但不在 allowlist（UNKNOWN_TOKEN）→ 絕不入 index：不得塌成 bare 原印版、
      // 也不得與任何版本 Math.max。fail closed，該筆直接丟棄。
      if (token === UNKNOWN_TOKEN) {
        unknown += 1;
        continue;
      }
      if (!byNum.has(numKey)) byNum.set(numKey, new Map());
      const perNum = byNum.get(numKey);
      const prev = perNum.get(token);
      const source = file.replace(/-prices\.json$/, '');
      if (prev == null || price > prev.price) {
        perNum.set(token, { price, source, timestamp: entry.timestamp });
      }
      fresh += 1;
    }
    if (stale > 0) {
      console.warn(`[merge-buy] ${file}: 略過 ${stale} 筆過期／無時間戳資料（>${MAX_SOURCE_AGE_HOURS}h）`);
    }
    if (unknown > 0) {
      console.warn(`[merge-buy] ${file}: fail-closed 丟棄 ${unknown} 筆未知版本標記（不塌成原印版）`);
    }
    console.log(`[merge-buy] ${file}: ${fresh} 筆新鮮買取價`);
  }
  // 攤平成 numKey -> array of { token, price, source, timestamp }
  const out = new Map();
  for (const [numKey, perNum] of byNum.entries()) {
    out.set(numKey, [...perNum.entries()].map(([token, v]) => ({ token, ...v })));
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
 * 把某卡號的買取版本清單，精確對齊到該卡 prices[] 的每個版本，回傳與 variants 等長的
 * 比對結果陣列（{ price, token, source, timestamp } | null）。對不到 / 版本不精確 → null，
 * fail closed，絕不借別版價、絕不 Math.max 跨版本。純函式。
 *
 * 規則（精確 token 比對）：
 *   - base（''）      只吃來源 bare('')；signed（'SEC'）只吃 'SEC'；帶標籤替代版只吃完全相同 token。
 *   - 純 (パラレル)（token=null）：唯一一個純平行版本、且唯一一個「未被具體 token 宣告的標準平行來源」
 *     才可對齊，否則 fail closed（避免 hBP02-017 兩個 (パラレル) 對 {SR,UR} 塌成同價）。
 *   - 任一具體 token 被兩個以上版本宣告（含同名重複）→ 全部 null（歧義，無法證明精確 provenance）。
 *
 * @param {Array<{name?:string}>} variants  database 卡片的 prices[]（至少含 name）
 * @param {Array<{token:string, price:number, source?:string, timestamp?:string}>} buyEntries 該卡號買取版本
 */
function assignVariantBuyMatches(variants, buyEntries) {
  const list = Array.isArray(variants) ? variants : [];
  // token → 完整比對 entry（{ price, token, source, timestamp }）。同 token＝同版本兩報價取高
  // （非跨版本）；保留該報價的來源店家與時間戳以寫入 provenance。
  const srcByToken = new Map();
  for (const b of Array.isArray(buyEntries) ? buyEntries : []) {
    const prev = srcByToken.get(b.token);
    if (prev == null || b.price > prev.price) srcByToken.set(b.token, b);
  }
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
      if (plainCount === 1 && parallelPool.length === 1) return srcByToken.get(parallelPool[0]) ?? null;
      return null; // 0 個或多個平行來源／多個純平行版本 → 無法精確判定
    }
    if ((tokenCount.get(c.token) || 0) > 1) return null; // 重複宣告同 token → 歧義
    const p = srcByToken.get(c.token);
    return p != null ? p : null;
  });
}

/**
 * assignVariantBuyPrices 的相容版：只回傳每個版本的 buyPrice（null = 對不到）。內部以
 * assignVariantBuyMatches 精確對齊，供舊呼叫點／驗證腳本使用。
 */
function assignVariantBuyPrices(variants, buyEntries) {
  return assignVariantBuyMatches(variants, buyEntries).map((m) => (m ? m.price : null));
}

/**
 * 把單一版本的比對結果寫進 variant（含 provenance）。null → 清掉 buyPrice 與其 provenance。
 * 這是 merge 與 regen 共用、確保輸出完全一致的唯一寫入點。
 *
 * @param {{[k:string]:unknown}} variant
 * @param {{price:number, token:string, source?:string, timestamp?:string}|null} match
 */
function applyVariantBuyProvenance(variant, match) {
  if (match == null) {
    delete variant.buyPrice;
    delete variant.buyPriceVersion;
    delete variant.buyPriceSource;
    delete variant.buyPriceTimestamp;
    return;
  }
  variant.buyPrice = match.price;
  variant.buyPriceVersion = match.token === '' ? 'BASE' : match.token;
  variant.buyPriceSource = match.source || '';
  variant.buyPriceTimestamp = match.timestamp || '';
}

/**
 * card 層級代表買取價：只在來源明確標記了「本列這個印次」時給價，否則 null。
 *
 * 一列 card 是一個實體印次（cardNumber + series + 該印次 rarity）；來源則把版本標在
 * listing 上：無標記 listing = 卡號的原印版，帶 rarity／產品碼的 listing = 該標記的
 * 平行／簽名版。兩者的對應只在下列情況可被來源證明：
 *   - premium rarity（SEC/HR/UR/S/P/產品碼…）→ 只吃完全同 token 的 listing。
 *   - 一般集內 rarity（OC/C/U/R/RR/SR）→ 只有「卡號原印集那一列」可吃無標記 listing；
 *     再刷／促銷列（series ≠ 卡號集前綴）與無標記 listing 無從連結 → fail closed。
 *   - 同一代碼同時有無標記與帶標記 listing（SR 卡又有 -SR listing）→ 無法證明本列是
 *     哪一個 → fail closed（與 app 端 dropConflictingPrices 同一判準）。
 *   - rarity 缺失或不在已知詞彙 → fail closed；別名（02_HR / UR_02 / P_02）先正規化成
 *     真代碼，絕不因為認不得就當成原印版（DIC-1008 CR：02_HR 曾拿到 bare ¥10）。
 */
function representativeBuyPrice(card, buyEntries) {
  const srcByToken = buyPriceByToken(buyEntries);
  if (srcByToken.size === 0) return null;
  const code = normalizeRarityCode(card && card.rarity);
  if (!isKnownRarityCode(code)) return null;
  if (isPremiumRarityCode(code)) return srcByToken.get(code) ?? null;
  if (!isOwnSetPrinting(card && card.cardNumber, card && card.series)) return null;
  if (srcByToken.has(code)) return null;
  return srcByToken.get('') ?? null;
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

    // 1) 每個版本自帶 matched buyPrice + provenance（對不到 → 清掉，fail closed）。
    if (Array.isArray(card.prices) && card.prices.length > 0) {
      const perVariant = assignVariantBuyMatches(card.prices, buyEntries);
      card.prices.forEach((v, i) => {
        const m = perVariant[i];
        applyVariantBuyProvenance(v, m);
        if (m != null) variantsMatched += 1;
      });
    }

    // 2) card 層級只放「本列這個印次」被來源證明的價（無則清掉，不留舊的混版值）。
    const rep = representativeBuyPrice(card, buyEntries);
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
    // Must be NON-ZERO: this is the final writer of data/database.json and the
    // scrape pipeline's fail-fast guard keys off this exit code to stop before
    // native generation, staging, commit and push. The old exit(0) ("不讓整個流程
    // 中斷") let malformed canonical data flow into the bot commit (DIC-989).
    console.error('[merge-buy] fatal:', err);
    process.exit(1);
  }
}

export { main as mergeBuyPrices, buildBuyIndex, buyPriceByToken, assignVariantBuyMatches, assignVariantBuyPrices, applyVariantBuyProvenance, representativeBuyPrice };
