/**
 * Account remote-sync store binding (DIC-1380 W4 CR — store wiring).
 *
 * `App.tsx` calls `installAccountSyncBinding()` once at boot; the binding
 * subscribes the auth store (to hydrate on session adoption) and the three
 * data stores (deck / priceAlert / settings) to push through the
 * orchestrator when their state changes. Split from the orchestrator so
 * the sync algorithm and the reactive glue can be unit-tested independently
 * — the orchestrator's tests exercise the pull/push/conflict paths without
 * a subscription needing to fire, and the binding's tests exercise the
 * subscription contract without the network mock.
 *
 * The binding installs at most once per process; a second call is a no-op
 * so a hot-reload does not stack subscriptions.
 *
 * Push debouncing: local edits arrive in bursts (adding a slot to a deck
 * changes the deck object then again a moment later when its updatedAt
 * settles). Debouncing collapses the burst into ONE push. Errors are
 * swallowed with a warn so a network hiccup never crashes the app; the next
 * store mutation triggers a fresh push, and a login retriggers the hydrate.
 */
import { useAuthStore } from '../store/authStore';
import { useDeckStore } from '../store/deckStore';
import { usePriceAlertStore } from '../stores/priceAlertStore';
import { useSettingsStore } from '../store/settingsStore';
import { useFavoritesStore } from '../store/favoritesStore';
import { useScanSessionStore } from '../stores/scanSessionStore';
import { useAccountSyncStateStore, isAccountSyncDirty } from '../store/accountSyncStateStore';
import { FEATURES } from '../config/releaseFlags';
import { AppState } from 'react-native';
import {
  pushAccountSyncFromStores,
  resetLastKnownRevision,
  clearAccountScopedStores,
  isApplyingServerState,
  reconcileAccountSync,
  parkPendingForOwner,
} from './accountSyncOrchestrator';

const PUSH_DEBOUNCE_MS = 750;
/** v41: a failed push is retried on its own (and on foreground / next change). */
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 300_000];
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;
/** Pull at most this often when the app comes back to the foreground. */
const FOREGROUND_RESYNC_MIN_MS = 15_000;
let lastForegroundSync = 0;

let installed = false;
let pendingPush: ReturnType<typeof setTimeout> | null = null;
// The session the currently queued push was scheduled for. If the session
// changes before the timeout fires, we cancel the push — it must NEVER fire
// against a different account than the one whose store snapshot it captured
// (DIC-1380 W5 handback).
let queuedPushSession: string | null = null;
const subscriptions: Array<() => void> = [];

function cancelQueuedPush(): void {
  if (pendingPush) {
    clearTimeout(pendingPush);
    pendingPush = null;
  }
  queuedPushSession = null;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function currentUserId(): string | null {
  const id = (useAuthStore.getState() as any).user?.internalId;
  return typeof id === 'string' && id ? id : null;
}

/** May this device push now? Only once its local data is known to be this account's. */
function pushAllowed(): boolean {
  const uid = currentUserId();
  if (!uid) return true; // pre-v41 callers (session only): unchanged behaviour
  return useAccountSyncStateStore.getState().ownerId === uid;
}

function scheduleRetry(): void {
  if (retryTimer || !isAccountSyncDirty()) return;
  const delay = RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)];
  retryAttempt += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (isAccountSyncDirty()) schedulePush();
  }, delay);
}

/** A local user change (not a server apply): remember it, push when allowed. */
function onLocalChange(): void {
  if (isApplyingServerState()) return;
  useAccountSyncStateStore.getState().markDirty();
  schedulePush();
}

function schedulePush(): void {
  // Ignore store changes coming from the orchestrator itself (a hydrate or a
  // 409 merge apply) — those already reflect server-authoritative state, so
  // pushing them back would fire a redundant same-revision POST and, for
  // account-switch cases, an OLD-account push against the NEW session.
  if (isApplyingServerState()) return;
  const session = useAuthStore.getState().session;
  if (!session) return;
  if (!pushAllowed()) return;
  if (pendingPush) clearTimeout(pendingPush);
  queuedPushSession = session;
  pendingPush = setTimeout(() => {
    pendingPush = null;
    const capturedSession = queuedPushSession;
    queuedPushSession = null;
    const currentSession = useAuthStore.getState().session;
    // Defence-in-depth: an account switch that happened after we scheduled
    // but before the debounce fired must not push the OLD account's
    // captured session bearer against the CURRENT stores. Cancel if the
    // session bearer has changed since scheduling.
    if (!currentSession || currentSession !== capturedSession) return;
    if (!pushAllowed()) return;
    pushAccountSyncFromStores(currentSession)
      .then(() => { retryAttempt = 0; })
      .catch((err) => {
        console.warn('[accountSync] push failed:', err?.message || err);
        // Offline / server error: the change stays pending (persisted) and is retried.
        scheduleRetry();
      });
  }, PUSH_DEBOUNCE_MS);
}

