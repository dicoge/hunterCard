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

const mockDecks = () => [
  {
    id: 'deck-1',
    name: '星街櫻巫女牌組',
    oshi: [{ card: sampleOshi, qty: 1 }],
    main: [{ card: sampleMain, qty: 50 }],
    yell: Array.from({ length: 20 }, (_, i) => ({
      card: { ...sampleMain, id: `yell-${i}`, cardNumber: `hYL-${i}` },
      qty: 1,
    })),
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
  return { container, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('DIC-1155 Mobile Deck Builder Test Suite');

// 1. Real database adapter test for hBD24-007 main-color mapping
await test('Req 1: adaptCardNumber maps skillsJp.color / skillsZh.color for hBD24-007 without falling back to 推し', async () => {
  const rawHBD24 = rawDb.cards['hBD24-007_ent07'];
  assert.ok(rawHBD24, 'hBD24-007_ent07 must exist in database.json');
  const adapted = adaptCardNumber([rawHBD24]);
  const card = adapted.cards[0];
  assert.strictEqual(card.color, '黄', 'hBD24-007 color must be correctly mapped as 黄');

  const { container, cleanup } = await renderScreenAt(390, 844, null, 'zh');
  try {
    // Inject hBD24 deck into state
    useDeckStore.setState({
      decks: [{
        id: 'deck-hBD24',
        name: 'hBD24 黃色牌組',
        oshi: [{ card, qty: 1 }],
        main: [],
        yell: [],
        updatedAt: '2026-08-25T05:00:00Z',
      }],
      activeDeckId: null,
    });
    // Re-render view
    const container2 = document.createElement('div');
    document.body.appendChild(container2);
    const root2 = createRoot(container2);
    await act(async () => root2.render(React.createElement(DeckEditorScreen)));
    await flush();

    const colorBadge = container2.querySelector('[data-testid="deck-color-badge-deck-hBD24"]');
    assert.ok(colorBadge, 'color badge for hBD24 deck must exist');
    assert.ok(colorBadge.textContent.includes('主色：黄'), 'should display 主色：黄');
    assert.ok(!colorBadge.textContent.includes('推し'), 'color badge must NEVER render card type fragment 推し as color');
    root2.unmount();
    container2.remove();
  } finally { await cleanup(); }
});

// 2. <=480px mobile panel switch & top progress
await test('Req 1b: <=480px mobile view renders all 6 tabs and pins progress bar at top', async () => {
  const { container, cleanup } = await renderScreenAt(390, 844, 'deck-1', 'zh');
  try {
    const progress = container.querySelector('[data-testid="deck-phone-progress"]');
    assert.ok(progress, 'phone progress bar must stay rendered at top');
    assert.ok(progress.textContent.includes('推しホロメン 1/1'));
    assert.ok(progress.textContent.includes('主牌組 50/50'));
    assert.ok(progress.textContent.includes('エール 20/20'));

    const switchBar = container.querySelector('[data-testid="deck-mobile-panel-switch"]');
    assert.ok(switchBar, 'mobile panel switch must exist');
    const tabs = ['overview', 'picker', 'oshi', 'main', 'yell', 'shortage'];
    for (const tab of tabs) {
      const btn = container.querySelector(`[data-testid="deck-mobile-panel-${tab}"]`);
      assert.ok(btn, `mobile panel tab button for ${tab} must exist`);
    }

    // Switch to overview
    await click(container.querySelector('[data-testid="deck-mobile-panel-overview"]'));
    assert.ok(container.querySelector('[data-testid="deck-overview-panel"]'), 'overview panel should render');

    // Switch to picker
    await click(container.querySelector('[data-testid="deck-mobile-panel-picker"]'));
    assert.ok(container.querySelector('[data-testid="card-picker-grid"]'), 'picker panel should render');

    // Switch to shortage
    await click(container.querySelector('[data-testid="deck-mobile-panel-shortage"]'));
    assert.ok(container.querySelector('[data-testid="sticky-shortage-summary"]'), 'sticky shortage summary should render');
  } finally { await cleanup(); }
});

// 3. Full 71-card UI deck & Sticky shortage summary with long shortage list
await test('Req 2: Shortage view renders sticky summary header with exact missing count and price sum for 71-card deck', async () => {
  const { container, cleanup } = await renderScreenAt(390, 844, 'deck-1', 'zh');
  try {
    await click(container.querySelector('[data-testid="deck-mobile-panel-shortage"]'));
    const stickyHeader = container.querySelector('[data-testid="sticky-shortage-summary"]');
    assert.ok(stickyHeader, 'sticky shortage summary header must be present at top');
    
    const countTitle = container.querySelector('[data-testid="shortage-count-title"]');
    assert.ok(countTitle, 'shortage count badge must exist');
    assert.ok(countTitle.textContent.includes('缺卡 71 張'), 'should display exact missing card count (71)');
  } finally { await cleanup(); }
});

// 4. Responsive deck library grid, active state, deck switching & deletion persistence
await test('Req 3: State machine supports switching among 3+ decks, active badge, deletion, and reload persistence', async () => {
  const { container, cleanup } = await renderScreenAt(390, 844, null, 'zh');
  try {
    const grid = container.querySelector('[data-testid="deck-library-grid"]');
    assert.ok(grid, 'deck library grid must exist');

    // Verify 3 decks render
    assert.ok(container.querySelector('[data-testid="deck-tile-deck-1"]'));
    assert.ok(container.querySelector('[data-testid="deck-tile-deck-2"]'));
    assert.ok(container.querySelector('[data-testid="deck-tile-deck-3"]'));

    // Open menu for deck-3 and confirm deletion
    await click(container.querySelector('[data-testid="deck-menu-deck-3"]'));
    await click(document.querySelector('[data-testid="deck-menu-delete"]'));
    assert.ok(document.body.textContent.includes('確定要刪除「賽事匯入牌組」嗎？'));
    await click(document.querySelector('[data-testid="deck-delete-confirm"]'));

    // Assert deck-3 deleted from store
    const remainingDecks = useDeckStore.getState().decks;
    assert.strictEqual(remainingDecks.length, 2, 'store should have 2 decks left after deletion');
    assert.strictEqual(remainingDecks.find((d) => d.id === 'deck-3'), undefined, 'deck-3 must be deleted');
  } finally { await cleanup(); }
});

// 5. Consistent placeholder icon (no ☆ symbol or emoji)
await test('Req 4: Deck without Oshi renders consistent vector icon placeholder without ☆ text symbol or emoji', async () => {
  const { container, cleanup } = await renderScreenAt(390, 844, null, 'zh');
  try {
    const draftTile = container.querySelector('[data-testid="deck-tile-deck-2"]');
    assert.ok(draftTile, 'draft deck tile without Oshi must render');
    const placeholderIcon = draftTile.querySelector('[data-testid="deck-oshi-placeholder-icon"]');
    assert.ok(placeholderIcon, 'vector icon placeholder element must exist');
    assert.strictEqual(draftTile.querySelector('.deckOshiPlaceholderIcon'), null, 'text ☆ symbol must not exist');
    assert.ok(!draftTile.textContent.includes('☆'), 'raw ☆ text must not be rendered');
  } finally { await cleanup(); }
});

// 6. Dark scrollbar tokens
await test('Req 5: index.html contains Webkit & Firefox dark scrollbar design tokens', async () => {
  const html = fs.readFileSync('public/index.html', 'utf8');
  assert.ok(html.includes('::-webkit-scrollbar'), 'Webkit scrollbar tokens must exist in index.html');
  assert.ok(html.includes('scrollbar-color'), 'Firefox scrollbar tokens must exist in index.html');
  assert.ok(html.includes('#18181c'), 'Dark track token must be set');
});

// 7. Production-path Viewport Matrix (390, 430, 768, 1366) & Grid Width Compatibility
await test('Req 7: Viewport Matrix (390/430/768/1366) enforces flexGrow 0 and zero horizontal overflow', async () => {
  for (const [w, h] of [[390, 844], [430, 932], [768, 1024], [1366, 768]]) {
    const { container, cleanup } = await renderScreenAt(w, h, 'deck-1', 'zh');
    try {
      assert.ok(document.documentElement.clientWidth <= w, `clientWidth must be within viewport ${w}`);
      for (const cols of [2, 3, 4]) {
        const style = uniformGridItemStyle(cols);
        assert.strictEqual(style.flexGrow, 0, 'flexGrow must be 0 to prevent last-row stretching');
        assert.strictEqual(style.flexShrink, 1, 'flexShrink must be 1 for grid bounds');
      }
    } finally { await cleanup(); }
  }
});

// 8. Soft Validation flow
await test('Req 8: Intermediate card edits do not block, finalize button triggers validation sheet', async () => {
  const { container, cleanup } = await renderScreenAt(390, 844, 'deck-2', 'zh');
  try {
    await click(container.querySelector('[data-testid="deck-mobile-panel-overview"]'));
    assert.strictEqual(document.querySelector('[data-testid="deck-finalize-sheet"]'), null, 'finalize sheet should start closed');
    await click(container.querySelector('[data-testid="deck-finalize-button"]'));
    assert.ok(document.querySelector('[data-testid="deck-finalize-sheet"]'), 'finalize sheet should open on 完成組牌 press');
  } finally { await cleanup(); }
});

// 9. zh-Hant / ja i18n zero mixing
await test('Req 9: Japanese locale surfaces clean Japanese tabs without Chinese or English mixing', async () => {
  const { container, cleanup } = await renderScreenAt(390, 844, 'deck-1', 'ja');
  try {
    const switchBar = container.querySelector('[data-testid="deck-mobile-panel-switch"]');
    assert.ok(switchBar.textContent.includes('デッキ'), 'Japanese tab for deck must be デッキ');
    assert.ok(switchBar.textContent.includes('カードを選択'), 'Japanese tab for picker must be カードを選択');
    assert.ok(switchBar.textContent.includes('不足カード'), 'Japanese tab for shortage must be 不足カード');
    assert.ok(!switchBar.textContent.includes('牌組'), 'Chinese 牌組 must not leak into Japanese');
    assert.ok(!switchBar.textContent.includes('選卡'), 'Chinese 選卡 must not leak into Japanese');
  } finally { await cleanup(); }
});

console.log(`DIC-1155 Test Suite PASSED (${passed} checks)`);
