/**
 * Legacy card-number tracking list (read-only since DIC-1087).
 *
 * This was the 趨勢追蹤 list: one row per card NUMBER, with an optional target
 * price that named no printing. 到價提醒 replaced it, so nothing writes here any
 * more — the store exists only so an installed device can still read what it
 * persisted and hand it to `priceAlertStore.importLegacyTracking`, which resolves
 * each row to an exact printing or asks the user for one.
 *
 * Once imported the list is cleared; when the last device has migrated this
 * store and its storage key can go.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import platformStorage from './storage';
import type { LegacyTrackedCard } from '../utils/alertMigration';

export interface WatchlistItem extends LegacyTrackedCard {
  addedAt: string;
}

interface WatchlistStore {
  items: WatchlistItem[];
  clearAll: () => void;
}

export const useWatchlistStore = create<WatchlistStore>()(
  persist(
    (set) => ({
      items: [],
      clearAll: () => set({ items: [] }),
    }),
    {
      name: 'watchlist-storage',
      storage: createJSONStorage(() => platformStorage),
      partialize: (s) => ({ items: s.items }),
    }
  )
);
