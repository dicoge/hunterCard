#!/usr/bin/env node
// DIC-1430 — ONE CardDetail must use ONE proven exact-print identity across
// hero art, the action-bar favorite payload, persistence, the Favorites row and
// reopen.
//
// The regression this pins (QA, real route, 390 and 1440):
//   search `hBP01-024` → CardDetail opens showing the official HR artwork
//   `hBP01-024_HR.png` → tapping `card-detail-action-favorite` persisted
//   `printing: "BASE"`, produced the row test id `favorite-open-hBP01-024-BASE`
//   and listed the ¥120 BASE artwork `hbp01/10036.jpg`. Reload and reopen at
//   both breakpoints stayed BASE. No console, page or network error — the view
//   was internally inconsistent, not broken.
//
// Why it happened: CardDetailScreen resolved the hero art and the
// collection/favorite printing INDEPENDENTLY. A card-number-level search hit
// carries no `printing`, so the hero rendered the elected row's official HR
// image while `resolveVersionForCard(buildPriceVersions(card))` ran
// `pickDefaultPrintingIndex`, whose plain-beats-premium rule elects BASE
// outright. The favorites store, FavoritesScreen and the canonical resolver
// then faithfully round-tripped that wrong add-side key — they are not the bug
// and must not paper over it with a migration.
//
// Why this test cannot go falsely green:
//   * the payload is produced by the REAL `searchCards` product path over the
//     REAL shipped catalog — not a hand-built fixture — so the fixture
//     preconditions below fail loudly if the catalog stops reproducing it;
//   * every identity assertion names the HR value AND rejects the BASE decoy
//     (¥120 / hbp01/10036.jpg), so a change that renders "everything" cannot
//     satisfy it;
//   * the exact-payload guard proves a payload that already carries `printing`
//     is still stored verbatim, so a fix may not re-derive identity on write.

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

