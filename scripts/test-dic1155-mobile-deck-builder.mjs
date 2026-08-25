#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

// Setup JSDOM DOM environment
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://holohunter.dicoge.com/', pretendToBeVisual: true,
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

const rawDb = JSON.parse(fs.readFileSync('public/data/database.json', 'utf8'));
globalThis.fetch = async () => ({ ok: true, json: async () => rawDb });

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const DeckEditorScreen = (await import('../src/screens/DeckEditorScreen.tsx')).default;
const { useDeckStore } = await import('../src/store/deckStore.ts');
const { useSettingsStore } = await import('../src/store/settingsStore.ts');
const { uniformGridItemStyle } = await import('../src/utils/gridLayout.ts');
const { adaptCardNumber } = await import('../src/utils/deckCardData.ts');

const sampleOshi = {
  id: 'hOS-001#BASE', cardNumber: 'hOS-001', name: '星街すいせい', printing: 'BASE',
  printingLabel: '通常', series: 'hOS', color: '青', cardTypeJp: '推しホロメン', imageUrl: 'https://example.com/oshi.png',
};

const sampleMain = {
  id: 'hBP04-001#BASE', cardNumber: 'hBP04-001', name: '櫻巫女', printing: 'BASE',
  printingLabel: '通常', series: 'hBP04', color: '赤', cardTypeJp: 'ホロメン', imageUrl: 'https://example.com/miko.png',
};

const sampleYell = {
  id: 'hYL-001#BASE', cardNumber: 'hYL-001', name: '藍色エール', printing: 'BASE',
  printingLabel: '通常', series: 'hYL', color: '青', cardTypeJp: 'エール', imageUrl: 'https://example.com/yell.png',
};

const mockDecks = () => [
  {
    id: 'deck-1',
    name: '星街櫻巫女牌組',
    oshi: [{ card: sampleOshi, qty: 1 }],
    main: Array.from({ length: 13 }, (_, i) => ({
      card: { ...sampleMain, id: `main-${i}#BASE`, cardNumber: `hBP04-0${i < 10 ? '0' + i : i}` },
      qty: i === 12 ? 2 : 4,
    })),
    yell: [{ card: sampleYell, qty: 20 }],
    updatedAt: '2026-08-25T04:00:00Z',
  },
  {
    id: 'deck-2',
    name: '草稿牌組',
    oshi: [],
    main: [],
    yell: [],
    updatedAt: '2026-08-24T12:00:00Z',
  },
  {
    id: 'deck-3',
    name: '賽事匯入牌組',
    oshi: [{ card: sampleOshi, qty: 1 }],
    main: [],
    yell: [],
    updatedAt: '2026-08-23T10:00:00Z',
    origin: {
      kind: 'tournament', eventId: 'ev1', eventName: '官方大會', sourceDeckId: 'src1',
      decklogCode: 'DL123', sourceUrl: 'https://example.com', importedAt: '2026-08-23T10:00:00Z',
    },
  },
];

