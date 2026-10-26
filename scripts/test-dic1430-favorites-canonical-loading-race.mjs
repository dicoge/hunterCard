#!/usr/bin/env node
// DIC-1430 CR round 2 — a tap that lands WHILE the canonical index is still
// loading must never leak a reduced payload to CardDetail.
//
// The regression this pins: FavoritesScreen kept the canonical index in state
// and resolved against it synchronously on press. Between mount and the
// moment `loadCanonicalCardIndex()` settled, that state was `null`, so
// `canonical?.resolve(...)` produced `undefined` and the handler fell straight
// through to the identity-only fallback — the branch meant for a legacy
// bookmark the catalog genuinely no longer carries. A user who tapped during
// the load window therefore opened CardDetail with no price, no skills, no
// stats and no history, and nothing about that payload said it was incomplete.
// "Still loading" is not "unresolvable".
//
// Why this test cannot go falsely green:
//   * the loader is a GATE this test opens by hand — there is no sleep, no
//     timing window and no pre-flushed render. The tap provably happens while
//     the promise is unsettled (asserted via `settled`).
//   * on the pre-fix code the tap navigates IMMEDIATELY with the reduced
//     payload, so the "no navigation while pending" assertion fails outright.
//   * the post-release payload is checked for the exact-printing price, the
//     version list and the skills the reduced payload could never carry.

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

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
Object.defineProperty(dom.window, 'innerWidth', { value: 390, configurable: true });

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { loadDatabaseJson } = await import('../src/utils/staticData.ts');
const { adaptCardNumber } = await import('../src/utils/deckCardData.ts');
const { printingFromLabel } = await import('../src/utils/printingIdentity.ts');
const { loadCanonicalCardIndex } = await import('../src/utils/canonicalCardRecord.ts');
const { useFavoritesStore } = await import('../src/store/favoritesStore.ts');
const { default: FavoritesScreen } = await import('../src/screens/FavoritesScreen.tsx');

async function flush(ms = 0) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/**
 * A canonical-index loader this test opens BY HAND.
 *
 * `settled` is the proof that the tap really landed inside the pending window:
 * nothing but `release()` can flip it, so a future refactor that resolves the
 * index before the press would trip the assertion rather than silently turn
 * this regression into a no-op.
 */
function gatedLoader(index) {
  let release;
  let settled = false;
  const gate = new Promise((resolve) => {
    release = () => { settled = true; resolve(index); };
  });
  return {
    load: () => gate,
    release,
    isSettled: () => settled,
    calls: 0,
  };
}

// ── Fixture: a REAL favorite whose exact printing is priced far from the
// card-number aggregate, so every payload assertion below is sensitive to a
// fallback rather than vacuous.
const rawDb = await loadDatabaseJson();
const byNumber = new Map();
for (const row of Object.values(rawDb.cards || {})) {
  if (!row?.cardNumber) continue;
  const list = byNumber.get(row.cardNumber);
  if (list) list.push(row);
  else byNumber.set(row.cardNumber, [row]);
}
const fixtureRows = byNumber.get('hBP01-024');
assert.ok(fixtureRows, 'shipped catalog still carries hBP01-024');
const fixtureAdapted = adaptCardNumber(fixtureRows);
const dearest = fixtureAdapted.priceRecords.slice().sort((a, b) => b.price - a.price)[0];
assert.ok(dearest, 'hBP01-024 still carries a priced printing');
const FIXTURE = { cardNumber: 'hBP01-024', printing: dearest.version, exactPrice: dearest.price };

// The exact listing image the resolved payload must carry, derived from source.
const expectedImage = fixtureRows
  .flatMap((row) => row.prices ?? [])
  .find((listing) => printingFromLabel(listing?.name ?? '') === FIXTURE.printing)?.imageUrl;
assert.ok(expectedImage, 'the fixture printing publishes its own listing image');

console.log('── DIC-1430 CR2 · canonical-index loading race ──');
console.log(`   fixture: ${FIXTURE.cardNumber} [${FIXTURE.printing}] ¥${FIXTURE.exactPrice.toLocaleString()}`);

// Warm the module cache once so the gate — not the JSON read — is the only
// thing deciding when the index becomes available.
const realIndex = await loadCanonicalCardIndex();

