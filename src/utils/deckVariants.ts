// Low-cost default printing resolver (DIC-1004 §A).
//
// The dataset stores every printing of a card number as its OWN entry, keyed by
// `${cardNumber}_${series}` and tagged with that printing's rarity — hBP01-024
// exists as C/hBP01 (the original set printing), HR/hBP07 + HR/ent07 (parallels)
// and P/hPR (promo). The MVP must build a playable, low-cost deck, so a premium
// printing is never the default while a base printing of the same card number
// exists. Explicit version picking is a later enhancement.
//
// This module is the SINGLE resolver for that choice: the deck editor's search /
// add flow, the one-time 套用低配版本 normalization and any future tournament
// import (DIC-1000) all go through it, so they cannot drift apart.

import {
  eligibleZone, resolveExactPrice,
  type DeckCard, type DeckSlot, type Deck, type DeckZone, type PriceRecord,
} from './deckRules';

/** Ordinary set rarities, cheapest first. Anything outside this list counts as a
 * premium printing (SEC, S/signature, OUR, OSR, P/PR, UR, HR, SY …). */
const BASE_RARITY_ORDER = ['OC', 'C', 'U', 'R', 'RR', 'SR'];

/** Premium printings, ordered so the resolver stays deterministic when a card
 * number has no base printing at all (e.g. an oshi that only ships as SEC). */
const PREMIUM_RARITY_ORDER = ['HR', 'SY', 'P', 'PR', 'S', 'UR', 'OSR', 'OUR', 'SEC'];

// The scraper disambiguates repeated rarities within a set by tacking on an
// index — `P_02`, `C_2`, `02_HR`, `C_re` all denote the plain P / C / HR / C
// printing. Strip those affixes so rarity ranking sees the real code.
export function normalizeRarityCode(rarity: string): string {
  return (rarity ?? '')
    .normalize('NFKC')
    .trim()
    .toUpperCase()
    .replace(/^\d+_/, '')
    .replace(/_(?:\d+|RE)$/, '');
}

export function isPremiumPrinting(rarity: string): boolean {
  return !BASE_RARITY_ORDER.includes(normalizeRarityCode(rarity));
}

function rarityRank(rarity: string): number {
  const code = normalizeRarityCode(rarity);
  const base = BASE_RARITY_ORDER.indexOf(code);
  if (base !== -1) return base;
  const premium = PREMIUM_RARITY_ORDER.indexOf(code);
  return BASE_RARITY_ORDER.length + (premium === -1 ? PREMIUM_RARITY_ORDER.length : premium);
}

// The printing whose series equals the card number's own set (hBP01-024 in set
// hBP01) is the original set printing; reprints carry another set's series.
function isOriginalSetPrinting(card: DeckCard): boolean {
  return card.series === card.cardNumber.split('-')[0];
}

/** Deterministic tie-break used whenever price cannot decide: cheapest rarity
 * tier, then the original set printing, then card id. */
