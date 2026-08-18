// Folding the legacy card-number tracking list into 到價提醒 (DIC-1087).
//
// The old list tracked a card NUMBER. A 到價提醒 is about one exact printing, so
// the two are not the same record and a tracking row cannot simply be renamed
// into an alert: hBP04-005 plain and hBP04-005(パラレル) are different physical
// cards at ¥980 and ¥69,800, and picking either on the user's behalf would set a
// price alert on a card they never chose.
//
// So migration only ever resolves what the source itself proves. A card number
// the catalog lists under exactly ONE printing has no ambiguity to resolve, and
// a legacy row that also carried a target price already states what the user
// wants to pay — that pair, and only that pair, becomes a real alert. Everything
// else survives as a `PendingAlert`: the same card, kept in the same list, with
// the missing part asked for instead of guessed.
//
// Framework-free like ./priceAlerts, so the regressions can drive it directly.

import { normalizePrinting } from './printingIdentity';
import { priceAlertKey, validateInterval, type PriceAlert } from './priceAlerts';

/** One row of the pre-DIC-1087 card-number tracking list. */
export interface LegacyTrackedCard {
  cardNumber: string;
  name: string;
  nameZh?: string;
  imageUrl?: string;
  addedAt?: string;
  /** the old card-number-only target price; names no printing */
  targetPrice?: number;
}

/** One printing of a card number, as the shipped catalog states it. */
export interface PrintingOption {
  printing: string;
  printingLabel: string;
  /** exact reference SELL price of THIS printing, null when unpriced */
  sellPrice: number | null;
  currency: string;
  imageUrl?: string;
}

/** What the user must still supply before a legacy row becomes a 到價提醒. */
export type PendingNeed = 'PRINTING' | 'RANGE';

/**
 * A migrated tracking row that could not be resolved to an exact printing and a
 * range on its own. It lives in the 到價提醒 list and asks for the missing part.
 */
export interface PendingAlert {
  cardNumber: string;
  name: string;
  nameZh?: string;
  imageUrl?: string;
  needs: PendingNeed[];
  /** carried over as the suggested upper bound; null when the row had none */
  legacyTargetPrice: number | null;
  addedAt: string;
  migratedAt: string;
}

export interface LegacyMigration {
  /** rows the source resolved outright — real exact-version alerts */
  alerts: PriceAlert[];
  /** rows still missing a printing and/or a range */
  pending: PendingAlert[];
  /** rows already covered by an existing alert on the same card number */
  absorbed: number;
}

export function pendingKey(cardNumber: string): string {
  return (cardNumber ?? '').trim();
}

/**
 * Index the catalog by card number, joining each printing to the price record of
 * that SAME printing. The join is on the exact (cardNumber, printing) pair, so a
 * printing the price list does not name stays unpriced rather than borrowing a
 * sibling's price.
 */
export interface CatalogPrinting {
  cardNumber: string;
  printing: string;
  printingLabel?: string;
  imageUrl?: string;
}

export interface CatalogPrice {
  cardNumber: string;
  /** the printing this price applies to */
  version: string;
  price: number;
  currency: string;
}

export function buildPrintingIndex(
  cards: readonly CatalogPrinting[],
  prices: readonly CatalogPrice[],
): Map<string, PrintingOption[]> {
  const priced = new Map<string, { price: number; currency: string }>();
  for (const record of prices) {
    const printing = normalizePrinting(record.version ?? '');
    if (!printing || typeof record.price !== 'number') continue;
    priced.set(priceAlertKey(record.cardNumber, printing), { price: record.price, currency: record.currency });
  }

  const index = new Map<string, PrintingOption[]>();
  for (const card of cards) {
    const cardNumber = (card.cardNumber ?? '').trim();
    const printing = normalizePrinting(card.printing ?? '');
    if (!cardNumber || !printing) continue;
    const options = index.get(cardNumber) ?? [];
    if (options.some((o) => o.printing === printing)) continue;
    const match = priced.get(priceAlertKey(cardNumber, printing));
    options.push({
      printing,
      printingLabel: card.printingLabel?.trim() || '',
      sellPrice: match ? match.price : null,
      currency: match ? match.currency : '',
      imageUrl: card.imageUrl,
    });
    index.set(cardNumber, options);
  }
  return index;
}

/** The exact printing's thumbnail, or nothing. Matching is on the printing
 * token, so a row never shows a sibling printing's art. */
export function resolvePrintingImage(
  cardNumber: string,
  printing: string,
  index: ReadonlyMap<string, PrintingOption[]>,
): string | undefined {
  const wanted = normalizePrinting(printing ?? '');
  if (!wanted) return undefined;
  const options = index.get((cardNumber ?? '').trim());
  return options?.find((o) => o.printing === wanted)?.imageUrl;
}

/**
 * Fold the legacy card-number tracking list into the unified model.
 *
 * `existing` is the current alert map: a card number the user has already set a
 * real alert on needs no migration at all, so the legacy row is absorbed rather
 * than resurrected as a duplicate or a pending prompt.
 */
export function migrateLegacyTracking(
  legacy: readonly LegacyTrackedCard[],
  existing: Readonly<Record<string, PriceAlert>>,
  printingIndex: ReadonlyMap<string, PrintingOption[]>,
  now: string,
): LegacyMigration {
  const covered = new Set(Object.values(existing).map((a) => a.cardNumber));
  const alerts: PriceAlert[] = [];
  const pending: PendingAlert[] = [];
  const seen = new Set<string>();
  let absorbed = 0;

  for (const row of legacy ?? []) {
    const cardNumber = pendingKey(row?.cardNumber ?? '');
    if (!cardNumber || seen.has(cardNumber)) {
      if (cardNumber) absorbed += 1;
      continue;
    }
    seen.add(cardNumber);
    if (covered.has(cardNumber)) {
      absorbed += 1;
      continue;
    }

    const options = printingIndex.get(cardNumber) ?? [];
    const interval = validateInterval(null, row?.targetPrice ?? null);
    const name = row?.nameZh?.trim() || row?.name?.trim() || cardNumber;
    const needs: PendingNeed[] = [];
    if (options.length !== 1) needs.push('PRINTING');
    if (!interval.ok) needs.push('RANGE');

    if (needs.length === 0) {
      const only = options[0];
      alerts.push({
        cardNumber,
        printing: only.printing,
        printingLabel: only.printingLabel,
        name,
        currency: only.currency || '',
        lowerPrice: null,
        upperPrice: (interval as { ok: true; upperPrice: number }).upperPrice,
        imageUrl: only.imageUrl ?? row?.imageUrl,
        createdAt: row?.addedAt || now,
        updatedAt: now,
      });
      continue;
    }

    pending.push({
      cardNumber,
      name,
      nameZh: row?.nameZh,
      imageUrl: row?.imageUrl,
      needs,
      legacyTargetPrice: interval.ok ? interval.upperPrice : null,
      addedAt: row?.addedAt || now,
      migratedAt: now,
    });
  }

  return { alerts, pending, absorbed };
}

export const PENDING_NEED_LABELS: Record<PendingNeed, string> = {
  PRINTING: '需選擇版本',
  RANGE: '需設定價格區間',
};

/** One line telling the user exactly what this row is still waiting for. */
export function pendingPrompt(item: Pick<PendingAlert, 'needs'>): string {
  const parts = item.needs.map((need) => PENDING_NEED_LABELS[need]);
  return `${parts.join('、')}後才會開始提醒`;
}
