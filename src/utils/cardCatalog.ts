// Player-facing catalog facets for the visual card picker (DIC-1067).
//
// The picker must let a player build a deck by LOOKING at cards, so every filter
// offered here is derived from data the committed catalog actually carries. No
// option is ever synthesised: `collectFilterOptions` returns only values present
// in the loaded database, and a dimension with no data yields an empty list the
// UI hides rather than an empty dropdown that looks broken.
//
// This module is pure and framework-free so it can be unit tested with plain
// node, the same way deckRules / deckVariants are.

import type { DeckCard } from './deckRules';
import { isPlainPrinting } from './printingIdentity';
import type { VariantGroup } from './deckVariants';

/** Player-facing card class. `main` in deck terms splits into the two classes a
 * player actually browses by, so the 主牌組 tab can offer a holomen/support
 * sub-filter without re-deriving anything. */
export type CardCategory = 'oshi' | 'holomen' | 'support' | 'yell';

export type ParallelMode = 'all' | 'hasBase' | 'hasParallel' | 'noParallel';

export type SearchMode = 'name' | 'text' | 'number';

/** The five single colours the game uses, plus the colourless ◇ marker. A card's
 * colour string concatenates them for multicolour cards ("白緑"), so membership
 * is tested per character rather than by string equality. */
export const COLOR_TOKENS = ['白', '緑', '赤', '青', '紫', '黄', '◇'] as const;

export interface CardFacets {
  cardNumber: string;
  category: CardCategory | null;
  /** every colour the card carries; a multicolour card lists each one */
  colors: string[];
  /** normalized rarity tokens across every row of this card number */
  rarities: string[];
  /** product codes this card number belongs to or was reprinted in */
  sets: string[];
  /** lower-cased names in every language the catalog carries */
  names: string[];
  /** lower-cased skill / arts / keyword text, JP and ZH concatenated */
  text: string;
}

export interface CatalogRow {
  cardNumber: string;
  name?: string;
  nameZh?: string;
  rarity?: string;
  series?: string;
  type?: string;
  skillsJp?: unknown;
  skillsZh?: unknown;
}

// ── Facet extraction ──────────────────────────────────────────────────────

export function categoryOf(cardType: string): CardCategory | null {
  const t = (cardType || '').toLowerCase();
  // 推しホロメン is a superstring of ホロメン, so it must be tested first.
  if (t.includes('推し') || t.includes('oshi')) return 'oshi';
  if (t.includes('エール') || t.includes('yell') || t.includes('cheer')) return 'yell';
  if (t.includes('サポート') || t.includes('support')) return 'support';
  if (t.includes('ホロメン') || t.includes('holomen') || t.includes('buzz')) return 'holomen';
  return null;
}

/** The deck zone a category may legally be placed in — the picker uses this to
 * offer only cards the rules engine can actually accept into the open tab. */
export function zoneOfCategory(category: CardCategory): 'oshi' | 'main' | 'yell' {
  if (category === 'oshi') return 'oshi';
  if (category === 'yell') return 'yell';
  return 'main';
}

/** Split a raw colour string into its individual colours. Multicolour cards store
 * their colours concatenated ("白緑"), so a 白 filter and a 緑 filter must both
 * match that card. Unknown characters are dropped rather than guessed at. */
export function splitColors(raw: string): string[] {
  const out: string[] = [];
  for (const ch of String(raw || '')) {
    if ((COLOR_TOKENS as readonly string[]).includes(ch) && !out.includes(ch)) out.push(ch);
  }
  return out;
}

/** Collapse the catalog's rarity spellings onto one token per rarity. The scrape
 * suffixes/prefixes a reprint's rarity with its printing round ("P_02", "02_C",
 * "C_re"); those are the same rarity to a player and must not each become their
 * own filter chip. */
export function normalizeRarity(raw: string): string {
  const parts = String(raw || '')
    .trim()
    .split(/[_\-/\s]+/)
    .filter((p) => p && !/^\d+$/.test(p) && p.toLowerCase() !== 're');
  return parts.join('_').toUpperCase();
}

