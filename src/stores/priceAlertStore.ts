/**
 * 到價提醒 Store (Zustand + persistent, local-first)
 *
 * The one alert record: the player's desired purchase interval for an EXACT
 * printing, keyed by `cardNumber|PRINTING` — the same identity the deck editor,
 * ownership and the gap estimate use.
 *
 * DIC-1087 folded the old card-number tracking list in here. A card-number row
 * carries no printing, so it is never rewritten into an alert on a printing the
 * user did not choose: unless the catalog proves the card number has exactly one
 * printing (and the row already stated a target price) it lands in `pending` and
 * the list asks for the missing part.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import platformStorage from './storage';
import { normalizePrinting } from '../utils/printingIdentity';
import { dedupePriceAlerts, priceAlertKey, type PriceAlert } from '../utils/priceAlerts';
import {
  migrateLegacyTracking, pendingKey,
  type LegacyMigration, type LegacyTrackedCard, type PendingAlert, type PrintingOption,
} from '../utils/alertMigration';

export interface PriceAlertInput {
  cardNumber: string;
  printing: string;
  printingLabel?: string;
  name: string;
  currency: string;
  lowerPrice: number | null;
  upperPrice: number;
  imageUrl?: string;
}

interface PriceAlertState {
  /** priceAlertKey -> alert */
  alerts: Record<string, PriceAlert>;
  /** cardNumber -> migrated row still waiting for a printing and/or a range */
  pending: Record<string, PendingAlert>;

  upsertAlert: (input: PriceAlertInput) => PriceAlert | null;
  removeAlert: (cardNumber: string, printing: string) => void;
  getAlert: (cardNumber: string, printing: string) => PriceAlert | null;
  importLegacyTracking: (
    legacy: readonly LegacyTrackedCard[],
    printingIndex: ReadonlyMap<string, PrintingOption[]>,
    now?: string,
  ) => LegacyMigration;
  dismissPending: (cardNumber: string) => void;
}

export const usePriceAlertStore = create<PriceAlertState>()(
  persist(
    (set, get) => ({
      alerts: {},
      pending: {},

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
          imageUrl: input.imageUrl,
          createdAt: existing?.createdAt || now,
          updatedAt: now,
        };
        set((s) => {
          // Configuring the alert is what the pending row was asking for.
          const pending = { ...s.pending };
          delete pending[pendingKey(cardNumber)];
          return { alerts: { ...s.alerts, [key]: alert }, pending };
        });
        return alert;
      },

      removeAlert: (cardNumber, printing) => set((s) => {
        const next = { ...s.alerts };
        delete next[priceAlertKey(cardNumber, printing)];
        return { alerts: next };
      }),

      getAlert: (cardNumber, printing) => get().alerts[priceAlertKey(cardNumber, printing)] ?? null,

      importLegacyTracking: (legacy, printingIndex, now) => {
        const result = migrateLegacyTracking(
          legacy, get().alerts, printingIndex, now || new Date().toISOString(),
        );
        if (result.alerts.length === 0 && result.pending.length === 0) return result;
        set((s) => {
          const alerts = { ...s.alerts };
          for (const alert of result.alerts) {
            alerts[priceAlertKey(alert.cardNumber, alert.printing)] = alert;
          }
          const pending = { ...s.pending };
          for (const item of result.pending) pending[pendingKey(item.cardNumber)] = item;
          return { alerts, pending };
        });
        return result;
      },

      dismissPending: (cardNumber) => set((s) => {
        const pending = { ...s.pending };
        delete pending[pendingKey(cardNumber)];
        return { pending };
      }),
    }),
    {
      name: 'hunterCard-price-alerts',
      version: 3,
      storage: createJSONStorage(() => platformStorage),
      partialize: (s) => ({ alerts: s.alerts, pending: s.pending }),
      // v1 keyed some records by an un-normalized printing. v2 also persisted a
      // representative card image as though it belonged to every printing. On
      // upgrade, collapse duplicates and discard those unprovable thumbnails;
      // the current catalog supplies a source-proven exact image when it has one.
      migrate: (persisted: any, version: number) => {
        const deduped = dedupePriceAlerts(persisted?.alerts ?? {}).alerts;
        const alerts = version < 3
          ? Object.fromEntries(Object.entries(deduped).map(([key, alert]) => [
              key, { ...alert, imageUrl: undefined },
            ]))
          : deduped;
        return { alerts, pending: persisted?.pending ?? {} };
      },
    }
  )
);

/** Stable display order: card number, then printing. */
export function sortedAlerts(alerts: Record<string, PriceAlert>): PriceAlert[] {
  return Object.values(alerts).sort(
    (a, b) => a.cardNumber.localeCompare(b.cardNumber) || a.printing.localeCompare(b.printing),
  );
}

/** Unresolved rows first — they are the ones asking the user for something. */
export function sortedPending(pending: Record<string, PendingAlert>): PendingAlert[] {
  return Object.values(pending).sort((a, b) => a.cardNumber.localeCompare(b.cardNumber));
}
