/**
 * Player-facing labels for a card number's printings (2026-10-19 user report:
 * hBP03-029 さくらみこ showed "[SR] さくらみこ(パラレル)" / "[SR] さくらみこ(パラレル/hEB01)"
 * and two R rows — four Japanese shop listing names, no picture, so the zh player could
 * not tell the four real printings apart).
 *
 * Identity is NOT decided here: the printing token still comes from
 * printingIdentity.buildSourcePrintings (one entry per printing; a printing whose own
 * listings disagree on price stays unpriced). This module only turns the shop's
 * Japanese descriptors into a Chinese label and keeps the original listing name next
 * to it, so the label stays traceable to the source. Proper names (set titles) have no
 * official Chinese name in the source data and are kept verbatim, never invented.
 */
import { buildSourcePrintings, printingFromLabel, type SourceListing } from './printingIdentity';

export type DisplayLanguage = 'zh' | 'ja';

const ZH_MARKERS: Record<string, string> = {
  'パラレル': '平行版',
  'サイン': '簽名版',
  '箔押し': '燙金版',
  'S仕様': 'S規格版',
};
const ERRATA = new Set(['エラッタ前', 'エラッタ後']);
const SET_CODE = /^h[A-Za-z]+\d*[A-Za-z0-9]*$/;

/** The descriptors inside a listing name's parentheses, in order. */
function descriptors(listingName: string): string[] {
  const norm = (listingName ?? '').normalize('NFKC');
  return Array.from(norm.matchAll(/[(（]([^)）]*)[)）]/g))
    .flatMap((m) => m[1].split('/'))
    .map((part) => part.trim())
    .filter((part) => part && !ERRATA.has(part));
}

/**
 * zh: `平行版・hEB01 收錄` / `一般版`; ja: the source's own descriptors
 * (`パラレル/hEB01`, `通常`). Set codes and unknown descriptors are kept verbatim.
 */
export function printingDisplayLabel(listingName: string, language: DisplayLanguage = 'zh'): string {
  const parts = descriptors(listingName);
  if (language === 'ja') return parts.length ? parts.join('/') : '通常';
  const treatments = parts.filter((p) => !SET_CODE.test(p)).map((p) => ZH_MARKERS[p] ?? p);
  const sets = parts.filter((p) => SET_CODE.test(p));
  const out = [treatments.length ? treatments.join('・') : '一般版'];
  for (const code of sets) out.push(`${code} 收錄`);
  return out.join('・');
}

// Longest first so ライブスタートデッキ is not read as スタートデッキ.
const ZH_PRODUCT_TYPES: Array<[string, string]> = [
  ['オフィシャルホロカコレクション', '官方收藏集'],
  ['ライブスタートデッキ', 'Live 起始牌組'],
  ['スタートエールセット', '起始應援組'],
  ['エクストラブースター', '額外補充包'],
  ['ブースターパック', '補充包'],
  ['スタートデッキ', '起始牌組'],
  ['ツインウエハース', '雙層威化餅贈卡'],
  ['PRカード', 'PR 宣傳卡'],
];

// What the SET CODE itself states: product family and, for numbered packs, the number
// (hBP03 = booster pack no. 3). This is a description, not a translated title.
const ZH_CODE_FAMILY: Array<[RegExp, (n: number) => string]> = [
  [/^hBP(\d+)$/, (n) => `補充包 第 ${n} 彈`],
  [/^hEB(\d+)$/, (n) => `額外補充包 第 ${n} 彈`],
  [/^hSD(\d+)$/, () => '起始牌組'],
  [/^hYS(\d+)$/, () => '起始應援組'],
  [/^h(?:CO|PC)(\d+)$/, () => '官方收藏集'],
  [/^hWF(\d+)$/, () => '雙層威化餅贈卡'],
  [/^hPR$/, () => 'PR 宣傳卡'],
];

export interface SeriesLabel {
  /** the player-facing label: zh = Chinese description + set code; ja = the source title */
  primary: string;
  /** the source's own (Japanese) title, shown as 原名; null when there is nothing more to show */
  original: string | null;
}

/**
 * zh primary series label for a set code and its source title (2026-10-19, PM acceptance
 * gap: the Chinese UI must not lead with a Japanese title). No official Chinese set titles
 * exist in the data, so the primary label describes what the code states —
 * `補充包 第 3 彈（hBP03）`, `額外補充包 第 1 彈（hEB01）`, `Live 起始牌組（hSD16）` — and the
 * untranslated title is returned separately as `original`, never presented as a translation.
 * ja: the source title as before.
 */
export function seriesLabel(
  code: string | null | undefined,
  sourceTitle: string | null | undefined,
  language: DisplayLanguage = 'zh',
): SeriesLabel {
  const c = (code ?? '').trim();
  const title = (sourceTitle ?? '').trim();
  if (language === 'ja') return { primary: title || c, original: null };
  const typed = ZH_PRODUCT_TYPES.find(([jp]) => title.startsWith(jp));
  let desc: string | null = null;
  // a Live start deck says so only in its title
  if (typed && typed[0] === 'ライブスタートデッキ') desc = typed[1];
  for (const [re, describe] of ZH_CODE_FAMILY) {
    if (desc) break;
    const m = c.match(re);
    if (m) desc = describe(Number(m[1]));
  }
  if (!desc && typed) desc = typed[1];
  const primary = desc ? (c ? `${desc}（${c}）` : desc) : (c ? `${c} 系列` : title);
  const original = title && title !== c && title !== primary ? title : null;
  return { primary, original };
}

export interface PrintingDisplayRow {
  printing: string;
  /** zh/ja player label (see printingDisplayLabel) */
  label: string;
  /** the shop's own listing name, kept for traceability */
  sourceLabel: string;
  rarity: string | null;
  sellPrice: number | null;
  /** this printing's OWN listing picture, or null (never a sibling's) */
  imageUrl: string | null;
  /** the printing's listings disagree on price → no price shown */
  ambiguous: boolean;
}

/**
 * One row per printing. Repeated listings of the SAME printing collapse into one row
 * (the raw listings are not modified); different printings — SR vs R, hBP03 vs hEB01 —
 * always stay separate rows, whatever their names or prices.
 */
export function buildPrintingDisplayRows(
  listings: readonly (SourceListing | null | undefined)[] | null | undefined,
  language: DisplayLanguage = 'zh',
): PrintingDisplayRow[] {
  const list = (listings ?? []).filter((l): l is SourceListing => !!l);
  return buildSourcePrintings(list).map((p) => {
    // The listing's rarity is provenance only; shown when this printing's listings agree.
    const rarities = new Set(
      list.filter((l) => printingFromLabel((l.name ?? '').trim()) === p.printing)
        .map((l) => (l.rarity ?? '').trim())
        .filter(Boolean),
    );
    return {
      printing: p.printing,
      label: printingDisplayLabel(p.label, language),
      sourceLabel: p.label,
      rarity: rarities.size === 1 ? Array.from(rarities)[0] : null,
      sellPrice: p.sellPrice,
      imageUrl: p.imageAmbiguous ? null : (p.imageUrl ?? null),
      ambiguous: p.ambiguous,
    };
  });
}
