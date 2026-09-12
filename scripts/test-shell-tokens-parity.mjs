#!/usr/bin/env node
// DIC-1409 Phase 2 mutation-sensitive tests for the v2 shell.
//
// These assertions are keyed on exact values sourced from the Pen file
// (`docs/pen-v2/holohunter-landing-v2-updated.pen`) so a silent mutation to
// tokens/tabs/routes will fail the suite instead of quietly drifting the UI.
//
// The test file is executed by node with the `register-web-render.mjs` hook so
// the shipped `.tsx` shell modules are imported directly, not stubbed.

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

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

const tokens = await import('../src/theme/tokensV2.ts');
const shell = await import('../src/components/shell/index.ts');
const cards = await import('../src/components/cards/index.ts');

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function renderComponent(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  await flush();
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('── DIC-1409 Phase 2 · shell tokens & wiring parity ──');

//
// 1) Palette / semantic / layout tokens map exactly to the Pen file.
//
await test('PALETTE mirrors Pen $accent/$app-bg/$app-surface/$app-elev/$border', () => {
  assert.equal(tokens.PALETTE.accent, '#FF4D9D');
  assert.equal(tokens.PALETTE.accent2, '#3DE0FF');
  assert.equal(tokens.PALETTE.accent3, '#8B5CF6');
  assert.equal(tokens.PALETTE.appBg, '#0A0A13');
  assert.equal(tokens.PALETTE.appSurface, '#14141F');
  assert.equal(tokens.PALETTE.appElev, '#1C1C2B');
  assert.equal(tokens.PALETTE.border, '#282838');
  assert.equal(tokens.PALETTE.textPrimary, '#F6F6FB');
  assert.equal(tokens.PALETTE.textSecondary, '#9494B0');
  assert.equal(tokens.PALETTE.textMuted, '#6A6A85');
});

await test('State + category palette matches Pen', () => {
  assert.equal(tokens.PALETTE.stateDefault, '#F6F6FB');
  assert.equal(tokens.PALETTE.stateHover, '#FFFFFF');
  assert.equal(tokens.PALETTE.stateFocus, '#FF4D9D');
  assert.equal(tokens.PALETTE.stateDisabled, '#4B4B60');
  assert.equal(tokens.PALETTE.stateLoading, '#9494B0');
  assert.equal(tokens.PALETTE.stateError, '#F87171');
  assert.equal(tokens.PALETTE.comingSoonBg, '#3D2547');
  assert.equal(tokens.PALETTE.comingSoonFg, '#FFB4D9');
  assert.equal(tokens.CATEGORY_COLORS.white, '#E4E4EE');
  assert.equal(tokens.CATEGORY_COLORS.blue, '#4C8DFF');
  assert.equal(tokens.CATEGORY_COLORS.green, '#34D399');
  assert.equal(tokens.CATEGORY_COLORS.red, '#F87171');
  assert.equal(tokens.CATEGORY_COLORS.purple, '#C084FC');
  assert.equal(tokens.CATEGORY_COLORS.yellow, '#FBBF24');
});

await test('SEMANTIC tokens surface Pen-derived colors', () => {
  assert.equal(tokens.SEMANTIC.background, tokens.PALETTE.appBg);
  assert.equal(tokens.SEMANTIC.surface, tokens.PALETTE.appSurface);
  assert.equal(tokens.SEMANTIC.elev, tokens.PALETTE.appElev);
  assert.equal(tokens.SEMANTIC.brand, tokens.PALETTE.accent);
  assert.equal(tokens.SEMANTIC.focusRing, tokens.PALETTE.stateFocus);
  assert.equal(tokens.SEMANTIC.onBg, tokens.PALETTE.textPrimary);
  assert.equal(tokens.SEMANTIC.onBgMuted, tokens.PALETTE.textSecondary);
  assert.equal(tokens.SEMANTIC.onBgDim, tokens.PALETTE.textMuted);
});

await test('LAYOUT + type scale + radii + spacing match Pen bounds', () => {
  assert.equal(tokens.LAYOUT.minTouch, 44, 'Pen $min-touch = 44');
  assert.equal(tokens.LAYOUT.safeMobile, 20, 'Pen $safe-mobile = 20');
  assert.equal(tokens.LAYOUT.contentDesktop, 1328, 'Pen $content-desktop = 1328');
  assert.equal(tokens.LAYOUT.statusBar.height, 54, 'Pen C / Status Bar = 390×54');
  assert.equal(tokens.LAYOUT.appBar.height, 56, 'Pen App Bar = 390×56');
  assert.equal(tokens.LAYOUT.bottomTab.height, 84, 'Pen C / Tab Bar inner = 390×84');
  assert.equal(tokens.LAYOUT.bottomTab.fab, 64, 'Pen Scan FAB = 64×64');
  assert.equal(tokens.LAYOUT.cardTile.width, 112, 'Pen C / Card Tile = 112×199');
  assert.equal(tokens.LAYOUT.cardTile.fullHeight, 199);
  assert.equal(tokens.LAYOUT.cardTile.artHeight, 156);
  assert.equal(tokens.LAYOUT.seriesCard.width, 175, 'Pen C / Series Card = 175×69');
  assert.equal(tokens.LAYOUT.seriesCard.height, 69);
  assert.equal(tokens.TYPE_SCALE.body.size, 15);
  assert.equal(tokens.TYPE_SCALE.hero.size, 32);
  assert.equal(tokens.RADII.pill, 999);
});

await test('FONTS surface Outfit + Noto Sans TC families', () => {
  assert.match(tokens.FONTS.display, /Outfit/);
  assert.match(tokens.FONTS.body, /Noto Sans TC/);
});

await test('GRADIENTS carry Pen brand pairings', () => {
  assert.deepEqual(tokens.GRADIENTS.brandPinkPurple.colors, ['#FF4D9D', '#8B5CF6']);
  assert.deepEqual(tokens.GRADIENTS.brandPinkCyan.colors, ['#FF4D9D', '#3DE0FF']);
});

//
// 2) Tab registry preserves every existing navigation destination.
//
await test('SHELL_TAB_ROUTE_MAP keeps deep-link contract with AppNavigator', () => {
  const map = shell.SHELL_TAB_ROUTE_MAP;
  assert.equal(map.home, 'Home');
  assert.equal(map.search, 'Search');
  assert.equal(map.scan, 'Scan');
  assert.equal(map.deck, 'DeckEditor');
  assert.equal(map.me, 'Settings');
});

await test('SHELL_TAB_LABELS mirror Pen tab labels (首頁/搜尋/牌組/我的)', () => {
  assert.equal(shell.SHELL_TAB_LABELS.home, '首頁');
  assert.equal(shell.SHELL_TAB_LABELS.search, '搜尋');
  assert.equal(shell.SHELL_TAB_LABELS.deck, '牌組');
  assert.equal(shell.SHELL_TAB_LABELS.me, '我的');
  assert.equal(shell.SHELL_TAB_LABELS.scan, '掃描');
});

await test('activeTabForRoute honors every registered destination', () => {
  const cases = {
    Home: 'home',
    Search: 'search',
    SearchResults: 'search',
    CardDetail: 'search',
    Scan: 'scan',
    DeckEditor: 'deck',
    Collection: 'deck',
    TournamentReport: 'home',
    Watchlist: 'home',
    Tutorial: 'home',
    TutorialDetail: 'home',
    TutorialSimulation: 'home',
    Settings: 'me',
    Favorites: 'me',
    Login: 'me',
  };
  for (const [route, expected] of Object.entries(cases)) {
    assert.equal(shell.activeTabForRoute(route), expected, `route ${route}`);
  }
});

await test('buildShellTabs emits five ordered items and nested MainDrawer onPress destinations', () => {
  // DIC-1409 CR fix: tab presses must use the nested-navigator form so
  // they resolve from root-stack screens (SearchResults / TutorialDetail /
  // TutorialSimulation) too — a bare drawer-child name is unhandled there.
  // The integrated proof lives in test:shell-tab-navigation.
  const calls = [];
  const items = shell.buildShellTabs({
    navigation: { navigate: (route, params) => calls.push([route, params]) },
  });
  assert.deepEqual(items.map((it) => it.key), ['home', 'search', 'scan', 'deck', 'me']);
  assert.deepEqual(items.map((it) => it.destinationRoute), ['Home', 'Search', 'Scan', 'DeckEditor', 'Settings']);
  items.forEach((item) => item.onPress?.());
  assert.deepEqual(
    calls,
    ['Home', 'Search', 'Scan', 'DeckEditor', 'Settings'].map((screen) => ['MainDrawer', { screen }]),
  );
});

//
// 3) React render of the shell keeps Pen shape and semantic anchors.
//
await test('AppShell renders StatusBar/AppBar/content/BottomTabBar landmarks', async () => {
  const items = shell.buildShellTabs({ navigation: { navigate: () => {} } });
  const { container, cleanup } = await renderComponent(
    React.createElement(shell.AppShell, {
      appBar: { title: 'HoloHunter', actions: [{ key: 'bell', label: 'alerts' }] },
      bottomTabBar: { items, activeKey: 'home' },
      children: React.createElement('div', { 'data-testid': 'inner' }, 'body'),
    })
  );
  try {
    assert.ok(container.querySelector('[data-testid="shell-status-bar"]'), 'status bar');
    assert.ok(container.querySelector('[data-testid="shell-app-bar"]'), 'app bar');
    assert.ok(container.querySelector('[data-testid="shell-app-bar-title"]'), 'app bar title');
    assert.ok(container.querySelector('[data-testid="shell-bottom-tab-bar"]'), 'tab bar');
    assert.ok(container.querySelector('[data-testid="shell-content"]'), 'content region');
    assert.equal(
      container.querySelector('[data-testid="shell-app-bar-title"]').textContent,
      'HoloHunter'
    );
    assert.ok(container.querySelector('[data-testid="inner"]'));
  } finally {
    await cleanup();
  }
});

await test('BottomTabBar dispatches onPress with the nested MainDrawer destination for every tab', async () => {
  const fired = [];
  const items = shell.buildShellTabs({
    navigation: { navigate: (route, params) => fired.push(params?.screen ?? route) },
  });
  const { container, cleanup } = await renderComponent(
    React.createElement(shell.BottomTabBar, {
      items,
      activeKey: 'home',
    })
  );
  try {
    for (const key of ['home', 'search', 'deck', 'me']) {
      const node = container.querySelector(`[data-testid="shell-bottom-tab-${key}"]`);
      assert.ok(node, `${key} tab exists`);
      await act(async () => node.click());
    }
    const fab = container.querySelector('[data-testid="shell-bottom-tab-bar-scan-fab"]');
    assert.ok(fab, 'scan FAB exists');
    await act(async () => fab.click());
    assert.deepEqual(fired, ['Home', 'Search', 'DeckEditor', 'Settings', 'Scan']);
  } finally {
    await cleanup();
  }
});

await test('BottomTabBar marks the active tab with accessibility state selected=true', async () => {
  const items = shell.buildShellTabs({ navigation: { navigate: () => {} } });
  const { container, cleanup } = await renderComponent(
    React.createElement(shell.BottomTabBar, { items, activeKey: 'search' })
  );
  try {
    const search = container.querySelector('[data-testid="shell-bottom-tab-search"]');
    const home = container.querySelector('[data-testid="shell-bottom-tab-home"]');
    assert.equal(search.getAttribute('aria-selected'), 'true');
    assert.notEqual(home.getAttribute('aria-selected'), 'true');
  } finally {
    await cleanup();
  }
});

await test('CardTile renders rarity + price + name and honors testID contract', async () => {
  const { container, cleanup } = await renderComponent(
    React.createElement(cards.CardTile, {
      name: '星街すいせい',
      rarity: 'SR',
      price: 'NT$ 1,280',
      testID: 'phase2-card-tile',
    })
  );
  try {
    assert.equal(
      container.querySelector('[data-testid="phase2-card-tile-name"]').textContent,
      '星街すいせい'
    );
    assert.equal(
      container.querySelector('[data-testid="phase2-card-tile-rarity"]').textContent,
      'SR'
    );
    assert.equal(
      container.querySelector('[data-testid="phase2-card-tile-price"]').textContent,
      'NT$ 1,280'
    );
  } finally {
    await cleanup();
  }
});

await test('SeriesCard renders code + title from Pen contract', async () => {
  const { container, cleanup } = await renderComponent(
    React.createElement(cards.SeriesCard, {
      code: 'hBP01',
      title: 'ブルーミングレディアンス',
      testID: 'phase2-series-card',
    })
  );
  try {
    assert.equal(
      container.querySelector('[data-testid="phase2-series-card-code"]').textContent,
      'hBP01'
    );
    assert.equal(
      container.querySelector('[data-testid="phase2-series-card-title"]').textContent,
      'ブルーミングレディアンス'
    );
  } finally {
    await cleanup();
  }
});

console.log(`\nPassed ${passed} tests.`);
