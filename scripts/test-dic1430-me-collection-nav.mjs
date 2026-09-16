#!/usr/bin/env node
// DIC-1430 — the 我的 Collection entry points must agree with the Collection
// route's registration in BOTH release profiles.
//
// Mac-OpenClaw Production QA run 16c25a62-af71-4571-99c8-bc8e7a5878cd found
// that on https://holohunter.dicoge.com/ a fresh guest reaching 我的 could
// press the real Collection entry points and go nowhere:
//   * `me-segment-collection` — count=1, visible, click succeeds
//   * `me-search-field`       — count=1, visible, click succeeds
// …yet `collection-shell` stayed count=0, the page stayed 我的, and there was
// NO console / page / network error. That silence is the fingerprint of React
// Navigation dropping `navigate()` for an UNREGISTERED route name: a no-op,
// not a throw, and its dev-only warning is stripped from production builds.
//
// Root cause: DIC-1427 shipped 我的 with three UNCONDITIONAL controls onto
// `Collection` (segment, search field, 檢視全部), while AppNavigator registers
// that route only behind `FEATURES.favorites` (= !STORE_MVP, DIC-1256). Web
// Production injects no EXPO_PUBLIC_STORE_MVP define, so the resolver
// fail-closes to STORE_MVP=ON and the route is absent.
//
// THE FIX IS THE CONTROLS, NOT THE ROUTE. Store MVP's DIC-1256 requirement is
// fail-closed on the route itself — "not only hidden menus" — so navigate()
// and deep links must both be unable to reach Collection in that profile. CR
// run 037b339f rejected the inverse repair (registering the route in every
// profile and hiding only its drawer menu row) because it reverses that
// recorded requirement without a superseding product/compliance decision.
//
// Two profiles, each in its OWN PROCESS because src/config/releaseFlags.ts
// resolves STORE_MVP once at module load:
//
//   production (EXPO_PUBLIC_STORE_MVP=1) — fail-closed:
//     none of the three controls render, and Collection is unreachable by
//     programmatic navigate() AND by a nested/deep-link navigate().
//   full (EXPO_PUBLIC_STORE_MVP=0) — full app:
//     all three controls render and each one really arrives at the route.
//
// Run: npm run test:collection-nav

import { fileURLToPath } from 'node:url';

const PROFILE = process.env.DIC1430_PROFILE;

// ── Runner: fan out to one child per release profile ──
if (!PROFILE) {
  const { spawnSync } = await import('node:child_process');
  const self = fileURLToPath(import.meta.url);
  let failed = false;

  for (const [profile, storeMvp] of [['production', '1'], ['full', '0']]) {
    console.log(`\n── release profile: ${profile} (EXPO_PUBLIC_STORE_MVP=${storeMvp}) ──`);
    // Inherit execArgv so the child keeps the type-stripping + web-render
    // loader flags the npm script supplies; hardcoding them here would drift.
    const res = spawnSync(process.execPath, [...process.execArgv, self], {
      stdio: 'inherit',
      env: { ...process.env, DIC1430_PROFILE: profile, EXPO_PUBLIC_STORE_MVP: storeMvp },
    });
    if (res.status !== 0) {
      failed = true;
      console.error(`  ✗ profile ${profile} exited ${res.status}${res.signal ? ` (signal ${res.signal})` : ''}`);
    }
  }

  if (failed) {
    console.error('\n❌ DIC-1430 我的 Collection controls vs route registration: FAILED');
    process.exit(1);
  }
  console.log('\n✅ DIC-1430 我的 Collection controls match route registration in both profiles');
  process.exit(0);
}

// ── Child: one release profile ──
const IS_PRODUCTION_PROFILE = PROFILE === 'production';
// Pin defensively so a stray local .env cannot silently swap the profile and
// make this child pass for the wrong reason.
process.env.EXPO_PUBLIC_STORE_MVP = IS_PRODUCTION_PROFILE ? '1' : '0';

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
// owns at least one card, so without this its absence under Store MVP would
// pass for the wrong reason — the empty-state branch would be hiding it
// regardless of the release flag. Seeding makes the flag the only variable.
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
// Arrival at Collection is proven by the FOCUSED route name plus the presence
// of `collection-shell` — deliberately NOT by `me-shell` disappearing, since a
// drawer navigator keeps already-visited screens mounted while unfocused.
async function gotoMe() {
  const meTab = byTestId('shell-bottom-tab-me');
  assert.ok(meTab, 'shell bottom tab deck renders the 我的 tab');
  await click(meTab);
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
  assert.equal(STORE_MVP, IS_PRODUCTION_PROFILE, `STORE_MVP must be ${IS_PRODUCTION_PROFILE}`);
  assert.equal(FEATURES.favorites, !IS_PRODUCTION_PROFILE, `FEATURES.favorites must be ${!IS_PRODUCTION_PROFILE}`);
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

if (IS_PRODUCTION_PROFILE) {
  // ── Store MVP: fail-closed. No control may reference the absent route. ──
  await test('NONE of the three Collection controls render under Store MVP', async () => {
    await gotoMe();
    assert.equal(isPresent('me-segment-collection'), false, '卡牌收藏 segment must not render');
    assert.equal(isPresent('me-search-field'), false, 'search field must not render');
    assert.equal(isPresent('me-view-all'), false, '檢視全部 must not render (ownership IS seeded)');
  });

  await test('no empty segment bar is left behind once every segment is gated off', async () => {
    await gotoMe();
    // styles.segmentRow paints a bordered surface; an empty one would read as
    // a broken control strip rather than an absent feature.
    assert.equal(isPresent('me-segments'), false, 'the segment row itself is dropped');
    assert.equal(isPresent('me-segment-watchlist'), false, '到價提醒 segment stays hidden (DIC-908)');
    assert.equal(isPresent('me-segment-trends'), false, '趨勢 segment stays hidden');
  });

  await test('Collection route is UNREACHABLE by programmatic navigate() (DIC-1256)', async () => {
    await gotoMe();
    const { route } = await tryNavigate('Collection');
    assert.notEqual(route, 'Collection', 'navigate("Collection") must not arrive');
    assert.equal(isPresent('collection-shell'), false, 'CollectionScreen must not mount');
  });

  await test('Collection route is UNREACHABLE by a nested/deep-link navigate() (DIC-1256)', async () => {
    await gotoMe();
    const { route } = await tryNavigate('MainDrawer', { screen: 'Collection' });
    assert.notEqual(route, 'Collection', 'deep link into MainDrawer/Collection must not arrive');
    assert.equal(isPresent('collection-shell'), false, 'CollectionScreen must not mount');
  });

  await test('Watchlist route stays unregistered too (DIC-908 regression)', async () => {
    await gotoMe();
    const { route } = await tryNavigate('MainDrawer', { screen: 'Watchlist' });
    assert.notEqual(route, 'Watchlist', 'Watchlist route stays unregistered under Store MVP');
  });
} else {
  // ── Full app: every intended entry point renders AND arrives. ──
  await test('all three Collection controls render when the profile is off', async () => {
    await gotoMe();
    assert.equal(isPresent('me-segment-collection'), true, 'Pen oaxgt 卡牌收藏 segment renders');
    assert.equal(isPresent('me-search-field'), true, 'Pen WUovy search field renders');
    assert.equal(isPresent('me-view-all'), true, 'Pen 檢視全部 action renders');
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
}

await act(async () => root.unmount());

if ((process.exitCode ?? 0) === 0) {
  console.log(`  ${PROFILE}: ${passed} checks passed`);
} else {
  console.error(`  ${PROFILE}: FAILED`);
}
