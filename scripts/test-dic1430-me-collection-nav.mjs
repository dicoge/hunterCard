#!/usr/bin/env node
// DIC-1430 Production P0 — 我的 → 收藏 navigation must actually arrive.
//
// Mac-OpenClaw Production QA run 16c25a62-af71-4571-99c8-bc8e7a5878cd found
// that on https://holohunter.dicoge.com/ a fresh guest reaching 我的 can press
// BOTH real Collection entry points and go nowhere:
//   * `me-segment-collection` — count=1, visible, click succeeds
//   * `me-search-field`       — count=1, visible, click succeeds
// …yet `collection-shell` stays count=0, the page stays 我的, and there is NO
// console / page / network error. That silence is the fingerprint of React
// Navigation dropping `navigate()` for an UNREGISTERED route name: it is a
// no-op, not a throw.
//
// The divergence from the PASSING Preview QA deployment is the release
// profile: that Preview ran with a deployment-local EXPO_PUBLIC_STORE_MVP=0,
// while Web Production injects no define at all and therefore fail-closes to
// STORE_MVP=ON (src/config/releaseFlags.ts). MeScreen ships its Collection
// entry points UNCONDITIONALLY, but AppNavigator only registered the
// `Collection` Drawer.Screen behind `FEATURES.favorites` (= !STORE_MVP).
//
// This suite therefore pins the PRODUCTION profile (STORE_MVP ON) and mounts
// the REAL nested navigator tree — root stack + MainDrawer + every shipped
// screen, exactly what a web guest gets — then drives the real DOM elements
// with real click events. It must fail on the pre-fix baseline.

// Production web injects no EXPO_PUBLIC_STORE_MVP define, so the fail-closed
// resolver lands on ON. Pin it explicitly so a stray local .env cannot quietly
// downgrade this suite into the (already passing) full-app profile.
process.env.EXPO_PUBLIC_STORE_MVP = '1';

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
// The QA probe ran at the Pen mobile frame size; keep the same viewport so the
// shell resolves the same (non-desktop) breakpoint and bottom tab deck.
Object.defineProperty(dom.window, 'innerWidth', { value: 390, configurable: true });
Object.defineProperty(dom.window, 'innerHeight', { value: 844, configurable: true });
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { NavigationContainer, createNavigationContainerRef } = await import('@react-navigation/native');
const { STORE_MVP, FEATURES } = await import('../src/config/releaseFlags.ts');
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

// Walk back to 我的 through the real bottom tab deck the shell renders on
// every route, so each entry point is exercised from a focused 我的.
//
// The assertions below deliberately do NOT require `me-shell` to disappear
// once Collection opens: a drawer navigator keeps already-visited screens
// mounted while unfocused, so 我的 legitimately stays in the DOM. Arrival is
// proven by the FOCUSED route name plus the presence of `collection-shell`.
async function gotoMe() {
  const meTab = byTestId('shell-bottom-tab-me');
  assert.ok(meTab, 'shell bottom tab deck renders the 我的 tab');
  await click(meTab);
  assert.ok(byTestId('me-shell'), '我的 hub mounts before the Collection entry point is pressed');
}

await test('suite really runs the PRODUCTION release profile (Store MVP ON)', async () => {
  // Without this the suite could pass for the wrong reason: under
  // EXPO_PUBLIC_STORE_MVP=0 the Collection route was always registered, which
  // is precisely why Preview QA passed while Production failed.
  assert.equal(STORE_MVP, true, 'Web Production fail-closes to STORE_MVP ON');
  assert.equal(FEATURES.favorites, false, 'the Store MVP advanced-surface gate is closed');
});

await test('real nested navigator mounts for a web guest', async () => {
  assert.ok(navRef.isReady(), 'navigation container becomes ready');
  assert.ok(byTestId('home-shell'), 'HomeScreen mounts as the initial drawer child');
});

await test('我的 segment 卡牌收藏 navigates to the real Collection screen', async () => {
  await gotoMe();
  const segment = byTestId('me-segment-collection');
  assert.ok(segment, 'Pen oaxgt 卡牌收藏 segment renders on 我的 under Store MVP');
  await click(segment);
  assert.equal(
    navRef.getCurrentRoute()?.name,
    'Collection',
    `expected the Collection route, got ${navRef.getCurrentRoute()?.name}`,
  );
  assert.ok(byTestId('collection-shell'), 'CollectionScreen shell mounts (not still 我的)');
});

await test('我的 search field navigates to the real Collection screen', async () => {
  await gotoMe();
  const search = byTestId('me-search-field');
  assert.ok(search, 'Pen WUovy search field renders on 我的 under Store MVP');
  await click(search);
  assert.equal(
    navRef.getCurrentRoute()?.name,
    'Collection',
    `expected the Collection route, got ${navRef.getCurrentRoute()?.name}`,
  );
  assert.ok(byTestId('collection-shell'), 'CollectionScreen shell mounts (not still 我的)');
});

// NOTE: 我的 carries a third entry point wired to the same route —
// `me-view-all`, at the foot of the owned-card list. It is deliberately NOT
// covered here: it only renders once the guest owns at least one card, and
// seeding ownership to reach it would mean injecting state the Production QA
// guest never had. It is fixed by the same route registration.

await test('Store MVP still blocks the surfaces it is supposed to block', async () => {
  // The fix must open the Collection route ONLY. The watchlist/trends siblings
  // stay gated, so 我的 keeps rendering just the one shipped segment.
  await gotoMe();
  // Compare BOOLEANS, never DOM nodes: a failing `assert.equal(element, null)`
  // makes Node deep-inspect a cyclic JSDOM tree to build the diff until the
  // process is OOM-killed, which masks the real failure as an opaque SIGKILL.
  assert.equal(byTestId('me-segment-watchlist') !== null, false, '到價提醒 segment stays hidden under Store MVP');
  assert.equal(byTestId('me-segment-trends') !== null, false, '趨勢 segment stays hidden under Store MVP');
  await act(async () => { navRef.navigate('MainDrawer', { screen: 'Watchlist' }); });
  await settle();
  assert.notEqual(
    navRef.getCurrentRoute()?.name,
    'Watchlist',
    'Watchlist route stays unregistered under Store MVP (DIC-908)',
  );
});

await act(async () => root.unmount());

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ DIC-1430 我的 → 收藏 navigation (Production profile, real navigator): ${passed} checks passed`);
} else {
  console.error('\n❌ DIC-1430 我的 → 收藏 navigation failed — Production P0 reproduced');
}
