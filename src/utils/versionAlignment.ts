/**
 * 版本對齊邏輯（純函式，無 React / store 依賴，方便單元 / 回歸測試）
 *
 * 背景：資料庫每張卡的 sellPrice 是「該卡號所有版本的最低價」，各版本的實際價格都在
 * card.prices 內。要正確顯示「這張卡這個版本」的價格，必須對齊到 prices 裡對應的那一
 * 筆，而不是拿最低價彙總值。
 *
 * 版本身分一律取自來源掛牌名稱（printingIdentity），與組牌器共用同一個模型。這裡刻意
 * 不再由 rarity 推論版本（早期的 SEC→パラレル/サイン、SR→パラレル 等對應是資料來源沒
 * 有說過的臆測，DIC-1013）。
 *
 * 關鍵原則：當來源本身無法唯一辨識版本時，絕不可靜默挑一筆當成已對齊 —— 必須回報
 * confident=false，由呼叫端標示「版本待確認」。
 */

import {
  printingFromLabel, pickDefaultPrintingIndex, buildSourcePrintings, BASE_PRINTING,
} from './printingIdentity';

export interface PriceVersion {
  name: string;
  /** 與組牌器共用的來源版本代碼（BASE / PARALLEL / PARALLEL/SIGN …）。 */
  printing: string;
  sellPrice: number | null;
  buyPrice: number | null; // 對齊到此版本的店家收購價；對不到為 null（fail closed，不借別版）
}

/** 對齊邏輯只需要這些欄位；CardInfo 與資料庫原始 record 都符合此結構。
 * rarity 不在其中：它描述整個卡號，不指向任何一筆掛牌。 */
export interface CardLike {
  series?: string;
  sellPrice?: number | null;
  buyPrice?: number | null;
  prices?: Array<{ name?: string; sellPrice: number | null; buyPrice?: number | null } | null | undefined> | null;
}

export interface VersionResolution {
  index: number; // versions 陣列中的預設 index（versions 非空時恆為合法值）
  confident: boolean; // 僅當來源能唯一辨識這個版本時為 true
  reason: string; // 說明（confident=false 時顯示於 UI）
}

/**
 * 從一張卡的 prices 陣列建出可選版本清單（去重）。
 * 沒有明細時退回單一版本（用卡的 series 當標籤、sellPrice 當價格）。
 *
 * 每個版本都帶上與組牌器共用的 printing 代碼（printingIdentity），兩邊對「這是哪一個版本」
 * 的判定因此永遠一致。此處刻意保留同名不同價的兩筆掛牌（讓使用者自行挑選），組牌器那側則
 * 因為無法辨識而 fail closed 不計價 —— 兩者用同一個版本模型，只是各自的採用門檻不同。
 */
export function buildPriceVersions(card: CardLike): PriceVersion[] {
  const raw = (card.prices || []).filter(
    (p): p is { name?: string; sellPrice: number | null; buyPrice?: number | null } =>
      !!p && p.sellPrice != null && p.sellPrice > 0
  );
  const seen = new Set<string>();
  const versions: PriceVersion[] = [];
  for (const p of raw) {
    const key = `${p.name || ''}|${p.sellPrice}`;
    if (seen.has(key)) continue;
    seen.add(key);
    versions.push({
      name: p.name || card.series || '版本',
      printing: printingFromLabel(p.name || ''),
      sellPrice: p.sellPrice,
      buyPrice: p.buyPrice ?? null,
    });
  }
  if (versions.length === 0) {
    // 無明細版本 → 退回卡號層級。單一版本時 card.buyPrice 即該版本收購價（未混版）。
    versions.push({
      name: card.series || '估值',
      printing: BASE_PRINTING,
      sellPrice: card.sellPrice ?? null,
      buyPrice: card.buyPrice ?? null,
    });
  }
  return versions;
}

/**
 * 選出這張卡的預設版本。
 *
 * 這裡刻意先用 buildSourcePrintings 收斂成「一個版本代碼一筆」的檢視，再交給
 * pickDefaultPrintingIndex —— 與組牌器走的是同兩個函式、同一份輸入形狀。差別只在顯示：
 * 卡片頁保留每一筆掛牌讓使用者自己挑，組牌器只留可辨識的那些。若這裡改用未收斂的清單，
 * 同代碼多筆掛牌（來源真的會出現兩筆同名「白銀ノエル(パラレル)」¥3,480／¥500）在這側
 * 會是「最低價候選」、在組牌器那側卻是無價的，兩邊就會挑到不同版本。
 *
 * 選中的版本代碼若有多筆掛牌，回報 confident=false 由使用者自行挑選，絕不替他選價格。
 */
export function resolveVersionForCard(versions: PriceVersion[]): VersionResolution {
  if (versions.length === 0) return { index: 0, confident: false, reason: '無價格版本' };
  if (versions.length === 1) return { index: 0, confident: true, reason: '單一版本' };

  const printings = buildSourcePrintings(versions);
  const chosen = printings[pickDefaultPrintingIndex(printings)];
  const index = versions.findIndex(v => v.printing === chosen.printing);
  if (chosen.ambiguous) {
    return { index, confident: false, reason: `來源有多筆「${chosen.label}」掛牌，無法辨識版本` };
  }
  return { index, confident: true, reason: `來源版本 ${chosen.printing}` };
}
