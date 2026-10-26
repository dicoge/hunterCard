#!/usr/bin/env node
// DIC-1430 → DIC-1481 — the 我的 Collection entry points must agree with the
// Collection route's registration in EVERY release profile, and since
// DIC-1481 that registration is unconditional.
//
// History, because this file used to assert the opposite:
//   * DIC-1430 (Production P0): 我的 shipped three live controls onto a route
//     AppNavigator only registered behind FEATURES.favorites (= !STORE_MVP,
//     DIC-1256). React Navigation drops navigate() to an unknown route name
//     silently in production builds, so QA saw working clicks, no arrival,
//     no error. The repair then was gating the CONTROLS; CR run 037b339f
//     rejected registering the route in every profile because no product
//     decision superseded DIC-1256's "not only hidden menus" criterion.
//   * DIC-1481 (Play Production release blocker): the corrected
//     new-interface release contract IS that superseding decision — the
//     Collection ownership browser must stay registered and reachable in
//     every release profile, while store-disallowed favorites/watchlist/
//     market surfaces still fail closed. CR run edb401bf failed the release
//     because production set EXPO_PUBLIC_STORE_MVP=1, AppNavigator
//     unregistered Collection, and this test asserted that wrong behavior.
//
// So the contract asserted here is now:
//   EVERY profile — the three 我的 Collection controls render and each one
//   really arrives at the Collection route; programmatic navigate() and the
//   nested/deep-link form both arrive.
//   Store-MVP profiles (production, preview) — Favorites and Watchlist
//   routes stay UNREGISTERED and their 我的 segments stay hidden: the
//   fail-closed boundary moved for exactly one route, not for the profile.
//
// Three profiles, each in its OWN PROCESS because src/config/releaseFlags.ts
// resolves STORE_MVP once at module load:
//
//   production (EXPO_PUBLIC_STORE_MVP=1) — Store MVP ON (eas.json production)
//   preview    (EXPO_PUBLIC_STORE_MVP unset) — Store MVP ON via the
//     fail-closed resolver default; also proves the unset-env path that Web
//     Production actually ships keeps Collection reachable
//   full       (EXPO_PUBLIC_STORE_MVP=0) — full app
//
// Run: npm run test:collection-nav

import { fileURLToPath } from 'node:url';

const PROFILE = process.env.DIC1481_PROFILE;

// ── Runner: fan out to one child per release profile ──
if (!PROFILE) {
  const { spawnSync } = await import('node:child_process');
  const self = fileURLToPath(import.meta.url);
  let failed = false;

  for (const [profile, storeMvp] of [['production', '1'], ['preview', null], ['full', '0']]) {
    console.log(`\n── release profile: ${profile} (EXPO_PUBLIC_STORE_MVP=${storeMvp ?? '<unset>'}) ──`);
    // Inherit execArgv so the child keeps the type-stripping + web-render
    // loader flags the npm script supplies; hardcoding them here would drift.
    const env = { ...process.env, DIC1481_PROFILE: profile };
    if (storeMvp === null) delete env.EXPO_PUBLIC_STORE_MVP;
    else env.EXPO_PUBLIC_STORE_MVP = storeMvp;
    const res = spawnSync(process.execPath, [...process.execArgv, self], {
      stdio: 'inherit',
      env,
    });
    if (res.status !== 0) {
      failed = true;
      console.error(`  ✗ profile ${profile} exited ${res.status}${res.signal ? ` (signal ${res.signal})` : ''}`);
    }
  }

  if (failed) {
    console.error('\n❌ DIC-1481 Collection route registration across release profiles: FAILED');
    process.exit(1);
  }
  console.log('\n✅ DIC-1481 Collection route reachable in every profile; restricted surfaces stay fail-closed');
  process.exit(0);
}

// ── Child: one release profile ──
const IS_STORE_MVP_PROFILE = PROFILE !== 'full';
// Pin defensively so a stray local .env cannot silently swap the profile and
// make this child pass for the wrong reason. `preview` deliberately leaves
// the variable UNSET to exercise the resolver's fail-closed default.
if (PROFILE === 'production') process.env.EXPO_PUBLIC_STORE_MVP = '1';
else if (PROFILE === 'preview') delete process.env.EXPO_PUBLIC_STORE_MVP;
else process.env.EXPO_PUBLIC_STORE_MVP = '0';

