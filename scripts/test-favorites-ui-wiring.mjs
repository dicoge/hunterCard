#!/usr/bin/env node
// DIC-1380 W6 CR — favorites store is wired into real product UI (not a
// static placeholder). The handback item was:
//
//   "Wire the independent favorites store into actual product UI actions
//    and reads; static FavoritesScreen/collection ownership is not
//    favorites round-trip."
//
// The proof is a MUTATION-SENSITIVE render regression:
//   • FavoritesScreen with an empty store shows the empty placeholder.
//   • FavoritesScreen with a populated store shows the exact bookmark
//     rows the store holds (mounts real FlatList output).
//   • Clicking the row's Remove button calls the store's removeFavorite
//     and STAMPS the removal tombstone — the sync orchestrator's 409
//     merge is what turns that tombstone into a durable delete.
//
// Under STORE_MVP=0 the surface is fully live (Web Develop / Staging /
// local `expo start --web`). Under STORE_MVP=1 (Web + native Production)
// the drawer entry is hidden along with the rest of the favorites
// surface; both cases still round-trip through the same store.

process.env.EXPO_PUBLIC_STORE_MVP = '0';

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://holohunter.dicoge.com/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key in globalThis) continue;
  try { globalThis[key] = dom.window[key]; } catch {}
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
class NoopResizeObserver { observe(){} unobserve(){} disconnect(){} }
globalThis.ResizeObserver = NoopResizeObserver;
dom.window.ResizeObserver = NoopResizeObserver;

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const FavoritesScreen = (await import('../src/screens/FavoritesScreen.tsx')).default;
const { useFavoritesStore } = await import('../src/store/favoritesStore.ts');
const { useSettingsStore } = await import('../src/store/settingsStore.ts');

async function mount() {
  const host = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(FavoritesScreen));
    await Promise.resolve();
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return {
    container: host,
    rerender: async () => {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

let passed = 0;
async function test(label, fn) {
  useFavoritesStore.getState().clearAll();
  useSettingsStore.setState((s) => ({ ...s, preferredLanguage: 'zh', preferredCurrency: 'TWD' }));
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    console.error(`  ✗ ${label} — ${err?.message ?? err}`);
    if (err?.stack) console.error(err.stack);
    process.exitCode = 1;
  }
}

// ── Empty state ─────────────────────────────────────────────────────────
await test('FavoritesScreen: empty store renders the empty placeholder (not the list)', async () => {
  const { container, cleanup } = await mount();
  try {
    const empty = container.querySelector('[data-testid="favorites-empty"]');
    assert.ok(empty, 'empty placeholder mounts');
    const list = container.querySelector('[data-testid="favorites-list"]');
    assert.equal(list, null, 'list container must NOT mount when the store is empty');
  } finally { await cleanup(); }
});

// ── Populated: rows come straight from the store ───────────────────────
await test('FavoritesScreen: populated store renders one row per FavoriteEntry (list mounts)', async () => {
  useFavoritesStore.getState().replaceAll([
    { cardNumber: 'hBP04-001', printing: 'BASE', addedAt: '2026-09-05T00:00:00.000Z' },
    { cardNumber: 'hBP06-042', printing: 'PARALLEL', addedAt: '2026-09-06T00:00:00.000Z' },
  ]);
  const { container, cleanup } = await mount();
  try {
    const list = container.querySelector('[data-testid="favorites-list"]');
    assert.ok(list, 'list container mounts when there is at least one favorite');
    const count = container.querySelector('[data-testid="favorites-count"]');
    assert.ok(count, 'count line mounts');
    assert.ok(count.textContent.includes('2'), 'count reflects the store length');
    const row1 = container.querySelector('[data-testid="favorite-row-hBP04-001-BASE"]');
    const row2 = container.querySelector('[data-testid="favorite-row-hBP06-042-PARALLEL"]');
    assert.ok(row1, 'row 1 mounts');
    assert.ok(row2, 'row 2 mounts');
  } finally { await cleanup(); }
});

// ── Remove action calls removeFavorite AND stamps a tombstone ──────────
await test('FavoritesScreen: Remove button calls removeFavorite AND stamps a tombstone (sync-ready)', async () => {
  useFavoritesStore.getState().replaceAll([
    { cardNumber: 'gone', printing: 'BASE', addedAt: '2026-09-05T00:00:00.000Z' },
  ]);
  assert.equal(Object.keys(useFavoritesStore.getState().removals).length, 0, 'precondition: no tombstones');
  const { container, cleanup } = await mount();
  try {
    const btn = container.querySelector('[data-testid="favorite-remove-gone-BASE"]');
    assert.ok(btn, 'remove button mounts');
    await act(async () => btn.click());
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const favsAfter = useFavoritesStore.getState().favorites;
    assert.equal(favsAfter.length, 0, 'store no longer holds the removed favorite');
    const tombstones = useFavoritesStore.getState().removals;
    assert.ok(tombstones['gone|BASE'], 'removal tombstone was stamped — the account-sync 409 merge will honor it');
  } finally { await cleanup(); }
});

// ── Store re-add clears the tombstone (re-favorite wins) ───────────────
await test('FavoritesScreen: re-adding after removing clears the tombstone (re-add wins)', async () => {
  useFavoritesStore.getState().replaceAll([
    { cardNumber: 'x', printing: 'BASE', addedAt: '2026-09-05T00:00:00.000Z' },
  ]);
  useFavoritesStore.getState().removeFavorite('x', 'BASE');
  assert.ok(useFavoritesStore.getState().removals['x|BASE'], 'tombstone present after remove');
  useFavoritesStore.getState().addFavorite({ cardNumber: 'x', printing: 'BASE' });
  assert.equal(useFavoritesStore.getState().removals['x|BASE'], undefined, 're-add clears the tombstone');
});

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ DIC-1380 W6 favorites UI wiring: ${passed} checks passed`);
} else {
  console.error(`\n❌ DIC-1380 W6 favorites UI wiring failed`);
}
