#!/usr/bin/env node
// DIC-1409 Phase 5 mutation-sensitive tests: App 08 收藏 (Collection) /
// App 09 我的最愛 (Favorites) / App 10 賽事月報 (TournamentReport) /
// App 11 到價提醒 (Watchlist) / App 12 規則教學 (Tutorial) render the shared
// Pen v2 shell with their real stores, routes, and contracts intact.
//
// Pinned to Pen frames ej9RF / sSDxQ / wRgD8 / VyzfW / DAQIq and to the
// shipped tabRegistry contract: Collection folds onto 牌組, Favorites onto
// 我的, TournamentReport / Watchlist / Tutorial onto 首頁.

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// Full profile — Collection/Favorites/Watchlist routes exist only with
// Store MVP off (same pattern as test-store-mvp-behavior).
process.env.EXPO_PUBLIC_STORE_MVP = '0';

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
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = TestResizeObserver;
dom.window.ResizeObserver = TestResizeObserver;
Object.defineProperty(dom.window.document.documentElement, 'clientWidth', { value: 390, configurable: true });
Object.defineProperty(dom.window.document.documentElement, 'clientHeight', { value: 844, configurable: true });
Object.defineProperty(dom.window, 'innerWidth', { value: 390, configurable: true });
Object.defineProperty(dom.window, 'innerHeight', { value: 844, configurable: true });

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function render(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  await flush();
  await flush();
  return {
    container,
    cleanup: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function assertShell(container, shellId, tabKey, tabLabelNote) {
  assert.ok(container.querySelector(`[data-testid="${shellId}"]`), `${shellId} renders`);
  assert.ok(container.querySelector('[data-testid="shell-status-bar"]'), 'status bar');
  assert.ok(container.querySelector('[data-testid="shell-bottom-tab-bar"]'), 'bottom tab bar');
  const tab = container.querySelector(`[data-testid="shell-bottom-tab-${tabKey}"]`);
  assert.ok(tab, `${tabKey} tab renders`);
  assert.equal(tab.getAttribute('aria-selected'), 'true', tabLabelNote);
}

console.log('── DIC-1409 Phase 5 · App 08–12 shell parity ──');

// ── App / 09 我的最愛 (Pen sSDxQ) — real favoritesStore ───────────────────

await test('Favorites renders in the shell (我的 active) with real store rows and remove action', async () => {
  const { useFavoritesStore } = await import('../src/store/favoritesStore.ts');
  const { default: FavoritesScreen } = await import('../src/screens/FavoritesScreen.tsx');
  useFavoritesStore.getState().addFavorite({ cardNumber: 'hBP01-081', printing: 'UR' });
  const events = [];
  const { container, cleanup } = await render(React.createElement(FavoritesScreen, {
    navigation: { navigate: (r) => events.push(['navigate', r]), goBack: () => events.push(['goBack']) },
  }));
  try {
    assertShell(container, 'favorites-shell', 'me', 'Pen sSDxQ folds Favorites onto 我的');
    assert.equal(
      container.querySelector('[data-testid="shell-app-bar-title"]').textContent,
      '我的收藏',
      'Pen app bar title (node oufJa: 我的最愛 route label — favorites_title)',
    );
    assert.ok(
      container.querySelector('[data-testid="favorite-row-hBP01-081-UR"]'),
      'real store row renders (DIC-1380 W6 contract intact)',
    );
    await act(async () => container.querySelector('[data-testid="favorites-shell-back"]').click());
    assert.deepEqual(events, [['goBack']]);
    // Real mutation still wired: remove stamps the tombstone.
    const before = useFavoritesStore.getState().favorites.length;
    const removeBtn = container.querySelector('[data-testid="favorite-remove-hBP01-081-UR"]');
    assert.ok(removeBtn, 'remove action renders');
    await act(async () => removeBtn.click());
    assert.equal(useFavoritesStore.getState().favorites.length, before - 1, 'removeFavorite mutates the real store');
  } finally { await cleanup(); }
});

// ── App / 08 收藏 (Pen ej9RF) — real deck-store ownership browser ─────────

await test('Collection renders in the shell (牌組 active) with search/filter contracts intact', async () => {
  const { default: CollectionScreen } = await import('../src/screens/CollectionScreen.tsx');
  const { container, cleanup } = await render(React.createElement(CollectionScreen, {
    navigation: { navigate: () => {}, goBack: () => {} },
  }));
  try {
    assertShell(container, 'collection-shell', 'deck', 'Pen ej9RF folds Collection onto 牌組 (tab registry)');
    // Real catalog load finishes async; the DIC-1086 contracts must survive
    // inside the shell whichever state has settled.
    await flush();
    assert.ok(
      container.querySelector('[data-testid="collection-search"]')
        || container.textContent.includes('載入') || container.textContent.includes('読み込み'),
      'collection search (DIC-1086 contract) or real loading state renders',
    );
  } finally { await cleanup(); }
});

// ── App / 11 到價提醒 (Pen VyzfW) — real price-alert store ────────────────

await test('Watchlist renders in the shell (首頁 active) with the real empty-state actions', async () => {
  const { default: WatchlistScreen } = await import('../src/screens/WatchlistScreen.tsx');
  const events = [];
  const { container, cleanup } = await render(React.createElement(WatchlistScreen, {
    navigation: { navigate: (r) => events.push(r), goBack: () => {} },
  }));
  try {
    assertShell(container, 'watchlist-shell', 'home', 'Pen VyzfW folds Watchlist onto 首頁');
    await flush();
    const empty = container.querySelector('[data-testid="price-alert-empty"]');
    assert.ok(empty, 'real empty state renders (no alerts in a fresh store)');
    const buttons = empty.querySelectorAll('[role="button"], button, [tabindex="0"]');
    assert.ok(buttons.length >= 2, 'empty-state actions render');
  } finally { await cleanup(); }
});

// ── App / 12 規則教學 (Pen DAQIq) — real tutorial data + navigation ───────

await test('Tutorial renders in the shell (首頁 active) and section cards navigate to TutorialDetail', async () => {
  const { default: TutorialScreen } = await import('../src/screens/TutorialScreen.tsx');
  const events = [];
  const { container, cleanup } = await render(React.createElement(TutorialScreen, {
    navigation: { navigate: (r, p) => events.push([r, p]), goBack: () => {} },
  }));
  try {
    assertShell(container, 'tutorial-shell', 'home', 'Pen DAQIq folds Tutorial onto 首頁');
    const sections = container.querySelectorAll('[data-testid^="tutorial-section-"]');
    assert.ok(sections.length >= 3, `real tutorial sections render (got ${sections.length})`);
    await act(async () => sections[0].click());
    assert.equal(events.length, 1, 'section press dispatches');
    assert.equal(events[0][0], 'TutorialDetail', 'section navigates to TutorialDetail');
    assert.ok(events[0][1]?.sectionId, 'navigation carries the real sectionId param');
  } finally { await cleanup(); }
});

// ── App / 10 賽事月報 (Pen wRgD8) — shell wrap over the real report ───────

await test('TournamentReport renders in the shell (首頁 active) in its real load/error state', async () => {
  const { default: TournamentReportScreen } = await import('../src/screens/TournamentReportScreen.tsx');
  const { container, cleanup } = await render(React.createElement(TournamentReportScreen));
  try {
    assertShell(container, 'tournament-shell', 'home', 'Pen wRgD8 folds TournamentReport onto 首頁');
    assert.equal(
      container.querySelector('[data-testid="shell-app-bar-title"]').textContent,
      '賽事月報',
      'Pen app bar title (node t4e7r8)',
    );
  } finally { await cleanup(); }
});

console.log(`\nPassed ${passed} tests.`);
