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
import { useFavoritesStore, type FavoriteEntry } from '../store/favoritesStore';
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

// Set while the orchestrator is applying a server snapshot back into the
// stores. The binding checks this flag before scheduling a push so a
// hydrate (or a 409 merge apply) does not immediately fire a redundant
// push against the same revision it just observed (DIC-1380 W5).
let applyingServerState = false;
export function isApplyingServerState(): boolean {
  return applyingServerState;
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

function currentFavorites(): AccountSyncFavorite[] {
  const { favorites } = useFavoritesStore.getState();
  return favorites
    .map((f): AccountSyncFavorite => ({
      cardNumber: f.cardNumber,
      printing: f.printing,
      ...(f.cardId ? { cardId: f.cardId } : {}),
      addedAt: f.addedAt,
    }))
    .sort(
      (a, b) => a.cardNumber.localeCompare(b.cardNumber) || a.printing.localeCompare(b.printing),
    );
}

/**
 * Read the four data stores (deck, priceAlert, settings, favorites) and
 * return the client's current view of the `AccountSyncSnapshot.patch`
 * shape. Pure — no I/O, no store mutation. Favorites are read from the
 * independent `useFavoritesStore` (DIC-1380 W5), not derived from the
 * collection map — bookmarking a card the user does not own must round-
 * trip on its own without touching ownership.
 */
export function snapshotFromLocalStores(): AccountSyncPatch {
  const { decks, collection } = useDeckStore.getState();
  const { preferredCurrency, preferredLanguage } = useSettingsStore.getState();
  return {
    favorites: currentFavorites(),
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
  applyingServerState = true;
  try {
    _applyServerSnapshotToStoresInner(snapshot);
  } finally {
    applyingServerState = false;
  }
}

function _applyServerSnapshotToStoresInner(snapshot: AccountSyncSnapshot): void {
  lastKnownRevision = typeof snapshot.revision === 'number' ? snapshot.revision : 0;

  if (Array.isArray(snapshot.favorites)) {
    useFavoritesStore.getState().replaceAll(snapshot.favorites as FavoriteEntry[]);
  }
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
 * Merge a pre-conflict local patch on top of the server snapshot the 409
 * carried. The DIC-1380 W5 handback failed the previous overwrite behaviour
 * — the retry must never silently discard the local edits the user was
 * already pushing. Rules, per field:
 *
 *   • favorites    — UNION by (cardNumber, printing). Nothing on either
 *                    side is dropped. addedAt keeps the earliest stamp so
 *                    the client history stays truthful.
 *   • collection   — per key `cardNumber|printing`, keep MAX(server, local).
 *                    Ownership is never decreased silently — even if the
 *                    server row is smaller, the local device just proved a
 *                    larger inventory and that stays.
 *   • decks        — union by `deck.id`. When both sides have the same id,
 *                    keep the one with the newer `updatedAt` (local wins
 *                    on tie so the pending edit that triggered this push
 *                    survives).
 *   • priceAlerts  — union by `cardNumber|printing`, newer `updatedAt`
 *                    wins (local wins on tie for the same reason).
 *   • settings     — the local pre-conflict value wins; the client is the
 *                    authority on the user's chosen currency + language.
 */
function mergeLocalOntoServer(
  server: AccountSyncSnapshot | null,
  local: AccountSyncPatch,
): AccountSyncPatch {
  const merged: AccountSyncPatch = {
    favorites: [],
    decks: [],
    collection: {},
    priceAlerts: [],
    settings: local.settings ?? server?.settings ?? undefined,
  };

  // favorites: union keyed by cardNumber|printing, earliest addedAt wins.
  const favMap = new Map<string, AccountSyncFavorite>();
  const rememberFav = (fav: AccountSyncFavorite) => {
    if (!fav?.cardNumber || !fav?.printing) return;
    const key = `${fav.cardNumber}|${fav.printing}`;
    const prev = favMap.get(key);
    if (!prev) { favMap.set(key, { ...fav }); return; }
    const prevMs = Date.parse(prev.addedAt || '') || Number.POSITIVE_INFINITY;
    const nextMs = Date.parse(fav.addedAt || '') || Number.POSITIVE_INFINITY;
    if (nextMs < prevMs) favMap.set(key, { ...fav });
  };
  for (const fav of server?.favorites ?? []) rememberFav(fav);
  for (const fav of local.favorites ?? []) rememberFav(fav);
  merged.favorites = [...favMap.values()].sort(
    (a, b) => a.cardNumber.localeCompare(b.cardNumber) || a.printing.localeCompare(b.printing),
  );

  // collection: MAX per key so ownership never regresses silently.
  const collection: Record<string, number> = {};
  const serverCollection = (server?.collection as Record<string, number> | undefined) ?? {};
  for (const [k, v] of Object.entries(serverCollection)) {
    if (typeof v === 'number' && v > 0) collection[k] = Math.floor(v);
  }
  for (const [k, v] of Object.entries(local.collection ?? {})) {
    const n = typeof v === 'number' && v > 0 ? Math.floor(v) : 0;
    if (n <= 0) continue;
    collection[k] = collection[k] ? Math.max(collection[k], n) : n;
  }
  merged.collection = collection;

  // decks: union by id, newer updatedAt wins; local wins on tie.
  const deckMap = new Map<string, any>();
  const rememberDeck = (deck: any, localSide: boolean) => {
    if (!deck?.id) return;
    const prev = deckMap.get(deck.id);
    if (!prev) { deckMap.set(deck.id, deck); return; }
    const prevMs = Date.parse(prev.updatedAt || '') || 0;
    const nextMs = Date.parse(deck.updatedAt || '') || 0;
    if (nextMs > prevMs) { deckMap.set(deck.id, deck); return; }
    if (nextMs === prevMs && localSide) deckMap.set(deck.id, deck);
  };
  for (const deck of (server?.decks as any[] | undefined) ?? []) rememberDeck(deck, false);
  for (const deck of (local.decks as any[] | undefined) ?? []) rememberDeck(deck, true);
  merged.decks = [...deckMap.values()];

  // priceAlerts: union by cardNumber|printing, newer updatedAt wins.
  const alertMap = new Map<string, any>();
  const rememberAlert = (alert: any, localSide: boolean) => {
    if (!alert?.cardNumber || !alert?.printing) return;
    const key = `${alert.cardNumber}|${alert.printing}`;
    const prev = alertMap.get(key);
    if (!prev) { alertMap.set(key, alert); return; }
    const prevMs = Date.parse(prev.updatedAt || '') || 0;
    const nextMs = Date.parse(alert.updatedAt || '') || 0;
    if (nextMs > prevMs) { alertMap.set(key, alert); return; }
    if (nextMs === prevMs && localSide) alertMap.set(key, alert);
  };
  for (const a of (server?.priceAlerts as any[] | undefined) ?? []) rememberAlert(a, false);
  for (const a of (local.priceAlerts as any[] | undefined) ?? []) rememberAlert(a, true);
  merged.priceAlerts = [...alertMap.values()];

  return merged;
}

/**
 * Apply a merged patch back into the three stores in place. Used after the
 * 409 merge so the retry's `snapshotFromLocalStores()` picks the merged
 * view straight from the stores — the app sees the merged state on the
 * next render.
 */
function applyMergedPatchToStores(patch: AccountSyncPatch): void {
  applyingServerState = true;
  try {
    _applyMergedPatchToStoresInner(patch);
  } finally {
    applyingServerState = false;
  }
}

function _applyMergedPatchToStoresInner(patch: AccountSyncPatch): void {
  if (Array.isArray(patch.favorites)) {
    useFavoritesStore.getState().replaceAll(patch.favorites as FavoriteEntry[]);
  }
  if (Array.isArray(patch.decks)) {
    useDeckStore.setState((s) => ({ ...s, decks: patch.decks as Deck[] }));
  }
  if (patch.collection) {
    useDeckStore.setState((s) => ({ ...s, collection: { ...(patch.collection as Record<string, number>) } }));
  }
  if (Array.isArray(patch.priceAlerts)) {
    const alerts: Record<string, PriceAlert> = {};
    for (const a of patch.priceAlerts as PriceAlert[]) {
      if (!a?.cardNumber || !a?.printing) continue;
      alerts[`${a.cardNumber}|${a.printing}`] = a;
    }
    usePriceAlertStore.setState((s) => ({ ...s, alerts }));
  }
  const settings = patch.settings;
  if (settings) {
    const partial: Partial<{ preferredCurrency: CurrencyCode; preferredLanguage: LanguageCode }> = {};
    if (settings.preferredCurrency) partial.preferredCurrency = settings.preferredCurrency as CurrencyCode;
    if (settings.preferredLanguage) partial.preferredLanguage = settings.preferredLanguage as LanguageCode;
    if (Object.keys(partial).length > 0) {
      useSettingsStore.setState((s) => ({ ...s, ...partial }));
    }
  }
}

/**
 * Snapshot the three stores and push the patch. On 409 the recovery path
 * MERGES the local pre-conflict patch on top of the server snapshot per
 * the rules in `mergeLocalOntoServer` above — union for favorites,
 * MAX-quantity for collection, newer-wins for decks/alerts, local-wins
 * for settings — and retries the push ONCE with the merged view. Local
 * edits are never silently discarded by the 409 recovery path
 * (DIC-1380 W5 handback). Any subsequent 409 surfaces to the caller so
 * the wiring can decide whether to back off.
 */
export async function pushAccountSyncFromStores(
  session: string | null | undefined,
  opts: PushOptions = {},
): Promise<AccountSyncSnapshot | null> {
  return withLock(async () => {
    const localPatch = snapshotFromLocalStores();
    const attemptPush = async (
      patch: AccountSyncPatch,
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
      return await attemptPush(localPatch, lastKnownRevision, opts.idempotencyKey ?? newIdempotencyKey());
    } catch (err) {
      if (!(err instanceof AccountSyncConflictError)) throw err;
      const serverSnapshot = err.serverSnapshot;
      lastKnownRevision = err.serverRevision;
      // MERGE local on top of server, then apply the merged view back to
      // the stores so the app + the retry both see the same merged state.
      const merged = mergeLocalOntoServer(serverSnapshot, localPatch);
      applyMergedPatchToStores(merged);
      return await attemptPush(merged, lastKnownRevision, opts.idempotencyKey ?? newIdempotencyKey());
    }
  });
}

/**
 * Wipe every account-scoped data store back to its empty state. Called on
 * logout / account switch so account A's local decks / favorites /
 * priceAlerts / collection / settings cannot bleed into account B's next
 * hydrate (DIC-1380 W5 handback).
 */
export function clearAccountScopedStores(): void {
  applyingServerState = true;
  try {
    useFavoritesStore.getState().clearAll();
    useDeckStore.setState((s) => ({ ...s, decks: [], collection: {}, activeDeckId: null }));
    usePriceAlertStore.setState((s) => ({ ...s, alerts: {}, pending: {} }));
    // settings (preferredCurrency / preferredLanguage) intentionally survives a
    // logout: it is a UI preference, not account-owned data.
    lastKnownRevision = 0;
  } finally {
    applyingServerState = false;
  }
}

export { mergeLocalOntoServer };

export { AccountSyncClientError, AccountSyncConflictError };
export type { AccountSyncSnapshot, AccountSyncPatch };
