/**
 * Printing versions and their price quotes (v44, user report: "same printing, different
 * price"). Dependency-free: the scan resolver, the API mapper and the Node tests share it.
 *
 * The catalog keeps one row per (card number, scraped product) — hBD24-023 has an
 * `ent07` row and an `hPR` row. `ent07` is a scrape AGGREGATION bucket, not a product a
 * player can buy, so the same physical card sold through the same shop listing can appear
 * twice with quotes taken at different times (JPY 8,980 on 2026-10-17 vs JPY 9,980 on
 * 2026-08-25). Shown as two "versions" the player could only tell apart by price.
 *
 * Rules (nothing is deleted; every row id stays a valid lookup id):
 *   • Rows are ONE version only with PROOF that they are the same physical printing:
 *       – an explicit equal `physicalPrinting`, or
 *       – the known aggregation alias: exactly one row comes from an aggregation bucket
 *         (AGGREGATE_SOURCE_PRODUCTS), and both carry the same card number, the same
 *         non-empty shop listing (yuyu image URL), the same non-empty official image and a
 *         compatible rarity.
 *     Language and condition are never assumed: both known and different → not the same.
 *   • Equal images WITHOUT that proof stay separate versions, marked `lookalike` so the
 *     picker shows source and quote date instead of two identical labels.
 *   • A version's current SELL price is the latest sell quote of that same listing; two
 *     different prices at the same latest time are a conflict (no current price, both
 *     kept). Buy quotes never stand in for sell quotes. No sibling version's price is
 *     ever borrowed, and neither max nor min is used to pick one.
 */

/** Scrape buckets that aggregate several products; their rows are aliases, not products. */
export const AGGREGATE_SOURCE_PRODUCTS: ReadonlySet<string> = new Set(['ent07']);

export type QuoteType = 'sell' | 'buy';

/** Where one price row came from. Unknown stays null — never guessed. */
export interface PriceProvenance {
  sourceProduct: string | null;
  sourceProductName: string | null;
  /** When this row's price was quoted (the row's scrape time). */
  quotedAt: string | null;
  /** The shop listing the price belongs to (its listing image URL). */
  listing: string | null;
  /** The shop, derived from the listing host only when it is recognised. */
  quoteSource: string | null;
  language: string | null;
  condition: string | null;
}

export interface PriceQuote {
  rowId: string;
  type: QuoteType;
  price: number;
  quotedAt: string | null;
  listing: string | null;
  quoteSource: string | null;
  sourceProduct: string | null;
  condition: string | null;
}

/** The fields this module reads from a catalog row / CardInfo / fixture row. */
export interface PrintingRow {
  id: string;
  cardNumber: string;
  rarity?: string | null;
  sellPrice?: number | null;
  buyPrice?: number | null;
  imageUrl?: string | null;
  /** fixture/forward data: an explicit physical-printing identity */
  physicalPrinting?: string | null;
  /** fixture/forward data: art identity (official image for catalog rows) */
  artIdentity?: string | null;
  /** fixture/forward data: the row's single price is of this type */
  priceType?: QuoteType | null;
  provenance?: PriceProvenance | null;
}

export interface PrintingVersion<R extends PrintingRow = PrintingRow> {
  /** the representative row (a non-aggregate member when there is one) */
  primary: R;
  /** every row id of this version (all remain valid lookup ids) */
  memberIds: string[];
  members: R[];
  /** proof used to join the members, or null for a single row */
  proof: 'explicit' | 'aggregate-alias-same-listing' | null;
  quotes: PriceQuote[];
  /** latest sell quote of the version; null when none or conflicting */
  currentSell: PriceQuote | null;
  currentBuy: PriceQuote | null;
  /** quotes at the same latest time disagree */
  sellConflict: boolean;
  /** distinct conditions seen among sell quotes (null = unknown) */
  conditions: Array<string | null>;
  /** another version looks identical (same art/listing) but is NOT proven the same */
  lookalike: boolean;
}

const YUYU_HOST = /^https?:\/\/card\.yuyu-tei\.jp\//;

