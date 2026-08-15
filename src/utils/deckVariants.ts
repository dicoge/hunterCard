// Low-cost default printing resolver (DIC-1004 §A, corrected by DIC-1013).
//
// A card number's printings come from the SOURCE LISTINGS — plain, パラレル,
// パラレル/サイン … — not from the dataset's row-level rarity, which describes the
// card number as a whole and would default hBP04-005 to its ¥69,800 signed
// printing when the source clearly lists a plain ¥980 one. See
// src/utils/printingIdentity.ts for how those printings are derived.
//
// This module is the SINGLE resolver for the deck's default choice: the deck
// editor's search / add flow, the one-time 套用低配版本 normalization, existing
// draft migration and tournament import (DIC-1000) all go through it, so they
// cannot drift apart.

import {
  eligibleZone, resolveExactPrice,
  type DeckCard, type DeckSlot, type Deck, type DeckZone, type PriceRecord,
} from './deckRules';
import { BASE_PRINTING, isPlainPrinting } from './printingIdentity';

/** Deterministic tie-break used whenever price cannot decide: plain printings
 * first, then printing token, then card id. */
function comparePrintings(a: DeckCard, b: DeckCard): number {
  return (
    Number(isPlainPrinting(b.printing)) - Number(isPlainPrinting(a.printing)) ||
    a.printing.localeCompare(b.printing) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Pick the MVP default printing among the printings of ONE card number.
 *
 * 1. Only playable printings are considered (an entry the rules engine cannot
 *    place in a zone can never be a deck default). A card number whose every
 *    printing is unplayable — the committed dataset has untyped promo rows such
 *    as `202_hPR` — resolves to null so it is never offered as a deck card.
 * 2. Plain printings win outright over premium ones — never default to a
 *    パラレル / サイン printing while a plain listing exists.
 * 3. Inside the winning tier, the lowest EXACT sell price wins, compared only
 *    against prices in the same currency. A printing with no exact sell price
 *    never borrows another printing's price (DIC-945 #6): it simply loses to the
 *    priced candidates, and when nothing is priced the deterministic first plain
 *    printing wins and the estimate stays unpriced.
 */
export function resolveLowCostVariant(
  variants: DeckCard[],
  priceRecords: PriceRecord[],
): DeckCard | null {
  const playable = variants.filter((c) => eligibleZone(c) !== null);
  if (playable.length === 0) return null;

  const plain = playable.filter((c) => isPlainPrinting(c.printing));
  const tier = (plain.length > 0 ? plain : playable).slice().sort(comparePrintings);

  const priced: Array<{ card: DeckCard; price: number; currency: string }> = [];
  for (const card of tier) {
    const p = resolveExactPrice(card.cardNumber, card.printing, priceRecords);
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
  /** every printing of this card number, in source-listing order */
  variants: DeckCard[];
}

/** Collapse a card list into one row per card number, each exposing its
 * low-cost default. Card numbers with no playable printing are omitted entirely,
 * so search can never offer one. First-seen card-number order is preserved. */
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

function mergeSlots(slots: DeckSlot[], resolve: (card: DeckCard) => DeckCard): DeckSlot[] {
  const out: DeckSlot[] = [];
  const seen = new Map<string, DeckSlot>();
  for (const slot of slots) {
    const card = resolve(slot.card);
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

/** Replace each slot's printing with its low-cost default, preserving quantity
 * and zone. A replacement that would change the slot's zone is skipped, and
 * slots that collapse onto the same printing merge their quantities. */
export function normalizeSlotsToLowCost(
  slots: DeckSlot[],
  zone: DeckZone,
  index: Map<string, DeckCard>,
): DeckSlot[] {
  return mergeSlots(slots, (card) => {
    const candidate = index.get(card.cardNumber);
    return candidate && eligibleZone(candidate) === zone ? candidate : card;
  });
}

/** A slot persisted before DIC-1013 keys its version off the row-level rarity
 * and carries no printing at all. */
export function isLegacySlotCard(card: DeckCard): boolean {
  return typeof card.printing !== 'string' || card.printing === '';
}

/**
 * Move slots persisted under the pre-DIC-1013 rarity model onto real printings.
 *
 * Zones and quantities are the player's data and are always preserved; only the
 * printing identity is rewritten, and only for slots that have none. A slot that
 * already names a printing is left exactly as it is, so a deliberately picked
 * premium printing is never silently downgraded. The global collection is NOT
 * touched: owning an SEC copy does not prove ownership of the plain printing, so
 * re-keying inventory would fabricate ownership (DIC-1013 §3).
 */
export function migrateSlotsToPrintings(
  slots: DeckSlot[],
  zone: DeckZone,
  index: Map<string, DeckCard>,
): DeckSlot[] {
  return mergeSlots(slots, (card) => {
    if (!isLegacySlotCard(card)) return card;
    const candidate = index.get(card.cardNumber);
    if (candidate && eligibleZone(candidate) === zone) return candidate;
    // Card number no longer in the dataset (or no longer playable in this zone):
    // keep the slot on the unmarked printing so the draft survives intact. It
    // has no price record, so it shows as 無精確版本價格 rather than a wrong cost.
    return { ...card, printing: BASE_PRINTING, printingLabel: '' };
  });
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
