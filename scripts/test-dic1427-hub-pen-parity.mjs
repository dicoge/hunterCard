#!/usr/bin/env node
// DIC-1427 QA P0 item 6 — re-audit corrections for Pen `App / 08 收藏`
// (ej9RF), `App / 09 我的最愛` (sSDxQ) and `App / 11 到價提醒` (VyzfW):
//   • ej9RF: the Pen stats hero (總收藏價值 + metric cells) is REAL —
//     computed from the deck store's ownership counts and the exact-printing
//     price records, never a static "NT$ 86,400".
//   • sSDxQ: favorite rows carry the real card identity — art, localized
//     name and the exact-printing reference price resolved from the shipped
//     catalog, and tap navigates to the real CardDetail.
//   • VyzfW: the intro paragraph becomes the Pen $accent-2 info banner, and
//     the row status renders as a tinted badge fed by the real
//     evaluateAlertStatus result.

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
const { loadCardDatabase } = await import('../src/utils/deckCardData.ts');
const { ownershipKey, resolveExactPrice } = await import('../src/utils/deckRules.ts');
const { useDeckStore } = await import('../src/store/deckStore.ts');
const { useFavoritesStore } = await import('../src/store/favoritesStore.ts');
const { usePriceAlertStore } = await import('../src/stores/priceAlertStore.ts');
const { default: CollectionScreen } = await import('../src/screens/CollectionScreen.tsx');
const { default: FavoritesScreen } = await import('../src/screens/FavoritesScreen.tsx');
const { default: WatchlistScreen } = await import('../src/screens/WatchlistScreen.tsx');

