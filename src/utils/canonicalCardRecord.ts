/**
 * canonicalCardRecord — the ONE raw-record → CardDetail payload mapper, plus the
 * exact-printing resolver that lets a saved `(cardNumber, printing)` pair open
 * the same canonical payload the search route produces.
 *
 * DIC-1430: Favorites used to hand CardDetail a reduced `DeckCard` (the deck
 * editor's shape), which carries no price, skills, stats or history — so tapping
 * a correctly priced favorite opened a detail view with no real market data.
 * Both entry points now build their payload here, so a field added for search
 * cannot silently go missing on the favorites route.
 *
 * Exact-printing identity is preserved end to end. The resolver matches the
 * saved printing token EXACTLY — never card-number-only, never a sibling
 * version — and the resolved payload's headline price is THAT printing's own
 * sell price. The card-number-level `sellPrice` is the minimum across every
 * printing of the number (see versionAlignment.ts), so copying it onto an
 * exact-printing payload would misreport a ¥3,480 parallel as its ¥50 sibling.
 * A printing the source prices ambiguously, or does not price at all, fails
 * closed to `null` so CardDetail renders its honest unavailable state instead of
 * a borrowed number.
 */

import { releaseCardFlags } from '../config/releaseFlags';
import { stripDisabledCardFields, type ReleaseCardFlags } from './cardReleaseFilter';
import { normalizeCardIdentity, resolveCardColorsWithNestedFallback } from './cardNormalization';
import { loadDatabaseJson, loadSeriesNamesJson } from './staticData';
import { adaptCardNumber, pickRepresentative, type RawCard } from './deckCardData';
import { buildSourcePrintings, canonicalPrinting, type SourceListing } from './printingIdentity';

export const COLOR_MAP: Record<string, string> = {
  white: '白色', blue: '藍色', green: '綠色', red: '紅色',
  purple: '紫色', yellow: '黃色', colorless: '無色',
};

/** One card row exactly as the shipped database.json stores it. */
export interface CardRecord {
  id: string; name: string; series: string; type: string; rarity: string;
  color: string; localImage?: string; officialImage?: string;
  sellPrice?: number | null; buyPrice?: number | null; yuyuName?: string; yuyuImage?: string;
  prices?: {
    name: string; sellPrice: number | null; rarity: string; buyPrice?: number | null;
    /** Art published on THIS listing. Part of the listing's identity, so two
     * listings that agree on label and price but not on art are two different
     * pieces of evidence, not one (DIC-1430). */
    imageUrl?: string;
  }[];
  priceHistory?: Record<string, number>;
  ytStats?: any;
  effects?: string[]; hp?: string; life?: string; arts?: string;
  nameZh?: string;
  skillsJp?: any; skillsZh?: any;
}

/** The canonical CardDetail payload. Every `CardDetail` route param is one of these. */
export interface CardResult {
  id: string; name: string; type: string; grade: string; rarity: string; sourceRarity: string;
  colors: string[]; colorNames: string[]; series: string[]; seriesNames: string[];
  tags: string[]; cardNumber: string; imageUrl: string;
  yuyuUrl: string; carousellUrl: string; officialUrl: string;
  yuyuPrice?: number | null;
  sellPrice?: number | null; buyPrice?: number | null; ytStats?: any;
  prices?: {
    name: string; sellPrice: number | null; rarity: string; buyPrice?: number | null;
    imageUrl?: string;
  }[];
  priceHistory?: Record<string, number>;
  searchKeywords?: string[];
  nameZh?: string;
  skillsJp?: any;
  skillsZh?: any;
  normalized?: any;
  yuyuPriceName?: string;
  yuyuImage?: string; officialImage?: string; localImage?: string;
  effects?: string[]; hp?: string; life?: string; arts?: string;
  /** Exact printing token (BASE / PARALLEL / PARALLEL/SIGN …), set only when the
   * caller opened a specific printing. Absent on card-number-level search hits. */
  printing?: string;
  /** The source's own listing label for `printing`, preserved verbatim. */
  printingLabel?: string;
}

export interface DatabaseSchema {
  cards: Record<string, CardRecord>;
  totalCards: number;
  lastUpdated: string;
}

/**
 * Raw database record → canonical CardDetail payload.
 *
 * This is the single place the detail-route fields are produced. Release-gated
 * fields are stripped here so no caller can leak a field the build disables.
 */
