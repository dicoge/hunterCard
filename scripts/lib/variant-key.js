/**
 * variant-key.js — 單一 canonical 版本 key，供爬蟲 / merge / build / 測試共用（DIC-856）
 *
 * 同一卡號有多個版本（原印 base / 平行 parallel / 簽名 signed，另有帶產品碼的替代平行版）。
 * 店家收購價「有分版本」，但兩邊用不同 taxonomy 標記：
 *   - 買取來源（fullahead / torecolo）：以 rarity 代碼標版本（SR/UR/OUR/HR/SEC…），
 *     無代碼的純卡號 key 代表原印版；另有 HSD06/HBP04 等「產品／套牌碼」標替代平行版。
 *   - 遊々亭 prices[]：以名稱後綴標版本（無後綴=原印、(パラレル)=平行、
 *     (パラレル/サイン)=簽名、(パラレル/HR)、(パラレル/hSD06) 等帶標籤的替代平行版）。
 *
 * 對齊原則（CR DIC-857 要求）：以**精確 token**（正規化 rarity/產品碼）對齊，
 *   - 不做 class 內 Math.max、不把不同 rarity 塌成同一 class 再取價；
 *   - token 一律「完全相等」比對，禁止子字串命中（HSD06 不得被當成 S、hBP07 不得被當成 P）；
 *   - 對不到精確 token → fail closed（null），絕不借別版價。
 *
 * canonical token 語意：
 *   ''(空字串) → base（原印版），只吃來源「無 rarity 的純卡號」收購價。
 *   'SEC'      → signed（簽名版 / パラレル/サイン），只吃 SEC。
 *   'HR'|'UR'|'SR'|'OUR'|'OSR'|'RR' → 標準平行版 token，只吃完全相同 rarity。
 *   'HSD06'|'HBP04'… → 產品／套牌碼標替代平行版，只吃完全相同產品碼。
 *   null       → 無標籤的純 (パラレル)：版本不精確，交由 merge 判斷唯一性，否則 fail closed。
 */

// 已知 hOCG rarity 代碼（精確比對用；不做子字串）。
const RARITY_CODES = ['SEC', 'OUR', 'OSR', 'UR', 'SR', 'HR', 'RR', 'OC', 'SY', 'C', 'R', 'U', 'S', 'P'];
const RARITY_SET = new Set(RARITY_CODES);

// 標準平行版 rarity；純 (パラレル) 只可能對上這些（不含 SEC 簽名、不含產品碼替代版）。
const PARALLEL_RARITIES = new Set(['OUR', 'OSR', 'UR', 'SR', 'HR', 'RR']);

// 來源標記別名：【PR】與【P】都對應 database 的 "P"。
const RARITY_ALIASES = { PR: 'P' };

// 產品／套牌碼（作為替代平行版 token，如 HSD06 / HBP04 / HBP07 / HSD12）。純字母 rarity 不會誤中。
const PRODUCT_CODE_RE = /^H[A-Z]{1,4}\d{2,}$/;

/** 從任意字串抽第一個卡號（如 hBP04-005），統一大寫；抓不到回 null。 */
function normalizeCardNumber(str) {
  const m = String(str ?? '').match(/h[A-Za-z]{1,4}\d{0,3}-\d{2,}/i);
  return m ? m[0].toUpperCase() : null;
}

/**
 * 精確正規化版本 token：
 *   - null / 空 / 純卡號無 rarity → ''（原印版 / bare）。
 *   - 完全等於某已知 rarity 代碼（處理【】、PR→P）→ 該代碼。
 *   - 符合產品／套牌碼樣式（HSD06…）→ 原樣保留（替代平行版 token）。
 *   - 其餘一律 ''（fail safe：不由子字串臆測版本，HSD06≠S、hBP07≠P、P_03≠P）。
 */
function normalizeRarity(raw) {
  if (raw == null) return '';
  let up = String(raw).trim().toUpperCase();
  if (up === '') return '';
  const braced = up.match(/【\s*([A-Z0-9]+)\s*】/);
  if (braced) up = braced[1];
  up = RARITY_ALIASES[up] || up;
  if (RARITY_SET.has(up)) return up;
  if (PRODUCT_CODE_RE.test(up)) return up;
  return '';
}

/** 由 rarity 代碼判 canonical 版本類別（僅 SEC→signed、標準平行→parallel，其餘 base）。 */
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
 * 由遊々亭版本名稱判 canonical 版本：{ versionClass, token }。
 *   - サイン → { signed, 'SEC' }
 *   - (パラレル/<標籤>) → { parallel, 正規化 token }；標籤無法對應已知代碼時給不可命中的 sentinel
 *     （'#…'），代表「有明確替代版標籤但無對應收購來源」→ 之後 fail closed，不落入純平行池。
 *   - 純 (パラレル) → { parallel, null }（版本不精確）
 *   - 其餘 → { base, '' }
 */
function classifyVariant(name) {
  const n = String(name || '');
  if (n.includes('サイン')) return { versionClass: 'signed', token: 'SEC' };
  if (n.includes('パラレル')) {
    const m = n.match(/パラレル\s*\/\s*([^)\/]+)/);
    if (m) {
      const tok = normalizeRarity(m[1]);
      return { versionClass: 'parallel', token: tok || `#${m[1].trim().toUpperCase()}` };
    }
    return { versionClass: 'parallel', token: null };
  }
  return { versionClass: 'base', token: '' };
}

/**
 * 由「來源 rarity 欄位（優先）或 key 尾綴」得出精確來源 token 與版本類別。
 * bare（無 rarity）→ token ''。
 */
function sourceToken(rarityField, keySuffix) {
  const raw = rarityField != null && String(rarityField).length > 0 ? rarityField : keySuffix;
  const cleaned = String(raw ?? '').replace(/^[-_\s]+/, '');
  return normalizeRarity(cleaned);
}

/**
 * 回傳版本名帶明確「パラレル/<rarity>」標籤時的精確 token（標準平行 rarity 才回傳），否則 null。
 * 保留給既有呼叫端；核心對齊改用 classifyVariant。
 */
function rarityTokenInName(name) {
  const { token } = classifyVariant(name);
  return token && RARITY_SET.has(token) && PARALLEL_RARITIES.has(token) ? token : null;
}

/** canonical 版本 key：正規化卡號 | 版本類別 | token（'' → base、null → parallel）。 */
function canonicalVariantKey(cardNumber, name) {
  const num = normalizeCardNumber(cardNumber) || String(cardNumber || '').toUpperCase();
  const { versionClass, token } = classifyVariant(name);
  const t = token == null ? 'parallel' : token === '' ? 'base' : token;
  return `${num}|${versionClass}|${t}`;
}

export {
  RARITY_CODES,
  RARITY_SET,
  PARALLEL_RARITIES,
  PRODUCT_CODE_RE,
  normalizeCardNumber,
  normalizeRarity,
  versionClassFromRarity,
  versionClassFromName,
  classifyVariant,
  sourceToken,
  rarityTokenInName,
  canonicalVariantKey,
};
