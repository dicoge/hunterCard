#!/usr/bin/env node
// v2026-10-19 deck list → editor → back flow (render). Harness copied from test-deck-editor-copy.mjs.
/**
 * DIC-1064 — the deck editor explains nothing. It shows the cards, what the
 * player owns, the exact printing each slot settled on, and what the rest costs.
 *
 * The default-printing MACHINERY is unchanged: a tournament slot whose printing
 * the source never proved still adopts the same card number's lowest ordinary
 * printing, still prices off that printing's yuyu-tei sell price, and existing
 * UNRESOLVED decks are still migrated in place. What was removed is the running
 * commentary about it — the origin banner's count-specific notes, the per-row
 * "（來源未指定版本…）" suffix, the finalize hint and the buy-price footnotes.
 *
 * Absence is a weak assertion on its own: a screen that failed to render passes
 * it trivially. So every case below first pins ANCHORS — the deck name, a real
 * card number, the exact ordinary printing that slot selected, and the exact
 * shortage subtotal — proving the editor rendered the fully-defaulted deck, and
 * only then proves none of the forbidden wording reached the DOM.
 *
 * Covered states: a fresh tournament import, an existing DIC-1033 UNRESOLVED
 * deck migrated in place, that deck after a persist/rehydrate reload, each at
 * desktop and mobile width.
 *
 * The subtotal anchor is rendered from FROZEN listings
 * (scripts/fixtures/frozen-card-prices.json), not from the live scraped
 * `public/data/database.json` (DIC-1127). The anchor's job is to prove the editor
 * really rendered a priced deck — but yuyu-tei prices are market data, so pinning
 * today's total made this suite fail whenever the nightly scrape moved a price,
 * with nothing in the app changed. The rendered TOTAL is now anchored on frozen
 * data, while the live dataset is still checked for the property that matters
 * here: it renders a real, non-zero total (§6).
 *
 * Run: npm run test:deck-editor-copy
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

// DIC-1380: `src/config/releaseFlags.ts` now fails closed on unset — the
// deck-editor render this suite exercises depends on FEATURES.marketData
// (the gap-subtotal-JPY / deck-gap-totals surface anchored below) and
// FEATURES.watchlist, so this test must run in the Web Develop / Staging
// profile just like local `expo start --web`. Pinning the env before any
// dynamic import of releaseFlags keeps the resolver deterministic and the
// child leg (DECK_EDITOR_LIVE_DB=1) inherits it through `...process.env`.
process.env.EXPO_PUBLIC_STORE_MVP = '0';

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
// jsdom ships no ResizeObserver; react-native-web's onLayout only reports element
// sizes, which nothing asserted here depends on.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = NoopResizeObserver;
dom.window.ResizeObserver = NoopResizeObserver;

const liveDb = JSON.parse(fs.readFileSync('public/data/database.json', 'utf8'));
const august = JSON.parse(fs.readFileSync('data/tournaments/2026-08.json', 'utf8'));

const { frozenDatabase } = await import('./lib/frozen-price-fixture.mjs');
// The real shipped catalog, with only the listings of the cards under test pinned
// to the frozen snapshot.
const frozenDb = frozenDatabase(liveDb);

/**
 * The screen loads its catalog through `loadCardDatabase()`, which memoizes the
 * parsed database in a module-level `cache` — correct in production (one fetch
 * per session) but it means ONE process can only ever observe ONE dataset: the
 * first render wins the cache and every later render reuses it, whatever a
 * re-pointed fetch stub returns.
 *
 * So the frozen leg and the live leg cannot share a process. Swapping the served
 * database mid-suite silently re-verified the frozen data twice while the live
 * assertions never ran at all — a test that could not fail. Each leg therefore
 * gets its own process with a fresh module registry: this file re-executes
 * itself with DECK_EDITOR_LIVE_DB=1 for the live leg (see the bottom of the
 * file). Production code stays untouched — no test-only cache reset, and the
 * render path is the real one.
 */
const LIVE_MODE = process.env.DECK_EDITOR_LIVE_DB === '1';

// The screen loads its catalog through src/utils/staticData, which on native —
// and in Node, which resolves that same base variant — returns the committed
// public/data/database.json inlined into the bundle rather than fetched
// (DIC-1287). The frozen leg pins its dataset by re-pointing that shared JSON
// module before the first render; it used to re-point a fetch stub. The live leg
// leaves the shipped bytes alone.
const bundledDb = (await import('../public/data/database.json')).default;
if (!LIVE_MODE) bundledDb.cards = frozenDb.cards;

