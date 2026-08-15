// Source-proven printing identity — the ONE version model shared by card lookup,
// deck search/add, draft normalization, tournament import, ownership and the gap
// estimate (DIC-1013).
//
// yuyu-tei publishes one listing per physical printing of a card number and names
// the printing in the listing itself:
//
//   ラプラス・ダークネス                 ¥980     ← plain printing
//   ラプラス・ダークネス(パラレル)        ¥9,980   ← parallel
//   ラプラス・ダークネス(パラレル/サイン)  ¥69,800  ← signed parallel
//
// That listing name is the ONLY place the source states which printing a price
// belongs to. `prices[].rarity` is empty on every row of the shipped dataset, and
// the row-level `rarity` describes the card number as a whole — hBP04-005 is SEC
// on both of its rows even though its cheapest listing is a plain ¥980 printing.
// So identity is derived from the label and nothing else; a rarity the source did
// not state is never guessed.
//
// Tokens are derived per listing (never from its siblings) so they stay stable
// when a scrape adds or drops a listing, which is what lets persisted decks and
// collections keep meaning across data refreshes.

export const BASE_PRINTING = 'BASE';

/** Fold incidental case / width / spacing differences so the same printing keys
 * one bucket everywhere (deck slot, hand entry, persisted collection). */
export function normalizePrinting(value: string): string {
  return (value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toUpperCase();
}

// Vocabulary the source uses to mark a printing. A parenthetical that carries
// none of these is part of the card's NAME (e.g. 「スペシャルイベント(白銀ノエル)」)
// and must not become a variant marker.
const MARKER_RE = /パラレル|サイン|エラッタ|箔押し/;

const MARKER_TOKENS: Record<string, string> = {
  'パラレル': 'PARALLEL',
  'サイン': 'SIGN',
  'エラッタ前': 'ERRATA-PRE',
  'エラッタ後': 'ERRATA-POST',
  '箔押し': 'FOIL',
};

// A premium treatment. Everything else — BASE, ERRATA-PRE/POST — is a plain
// printing and is what a budget deck defaults to.
const PREMIUM_TOKEN_RE = /(^|\/)(PARALLEL|SIGN|FOIL)(\/|$)/;

/** Listing label → deterministic printing token. An unmarked listing is BASE;
 * a marked one spells out exactly the markers the label carries, so
 * `(パラレル/hBP07)` and `(パラレル/HR)` stay distinct printings. */
export function printingFromLabel(label: string): string {
  const norm = (label ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const marked = Array.from(norm.matchAll(/[(（]([^)）]*)[)）]/g))
    .map((m) => m[1].trim())
    .filter((group) => MARKER_RE.test(group));
  if (marked.length === 0) return BASE_PRINTING;
  const token = marked
    .flatMap((group) => group.split('/'))
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => MARKER_TOKENS[part] ?? part)
    .join('/');
  return normalizePrinting(token) || BASE_PRINTING;
}

export function isPlainPrinting(printing: string): boolean {
  return !PREMIUM_TOKEN_RE.test(normalizePrinting(printing));
}

/** One raw price listing as the scraped dataset stores it. */
export interface SourceListing {
  name?: string;
  sellPrice?: number | null;
  buyPrice?: number | null;
  /** kept as provenance only — identity always comes from the label */
  rarity?: string;
}

export interface SourcePrinting {
  /** deterministic identity: BASE | PARALLEL | PARALLEL/SIGN | PARALLEL/HR … */
  printing: string;
  /** the source's own listing label, preserved verbatim */
  label: string;
  /** player purchase / reference price — the ONLY price a deck cost may use */
  sellPrice: number | null;
  /** store acquisition price — card-market display only, never a deck cost */
  buyPrice: number | null;
  /** two listings claim this printing at different prices → priced fail-closed */
  ambiguous: boolean;
}

/**
 * Collapse a card number's listings into its printings, first-seen order.
 *
 * Listings that resolve to the same printing at DIFFERENT sell prices cannot be
 * told apart from the source alone — the dataset really does ship two
 * `白銀ノエル(パラレル)` rows at ¥3,480 and ¥500. Merging them would invent a
 * price for a printing the player cannot identify, so the printing survives as a
 * selectable version but stays UNPRICED (DIC-1013 §4).
 */
export function buildSourcePrintings(
  listings: readonly (SourceListing | null | undefined)[] | null | undefined,
): SourcePrinting[] {
  const order: string[] = [];
  const byPrinting = new Map<string, SourcePrinting>();
  const sellPrices = new Map<string, Set<number>>();

  for (const raw of listings ?? []) {
    if (!raw) continue;
    const label = (raw.name ?? '').trim();
    const printing = printingFromLabel(label);
    const sell = typeof raw.sellPrice === 'number' && raw.sellPrice > 0 ? raw.sellPrice : null;
    const buy = typeof raw.buyPrice === 'number' && raw.buyPrice > 0 ? raw.buyPrice : null;

    let entry = byPrinting.get(printing);
    if (!entry) {
      entry = { printing, label, sellPrice: null, buyPrice: null, ambiguous: false };
      byPrinting.set(printing, entry);
      order.push(printing);
    }
    if (sell !== null) {
      const seen = sellPrices.get(printing) ?? new Set<number>();
      seen.add(sell);
      sellPrices.set(printing, seen);
      if (entry.sellPrice === null) entry.sellPrice = sell;
    }
    if (buy !== null && entry.buyPrice === null) entry.buyPrice = buy;
  }

  for (const [printing, prices] of sellPrices) {
    if (prices.size > 1) {
      const entry = byPrinting.get(printing) as SourcePrinting;
      entry.ambiguous = true;
      entry.sellPrice = null;
    }
  }

  return order.map((printing) => byPrinting.get(printing) as SourcePrinting);
}
