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
import {
  hydrateAccountSyncFromServer,
  pushAccountSyncFromStores,
  resetLastKnownRevision,
  clearAccountScopedStores,
  isApplyingServerState,
} from './accountSyncOrchestrator';

const PUSH_DEBOUNCE_MS = 750;

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
}

function schedulePush(): void {
  // Ignore store changes coming from the orchestrator itself (a hydrate or a
  // 409 merge apply) — those already reflect server-authoritative state, so
  // pushing them back would fire a redundant same-revision POST and, for
  // account-switch cases, an OLD-account push against the NEW session.
  if (isApplyingServerState()) return;
  const session = useAuthStore.getState().session;
  if (!session) return;
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
    pushAccountSyncFromStores(currentSession).catch((err) => {
      console.warn('[accountSync] push failed:', err?.message || err);
    });
  }, PUSH_DEBOUNCE_MS);
}

function handleSessionChange(nextSession: string | null | undefined, prevSession: string | null | undefined): void {
  // Any queued push targeted the PREVIOUS session's stores. Kill it before
  // it can leak account A's captured state into account B's push queue.
  cancelQueuedPush();

  if (!nextSession) {
    // Logout — clear account-scoped stores so the next login starts from a
    // clean slate and cannot re-hydrate against a stale local copy.
    clearAccountScopedStores();
    resetLastKnownRevision();
    return;
  }

  // Session identifier changed (login OR account switch). Both cases must
  // wipe account A's data before hydrating account B — merging a foreign
  // local snapshot on top of the new server snapshot is exactly the leak
  // the W5 handback flagged. `resetLastKnownRevision` is folded into
  // `clearAccountScopedStores`, so no extra call is needed here.
  if (prevSession && prevSession !== nextSession) {
    clearAccountScopedStores();
  }

  hydrateAccountSyncFromServer(nextSession).catch((err) => {
    console.warn('[accountSync] hydrate failed:', err?.message || err);
  });
}

export function installAccountSyncBinding(): void {
  if (installed) return;
  installed = true;

  const initialSession = useAuthStore.getState().session;
  if (initialSession) {
    hydrateAccountSyncFromServer(initialSession).catch((err) => {
      console.warn('[accountSync] hydrate failed:', err?.message || err);
    });
  }

  subscriptions.push(useAuthStore.subscribe((state, prev) => {
    if (state.session === prev.session) return;
    handleSessionChange(state.session, prev.session);
  }));
  subscriptions.push(useDeckStore.subscribe((state, prev) => {
    if (state.decks === prev.decks && state.collection === prev.collection) return;
    schedulePush();
  }));
  subscriptions.push(usePriceAlertStore.subscribe((state, prev) => {
    if (state.alerts === prev.alerts) return;
    schedulePush();
  }));
  subscriptions.push(useSettingsStore.subscribe((state, prev) => {
    if (
      state.preferredCurrency === prev.preferredCurrency
      && state.preferredLanguage === prev.preferredLanguage
    ) return;
    schedulePush();
  }));
  subscriptions.push(useFavoritesStore.subscribe((state, prev) => {
    if (state.favorites === prev.favorites) return;
    schedulePush();
  }));
}

// Test seams — exposed so scripts/test-account-sync-binding.mjs can reset
// module state between cases without reloading the module registry.
export function __resetAccountSyncBindingForTesting(): void {
  while (subscriptions.length > 0) {
    const off = subscriptions.pop();
    try { off?.(); } catch { /* ignore */ }
  }
  installed = false;
  cancelQueuedPush();
  resetLastKnownRevision();
}

export function __getAccountSyncBindingQueuedPushSession(): string | null {
  return queuedPushSession;
}

export function __getAccountSyncBindingPendingPushMs(): number {
  return PUSH_DEBOUNCE_MS;
}
