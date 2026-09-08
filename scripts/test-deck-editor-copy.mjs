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

/**
 * Render the currently active deck and hold the editor to the DIC-1064 contract:
 * it must show the deck, the slot's selected printing and the exact total, and
 * must say nothing about why that printing was selected.
 */
async function assertSilentEditor(deck, viewport, expectedLayout, expectedSubtotal = ANCHOR_SUBTOTAL) {
  setViewport(viewport);
  const { container, cleanup } = await renderDeckEditor();
  try {
    assert.equal(layoutOf(container), expectedLayout, `must render the ${expectedLayout} layout`);
    const observedText = [container.textContent];

    if (expectedLayout === 'mobile') {
      await act(async () => byTestId(container, 'deck-mobile-panel-oshi').click());
      assert.equal(byTestId(container, 'card-picker-grid'), null, 'phone deck panel must replace the picker');
      observedText.push(container.textContent);
    }

    const deckText = container.textContent;
    assert.ok(deckText.includes(deck.name), `the deck "${deck.name}" must be on screen`);
    assert.ok(byTestId(container, 'deck-origin-banner'), 'the tournament provenance line stays');
    assert.ok(deckText.includes(ANCHOR_CARD_NUMBER), `${ANCHOR_CARD_NUMBER} must be listed`);
    const anchorSlot = ['oshi', 'main', 'yell']
      .flatMap((zone) => deck[zone])
      .find((slot) => slot.card.cardNumber === ANCHOR_CARD_NUMBER);
    assert.ok(anchorSlot, `${ANCHOR_CARD_NUMBER} must remain in the imported deck`);
    assert.equal(anchorSlot.card.printing, ANCHOR_PRINTING, 'the exact ordinary printing identity must remain BASE');
    const anchorLabel = anchorSlot.card.printingLabel || anchorSlot.card.printing;
    assert.ok(
      deckText.includes(anchorLabel),
      `the exact selected ordinary printing label ${anchorLabel} must still be shown`,
    );

    if (expectedLayout === 'mobile') {
      await act(async () => byTestId(container, 'deck-mobile-panel-shortage').click());
      assert.equal(byTestId(container, 'deck-origin-banner'), null, 'phone shortage panel must replace the deck');
      observedText.push(container.textContent);
    }

    const subtotal = byTestId(container, 'gap-subtotal-JPY');
    assert.ok(subtotal, 'the shortage subtotal must render');
    if (expectedSubtotal === null) {
      // Live-data mode: the number is today's market, so only the property that
      // proves the editor priced the deck at all is asserted.
      const rendered = Number((subtotal.textContent.match(/([\d,]+)\s*JPY/) ?? [])[1]?.replace(/,/g, ''));
      assert.ok(
        Number.isFinite(rendered) && rendered > 0,
        `the live dataset must still render a real total, got: ${subtotal.textContent}`,
      );
    } else {
      assert.ok(
        subtotal.textContent.includes(expectedSubtotal),
        `the exact total must stay ${expectedSubtotal}, got: ${subtotal.textContent}`,
      );
    }

    const text = observedText.join('\n');
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

// ── 6. The same screen, on the LIVE scraped dataset ─────────────────────────
// Everything above renders frozen prices so the anchor total can be exact. This
// renders the real public/data/database.json, where the total is whatever the
// last scrape published: a moved price must NOT fail (DIC-1127), but a dataset
// that stopped pricing the deck, or copy creeping back in, still must.
await test('the live scraped dataset renders the same silent editor', async () => {
  // This process serves the live database to the screen (LIVE_MODE), so what the
  // screen renders below really is the scraped dataset.
  const liveCards = adaptDatabase(Object.values(liveDb.cards || {}));
  const liveCatalog = buildCatalogIndex(liveCards.cards);
  const draft = buildImportedDeck(
    event, sourceDeck, liveCatalog, liveCards.priceRecords, [], IMPORTED_AT,
  );
  const deck = {
    id: 'live-import',
    name: draft.name,
    oshi: draft.oshi,
    main: draft.main,
    yell: draft.yell,
    origin: draft.origin,
    updatedAt: IMPORTED_AT,
  };
  seed(deck);
  await assertSilentEditor(deck, DESKTOP, 'desktop', null);
  await assertSilentEditor(deck, MOBILE, 'mobile', null);
});

// A leg that ran nothing must never look like a pass — that is exactly how the
// original defect hid: the live assertions silently never executed. Pinning the
// per-leg count means a rename or a filter drift fails loudly instead of
// collapsing both legs back onto one dataset.
const EXPECTED_CASES = LIVE_MODE ? LIVE_CASES : FROZEN_CASES;
assert.equal(
  passed, EXPECTED_CASES,
  `the ${LIVE_MODE ? 'live' : 'frozen'} leg must run exactly ${EXPECTED_CASES} case(s), ran ${passed}`,
);

console.log(
  `\nDIC-1064 deck editor says nothing it should not: ${passed} tests passed`
  + ` (${LIVE_MODE ? 'live scraped' : 'frozen'} database)`,
);

// ── The other leg, in its own process ────────────────────────────────────────
// Run last so this leg's result is already reported. execArgv carries the loader
// flags (--import ./scripts/register-web-render.mjs), without which the child
// could not load .ts/.tsx at all. stdio is inherited so the child's ✓ lines and
// any failure surface directly; a non-zero child exit fails this suite.
if (!LIVE_MODE) {
  const { spawnSync } = await import('node:child_process');
  const child = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, DECK_EDITOR_LIVE_DB: '1' },
  });
  if (child.status !== 0) {
    console.error('\n✗ the live-database leg failed');
    process.exit(child.status === null ? 1 : child.status);
  }
}