/** Product code of a card number ("hBP04-060" → "hBP04"). */
export function setOfCardNumber(cardNumber: string): string {
  return String(cardNumber || '').split('-')[0];
}

// A row's `series` is the set the ROW was scraped from, which is a real product
// for a reprint ("hBP07") but is also used for internal scrape buckets such as
// "ent07" that no player would recognise. A handful of rows also carry a
// malformed card number that has no product prefix at all ("202"). Only values
// shaped like a product code become a filter option, so the product list never
// contains a fake one.
function isProductCode(series: string): boolean {
  return /^h[A-Za-z]+\d*[A-Za-z0-9]*$/.test(series) && /^h[A-Z]/.test(series);
}

function pushUnique(list: string[], value: string): void {
  if (value && !list.includes(value)) list.push(value);
}

function collectText(skills: unknown, sink: string[]): void {
  if (!skills) return;
  if (typeof skills === 'string') {
    sink.push(skills);
    return;
  }
  if (Array.isArray(skills)) {
    for (const item of skills) collectText(item, sink);
    return;
  }
  if (typeof skills === 'object') {
    for (const [key, value] of Object.entries(skills as Record<string, unknown>)) {
      // cardNumber/name are searched through the dedicated name+number modes;
      // including them here would make every text query also match names.
      if (key === 'cardNumber' || key === 'name') continue;
      collectText(value, sink);
    }
  }
}

/** Build one facet record per card number, merging every row that shares it. */
export function buildFacetIndex(rows: CatalogRow[]): Map<string, CardFacets> {
  const index = new Map<string, CardFacets>();
  for (const row of rows) {
    const cardNumber = row.cardNumber;
    if (!cardNumber) continue;
    let facets = index.get(cardNumber);
    if (!facets) {
      facets = {
        cardNumber,
        category: null,
        colors: [],
        rarities: [],
        sets: [],
        names: [],
        text: '',
      };
      index.set(cardNumber, facets);
      const own = setOfCardNumber(cardNumber);
      if (isProductCode(own)) facets.sets.push(own);
    }

    const jp = (row.skillsJp || {}) as { cardType?: string; color?: string };
    const zh = (row.skillsZh || {}) as { cardType?: string; color?: string };
    facets.category = facets.category
      ?? categoryOf(jp.cardType || row.type || '')
      ?? categoryOf(zh.cardType || '');

    for (const color of splitColors(jp.color || zh.color || '')) pushUnique(facets.colors, color);
    pushUnique(facets.rarities, normalizeRarity(row.rarity || ''));
    if (row.series && isProductCode(row.series)) pushUnique(facets.sets, row.series);
    for (const name of [row.name, row.nameZh, (zh as { name?: string }).name]) {
      if (name) pushUnique(facets.names, String(name).toLowerCase());
    }

    const sink: string[] = [];
    collectText(row.skillsJp, sink);
    collectText(row.skillsZh, sink);
    if (sink.length > 0) {
      facets.text = `${facets.text} ${sink.join(' ')}`.toLowerCase().trim();
    }
  }
  return index;
}

// ── Filter options ────────────────────────────────────────────────────────

export interface FilterOptions {
  sets: string[];
  colors: string[];
  rarities: string[];
}

const SET_FAMILY_ORDER = ['hBP', 'hSD', 'hY', 'hBD', 'hPR'];

function setSortKey(code: string): [number, string] {
  const family = SET_FAMILY_ORDER.findIndex((f) => code.startsWith(f));
  return [family === -1 ? SET_FAMILY_ORDER.length : family, code];
}

const RARITY_ORDER = ['C', 'U', 'R', 'RR', 'SR', 'HR', 'UR', 'SEC', 'S', 'P', 'SY', 'OC', 'OSR', 'OUR'];

/**
 * Every filter value the LOADED catalog can actually produce, in display order.
 *
 * Options are derived from the facets in play rather than from a hardcoded list,
 * so a dimension the current dataset does not carry simply does not appear —
 * requirement 5's "no fake options unsupported by the current catalog".
 */
