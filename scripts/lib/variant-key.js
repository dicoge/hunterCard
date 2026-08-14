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

// 一般集內 rarity（非 premium 印次）。必須與 src/utils/deckVariants.ts 的
// BASE_RARITY_ORDER 是同一份詞彙 —— test-deck-variants.mjs 有 parity 斷言。
const BASE_RARITIES = new Set(['OC', 'C', 'U', 'R', 'RR', 'SR']);

// 來源標記別名：【PR】與【P】都對應 database 的 "P"。
const RARITY_ALIASES = { PR: 'P' };

// 產品／套牌碼（作為替代平行版 token，如 HSD06 / HBP04 / HBP07 / HSD12）。純字母 rarity 不會誤中。
const PRODUCT_CODE_RE = /^H[A-Z]{1,4}\d{2,}$/;

// 「有標記但不在 allowlist」的來源版本 sentinel：既非 bare、也非任何已知/產品碼 token，
// 因此對不到任何 variant（fail closed）。與純卡號無標記（bare '' → 原印版）嚴格區分，
// 避免未知標記的收購價塌成原印價、或被 Math.max 蓋掉真正的原印價（CR DIC-857）。
const UNKNOWN_TOKEN = '#UNKNOWN';

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

/**
 * 卡片自身 rarity 欄位 → canonical rarity 代碼。爬蟲以序號區分同集重複 rarity
 * （P_02 / 02_HR / C_2 / C_re 都是 P / HR / C / C 這個印次），剝掉序號才是代碼。
 * 這是 src/utils/deckVariants.ts `normalizeRarityCode` 的逐字 twin：兩邊必須對
 * 整個 production rarity 詞彙給出相同結果（test-deck-variants.mjs parity 斷言）。
 */
function normalizeRarityCode(raw) {
  return String(raw ?? '')
    .normalize('NFKC')
    .trim()
    .toUpperCase()
    .replace(/^\d+_/, '')
    .replace(/_(?:\d+|RE)$/, '');
}

/** rarity 代碼是否在已知詞彙內（已知 rarity 或產品／套牌碼）。不在 → 不可信。 */
function isKnownRarityCode(code) {
  return code !== '' && (RARITY_SET.has(code) || PRODUCT_CODE_RE.test(code));
}

/** premium 印次（SEC / HR / UR / S / P / 產品碼…）：來源會以同名 token 明確標記。 */
function isPremiumRarityCode(code) {
  return !BASE_RARITIES.has(code);
}

/** 這一列是否為卡號自身原印集的印次（series === 卡號的集前綴）。 */
function isOwnSetPrinting(cardNumber, series) {
  const prefix = String(cardNumber ?? '').split('-')[0].toLowerCase();
  return prefix !== '' && String(series ?? '').toLowerCase() === prefix;
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
 * 判定一段來源版本標記字串屬於哪一類：
 *   - 空（null / 純卡號無尾綴）→ { kind:'bare', token:'' }：真正無標記的原印版。
 *   - 完全等於已知 rarity / 產品碼 → { kind:'known', token }：精確版本。
 *   - 非空但不在 allowlist（如 XYZ / P_03 這類無法證明的標記）→ { kind:'unknown', token:UNKNOWN_TOKEN }：
 *     **有標記但不可信**，必須 fail closed，絕不可塌成 bare 與真正原印版合併／取 max。
 */
function classifySourceRarity(raw) {
  const s = raw == null ? '' : String(raw).trim();
  if (s === '') return { kind: 'bare', token: '' };
  const norm = normalizeRarity(s);
  if (norm !== '') return { kind: 'known', token: norm };
  return { kind: 'unknown', token: UNKNOWN_TOKEN };
}

/**
 * 由「來源 rarity 欄位（優先）或 key 尾綴」得出精確來源 token。
 *   - 無標記 → ''（bare / 原印版）。
 *   - 已知 rarity / 產品碼 → 該精確 token。
 *   - 有標記但非 allowlist → UNKNOWN_TOKEN（fail closed，對不到任何 variant）。
 */
function sourceToken(rarityField, keySuffix) {
  const rawField = rarityField != null ? String(rarityField) : '';
  const raw = rawField.length > 0 ? rawField : keySuffix != null ? String(keySuffix) : '';
  const cleaned = raw.replace(/^[-_\s]+/, '');
  return classifySourceRarity(cleaned).token;
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
  BASE_RARITIES,
  PRODUCT_CODE_RE,
  UNKNOWN_TOKEN,
  normalizeCardNumber,
  normalizeRarity,
  normalizeRarityCode,
  isKnownRarityCode,
  isPremiumRarityCode,
  isOwnSetPrinting,
  versionClassFromName,
  classifyVariant,
  classifySourceRarity,
  sourceToken,
  rarityTokenInName,
  canonicalVariantKey,
};
