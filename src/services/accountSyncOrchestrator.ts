/**
 * Account remote-sync orchestrator (DIC-1380 W4 CR — store wiring;
 * W5 — favorites/logout; W6 CR — tombstones + session-race guard).
 *
 * The client boundary in `accountSyncClient.ts` exposes pull / push; this
 * module glues those calls to the four stores that own the state
 * `AccountSyncSnapshot` describes: `deckStore` (decks + collection),
 * `priceAlertStore` (alerts), `settingsStore` (preferredCurrency +
 * preferredLanguage), and `favoritesStore` (bookmarks — independent of
 * ownership). Wiring here — not inside each store — keeps every store
 * free of a network dependency and lets the orchestrator serialize the
 * read / hydrate / write cycle so two concurrent triggers cannot
 * interleave.
 *
 * Contract:
 *   • `hydrateAccountSyncFromServer(session)` — GET the snapshot and apply it
 *     to the stores IN PLACE (Zustand setState, not persist rehydrate) so
 *     already-mounted screens see the server-authoritative state on the
 *     next render. Before applying, re-checks that the current auth session
 *     still matches the one this hydrate was scheduled for — a logout /
 *     account-switch that lands during the network wait must NOT reapply
 *     account A's snapshot on top of account B's clean slate (DIC-1380 W6
 *     handback). Returns the applied snapshot, or `null` when there is
 *     nothing to pull (empty session, 401, 404, account_deleted, or the
 *     session already switched away).
 *   • `pushAccountSyncFromStores(session, opts)` — snapshot the four stores,
 *     build the patch, POST it. On 409 pull the server, MERGE the local
 *     patch on top honoring tombstones (DIC-1380 W6), apply the merged
 *     view back into the stores, and retry the push ONCE with the fresh
 *     baseRevision. The same session-race guard runs before each store
 *     write. Returns the confirmed server snapshot on success, or `null`
 *     when the session has nothing to sync against.
 *   • `snapshotFromLocalStores()` — pure function that reads the stores'
 *     current state and returns the client's view of an
 *     `AccountSyncSnapshot` `patch`. Exposed so the test suite can pin
 *     what "the client would push right now" without triggering a request.
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
import { useAuthStore } from '../store/authStore';
import { useDeckStore } from '../store/deckStore';
import { usePriceAlertStore } from '../stores/priceAlertStore';
import { useSettingsStore, type CurrencyCode, type LanguageCode } from '../store/settingsStore';
import { useFavoritesStore, type FavoriteEntry } from '../store/favoritesStore';
import type { Deck } from '../utils/deckRules';
import type { PriceAlert } from '../utils/priceAlerts';
import { FEATURES } from '../config/releaseFlags';
import { useScanSessionStore, scanSessionForSync } from '../stores/scanSessionStore';
import { useAccountSyncStateStore, type SyncBaseline } from '../store/accountSyncStateStore';
import { useAccountSyncOutboxStore, type OutboxEntry } from '../store/accountSyncOutboxStore';
import { laterClear, unionScanEntries, emptyScanSession } from '../utils/scanSessionSync';

export const ACCOUNT_SYNC_ORCHESTRATOR_VERSION = 2;

// Server tracks the last-observed revision per user; we cache the value the
// server returned so the next push uses it as `baseRevision`. Zero is the
// server's initial revision, so a fresh account with no snapshot correctly
// pushes against revision 0.
let lastKnownRevision = 0;
export function getLastKnownRevision(): number {
  return lastKnownRevision;
}
/** Continue from the revision this device persisted (v41: a restart must not reset the base). */
export function setLastKnownRevision(revision: number): void {
  lastKnownRevision = Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
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

// Account epoch (CR 2026-10-17): bumped whenever whose data the local stores hold may
// change — sign-in, sign-out, account switch, a clear. Every asynchronous sync call
// captures it (with the session and the server-verified account id) when it is MADE,
// and re-checks all three when it gets the lock — before it reads the stores to send —
// and after every network wait, before it writes anything back. A call queued for
// account A therefore can never send B's (or a guest's) data under A's bearer, nor
// apply A's reply to B's stores, even if the session string comes back unchanged.
let accountEpoch = 0;
export function bumpAccountSyncEpoch(): void {
  accountEpoch += 1;
}
export function getAccountSyncEpoch(): number {
  return accountEpoch;
}
function guardFor(session: string | null | undefined): () => boolean {
  const epoch = accountEpoch;
  const uid = currentUserId();
  return () => accountEpoch === epoch && sessionStillCurrent(session) && (uid === null || currentUserId() === uid);
}
/** The local stores hold the signed-in account's data (or no verified id is known yet). */
function storesBelongToCurrentAccount(): boolean {
  const uid = currentUserId();
  return uid === null || useAccountSyncStateStore.getState().ownerId === uid;
}

/** Read the current auth session from the store. Test suites replace
 *  `useAuthStore` via a mock, so keep this indirection cheap. */
function currentSession(): string | null {
  const s = useAuthStore.getState().session;
  return typeof s === 'string' && s.length > 0 ? s : null;
}

/** DIC-1380 W6: guard every store-mutation path against a stale in-flight
 *  response. The `session` we were scheduled for must still be the current
 *  bearer AT THE MOMENT of the write; a logout / account-switch during the
 *  network wait invalidates the response. */
function sessionStillCurrent(scheduledSession: string | null | undefined): boolean {
  const cur = currentSession();
  if (!cur) return false;
  return cur === scheduledSession;
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
  return activeDomainsOnly({
    favorites: currentFavorites(),
    decks,
    collection: { ...collection },
    priceAlerts: priceAlertList(),
    settings: { preferredCurrency, preferredLanguage },
    scanSession: scanSessionForSync(FEATURES.buyPrice),
  });
}

/**
 * v41: only the data of surfaces this build shows travels. Under Store MVP the
 * bookmark (favorites) and price-alert surfaces are hidden, so their fields are
 * left out of every push — the server keeps whatever it holds for them, and a
 * hidden surface never writes. Collection, decks, settings and the 估值清單 are
 * visible in every profile.
 */
export function activeDomainsOnly(patch: AccountSyncPatch): AccountSyncPatch {
  const out: AccountSyncPatch = { ...patch };
  if (!FEATURES.favorites) delete out.favorites;
  if (!FEATURES.watchlist) delete out.priceAlerts;
  return out;
}

/** True when the local stores hold anything a guest would lose by being overwritten. */
export function localStoresHaveData(): boolean {
  const { decks, collection } = useDeckStore.getState();
  return decks.length > 0
    || Object.values(collection).some((q) => q > 0)
    || useScanSessionStore.getState().cards.length > 0
    || (FEATURES.favorites && useFavoritesStore.getState().favorites.length > 0)
    || (FEATURES.watchlist && Object.keys(usePriceAlertStore.getState().alerts).length > 0);
}

type SyncTombstones = {
  favoritesRemovedAt: Record<string, string>;
  priceAlertsRemovedAt: Record<string, string>;
  deletedDeckIds: Record<string, string>;
  collectionChangedKeys: Record<string, string>;
  scanRemovedAt: Record<string, string>;
};

function currentTombstones(): SyncTombstones {
  const deck = useDeckStore.getState();
  return {
    favoritesRemovedAt: { ...useFavoritesStore.getState().removals },
    priceAlertsRemovedAt: { ...usePriceAlertStore.getState().removals },
    deletedDeckIds: { ...deck.deletedDeckIds },
    collectionChangedKeys: { ...deck.collectionChangedKeys },
    scanRemovedAt: { ...useScanSessionStore.getState().removals },
  };
}

/** Drop only the markers a push carried; one made while it was in flight stays. */
function clearAckedTombstones(acked: SyncTombstones): void {
  const without = (cur: Record<string, string>, done: Record<string, string>) => {
    const out = { ...cur };
    for (const [k, v] of Object.entries(done)) if (out[k] === v) delete out[k];
    return out;
  };
  useFavoritesStore.setState((s) => ({ ...s, removals: without(s.removals, acked.favoritesRemovedAt) }));
  usePriceAlertStore.setState((s) => ({ ...s, removals: without(s.removals, acked.priceAlertsRemovedAt) }));
  useDeckStore.setState((s) => ({
    ...s,
    deletedDeckIds: without(s.deletedDeckIds, acked.deletedDeckIds),
    collectionChangedKeys: without(s.collectionChangedKeys, acked.collectionChangedKeys),
  }));
  useScanSessionStore.setState((s) => ({ ...s, removals: without(s.removals, acked.scanRemovedAt) }));
}

function clearAllSyncTombstones(): void {
  useFavoritesStore.getState().clearRemovals();
  useDeckStore.getState().clearSyncTombstones();
  usePriceAlertStore.getState().clearRemovals();
  useScanSessionStore.getState().clearSyncTombstones();
}

/** What the server held, reduced to what a later merge needs to recognise deletions. */
export function baselineFrom(snapshot: Partial<AccountSyncSnapshot> | AccountSyncPatch | null | undefined): SyncBaseline {
  const collection: Record<string, number> = {};
  const rawCollection = snapshot?.collection as Record<string, number> | undefined;
  if (rawCollection && typeof rawCollection === 'object') {
    for (const [k, v] of Object.entries(rawCollection)) if (typeof v === 'number' && v > 0) collection[k] = Math.floor(v);
  }
  const decks: Record<string, string> = {};
  const deckContent: Record<string, string> = {};
  if (Array.isArray(snapshot?.decks)) {
    for (const d of snapshot!.decks as any[]) {
      if (!d?.id) continue;
      decks[d.id] = String(d.updatedAt ?? '');
      deckContent[d.id] = deckContentFingerprint(d);
    }
  }
  const entries = (snapshot as any)?.scanSession?.entries;
  const scans = Array.isArray(entries) ? entries.map((e: any) => e?.instanceId).filter((id: unknown) => typeof id === 'string') : null;
  return { collection, decks, deckContent, scans };
}

/**
 * What a deck CONTAINS, independent of any clock (2026-10-27): canonical JSON with
 * sorted keys, null/undefined fields dropped (the server drops them too) and the
 * top-level `updatedAt` excluded, hashed to a short fixed-size string so the
 * persisted baseline stays small. Two copies with the same fingerprint hold the
 * same name, zones, slots, cards and origin.
 *
 * `origin.importedAt` is compared the way the server stores it (cleanIso in
 * api/_lib/account-sync-store.ts: trim, parse, re-emit as UTC ISO), so a local
 * `+08:00` form and the server's `Z` form of the same instant are the same
 * content, while a different import instant is not. A value the server would
 * reject (not a string, empty, unparseable) is kept verbatim: it can never equal
 * a server copy, so that deck falls back to the timestamp rules.
 */
function canonicalIso(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const t = Date.parse(value.trim());
  return value.trim() && Number.isFinite(t) ? new Date(t).toISOString() : value;
}

export function deckContentFingerprint(deck: unknown): string {
  const canon = (v: unknown, top: boolean): unknown => {
    if (Array.isArray(v)) return v.map((x) => canon(x, false));
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x === undefined || x === null || (top && k === 'updatedAt')) continue;
        o[k] = top && k === 'origin' && x && typeof x === 'object' && !Array.isArray(x)
          ? canon({ ...(x as Record<string, unknown>), importedAt: canonicalIso((x as Record<string, unknown>).importedAt) }, false)
          : canon(x, false);
      }
      return o;
    }
    return v;
  };
  const text = JSON.stringify(canon(deck, true));
  // Two independent 53-bit cyrb53 hashes plus the length.
  const cyrb53 = (seed: number) => {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  };
  return `${text.length.toString(36)}.${cyrb53(1)}.${cyrb53(0x9e3779b9)}`;
}