// Nothing in this render may reach the network: a relative fetch is exactly the
// DIC-1287 defect that emptied the packaged Android picker.
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : String(input?.url ?? input);
  assert.fail(`the deck editor must not fetch during render: ${url}`);
};

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const DeckEditorScreen = (await import('../src/screens/DeckEditorScreen.tsx')).default;
const { adaptDatabase } = await import('../src/utils/deckCardData.ts');
const {
  UNRESOLVED_PRINTING,
  buildCatalogIndex,
  buildImportedDeck,
} = await import('../src/utils/tournamentDeckImport.ts');
const { buildLowCostIndex, groupVariantsByCardNumber } = await import('../src/utils/deckVariants.ts');
const { useDeckStore } = await import('../src/store/deckStore.ts');
const platformStorage = (await import('../src/stores/storage.ts')).default;

/**
 * Every phrase the deck editor and its shortage list must no longer say. Pinned
 * as literals rather than imported from the app so deleting a constant cannot
 * quietly empty this list — a re-added banner is caught by its words, wherever
 * they come from.
 */
const FORBIDDEN_COPY = [
  '來源未指定版本',
  '已使用最低普通版本估價',
  '來源只註明卡號與稀有度',
  '未指明可購買的版本',
  '沒有可用的普通版本',
  '編輯中不中斷提示',
  '才會檢查完整規則',
  '不使用「店家收購價」估算缺卡成本',
  '收購價僅於卡片行情頁顯示',
  '不採用店家收購價',
  '單價採 yuyu-tei',
];

const FORBIDDEN_TESTIDS = ['deck-defaulted-printings-note', 'deck-unresolved-printings-note'];

const DESKTOP = { width: 1280, height: 900 };
const MOBILE = { width: 390, height: 844 };

const STORE_KEY = 'hunterCard-decks';
const IMPORTED_AT = '2026-08-17T00:00:00.000Z';

/** The slot DIC-1060 reported: its ordinary printing and the deck's exact total
 * at the FROZEN prices this suite renders. */
const ANCHOR_CARD_NUMBER = 'hBP07-006';
const ANCHOR_PRINTING = 'BASE';
const ANCHOR_SUBTOTAL = '12660';

/** The live leg is the one case that must observe the live scraped dataset; every
 * other case pins exact frozen totals. A process runs exactly one of the two, so
 * neither can be silently served the other's data. */
const isLiveCase = (name) => name.includes('live scraped dataset');
const FROZEN_CASES = 5;
const LIVE_CASES = 1;

let passed = 0;
async function test(name, fn) {
  if (LIVE_MODE !== isLiveCase(name)) return;
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ── Real shipped artefacts, imported by the real importer ────────────────────
const db = adaptDatabase(Object.values(frozenDb.cards || {}));
const catalog = buildCatalogIndex(db.cards);
const lowCostIndex = buildLowCostIndex(groupVariantsByCardNumber(db.cards, db.priceRecords));
const event = august.events[0];
const sourceDeck = event.decks.find((d) => d.decklogCode === 'DUKHN');
assert.ok(sourceDeck, 'the real August DUKHN deck must be present in the shipped report');

const importDraft = () =>
  buildImportedDeck(event, sourceDeck, catalog, db.priceRecords, [], IMPORTED_AT);

function freshlyImportedDeck() {
  const draft = importDraft();
  assert.ok(draft.defaultedPrintings > 0, 'precondition: the import defaults printings');
  return {
    id: 'fresh-import',
    name: draft.name,
    oshi: draft.oshi,
    main: draft.main,
    yell: draft.yell,
    origin: draft.origin,
    updatedAt: IMPORTED_AT,
  };
}

/** A deck as DIC-1033 persisted it: every printing on the UNRESOLVED sentinel. */
function legacyUnresolvedDeck() {
  const draft = importDraft();
  const rewrite = (slots) => slots.map((s) => ({
    qty: s.qty,
    card: {
      ...s.card,
      id: `${s.card.cardNumber}#${UNRESOLVED_PRINTING}`,
      printing: UNRESOLVED_PRINTING,
      printingLabel: '',
      unresolvedPrinting: true,
      defaultedPrinting: undefined,
    },
  }));
  return {
    id: 'legacy-deck',
    name: draft.name,
    oshi: rewrite(draft.oshi),
    main: rewrite(draft.main),
    yell: rewrite(draft.yell),
    origin: draft.origin,
    updatedAt: IMPORTED_AT,
  };
}

// ── Render harness ───────────────────────────────────────────────────────────
/** react-native-web's Dimensions reads documentElement.clientWidth (jsdom has no
 *  visualViewport and no layout, so it otherwise reports 0 and every render
 *  would silently be the mobile one). */
function setViewport({ width, height }) {
  const docEl = dom.window.document.documentElement;
  Object.defineProperty(docEl, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(docEl, 'clientHeight', { value: height, configurable: true });
  dom.window.dispatchEvent(new dom.window.Event('resize'));
}

/** Desktop keeps the filter, picker and deck columns together. At <=480px only
 * one major panel is mounted and the five-way switch owns navigation (DIC-1086). */
function layoutOf(container) {
  const picker = container.querySelector('[data-testid="card-picker-grid"]');
  const deck = container.querySelector('[data-testid="deck-origin-banner"]');
  const inlineFilters = container.querySelector('[data-testid="card-filter-panel"]');
  const filterButton = container.querySelector('[data-testid="open-filters"]');
  const mobileSwitch = container.querySelector('[data-testid="deck-mobile-panel-switch"]');
  if (picker && deck && inlineFilters && !filterButton && !mobileSwitch) {
    const filtersComeFirst =
      (inlineFilters.compareDocumentPosition(deck) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    assert.ok(filtersComeFirst, 'desktop must render the filter column before the deck column');
    return 'desktop';
  }
  assert.ok(mobileSwitch, 'phone must render the five-panel switch');
  assert.ok(picker && !deck, 'phone must mount only the initial picker panel');
  assert.ok(filterButton && !inlineFilters, 'phone picker must hide filters behind 搜尋 / 篩選');
  return 'mobile';
}

async function renderDeckEditor() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(DeckEditorScreen));
  });
  const cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { container, cleanup };
}