const assert = (await import('node:assert/strict')).default;
const { JSDOM } = await import('jsdom');

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
const { useDeckStore } = await import('../src/store/deckStore.ts');

const byTestId = (id) => dom.window.document.querySelector(`[data-testid="${id}"]`);
// Compare BOOLEANS, never DOM nodes: a failing `assert.equal(element, null)`
// makes Node deep-inspect a cyclic JSDOM tree to build the diff until the
// process is OOM-killed, which masks the real failure as an opaque SIGKILL.
const isPresent = (id) => byTestId(id) !== null;
const settle = async () => {
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const click = async (el) => {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  await settle();
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

// Seed one owned printing BEFORE mount. 檢視全部 renders only once the guest
// owns at least one card, so without this its rendering in every profile
// could hide an empty-state interaction rather than prove the release flag.
// Seeding makes the flag the only variable.
// (Canonical exact-print identity: cardNumber|printing, never BASE.)
const SEEDED_KEY = 'hBP01-024|PARALLEL/HR';
useDeckStore.setState({ collection: { [SEEDED_KEY]: 2 } });

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
// Arrival at Collection is proven by the FOCUSED route name — deliberately
// NOT by shell testIDs appearing/disappearing, since a drawer navigator
// keeps already-visited screens mounted while unfocused, so once Collection
// has been reached `collection-shell` stays in the DOM for the rest of the
// process.
async function gotoMe() {
  const meTab = byTestId('shell-bottom-tab-me');
  assert.ok(meTab, 'shell bottom tab deck renders the 我的 tab');
  await click(meTab);
  assert.equal(navRef.getCurrentRoute()?.name, 'Me', '我的 becomes the focused route');
  assert.ok(byTestId('me-shell'), '我的 hub mounts');
}

/** Attempt a navigation and report whether it ARRIVED. An unregistered route
 *  may either no-op or throw depending on the navigator; both mean the route
 *  is unreachable, so the caller asserts on arrival, not on the mechanism. */
async function tryNavigate(...args) {
  let threw = null;
  try {
    await act(async () => { navRef.navigate(...args); });
  } catch (err) {
    threw = err;
  }
  await settle();
  return { threw, route: navRef.getCurrentRoute()?.name };
}

await test(`suite really runs the ${PROFILE} release profile`, async () => {
  assert.equal(STORE_MVP, IS_STORE_MVP_PROFILE, `STORE_MVP must be ${IS_STORE_MVP_PROFILE}`);
  assert.equal(FEATURES.favorites, !IS_STORE_MVP_PROFILE, `FEATURES.favorites must be ${!IS_STORE_MVP_PROFILE}`);
  assert.equal(FEATURES.watchlist, !IS_STORE_MVP_PROFILE, `FEATURES.watchlist must be ${!IS_STORE_MVP_PROFILE}`);
  assert.equal(FEATURES.collection, true, 'FEATURES.collection must be true in every profile (DIC-1481)');
});

await test('real nested navigator mounts for a web guest', async () => {
  assert.ok(navRef.isReady(), 'navigation container becomes ready');
  assert.ok(byTestId('home-shell'), 'HomeScreen mounts as the initial drawer child');
});

await test('我的 mounts with seeded ownership (檢視全部 precondition satisfied)', async () => {
  await gotoMe();
  assert.equal(isPresent('me-owned-row'), true, 'the seeded owned printing renders a row');
  assert.equal(isPresent('me-owned-empty'), false, '我的 is NOT in the empty state');
});

// ── DIC-1481: Collection is registered and reachable in EVERY profile. ──

await test('all three Collection controls render (DIC-1481: every profile)', async () => {
  await gotoMe();
  assert.equal(isPresent('me-segments'), true, 'the segment row renders');
  assert.equal(isPresent('me-segment-collection'), true, 'Pen oaxgt 卡牌收藏 segment renders');
  assert.equal(isPresent('me-search-field'), true, 'Pen WUovy search field renders');
  assert.equal(isPresent('me-view-all'), true, 'Pen 檢視全部 action renders (ownership IS seeded)');
});

await test('Collection route is REACHABLE by programmatic navigate() (DIC-1481)', async () => {
  await gotoMe();
  const { route, threw } = await tryNavigate('Collection');
  assert.equal(threw, null, `navigate("Collection") must not throw: ${threw}`);
  assert.equal(route, 'Collection', 'navigate("Collection") must arrive');
  assert.equal(isPresent('collection-shell'), true, 'CollectionScreen mounts');
});

await test('Collection route is REACHABLE by a nested/deep-link navigate() (DIC-1481)', async () => {
  await gotoMe();
  const { route, threw } = await tryNavigate('MainDrawer', { screen: 'Collection' });
  assert.equal(threw, null, `deep link into MainDrawer/Collection must not throw: ${threw}`);
  assert.equal(route, 'Collection', 'deep link into MainDrawer/Collection must arrive');
});

for (const [label, testID] of [
  ['我的 segment 卡牌收藏', 'me-segment-collection'],
  ['我的 search field', 'me-search-field'],
  ['我的 檢視全部 action', 'me-view-all'],
]) {
  await test(`${label} navigates to the real Collection screen`, async () => {
    await gotoMe();
    const el = byTestId(testID);
    assert.ok(el, `${testID} renders on 我的`);
    await click(el);
    assert.equal(
      navRef.getCurrentRoute()?.name,
      'Collection',
      `expected the Collection route, got ${navRef.getCurrentRoute()?.name}`,
    );
    assert.equal(isPresent('collection-shell'), true, 'CollectionScreen shell mounts (not still 我的)');
  });
}

// ── The fail-closed boundary moved for ONE route only. Favorites, Watchlist
//    and their 我的 segments keep the DIC-1256 / DIC-908 behavior. ──

if (IS_STORE_MVP_PROFILE) {
  await test('restricted 我的 segments stay hidden under Store MVP', async () => {
    await gotoMe();
    assert.equal(isPresent('me-segment-watchlist'), false, '到價提醒 segment stays hidden (DIC-908)');
    assert.equal(isPresent('me-segment-trends'), false, '趨勢 segment stays hidden (DIC-1256)');
  });

  await test('Favorites route stays UNREACHABLE under Store MVP (DIC-1256)', async () => {
    await gotoMe();
    const direct = await tryNavigate('Favorites');
    assert.notEqual(direct.route, 'Favorites', 'navigate("Favorites") must not arrive');
    const nested = await tryNavigate('MainDrawer', { screen: 'Favorites' });
    assert.notEqual(nested.route, 'Favorites', 'deep link into MainDrawer/Favorites must not arrive');
  });

  await test('Watchlist route stays UNREACHABLE under Store MVP (DIC-908)', async () => {
    await gotoMe();
    const direct = await tryNavigate('Watchlist');
    assert.notEqual(direct.route, 'Watchlist', 'navigate("Watchlist") must not arrive');
    const nested = await tryNavigate('MainDrawer', { screen: 'Watchlist' });
    assert.notEqual(nested.route, 'Watchlist', 'deep link into MainDrawer/Watchlist must not arrive');
  });
} else {
  await test('restricted 我的 segments render in the full profile', async () => {
    await gotoMe();
    assert.equal(isPresent('me-segment-watchlist'), true, '到價提醒 segment renders');
    assert.equal(isPresent('me-segment-trends'), true, '趨勢 segment renders');
  });

  await test('Favorites and Watchlist routes are registered in the full profile', async () => {
    await gotoMe();
    const favorites = await tryNavigate('MainDrawer', { screen: 'Favorites' });
    assert.equal(favorites.route, 'Favorites', 'deep link into MainDrawer/Favorites arrives');
    await gotoMe();
    const watchlist = await tryNavigate('MainDrawer', { screen: 'Watchlist' });
    assert.equal(watchlist.route, 'Watchlist', 'deep link into MainDrawer/Watchlist arrives');
  });
}

await act(async () => root.unmount());

if ((process.exitCode ?? 0) === 0) {
  console.log(`  ${PROFILE}: ${passed} checks passed`);
} else {
  console.error(`  ${PROFILE}: FAILED`);
}