/**
 * After a server ACK (CR b16d7ab): the server stores its CANONICAL `selectedAt` — it
 * caps a pick time ahead of its clock to now (and normalises the ISO form). A local
 * scan entry whose pick is still exactly what this push sent takes the server's
 * value, so a device clock running fast cannot keep a future time locally and win a
 * later 409 merge against a newer pick made elsewhere. An entry whose pick changed
 * while the request was in flight (version, confidence or pick time differs from
 * what was sent) is left alone — that newer local pick is still pending. Only
 * `selectedAt` is adopted, only when the server kept the same pick; nothing else in
 * the stores is touched and the device's dirty state is unchanged.
 */
function reconcileAckedScanSelections(pushed: AccountSyncPatch, confirmed: AccountSyncSnapshot): void {
  const sent = new Map((pushed.scanSession?.entries ?? []).map((e) => [e.instanceId, e]));
  const acked = new Map((confirmed.scanSession?.entries ?? []).map((e) => [e.instanceId, e]));
  if (sent.size === 0 || acked.size === 0) return;
  let changed = false;
  const next = useScanSessionStore.getState().cards.map((c) => {
    const s = sent.get(c.instanceId);
    const a = acked.get(c.instanceId);
    if (!s || !a) return c;
    const unchangedSinceSent = c.selectedVersion === s.selectedVersion
      && c.versionConfident === s.versionConfident
      && (c.selectedAt ?? null) === (s.selectedAt ?? null);
    const serverKeptPick = a.selectedVersion === s.selectedVersion && a.versionConfident === s.versionConfident;
    if (!unchangedSinceSent || !serverKeptPick || (a.selectedAt ?? null) === (c.selectedAt ?? null)) return c;
    changed = true;
    const { selectedAt: _dropped, ...rest } = c;
    return a.selectedAt ? { ...rest, selectedAt: a.selectedAt } : rest;
  });
  if (!changed) return;
  applyingServerState = true;
  try {
    useScanSessionStore.setState({ cards: next });
  } finally {
    applyingServerState = false;
  }
}