const byTestId = (container, testID) => container.querySelector(`[data-testid="${testID}"]`);
let passed2 = 0;
async function flow(label, fn) {
  try { await fn(); passed2 += 1; console.log(`  ✓ ${label}`); }
  catch (err) { process.exitCode = 1; console.error(`  ✗ ${label} — ${err.message}`); }
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 60)); });
const isLibrary = (c) => !!byTestId(c, 'deck-library-grid');
const isEditor = (c) => !!byTestId(c, 'deck-mobile-appbar') || !!byTestId(c, 'card-picker-grid');

await flow('empty 牌組 shows the deck list with the create form — NO deck is created behind the player (no phantom deck)', async () => {
  useDeckStore.setState({ decks: [], activeDeckId: null, collection: {} });
  setViewport(MOBILE);
  const { container, cleanup } = await renderDeckEditor();
  try {
    for (let i = 0; i < 20; i += 1) await settle();          // the card catalog finished loading
    assert.equal(useDeckStore.getState().decks.length, 0, 'no deck was created');
    assert.ok(isLibrary(container), 'the deck list is shown');
    assert.ok(!isEditor(container), 'not the editor');
  } finally { await cleanup(); }
});

await flow('create → editor opens; app-bar ‹ returns to the deck LIST (not out of 牌組); the deck and its name are kept', async () => {
  useDeckStore.setState({ decks: [], activeDeckId: null, collection: {} });
  setViewport(MOBILE);
  const { container, cleanup } = await renderDeckEditor();
  try {
    await act(async () => { useDeckStore.getState().createDeck('我的測試牌組'); });
    await settle();
    assert.ok(isEditor(container), 'the new deck opens in the editor');
    const back = byTestId(container, 'deck-mobile-appbar-back');
    assert.ok(back, 'app-bar back exists');
    await act(async () => back.click());
    await settle();
    assert.equal(useDeckStore.getState().activeDeckId, null);
    assert.ok(isLibrary(container), 'back lands on the deck list');
    assert.equal(useDeckStore.getState().decks.length, 1, 'the deck is kept');
    assert.equal(useDeckStore.getState().decks[0].name, '我的測試牌組');
    assert.ok(container.textContent.includes('我的測試牌組'), 'listed by name');
  } finally { await cleanup(); }
});

await flow('reload (rehydrate) reopens 牌組 on the deck list, with every deck kept', async () => {
  const raw = platformStorage.getItem(STORE_KEY);
  assert.ok(raw);
  assert.equal(JSON.parse(raw).state.activeDeckId, undefined, 'the open deck is not persisted');
  useDeckStore.setState({ decks: [], activeDeckId: 'stale', collection: {} });
  platformStorage.setItem(STORE_KEY, raw);
  await useDeckStore.persist.rehydrate();
  // rehydrate merges persisted state; the session's open deck is not restored from storage
  useDeckStore.setState({ activeDeckId: null });
  setViewport(MOBILE);
  const { container, cleanup } = await renderDeckEditor();
  try {
    await settle();
    assert.ok(isLibrary(container));
    assert.equal(useDeckStore.getState().decks.length, 1);
  } finally { await cleanup(); }
});

await flow('a v3 store that still carries an open deck migrates to v4 without it (decks kept)', async () => {
  const deck = useDeckStore.getState().decks[0];
  platformStorage.setItem(STORE_KEY, JSON.stringify({ state: { decks: [deck], activeDeckId: deck.id, collection: {} }, version: 3 }));
  useDeckStore.setState({ decks: [], activeDeckId: null, collection: {} });
  await useDeckStore.persist.rehydrate();
  assert.equal(useDeckStore.getState().activeDeckId, null, 'old persisted open deck dropped');
  assert.equal(useDeckStore.getState().decks.length, 1, 'decks kept');
});

if ((process.exitCode ?? 0) === 0) console.log(`\n✅ deck-list-flow: ${passed2} checks passed`);
else console.error('\n❌ deck-list-flow failed');
process.exit();
