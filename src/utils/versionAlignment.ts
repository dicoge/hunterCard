/**
 * 版本對齊邏輯（純函式，無 React / store 依賴，方便單元 / 回歸測試）
 *
 * 背景：資料庫每張卡的 sellPrice 是「該卡號所有版本的最低價」，而各 rarity/パラレル/
 * サイン 版的實際價格都在 card.prices 內。要正確顯示「這張卡這個版本」的價格，必須依
 * 卡的 rarity 對齊到 prices 裡對應的那一筆，而不是拿最低價彙總值。
 *
 * 關鍵原則（對應 CR 要求）：當 rarity 無法唯一對齊到某個版本時，絕不可靜默退回最低價
 * 並當成已對齊 —— 必須回報 confident=false，由呼叫端標示「版本待確認」。
 */

export interface PriceVersion {
  name: string;
  sellPrice: number | null;
}

/** 對齊邏輯只需要這些欄位；CardInfo 與資料庫原始 record 都符合此結構。 */
export interface CardLike {
  rarity?: string;
  series?: string;
  sellPrice?: number | null;
  prices?: Array<{ name?: string; sellPrice: number | null } | null | undefined> | null;
}

export interface VersionResolution {
  index: number; // versions 陣列中的最佳猜測 index（versions 非空時恆為合法值）
  confident: boolean; // 僅當 rarity 能唯一對齊到單一版本時為 true
  reason: string; // 說明（confident=false 時顯示於 UI）
}

/**
 * 從一張卡的 prices 陣列建出可選版本清單（去重）。
 * 沒有明細時退回單一版本（用卡的 series 當標籤、sellPrice 當價格）。
 */
export function buildPriceVersions(card: CardLike): PriceVersion[] {
  const raw = (card.prices || []).filter(
    (p): p is { name?: string; sellPrice: number | null } =>
      !!p && p.sellPrice != null && p.sellPrice > 0
  );
  const seen = new Set<string>();
  const versions: PriceVersion[] = [];
  for (const p of raw) {
    const key = `${p.name || ''}|${p.sellPrice}`;
    if (seen.has(key)) continue;
    seen.add(key);
    versions.push({ name: p.name || card.series || '版本', sellPrice: p.sellPrice });
  }
  if (versions.length === 0) {
    versions.push({ name: card.series || '估值', sellPrice: card.sellPrice ?? null });
  }
  return versions;
}

// rarity 代碼由「較長 / 較特定」往後排，避免子字串誤判（如 OUR 不該被 UR 命中、OSR 不該被 SR 命中）。
const RARITY_CODES = ['SEC', 'OSR', 'OUR', 'HR', 'RR', 'UR', 'SR', 'R', 'U', 'C', 'S', 'P'];

/** 從可能夾雜套牌前後綴的 rarity 字串（如 "02_HR"、"P_02"）抽出核心 rarity 代碼。 */
export function coreRarity(raw?: string): string {
  const up = (raw || '').toUpperCase();
  for (const code of RARITY_CODES) {
    if (up.includes(code)) return code;
  }
  return '';
}

// 高 rarity 的代表版本是「平行版（パラレル）」；低 rarity 的代表版本是「原印版（非平行）」。
const PARALLEL_REPRESENTATIVE = new Set(['OUR', 'OSR', 'UR', 'SR', 'HR', 'RR']);
const BASE_REPRESENTATIVE = new Set(['R', 'U', 'C', 'S', 'P']);

function hasRarityToken(name: string, rarity: string): boolean {
  const n = (name || '').toUpperCase();
  return (
    n.includes(`/${rarity}`) ||
    n.includes(`(${rarity})`) ||
    n.includes(`(${rarity}/`) ||
    n.includes(` ${rarity})`)
  );
}
const isSigned = (name: string) => (name || '').includes('サイン');
const isParallel = (name: string) => (name || '').includes('パラレル');
// 「純平行版」：有パラレル、非簽名，且パラレル後面沒有再接 "/其他標記"（排除 パラレル/HR、パラレル/hBP07 等）。
const isPlainParallel = (name: string) =>
  isParallel(name) && !isSigned(name) && !/パラレル\s*\//.test(name || '');
const isBaseVersion = (name: string) => !isParallel(name) && !isSigned(name);

/**
 * 依卡的 rarity 對齊到 prices 裡對應的版本。
 * 回傳 confident=false 時，呼叫端應標示「版本待確認」而非把 index 的價格當成已對齊。
 */
export function resolveVersionForCard(card: CardLike, versions: PriceVersion[]): VersionResolution {
  if (versions.length === 0) return { index: 0, confident: false, reason: '無價格版本' };
  if (versions.length === 1) return { index: 0, confident: true, reason: '單一版本' };

  const rarity = coreRarity(card.rarity);
  const idxOf = (v: PriceVersion) => versions.indexOf(v);

  // 無法唯一對齊時的預選 index：優先平行版、否則最高價 —— 絕不預設最低價（那正是要修的混版 bug）。
  const seed = (): number => {
    const pool = versions.filter(v => isParallel(v.name));
    const list = pool.length ? pool : versions;
    let best = list[0];
    for (const v of list) if ((v.sellPrice || 0) > (best.sellPrice || 0)) best = v;
    return versions.indexOf(best);
  };

  // 1) 版本名直接帶 rarity 標記（如 HR → "(パラレル/HR)"）。
  if (rarity) {
    const tok = versions.filter(v => hasRarityToken(v.name, rarity));
    if (tok.length === 1) return { index: idxOf(tok[0]), confident: true, reason: `版本名標記 ${rarity}` };
    if (tok.length > 1) return { index: seed(), confident: false, reason: `rarity ${rarity} 有多個同標版本` };
  }

  // 2) SEC → 簽名平行版（パラレル/サイン）為代表。
  if (rarity === 'SEC') {
    const signed = versions.filter(v => isSigned(v.name));
    if (signed.length === 1) return { index: idxOf(signed[0]), confident: true, reason: 'SEC → パラレル/サイン' };
    if (signed.length > 1) return { index: seed(), confident: false, reason: 'SEC 有多個サイン版本' };
  }

  // 3) 高 rarity（OUR/OSR/UR/SR/HR/RR）→ 平行版。
  if (PARALLEL_REPRESENTATIVE.has(rarity)) {
    const plain = versions.filter(v => isPlainParallel(v.name));
    if (plain.length === 1) return { index: idxOf(plain[0]), confident: true, reason: `${rarity} → パラレル` };
    const par = versions.filter(v => isParallel(v.name));
    if (par.length === 1) return { index: idxOf(par[0]), confident: true, reason: `${rarity} → 唯一平行版本` };
    return { index: seed(), confident: false, reason: `${rarity} 有多個平行版本，無法唯一對齊` };
  }

  // 4) 低 rarity（R/U/C/S/P）→ 原印（非平行）版本。
  if (BASE_REPRESENTATIVE.has(rarity)) {
    const base = versions.filter(v => isBaseVersion(v.name));
    if (base.length === 1) return { index: idxOf(base[0]), confident: true, reason: `${rarity} → 原印版本` };
    return {
      index: seed(),
      confident: false,
      reason: base.length === 0 ? `${rarity} 無原印版本` : `${rarity} 有多個原印/重印版本`,
    };
  }

  return { index: seed(), confident: false, reason: rarity ? `rarity ${rarity} 無對齊規則` : 'rarity 缺失' };
}