export function toCanonicalCardRecord(
  c: CardRecord,
  nameMap: Record<string, string>,
  flags: ReleaseCardFlags = releaseCardFlags(),
): CardResult {
  const id = c.id || '';
  const name = c.name || '';
  // DIC-1159 + DIC-1192 + CR #1: strict canonicalCardColors first (so raw
  // `◇` / `blue_red` cannot reach `t(\`color_${color}\`)`), fall through to
  // the permissive normaliser so DIC-1192's shipped `◇ → 無色` render still
  // lands at 1440×900. When the top-level source produces no colors (the
  // 2026-08-28 catalog sync now writes `"null"` at top level for the real
  // hBP04-087/088/hBP06-084 winners), fall back to the authoritative
  // ◇ token in `skillsJp.color` / `skillsZh.color` so those diamond
  // winners still render as colorless instead of dropping the label.
  const colors = resolveCardColorsWithNestedFallback(c);
  const colorNames = colors.map((x: string) => COLOR_MAP[x] || x);
  const series = c.series ? [c.series] : [];
  const seriesNames = series.map((s: string) => nameMap[s] || s);
  const cardNumber = (c as any).cardNumber || id;

  const normalized = normalizeCardIdentity(c);
  const rarity = (c.rarity || '').toUpperCase();

  // Use official image (400×559) first for sharp display, local image (100×140) as fallback
  const imageUrl = c.officialImage || c.localImage || '';

  return stripDisabledCardFields({
    id,
    name,
    cardNumber,
    type: normalized.category || '',
    grade: normalized.stage || '',
    normalized,
    rarity,
    sourceRarity: c.rarity || '',
    colors,
    colorNames,
    series,
    seriesNames,
    imageUrl,
    yuyuPrice: c.sellPrice || null,
    sellPrice: c.sellPrice ?? null,
    buyPrice: c.buyPrice ?? null,
    ytStats: c.ytStats ?? null,
    yuyuPriceName: c.yuyuName || '',
    prices: c.prices || [],
    priceHistory: c.priceHistory || {},
    yuyuImage: c.yuyuImage || '',
    officialImage: c.officialImage || '',
    localImage: c.localImage || '',
    effects: c.effects || [],
    hp: c.hp || '',
    life: c.life || '',
    arts: c.arts || '',
    skillsJp: (c as any).skillsJp,
    skillsZh: (c as any).skillsZh,
    searchKeywords: [c.name || '', '', ''],
    tags: [],
    nameZh: c.nameZh || '',
    yuyuUrl: `https://yuyu-tei.jp/sell/hocg/s/search?search_word=${encodeURIComponent(cardNumber)}`,
    carousellUrl: '',
    officialUrl: `https://hololive-official-cardgame.com/cardlist/?keyword=${encodeURIComponent(cardNumber)}&view=image`,
  }, flags);
}

/** Why an exact `(cardNumber, printing)` pair could not be resolved. Both
 * reasons are honest dead ends, never a reason to widen the match. */
export type CanonicalUnresolvedReason = 'unknown-card-number' | 'unknown-printing';

export type CanonicalCardResolution =
  | { status: 'ok'; card: CardResult }
  | { status: 'unresolved'; reason: CanonicalUnresolvedReason };

export interface CanonicalCardIndex {
  /**
   * Resolve a saved bookmark to its canonical detail payload.
   *
   * Synchronous by design: the caller loads the index once, so a tap navigates
   * in the same turn as the press rather than resolving in a later microtask.
   */
  resolve(cardNumber: string, printing: string): CanonicalCardResolution;
}

/**
 * Collapse the listings repeated across a card number's rows.
 *
 * Two listings that claim the same label at DIFFERENT prices are deliberately
 * both kept: that disagreement is what `buildSourcePrintings` reads to mark the
 * printing ambiguous and leave it unpriced (fail closed). Deduping by label
 * alone would hide it and invent a price the source never stated.
 *
 * `imageUrl` is part of that identity for the same reason (DIC-1430). Two
 * listings that agree on label and price but publish DIFFERENT art disagree
 * about what the printing looks like; collapsing them on a label+price key
 * would erase the disagreement and let the survivor's art be presented as
 * proven. Keeping both lets `buildSourcePrintings` mark the printing's image
 * ambiguous and show none.
 */
