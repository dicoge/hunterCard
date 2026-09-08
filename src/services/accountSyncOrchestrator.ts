/**
 * Account remote-sync orchestrator (DIC-1380 W4 CR — store wiring).
 *
 * The client boundary in `accountSyncClient.ts` exposes pull / push; this
 * module glues those calls to the three stores that own the state
 * `AccountSyncSnapshot` describes: `deckStore` (decks + collection),
 * `priceAlertStore` (alerts), and `settingsStore` (preferredCurrency +
 * preferredLanguage). Wiring here — not inside each store — keeps every store
 * free of a network dependency and lets the orchestrator serialize the read
 * / hydrate / write cycle so two concurrent triggers cannot interleave.
 *
 * Contract:
 *   • `hydrateAccountSyncFromServer(session)` — GET the snapshot and apply it
 *     to the three stores IN PLACE (Zustand setState, not persist rehydrate)
 *     so already-mounted screens see the server-authoritative state on the
 *     next render. Returns the applied snapshot, or `null` when there is
 *     nothing to pull (empty session, 401, 404, account_deleted).
 *   • `pushAccountSyncFromStores(session, opts)` — snapshot the three stores,
 *     build the patch, POST it. On 409 pull the server, hydrate stores
 *     server-first, and retry the push ONCE with the fresh baseRevision so a
 *     concurrent write from another device never trips a permanent conflict.
 *     Returns the confirmed server snapshot on success, or `null` when the
 *     session has nothing to sync against.
 *   • `snapshotFromLocalStores()` — pure function that reads the three
 *     stores' current state and returns the client's view of an
 *     `AccountSyncSnapshot` `patch`. Exposed so the test suite can pin what
 *     "the client would push right now" without triggering a request.
 *
 * A single in-module mutex serialises pull / push so overlapping triggers
 * (login handoff firing while a store change already queued a push) resolve
 * one at a time. The mutex is intentionally scoped to this module — the
 * per-user server-side idempotency key still fences against cross-device
 * duplicates.
 */
import {
  pullAccountSnapshot,
  pushAccountSnapshot,
  newIdempotencyKey,
  AccountSyncClientError,
  AccountSyncConflictError,
  type AccountSyncSnapshot,
  type AccountSyncPatch,
  type AccountSyncFavorite,
} from './accountSyncClient';
import { useDeckStore } from '../store/deckStore';
import { usePriceAlertStore } from '../stores/priceAlertStore';
import { useSettingsStore, type CurrencyCode, type LanguageCode } from '../store/settingsStore';
import type { Deck } from '../utils/deckRules';
import type { PriceAlert } from '../utils/priceAlerts';

export const ACCOUNT_SYNC_ORCHESTRATOR_VERSION = 1;

// Server tracks the last-observed revision per user; we cache the value the
// server returned so the next push uses it as `baseRevision`. Zero is the
// server's initial revision, so a fresh account with no snapshot correctly
// pushes against revision 0.
let lastKnownRevision = 0;
export function getLastKnownRevision(): number {
  return lastKnownRevision;
}
export function resetLastKnownRevision(): void {
  lastKnownRevision = 0;
}

// Simple promise-chain mutex: `withLock` awaits the previous holder before
// running its body. `.finally` clears the pointer so a rejected body still
// releases the lock. Kept in-module so a test can `resetLastKnownRevision()`
// and be sure nothing else queues behind it.
let syncLock: Promise<unknown> | null = null;
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = Promise.resolve(syncLock).then(fn);
  syncLock = run.catch(() => {});
  return run;
}

function priceAlertList(): PriceAlert[] {
  const { alerts } = usePriceAlertStore.getState();
  return Object.values(alerts).sort(
    (a, b) => a.cardNumber.localeCompare(b.cardNumber) || a.printing.localeCompare(b.printing),
  );
}

function collectionFavorites(collection: Record<string, number>): AccountSyncFavorite[] {
  const addedAt = new Date(0).toISOString();
  const out: AccountSyncFavorite[] = [];
  for (const key of Object.keys(collection)) {
    const sep = key.indexOf('|');
    if (sep === -1) continue;
    const cardNumber = key.slice(0, sep);
    const printing = key.slice(sep + 1);
    if (!cardNumber || !printing) continue;
    out.push({ cardNumber, printing, addedAt });
  }
  out.sort(
    (a, b) => a.cardNumber.localeCompare(b.cardNumber) || a.printing.localeCompare(b.printing),
  );
  return out;
}

/**
 * Read the three stores and return the client's current view of the
 * `AccountSyncSnapshot.patch` shape. Pure — no I/O, no store mutation.
 */
export function snapshotFromLocalStores(): AccountSyncPatch {
  const { decks, collection } = useDeckStore.getState();
  const { preferredCurrency, preferredLanguage } = useSettingsStore.getState();
  return {
    favorites: collectionFavorites(collection),
    decks,
    collection: { ...collection },
    priceAlerts: priceAlertList(),
    settings: { preferredCurrency, preferredLanguage },
  };
}

