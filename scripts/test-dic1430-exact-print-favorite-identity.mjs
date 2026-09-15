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
// Read-only here: used to state each fail-closed case's PRECONDITION, so a case
// can never pass because the art accidentally matched or the card lost its
// listings — only because the screen refused to act on unproven evidence.
const { buildPriceVersions, resolveVersionForCard, resolveDisplayedPrintingIndex } =
  await import('../src/utils/versionAlignment.ts');

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

// ── Fail closed when the displayed art proves NO single printing ─────────────
//
// CR round 2. Binding the action to the art (above) fixed the case where the
// art DOES prove a printing, but left the opposite case intact: when the art
// proves nothing, the screen fell through to `resolveVersionForCard` — the
// price default — and favorited THAT. For hBP01-024 the price default is the
// ¥120 BASE listing, so every unproven-art route below still persisted exactly
// the `hBP01-024|BASE` key DIC-1430 exists to prevent, sitting next to artwork
// that is not BASE's. The user is given no way to tell.
//
// A printing the source never proved must not be written at all. With no
// provable identity there is nothing to favorite or count, so the actions are
// withheld rather than pointed at a guess — the same fail-closed rule the hero
// art and the exact-printing price already follow.
//
// Each case below states its precondition (≥2 listings, art proves none of
// them, and the price default IS confident) so it can only go green by the
// screen refusing to act — never because the fixture stopped reproducing the
// trap. The confident-default assertion is what pins the regression: it proves
// a fallback WOULD have had something to write.

const FAVORITES_STORAGE_KEY = 'hunterCard-favorites';

/** Absent, or present-but-disabled — either is a refusal to act. */
function assertWithheld(container, testID, why) {
  const el = container.querySelector(`[data-testid="${testID}"]`);
  if (!el) return;
  const disabled = el.getAttribute('disabled') !== null
    || el.getAttribute('aria-disabled') === 'true';
  assert.ok(disabled, `${testID} must be absent or disabled ${why}`);
}

async function assertFailsClosed(card) {
  // Start from a genuinely empty store AND empty persistence, so "nothing was
  // written" below is about THIS render and not about a previous test's state.
  useFavoritesStore.setState({ favorites: [], removals: {} });
  platformStorage.removeItem(FAVORITES_STORAGE_KEY);

  const versions = buildPriceVersions(card);
  assert.ok(versions.length >= 2, 'precondition: the card really has sibling listings to confuse');
  assert.equal(
    resolveDisplayedPrintingIndex(versions, (card.images && card.images[0]) || card.imageUrl || ''),
    -1,
    'precondition: the displayed art proves no single listing',
  );
  const fallback = resolveVersionForCard(versions);
  assert.ok(
    fallback.confident,
    'precondition: the price default is confident — a fallback would have written something',
  );
  assert.equal(
    versions[fallback.index].printing, DECOY_PRINTING,
    `precondition: that something is the ${DECOY_PRINTING} decoy`,
  );

  const { container, cleanup } = await render(React.createElement(CardDetailScreen, {
    route: { params: { card } },
    navigation: { navigate() {}, goBack() {}, setOptions() {} },
  }));
  try {
    assertWithheld(container, 'card-detail-action-favorite', 'while no printing is proven');
    assertWithheld(container, 'card-detail-collection', 'while no printing is proven');

    const favorites = useFavoritesStore.getState().favorites;
    assert.equal(favorites.length, 0, 'the favorites store stays empty');

    const raw = platformStorage.getItem(FAVORITES_STORAGE_KEY);
    if (raw) {
      const entries = JSON.parse(raw).state?.favorites || [];
      assert.equal(
        entries.filter((e) => e?.cardNumber === CARD_NUMBER).length, 0,
        `nothing is persisted for ${CARD_NUMBER}`,
      );
      // The three shapes a guess could take: the decoy sibling, a bare
      // card-number key, and the price default's own key.
      assert.ok(!raw.includes(`${CARD_NUMBER}|${DECOY_PRINTING}`), 'no decoy sibling key');
      assert.ok(!raw.includes(`"printing":"${DECOY_PRINTING}"`), 'no BASE default entry');
      assert.ok(!raw.includes(`"cardNumber":"${CARD_NUMBER}"`), 'no card-number-level entry');
    }
  } finally { await cleanup(); }
}

/** A card-number-level payload (never an exact `printing`) showing `art`. */
function displaying(art, prices) {
  const card = { ...searchHit, images: [], imageUrl: art };
  if (prices) card.prices = prices;
  assert.equal(card.printing, undefined, 'the fixture stays card-number-level');
  return card;
}

const OFFICIAL = 'https://hololive-official-cardgame.com/wp-content/images/cardlist/hBP07';

// The ambiguous case needs art that matches MORE than one listing: `_HR` names
// both the パラレル/HR printing and a signed パラレル/HR/サイン sibling, so the
// token identifies a group, not a printing.
const AMBIGUOUS_PRICES = [
  { name: 'ベスティア・ゼータ', sellPrice: DECOY_PRICE, rarity: '', imageUrl: DECOY_ART },
  { name: EXPECTED_LABEL, sellPrice: EXPECTED_PRICE, rarity: '', imageUrl: EXPECTED_ART },
  {
    name: 'ベスティア・ゼータ(パラレル/HR/サイン)',
    sellPrice: 9800,
    rarity: '',
    imageUrl: 'https://card.yuyu-tei.jp/hocg/100_140/hbp07/10240.jpg',
  },
];

const UNPROVEN_ART = [
  ['the listing published no art at all', displaying('')],
  ['the art carries no variant suffix', displaying(`${OFFICIAL}/hBP01-024.png`)],
  ['the art is a promo `_P` the source never listed', displaying(`${OFFICIAL}/hBP01-024_P.png`)],
  ['the art names a UR the listings do not carry', displaying(`${OFFICIAL}/hBP01-024_UR.png`)],
  ['a query string hides the suffix from the parser', displaying(`${HERO_ART}?t=123`)],
  ['the suffix matches more than one listing', displaying(HERO_ART, AMBIGUOUS_PRICES)],
];

for (const [why, card] of UNPROVEN_ART) {
  await test(`withholds favorite + collection when ${why}`, async () => {
    await assertFailsClosed(card);
  });
}

await test('the proven-art control still acts after every fail-closed case', async () => {
  // Fail-closed must not become "closed": the one case that IS proven still
  // binds its exact printing, so the six cases above cannot pass by disabling
  // the feature outright.
  useFavoritesStore.setState({ favorites: [], removals: {} });
  const { favorites } = await favoriteFromDetail(searchHit);
  assert.equal(favorites.length, 1, 'the proven HR identity is still favoritable');
  assert.equal(favorites[0].printing, EXPECTED_PRINTING, 'and still binds PARALLEL/HR');
});

console.log(`\n✅ DIC-1430 exact-print favorite identity: ${passed} tests passed`);
