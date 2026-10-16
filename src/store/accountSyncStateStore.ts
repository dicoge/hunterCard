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
 *
 * Nothing here is account data itself; it never leaves the device.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import platformStorage from '../stores/storage';

export interface AccountSyncState {
  ownerId: string | null;
  dirtySeq: number;
  ackedSeq: number;
  lastRevision: number;
  lastSyncedAt: string | null;

  markDirty: () => void;
  /** The server holds everything up to `seq`, at `revision`. */
  markSynced: (revision: number, seq: number) => void;
  /** Local stores now hold `ownerId`'s data, matching server `revision`. */
  adoptOwner: (ownerId: string | null, revision: number) => void;
  reset: () => void;
}

const EMPTY = { ownerId: null, dirtySeq: 0, ackedSeq: 0, lastRevision: 0, lastSyncedAt: null };

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
      }),
    },
  ),
);

export function isAccountSyncDirty(): boolean {
  const s = useAccountSyncStateStore.getState();
  return s.dirtySeq !== s.ackedSeq;
}