function handleSessionChange(nextSession: string | null | undefined, prevSession: string | null | undefined): void {
  // Any queued push targeted the PREVIOUS session's stores. Kill it before
  // it can leak account A's captured state into account B's push queue.
  cancelQueuedPush();
  retryAttempt = 0;

  if (!nextSession) {
    // Logout — clear account-scoped stores (incl. the 估值清單, v41) so the next
    // person on this device sees nothing of this account, and the device's data is
    // guest data again. Edits the server has not acknowledged yet (offline, or still in
    // the push debounce) are parked for this account first, not silently lost.
    parkPendingForOwner();
    clearAccountScopedStores();
    resetLastKnownRevision();
    useAccountSyncStateStore.getState().reset();
    return;
  }

  // Login, boot, token change or account switch. Who owns the local data is decided
  // by the server-verified account id when it is known (v41): the same person with
  // a new token keeps (and pushes) their pending changes, a different account's data
  // is cleared first, guest data is merged. See reconcileAccountSync.
  reconcileAccountSync(nextSession, currentUserId(), prevSession ?? null)
    .then(() => { if (isAccountSyncDirty()) schedulePush(); })
    .catch((err) => {
      console.warn('[accountSync] reconcile failed:', err?.message || err);
      scheduleRetry();
    });
}

export function installAccountSyncBinding(): void {
  if (installed) return;
  installed = true;

  const initialSession = useAuthStore.getState().session;
  if (initialSession) handleSessionChange(initialSession, null);

  subscriptions.push(useAuthStore.subscribe((state, prev) => {
    const uid = (state as any).user?.internalId ?? null;
    const prevUid = (prev as any).user?.internalId ?? null;
    if (state.session === prev.session && uid === prevUid) return;
    // The server-verified id arriving for the SAME session (boot: /auth/me answered)
    // is not a new session: reconcile ownership without treating it as a switch.
    handleSessionChange(state.session, state.session === prev.session ? null : prev.session);
  }));
  subscriptions.push(useDeckStore.subscribe((state, prev) => {
    if (state.decks === prev.decks && state.collection === prev.collection) return;
    onLocalChange();
  }));
  subscriptions.push(useSettingsStore.subscribe((state, prev) => {
    if (
      state.preferredCurrency === prev.preferredCurrency
      && state.preferredLanguage === prev.preferredLanguage
    ) return;
    onLocalChange();
  }));
  // 估值清單 (v41): visible in every profile.
  subscriptions.push(useScanSessionStore.subscribe((state, prev) => {
    if (state.cards === prev.cards && state.clearedAt === prev.clearedAt) return;
    onLocalChange();
  }));
  // Hidden under Store MVP: their changes never trigger a push there.
  if (FEATURES.watchlist) {
    subscriptions.push(usePriceAlertStore.subscribe((state, prev) => {
      if (state.alerts === prev.alerts) return;
      onLocalChange();
    }));
  }
  if (FEATURES.favorites) {
    subscriptions.push(useFavoritesStore.subscribe((state, prev) => {
      if (state.favorites === prev.favorites) return;
      onLocalChange();
    }));
  }
  // Back in the foreground: send anything still pending, otherwise pull what the
  // account's other devices changed meanwhile (throttled).
  const appStateSub = AppState.addEventListener?.('change', (next) => {
    if (next !== 'active') return;
    const session = useAuthStore.getState().session;
    if (!session) return;
    if (isAccountSyncDirty()) { schedulePush(); return; }
    const now = Date.now();
    if (now - lastForegroundSync < FOREGROUND_RESYNC_MIN_MS) return;
    lastForegroundSync = now;
    reconcileAccountSync(session, currentUserId(), null).catch((err) => {
      console.warn('[accountSync] foreground sync failed:', err?.message || err);
    });
  });
  if (appStateSub) subscriptions.push(() => appStateSub.remove());
}

// Test seams — exposed so scripts/test-account-sync-binding.mjs can reset
// module state between cases without reloading the module registry.
export function __resetAccountSyncBindingForTesting(): void {
  while (subscriptions.length > 0) {
    const off = subscriptions.pop();
    try { off?.(); } catch { /* ignore */ }
  }
  installed = false;
  lastForegroundSync = 0;
  retryAttempt = 0;
  cancelQueuedPush();
  resetLastKnownRevision();
}

export function __getAccountSyncBindingQueuedPushSession(): string | null {
  return queuedPushSession;
}

export function __getAccountSyncBindingPendingPushMs(): number {
  return PUSH_DEBOUNCE_MS;
}
