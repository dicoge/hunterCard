// Loads the card database for the deck editor and adapts it to the editor's
// DeckCard / PriceRecord shapes. Mirrors the fetch('/data/database.json')
// pattern already used by HomeScreen (web serves data from public/). Kept out of
// the screen component so it can be reused and reasoned about independently.

import type { DeckCard, PriceRecord } from './deckRules';
import { normalizeVersion } from './deckRules';
import { isPremiumPrinting } from './deckVariants';

export interface RawPriceEntry {
  name?: string;
  sellPrice?: number | null;
  rarity?: string;
  buyPrice?: number | null;
  /** merge-buy-prices.js provenance: exact version token this buy price belongs
   * to; 'BASE' = the bare (original-printing) listing. Absent = no version. */
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
  officialImage?: string;
  localImage?: string;
  skillsJp?: { cardType?: string };
  prices?: RawPriceEntry[];
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
// declares that version. Two explicit listing→version channels exist:
//
//  A) a `prices[]` entry that carries its own non-empty `rarity` (yuyu-tei);
//     none exists in the current dataset — every entry ships `rarity: ""`.
//  B) merge-buy-prices.js buy-price provenance (`buyPrice` + `buyPriceVersion`
//     + `buyPriceSource` + `buyPriceTimestamp`), stamped per variant from the
//     store's own listing. This is the version-precise channel used by the deck.
//
// Every other mapping is inference and is NOT emitted: the top-level
// `sellPrice`/`rarity` pair is copied across every printing of a card number and
// has no verified link to this record's rarity, so it never becomes a record
// (DIC-952). And a buy price whose version token is missing stays versionless —
// resolveExactPrice requires an exact (cardNumber, version) match and drops
// empty-version records, so nothing leaks cross-version.
export function adaptPrices(raw: RawCard): PriceRecord[] {
  const out: PriceRecord[] = [];
  const ts = (raw as RawCard & { timestamp?: string }).timestamp || '';

  // Does this row actually represent the card number's own base printing
  // (original set + non-premium rarity)? Only that printing may claim the bare
  // 'BASE' buy price; a premium row (SEC/signed/parallel) must NOT absorb it.
  const setPrefix = String(raw.cardNumber ?? '').split('-')[0].toLowerCase();
  const isOwnSetBase = setPrefix !== '' &&
    (raw.series || '').toLowerCase() === setPrefix &&
    !isPremiumPrinting(raw.rarity || '');

  const push = (version: string, price: number, source: string, timestamp: string) => {
    const v = normalizeVersion(version);
    if (!v) return; // fail closed: never emit a versionless record
    out.push({
      cardNumber: raw.cardNumber,
      version: v,
      price,
      currency: 'JPY',
      source,
      timestamp,
    });
  };

  for (const p of raw.prices || []) {
    if (typeof p.sellPrice === 'number' && p.rarity) {
      push(p.rarity, p.sellPrice, 'yuyu-tei.jp', ts);
    }
    if (typeof p.buyPrice === 'number') {
      const v = p.buyPriceVersion;
      if (v && v !== 'BASE') {
        // Explicit parallel / signed token (e.g. SEC, SR, OUR): the version is
        // already proven by the source, so it applies to every row of this card
        // number alike (they share the same listing set).
        push(v, p.buyPrice, p.buyPriceSource || 'buy-price', p.buyPriceTimestamp || ts);
      } else if (v === 'BASE' && isOwnSetBase) {
        // Bare listing = original printing. Only this card's own-set base row
        // may claim it — premium rows stay excluded (no cross-version fallback).
        // isOwnSetBase implies a non-empty, non-premium rarity.
        push(String(raw.rarity || ''), p.buyPrice, p.buyPriceSource || 'buy-price', p.buyPriceTimestamp || ts);
      }
    }
  }
  return out;
}

// Same (cardNumber, version) reached with conflicting prices across the card
// number's rows (e.g. two stores disagree) → ambiguous, drop ALL of them rather
// than trust an arbitrary pick (fail closed). Runs at database level because a
// card number's price rows are split across separate card entries.
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
  return {
    cards: rawCards.map(adaptCard),
    priceRecords: dropConflictingPrices(rawCards.flatMap(adaptPrices)),
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
