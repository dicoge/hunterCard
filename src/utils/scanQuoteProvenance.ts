/**
 * Scan → CardDetail quote provenance (2026-11-07 last-known price, review R2).
 *
 * A scanned card is ONE catalog row (or one proven alias version whose price and listings
 * are those of its current quote row — cardRecognition.consolidatePrintingCards), so every
 * listing it carries was quoted at that row's own time: `provenance.quotedAt`. This passes
 * exactly that time to the detail route — never the representative row's or the catalog's —
 * and states nothing for a printing the card's own listings price ambiguously. A card with
 * no quote provenance (an older or account-synced entry) carries `null`: the detail then
 * says 報價日期不明 rather than presenting the price as current.
 */
import { buildSourcePrintings, type SourceListing } from './printingIdentity';

export interface ScanQuoteFields {
  priceQuotedAt: string | null;
  printingQuotedAt: Record<string, string>;
}

export function scanQuoteProvenance(card: {
  provenance?: { quotedAt?: string | null } | null;
  prices?: ReadonlyArray<SourceListing | null | undefined> | null;
}): ScanQuoteFields {
  const raw = card?.provenance?.quotedAt;
  const quotedAt = typeof raw === 'string' && raw.trim() ? raw : null;
  const printingQuotedAt: Record<string, string> = {};
  if (quotedAt) {
    for (const p of buildSourcePrintings(card?.prices ?? [])) {
      if (!p.ambiguous && p.sellPrice != null) printingQuotedAt[p.printing] = quotedAt;
    }
  }
  return { priceQuotedAt: quotedAt, printingQuotedAt };
}