function dedupeListings(
  listings: NonNullable<CardRecord['prices']>,
): NonNullable<CardRecord['prices']> {
  const seen = new Set<string>();
  const out: NonNullable<CardRecord['prices']> = [];
  for (const listing of listings) {
    if (!listing) continue;
    const key = `${listing.name ?? ''}|${listing.sellPrice ?? ''}|${listing.buyPrice ?? ''}`
      + `|${listing.imageUrl ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(listing);
  }
  return out;
}

let cache: CanonicalCardIndex | null = null;
let inflight: Promise<CanonicalCardIndex> | null = null;

/**
 * Pure raw-records → exact-printing index. Kept separate from the fetch/cache
 * wrapper — the same split `adaptDatabase` / `loadCardDatabase` already uses in
 * deckCardData.ts — so the resolution rules can be regression-tested directly
 * against constructed listing evidence, including the conflicting-art case the
 * shipped catalog does not currently contain.
 */
export function buildCanonicalCardIndex(
  rawCards: (CardRecord & RawCard)[],
  nameMap: Record<string, string>,
): CanonicalCardIndex {
  const byNumber = new Map<string, (CardRecord & RawCard)[]>();
  for (const raw of rawCards) {
    const key = raw.cardNumber;
    if (!key) continue;
    const list = byNumber.get(key);
    if (list) list.push(raw);
    else byNumber.set(key, [raw]);
  }

  // Adapting a card number walks every listing it ships, so memoize per number:
  // a favorites list of 200 bookmarks otherwise re-adapts on every tap.
  const memo = new Map<string, CanonicalCardResolution>();

  return {
    resolve(cardNumber, printing) {
      const want = canonicalPrinting(printing);
      const memoKey = `${cardNumber}|${want}`;
      const hit = memo.get(memoKey);
      if (hit) return hit;

      const resolution = ((): CanonicalCardResolution => {
        const rows = byNumber.get(cardNumber);
        if (!rows || rows.length === 0) {
          return { status: 'unresolved', reason: 'unknown-card-number' };
        }
        // Same adapter the favorites row and the deck editor read, so the row a
        // user sees and the detail view they open can never disagree about which
        // printings exist or what they cost.
        const adapted = adaptCardNumber(rows);
        const match = adapted.cards.find((entry) => canonicalPrinting(entry.printing) === want);
        if (!match) return { status: 'unresolved', reason: 'unknown-printing' };

        const rep = pickRepresentative(rows) as CardRecord & RawCard;
        // A card number is stored as one row per set it was printed in, and only
        // SOME of those rows carry the listing set. The elected representative
        // supplies the display fields but may list just its own printing —
        // hBP01-024's representative carries only the ¥120 BASE listing while the
        // number really ships BASE / PARALLEL/HR / PARALLEL/hBP07. Handing that
        // row's `prices` to CardDetail would build a version list that does not
        // contain the printing the user opened, and label a ¥3,480 parallel with
        // its ¥120 sibling. Merge the listings across every row — the same input
        // `adaptCardNumber` derived the printings from — so the version list and
        // the resolved printing can never disagree.
        //
        // The merge is fed THROUGH the mapper rather than spliced onto its result
        // so the release filter still strips per-listing buy fields on a build
        // that disables them.
        const merged: CardRecord = {
          ...rep,
          prices: dedupeListings(
            rows.flatMap((row) => row.prices ?? []) as NonNullable<CardRecord['prices']>,
          ),
        };
        const base = toCanonicalCardRecord(merged, nameMap);
        // The exact printing's OWN sell price. `adaptCardNumber` emits no record
        // for an unpriced or ambiguously priced printing, so this stays null and
        // CardDetail shows its unavailable state — never the card number's
        // cross-printing minimum.
        const record = adapted.priceRecords.find((r) => canonicalPrinting(r.version) === want);
        const exactPrice = record ? record.price : null;

        // The exact printing's OWN artwork. `base.imageUrl` is the elected
        // representative row's card-level image, which is IDENTICAL for every
        // printing of the number — so hBP01-024's ¥3,480 PARALLEL/HR opened
        // showing the same picture as its ¥50 PARALLEL/hBP07 sibling. The source
        // publishes art per LISTING, so the printing the user opened must carry
        // the image that printing's own listing proved.
        //
        // Three cases, and only the first may show printing-specific art:
        //   * one proven image → that image;
        //   * listings disagree → fail closed to NO image rather than an
        //     arbitrary pick (86 printings in the shipped catalog disagree);
        //   * the printing published no listing image at all → the card-level
        //     image stands. That is not a cross-printing borrow: it is the only
        //     thing the source states, and it is what the 257 card numbers with
        //     no listings at all (the synthetic UNLISTED base) rely on.
        const sourcePrinting = buildSourcePrintings(
          rows.flatMap((row) => row.prices ?? []) as SourceListing[],
        ).find((p) => canonicalPrinting(p.printing) === want);
        const exactImage = sourcePrinting?.imageUrl
          ?? (sourcePrinting?.imageAmbiguous ? '' : base.imageUrl);

        return {
          status: 'ok',
          card: {
            ...base,
            printing: match.printing,
            printingLabel: match.printingLabel,
            imageUrl: exactImage,
            yuyuPrice: exactPrice,
            sellPrice: exactPrice,
            yuyuPriceName: match.printingLabel || base.yuyuPriceName || '',
          },
        };
      })();

      memo.set(memoKey, resolution);
      return resolution;
    },
  };
}

/**
 * Load (and cache) the exact-printing index over the shipped catalog.
 *
 * Reads through the same platform-split loader the rest of the app uses, so
 * native reads its bundled copy instead of a page-relative fetch (DIC-972).
 */
export async function loadCanonicalCardIndex(): Promise<CanonicalCardIndex> {
  if (cache) return cache;
  if (inflight) return inflight;

  inflight = (async () => {
    const [db, nameMap] = await Promise.all([loadDatabaseJson(), loadSeriesNamesJson()]);
    const rawCards = Object.values((db as DatabaseSchema).cards || {}) as (CardRecord & RawCard)[];
    cache = buildCanonicalCardIndex(rawCards, nameMap || {});
    return cache;
  })();

  return inflight;
}
