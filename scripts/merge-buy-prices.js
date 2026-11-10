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
 *   `prices[i].buyPriceRetained`   true = 本輪沒有新報價，這是驗證過的上次已知報價（原來源／原時間）；
 *                                  本輪新報價不帶此欄位。card 層級 `card.buyPriceRetained` 同義。
 * 讓資料面直接可驗證「每個價格都精確對應一個來源的特定版本」，且 build-database / 讀取層
 * 不需重複推測 provenance（DIC-856 版本來源可追溯）。
 */
import { createHash } from 'crypto';
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
  plainParallelRarity,
  variantTokenCompatible,
  sourceToken,
} from './lib/variant-key.js';
import { readBuySourceEntries, groupByNumKey, buySourceDigest } from './lib/buy-source-cache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, '../data/database.json');
const BUY_DIR = process.env.HUNTERCARD_BUY_PRICES_DIR || path.join(__dirname, '../data/buy-prices');
const SOURCE_FILES = ['torecolo-prices.json', 'fullahead-prices.json', 'yuyu-prices.json'];
const BUY_SOURCES = new Set(SOURCE_FILES.map((f) => f.replace(/-prices\.json$/, '')));

// 來源檔的 timestamp 超過這個時數就視為過期，避免把昨天殘留檔當今天資料寫入（DIC-187）。
const MAX_SOURCE_AGE_HOURS = 18;
// 來源 timestamp 晚於 now 超過這個容差 → 未來時間，fail closed（不當新鮮、不當 last-known）。
const FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * 本次 pipeline 的起始時間（ms）。只認 local-scrape-and-push.sh 明確 export 的
 * HUNTERCARD_RUN_STARTED_AT（epoch 秒，已在 shell 端拒絕未來 / >1 天的殘留值，這裡再驗一次）。
 * 缺少或不合法 → null：無法證明哪筆報價是「這一輪」抓到的，所有報價都只能當 last-known
 * （buyPriceRetained），絕不由檔案 mtime / build 時間 / 18h 年齡推論為本輪新報價。
 */
function runStartedAtMs(now = Date.now(), raw = process.env.HUNTERCARD_RUN_STARTED_AT) {
  if (raw == null || !/^\d+$/.test(String(raw).trim())) return null;
  const ms = Number(String(raw).trim()) * 1000;
  if (!Number.isFinite(ms) || ms > now + FUTURE_SKEW_MS || now - ms > 86400 * 1000) return null;
  return ms;
}

function localDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** The merge process's own time zone (recorded in the run proof). */
function processTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/**
 * YYYY-MM-DD of `ms` in `timeZone`. Used by the merge's history write (with its own zone) and by
 * regen when it reproduces a merge from its recorded run proof (with the recorded zone), so the
 * two can never key the same observation differently.
 */
