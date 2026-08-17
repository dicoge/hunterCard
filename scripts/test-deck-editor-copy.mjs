#!/usr/bin/env node
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
 * Run: npm run test:deck-editor-copy
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

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

const rawDb = JSON.parse(fs.readFileSync('public/data/database.json', 'utf8'));
const august = JSON.parse(fs.readFileSync('data/tournaments/2026-08.json', 'utf8'));

// The screen loads its catalog over fetch(); serve the shipped file instead of
// the network so the render path itself is unchanged.
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : String(input?.url ?? input);
  assert.equal(url, '/data/database.json', `unexpected fetch during render: ${url}`);
  return { ok: true, json: async () => rawDb };
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

/** The slot DIC-1060 reported: its ordinary printing and the deck's exact total. */
const ANCHOR_CARD_NUMBER = 'hBP07-006';
const ANCHOR_PRINTING = 'BASE';
const ANCHOR_SUBTOTAL = '13220';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ── Real shipped artefacts, imported by the real importer ────────────────────
const db = adaptDatabase(Object.values(rawDb.cards || {}));
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

/** Desktop puts the filter column inline, before the deck column; mobile moves it
 *  behind a 搜尋 / 篩選 button and stacks the picker first (DIC-1067). Asserted so
 *  a viewport that stopped taking effect cannot turn the two layout cases into
 *  the same render. */
function layoutOf(container) {
  const picker = container.querySelector('[data-testid="card-picker-grid"]');
  const deck = container.querySelector('[data-testid="deck-origin-banner"]');
  assert.ok(picker && deck, 'both the card picker and the deck column must render');
  const inlineFilters = container.querySelector('[data-testid="card-filter-panel"]');
  const filterButton = container.querySelector('[data-testid="open-filters"]');
  if (inlineFilters && !filterButton) {
    const filtersComeFirst =
      (inlineFilters.compareDocumentPosition(deck) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    assert.ok(filtersComeFirst, 'desktop must render the filter column before the deck column');
    return 'desktop';
  }
  assert.ok(filterButton && !inlineFilters, 'mobile must hide the filters behind 搜尋 / 篩選');
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

/**
 * Render the currently active deck and hold the editor to the DIC-1064 contract:
 * it must show the deck, the slot's selected printing and the exact total, and
 * must say nothing about why that printing was selected.
 */
async function assertSilentEditor(deck, viewport, expectedLayout) {
  setViewport(viewport);
  const { container, cleanup } = await renderDeckEditor();
  try {
    const text = container.textContent;

    // Anchors — without these the absence assertions below prove nothing.
    assert.equal(layoutOf(container), expectedLayout, `must render the ${expectedLayout} layout`);
    assert.ok(text.includes(deck.name), `the deck "${deck.name}" must be on screen`);
    assert.ok(byTestId(container, 'deck-origin-banner'), 'the tournament provenance line stays');
    assert.ok(text.includes(ANCHOR_CARD_NUMBER), `${ANCHOR_CARD_NUMBER} must be listed`);
    assert.ok(
      text.includes(ANCHOR_PRINTING),
      `the exact selected ordinary printing ${ANCHOR_PRINTING} must still be shown`,
    );
    const subtotal = byTestId(container, 'gap-subtotal-JPY');
    assert.ok(subtotal, 'the shortage subtotal must render');
    assert.ok(
      subtotal.textContent.includes(ANCHOR_SUBTOTAL),
      `the exact total must stay ${ANCHOR_SUBTOTAL}, got: ${subtotal.textContent}`,
    );

    // The contract.
    for (const phrase of FORBIDDEN_COPY) {
      assert.ok(!text.includes(phrase), `the deck editor must no longer say "${phrase}"`);
    }
    for (const testID of FORBIDDEN_TESTIDS) {
      assert.equal(byTestId(container, testID), null, `${testID} must no longer render`);
    }
  } finally {
    await cleanup();
  }
}

function seed(deck) {
  platformStorage.removeItem(STORE_KEY);
  useDeckStore.setState({ decks: [deck], activeDeckId: deck.id, collection: {} });
}

const activeDeck = () => useDeckStore.getState().decks[0];

// ── 1–2. A fresh tournament import, both layouts ─────────────────────────────
for (const [label, viewport] of [['desktop', DESKTOP], ['mobile', MOBILE]]) {
  await test(`a freshly imported tournament deck explains nothing (${label})`, async () => {
    const deck = freshlyImportedDeck();
    seed(deck);
    await assertSilentEditor(deck, viewport, label);
  });
}

// ── 3–4. An existing UNRESOLVED deck, migrated in place by the screen ────────
for (const [label, viewport] of [['desktop', DESKTOP], ['mobile', MOBILE]]) {
  await test(`a migrated UNRESOLVED deck explains nothing (${label})`, async () => {
    const legacy = legacyUnresolvedDeck();
    seed(legacy);
    assert.equal(
      activeDeck().oshi[0].card.printing, UNRESOLVED_PRINTING,
      'precondition: the seeded deck really is the broken one',
    );

    setViewport(viewport);
    const { cleanup } = await renderDeckEditor();
    await cleanup();

    // The screen's own migration effect ran; the deck is now on its defaults.
    const migrated = activeDeck();
    const slot = [...migrated.oshi, ...migrated.main, ...migrated.yell]
      .find((s) => s.card.cardNumber === ANCHOR_CARD_NUMBER);
    assert.equal(slot.card.printing, ANCHOR_PRINTING, 'the screen migrated the deck in place');
    assert.ok(slot.card.defaultedPrinting, 'the defaulted marker is kept internally');

    await assertSilentEditor(migrated, viewport, label);
  });
}

// ── 5. …and after a reload, which is when the old banner used to reappear ────
await test('the migrated deck still explains nothing after a reload', async () => {
  const legacy = legacyUnresolvedDeck();
  seed(legacy);
  setViewport(DESKTOP);
  const { cleanup } = await renderDeckEditor();
  await cleanup();

  // Reload: drop the in-memory state and rehydrate from what persist wrote.
  const raw = platformStorage.getItem(STORE_KEY);
  assert.ok(raw, 'the migrated deck must reach persistent storage');
  useDeckStore.setState({ decks: [], activeDeckId: null, collection: {} });
  platformStorage.setItem(STORE_KEY, raw);
  await useDeckStore.persist.rehydrate();

  const reloaded = activeDeck();
  assert.ok(reloaded, 'the deck must come back from storage');
  await assertSilentEditor(reloaded, DESKTOP, 'desktop');
  await assertSilentEditor(reloaded, MOBILE, 'mobile');
});

console.log(`\nDIC-1064 deck editor says nothing it should not: ${passed} tests passed`);