function comparePrintings(a: DeckCard, b: DeckCard): number {
  return (
    rarityRank(a.rarity) - rarityRank(b.rarity) ||
    Number(isOriginalSetPrinting(b)) - Number(isOriginalSetPrinting(a)) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Pick the MVP default printing among the variants of ONE card number.
 *
 * 1. Only playable printings are considered (an entry the rules engine cannot
 *    place in a zone can never be a deck default).
 * 2. Base printings win outright over premium ones — never default to SEC / S /
 *    OUR / OSR / P / UR while a base printing exists.
 * 3. Inside the winning tier, the lowest EXACT-version price wins, compared only
 *    against prices in the same currency. A printing with no exact-version price
 *    never borrows another version's price (DIC-945 #6): it simply loses to the
 *    priced candidates, and when nothing is priced the deterministic
 *    lowest-rarity printing wins and the estimate stays unpriced.
 */
export function resolveLowCostVariant(
  variants: DeckCard[],
  priceRecords: PriceRecord[],
): DeckCard | null {
  if (variants.length === 0) return null;

  const playable = variants.filter((c) => eligibleZone(c) !== null);
  const pool = playable.length > 0 ? playable : variants;
  const base = pool.filter((c) => !isPremiumPrinting(c.rarity));
  const tier = (base.length > 0 ? base : pool).slice().sort(comparePrintings);

  const priced: Array<{ card: DeckCard; price: number; currency: string }> = [];
  for (const card of tier) {
    const p = resolveExactPrice(card.cardNumber, card.rarity, priceRecords);
    if (p.status === 'ok') priced.push({ card, price: p.price, currency: p.currency });
  }
  if (priced.length === 0) return tier[0];

  // Prices in different currencies are never compared; the deterministically
  // first priced printing fixes the currency context for the comparison.
  const currency = priced[0].currency;
  let best = priced[0];
  for (const entry of priced) {
    if (entry.currency === currency && entry.price < best.price) best = entry;
  }
  return best.card;
}

export interface VariantGroup {
  cardNumber: string;
  /** the MVP default — lowest-cost playable printing of this card number */
  card: DeckCard;
  /** every printing of this card number, in database order */
  variants: DeckCard[];
}

/** Collapse a card list into one row per card number, each exposing its
 * low-cost default. First-seen card-number order is preserved. */
export function groupVariantsByCardNumber(
  cards: DeckCard[],
  priceRecords: PriceRecord[],
): VariantGroup[] {
  const byNumber = new Map<string, DeckCard[]>();
  for (const card of cards) {
    const list = byNumber.get(card.cardNumber);
    if (list) list.push(card);
    else byNumber.set(card.cardNumber, [card]);
  }
  const groups: VariantGroup[] = [];
  for (const [cardNumber, variants] of byNumber) {
    const card = resolveLowCostVariant(variants, priceRecords);
    if (card) groups.push({ cardNumber, card, variants });
  }
  return groups;
}

/** Search grouped rows. Matches any printing's fields so a promo-series query
 * still finds the card, but always yields the group's low-cost default. */
export function searchVariantGroups(
  groups: VariantGroup[],
  query: string,
  limit = 60,
): VariantGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: VariantGroup[] = [];
  for (const g of groups) {
    const hit = g.cardNumber.toLowerCase().includes(q)
      || g.variants.some((c) => c.name.toLowerCase().includes(q) || c.series.toLowerCase().includes(q));
    if (hit) {
      out.push(g);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** cardNumber → low-cost default, for normalizing decks built before this rule. */
export function buildLowCostIndex(groups: VariantGroup[]): Map<string, DeckCard> {
  return new Map(groups.map((g) => [g.cardNumber, g.card]));
}

/** Replace each slot's printing with its low-cost default, preserving quantity
 * and zone. A replacement that would change the slot's zone is skipped, and
 * slots that collapse onto the same printing merge their quantities. */
export function normalizeSlotsToLowCost(
  slots: DeckSlot[],
  zone: DeckZone,
  index: Map<string, DeckCard>,
): DeckSlot[] {
  const out: DeckSlot[] = [];
  const seen = new Map<string, DeckSlot>();
  for (const slot of slots) {
    const candidate = index.get(slot.card.cardNumber);
    const card = candidate && eligibleZone(candidate) === zone ? candidate : slot.card;
    const existing = seen.get(card.id);
    if (existing) {
      existing.qty += slot.qty;
      continue;
    }
    const next: DeckSlot = { card, qty: slot.qty };
    seen.set(card.id, next);
    out.push(next);
  }
  return out;
}

/** How many slots would 套用低配版本 rewrite — 0 means the deck is already on
 * low-cost printings, so the action can stay hidden. */
export function countLowCostDrift(deck: Deck, index: Map<string, DeckCard>): number {
  let drift = 0;
  for (const zone of ['oshi', 'main', 'yell'] as DeckZone[]) {
    for (const slot of deck[zone]) {
      const candidate = index.get(slot.card.cardNumber);
      if (candidate && candidate.id !== slot.card.id && eligibleZone(candidate) === zone) drift += 1;
    }
  }
  return drift;
}
