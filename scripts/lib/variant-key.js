/**
 * variant-key.js — canonical 版本正規化，供爬蟲 / merge / database 共用（DIC-856）
 *
 * 背景：同一卡號有多個版本（普通 / 平行 / 簽名），店家收購價「有分版本」但兩邊用不同
 * taxonomy 標記：
 *   - 買取來源（fullahead / torecolo）用 rarity 代碼標版本：null/C/R/U/S/P=普通、
 *     UR/OUR/OSR/SR/HR/RR=平行、SEC=簽名。
 *   - 遊々亭 prices[] 用「名稱後綴」標版本：無後綴=普通、(パラレル)=平行、
 *     (パラレル/サイン)=簽名，另有 (パラレル/HR)、(パラレル/hBP07) 等帶標籤的替代平行版。
 *
 * 這支把兩種 taxonomy 收斂到「單一 canonical 版本類別」：'base' | 'parallel' | 'signed'，
 * 加上可選的 rarity token（如 HR），讓買取價能精確對齊到對應版本，對不到時 fail closed，
 * 絕不跨版本借價。
 */

// 已知 hOCG rarity 代碼（由長 / 特定往短排，避免子字串誤判：OUR 不該被 UR 命中、OSR 不該被 SR 命中）。
const RARITY_CODES = ['SEC', 'OSR', 'OUR', 'RR', 'HR', 'UR', 'SR', 'OC', 'SY', 'C', 'R', 'U', 'S', 'P'];

// 平行版代表的高 rarity；其餘（C/R/U/S/P/OC/SY…）視為普通版。SEC 另歸簽名版。
const PARALLEL_RARITIES = new Set(['OUR', 'OSR', 'UR', 'SR', 'HR', 'RR']);

// 來源商品名的稀有度標記別名：【PR】與【P】都對應 database 的 "P"。
const RARITY_ALIASES = { PR: 'P' };

/** 從任意字串抽第一個卡號（如 hBP04-005），統一大寫；抓不到回 null。 */
function normalizeCardNumber(str) {
  const m = String(str ?? '').match(/h[A-Za-z]{1,4}\d{0,3}-\d{2,}/i);
  return m ? m[0].toUpperCase() : null;
}

/**
 * 把來源 rarity 字串正規化成核心代碼（大寫）。處理【】標記、PR→P 別名、
 * 以及夾雜套牌前後綴的寫法（如 "02_HR"、"P_02"）。不是已知 rarity（例如把套牌代碼
 * HSD06 誤當 rarity）就回空字串，交由呼叫端落到普通版，不可臆測成某個版本。
 */
function normalizeRarity(raw) {
  if (raw == null) return '';
  let up = String(raw).toUpperCase();
  const braced = up.match(/【\s*([A-Z0-9]+)\s*】/);
  if (braced) up = braced[1];
  up = RARITY_ALIASES[up] || up;
  for (const code of RARITY_CODES) {
    if (up.includes(code)) return RARITY_ALIASES[code] || code;
  }
  return '';
}

/** 由 rarity 代碼判 canonical 版本類別。 */
function versionClassFromRarity(raw) {
  const r = normalizeRarity(raw);
  if (r === 'SEC') return 'signed';
  if (PARALLEL_RARITIES.has(r)) return 'parallel';
  return 'base';
}

/** 由遊々亭版本名稱判 canonical 版本類別。 */
function versionClassFromName(name) {
  const n = String(name || '');
  if (n.includes('サイン')) return 'signed';
  if (n.includes('パラレル')) return 'parallel';
  return 'base';
}

/**
 * 若版本名帶「パラレル/<rarity>」形式的明確 rarity 標籤（如 パラレル/HR），回該 rarity 代碼，
 * 否則 null。用來把帶標籤的替代平行版跟對應 rarity 的買取價精確對上（而非落到普通平行版）。
 */
function rarityTokenInName(name) {
  const m = String(name || '').match(/パラレル\s*\/\s*([A-Za-z0-9]+)/);
  if (!m) return null;
  const r = normalizeRarity(m[1]);
  return r || null;
}

/** canonical 版本 key：正規化卡號 + 版本類別（+ 可選 rarity token）。 */
function canonicalVariantKey(cardNumber, versionClass, token) {
  const num = normalizeCardNumber(cardNumber) || String(cardNumber || '').toUpperCase();
  return token ? `${num}|${versionClass}|${token}` : `${num}|${versionClass}`;
}

export {
  RARITY_CODES,
  PARALLEL_RARITIES,
  normalizeCardNumber,
  normalizeRarity,
  versionClassFromRarity,
  versionClassFromName,
  rarityTokenInName,
  canonicalVariantKey,
};
