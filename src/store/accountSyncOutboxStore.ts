/**
 * Per-account pending outbox (v41, 2026-10-17). When the device has to drop an
 * account's data — sign-out, or another account taking over — while some of that
 * account's edits have not reached the server yet (offline, or still inside the push
 * debounce), those edits are parked here under the server-verified owner id instead
 * of being lost.
 *
 *   • never shown to, merged into, or pushed for anyone but that same owner: it is
 *     read only by reconcileAccountSync when that owner signs in again
 *   • cleared when the server acknowledges the restored push, or when the account is
 *     deleted
 *   • holds only sync payload data (collection, decks, settings, scan list, deletion
 *     markers) — never photos, diagnostics or credentials
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import platformStorage from '../stores/storage';
import type { AccountSyncPatch } from '../services/accountSyncClient';
import type { SyncBaseline } from './accountSyncStateStore';

export interface OutboxTombstones {
  favoritesRemovedAt?: Record<string, string>;
  priceAlertsRemovedAt?: Record<string, string>;
  deletedDeckIds?: Record<string, string>;
  collectionChangedKeys?: Record<string, string>;
  scanRemovedAt?: Record<string, string>;
}

export interface OutboxEntry {
  patch: AccountSyncPatch;
  tombstones: OutboxTombstones;
  /** What the server held when this device last matched it (deletion provenance). */
  baseline?: SyncBaseline | null;
  savedAt: string;
}

interface OutboxState {
  entries: Record<string, OutboxEntry>;
  save: (ownerId: string, entry: OutboxEntry) => void;
  take: (ownerId: string) => OutboxEntry | null;
  discard: (ownerId: string) => void;
  owners: () => string[];
}

export const useAccountSyncOutboxStore = create<OutboxState>()(
  persist(
    (set, get) => ({
      entries: {},
      save: (ownerId, entry) => set((s) => ({ entries: { ...s.entries, [ownerId]: entry } })),
      take: (ownerId) => get().entries[ownerId] ?? null,
      discard: (ownerId) => set((s) => {
        if (!(ownerId in s.entries)) return s;
        const entries = { ...s.entries };
        delete entries[ownerId];
        return { entries };
      }),
      owners: () => Object.keys(get().entries),
    }),
    {
      name: 'hunterCard-account-sync-outbox',
      version: 1,
      storage: createJSONStorage(() => platformStorage),
      partialize: (s) => ({ entries: s.entries }),
    },
  ),
);