/**
 * Apply a server snapshot to the three stores. Everything the server
 * authoritatively holds overwrites the local state; anything the server does
 * not include is left alone. This is called from both `hydrateAccountSyncFromServer`
 * and the 409-conflict recovery path in `pushAccountSyncFromStores`.
 */
export function applyServerSnapshotToStores(snapshot: AccountSyncSnapshot): void {
  lastKnownRevision = typeof snapshot.revision === 'number' ? snapshot.revision : 0;

  if (Array.isArray(snapshot.decks)) {
    useDeckStore.setState((s) => ({
      ...s,
      decks: snapshot.decks as Deck[],
    }));
  }
  if (snapshot.collection && typeof snapshot.collection === 'object') {
    useDeckStore.setState((s) => ({
      ...s,
      collection: { ...(snapshot.collection as Record<string, number>) },
    }));
  }
  if (Array.isArray(snapshot.priceAlerts)) {
    const alerts: Record<string, PriceAlert> = {};
    for (const alert of snapshot.priceAlerts as PriceAlert[]) {
      if (!alert?.cardNumber || !alert?.printing) continue;
      alerts[`${alert.cardNumber}|${alert.printing}`] = alert;
    }
    usePriceAlertStore.setState((s) => ({ ...s, alerts }));
  }
  const settings = snapshot.settings;
  if (settings && typeof settings === 'object') {
    const partial: Partial<{ preferredCurrency: CurrencyCode; preferredLanguage: LanguageCode }> = {};
    if (settings.preferredCurrency) partial.preferredCurrency = settings.preferredCurrency as CurrencyCode;
    if (settings.preferredLanguage) partial.preferredLanguage = settings.preferredLanguage as LanguageCode;
    if (Object.keys(partial).length > 0) {
      useSettingsStore.setState((s) => ({ ...s, ...partial }));
    }
  }
}

export interface HydrateOptions {
  /** Optional per-device identifier; propagated to the server as `deviceId`
   *  on the next push so the server can report which device wrote last. */
  deviceId?: string;
}

/**
 * Pull the server snapshot and apply it to the three stores. Returns the
 * applied snapshot, or `null` when there is nothing to hydrate. Idempotent:
 * calling twice with the same session applies the same snapshot twice
 * (last write wins on the store setState).
 */
export async function hydrateAccountSyncFromServer(
  session: string | null | undefined,
): Promise<AccountSyncSnapshot | null> {
  return withLock(async () => {
    const snapshot = await pullAccountSnapshot(session);
    if (!snapshot) return null;
    applyServerSnapshotToStores(snapshot);
    return snapshot;
  });
}

export interface PushOptions extends HydrateOptions {
  /** Idempotency key to send with the push. Defaults to a fresh key each call
   *  so retries from different triggers do not accidentally deduplicate. */
  idempotencyKey?: string;
}

/**
 * Snapshot the three stores and push the patch. On 409 pull the server,
 * hydrate stores server-first, then retry the push ONCE. Any subsequent
 * 409 surfaces to the caller so the wiring can decide whether to back off.
 * Returns the server's confirmed snapshot, or `null` when there is nothing
 * to push against.
 */
export async function pushAccountSyncFromStores(
  session: string | null | undefined,
  opts: PushOptions = {},
): Promise<AccountSyncSnapshot | null> {
  return withLock(async () => {
    const patch = snapshotFromLocalStores();
    const attemptPush = async (
      baseRevision: number,
      idempotencyKey: string,
    ): Promise<AccountSyncSnapshot | null> => {
      const confirmed = await pushAccountSnapshot(session, {
        baseRevision,
        idempotencyKey,
        deviceId: opts.deviceId,
        patch,
      });
      if (confirmed) {
        lastKnownRevision = typeof confirmed.revision === 'number' ? confirmed.revision : baseRevision;
      }
      return confirmed;
    };

    try {
      return await attemptPush(lastKnownRevision, opts.idempotencyKey ?? newIdempotencyKey());
    } catch (err) {
      if (!(err instanceof AccountSyncConflictError)) throw err;
      const serverSnapshot = err.serverSnapshot;
      if (serverSnapshot) {
        applyServerSnapshotToStores(serverSnapshot);
      } else {
        lastKnownRevision = err.serverRevision;
      }
      // Snapshot the stores AGAIN so the retry ships the merged view — the
      // hydrate above mutated `decks / collection / priceAlerts / settings`
      // in place, and re-reading them here is what makes the second attempt
      // more than a stale replay of the first.
      const merged = snapshotFromLocalStores();
      Object.assign(patch, merged);
      return await attemptPush(lastKnownRevision, opts.idempotencyKey ?? newIdempotencyKey());
    }
  });
}

export { AccountSyncClientError, AccountSyncConflictError };
export type { AccountSyncSnapshot, AccountSyncPatch };
