#!/usr/bin/env node
/**
 * DIC-1287 regression: the Android/native deck editor must render its card
 * picker grid.
 *
 * The bug: `loadCardDatabase()` fetched the catalog by ROOT-RELATIVE URL —
 * `fetch('/data/database.json')`. Web resolves that same-origin, but React
 * Native has no page origin, so the request rejects before it reaches the
 * network. DeckEditorScreen catches the rejection (`.catch(() => setDb(null))`),
 * so the release APK rendered the 選擇卡片 header, the 搜尋 / 篩選 button and a
 * card count — of ZERO — with an empty grid underneath. This is the same defect
 * DIC-972 fixed for the guest home; the deck editor's own loader was never moved
 * onto the shared `staticData` split.
 *
 * The fix: `loadCardDatabase()` reads through `src/utils/staticData` — native
 * gets the pre-sanitized `public/data/database.json` it already ships in its
 * bundle, web keeps the same-origin fetch.
 *
 * This test is trustworthy because it reproduces the APK, not a paraphrase:
 *   - it runs under the module hooks WITHOUT a `.web.*` override, so `./staticData`
 *     resolves to `staticData.ts` — the exact variant Metro hands Android;
 *   - `globalThis.fetch` behaves like React Native's, rejecting every relative
 *     URL, and the test asserts the render performed NO fetch at all;
 *   - it renders the real DeckEditorScreen at a 390px phone viewport and asserts
 *     the two cards the DIC-1287 report circles — hBP01-001 and hBP01-002 —
 *     mount as grid cells and can be added to the open deck.
 *
 * Before the fix the loader leg throws `Network request failed` and the screen
 * renders 0 cards; after it, the grid mounts from the bundled catalog.
 *
 * Run: npm run test:native-deck-editor-grid
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

// The two cards the DIC-1287 screenshot circles, at the top of the default
// 推しホロメン picker the editor opens on.
const CIRCLED = ['hBP01-001', 'hBP01-002'];

// ── The DOM must exist before react-native-web is imported: its StyleSheet
//    installs a real style element at module-evaluation time. ────────────────
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://holohunter.dicoge.com/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key in globalThis) continue;
  try {
    globalThis[key] = dom.window[key];
  } catch {
    // read-only globals (e.g. `location`) are already usable via `window`
  }
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = NoopResizeObserver;
dom.window.ResizeObserver = NoopResizeObserver;

// ── React Native's fetch, faithfully ─────────────────────────────────────────
// A packaged app has no page origin: RN's networking layer cannot build a URI
// from '/data/database.json' and the promise rejects. Every call is recorded so
// the render can be held to using no network at all.
const fetchCalls = [];
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : String(input?.url ?? input);
  fetchCalls.push(url);
  throw new TypeError(`Network request failed (native has no origin for ${url})`);
};

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const DeckEditorScreen = (await import('../src/screens/DeckEditorScreen.tsx')).default;
const { CardPickerGrid } = await import('../src/components/CardPicker.tsx');
const { loadCardDatabase } = await import('../src/utils/deckCardData.ts');
const { useDeckStore } = await import('../src/store/deckStore.ts');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ── 1. The native loader returns the shipped catalog, over no network ────────
await test('the native card-database loader resolves without a page origin', async () => {
  const db = await loadCardDatabase();
  assert.ok(db && Array.isArray(db.cards), 'loadCardDatabase() must return an adapted database');
  assert.ok(db.cards.length > 0, 'the native loader must return a non-empty catalog');
  assert.ok(db.facets.size > 0, 'the native loader must return the picker facet index');
  for (const cardNumber of CIRCLED) {
    assert.ok(
      db.cards.some((card) => card.cardNumber === cardNumber),
      `${cardNumber} must be in the catalog the native loader returns`,
    );
  }
  assert.deepEqual(fetchCalls, [], `the native catalog load must not fetch, called: ${fetchCalls.join(', ')}`);
});

// ── Render harness ───────────────────────────────────────────────────────────
/** react-native-web's Dimensions reads documentElement.clientWidth (jsdom has no
 *  layout, so it otherwise reports 0 and every render would be the desktop one). */