function historyDateKey(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * 讀所有來源檔，建 numKey(正規化卡號) -> 該卡號的買取版本清單。
 * 每筆版本：{ token(精確 rarity/產品碼，bare='' ), price, source, timestamp }。同一
 * (numKey, token) 多筆（例如 fullahead 與 torecolo 都收 SEC）取較高價——那是「同一版本」
 * 的兩個報價，非跨版本；同時記錄該報價的來源店家與抓取時間戳。
 */
function buildBuyIndex(now = Date.now(), { dir = BUY_DIR, notBefore = null } = {}) {
  const byNum = new Map(); // numKey -> Map(token -> { price, source, timestamp })
  for (const file of SOURCE_FILES) {
    const p = path.join(dir, file);
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
    let future = 0;
    let earlier = 0;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      console.warn(`[merge-buy] ${file} 格式異常（非物件），跳過`);
      continue;
    }
    for (const [srcKey, entry] of Object.entries(raw)) {
      const price = entry && Number(entry.buyPrice);
      if (!Number.isFinite(price) || price <= 0) continue;
      const t = Date.parse(entry && entry.timestamp);
      if (!Number.isFinite(t) || now - t > MAX_SOURCE_AGE_HOURS * 3600 * 1000) {
        stale += 1;
        continue;
      }
      if (t > now + FUTURE_SKEW_MS) {
        future += 1;
        continue;
      }
      // 本輪起始之前抓到的報價（例如 403 後殘留的昨天檔案）不是本輪新報價：
      // 不進 fresh index；該版本先前寫入的 tuple 由 reconcile 以 last-known 保留。
      if (notBefore != null && t < notBefore) {
        earlier += 1;
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
    if (future > 0) {
      console.warn(`[merge-buy] ${file}: fail-closed 丟棄 ${future} 筆未來時間戳報價`);
    }
    if (earlier > 0) {
      console.warn(`[merge-buy] ${file}: ${earlier} 筆報價早於本輪起始（非本輪新報價，不當新鮮）`);
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
 *   - 純 (パラレル)（token=null）且版本自身 `rarity` 為已知代碼（遊々亭 listing 標示）：綁定該印次，
 *     只吃完全相同的標準平行 token；非平行代碼（S/C/SEC/產品碼…）、重複綁定、或該 token 無 listing
 *     → null，絕不借別印次（2026-11-10 PR #287：SR 版本曾吃 UR、S 版本曾吃 HR/SR）。
 *   - 純 (パラレル) 而 rarity 缺失／未知（未綁定）：只有在「本列只有這一個純平行版本」、「唯一一個未被
 *     宣告的標準平行來源」且「該 token 等於本列自身印次代碼 rowRarity」時才可對齊；否則 fail closed。
 *     不由兄弟版本的綁定推論剩餘 listing（review MATCHER R1 P1-1），不讓別列印次的 listing 落到
 *     本列（P1-2）。rowRarity 缺省／未知 → 未綁定一律 null。
 *   - 任一具體（或綁定）token 被兩個以上版本宣告（含同名重複）→ 全部 null（歧義）。
 *
 * @param {Array<{name?:string, rarity?:string}>} variants  database 卡片的 prices[]（至少含 name）
 * @param {Array<{token:string, price:number, source?:string, timestamp?:string}>} buyEntries 該卡號買取版本
 * @param {string} [rowRarity]  該 card 列自身的 rarity（本列印次）；未提供 → 未綁定純平行 fail closed
 */
function assignVariantBuyMatches(variants, buyEntries, rowRarity) {
  const list = Array.isArray(variants) ? variants : [];
  // token → 完整比對 entry（{ price, token, source, timestamp }）。同 token＝同版本兩報價取高
  // （非跨版本）；保留該報價的來源店家與時間戳以寫入 provenance。
  const srcByToken = new Map();
  for (const b of Array.isArray(buyEntries) ? buyEntries : []) {
    const prev = srcByToken.get(b.token);
    if (prev == null || b.price > prev.price) srcByToken.set(b.token, b);
  }
  const cls = list.map((v) => classifyVariant(v && v.name));
  // 純 (パラレル) 自身 rarity 明確 → 綁定該印次；缺失／未知 → null（未綁定）。
  const bound = list.map((v) => plainParallelRarity(v));

  const tokenCount = new Map(); // 具體 token（含綁定的純平行）出現次數 → 判重複歧義
  const count = (t) => tokenCount.set(t, (tokenCount.get(t) || 0) + 1);
  cls.forEach((c, i) => { if (c.token != null) count(c.token); else if (bound[i] != null) count(bound[i]); });

  // 被具體版本（或綁定的純平行）宣告的標準平行 rarity；未綁定的純 (パラレル) 不可再吃這些。
  const claimed = new Set();
  cls.forEach((c, i) => {
    const t = c.token != null ? c.token : bound[i];
    if (t && PARALLEL_RARITIES.has(t)) claimed.add(t);
  });

  // 可供未綁定純 (パラレル) 對齊的標準平行來源（未被宣告）。
  const parallelPool = [...srcByToken.keys()].filter((t) => PARALLEL_RARITIES.has(t) && !claimed.has(t));
  // 本列所有純平行版本（綁定與未綁定合計）：>1 時未綁定者不得以「剩餘」推論（P1-1）。
  const plainTotal = cls.filter((c) => c.versionClass === 'parallel' && c.token === null).length;
  const rowCode = normalizeRarityCode(rowRarity);

  return cls.map((c, i) => {
    if (c.token === null) {
      const b = bound[i];
      if (b != null) {
        // 明確 rarity 證明：只吃同一標準平行 token；非平行代碼、重複宣告或該 token 無 listing → null。
        if (!PARALLEL_RARITIES.has(b) || (tokenCount.get(b) || 0) > 1) return null;
        return srcByToken.get(b) ?? null;
      }
      // 未綁定：唯一純平行 + 唯一未宣告平行來源 + 該 token 就是本列印次（列印次證明），否則 null。
      if (plainTotal === 1 && parallelPool.length === 1 && parallelPool[0] === rowCode) return srcByToken.get(rowCode) ?? null;
      return null;
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
function assignVariantBuyPrices(variants, buyEntries, rowRarity) {
  return assignVariantBuyMatches(variants, buyEntries, rowRarity).map((m) => (m ? m.price : null));
}

/**
 * 把單一版本的比對結果寫進 variant（含 provenance）。null → 清掉 buyPrice 與其 provenance。
 * 這是 merge 與 regen 共用、確保輸出完全一致的唯一寫入點。
 *
 * @param {{[k:string]:unknown}} variant
 * @param {{price:number, token:string, source?:string, timestamp?:string}|null} match
 */
function applyVariantBuyProvenance(variant, match, { retained = false } = {}) {
  // 新報價（或清除）一律清掉 last-known 狀態；只有 reconcile 明確驗證過的舊報價才帶 retained。
  delete variant.buyPriceRetained;
  delete variant.buyLastKnown;
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
  if (retained) variant.buyPriceRetained = true;
}

/**
 * 先前寫入（或 build-database 以 `buyLastKnown` 暫存）的單一版本報價，轉成可再驗證的
 * 候選 entry `{ token, price, source, timestamp }`。值、精確版本、來源、時間必須一起完整，
 * 任何一項缺失／格式錯／來源不在 allowlist／未來時間 → null（fail closed）。
 * 不讀 buyPriceHistory、不讀使用者成本／帳戶資料。
 */
function lastKnownBuyCandidate(variant, now) {
  if (!variant || typeof variant !== 'object') return null;
  const held = variant.buyLastKnown && typeof variant.buyLastKnown === 'object' ? variant.buyLastKnown : null;
  const price = held ? held.price : variant.buyPrice;
  const version = held ? held.version : variant.buyPriceVersion;
  const source = held ? held.source : variant.buyPriceSource;
  const timestamp = held ? held.timestamp : variant.buyPriceTimestamp;
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;
  if (typeof version !== 'string' || version === '' || version.startsWith('#') || version === UNKNOWN_TOKEN) return null;
  if (typeof source !== 'string' || !BUY_SOURCES.has(source)) return null;
  const t = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
  if (!Number.isFinite(t) || t > now + FUTURE_SKEW_MS) return null;
  const token = version === 'BASE' ? '' : version;
  // 版本 token 必須是 allowlist 內的精確代碼（與來源端同一判準），未知尾綴不收。
  if (token !== '' && sourceToken(token, '') !== token) return null;
  return { token, price, source, timestamp };
}

function representativeBuyEntry(card, buyEntries) {
  const byToken = new Map();
  for (const b of Array.isArray(buyEntries) ? buyEntries : []) {
    const prev = byToken.get(b.token);
    if (prev == null || b.price > prev.price) byToken.set(b.token, b);
  }
  const price = representativeBuyPrice(card, buyEntries);
  if (price == null) return null;
  const code = normalizeRarityCode(card && card.rarity);
  const entry = isPremiumRarityCode(code) ? byToken.get(code) : byToken.get('');
  return entry && entry.price === price ? entry : null;
}

/**
 * A raw source-evidence record (`card.buyPriorSource[]` from the rebuild, or a current
 * source-file entry that is not proven fresh this run) → candidate entry, or null.
 * Same validity rules as a held tuple: positive value, allowlisted exact token, known shop,
 * parseable own observation time not in the future. Its own time is kept verbatim.
 */
function sourceEvidenceCandidate(rec, now) {
  if (!rec || typeof rec !== 'object') return null;
  const { token, price, source, timestamp, sourceKey } = rec;
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;
  if (typeof token !== 'string' || token.startsWith('#') || token === UNKNOWN_TOKEN) return null;
  if (token !== '' && sourceToken(token, '') !== token) return null;
  if (typeof source !== 'string' || !BUY_SOURCES.has(source)) return null;
  const t = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
  if (!Number.isFinite(t) || t > now + FUTURE_SKEW_MS) return null;
  return { token, price, source, timestamp, ...(typeof sourceKey === 'string' ? { sourceKey } : {}) };
}

/**
 * Retained-only candidate pool of one card: token → ONE evidence entry.
 *   - variant tuples / `buyLastKnown` holders, only when compatible with their own variant;
 *   - the card's own verified holder (`card.buyLastKnown`, written by a previous merge);
 *   - the rebuild-captured prior source cache (`card.buyPriorSource`);
 *   - `cacheEntries`: this run's source files' entries that are NOT proven fresh this run.
 * A token quoted fresh this run is excluded (fresh always wins, even lower). Per token the
 * NEWEST observation is the evidence; two different quotes (value or shop) at that newest
 * time → the token is a conflict and nothing is retained for it (fail closed).
 */
function buildRetainedCandidatePool(card, fresh, now, cacheEntries, retainedBefore = Infinity) {
  const freshTokens = new Set(fresh.map((b) => b.token));
  const raw = [];
  if (Array.isArray(card.prices)) {
    card.prices.forEach((v) => {
      const c = lastKnownBuyCandidate(v, now);
      if (!c) return;
      // 只收與本版本相容的 held tuple（同 assignVariantBuyMatches 判準：綁定的純平行只收同 token，
      // 未綁定的只收本列印次 token；SR 版本上的 UR tuple 不是證據）。
      if (variantTokenCompatible(v, c.token, card.rarity)) raw.push(c);
    });
  }
  if (card.buyLastKnown && typeof card.buyLastKnown === 'object') {
    const c = lastKnownBuyCandidate({ buyLastKnown: card.buyLastKnown }, now);
    if (c) raw.push(typeof card.buyLastKnown.sourceKey === 'string' ? { ...c, sourceKey: card.buyLastKnown.sourceKey } : c);
  }
  for (const rec of [...(Array.isArray(card.buyPriorSource) ? card.buyPriorSource : []), ...(cacheEntries || [])]) {
    const c = sourceEvidenceCandidate(rec, now);
    if (c) raw.push(c);
  }
  const byToken = new Map();
  for (const c of raw) {
    if (freshTokens.has(c.token)) continue;
    // A quote observed at/after this run's start (or, with no run marker, after the merge clock)
    // is never "last known": it is either this run's fresh quote or not trustworthy (review N7).
    if (!(Date.parse(c.timestamp) < retainedBefore)) continue;
    if (!byToken.has(c.token)) byToken.set(c.token, []);
    byToken.get(c.token).push(c);
  }
  const pool = new Map();
  const conflicts = new Set();
  for (const [token, list] of byToken) {
    const newest = Math.max(...list.map((c) => Date.parse(c.timestamp)));
    const atNewest = list.filter((c) => Date.parse(c.timestamp) === newest);
    const distinct = new Set(atNewest.map((c) => `${c.price}|${c.source}`));
    if (distinct.size > 1) {
      conflicts.add(token);
      continue;
    }
    // Same quote seen through several carriers: keep the one that names its source key.
    pool.set(token, atNewest.find((c) => c.sourceKey) || atNewest[0]);
  }
  return { pool, conflicts };
}

/** Why the card-level quote could not be restored (replay / audit diagnostics). */
function cardLevelFailReason(card, combined, conflicts) {
  const code = normalizeRarityCode(card && card.rarity);
  if (!isKnownRarityCode(code)) return `unknown-rarity:${card && card.rarity}`;
  const tokens = new Set(combined.map((b) => b.token));
  if (isPremiumRarityCode(code)) {
    if (conflicts.has(code)) return `conflicting-evidence:${code}`;
    return `no-evidence-for-token:${code}`;
  }
  if (!isOwnSetPrinting(card && card.cardNumber, card && card.series)) return 'reprint-row-cannot-take-bare-listing';
  if (tokens.has(code)) return `bare-and-${code}-listings-both-present`;
  if (isParallelOnlyRow(card)) return 'parallel-only-row-cannot-take-bare-listing';
  if (conflicts.has('')) return 'conflicting-evidence:BASE';
  return 'no-evidence-for-token:BASE';
}

/**
 * merge 與 regen 共用的唯一 reconcile（就地修改 card）：
 *   1. 每個版本先只用本輪新報價（freshEntries）精確對齊——與既有規則完全相同，新報價永遠勝出
 *      （即使比舊報價低），帶自己的來源與時間，並清掉 retained 狀態。
 *   2. 本輪沒有新報價的版本／card：只從 retained-only 候選池（見 buildRetainedCandidatePool）
 *      以「同一套」exact 對齊規則重跑；對到候選 → 保留並標 `buyPriceRetained: true`，保留原來源
 *      與原觀測時間；對不到／歧義／衝突 → 清除（拒絕、不相容、歧義不復活）。
 *   3. card 層級：本輪新報價 → buyPrice（回傳 entry 供呼叫端以觀測日期寫 history）；否則以同一
 *      representative 規則（原印集 bare／premium 精確 token／衝突即 null）從 fresh ∪ 候選池選；
 *      選中候選 → retained，並寫 internal `card.buyLastKnown`（值+版本+來源+時間），使證據在
 *      下一次全量 rebuild 與連續缺報後仍可再驗證。保留的報價絕不寫 history。
 *   4. `card.buyPriorSource`（rebuild 暫存的原始來源證據）在此被消耗並移除。
 * @returns {{ fresh: object|null, retained: boolean, retainedEntry: object|null, cardReason: string|null,
 *             variantsFresh: number, variantsRetained: number }}
 */
function reconcileCardBuyQuotes(card, freshEntries, now, { cacheEntries = [], retainedBefore = Infinity } = {}) {
  const fresh = Array.isArray(freshEntries) ? freshEntries : [];
  const { pool, conflicts } = buildRetainedCandidatePool(card, fresh, now, cacheEntries, retainedBefore);
  const poolEntries = new Set(pool.values());
  // A conflicted token still EXISTS as source evidence: it enters alignment as a placeholder
  // that can never be retained, so it keeps blocking what its presence makes ambiguous (a plain
  // parallel's pool, a base row's bare listing beside its own code) instead of vanishing.
  const placeholders = [...conflicts].map((token) => ({ token, price: -1, conflict: true }));
  const combined = [...fresh, ...pool.values(), ...placeholders];
  let variantsFresh = 0;
  let variantsRetained = 0;
  if (Array.isArray(card.prices) && card.prices.length > 0) {
    const freshMatches = assignVariantBuyMatches(card.prices, fresh, card.rarity);
    const combinedMatches = assignVariantBuyMatches(card.prices, combined, card.rarity);
    card.prices.forEach((v, i) => {
      if (freshMatches[i] != null) {
        applyVariantBuyProvenance(v, freshMatches[i]);
        variantsFresh += 1;
        return;
      }
      const m = combinedMatches[i];
      if (m && poolEntries.has(m)) {
        applyVariantBuyProvenance(v, m, { retained: true });
        variantsRetained += 1;
        return;
      }
      applyVariantBuyProvenance(v, null);
    });
  }

  delete card.buyPriorSource;
  delete card.buyPriceRetained;
  delete card.buyLastKnown;
  const freshRep = representativeBuyEntry(card, fresh);
  if (freshRep) {
    card.buyPrice = freshRep.price;
    return { fresh: freshRep, retained: false, retainedEntry: null, cardReason: null, variantsFresh, variantsRetained };
  }
  const rep = pool.size > 0 ? representativeBuyEntry(card, combined) : null;
  if (rep && poolEntries.has(rep)) {
    card.buyPrice = rep.price;
    card.buyPriceRetained = true;
    card.buyLastKnown = {
      price: rep.price,
      version: rep.token === '' ? 'BASE' : rep.token,
      source: rep.source,
      timestamp: rep.timestamp,
      ...(rep.sourceKey ? { sourceKey: rep.sourceKey } : {}),
    };
    return { fresh: null, retained: true, retainedEntry: rep, cardReason: null, variantsFresh, variantsRetained };
  }
  delete card.buyPrice;
  return {
    fresh: null, retained: false, retainedEntry: null,
    cardReason: cardLevelFailReason(card, combined, conflicts), variantsFresh, variantsRetained,
  };
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
 *   - 本列自己的遊々亭版本全是 (パラレル)／サイン（沒有任何 base 版本）→ 來源已證明本列不是原印版，
 *     不可吃無標記 listing → fail closed（2026-11-10 PR #287 B：hBP06-081 SR 列曾吃原印 RR 的 bare ¥5）。
 *     prices[] 缺失／空 → 規則不變（揭露的殘餘，由 audit 列舉）。
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
  // 無標記 listing ＝卡號的原印版；本列版本全為 (パラレル)／サイン → 不是原印版。只看本列自己的
  // 版本名稱，不看報價日期、不看圖片。
  if (isParallelOnlyRow(card)) return null;
  return srcByToken.get('') ?? null;
}

/** 本列 prices[] 非空且沒有任何 base 類版本（全為 (パラレル)／サイン）→ true；prices[] 缺失／空 → false。 */
function isParallelOnlyRow(card) {
  const list = card && Array.isArray(card.prices) ? card.prices.filter((v) => v && typeof v === 'object') : [];
  return list.length > 0 && !list.some((v) => classifyVariant(v.name).versionClass === 'base');
}

/**
 * 每日 merge：本輪新報價 → 套用 + 以「該報價自身觀測日（本機時區）」寫一筆 history；
 * 沒有本輪新報價 → 只保留通過驗證的 last-known（buyPriceRetained），不寫 history。
 * 來源檔缺失／403／過期／毀損時不再提早 return：仍需把 build-database 的 buyLastKnown holder
 * 轉成明確的 retained 報價或清除（holder 不得留在輸出）。
 */
/** Retained quotes must be observed strictly before this instant (run start, else the merge clock). */
function retainedBoundMs(runStartedAt, now) {
  return runStartedAt == null ? now : runStartedAt;
}

/**
 * The merge's not-fresh BOUND evidence: every valid entry of the source files in `dir` that is
 * not fresh under (now, runStartedAt) and was observed before the retained bound, grouped by
 * card number. merge-buy-prices.js offers these as retained-only candidates; regen rebuilds the
 * exact same set from the digest-verified files to audit retained quotes (review N7).
 */
function notFreshBoundEvidence(dir, now, runStartedAt) {
  const bound = retainedBoundMs(runStartedAt, now);
  return groupByNumKey(readBuySourceEntries(dir, now).entries.filter((e) => {
    const t = Date.parse(e.timestamp);
    const fresh = runStartedAt != null && now - t <= MAX_SOURCE_AGE_HOURS * 3600 * 1000 && t >= runStartedAt;
    return !fresh && t < bound;
  }));
}

/**
 * Audit every RETAINED quote of an artifact against the bound evidence (review N7), with the
 * merge's own rules for that exact token:
 *   - observed at/after the retained bound → `after-run-start`;
 *   - bound evidence has a NEWER observation → `older-than-bound-evidence`;
 *   - bound evidence at the same newest time with a different value/shop (or a different quote
 *     under the same source key) → `conflicts-bound-evidence`;
 *   - exactly one bound entry (value, shop, time, and source key for a card holder) → COVERED;
 *   - strictly newer than every bound entry (or none exists) → CARRIED from an earlier run's
 *     capture: listed in `carried`, whose sha256 (`carryDigest`) the merge records in its run
 *     proof, so an edited carried quote invalidates the proof.
 * A retained card without a complete holder, or a retained tuple that is not a valid exact
 * quote, is `incomplete`. Keys: `${id}\u0000#card` or `${id}\u0000${variantIndex}`.
 */
function auditRetainedQuotes(db, cacheByNum, { now, runStartedAt, freshByNum = new Map() }) {
  const bound = retainedBoundMs(runStartedAt, now);
  const violations = new Map();
  const carried = [];
  let covered = 0;
  const judge = (key, numKey, q, withSourceKey) => {
    const t = Date.parse(q.timestamp);
    if (!(t < bound)) { violations.set(key, 'after-run-start'); return; }
    const ev = ((numKey && cacheByNum.get(numKey)) || []).filter((e) => e.token === q.token);
    const newest = ev.length ? Math.max(...ev.map((e) => Date.parse(e.timestamp))) : -Infinity;
    if (newest > t) { violations.set(key, 'older-than-bound-evidence'); return; }
    // N8: the quote's OWN provider still quotes this exact token in the bound files. Its
    // retained observation cannot be newer than that entry (a scrape writes this run's times; a
    // 403 / missing file leaves the very file that was captured), so it is never "carried".
    // Stricter than per-key: any own-provider entry for the token counts (a card holder's own
    // sourceKey under the same provider included). A different provider, or an own provider that
    // no longer quotes the token at all, remains the legitimate carried case.
    const own = ev.filter((e) => e.source === q.source);
    if (own.length && t > Math.max(...own.map((e) => Date.parse(e.timestamp)))) {
      violations.set(key, 'newer-than-own-bound-entry');
      return;
    }
    if (newest === t) {
      const atNewest = ev.filter((e) => Date.parse(e.timestamp) === t);
      const same = (e) => e.price === q.price && e.source === q.source && Date.parse(e.timestamp) === t
        && (!withSourceKey || !q.sourceKey || e.sourceKey === q.sourceKey);
      const distinct = new Set(atNewest.map((e) => `${e.price}|${e.source}`));
      if (distinct.size === 1 && atNewest.some(same)) { covered += 1; return; }
      violations.set(key, 'conflicts-bound-evidence');
      return;
    }
    carried.push([key, q.token, q.price, q.source, q.timestamp, withSourceKey ? (q.sourceKey || '') : ''].join('|'));
  };
  for (const [id, card] of Object.entries(db.cards || {})) {
    if (!card || typeof card !== 'object' || !card.cardNumber) continue;
    const numKey = normalizeCardNumber(card.cardNumber);
    (Array.isArray(card.prices) ? card.prices : []).forEach((v, i) => {
      if (!v || v.buyPriceRetained !== true) return;
      const key = `${id}\u0000${i}`;
      const q = lastKnownBuyCandidate({ ...v, buyLastKnown: undefined }, now);
      if (!q) { violations.set(key, 'incomplete'); return; }
      judge(key, numKey, q, false);
    });
    if (card.buyPriceRetained === true) {
      const key = `${id}\u0000#card`;
      const h = card.buyLastKnown;
      const q = h && typeof h === 'object' ? lastKnownBuyCandidate({ buyLastKnown: h }, now) : null;
      if (!q || card.buyPrice !== q.price) { violations.set(key, 'incomplete'); return; }
      judge(key, numKey, { ...q, sourceKey: typeof h.sourceKey === 'string' ? h.sourceKey : undefined }, true);
    }
    // N9: every retained quote must be exactly what the merge's OWN rules assign for this row —
    // re-run the real reconcile on a CLONE whose only carriers are the artifact's retained quotes
    // plus the bound evidence (ambiguity tokens), with the same fresh entries and bound. This
    // re-applies the card printing rule (premium exact code / own-set bare with no own-code
    // listing / reprint or unknown rarity → none) and the variant uniqueness rules (duplicate
    // token, single plain parallel with a single unclaimed parallel listing). The original is
    // never modified here; only mismatching quotes become violations (cleared by the caller).
    const hasRetained = card.buyPriceRetained === true || (Array.isArray(card.prices) && card.prices.some((v) => v && v.buyPriceRetained === true));
    if (hasRetained) {
      const clone = JSON.parse(JSON.stringify(card));
      reconcileCardBuyQuotes(clone, (numKey && freshByNum.get(numKey)) || [], now, {
        cacheEntries: (numKey && cacheByNum.get(numKey)) || [], retainedBefore: bound,
      });
      (Array.isArray(card.prices) ? card.prices : []).forEach((v, i) => {
        if (!v || v.buyPriceRetained !== true) return;
        const key = `${id}\u0000${i}`;
        const c = clone.prices && clone.prices[i];
        const same = c && c.buyPriceRetained === true && c.buyPrice === v.buyPrice && c.buyPriceVersion === v.buyPriceVersion
          && c.buyPriceSource === v.buyPriceSource && c.buyPriceTimestamp === v.buyPriceTimestamp;
        if (!same && !violations.has(key)) violations.set(key, 'not-the-merge-assignment');
      });
      if (card.buyPriceRetained === true) {
        const key = `${id}\u0000#card`;
        const h = card.buyLastKnown || {};
        const ch = clone.buyLastKnown || {};
        const same = clone.buyPriceRetained === true && clone.buyPrice === card.buyPrice
          && ch.price === h.price && ch.version === h.version && ch.source === h.source && ch.timestamp === h.timestamp;
        if (!same && !violations.has(key)) violations.set(key, 'not-the-merge-assignment');
      }
    }
  }
  // Carried quotes that are not violations; violations never enter the digest.
  for (let i = carried.length - 1; i >= 0; i -= 1) if (violations.has(carried[i].split('|')[0])) carried.splice(i, 1);
  carried.sort();
  return { violations, carried: carried.length, covered, carryDigest: createHash('sha256').update(carried.join('\n')).digest('hex') };
}

/** Clear every audited violation (variant tuple / card quote + holder). Shared by merge and regen. */
function clearRetainedViolations(db, violations) {
  for (const key of violations.keys()) {
    const [id, slot] = key.split('\u0000');
    const card = db.cards && db.cards[id];
    if (!card) continue;
    if (slot === '#card') {
      delete card.buyPrice;
      delete card.buyPriceRetained;
      delete card.buyLastKnown;
    } else if (Array.isArray(card.prices) && card.prices[Number(slot)]) {
      applyVariantBuyProvenance(card.prices[Number(slot)], null);
    }
  }
}

function mergeBuyPricesInto(db, { now = Date.now(), runStartedAt = runStartedAtMs(now), dir = BUY_DIR } = {}) {
  if (runStartedAt == null) {
    console.warn('[merge-buy] 無合法 HUNTERCARD_RUN_STARTED_AT：無法證明本輪新報價，所有報價只當 last-known 保留');
  }
  // 沒有本輪起始時間 → 沒有任何報價能被證明為本輪新報價。
  const buyIndex = runStartedAt == null ? new Map() : buildBuyIndex(now, { dir, notBefore: runStartedAt });
  // 來源檔中「未被證明為本輪新報價」的合法 entry（過期、早於本輪起始、或無 run marker）：
  // 不再忽略，而是作為 retained-only 候選（原來源／原時間，永不當新鮮）。
  // …observed before the retained bound (a quote at/after the run start is never "last known").
  const cacheByNum = notFreshBoundEvidence(dir, now, runStartedAt);
  const retainedBefore = retainedBoundMs(runStartedAt, now);
  const timeZone = processTimeZone();
  const stats = { buyIndexSize: buyIndex.size, cardsFresh: 0, cardsRetained: 0, variantsFresh: 0, variantsRetained: 0 };
  for (const card of Object.values(db.cards || {})) {
    if (!card || typeof card !== 'object') continue;
    if (!card.cardNumber) {
      // No card number → nothing can be aligned; internal holders never survive the merge.
      delete card.buyPriorSource;
      delete card.buyLastKnown;
      continue;
    }
    const numKey = normalizeCardNumber(card.cardNumber);
    const buyEntries = (numKey && buyIndex.get(numKey)) || [];
    const r = reconcileCardBuyQuotes(card, buyEntries, now, { cacheEntries: (numKey && cacheByNum.get(numKey)) || [], retainedBefore });
    stats.variantsFresh += r.variantsFresh;
    stats.variantsRetained += r.variantsRetained;
    if (r.fresh) {
      if (!card.buyPriceHistory || typeof card.buyPriceHistory !== 'object') card.buyPriceHistory = {};
      const key = historyDateKey(Date.parse(r.fresh.timestamp), timeZone);
      // 既有歷史紀錄不改寫：同一觀測日已有紀錄則保留原值。
      if (!Object.hasOwn(card.buyPriceHistory, key)) card.buyPriceHistory[key] = r.fresh.price;
      else if (card.buyPriceHistory[key] !== r.fresh.price) stats.historyKept = (stats.historyKept || 0) + 1;
      stats.cardsFresh += 1;
    } else if (r.retained) {
      stats.cardsRetained += 1;
    }
  }
  // Run proof (review N5): exactly what this merge proved, bound to the bytes it read. Internal
  // artifact metadata (stripped from every published profile). regen-buy-alignment.mjs uses it
  // to REPRODUCE these fresh / retained decisions and history keys byte-for-byte, instead of
  // re-deciding from snapshot age (which would turn retained quotes back into "fresh").
  // N7: bind every retained quote — covered ones to the bound source entries (regen re-checks
  // them against the same files), carried ones (newer than any bound entry; from an earlier
  // run's capture) by digest.
  let audit = auditRetainedQuotes(db, cacheByNum, { now, runStartedAt, freshByNum: buyIndex });
  for (let pass = 0; audit.violations.size > 0 && pass < 5; pass += 1) {
    // By construction the merge never produces these. If it ever does, fail CLOSED: the quote
    // cannot be certified against its evidence, so it is not shown (never shown as new either).
    console.warn(`[merge-buy] ${audit.violations.size} retained quote(s) failed the evidence audit and were cleared: ${[...audit.violations].slice(0, 5).map(([k, why]) => `${k.replace('\u0000', ' ')}=${why}`).join(', ')}`);
    clearRetainedViolations(db, audit.violations);
    audit = auditRetainedQuotes(db, cacheByNum, { now, runStartedAt, freshByNum: buyIndex });
  }
  if (audit.violations.size > 0) throw new Error('[merge-buy] retained evidence audit did not converge; refusing to certify the artifact');
  stats.retainedCovered = audit.covered;
  stats.retainedCarried = audit.carried;
  db.buyQuoteRun = {
    runStartedAt: runStartedAt == null ? null : new Date(runStartedAt).toISOString(),
    now: new Date(now).toISOString(),
    timeZone,
    sourceDigest: buySourceDigest(dir),
    retainedCarryDigest: audit.carryDigest,
  };
  return stats;
}

function main() {
  console.log('[merge-buy] Starting...');
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  const s = mergeBuyPricesInto(db);
  fs.writeFileSync(DB_PATH, `${JSON.stringify(db, null, 2)}\n`, 'utf-8');
  console.log(
    `[merge-buy] ✅ Done — 本輪買取卡號 ${s.buyIndexSize} 個；card 層級新報價 ${s.cardsFresh} 張、保留舊報價 ${s.cardsRetained} 張；版本層級新報價 ${s.variantsFresh} 筆、保留舊報價 ${s.variantsRetained} 筆（history 只記本輪新報價的觀測日）`
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

export {
  main as mergeBuyPrices,
  mergeBuyPricesInto,
  reconcileCardBuyQuotes,
  buildRetainedCandidatePool,
  sourceEvidenceCandidate,
  lastKnownBuyCandidate,
  runStartedAtMs,
  buildBuyIndex,
  buyPriceByToken,
  assignVariantBuyMatches,
  assignVariantBuyPrices,
  applyVariantBuyProvenance,
  representativeBuyPrice,
  representativeBuyEntry,
  isParallelOnlyRow,
  historyDateKey,
  processTimeZone,
  notFreshBoundEvidence,
  auditRetainedQuotes,
  clearRetainedViolations,
  retainedBoundMs,
  MAX_SOURCE_AGE_HOURS,
};
