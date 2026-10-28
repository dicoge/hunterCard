/**
 * Device-side account-sync bookkeeping (v41, 2026-10-17). Persisted so a restart
 * cannot forget what has not reached the server yet.
 *
 *   ownerId       the server-verified account (`user.internalId` from /auth/me or a
 *                 login response — never an email or anything the client typed) whose
 *                 data the local stores hold. null = guest data, never synced.
 *   dirtySeq      bumped on every local user change; `ackedSeq` is the value the last
 *                 server-acknowledged push carried. dirty ⇔ dirtySeq !== ackedSeq.
 *   lastRevision  the revision of the snapshot this device last saw / wrote, so a
 *                 pending push after a restart goes out against the right base.
 *   lastSyncedAt  when this device last matched the server.
 *   baseline      what the server held the last time this device matched it
 *                 (collection quantities, deck id → updatedAt, scan ids). A merge
 *                 compares against it so an entity the device did not touch since
 *                 but another device deleted stays deleted (CR 2026-10-17).
 *                 `deckContent` (2026-10-27, optional) adds deck id → content
 *                 fingerprint, so a deck merge can tell which side really changed
 *                 instead of trusting device clocks; a baseline saved before it
 *                 existed simply lacks it and the old timestamp rules apply.
 *
 * Nothing here is account data itself; it never leaves the device.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import platformStorage from '../stores/storage';

export interface SyncBaseline {
  collection: Record<string, number>;
  decks: Record<string, string>;
  /** Deck id → deckContentFingerprint() of the copy the server held. Absent in older baselines. */
  deckContent?: Record<string, string>;
  /** Scan instance ids; null when the server did not carry the scan list. */
  scans: string[] | null;
}

export interface AccountSyncState {
  ownerId: string | null;
  dirtySeq: number;
  ackedSeq: number;
  lastRevision: number;
  lastSyncedAt: string | null;
  baseline: SyncBaseline | null;

  markDirty: () => void;
  /** The server holds everything up to `seq`, at `revision`. */
  markSynced: (revision: number, seq: number) => void;
  /** Local stores now hold `ownerId`'s data, matching server `revision`. */
  adoptOwner: (ownerId: string | null, revision: number) => void;
  setBaseline: (baseline: SyncBaseline | null) => void;
  reset: () => void;
}

const EMPTY = { ownerId: null, dirtySeq: 0, ackedSeq: 0, lastRevision: 0, lastSyncedAt: null, baseline: null };

export const useAccountSyncStateStore = create<AccountSyncState>()(
  persist(
    (set) => ({
      ...EMPTY,
      markDirty: () => set((s) => ({ dirtySeq: s.dirtySeq + 1 })),
      markSynced: (revision, seq) => set((s) => ({
        lastRevision: revision,
        ackedSeq: Math.max(s.ackedSeq, seq),
        lastSyncedAt: new Date().toISOString(),
      })),
      adoptOwner: (ownerId, revision) => set((s) => ({
        ownerId,
        lastRevision: revision,
        ackedSeq: s.dirtySeq,
        lastSyncedAt: new Date().toISOString(),
      })),
      setBaseline: (baseline) => set({ baseline }),
      reset: () => set({ ...EMPTY }),
    }),
    {
      name: 'hunterCard-account-sync-state',
      version: 1,
      storage: createJSONStorage(() => platformStorage),
      partialize: (s) => ({
        ownerId: s.ownerId,
        dirtySeq: s.dirtySeq,
        ackedSeq: s.ackedSeq,
        lastRevision: s.lastRevision,
        lastSyncedAt: s.lastSyncedAt,
        baseline: s.baseline,
      }),
    },
  ),
);

export function isAccountSyncDirty(): boolean {
  const s = useAccountSyncStateStore.getState();
  return s.dirtySeq !== s.ackedSeq;
}
