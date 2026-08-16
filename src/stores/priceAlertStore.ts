/**
 * Price Alert Store (Zustand + persistent, local-first)
 *
 * The player's desired purchase interval for an EXACT printing of a missing
 * deck card (DIC-1023). Keyed by `cardNumber|PRINTING`, the same identity the
 * deck editor / ownership / gap estimate use.
 *
 * Deliberately separate from `watchlistStore`: that store is the card-number
 * trend watchlist and its legacy `targetPrice` field carries no version, so
 * folding the two would silently turn a card-number-only entry into an
 * exact-version price alert. Legacy items stay readable in their own list.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import platformStorage from './storage';
import { normalizePrinting } from '../utils/printingIdentity';
import { priceAlertKey, type PriceAlert } from '../utils/priceAlerts';

export interface PriceAlertInput {
  cardNumber: string;
  printing: string;
  printingLabel?: string;
  name: string;
  currency: string;
  lowerPrice: number | null;
  upperPrice: number;
}

interface PriceAlertState {
  /** priceAlertKey -> alert */
  alerts: Record<string, PriceAlert>;

  upsertAlert: (input: PriceAlertInput) => PriceAlert | null;
  removeAlert: (cardNumber: string, printing: string) => void;
  getAlert: (cardNumber: string, printing: string) => PriceAlert | null;
}

export const usePriceAlertStore = create<PriceAlertState>()(
  persist(
    (set, get) => ({
      alerts: {},

      upsertAlert: (input) => {
        const cardNumber = (input.cardNumber ?? '').trim();
        const printing = normalizePrinting(input.printing ?? '');
        // An alert without a proven printing is not representable — refuse
        // rather than fall back to a card-number-only match.
        if (!cardNumber || !printing) return null;

        const key = priceAlertKey(cardNumber, printing);
        const now = new Date().toISOString();
        const existing = get().alerts[key];
        const alert: PriceAlert = {
          cardNumber,
          printing,
          printingLabel: input.printingLabel?.trim() || '',
          name: input.name,
          currency: input.currency,
          lowerPrice: input.lowerPrice,
          upperPrice: input.upperPrice,
          createdAt: existing?.createdAt || now,
          updatedAt: now,
        };
        set((s) => ({ alerts: { ...s.alerts, [key]: alert } }));
        return alert;
      },

      removeAlert: (cardNumber, printing) => set((s) => {
        const next = { ...s.alerts };
        delete next[priceAlertKey(cardNumber, printing)];
        return { alerts: next };
      }),

      getAlert: (cardNumber, printing) => get().alerts[priceAlertKey(cardNumber, printing)] ?? null,
    }),
    {
      name: 'hunterCard-price-alerts',
      version: 1,
      storage: createJSONStorage(() => platformStorage),
      partialize: (s) => ({ alerts: s.alerts }),
    }
  )
);

/** Stable display order: card number, then printing. */
export function sortedAlerts(alerts: Record<string, PriceAlert>): PriceAlert[] {
  return Object.values(alerts).sort(
    (a, b) => a.cardNumber.localeCompare(b.cardNumber) || a.printing.localeCompare(b.printing),
  );
}