function setViewport(width) {
  Object.defineProperty(dom.window.document.documentElement, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(dom.window, 'innerWidth', { value: width, configurable: true });
}
setViewport(390);

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { loadDatabaseJson, loadSeriesNamesJson } = await import('../src/utils/staticData.ts');
const { searchCards } = await import('../src/screens/SearchResultsScreen.tsx');
const { useFavoritesStore, favoriteKey } = await import('../src/store/favoritesStore.ts');
// The same StateStorage the persist middleware writes through, so the reload
// assertion below reads the bytes the store really persisted.
const { default: platformStorage } = await import('../src/stores/storage.ts');
const { default: FavoritesScreen } = await import('../src/screens/FavoritesScreen.tsx');
const { default: CardDetailScreen } = await import('../src/screens/CardDetailScreen.tsx');

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

// ── The QA-proven identity, stated once ─────────────────────────────────────
const CARD_NUMBER = 'hBP01-024';
const EXPECTED_PRINTING = 'PARALLEL/HR';
const EXPECTED_KEY = `${CARD_NUMBER}|${EXPECTED_PRINTING}`;
const EXPECTED_ROW_TESTID = `favorite-open-${CARD_NUMBER}-${EXPECTED_PRINTING}`;
const EXPECTED_ART = 'https://card.yuyu-tei.jp/hocg/100_140/hbp07/10234.jpg';
const EXPECTED_PRICE = 3480;
const EXPECTED_LABEL = 'ベスティア・ゼータ(パラレル/HR)';
const HERO_ART = 'https://hololive-official-cardgame.com/wp-content/images/cardlist/hBP07/hBP01-024_HR.png';
// The wrong identity the regression produced. Every assertion that names the HR
// value also rejects these, so none of them can pass vacuously.
const DECOY_PRINTING = 'BASE';
const DECOY_ART = 'https://card.yuyu-tei.jp/hocg/100_140/hbp01/10036.jpg';
const DECOY_PRICE = 120;

const database = await loadDatabaseJson();
const nameMap = await loadSeriesNamesJson();

/** The payload the REAL search route hands CardDetail for this card number. */
const searchHit = searchCards(database, CARD_NUMBER, nameMap)
  .find((c) => c.cardNumber === CARD_NUMBER);

console.log('── DIC-1430 · one CardDetail, one proven exact-print identity ──');

await test('fixture: the real search route still reproduces the QA payload', async () => {
  assert.ok(searchHit, `searchCards still returns ${CARD_NUMBER}`);
  // A card-number-level hit: no exact printing is asserted by the payload.
  assert.equal(searchHit.printing, undefined, 'the search hit carries no exact printing');
  // …yet the art it displays is unambiguously the HR printing's official image.
  assert.equal(searchHit.imageUrl, HERO_ART, 'the hero art is the official HR image');
  const labels = (searchHit.prices || []).map((p) => p?.name || '');
  assert.ok(labels.includes(EXPECTED_LABEL), `the HR listing is present (saw: ${labels.join(' / ')})`);
  const hr = (searchHit.prices || []).find((p) => (p?.name || '') === EXPECTED_LABEL);
  assert.equal(hr.sellPrice, EXPECTED_PRICE, 'the HR listing still costs ¥3,480');
  // The gap that makes every price assertion below mutation-sensitive.
  assert.notEqual(EXPECTED_PRICE, DECOY_PRICE, 'HR and BASE are priced differently');
});

/** Mount CardDetail on `card`, tap 加入收藏, return the favorites the store holds. */
async function favoriteFromDetail(card) {
  useFavoritesStore.setState({ favorites: [], removals: {} });
  const { container, cleanup } = await render(React.createElement(CardDetailScreen, {
    route: { params: { card } },
    navigation: { navigate() {}, goBack() {}, setOptions() {} },
  }));
  try {
    const btn = container.querySelector('[data-testid="card-detail-action-favorite"]');
    assert.ok(btn, 'CardDetail offers the Pen Mst3p 加入收藏 action');
    await act(async () => btn.click());
    await flush(10);
    return { favorites: useFavoritesStore.getState().favorites, html: container.innerHTML };
  } finally { await cleanup(); }
}

/** Tap a favorite row; return the row markup and the CardDetail route payload. */
async function openFavoriteRow(cardNumber, printing) {
  const navs = [];
  const { container, cleanup } = await render(React.createElement(FavoritesScreen, {
    navigation: { navigate: (route, params) => navs.push([route, params]), goBack() {} },
  }));
  try {
    const open = container.querySelector(`[data-testid="favorite-open-${cardNumber}-${printing}"]`);
    assert.ok(open, `the Favorites row renders test id favorite-open-${cardNumber}-${printing}`);
    const html = container.innerHTML;
    const text = container.textContent;
    await act(async () => open.click());
    await flush(10);
    assert.equal(navs.length, 1, 'tapping the row navigates exactly once');
    assert.equal(navs[0][0], 'CardDetail', 'to the real CardDetail route');
    return { html, text, payload: navs[0][1]?.card };
  } finally { await cleanup(); }
}

await test('CardDetail displays the HR artwork for the card-number-level hit', async () => {
  const { container, cleanup } = await render(React.createElement(CardDetailScreen, {
    route: { params: { card: searchHit } },
    navigation: { navigate() {}, goBack() {}, setOptions() {} },
  }));
  try {
    assert.ok(container.innerHTML.includes(HERO_ART), 'the hero renders the official HR art the user sees');
  } finally { await cleanup(); }
});

await test('adding to favorites binds the printing the displayed art proves', async () => {
  const { favorites } = await favoriteFromDetail(searchHit);
  assert.equal(favorites.length, 1, 'exactly one favorite is stored');
  const [fav] = favorites;
  assert.equal(fav.cardNumber, CARD_NUMBER, 'the real card number');
  assert.equal(
    fav.printing, EXPECTED_PRINTING,
    `the favorite must bind the HR printing the hero art proves, not the ${DECOY_PRINTING} price default`,
  );
  assert.notEqual(fav.printing, DECOY_PRINTING, 'never the silent BASE default');
  assert.equal(`${fav.cardNumber}|${fav.printing}`, EXPECTED_KEY, 'the canonical storage key');
});

await test('persistence keeps the exact-print key across a reload', async () => {
  // The store's OWN key function — this is the storage key the requirement names.
  assert.equal(
    favoriteKey(CARD_NUMBER, EXPECTED_PRINTING), EXPECTED_KEY,
    'the canonical entry key is hBP01-024|PARALLEL/HR',
  );
  const raw = platformStorage.getItem('hunterCard-favorites');
  assert.ok(raw, 'the favorites store persisted under its v2 storage name');
  const persisted = JSON.parse(raw);
  assert.equal(persisted.version, 2, 'the v2 persist shape is preserved');
  const entries = persisted.state?.favorites || [];
  assert.equal(entries.length, 1, 'exactly one entry survives the reload');
  assert.equal(entries[0].cardNumber, CARD_NUMBER, 'the reloaded entry keeps the card number');
  assert.equal(entries[0].printing, EXPECTED_PRINTING, 'the reloaded entry keeps the HR printing');
  assert.equal(
    `${entries[0].cardNumber}|${entries[0].printing}`, EXPECTED_KEY,
    'the persisted entry addresses itself by the exact-print key',
  );
  assert.ok(
    !raw.includes(`"printing":"${DECOY_PRINTING}"`),
    'no BASE entry is persisted for this card',
  );
  // The v2 tombstone map must survive untouched — this fix adds no migration.
  assert.ok(persisted.state?.removals !== undefined, 'the v2 removals tombstone map is preserved');
});

let reopened = null;

await test('the Favorites row lists the HR identity, price and artwork', async () => {
  const { html, text, payload } = await openFavoriteRow(CARD_NUMBER, EXPECTED_PRINTING);
  reopened = payload;
  assert.ok(html.includes(EXPECTED_ART), `the row shows the HR listing artwork ${EXPECTED_ART}`);
  assert.ok(!html.includes(DECOY_ART), 'never the BASE sibling artwork');
  assert.ok(text.includes(EXPECTED_PRICE.toLocaleString()), 'the row shows ¥3,480');
  assert.ok(!text.includes(`¥${DECOY_PRICE.toLocaleString()}`), 'never the ¥120 BASE price');
  assert.ok(text.includes(EXPECTED_LABEL), `the row shows the HR label ${EXPECTED_LABEL}`);
});

await test('reopening carries the same exact printing, price and artwork', async () => {
  assert.ok(reopened, 'the row handed CardDetail a payload');
  assert.equal(reopened.cardNumber, CARD_NUMBER, 'the real card number');
  assert.equal(reopened.printing, EXPECTED_PRINTING, 'the same HR printing');
  assert.equal(reopened.yuyuPrice, EXPECTED_PRICE, "the HR printing's own price");
  assert.notEqual(reopened.yuyuPrice, DECOY_PRICE, 'never the BASE price');
  assert.equal(reopened.imageUrl, EXPECTED_ART, "the HR printing's own listing artwork");

  const { container, cleanup } = await render(React.createElement(CardDetailScreen, {
    route: { params: { card: reopened } },
    navigation: { navigate() {}, goBack() {}, setOptions() {} },
  }));
  try {
    assert.ok(
      container.textContent.includes(EXPECTED_PRICE.toLocaleString()),
      'the reopened detail renders ¥3,480',
    );
  } finally { await cleanup(); }
});

await test('the identity holds at the 1440 breakpoint too', async () => {
  setViewport(1440);
  try {
    const { favorites } = await favoriteFromDetail(searchHit);
    assert.equal(favorites[0]?.printing, EXPECTED_PRINTING, 'desktop binds the same HR printing');
    const { html } = await openFavoriteRow(CARD_NUMBER, EXPECTED_PRINTING);
    assert.ok(html.includes(EXPECTED_ART), 'desktop lists the same HR artwork');
  } finally { setViewport(390); }
});

await test('an exact payload that already carries `printing` is stored VERBATIM', async () => {
  // Requirement: never re-derive or normalize an exact payload on write. The
  // cheapest sibling is used deliberately — a fix that re-derived identity from
  // the art would overwrite it with the HR printing and fail here.
  const sibling = {
    ...searchHit,
    printing: 'PARALLEL/HBP07',
    printingLabel: 'ベスティア・ゼータ(パラレル/hBP07)',
    imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/hbp07/10223.jpg',
    yuyuPrice: 50,
  };
  const { favorites } = await favoriteFromDetail(sibling);
  assert.equal(favorites.length, 1, 'exactly one favorite is stored');
  assert.equal(favorites[0].printing, 'PARALLEL/HBP07', 'the caller-supplied printing survives verbatim');
});

console.log(`\n✅ DIC-1430 exact-print favorite identity: ${passed} tests passed`);
