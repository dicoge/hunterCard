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

// Every parenthetical descriptor the source prints is part of the printing's
// identity, not just the premium-treatment vocabulary. yuyu-tei distinguishes a
// card number's base reprints the same way it distinguishes its parallels —
// `みっころね24` ¥120 and `みっころね24(hBP04)` ¥180 are two different physical
// printings at two different prices. Reading only パラレル/サイン/… collapsed
// those onto one key, which made an unambiguous pair look ambiguous and dropped
// both prices.
//
// Known treatments below get a stable ASCII token; anything else (set codes such
// as `hBP04`, art descriptors such as `白銀ノエル`) is kept verbatim so the
// identity never claims more than the label states.
//
// エラッタ前 / エラッタ後 are source-maintenance revisions of the SAME tier
// (DIC-1139) — they do not create a new printing the player can hold, only a
// bookkeeping row on the shop. They are recognised here so pre-canonicalisation
// input parses correctly, but `printingFromLabel` folds them out of the token
// so no user-facing identifier ever carries errata history.
const MARKER_TOKENS: Record<string, string> = {
  'パラレル': 'PARALLEL',
  'サイン': 'SIGN',
  'エラッタ前': 'ERRATA-PRE',
  'エラッタ後': 'ERRATA-POST',
  '箔押し': 'FOIL',
  'S仕様': 'S-SPEC',
};

const ERRATA_TOKENS = new Set(['ERRATA-PRE', 'ERRATA-POST']);

// A premium treatment. Everything else — BASE, ERRATA-PRE/POST — is a plain
// printing and is what a budget deck defaults to.
const PREMIUM_TOKEN_RE = /(^|\/)(PARALLEL|SIGN|FOIL|S-SPEC|S仕様)(\/|$)/;

/** Listing label → deterministic printing token. A listing with no parenthetical
 * is the card number's plain printing (BASE); otherwise the token spells out
 * exactly the descriptors the label carries, so `(パラレル/hBP07)`,
 * `(パラレル/HR)` and a bare `(hBP04)` reprint all stay distinct printings.
 *
 * ERRATA-PRE / ERRATA-POST are stripped here so ownership, deck slots and
 * alert targets never key by errata history (DIC-1139) — a corrected reprint
 * of a signed card is still the signed card. */
export function printingFromLabel(label: string): string {
  const norm = (label ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const groups = Array.from(norm.matchAll(/[(（]([^)）]*)[)）]/g))
    .map((m) => m[1].trim())
    .filter(Boolean);
  if (groups.length === 0) return BASE_PRINTING;
  const parts = groups
    .flatMap((group) => group.split('/'))
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => MARKER_TOKENS[part] ?? part)
    .filter((tok) => !ERRATA_TOKENS.has(tok));
  if (parts.length === 0) return BASE_PRINTING;
  const token = parts.join('/');
  return normalizePrinting(token) || BASE_PRINTING;
}

/**
 * Strip errata-history tokens from any legacy printing string persisted
 * before DIC-1139. `PARALLEL/SIGN/ERRATA-PRE` → `PARALLEL/SIGN`; a token that
 * was ONLY errata history (`ERRATA-POST`) → BASE. This is the single point
 * every store's migration and every read-side lookup routes through so old
 * inventory / deck slot / alert keys land on the canonical printing without
 * duplication. */
export function canonicalPrinting(printing: string): string {
  const norm = normalizePrinting(printing);
  if (!norm) return BASE_PRINTING;
  const parts = norm.split('/').filter((p) => p && !ERRATA_TOKENS.has(p));
  if (parts.length === 0) return BASE_PRINTING;
  return parts.join('/');
}

export function isPlainPrinting(printing: string): boolean {
  return !PREMIUM_TOKEN_RE.test(normalizePrinting(printing));
}