/** Everything a merge or a push would send, for "did the user change anything meanwhile?". */
function localFingerprint(): string {
  return JSON.stringify(snapshotFromLocalStores());
}

/**
 * Apply a server snapshot to the four stores. Everything the server
 * authoritatively holds overwrites the local state; anything the server does
 * not include is left alone. This is called from both `hydrateAccountSyncFromServer`
 * and (via `applyMergedPatchToStores`) the 409-conflict recovery path in
 * `pushAccountSyncFromStores`.
 */
export function applyServerSnapshotToStores(snapshot: AccountSyncSnapshot): void {
  applyingServerState = true;
  try {
    _applyServerSnapshotToStoresInner(snapshot);
    // Server snapshot is the new baseline — every prior local
    // deletion/decrease has either been reflected by the pull or was
    // overwritten by it. Drop the tombstones so a stale local write
    // does not later mask a legitimate server value.
    useFavoritesStore.getState().clearRemovals();
    useDeckStore.getState().clearSyncTombstones();
    usePriceAlertStore.getState().clearRemovals();
    useScanSessionStore.getState().clearSyncTombstones();
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
  // A server that predates the 估值清單 field sends none: the local list stays.
  if (snapshot.scanSession && Array.isArray(snapshot.scanSession.entries)) {
    useScanSessionStore.getState().replaceFromSync(snapshot.scanSession);
  }
}

export interface HydrateOptions {
  /** Optional per-device identifier; propagated to the server as `deviceId`
   *  on the next push so the server can report which device wrote last. */
  deviceId?: string;
}

/**
 * Pull the server snapshot and apply it to the four stores. Returns the
 * applied snapshot, or `null` when there is nothing to hydrate (empty
 * session, tombstone response, or the auth session already changed while
 * we were awaiting the network — the DIC-1380 W6 stale-hydrate race).
 */
export async function hydrateAccountSyncFromServer(
  session: string | null | undefined,
  opts: { adoptOwnerId?: string | null } = {},
): Promise<AccountSyncSnapshot | null> {
  const still = guardFor(session);
  // Captured when the hydrate is ASKED for, not when it gets the lock: an edit made
  // while it waits behind another sync call (e.g. right after an account switch) is
  // "during the pull" too.
  const before = localFingerprint();
  const seqBefore = useAccountSyncStateStore.getState().dirtySeq;
  return withLock(async () => {
    if (!still()) return null;
    const snapshot = await pullAccountSnapshot(session);
    if (!snapshot) return null;
    // DIC-1380 W6 handback: an account-switch or logout that happened
    // during the network wait means this snapshot belongs to a previous
    // account. Applying it now would leak account A's state into account
    // B's stores. Drop the response silently — the next hydrate for the
    // new session will get the right snapshot.
    if (!still()) return null;
    const st = useAccountSyncStateStore.getState();
    const owner = opts.adoptOwnerId !== undefined ? opts.adoptOwnerId : currentUserId();
    const ownerPending = st.ownerId !== null && st.ownerId === owner && st.dirtySeq !== st.ackedSeq;
    const editedDuringPull = st.dirtySeq !== seqBefore || localFingerprint() !== before;
    const revision = typeof snapshot.revision === 'number' ? snapshot.revision : 0;
    if (!editedDuringPull && !ownerPending) {
      applyServerSnapshotToStores(snapshot);
      if (opts.adoptOwnerId !== undefined) st.adoptOwner(opts.adoptOwnerId, revision);
      useAccountSyncStateStore.getState().setBaseline(baselineFrom(snapshot));
      return snapshot;
    }
    // CR 2026-10-17: the user changed something while the pull was in flight (or
    // this account has changes the server has not acknowledged). Overwriting would
    // lose them silently: merge them onto the snapshot with the 409 rules instead,
    // keep their markers, and stay dirty so they are pushed on top of `revision`.
    const merged = mergeLocalOntoServer(snapshot, snapshotFromLocalStores(), currentTombstones(), st.baseline);
    applyMergedPatchToStores(merged);
    lastKnownRevision = revision;
    if (opts.adoptOwnerId !== undefined) st.adoptOwner(opts.adoptOwnerId, revision);
    else useAccountSyncStateStore.setState({ lastRevision: revision });
    const after = useAccountSyncStateStore.getState();
    after.setBaseline(baselineFrom(snapshot));
    after.markDirty();
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
 * carried, honoring tombstones so a genuine local deletion is preserved
 * against a concurrent server add (DIC-1380 W6 handback). Rules, per field:
 *
 *   • favorites    — UNION by (cardNumber, printing) MINUS the local
 *                    removal tombstones. A server entry whose key has a
 *                    local `removedAt` at or after its `addedAt` is
 *                    dropped: the client-side unfavorite happened after
 *                    the server's copy so the removal wins on the retry.
 *   • collection   — per key `cardNumber|printing`:
 *                       - if the local store WROTE the key after the last
 *                         hydrate (`collectionChangedKeys[key]` present)
 *                         the local value wins, INCLUDING a decrease or a
 *                         missing entry (deletion). Local writes are the
 *                         user's most recent evidence of ownership.
 *                       - otherwise MAX(server, local), so a value the
 *                         local device never touched cannot silently
 *                         reduce the server view.
 *   • decks        — server entries whose id is in
 *                    `deletedDeckIds` with a `deletedAt` >= the server
 *                    `updatedAt` are DROPPED (local delete beat the
 *                    server add). The rest merges by id, newer
 *                    `updatedAt` winning (local wins on tie).
 *   • priceAlerts  — server entries with a matching local removal
 *                    tombstone (removedAt >= server `updatedAt`) are
 *                    DROPPED. The rest merges by `cardNumber|printing`,
 *                    newer `updatedAt` winning (local wins on tie).
 *   • settings     — the local pre-conflict value wins; the client is the
 *                    authority on the user's chosen currency + language.
 */
function mergeLocalOntoServer(
  server: AccountSyncSnapshot | null,
  local: AccountSyncPatch,
  tombstones?: {
    favoritesRemovedAt?: Record<string, string>;
    priceAlertsRemovedAt?: Record<string, string>;
    deletedDeckIds?: Record<string, string>;
    collectionChangedKeys?: Record<string, string>;
    scanRemovedAt?: Record<string, string>;
  },
  baseline?: SyncBaseline | null,
): AccountSyncPatch {
  const favoritesRemovedAt = tombstones?.favoritesRemovedAt || {};
  const priceAlertsRemovedAt = tombstones?.priceAlertsRemovedAt || {};
  const deletedDeckIds = tombstones?.deletedDeckIds || {};
  const collectionChangedKeys = tombstones?.collectionChangedKeys || {};

  const merged: AccountSyncPatch = {
    favorites: [],
    decks: [],
    collection: {},
    priceAlerts: [],
    settings: local.settings ?? server?.settings ?? undefined,
  };

  // favorites: union keyed by cardNumber|printing, earliest addedAt wins,
  // MINUS keys whose local removal tombstone is >= the server's addedAt.
  const favMap = new Map<string, AccountSyncFavorite>();
  const rememberFav = (fav: AccountSyncFavorite, side: 'server' | 'local') => {
    if (!fav?.cardNumber || !fav?.printing) return;
    const key = `${fav.cardNumber}|${fav.printing}`;
    if (side === 'server') {
      // Local unfavorite that happened at-or-after the server's add wins.
      const removedAt = favoritesRemovedAt[key];
      if (removedAt) {
        const removedMs = Date.parse(removedAt) || 0;
        const addedMs = Date.parse(fav.addedAt || '') || 0;
        if (removedMs >= addedMs) return;
      }
    }
    const prev = favMap.get(key);
    if (!prev) { favMap.set(key, { ...fav }); return; }
    const prevMs = Date.parse(prev.addedAt || '') || Number.POSITIVE_INFINITY;
    const nextMs = Date.parse(fav.addedAt || '') || Number.POSITIVE_INFINITY;
    if (nextMs < prevMs) favMap.set(key, { ...fav });
  };
  for (const fav of server?.favorites ?? []) rememberFav(fav, 'server');
  for (const fav of local.favorites ?? []) rememberFav(fav, 'local');
  merged.favorites = [...favMap.values()].sort(
    (a, b) => a.cardNumber.localeCompare(b.cardNumber) || a.printing.localeCompare(b.printing),
  );

  // collection: per-key merge. If the local device WROTE the key after
  // the last hydrate the local value wins outright (including 0 → the
  // absence in the local map is the value); otherwise MAX(server, local)
  // so a key nobody touched cannot silently regress.
  const collection: Record<string, number> = {};
  const serverCollection = (server?.collection as Record<string, number> | undefined) ?? {};
  const localCollection = local.collection ?? {};
  const allKeys = new Set<string>([
    ...Object.keys(serverCollection),
    ...Object.keys(localCollection),
    ...Object.keys(collectionChangedKeys),
  ]);
  for (const key of allKeys) {
    const localWroteIt = Object.prototype.hasOwnProperty.call(collectionChangedKeys, key);
    if (localWroteIt) {
      const localVal = typeof localCollection[key] === 'number' ? Math.floor(localCollection[key]) : 0;
      if (localVal > 0) collection[key] = localVal;
      continue;
    }
    const serverVal = typeof serverCollection[key] === 'number' ? Math.floor(serverCollection[key]) : 0;
    const localVal = typeof localCollection[key] === 'number' ? Math.floor(localCollection[key]) : 0;
    // CR 2026-10-17: untouched here since this device last matched the server →
    // the server's value is newer information (another device's decrease or
    // deletion); MAX would resurrect it. Without a baseline: MAX, as before.
    const baseVal = baseline && server?.collection ? Math.floor(baseline.collection[key] ?? 0) : null;
    const chosen = baseVal !== null && localVal === baseVal ? serverVal : Math.max(serverVal, localVal);
    if (chosen > 0) collection[key] = chosen;
  }
  merged.collection = collection;

  // decks: union by id, newer updatedAt wins; local wins on tie; drop server
  // entries whose id has a local delete tombstone >= the server updatedAt.
  // 2026-10-27: when the baseline carries the deck's content fingerprint, the
  // side that did NOT change since this device last matched the server yields to
  // the side that did, whatever the device clocks say (a fast-clock device's
  // untouched copy must not overwrite a slow-clock device's newer edit). Only a
  // deck changed on BOTH sides, or one without a fingerprint, uses timestamps.
  const deckBase = (id: string): string | undefined =>
    (baseline && Array.isArray(server?.decks) ? baseline.deckContent?.[id] : undefined);
  const unchangedSinceBase = (deck: any): boolean | null => {
    const base = deckBase(deck?.id);
    return base === undefined ? null : deckContentFingerprint(deck) === base;
  };
  const deckMap = new Map<string, any>();
  const rememberDeck = (deck: any, side: 'server' | 'local') => {
    if (!deck?.id) return;
    if (side === 'server') {
      const deletedAt = deletedDeckIds[deck.id];
      if (deletedAt) {
        // Deleted here, and the server copy is exactly what this device last saw:
        // the deletion is the only change → it wins (no resurrection by clock).
        if (unchangedSinceBase(deck) === true) return;
        const deletedMs = Date.parse(deletedAt) || 0;
        const updatedMs = Date.parse(deck.updatedAt || '') || 0;
        if (deletedMs >= updatedMs) return;
      }
    }
    const prev = deckMap.get(deck.id);
    if (!prev) { deckMap.set(deck.id, deck); return; }
    const localSame = unchangedSinceBase(deck);
    const serverSame = unchangedSinceBase(prev);
    if (localSame !== null && serverSame !== null && localSame !== serverSame) {
      if (serverSame) deckMap.set(deck.id, deck);
      return;
    }
    const prevMs = Date.parse(prev.updatedAt || '') || 0;
    const nextMs = Date.parse(deck.updatedAt || '') || 0;
    if (nextMs > prevMs) { deckMap.set(deck.id, deck); return; }
    if (nextMs === prevMs && side === 'local') deckMap.set(deck.id, deck);
  };
  for (const deck of (server?.decks as any[] | undefined) ?? []) rememberDeck(deck, 'server');
  // CR 2026-10-17: a deck the server no longer has, that this device had when it
  // last matched the server and has not edited since, was deleted elsewhere.
  // "Not edited" is the content fingerprint when the baseline has one (a slow-clock
  // edit stamped before the baseline is still an edit), else the timestamp.
  const serverDeckIds = new Set(((server?.decks as any[] | undefined) ?? []).map((d) => d?.id));
  const deletedElsewhere = (deck: any) => !!baseline && Array.isArray(server?.decks) && !serverDeckIds.has(deck?.id)
    && baseline.decks[deck?.id] !== undefined
    && (unchangedSinceBase(deck)
      ?? (Date.parse(deck?.updatedAt || '') || 0) <= (Date.parse(baseline.decks[deck.id]) || 0));
  for (const deck of (local.decks as any[] | undefined) ?? []) if (!deletedElsewhere(deck)) rememberDeck(deck, 'local');
  merged.decks = [...deckMap.values()];

  // priceAlerts: union by cardNumber|printing, newer updatedAt wins; drop
  // server entries whose key has a local removal tombstone >= server
  // updatedAt.
  const alertMap = new Map<string, any>();
  const rememberAlert = (alert: any, side: 'server' | 'local') => {
    if (!alert?.cardNumber || !alert?.printing) return;
    const key = `${alert.cardNumber}|${alert.printing}`;
    if (side === 'server') {
      const removedAt = priceAlertsRemovedAt[key];
      if (removedAt) {
        const removedMs = Date.parse(removedAt) || 0;
        const updatedMs = Date.parse(alert.updatedAt || '') || 0;
        if (removedMs >= updatedMs) return;
      }
    }
    const prev = alertMap.get(key);
    if (!prev) { alertMap.set(key, alert); return; }
    const prevMs = Date.parse(prev.updatedAt || '') || 0;
    const nextMs = Date.parse(alert.updatedAt || '') || 0;
    if (nextMs > prevMs) { alertMap.set(key, alert); return; }
    if (nextMs === prevMs && side === 'local') alertMap.set(key, alert);
  };
  for (const a of (server?.priceAlerts as any[] | undefined) ?? []) rememberAlert(a, 'server');
  for (const a of (local.priceAlerts as any[] | undefined) ?? []) rememberAlert(a, 'local');
  merged.priceAlerts = [...alertMap.values()];

  // 估值清單 (v41): union by instanceId, minus this device's removals and anything
  // scanned at/before the later clear of either side.
  if (local.scanSession || server?.scanSession) {
    const clearedAt = laterClear(server?.scanSession?.clearedAt, local.scanSession?.clearedAt);
    // CR 2026-10-17: a scan this device had when it last matched the server, that
    // the server no longer has, was removed on another device — it must not come
    // back through this device's copy.
    const baseScans = baseline?.scans && server?.scanSession ? new Set(baseline.scans) : null;
    const serverScanIds = new Set((server?.scanSession?.entries ?? []).map((e) => e.instanceId));
    const localEntries = (local.scanSession?.entries ?? []).filter(
      (e) => !(baseScans && baseScans.has(e.instanceId) && !serverScanIds.has(e.instanceId)),
    );
    merged.scanSession = {
      entries: unionScanEntries(
        [server?.scanSession?.entries ?? [], localEntries],
        clearedAt,
        tombstones?.scanRemovedAt ?? {},
      ),
      clearedAt,
    };
  }

  return merged;
}

/**
 * Guest data meeting an account for the first time on this device (v41). Nothing
 * the guest made may be lost and nothing may be doubled:
 *   • collection — MAX per cardNumber|printing (owning 2 locally and 3 in the
 *     account means 3, not 5: the same physical cards were most likely counted on
 *     both sides; never fewer than either side)
 *   • decks      — union by deck id (ids are random per device), newer updatedAt wins
 *   • 估值清單    — union by scan instanceId; the account's own clear time still
 *                  applies to the account's older entries
 *   • settings   — the device's current choice (what the user is looking at)
 *   • favorites / price alerts — the account's (hidden surfaces in Store MVP; in the
 *     full app the union rules of mergeLocalOntoServer apply)
 */
export function mergeGuestOntoServer(server: AccountSyncSnapshot | null, local: AccountSyncPatch): AccountSyncPatch {
  const base = mergeLocalOntoServer(server, local);
  const collection: Record<string, number> = {};
  const serverCollection = (server?.collection as Record<string, number> | undefined) ?? {};
  for (const key of new Set([...Object.keys(serverCollection), ...Object.keys(local.collection ?? {})])) {
    const v = Math.max(Math.floor(serverCollection[key] ?? 0), Math.floor(local.collection?.[key] ?? 0));
    if (v > 0) collection[key] = v;
  }
  const serverClear = server?.scanSession?.clearedAt ?? null;
  const serverEntries = unionScanEntries([server?.scanSession?.entries ?? []], serverClear);
  const scanSession = {
    entries: unionScanEntries([serverEntries, local.scanSession?.entries ?? []], null),
    clearedAt: serverClear,
  };
  return activeDomainsOnly({ ...base, collection, scanSession });
}

/**
 * Apply a merged patch back into the four stores in place. Used after the
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
    // DIC-1380 W7 CR: MUST preserve tombstones across the 409 merge apply.
    // A subsequent 409 during the same push cycle — or a caller re-
    // scheduling after a rethrow — needs the tombstones to be intact so
    // the retry still honors the local unfavorite. Only a server-ACKed
    // push (attemptPush success branch) or a fresh hydrate is allowed to
    // drop the tombstones.
    useFavoritesStore.getState().replaceAllPreservingTombstones(patch.favorites as FavoriteEntry[]);
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
  if (patch.scanSession) {
    useScanSessionStore.getState().replaceFromSync(patch.scanSession, { keepRemovals: true });
  }
}

/**
 * Snapshot the four stores and push the patch. On 409 the recovery path
 * MERGES the local pre-conflict patch on top of the server snapshot per
 * the tombstone-aware rules in `mergeLocalOntoServer` — union with
 * removal-wins for favorites, per-key local-wins-if-changed for
 * collection (including decreases), tombstone-aware newer-wins for
 * decks/alerts, local-wins for settings — and retries the push ONCE with
 * the merged view. Local edits and deletions are never silently discarded
 * (DIC-1380 W5 + W6 handbacks). Any subsequent 409 surfaces to the caller
 * so the wiring can decide whether to back off.
 *
 * The retry's server response is only applied to the stores if the auth
 * session is STILL the one this push was scheduled for — an account switch
 * during the retry must not leak account A's confirmed revision counter
 * onto account B (DIC-1380 W6 stale-response guard).
 */
export async function pushAccountSyncFromStores(
  session: string | null | undefined,
  opts: PushOptions = {},
): Promise<AccountSyncSnapshot | null> {
  const still = guardFor(session);
  return withLock(async () => {
    // CR 2026-10-17 (P1): validated BEFORE the stores are read. A push queued for
    // account A behind another sync call must not read what the stores hold after
    // a switch to B / a guest and send it under A's bearer.
    if (!still() || !storesBelongToCurrentAccount()) return null;
    let localPatch = snapshotFromLocalStores();
    let tombstones = currentTombstones();
    // Everything changed up to here is in this push; a change made while it is in
    // flight keeps the device dirty.
    let seqAtPush = useAccountSyncStateStore.getState().dirtySeq;

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
        // DIC-1380 W6: only trust the response if the session bearer (and,
        // CR 2026-10-17, the account epoch) is still the one this push was
        // made for.
        if (!still()) return null;
        lastKnownRevision = typeof confirmed.revision === 'number' ? confirmed.revision : baseRevision;
        // Server has our removals + decreases — drop exactly those markers so
        // the next push does not carry them again (newer ones stay).
        clearAckedTombstones(tombstones);
        reconcileAckedScanSelections(patch, confirmed);
        const st = useAccountSyncStateStore.getState();
        st.markSynced(lastKnownRevision, seqAtPush);
        st.setBaseline(baselineFrom(confirmed.collection || confirmed.decks || confirmed.scanSession ? confirmed : patch));
        // Anything this owner had parked is now on the server too.
        if (st.ownerId) useAccountSyncOutboxStore.getState().discard(st.ownerId);
      }
      return confirmed;
    };

    try {
      return await attemptPush(localPatch, lastKnownRevision, opts.idempotencyKey ?? newIdempotencyKey());
    } catch (err) {
      if (!(err instanceof AccountSyncConflictError)) throw err;
      // DIC-1380 W6: an account switch that landed during the first
      // push means the retry would apply account A's conflict payload
      // to account B's stores. Bail out silently.
      if (!still()) return null;
      const serverSnapshot = err.serverSnapshot;
      lastKnownRevision = err.serverRevision;
      // CR 2026-10-17: merge what the stores hold NOW — an edit made while the
      // first attempt was in flight is part of it, not overwritten by the merge.
      localPatch = snapshotFromLocalStores();
      tombstones = currentTombstones();
      seqAtPush = useAccountSyncStateStore.getState().dirtySeq;
      // MERGE local on top of server (honoring tombstones and, for deletions made
      // on other devices, this device's baseline), then apply the merged view back
      // to the stores so the app + the retry both see the same merged state.
      const merged = mergeLocalOntoServer(
        serverSnapshot, localPatch, tombstones, useAccountSyncStateStore.getState().baseline,
      );
      applyMergedPatchToStores(merged);
      return await attemptPush(activeDomainsOnly(merged), lastKnownRevision, opts.idempotencyKey ?? newIdempotencyKey());
    }
  });
}

/**
 * Wipe every account-scoped data store back to its empty state. Called on
 * logout / account switch so account A's local decks / favorites /
 * priceAlerts / collection / settings cannot bleed into account B's next
 * hydrate (DIC-1380 W5 handback). Also clears the sync tombstones — they
 * belong to account A's history and must not attach to account B's
 * fresh state.
 */
export function clearAccountScopedStores(): void {
  // Whatever was in flight for the data being cleared is void now.
  bumpAccountSyncEpoch();
  applyingServerState = true;
  try {
    useFavoritesStore.getState().clearAll();
    useDeckStore.setState((s) => ({
      ...s,
      decks: [],
      collection: {},
      activeDeckId: null,
      deletedDeckIds: {},
      collectionChangedKeys: {},
    }));
    usePriceAlertStore.setState((s) => ({ ...s, alerts: {}, pending: {}, removals: {} }));
    // v41: the 估值清單 is account data now — the next person on this device must
    // not see the previous account's scans.
    useScanSessionStore.getState().replaceFromSync(emptyScanSession());
    useScanSessionStore.setState({ lastScanKey: null, lastScanAt: null });
    // settings (preferredCurrency / preferredLanguage) intentionally survives a
    // logout: it is a UI preference, not account-owned data.
    lastKnownRevision = 0;
  } finally {
    applyingServerState = false;
  }
}

/**
 * Before the device drops the current owner's data (sign-out, another account), park
 * the edits the server has not acknowledged in that owner's outbox (v41) — they come
 * back when the same account signs in again, and are never shown to anyone else.
 * Nothing is parked without a server-verified owner or without pending changes.
 */
export function parkPendingForOwner(): boolean {
  const st = useAccountSyncStateStore.getState();
  if (!st.ownerId || st.dirtySeq === st.ackedSeq) return false;
  useAccountSyncOutboxStore.getState().save(st.ownerId, {
    patch: snapshotFromLocalStores(),
    tombstones: currentTombstones(),
    baseline: st.baseline,
    savedAt: new Date().toISOString(),
  });
  return true;
}

function currentUserId(): string | null {
  const id = (useAuthStore.getState() as any).user?.internalId;
  return typeof id === 'string' && id ? id : null;
}

/**
 * What a device does when a session (and, once known, the server-verified account id)
 * becomes current — login, boot after /auth/me, or an account switch (v41).
 *
 *   local data owned by this account, with changes not yet on the server
 *       → push them against the revision this device last saw (a 409 merges)
 *   local data owned by this account, nothing pending → the server wins (hydrate)
 *   guest data (never synced)            → merge into the account, then push
 *   another account's data               → clear it first, then hydrate
 *
 * `userId` must be the server-verified `user.internalId`; without it (an older
 * caller) the pre-v41 session rule applies: a different session clears.
 */
export async function reconcileAccountSync(
  session: string,
  userId: string | null,
  prevSession: string | null = null,
): Promise<'pushed' | 'hydrated' | 'merged' | 'skipped'> {
  const syncState = useAccountSyncStateStore.getState();

  if (userId && syncState.ownerId === userId) {
    setLastKnownRevision(syncState.lastRevision);
    if (syncState.dirtySeq !== syncState.ackedSeq) {
      await pushAccountSyncFromStores(session);
      return 'pushed';
    }
    const snap = await hydrateAccountSyncFromServer(session, { adoptOwnerId: userId });
    return snap ? 'hydrated' : 'skipped';
  }

  const foreignOwner = userId ? (syncState.ownerId !== null && syncState.ownerId !== userId) : false;
  const legacySwitch = !userId && !!prevSession && prevSession !== session;
  if (foreignOwner || legacySwitch) {
    // The previous owner's unacknowledged edits are parked for them, not lost.
    parkPendingForOwner();
    clearAccountScopedStores();
    useAccountSyncStateStore.getState().reset();
  }

  // Deletion markers made as a guest describe nothing in this account: a guest
  // merge is a union, and they must not delete the account's entries later.
  if (userId && !foreignOwner && !legacySwitch && syncState.ownerId === null) clearAllSyncTombstones();

  const guestData = !foreignOwner && !legacySwitch && localStoresHaveData();
  const parked = userId ? useAccountSyncOutboxStore.getState().take(userId) : null;
  if (userId && parked) {
    return restoreParkedIntoAccount(session, userId, parked, guestData);
  }
  if (guestData) {
    return mergeGuestDataIntoAccount(session, userId);
  }
  const snap = await hydrateAccountSyncFromServer(session, { adoptOwnerId: userId });
  return snap ? 'hydrated' : 'skipped';
}

/**
 * The same account signs in again on this device with edits parked from before (v41):
 * merge them onto the server's current snapshot with their deletion markers (the same
 * rules as a 409 merge), then any guest data made since, and push. The outbox entry is
 * dropped only when the server acknowledges (pushAccountSyncFromStores).
 */
async function restoreParkedIntoAccount(
  session: string,
  userId: string,
  parked: OutboxEntry,
  withGuestData: boolean,
): Promise<'merged' | 'skipped'> {
  const guard = guardFor(session);
  const stillOn = () => guard() && currentUserId() === userId;
  const before = localFingerprint();
  const done = await withLock(async () => {
    if (!stillOn()) return false;
    const server = await pullAccountSnapshot(session);
    if (!stillOn()) return false;
    let patch = activeDomainsOnly(mergeLocalOntoServer(server, parked.patch, parked.tombstones, parked.baseline ?? null));
    // Edits made on this device while the pull was in flight are kept too.
    if (withGuestData || localFingerprint() !== before) {
      const asSnapshot = { ...(server ?? {}), ...patch, revision: server?.revision ?? 0 } as AccountSyncSnapshot;
      patch = mergeGuestOntoServer(asSnapshot, snapshotFromLocalStores());
    }
    applyMergedPatchToStores(patch);
    // Re-arm the parked deletion markers so a 409 on the push still honours them.
    applyingServerState = true;
    try {
      const t = parked.tombstones;
      useDeckStore.setState((s) => ({
        ...s,
        deletedDeckIds: { ...(t.deletedDeckIds ?? {}), ...s.deletedDeckIds },
        collectionChangedKeys: { ...(t.collectionChangedKeys ?? {}), ...s.collectionChangedKeys },
      }));
      useScanSessionStore.setState((s) => ({ ...s, removals: { ...(t.scanRemovedAt ?? {}), ...s.removals } }));
    } finally {
      applyingServerState = false;
    }
    const base = typeof server?.revision === 'number' ? server.revision : 0;
    setLastKnownRevision(base);
    const st = useAccountSyncStateStore.getState();
    st.adoptOwner(userId, base);
    st.setBaseline(baselineFrom(server));
    st.markDirty();
    return true;
  });
  if (!done) return 'skipped';
  await pushAccountSyncFromStores(session);
  return 'merged';
}

async function mergeGuestDataIntoAccount(session: string, userId: string | null): Promise<'merged' | 'skipped'> {
  const guard = guardFor(session);
  const stillOn = () => guard() && (userId === null || currentUserId() === userId);
  const merged = await withLock(async () => {
    if (!stillOn()) return null;
    const server = await pullAccountSnapshot(session);
    if (!stillOn()) return null;
    const local = snapshotFromLocalStores();
    const patch = mergeGuestOntoServer(server, local);
    applyMergedPatchToStores(patch);
    const base = typeof server?.revision === 'number' ? server.revision : 0;
    setLastKnownRevision(base);
    const st = useAccountSyncStateStore.getState();
    // The stores now hold this account's data plus the guest's — not yet on the server.
    st.adoptOwner(userId, base);
    st.setBaseline(baselineFrom(server));
    st.markDirty();
    return patch;
  });
  if (!merged) return 'skipped';
  // Pushed through the normal path: idempotency key, 409 merge, ack bookkeeping. A
  // failure leaves the device dirty and the binding retries.
  await pushAccountSyncFromStores(session);
  return 'merged';
}

export { mergeLocalOntoServer };

export { AccountSyncClientError, AccountSyncConflictError };
export type { AccountSyncSnapshot, AccountSyncPatch };
