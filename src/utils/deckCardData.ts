// Loads the card database for the deck editor and adapts it to the editor's
// DeckCard / PriceRecord shapes. Mirrors the fetch('/data/database.json')
// pattern already used by HomeScreen (web serves data from public/). Kept out of
// the screen component so it can be reused and reasoned about independently.

import type { DeckCard, PriceRecord } from './deckRules';
import { eligibleZone } from './deckRules';
import {
  BASE_PRINTING, buildSourcePrintings, type SourceListing, type SourcePrinting,
} from './printingIdentity';
import { buildFacetIndex, type CardFacets } from './cardCatalog';

export interface RawPriceEntry extends SourceListing {
  /** merge-buy-prices.js provenance for the store's acquisition price. Retained
   * for the card-market display; never an input to a deck cost. */
  buyPriceVersion?: string;
  buyPriceSource?: string;
  buyPriceTimestamp?: string;
}

export interface RawCard {
  id: string;
  cardNumber: string;
  name?: string;
  nameZh?: string;
  type?: string;
  rarity?: string;
  series?: string;
  sellPrice?: number | null;
  timestamp?: string;
  officialImage?: string;
  localImage?: string;
  skillsJp?: { cardType?: string; color?: string };
  skillsZh?: { cardType?: string; color?: string; name?: string };
  prices?: RawPriceEntry[];
}

export interface AdaptedCards {
  cards: DeckCard[];
  priceRecords: PriceRecord[];
}

export interface CardDatabase extends AdaptedCards {
  /** cardNumber → the player-facing filter/search facets of the visual picker */
  facets: Map<string, CardFacets>;
}

export const PRICE_SOURCE = 'yuyu-tei.jp';
export const PRICE_CURRENCY = 'JPY';

let cache: CardDatabase | null = null;
let inflight: Promise<CardDatabase> | null = null;

function toDeckCard(rep: RawCard, printing: SourcePrinting): DeckCard {
  return {
    id: `${rep.cardNumber}#${printing.printing}`,
    cardNumber: rep.cardNumber,
    name: rep.nameZh || rep.name || rep.cardNumber,
    printing: printing.printing,
    printingLabel: printing.label,
    series: rep.series || '',
    type: rep.type || '',
    cardTypeJp: rep.skillsJp?.cardType || '',
    imageUrl: rep.officialImage || rep.localImage || undefined,
  };
}

const UNLISTED: SourcePrinting = {
  printing: BASE_PRINTING, label: '', sellPrice: null, buyPrice: null, ambiguous: false,
};

function isClassifiable(raw: RawCard): boolean {
  return eligibleZone(toDeckCard(raw, UNLISTED)) !== null;
}

// A card number is stored as one row per set it was printed in, and those rows
// carry the SAME listing set — the printing identity lives in the listings, not
// in the row. One row is elected to supply the display fields: a row the rules
// engine can place in a zone wins (some reprint rows ship an empty `type`), then
// the card number's own set, then the lowest id so the choice is deterministic.
export function pickRepresentative(rows: RawCard[]): RawCard {
  const ownSet = String(rows[0]?.cardNumber ?? '').split('-')[0].toLowerCase();
  return rows.slice().sort((a, b) => (
    Number(isClassifiable(b)) - Number(isClassifiable(a))
    || Number((b.series || '').toLowerCase() === ownSet) - Number((a.series || '').toLowerCase() === ownSet)
    || String(a.id).localeCompare(String(b.id))
  ))[0];
}

/**
 * Adapt every row of ONE card number into its printings and their prices.
 *
 * Only the player-facing SELL price becomes a PriceRecord. The store's buy
 * (acquisition) price is a different commercial quantity — what a shop pays the
 * player — so it can never stand in for what a missing card costs to acquire,
 * and is deliberately left out of this pipeline (DIC-1013 §5). It stays
 * available to the card-market display, which reads the raw listings directly.
 *
 * A printing whose sell price the source states ambiguously stays unpriced
 * rather than borrowing a sibling's price.
 */
export function adaptCardNumber(rows: RawCard[]): AdaptedCards {
  const rep = pickRepresentative(rows);
  const listings = rows.flatMap((row) => row.prices ?? []);
  const printings = buildSourcePrintings(listings);
  const timestamp = rep.timestamp || '';

  const cards: DeckCard[] = [];
  const priceRecords: PriceRecord[] = [];
  for (const printing of printings.length > 0 ? printings : [UNLISTED]) {
    cards.push(toDeckCard(rep, printing));
    if (printing.sellPrice !== null) {
      priceRecords.push({
        cardNumber: rep.cardNumber,
        version: printing.printing,
        price: printing.sellPrice,
        currency: PRICE_CURRENCY,
        source: PRICE_SOURCE,
        timestamp,
      });
    }
  }
  return { cards, priceRecords };
}

// Same (cardNumber, printing) reached with conflicting prices → ambiguous, drop
// ALL of them rather than trust an arbitrary pick (fail closed). Kept as a
// database-level guard for rows that reach the adapter through another path.
export function dropConflictingPrices(records: PriceRecord[]): PriceRecord[] {
  const byKey = new Map<string, Set<number>>();
  for (const r of records) {
    const key = `${r.cardNumber}|${r.version}`;
    const set = byKey.get(key) ?? new Set();
    set.add(r.price);
    byKey.set(key, set);
  }
  return records.filter((r) => (byKey.get(`${r.cardNumber}|${r.version}`)?.size ?? 0) === 1);
}

// Pure raw-database → editor-shape adapter. Kept separate from the fetch/cache
// wrapper so the raw-database-to-PriceRecord boundary can be regression-tested
// directly against real ambiguous data (DIC-952).
export function adaptDatabase(rawCards: RawCard[]): CardDatabase {
  const byNumber = new Map<string, RawCard[]>();
  for (const raw of rawCards) {
    const list = byNumber.get(raw.cardNumber);
    if (list) list.push(raw);
    else byNumber.set(raw.cardNumber, [raw]);
  }
  const cards: DeckCard[] = [];
  const priceRecords: PriceRecord[] = [];
  for (const rows of byNumber.values()) {
    const adapted = adaptCardNumber(rows);
    cards.push(...adapted.cards);
    priceRecords.push(...adapted.priceRecords);
  }
  return {
    cards,
    priceRecords: dropConflictingPrices(priceRecords),
    facets: buildFacetIndex(rawCards),
  };
}

export async function loadCardDatabase(): Promise<CardDatabase> {
  if (cache) return cache;
  if (inflight) return inflight;

  inflight = (async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch('/data/database.json', { signal: controller.signal });
      if (!res.ok) throw new Error('Failed to load card database');
      const db = await res.json();
      const rawCards = Object.values(db.cards || {}) as RawCard[];
      cache = adaptDatabase(rawCards);
      return cache;
    } finally {
      clearTimeout(timeoutId);
    }
  })();

  return inflight;
}