export function collectFilterOptions(facets: Iterable<CardFacets>): FilterOptions {
  const sets = new Set<string>();
  const colors = new Set<string>();
  const rarities = new Set<string>();
  for (const f of facets) {
    for (const s of f.sets) sets.add(s);
    for (const c of f.colors) colors.add(c);
    for (const r of f.rarities) if (r) rarities.add(r);
  }
  return {
    sets: Array.from(sets).sort((a, b) => {
      const [fa, ca] = setSortKey(a);
      const [fb, cb] = setSortKey(b);
      return fa - fb || ca.localeCompare(cb);
    }),
    colors: COLOR_TOKENS.filter((c) => colors.has(c)),
    rarities: Array.from(rarities).sort((a, b) => {
      const ia = RARITY_ORDER.indexOf(a);
      const ib = RARITY_ORDER.indexOf(b);
      return (ia === -1 ? RARITY_ORDER.length : ia) - (ib === -1 ? RARITY_ORDER.length : ib)
        || a.localeCompare(b);
    }),
  };
}

// ── Filtering ─────────────────────────────────────────────────────────────

export interface PickerCriteria {
  query: string;
  mode: SearchMode;
  /** empty = every category */
  categories: CardCategory[];
  sets: string[];
  colors: string[];
  rarities: string[];
  parallel: ParallelMode;
}

export const EMPTY_CRITERIA: PickerCriteria = {
  query: '',
  mode: 'name',
  categories: [],
  sets: [],
  colors: [],
  rarities: [],
  parallel: 'all',
};

/** True when nothing but the category tab is narrowing the results — the reset
 * control only needs to be offered when this is false. */
export function hasActiveFilters(criteria: PickerCriteria): boolean {
  return criteria.query.trim() !== ''
    || criteria.sets.length > 0
    || criteria.colors.length > 0
    || criteria.rarities.length > 0
    || criteria.parallel !== 'all';
}

function matchesParallel(variants: DeckCard[], mode: ParallelMode): boolean {
  if (mode === 'all') return true;
  const hasParallel = variants.some((v) => !isPlainPrinting(v.printing));
  if (mode === 'hasParallel') return hasParallel;
  if (mode === 'noParallel') return !hasParallel;
  return variants.some((v) => isPlainPrinting(v.printing));
}

function matchesQuery(
  group: VariantGroup,
  facets: CardFacets | undefined,
  query: string,
  mode: SearchMode,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (mode === 'number') return group.cardNumber.toLowerCase().includes(q);
  if (mode === 'text') return (facets?.text ?? '').includes(q);
  // Name mode also matches the deck card's own display name so a card number
  // absent from the facet index (an unscraped row) is still findable by name.
  return (facets?.names ?? []).some((n) => n.includes(q))
    || group.card.name.toLowerCase().includes(q);
}

/**
 * Apply the combined search + filter state.
 *
 * Every dimension is an AND across dimensions and an OR within one, which is
 * what a player expects from a chip-style filter bar: picking 白 and 青 widens,
 * picking 白 and hBP04 narrows.
 */
export function filterCatalog(
  groups: VariantGroup[],
  facets: Map<string, CardFacets>,
  criteria: PickerCriteria,
): VariantGroup[] {
  const out: VariantGroup[] = [];
  for (const group of groups) {
    const f = facets.get(group.cardNumber);
    if (criteria.categories.length > 0) {
      if (!f?.category || !criteria.categories.includes(f.category)) continue;
    }
    if (criteria.sets.length > 0 && !criteria.sets.some((s) => f?.sets.includes(s))) continue;
    if (criteria.colors.length > 0 && !criteria.colors.some((c) => f?.colors.includes(c))) continue;
    if (criteria.rarities.length > 0 && !criteria.rarities.some((r) => f?.rarities.includes(r))) continue;
    if (!matchesParallel(group.variants, criteria.parallel)) continue;
    if (!matchesQuery(group, f, criteria.query, criteria.mode)) continue;
    out.push(group);
  }
  return out;
}
