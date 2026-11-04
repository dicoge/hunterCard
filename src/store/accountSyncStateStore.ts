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
 *                 `scanPicks` (2026-11-03, optional) does the same for a scan's version
 *                 pick: instance id → pick fingerprint; absent → clock-only pick rule.
 *   pendingAck    (2026-11-04, optional) a push sent without a response (lost ACK),
 *                 replayed verbatim before the next push/hydrate; see PendingAck.
 *                 Persist version unchanged (1): older state simply lacks it.
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
  /** Scan instance id → scanPickFingerprint() of the server's copy (2026-11-03). Absent in
   *  older baselines, which keep the clock-only pick rule. */
  scanPicks?: Record<string, string>;
}

/**
 * A push whose request was sent but whose response never arrived (status 0, a lost
 * ACK — 2026-11-04 F1). The server may or may not have committed it; replaying the
 * EXACT request with the same idempotency key recovers the original ACK (the server
 * answers an existing key before checking the revision) or proves it never
 * committed (409). Frozen JSON deep copies; owner-scoped; cleared by reset().
 */
export interface PendingAck {
  ownerId: string;
  idempotencyKey: string;
  baseRevision: number;
  /** AccountSyncPatch as sent (kept untyped here to avoid an import cycle). */
  patch: Record<string, unknown>;
  /** The tombstone maps that request carried (SyncTombstones shape). */
  tombstones: Record<string, Record<string, string>>;
  seqAtPush: number;
  createdAt: string;
  attempts: number;
}

export interface AccountSyncState {
  ownerId: string | null;
  dirtySeq: number;
  ackedSeq: number;
  lastRevision: number;
  lastSyncedAt: string | null;
  baseline: SyncBaseline | null;
  /** Optional (2026-11-04): absent in older persisted state = no pending lost ACK. */
  pendingAck?: PendingAck | null;

  markDirty: () => void;
  /** The server holds everything up to `seq`, at `revision`. */
  markSynced: (revision: number, seq: number) => void;
  /** Local stores now hold `ownerId`'s data, matching server `revision`. */
  adoptOwner: (ownerId: string | null, revision: number) => void;
  setBaseline: (baseline: SyncBaseline | null) => void;
  setPendingAck: (pendingAck: PendingAck | null) => void;
  reset: () => void;
}

const EMPTY = { ownerId: null, dirtySeq: 0, ackedSeq: 0, lastRevision: 0, lastSyncedAt: null, baseline: null, pendingAck: null };

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
      setPendingAck: (pendingAck) => set({ pendingAck }),
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
        pendingAck: s.pendingAck ?? null,
      }),
    },
  ),
);

export function isAccountSyncDirty(): boolean {
  const s = useAccountSyncStateStore.getState();
  return s.dirtySeq !== s.ackedSeq;
}
