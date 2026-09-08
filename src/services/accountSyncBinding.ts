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
import {
  hydrateAccountSyncFromServer,
  pushAccountSyncFromStores,
  resetLastKnownRevision,
} from './accountSyncOrchestrator';

const PUSH_DEBOUNCE_MS = 750;

let installed = false;
let pendingPush: ReturnType<typeof setTimeout> | null = null;
const subscriptions: Array<() => void> = [];

function schedulePush(): void {
  const session = useAuthStore.getState().session;
  if (!session) return;
  if (pendingPush) clearTimeout(pendingPush);
  pendingPush = setTimeout(() => {
    pendingPush = null;
    pushAccountSyncFromStores(session).catch((err) => {
      console.warn('[accountSync] push failed:', err?.message || err);
    });
  }, PUSH_DEBOUNCE_MS);
}

function scheduleHydrate(session: string | null | undefined): void {
  if (!session) {
    resetLastKnownRevision();
    return;
  }
  hydrateAccountSyncFromServer(session).catch((err) => {
    console.warn('[accountSync] hydrate failed:', err?.message || err);
  });
}

export function installAccountSyncBinding(): void {
  if (installed) return;
  installed = true;

  const initialSession = useAuthStore.getState().session;
  if (initialSession) scheduleHydrate(initialSession);

  subscriptions.push(useAuthStore.subscribe((state, prev) => {
    if (state.session === prev.session) return;
    scheduleHydrate(state.session);
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
}

// Test seams — exposed so scripts/test-account-sync-binding.mjs can reset
// module state between cases without reloading the module registry.
export function __resetAccountSyncBindingForTesting(): void {
  while (subscriptions.length > 0) {
    const off = subscriptions.pop();
    try { off?.(); } catch { /* ignore */ }
  }
  installed = false;
  if (pendingPush) {
    clearTimeout(pendingPush);
    pendingPush = null;
  }
  resetLastKnownRevision();
}

export function __getAccountSyncBindingPendingPushMs(): number {
  return PUSH_DEBOUNCE_MS;
}