await test('a tap during the PENDING load neither navigates nor leaks a reduced payload', async () => {
  useFavoritesStore.setState({
    favorites: [{ ...FIXTURE, addedAt: '2026-09-01T00:00:00Z' }],
    removals: {},
  });

  const gate = gatedLoader(realIndex);
  const navs = [];
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => root.render(React.createElement(FavoritesScreen, {
    navigation: { navigate: (route, params) => navs.push([route, params]), goBack() {} },
    loadCanonicalIndex: () => { gate.calls += 1; return gate.load(); },
  })));
  // Let the row itself render (loadCardDatabase is NOT gated) without ever
  // letting the canonical index settle.
  await flush(10);
  await flush(10);

  assert.equal(gate.isSettled(), false, 'precondition: the canonical index is still loading');
  assert.ok(gate.calls > 0, 'the screen actually asked for the canonical index');

  const open = container.querySelector(
    `[data-testid="favorite-open-${FIXTURE.cardNumber}-${FIXTURE.printing}"]`,
  );
  assert.ok(open, 'the favorite row rendered and is tappable during the load');

  // ── The tap, inside the pending window ──
  await act(async () => open.click());
  await flush(10);

  assert.equal(
    gate.isSettled(), false,
    'the index is STILL pending — the tap genuinely happened inside the load window',
  );
  assert.equal(
    navs.length, 0,
    'no navigation while the canonical index is pending — the pre-fix code navigated '
    + 'here with an identity-only payload',
  );

  // ── Open the gate; the very same tap must now complete with the full record ──
  await act(async () => { gate.release(); await gate.load(); });
  await flush(10);

  assert.equal(navs.length, 1, 'the pending tap resolves into exactly one navigation');
  assert.equal(navs[0][0], 'CardDetail', 'to the real CardDetail route');
  const payload = navs[0][1]?.card;
  assert.ok(payload, 'the route carries a card payload');

  // Everything the reduced fallback could never have carried.
  assert.equal(payload.cardNumber, FIXTURE.cardNumber, 'the real card number');
  assert.equal(payload.printing, FIXTURE.printing, 'the EXACT printing bookmarked');
  assert.equal(payload.yuyuPrice, FIXTURE.exactPrice, "this printing's own sell price");
  assert.ok(Array.isArray(payload.prices) && payload.prices.length > 0, 'the version list survives');
  assert.ok(payload.skillsZh || payload.skillsJp, 'skills survive');
  assert.ok(payload.normalized?.category, 'normalized identity survives');
  assert.equal(payload.imageUrl, expectedImage, "the exact printing's own artwork");

  await act(async () => root.unmount());
  container.remove();
});

await test('a loader that NEVER settles never navigates at all (no timing luck)', async () => {
  useFavoritesStore.setState({
    favorites: [{ ...FIXTURE, addedAt: '2026-09-01T00:00:00Z' }],
    removals: {},
  });

  const navs = [];
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => root.render(React.createElement(FavoritesScreen, {
    navigation: { navigate: (route, params) => navs.push([route, params]), goBack() {} },
    // Never resolves, never rejects.
    loadCanonicalIndex: () => new Promise(() => {}),
  })));
  await flush(10);

  const open = container.querySelector(
    `[data-testid="favorite-open-${FIXTURE.cardNumber}-${FIXTURE.printing}"]`,
  );
  assert.ok(open, 'the favorite row still renders');

  await act(async () => open.click());
  await flush(25);
  await flush(25);

  assert.equal(
    navs.length, 0,
    'an unresolved canonical index blocks navigation indefinitely rather than '
    + 'degrading to identity-only — the payload is never silently reduced',
  );

  await act(async () => root.unmount());
  container.remove();
});

await test('after loading SETTLES, a genuinely unresolved favorite still fails closed', async () => {
  // The honest dead end must survive the fix: a legacy bookmark still opens,
  // carrying identity only, with no price borrowed from any sibling printing.
  useFavoritesStore.setState({
    favorites: [{ cardNumber: 'hZZ99-999', printing: 'BASE', addedAt: '2026-09-01T00:00:00Z' }],
    removals: {},
  });

  const gate = gatedLoader(realIndex);
  const navs = [];
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => root.render(React.createElement(FavoritesScreen, {
    navigation: { navigate: (route, params) => navs.push([route, params]), goBack() {} },
    loadCanonicalIndex: () => gate.load(),
  })));
  await flush(10);

  // Settle FIRST — this branch is only legitimate once loading is done.
  await act(async () => { gate.release(); await gate.load(); });
  await flush(10);

  const open = container.querySelector('[data-testid="favorite-open-hZZ99-999-BASE"]');
  assert.ok(open, 'the legacy favorite row renders');
  await act(async () => open.click());
  await flush(10);

  assert.equal(navs.length, 1, 'a legacy bookmark still opens — the route never dead-ends');
  const payload = navs[0][1]?.card;
  assert.equal(payload.cardNumber, 'hZZ99-999', 'carrying its own identity');
  assert.equal(payload.printing, 'BASE', 'preserving the bookmarked printing');
  assert.equal(payload.yuyuPrice, undefined, 'no price is invented for an unknown card');
  assert.equal(payload.prices, undefined, 'no listings are invented for an unknown card');

  await act(async () => root.unmount());
  container.remove();
});

await test('an already-warm index still resolves the tap in place', async () => {
  // The common case must not regress into an avoidable await.
  useFavoritesStore.setState({
    favorites: [{ ...FIXTURE, addedAt: '2026-09-01T00:00:00Z' }],
    removals: {},
  });

  const navs = [];
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => root.render(React.createElement(FavoritesScreen, {
    navigation: { navigate: (route, params) => navs.push([route, params]), goBack() {} },
    loadCanonicalIndex: async () => realIndex,
  })));
  await flush(10);
  await flush(10);

  const open = container.querySelector(
    `[data-testid="favorite-open-${FIXTURE.cardNumber}-${FIXTURE.printing}"]`,
  );
  await act(async () => open.click());
  await flush(0);

  assert.equal(navs.length, 1, 'the warm path navigates');
  assert.equal(navs[0][1]?.card?.yuyuPrice, FIXTURE.exactPrice, 'with the full canonical payload');

  await act(async () => root.unmount());
  container.remove();
});

console.log(`\n✅ DIC-1430 CR2 canonical loading race: ${passed} tests passed`);