function setViewport({ width, height }) {
  const docEl = dom.window.document.documentElement;
  Object.defineProperty(docEl, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(docEl, 'clientHeight', { value: height, configurable: true });
  dom.window.dispatchEvent(new dom.window.Event('resize'));
}

const byTestId = (container, testID) => container.querySelector(`[data-testid="${testID}"]`);

async function render(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function openEmptyDeck() {
  useDeckStore.setState({
    decks: [{
      id: 'dic1287-regression',
      name: 'DIC-1287',
      oshi: [],
      main: [],
      yell: [],
      updatedAt: '2026-09-02T00:00:00.000Z',
    }],
    activeDeckId: 'dic1287-regression',
    collection: {},
  });
}

// A Pixel-class phone: DeckEditorScreen treats <=480px as the phone layout, the
// one the APK report is about.
const PHONE = { width: 390, height: 844 };

// ── 2. The phone picker mounts real card cells ───────────────────────────────
await test('the phone deck editor renders the two-column card picker grid', async () => {
  openEmptyDeck();
  setViewport(PHONE);
  const { container, cleanup } = await render(React.createElement(DeckEditorScreen));
  try {
    assert.ok(byTestId(container, 'deck-mobile-panel-switch'), 'the phone layout must be the one under test');
    assert.ok(byTestId(container, 'card-picker-grid'), 'the card picker grid must mount');

    const count = byTestId(container, 'card-result-count-mobile');
    assert.ok(count, 'the phone picker must render its card count');
    const counted = Number((count.textContent.match(/\d[\d,]*/) ?? [])[0]?.replace(/,/g, ''));
    assert.ok(
      Number.isFinite(counted) && counted > 0,
      `the picker must offer cards, the count read "${count.textContent}"`,
    );

    const cells = container.querySelectorAll('[data-testid^="card-cell-"]');
    assert.ok(
      cells.length > 1,
      `the grid must mount card cells, not just its container (mounted ${cells.length})`,
    );
    assert.ok(
      cells.length <= counted,
      'the grid pages in — it must never mount more cells than the result count',
    );

    const db = await loadCardDatabase();
    for (const cardNumber of CIRCLED) {
      const cell = byTestId(container, `card-cell-${cardNumber}`);
      assert.ok(cell, `${cardNumber} must render as a grid cell`);
      const name = db.cards.find((card) => card.cardNumber === cardNumber)?.name;
      assert.ok(name, `${cardNumber} must carry a name`);
      assert.ok(cell.textContent.includes(name), `the ${cardNumber} cell must show its name "${name}"`);
      assert.ok(
        container.textContent.includes(cardNumber),
        `the ${cardNumber} cell must show its card number`,
      );
    }

    assert.deepEqual(fetchCalls, [], `the phone render must not fetch, called: ${fetchCalls.join(', ')}`);
  } finally {
    await cleanup();
  }
});

// ── 3. A rendered card is addable ────────────────────────────────────────────
await test('a card in the grid can be added to the open deck', async () => {
  openEmptyDeck();
  setViewport(PHONE);
  const { container, cleanup } = await render(React.createElement(DeckEditorScreen));
  try {
    const [cardNumber] = CIRCLED;
    await act(async () => byTestId(container, `card-cell-${cardNumber}`).click());

    const deck = useDeckStore.getState().decks[0];
    const added = ['oshi', 'main', 'yell']
      .flatMap((zone) => deck[zone])
      .find((slot) => slot.card.cardNumber === cardNumber);
    assert.ok(added, `tapping the ${cardNumber} cell must put it in the deck`);
    assert.ok(added.qty > 0, `${cardNumber} must be held with a real quantity`);

    const badge = byTestId(container, `card-qty-${cardNumber}`);
    assert.ok(badge, `the ${cardNumber} cell must show its quantity badge once held`);
    assert.equal(badge.textContent, String(added.qty), 'the badge must show the held quantity');
  } finally {
    await cleanup();
  }
});

// ── 4. Empty state ───────────────────────────────────────────────────────────
await test('an empty result set renders the empty label and no cells', async () => {
  const EMPTY_LABEL = '沒有符合的卡片';
  const { container, cleanup } = await render(React.createElement(CardPickerGrid, {
    groups: [],
    numColumns: 2,
    height: 460,
    qtyOf: () => 0,
    onAdd: () => assert.fail('an empty grid can add nothing'),
    emptyLabel: EMPTY_LABEL,
  }));
  try {
    assert.ok(byTestId(container, 'card-picker-grid'), 'the grid container must still mount when empty');
    assert.equal(
      container.querySelectorAll('[data-testid^="card-cell-"]').length,
      0,
      'an empty result set must mount no card cells',
    );
    assert.ok(container.textContent.includes(EMPTY_LABEL), 'the empty label must be shown');
  } finally {
    await cleanup();
  }
});

// ── 5. The relative fetch must not come back ─────────────────────────────────
await test('the deck-editor catalog loader keeps off the relative /data URL', async () => {
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const source = stripComments(fs.readFileSync('src/utils/deckCardData.ts', 'utf8'));
  assert.doesNotMatch(
    source,
    /fetch\(\s*['"`]\/data\//,
    "deckCardData.ts must load via staticData, not a relative fetch('/data/...') that fails on native",
  );
  assert.match(
    source,
    /from '\.\/staticData'/,
    'deckCardData.ts must read through the platform-split staticData loader',
  );
});

console.log(`\nDIC-1287 native deck-editor card grid: ${passed} tests passed`);
