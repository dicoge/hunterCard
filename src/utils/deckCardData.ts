// Loads the card database for the deck editor and adapts it to the editor's
// DeckCard / PriceRecord shapes. Mirrors the fetch('/data/database.json')
// pattern already used by HomeScreen (web serves data from public/). Kept out of
// the screen component so it can be reused and reasoned about independently.

import type { DeckCard, PriceRecord } from './deckRules';

interface RawCard {
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

function adaptCard(raw: RawCard): DeckCard {
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

// Build version-precise price records. A record is only usable when it carries a
// non-empty version (rarity) — the resolver refuses to match version==='' so we
// never silently cross-version match. The dataset's sellPrice is keyed to the
// card's own printing, so its version is the card's rarity.
function adaptPrices(raw: RawCard): PriceRecord[] {
  const out: PriceRecord[] = [];
  const now = raw as RawCard & { timestamp?: string };
  const ts = (now as any).timestamp || '';
  if (typeof raw.sellPrice === 'number') {
    out.push({
      cardNumber: raw.cardNumber,
      version: raw.rarity || '',
      price: raw.sellPrice,
      currency: 'JPY',
      source: 'yuyu-tei.jp',
      timestamp: ts,
    });
  }
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
      const cards = rawCards.map(adaptCard);
      const priceRecords = rawCards.flatMap(adaptPrices);
      cache = { cards, priceRecords };
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