/**
 * Canonical order over printing tokens: plain printings first, then code-unit
 * order. Code units rather than `localeCompare` because the same deck has to
 * resolve identically on V8, Hermes and JSC, whose collation tables differ.
 *
 * This is what makes the default printing a property of the card number instead
 * of a property of whichever list a caller happened to build — card detail reads
 * listings in source order while deck search reads them sorted, and at equal
 * price that difference used to hand them different printings (`エラッタ前` vs
 * `エラッタ後` on hBP03-027 and five others).
 */
export function comparePrintingTokens(a: string, b: string): number {
  const na = normalizePrinting(a);
  const nb = normalizePrinting(b);
  if (isPlainPrinting(na) !== isPlainPrinting(nb)) return isPlainPrinting(na) ? -1 : 1;
  if (na === nb) return 0;
  return na < nb ? -1 : 1;
}

export interface PrintingPrice {
  printing: string;
  /** exact reference SELL price of THIS printing, or null when unpriced */
  sellPrice: number | null;
  currency?: string;
}

/**
 * The ONE default-printing rule, shared by the deck's low-cost resolver and the
 * card-lookup/scan version alignment so the two can never disagree about which
 * printing a card number defaults to.
 *
 * Plain printings win outright over premium ones — never default to a
 * パラレル / サイン printing while a plain listing exists. Inside the winning
 * tier the lowest exact sell price wins, compared only against prices in the
 * same currency; an unpriced printing never borrows a sibling's price, it simply
 * loses.
 *
 * Every step that price cannot decide falls back to `comparePrintingTokens`, so
 * the answer depends only on the card number's printings — not on the order the
 * caller listed them in.
 *
 * Returns an index into `entries`, or -1 when `entries` is empty.
 */
export function pickDefaultPrintingIndex(entries: readonly PrintingPrice[]): number {
  if (entries.length === 0) return -1;
  const ranked = entries
    .map((_, i) => i)
    .sort((a, b) => comparePrintingTokens(entries[a].printing, entries[b].printing) || a - b);
  const plain = ranked.filter((i) => isPlainPrinting(entries[i].printing));
  const tier = plain.length > 0 ? plain : ranked;

  const priced = tier.filter((i) => {
    const p = entries[i].sellPrice;
    return typeof p === 'number' && p > 0;
  });
  if (priced.length === 0) return tier[0];

  const currency = entries[priced[0]].currency ?? '';
  let best = priced[0];
  for (const i of priced) {
    if ((entries[i].currency ?? '') !== currency) continue;
    if ((entries[i].sellPrice as number) < (entries[best].sellPrice as number)) best = i;
  }
  return best;
}

/** One raw price listing as the scraped dataset stores it. */
export interface SourceListing {
  name?: string;
  sellPrice?: number | null;
  buyPrice?: number | null;
  /** Image published on this exact listing. A card-level/representative image
   * must never be copied here because it does not prove a printing identity. */
  imageUrl?: string;
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
  /** Image proven by the source listing for this printing. Missing when the
   * source has no image or conflicting listings publish different images. */
  imageUrl?: string;
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
  const imageUrls = new Map<string, Set<string>>();

  for (const raw of listings ?? []) {
    if (!raw) continue;
    const label = (raw.name ?? '').trim();
    const printing = printingFromLabel(label);
    const sell = typeof raw.sellPrice === 'number' && raw.sellPrice > 0 ? raw.sellPrice : null;
    const buy = typeof raw.buyPrice === 'number' && raw.buyPrice > 0 ? raw.buyPrice : null;
    const imageUrl = (raw.imageUrl ?? '').trim();

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
    if (imageUrl) {
      const seen = imageUrls.get(printing) ?? new Set<string>();
      seen.add(imageUrl);
      imageUrls.set(printing, seen);
    }
  }

  for (const [printing, prices] of sellPrices) {
    if (prices.size > 1) {
      const entry = byPrinting.get(printing) as SourcePrinting;
      entry.ambiguous = true;
      entry.sellPrice = null;
    }
  }

  for (const [printing, images] of imageUrls) {
    if (images.size === 1) {
      (byPrinting.get(printing) as SourcePrinting).imageUrl = Array.from(images)[0];
    }
  }

  return order.map((printing) => byPrinting.get(printing) as SourcePrinting);
}
