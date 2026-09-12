#!/usr/bin/env node
// DIC-1409 CR fix — bottom-tab navigation through the REAL nested
// navigator tree, not a stub. The CR found that `buildShellTabs()`
// navigated to drawer-child names ('Home', 'Search', …) which cannot
// resolve from root-stack screens (SearchResults / TutorialDetail /
// TutorialSimulation): the press was silently unhandled. The fix routes
// through the nested form `navigate('MainDrawer', { screen })`.
//
// This suite mounts `NavigationContainer` + the exported real
// `StackNavigator` (root stack + MainDrawer + every shipped screen) and
// proves tab presses land on the destination from BOTH contexts:
//   1. a root-stack screen (SearchResults → 首頁 tab → Home)
//   2. a root-stack screen (TutorialDetail → 牌組 tab → DeckEditor)
//   3. a drawer child (Home → 搜尋 tab → Search)

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
class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = NoopResizeObserver;
dom.window.ResizeObserver = NoopResizeObserver;
if (!dom.window.matchMedia) {
  dom.window.matchMedia = () => ({
    matches: false,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
  });
  globalThis.matchMedia = dom.window.matchMedia;
}
Object.defineProperty(dom.window, 'innerWidth', { value: 390, configurable: true });
Object.defineProperty(dom.window, 'innerHeight', { value: 844, configurable: true });
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { NavigationContainer, createNavigationContainerRef } = await import('@react-navigation/native');
const { StackNavigator } = await import('../src/navigation/AppNavigator.tsx');

const byTestId = (id) => dom.window.document.querySelector(`[data-testid="${id}"]`);
const click = async (el) => {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  await settle();
};
const settle = async () => {
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

let passed = 0;
async function test(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    process.exitCode = 1;
    console.error(`  ✗ ${label} — ${err.message}`);
  }
}

const navRef = createNavigationContainerRef();
const host = dom.window.document.createElement('div');
dom.window.document.body.appendChild(host);
const root = createRoot(host);
await act(async () => {
  root.render(
    React.createElement(
      NavigationContainer,
      { ref: navRef },
      React.createElement(StackNavigator),
    ),
  );
  await Promise.resolve();
});
await settle();

await test('real nested navigator mounts with Home (drawer child) visible', async () => {
  assert.ok(navRef.isReady(), 'navigation container becomes ready');
  assert.ok(byTestId('home-shell'), 'HomeScreen mounts as the initial drawer child');
});

await test('drawer child → tab press: Home 搜尋 tab lands on Search', async () => {
  const searchTab = byTestId('shell-bottom-tab-search');
  assert.ok(searchTab, 'Home shell renders the 搜尋 tab');
  await click(searchTab);
  assert.equal(navRef.getCurrentRoute()?.name, 'Search', `expected Search, got ${navRef.getCurrentRoute()?.name}`);
});

await test('root-stack screen → tab press: SearchResults 首頁 tab lands on Home', async () => {
  await act(async () => { navRef.navigate('SearchResults', { query: 'すいせい' }); });
  await settle();
  assert.equal(navRef.getCurrentRoute()?.name, 'SearchResults', 'test drives the real SearchResults stack route');
  const homeTab = byTestId('shell-bottom-tab-home');
  assert.ok(homeTab, 'SearchResults shell renders the 首頁 tab');
  await click(homeTab);
  assert.equal(navRef.getCurrentRoute()?.name, 'Home', `expected Home, got ${navRef.getCurrentRoute()?.name}`);
  assert.ok(byTestId('home-shell'), 'HomeScreen content mounts after the tab press');
});

await test('root-stack screen → tab press: TutorialDetail 牌組 tab lands on DeckEditor', async () => {
  await act(async () => { navRef.navigate('TutorialDetail', { sectionId: 'section-1' }); });
  await settle();
  assert.equal(navRef.getCurrentRoute()?.name, 'TutorialDetail', 'test drives the real TutorialDetail stack route');
  const deckTab = byTestId('shell-bottom-tab-deck');
  assert.ok(deckTab, 'TutorialDetail shell renders the 牌組 tab');
  await click(deckTab);
  assert.equal(navRef.getCurrentRoute()?.name, 'DeckEditor', `expected DeckEditor, got ${navRef.getCurrentRoute()?.name}`);
});

await act(async () => root.unmount());

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ DIC-1409 shell tab navigation (real nested navigator): ${passed} checks passed`);
} else {
  console.error('\n❌ DIC-1409 shell tab navigation failed');
}
