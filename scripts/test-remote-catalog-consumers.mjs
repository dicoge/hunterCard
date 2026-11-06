#!/usr/bin/env node
/**
 * Remote native catalog — consumers in the same client (2026-11-06).
 *
 * Starts from the REAL bundled catalog (src/utils/staticData.ts →
 * public/data/database.json), injects an in-memory platform through the
 * __setCatalogPlatformForTest seam (the origin stays PRODUCTION_ORIGIN — routes
 * below only answer the real URLs), publishes a SYNTHETIC next dataset with the
 * real publisher (one new supported card in one new series), and checks that,
 * without remounting or restarting:
 *   - an already-mounted Home shows the new series;
 *   - an already-mounted SearchResults finds the new card while the player's
 *     unsubmitted draft text is kept;
 *   - deck catalog, canonical exact-printing index and recognition caches move
 *     to the new revision together, and an existing card keeps its exact printing;
 *   - a later dataset that DROPS a card the player owns leaves collection and
 *     favorites untouched (no deletion, no silent rewrite).
 *
 * Synthetic data lives only in this process. This is not Android acceptance.
 *
 * Run: node --import ./scripts/register-web-render.mjs scripts/test-remote-catalog-consumers.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = TestResizeObserver;
dom.window.ResizeObserver = TestResizeObserver;

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

const staticData = await import('../src/utils/staticData.ts');
const { PRODUCTION_ORIGIN } = await import('../src/config/apiOrigin.ts');
const { buildNativeCatalogRelease } = await import('./lib/native-catalog-publish.mjs');
const homeModule = await import('../src/screens/HomeScreen.tsx');
const searchModule = await import('../src/screens/SearchResultsScreen.tsx');
const { loadCardDatabase } = await import('../src/utils/deckCardData.ts');
const { loadCanonicalCardIndex } = await import('../src/utils/canonicalCardRecord.ts');
const { loadAllCards } = await import('../src/services/cardRecognition.ts');
const { useDeckStore } = await import('../src/store/deckStore.ts');
const { useFavoritesStore } = await import('../src/store/favoritesStore.ts');

const MANIFEST_URL = `${PRODUCTION_ORIGIN}/data/catalog/manifest.json`;

async function flush(times = 3) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}
async function render(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  await flush();
  return { container, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

// ── in-memory platform (no disk, no network) ─────────────────────────────────
const files = new Map();
const fakeFs = {
  async readText(p) { return files.has(p) ? files.get(p) : null; },
  async writeText(p, t) { files.set(p, t); },
  async move(from, to) {
    for (const k of [...files.keys()]) {
      if (k === from || k.startsWith(`${from}/`)) { files.set(to + k.slice(from.length), files.get(k)); files.delete(k); }
    }
  },
  async remove(p) { for (const k of [...files.keys()]) if (k === p || k.startsWith(`${p}/`)) files.delete(k); },
  async ensureDir() {},
  async list(p) {
    const names = new Set();
    for (const k of files.keys()) if (k.startsWith(`${p}/`)) names.add(k.slice(p.length + 1).split('/')[0]);
    return [...names];
  },
  async freeBytes() { return 10 ** 12; },
};
const routes = new Map();
const fakeFetch = async (url) => {
  const body = routes.get(url);
  if (body == null) return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
  return { ok: true, status: 200, url, headers: { get: (n) => (n.toLowerCase() === 'content-type' ? 'application/json' : null) }, text: async () => body };
};
const platform = {
  fs: fakeFs,
  fetch: fakeFetch,
  sha256: async (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex'),
};
function publish(db, names, when) {
  const release = buildNativeCatalogRelease({ canonical: db, seriesNames: names, now: new Date(when) });
  routes.clear();
  routes.set(MANIFEST_URL, JSON.stringify(release.manifest));
  for (const a of release.assets) routes.set(`${PRODUCTION_ORIGIN}/${a.rel}`, a.text);
  return release.manifest;
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('── remote native catalog: consumers refresh in the same client ──');

staticData.__setCatalogPlatformForTest(platform);
const bundledDb = await staticData.loadDatabaseJson();
const bundledNames = await staticData.loadSeriesNamesJson();
assert.equal(staticData.getCatalogRevision(), 'bundled');
assert.equal(Object.keys(bundledDb.cards).length, 3973, 'starts from the full bundled catalog');

// Synthetic next dataset: one new supported card in one new series.
const NEW_ID = 'hBP99-001_hBP99';
const NEW_NAME = 'シンセティック・テスト';
const nextDb = structuredClone(bundledDb);
nextDb.lastUpdated = '2026-11-06T00:00:00.000Z';
const template = Object.values(nextDb.cards).find((c) => c.series === 'hBP01' && Array.isArray(c.prices) && c.prices.length > 0);
const newCard = structuredClone(template);
Object.assign(newCard, { id: NEW_ID, cardNumber: 'hBP99-001', series: 'hBP99', sourceProduct: 'hBP99', name: NEW_NAME, nameZh: NEW_NAME });
delete newCard.skillsJp;
delete newCard.skillsZh;
nextDb.cards[NEW_ID] = newCard;
nextDb.totalCards = Object.keys(nextDb.cards).length;
const nextNames = { ...bundledNames, hBP99: 'シンセティックパック' };

// A card number with an exact printing resolved before and after the refresh.
const indexBefore = await loadCanonicalCardIndex();
const existing = template.cardNumber;
const existingBefore = indexBefore.resolve(existing, 'BASE');

const deckBefore = await loadCardDatabase();
const recogBefore = await loadAllCards();
assert.ok(!deckBefore.cards.some((c) => c.cardNumber === 'hBP99-001'));
assert.ok(!recogBefore.some((c) => c.id === NEW_ID));
assert.equal(indexBefore.resolve('hBP99-001', 'BASE').status, 'unresolved');

// Owned data that a later dataset will drop.
const DROPPED_ID = Object.keys(bundledDb.cards).find((k) => k !== template.id && bundledDb.cards[k].series === 'hSD01');
const DROPPED_NUMBER = bundledDb.cards[DROPPED_ID].cardNumber;
useDeckStore.setState({ collection: { [`${DROPPED_NUMBER}|BASE`]: 2, [`${existing}|BASE`]: 1 } });
useFavoritesStore.setState({ favorites: [{ cardNumber: DROPPED_NUMBER, printing: 'BASE', addedAt: '2026-11-01T00:00:00.000Z' }] });
const collectionBefore = structuredClone(useDeckStore.getState().collection);
const favoritesBefore = structuredClone(useFavoritesStore.getState().favorites);

homeModule.__seedHomeSeriesCacheForTest(null);
const home = await render(React.createElement(homeModule.default, { navigation: { navigate() {}, openDrawer() {} } }));
searchModule.__seedSearchResultsCacheForTest(null, null);
const search = await render(React.createElement(searchModule.default, {
  route: { params: { query: 'hBP99-001' } },
  navigation: { navigate() {}, goBack() {} },
}));

await test('before the refresh the new series and card are absent from mounted screens', async () => {
  assert.equal(home.container.querySelector('[data-testid="home-booster-hBP99"]'), null);
  assert.ok(home.container.querySelector('[data-testid="home-booster-hBP01"]'), 'home rendered the bundled series');
  assert.ok(!search.container.textContent.includes(NEW_NAME));
});

// The player types an unsubmitted draft in the mounted search field.
const input = search.container.querySelector('[data-testid="search-results-input"]');
assert.ok(input, 'search input rendered');
await act(async () => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'hBP99 my draft');
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
});

const manifest1 = publish(nextDb, nextNames, '2026-11-06T08:00:00.000Z');
let result;
await act(async () => { result = await staticData.refreshCatalog({ force: true }); });
await flush(6);

await test('refresh commits the new revision (one coherent database + series names)', async () => {
  assert.equal(result.status, 'updated', JSON.stringify(result));
  assert.equal(staticData.getCatalogRevision(), manifest1.revision);
  const snap = await staticData.loadCatalogSnapshot();
  assert.ok(snap.database.cards[NEW_ID]);
  assert.equal(snap.seriesNames.hBP99, 'シンセティックパック');
  assert.equal(snap.dataObservedAt, '2026-11-06T00:00:00.000Z');
  assert.equal(staticData.getCatalogStatus().publishedAt, '2026-11-06T08:00:00.000Z');
});

await test('the already-mounted Home shows the new series without remounting', async () => {
  assert.ok(home.container.querySelector('[data-testid="home-booster-hBP99"]'), 'new series tile rendered');
});

await test('the already-mounted SearchResults finds the new card and keeps the unsubmitted draft', async () => {
  assert.ok(search.container.textContent.includes(NEW_NAME), 'new card listed for the active query');
  assert.equal(search.container.querySelector('[data-testid="search-results-input"]').value, 'hBP99 my draft');
});

await test('deck, canonical and recognition caches all moved to the new revision', async () => {
  const deckAfter = await loadCardDatabase();
  assert.notEqual(deckAfter, deckBefore, 'deck catalog re-derived');
  assert.ok(deckAfter.cards.some((c) => c.cardNumber === 'hBP99-001'));
  const recogAfter = await loadAllCards();
  assert.ok(recogAfter.some((c) => c.id === NEW_ID));
  const indexAfter = await loadCanonicalCardIndex();
  assert.notEqual(indexAfter, indexBefore, 'exact-printing index re-derived');
  assert.notEqual(indexAfter.resolve('hBP99-001', 'BASE').reason, 'unknown-card-number');
});

await test('an existing card keeps the same exact printing across the refresh', async () => {
  const after = (await loadCanonicalCardIndex()).resolve(existing, 'BASE');
  assert.equal(after.status, existingBefore.status);
  if (after.status === 'ok') {
    assert.equal(after.card.printing, existingBefore.card.printing);
    assert.equal(after.card.imageUrl, existingBefore.card.imageUrl);
    assert.equal(after.card.sellPrice, existingBefore.card.sellPrice);
  }
});

// A later dataset drops a card the player owns.
const laterDb = structuredClone(nextDb);
laterDb.lastUpdated = '2026-11-07T00:00:00.000Z';
delete laterDb.cards[DROPPED_ID];
for (const [k, c] of Object.entries(laterDb.cards)) if (c.cardNumber === DROPPED_NUMBER) delete laterDb.cards[k];
laterDb.totalCards = Object.keys(laterDb.cards).length;
publish(laterDb, nextNames, '2026-11-07T08:00:00.000Z');
await act(async () => { result = await staticData.refreshCatalog({ force: true }); });
await flush(4);

await test('a dataset that drops an owned card never deletes or rewrites collection / favorites', async () => {
  assert.equal(result.status, 'updated', JSON.stringify(result));
  const deck = await loadCardDatabase();
  assert.ok(!deck.cards.some((c) => c.cardNumber === DROPPED_NUMBER), 'card is gone from the catalog');
  assert.deepEqual(useDeckStore.getState().collection, collectionBefore, 'collection untouched');
  assert.deepEqual(useFavoritesStore.getState().favorites, favoritesBefore, 'favorites untouched');
});

await home.cleanup();
await search.cleanup();
staticData.__setCatalogPlatformForTest(null);
assert.equal(staticData.getCatalogRevision(), 'bundled', 'default (no platform) restored');

console.log(`\n✅ remote catalog consumers: ${passed} checks passed`);