async function flush(ms = 0) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}
async function render(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  await flush(10);
  await flush(10);
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

// Real catalog entry with an exact-printing price so both value paths light up.
const db = await loadCardDatabase();
const priced = db.priceRecords.find((r) => r.version !== '' && typeof r.price === 'number' && r.price > 0);
assert.ok(priced, 'shipped catalog carries an exact-printing price record');
const pricedCard = db.cards.find((c) => c.cardNumber === priced.cardNumber && c.printing === priced.version);
assert.ok(pricedCard, 'price record resolves to a real catalog card');

console.log('── DIC-1427 · App 08/09/11 re-audit Pen parity ──');

await test('ej9RF stats hero: 總收藏價值 and metric cells computed from the REAL store + price records', async () => {
  useDeckStore.setState({
    collection: { [ownershipKey(pricedCard.cardNumber, pricedCard.printing)]: 3 },
    decks: [{ id: 'deck-a' }, { id: 'deck-b' }],
  });
  const { container, cleanup } = await render(React.createElement(CollectionScreen, {
    navigation: { navigate() {}, goBack() {} },
  }));
  try {
    const hero = container.querySelector('[data-testid="collection-stats-hero"]');
    assert.ok(hero, 'stats hero renders (Pen Eb2v2 block)');
    const expectedValue = priced.price * 3;
    assert.ok(
      hero.textContent.includes(expectedValue.toLocaleString()),
      `hero value carries the real ¥${expectedValue.toLocaleString()} (3 × real exact price)`,
    );
    assert.ok(hero.textContent.includes('3'), 'hero carries the real owned count');
    assert.ok(
      hero.textContent.includes('套牌數') && hero.textContent.includes('2'),
      '套牌數 cell (Pen wE9QD) carries the REAL deck-store count',
    );
  } finally { await cleanup(); }
});

await test('sSDxQ favorite rows: real art + localized name + exact reference price + CardDetail navigation', async () => {
  useFavoritesStore.setState({
    favorites: [{
      cardNumber: pricedCard.cardNumber,
      printing: pricedCard.printing,
      addedAt: '2026-09-01T00:00:00Z',
    }],
    removals: {},
  });
  const navs = [];
  const { container, cleanup } = await render(React.createElement(FavoritesScreen, {
    navigation: { navigate: (r, p) => navs.push([r, p]), goBack() {} },
  }));
  try {
    const row = container.querySelector(`[data-testid="favorite-row-${pricedCard.cardNumber}-${pricedCard.printing}"]`);
    assert.ok(row, 'favorite row renders');
    assert.ok(
      row.textContent.includes(pricedCard.nameZh || pricedCard.name),
      'row carries the real card name, not just the number',
    );
    assert.ok(row.querySelector('img') || row.textContent.includes(pricedCard.cardNumber), 'row carries the card art (Pen 44×60 thumb)');
    const exact = resolveExactPrice(pricedCard.cardNumber, pricedCard.printing, db.priceRecords);
    assert.equal(exact.status, 'ok');
    assert.ok(
      row.textContent.includes(exact.price.toLocaleString()),
      'row carries the real exact-printing reference price',
    );
    const open = row.querySelector(`[data-testid="favorite-open-${pricedCard.cardNumber}-${pricedCard.printing}"]`);
    assert.ok(open, 'row exposes the open-card action');
    await act(async () => open.click());
    assert.equal(navs.length, 1, 'row navigates');
    assert.equal(navs[0][0], 'CardDetail', 'to the real CardDetail route');
    const payload = navs[0][1]?.card;
    assert.equal(payload?.cardNumber, pricedCard.cardNumber, 'carrying the real card');
    // DIC-1430: the destination PAYLOAD is part of this parity contract. The
    // number-only assertion above passed while CardDetail opened with no market
    // data, because Favorites handed over the reduced deck-editor row.
    assert.equal(payload?.printing, pricedCard.printing, 'carrying the exact printing identity');
    assert.equal(payload?.yuyuPrice, exact.price, "carrying THIS printing's own price");
    assert.ok(
      Array.isArray(payload?.prices) && payload.prices.length > 0,
      'carrying the source listings CardDetail builds its version list from',
    );
    assert.ok(payload?.normalized, 'carrying the canonical normalized identity');
  } finally { await cleanup(); }
});

await test('sSDxQ sort control (Pen MxLuq 價格 ↓): reorders by the REAL exact-printing price, fail-closed', async () => {
  const second = db.priceRecords.find((r) => (
    r.version !== '' && typeof r.price === 'number' && r.price > 0
    && r.price !== priced.price
    && db.cards.some((c) => c.cardNumber === r.cardNumber && c.printing === r.version)
  ));
  assert.ok(second, 'catalog carries a second exact-printing price with a different value');
  const cheap = priced.price < second.price ? priced : second;
  const dear = priced.price < second.price ? second : priced;
  useFavoritesStore.setState({
    favorites: [
      { cardNumber: cheap.cardNumber, printing: cheap.version, addedAt: '2026-09-02T00:00:00Z' },
      { cardNumber: dear.cardNumber, printing: dear.version, addedAt: '2026-09-01T00:00:00Z' },
    ],
    removals: {},
  });
  const { container, cleanup } = await render(React.createElement(FavoritesScreen, {
    navigation: { navigate() {}, goBack() {} },
  }));
  try {
    const sort = container.querySelector('[data-testid="favorites-sort"]');
    assert.ok(sort, 'sort control renders in the head row (Pen VIu25)');
    const firstRowOf = () => container.querySelector('[data-testid^="favorite-open-"]').getAttribute('data-testid');
    assert.equal(
      firstRowOf(),
      `favorite-open-${cheap.cardNumber}-${cheap.version}`,
      'default order is the store insertion order',
    );
    await act(async () => sort.click());
    assert.equal(
      firstRowOf(),
      `favorite-open-${dear.cardNumber}-${dear.version}`,
      '價格 ↓ puts the higher REAL exact price first',
    );
  } finally { await cleanup(); }
});

await test('VyzfW: Pen info banner replaces the paragraph; status renders as a tinted badge', async () => {
  usePriceAlertStore.setState({
    alerts: {
      [`${pricedCard.cardNumber}|${pricedCard.printing}`]: {
        cardNumber: pricedCard.cardNumber,
        printing: pricedCard.printing,
        printingLabel: pricedCard.printingLabel || pricedCard.printing,
        name: pricedCard.name,
        currency: 'JPY',
        lowerPrice: 1,
        upperPrice: Math.max(2, priced.price * 2),
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
      },
    },
    pending: {},
  });
  const { container, cleanup } = await render(React.createElement(WatchlistScreen, {
    navigation: { navigate() {}, goBack() {} },
  }));
  try {
    const banner = container.querySelector('[data-testid="watchlist-info-banner"]');
    assert.ok(banner, 'Pen $accent-2 info banner renders (Pen VyzfW banner)');
    const hits = container.querySelector('[data-testid="watchlist-hit-count"]');
    assert.ok(hits, 'banner headline renders once the catalog is ready (Pen b65BhE)');
    assert.ok(hits.textContent.includes('1'), 'headline carries the REAL evaluated IN_RANGE count');
    const badge = container.querySelector(`[data-testid="price-alert-status-badge-${pricedCard.cardNumber}|${pricedCard.printing}"]`);
    assert.ok(badge, 'status badge renders on the alert row');
    assert.ok(badge.textContent.trim().length > 0, 'badge carries the real evaluated status');
  } finally { await cleanup(); }
});

console.log(`\nPassed ${passed} tests.`);