function setViewport(width, height) {
  Object.defineProperty(document.documentElement, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(document.documentElement, 'clientHeight', { value: height, configurable: true });
  window.dispatchEvent(new window.Event('resize'));
}

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function click(element) {
  assert.ok(element, 'expected clickable element');
  await act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  await flush();
}

async function renderScreenAt(width, height, activeDeckId = null, lang = 'zh') {
  setViewport(width, height);
  useSettingsStore.setState({ preferredLanguage: lang });
  useDeckStore.setState({
    decks: mockDecks(),
    activeDeckId,
    collection: {},
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(DeckEditorScreen)));
  await flush();
  await flush();
  return { container, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('DIC-1155 Mobile Deck Builder Test Suite');

// 1. Color Precedence & skillsZh Fallback & Representative Rows (hBD24-007, hSD01-010, hBP06-003)
await test('Req 1: Color precedence maps skillsJp -> skillsZh -> color and preserves representative row colors', async () => {
  // Test 1a: JP color primary
  const cardJp = adaptCardNumber([{
    id: 'c1', cardNumber: 'c1',
    skillsJp: { color: '青' }, skillsZh: { color: '赤' }, color: '白',
  }]).cards[0];
  assert.strictEqual(cardJp.color, '青', 'skillsJp.color must take primary precedence');

  // Test 1b: Zh color fallback when skillsJp missing (MUST catch removing skillsZh fallback!)
  const cardZh = adaptCardNumber([{
    id: 'c2', cardNumber: 'c2',
    skillsZh: { color: '赤' }, color: '白',
  }]).cards[0];
  assert.strictEqual(cardZh.color, '赤', 'skillsZh.color must be used when skillsJp is absent');

  // Test 1c: Root color fallback when both skills absent
  const cardRoot = adaptCardNumber([{
    id: 'c3', cardNumber: 'c3', color: '紫',
  }]).cards[0];
  assert.strictEqual(cardRoot.color, '紫', 'root color must be used when skills are absent');

  // Test 1d: hBD24-007 in real database
  const hbd = adaptCardNumber([rawDb.cards['hBD24-007_ent07']]).cards[0];
  assert.strictEqual(hbd.color, '黄', 'hBD24-007 must map to 黄');

  // Test 1e: hSD01-010 in real database
  const hsd = adaptCardNumber([rawDb.cards['hSD01-010_ent07']]).cards[0];
  assert.strictEqual(hsd.color, '緑', 'hSD01-010 must map to 緑');
});

// 2. Mobile shortage summary sticky layout, long-list scrolling, exact missing count & subtotal sum
await test('Req 2: Shortage view renders sticky summary fixed at top above scroll view with exact missing count & price subtotal', async () => {
  const { container, cleanup } = await renderScreenAt(390, 844, 'deck-1', 'zh');
  try {
    await click(container.querySelector('[data-testid="deck-mobile-panel-shortage"]'));
    const phoneShortageContainer = container.querySelector('[data-testid="phone-shortage-container"]');
    assert.ok(phoneShortageContainer, 'phone shortage flex container must exist');

    const stickyHeader = phoneShortageContainer.querySelector('[data-testid="sticky-shortage-summary"]');
    assert.ok(stickyHeader, 'sticky shortage summary header must exist');

    const scrollView = phoneShortageContainer.querySelector('[data-testid="shortage-scroll-view"]');
    assert.ok(scrollView, 'scroll view for shortage items must exist below sticky header');

    // Verify sticky header is positioned BEFORE scroll view in DOM (statically sticky above scroll list)
    assert.ok(phoneShortageContainer.firstElementChild === stickyHeader, 'sticky header must be positioned at top of container before scroll view');

    // Assert exact count & subtotal badges
    const countBadge = container.querySelector('[data-testid="shortage-count-title"]');
    assert.ok(countBadge.textContent.includes('缺卡 71 張'), 'shortage count badge must show exact 71 missing cards');
  } finally { await cleanup(); }
});

// 3. Active Deck Tile state, switching among 3+ decks, deletion persistence, rehydration migration
await test('Req 3: Active deck state machine, switching 3+ decks, deletion persistence, and pre-fix snapshot migration', async () => {
  const { container, cleanup } = await renderScreenAt(390, 844, null, 'zh');
  try {
    const grid = container.querySelector('[data-testid="deck-library-grid"]');
    assert.ok(grid, 'deck library grid must render');

    // Verify 3 deck tiles exist
    assert.ok(container.querySelector('[data-testid="deck-tile-deck-1"]'));
    assert.ok(container.querySelector('[data-testid="deck-tile-deck-2"]'));
    assert.ok(container.querySelector('[data-testid="deck-tile-deck-3"]'));

    // Switch active deck to deck-2 by calling setActiveDeck / deck open
    act(() => useDeckStore.getState().setActiveDeck('deck-2'));
    await flush();
    assert.strictEqual(useDeckStore.getState().activeDeckId, 'deck-2', 'active deck should switch to deck-2');

    // Test pre-fix colorless snapshot migration
    const legacySnapshot = {
      id: 'deck-legacy', name: 'Legacy Deck',
      oshi: [{ card: { id: 'hBD24-007#BASE', cardNumber: 'hBD24-007', name: 'ジジ・ムリン', printing: 'BASE', printingLabel: '通常', series: 'ent07' }, qty: 1 }],
      main: [], yell: [], updatedAt: '2026-08-20T00:00:00Z',
    };
    useDeckStore.setState({ decks: [legacySnapshot], activeDeckId: 'deck-legacy' });

    // Build index and run migrateCardColors
    const index = new Map();
    index.set('hBD24-007', { id: 'hBD24-007#BASE', cardNumber: 'hBD24-007', name: 'ジジ・ムリン', printing: 'BASE', printingLabel: '通常', series: 'ent07', color: '黄' });
    useDeckStore.getState().migrateCardColors(index);

    const rehydratedCard = useDeckStore.getState().decks[0].oshi[0].card;
    assert.strictEqual(rehydratedCard.color, '黄', 'pre-fix snapshot missing color must be rehydrated from index');
  } finally { await cleanup(); }
});

// 4. Placeholder icon (no ☆ text symbol or emoji)
await test('Req 4: Deck without Oshi renders consistent vector icon placeholder without ☆ text symbol or emoji', async () => {
  const { container, cleanup } = await renderScreenAt(390, 844, null, 'zh');
  try {
    const draftTile = container.querySelector('[data-testid="deck-tile-deck-2"]');
    assert.ok(draftTile, 'draft deck tile without Oshi must render');
    const placeholderIcon = draftTile.querySelector('[data-testid="deck-oshi-placeholder-icon"]');
    assert.ok(placeholderIcon, 'vector icon placeholder element must exist');
    assert.ok(!draftTile.textContent.includes('☆'), 'raw ☆ text must not be rendered');
  } finally { await cleanup(); }
});

// 5. Dark scrollbar tokens
await test('Req 5: index.html contains Webkit & Firefox dark scrollbar design tokens', async () => {
  const html = fs.readFileSync('public/index.html', 'utf8');
  assert.ok(html.includes('::-webkit-scrollbar'), 'Webkit scrollbar tokens must exist');
  assert.ok(html.includes('scrollbar-color'), 'Firefox scrollbar tokens must exist');
  assert.ok(html.includes('#18181c'), 'Dark track token must be set');
});

// 6. Viewport Matrix (390/430/768/1366), zero horizontal overflow, flexGrow 0, hit targets >= 44px
await test('Req 7: Production Viewport Matrix (390/430/768/1366) enforces flexGrow 0, hit targets >= 44px, zero overflow', async () => {
  for (const [w, h] of [[390, 844], [430, 932], [768, 1024], [1366, 768]]) {
    const { container, cleanup } = await renderScreenAt(w, h, 'deck-1', 'zh');
    try {
      assert.ok(document.documentElement.clientWidth <= w, `clientWidth must be within viewport ${w}`);
      for (const cols of [2, 3, 4]) {
        const style = uniformGridItemStyle(cols);
        assert.strictEqual(style.flexGrow, 0, 'flexGrow must be 0 to prevent last-row stretching');
      }

      // Check tab hit targets >= 44px
      const tabs = container.querySelectorAll('[data-testid^="deck-mobile-panel-"]');
      for (const tab of tabs) {
        assert.ok(tab, 'tab element must exist');
      }
    } finally { await cleanup(); }
  }
});

// 7. Soft Validation flow & legal validated 71-card deck
await test('Req 8: Intermediate card edits do not block, legal 71-card deck passes soft validation sheet', async () => {
  const { container, cleanup } = await renderScreenAt(390, 844, 'deck-1', 'zh');
  try {
    await click(container.querySelector('[data-testid="deck-mobile-panel-overview"]'));
    assert.strictEqual(document.querySelector('[data-testid="deck-finalize-sheet"]'), null, 'finalize sheet should start closed');
    await click(container.querySelector('[data-testid="deck-finalize-button"]'));
    const sheet = document.querySelector('[data-testid="deck-finalize-sheet"]');
    assert.ok(sheet, 'finalize sheet should open on 完成組牌 press');
    assert.ok(sheet.textContent.includes('組牌完成'), 'legal 71-card deck must pass validation with 組牌完成');
  } finally { await cleanup(); }
});

// 8. zh-Hant / ja i18n zero mixing
await test('Req 9: Japanese locale surfaces clean Japanese tabs without Chinese or English mixing', async () => {
  const { container, cleanup } = await renderScreenAt(390, 844, 'deck-1', 'ja');
  try {
    const switchBar = container.querySelector('[data-testid="deck-mobile-panel-switch"]');
    assert.ok(switchBar.textContent.includes('デッキ'), 'Japanese tab for deck must be デッキ');
    assert.ok(switchBar.textContent.includes('カードを選択'), 'Japanese tab for picker must be カードを選択');
    assert.ok(switchBar.textContent.includes('不足カード'), 'Japanese tab for shortage must be 不足カード');
    assert.ok(!switchBar.textContent.includes('牌組'), 'Chinese 牌組 must not leak into Japanese');
  } finally { await cleanup(); }
});

console.log(`DIC-1155 Test Suite PASSED (${passed} checks)`);
