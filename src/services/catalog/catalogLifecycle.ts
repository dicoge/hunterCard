/**
 * Remote catalog lifecycle — native (2026-11-06).
 *
 * Checks the small manifest once at launch and again whenever the app returns to
 * the foreground. Throttling, backoff, single-flight and the "never retry an
 * explicit refusal" rule live in catalogRepository.refresh(), so an AppState
 * flurry costs at most one bounded check. No timers, push or background jobs.
 * Web has its own no-op variant (catalogLifecycle.web.ts).
 */
import { AppState } from 'react-native';
import { refreshCatalog } from '../../utils/staticData';

let installed = false;

export function installCatalogUpdates(): () => void {
  if (installed) return () => {};
  installed = true;
  void refreshCatalog();
  const subscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') void refreshCatalog();
  });
  return () => {
    subscription.remove();
    installed = false;
  };
}
