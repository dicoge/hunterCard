// Loads the card database for the deck editor and adapts it to the editor's
// DeckCard / PriceRecord shapes. Mirrors the fetch('/data/database.json')
// pattern already used by HomeScreen (web serves data from public/). Kept out of
// the screen component so it can be reused and reasoned about independently.

import type { DeckCard, PriceRecord } from './deckRules';

export interface RawCard {
  id: string;
  cardNumber: string;
  name?: string;
  nameZh?: string;
  type?: string;
  rarity?: string;
  series?: string;
  sellPrice?: number | null;
  officialImage?: string;
  localImage?: string;
  skillsJp?: { cardType?: string };
  prices?: Array<{ name?: string; sellPrice?: number | null; rarity?: string }>;
}

export interface CardDatabase {
  cards: DeckCard[];
  priceRecords: PriceRecord[];
}

let cache: CardDatabase | null = null;
let inflight: Promise<CardDatabase> | null = null;

export function adaptCard(raw: RawCard): DeckCard {
  return {
    id: raw.id,
    cardNumber: raw.cardNumber,
    name: raw.nameZh || raw.name || raw.cardNumber,
    rarity: raw.rarity || '',
    series: raw.series || '',
    type: raw.type || '',
    cardTypeJp: raw.skillsJp?.cardType || '',
    imageUrl: raw.officialImage || raw.localImage || undefined,
  };
}

// Build version-precise price records — FAIL CLOSED (DIC-952).
//
// A price may only claim a version when the SOURCE LISTING itself explicitly
// declares that version. The scraper's top-level `sellPrice` is the price of a
// single representative marketplace listing (identified by `yuyuName`) that has
// NO verified link to this record's `rarity`: the same (sellPrice, yuyuName) is
// copied across every rarity variant of a cardNumber. For example hBP01-044 is
// stored as C / HR / P_02 records that all carry `sellPrice: 80` from the one
// "AZKi(パラレル/hBP07)" listing. Assigning that price to `raw.rarity` would
// fabricate three "exact" prices from a single listing, so we do NOT use the
// top-level `sellPrice`/`rarity` pair at all — that is inferring from top-level
// rarity, which the resolver contract forbids.
//
// The only explicit listing→version mapping in this schema is a `prices[]` entry
// that carries its own non-empty `rarity`. Only those become version-keyed
// records. When nothing qualifies we emit no record, the resolver returns
// NO_EXACT_PRICE, and the UI shows 無精確版本價格 instead of a spread-across-
// versions guess.
export function adaptPrices(raw: RawCard): PriceRecord[] {
  const out: PriceRecord[] = [];
  const ts = (raw as RawCard & { timestamp?: string }).timestamp || '';
  for (const p of raw.prices || []) {
    if (typeof p.sellPrice === 'number' && p.rarity) {
      out.push({
        cardNumber: raw.cardNumber,
        version: p.rarity,
        price: p.sellPrice,
        currency: 'JPY',
        source: 'yuyu-tei.jp',
        timestamp: ts,
      });
    }
  }
  return out;
}

// Pure raw-database → editor-shape adapter. Kept separate from the fetch/cache
// wrapper so the raw-database-to-PriceRecord boundary can be regression-tested
// directly against real ambiguous data (DIC-952).
export function adaptDatabase(rawCards: RawCard[]): CardDatabase {
  return {
    cards: rawCards.map(adaptCard),
    priceRecords: rawCards.flatMap(adaptPrices),
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

export function searchCards(cards: DeckCard[], query: string, limit = 60): DeckCard[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: DeckCard[] = [];
  for (const c of cards) {
    if (
      c.cardNumber.toLowerCase().includes(q) ||
      c.name.toLowerCase().includes(q) ||
      c.series.toLowerCase().includes(q)
    ) {
      out.push(c);
      if (out.length >= limit) break;
    }
  }
  return out;
}