const clean = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Provenance of one database row (local catalog or the API's `fmt`). Missing = null. */
export function provenanceFromRow(entry: Record<string, any>): PriceProvenance {
  const listing = clean(entry.yuyuImage) ?? clean(entry.listing);
  return {
    sourceProduct: clean(entry.sourceProduct) ?? clean(entry.series),
    sourceProductName: clean(entry.sourceProductName) ?? clean(entry.sourceProductText),
    quotedAt: clean(entry.timestamp) ?? clean(entry.quotedAt),
    listing,
    quoteSource: listing && YUYU_HOST.test(listing) ? 'yuyu-tei' : clean(entry.quoteSource),
    language: clean(entry.language),
    condition: clean(entry.condition),
  };
}

const isAggregate = (r: PrintingRow) => AGGREGATE_SOURCE_PRODUCTS.has(r.provenance?.sourceProduct ?? '');
const art = (r: PrintingRow) => clean(r.artIdentity) ?? clean(r.imageUrl);
const knownDiffer = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a !== b;

/** Why two rows are the same physical printing, or null when that is not proven. */
export function samePrintingProof(a: PrintingRow, b: PrintingRow): PrintingVersion['proof'] {
  if (a.cardNumber !== b.cardNumber) return null;
  const pa = a.provenance, pb = b.provenance;
  // A known, different language is a different printing; unknown is never assumed equal
  // to a known one.
  if ((pa?.language ?? null) !== (pb?.language ?? null)) return null;
  if (a.physicalPrinting || b.physicalPrinting) {
    return a.physicalPrinting && a.physicalPrinting === b.physicalPrinting ? 'explicit' : null;
  }
  if (isAggregate(a) === isAggregate(b)) return null;              // exactly one alias row
  if (!pa?.listing || pa.listing !== pb?.listing) return null;     // the same shop listing
  if (!art(a) || art(a) !== art(b)) return null;                   // the same official image
  if (knownDiffer(clean(a.rarity), clean(b.rarity))) return null;
  if (knownDiffer(pa.condition, pb?.condition)) return null;
  return 'aggregate-alias-same-listing';
}

function quotesOf(r: PrintingRow): PriceQuote[] {
  const p = r.provenance;
  const base = {
    rowId: r.id,
    quotedAt: p?.quotedAt ?? null,
    listing: p?.listing ?? null,
    quoteSource: p?.quoteSource ?? null,
    sourceProduct: p?.sourceProduct ?? null,
    condition: p?.condition ?? null,
  };
  const out: PriceQuote[] = [];
  const type: QuoteType = r.priceType ?? 'sell';
  if (r.sellPrice != null && r.sellPrice > 0) out.push({ ...base, type, price: r.sellPrice });
  if (r.buyPrice != null && r.buyPrice > 0 && type === 'sell') out.push({ ...base, type: 'buy', price: r.buyPrice });
  return out;
}

const time = (q: PriceQuote) => (q.quotedAt ? Date.parse(q.quotedAt) || 0 : 0);

/** The latest quote of one type; a different price at the same latest time = conflict. */
function latest(quotes: PriceQuote[]): { quote: PriceQuote | null; conflict: boolean } {
  if (quotes.length === 0) return { quote: null, conflict: false };
  const top = Math.max(...quotes.map(time));
  const atTop = quotes.filter((q) => time(q) === top);
  const prices = new Set(atTop.map((q) => q.price));
  if (prices.size > 1) return { quote: null, conflict: true };
  return { quote: atTop[0], conflict: false };
}

/** Group rows into proven versions (order follows the first member of each version). */
export function buildPrintingVersions<R extends PrintingRow>(rows: R[]): PrintingVersion<R>[] {
  const parent = rows.map((_, i) => i);
  const proofs: Array<PrintingVersion['proof']> = rows.map(() => null);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const proof = samePrintingProof(rows[i], rows[j]);
      if (!proof) continue;
      const a = find(i), b = find(j);
      if (a !== b) { parent[b] = a; proofs[a] = proofs[a] ?? proof; }
    }
  }
  const groups = new Map<number, number[]>();
  rows.forEach((_, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), i]); });
  const versions = [...groups.entries()].map(([root, idx]) => {
    const members = idx.map((i) => rows[i]);
    const primary = members.find((m) => !isAggregate(m)) ?? members[0];
    const quotes = members.flatMap(quotesOf);
    const sell = quotes.filter((q) => q.type === 'sell');
    const conditions = [...new Set(sell.map((q) => q.condition))];
    // With several conditions there is no single "current" price: each condition is its
    // own quote option (shown with its label).
    const sellPick = conditions.length > 1 ? { quote: null, conflict: false } : latest(sell);
    return {
      primary,
      memberIds: members.map((m) => m.id),
      members,
      proof: members.length > 1 ? proofs[root] : null,
      quotes,
      currentSell: sellPick.quote,
      currentBuy: latest(quotes.filter((q) => q.type === 'buy')).quote,
      sellConflict: sellPick.conflict,
      conditions,
      lookalike: false,
    } as PrintingVersion<R>;
  });
  // Unproven lookalikes: same card number + same art + same listing, not joined above.
  for (const v of versions) {
    v.lookalike = versions.some((o) => o !== v
      && o.primary.cardNumber === v.primary.cardNumber
      && !!art(o.primary) && art(o.primary) === art(v.primary)
      && !!o.primary.provenance?.listing && o.primary.provenance?.listing === v.primary.provenance?.listing);
  }
  return versions;
}
