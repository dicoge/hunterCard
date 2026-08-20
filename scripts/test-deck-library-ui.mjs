#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

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

const importedOshi = {
  id: 'hOS-001#BASE', cardNumber: 'hOS-001', name: '測試推し', printing: 'BASE',
  printingLabel: '通常', series: 'hOS', cardTypeJp: '推しホロメン', imageUrl: 'https://example.com/oshi.png',
};

const decks = () => [
  { id: 'missing', name: '沒有推し', oshi: [], main: [], yell: [], updatedAt: '2026-08-18T00:00:00Z' },
  {
    id: 'imported', name: '匯入牌組', oshi: [{ card: importedOshi, qty: 1 }], main: [], yell: [],
    updatedAt: '2026-08-18T00:00:00Z',
    origin: {
      kind: 'tournament', eventId: 'event', eventName: '測試賽事', sourceDeckId: 'source',
      decklogCode: null, sourceUrl: 'https://example.com', importedAt: '2026-08-18T00:00:00Z',
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

async function renderAt(width, height) {
  setViewport(width, height);
  useDeckStore.setState({ decks: decks(), activeDeckId: null, collection: { 'hOS-001|BASE': 2 } });
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

for (const [label, width, height] of [['mobile', 390, 844], ['desktop', 1280, 900]]) {
  await test(`${label} renders imported and missing-Oshi deck tiles`, async () => {
    const { container, cleanup } = await renderAt(width, height);
    try {
      assert.ok(container.querySelector('[data-testid="deck-library-grid"]'));
      assert.ok(container.querySelector('[data-testid="deck-tile-missing"]'));
      assert.ok(container.querySelector('[data-testid="deck-tile-imported"]'));
      assert.ok(container.querySelector('[data-testid="deck-oshi-placeholder"]'));
      assert.ok(container.textContent.includes('賽事匯入'));
      assert.ok(container.textContent.includes('推しホロメン 1/1'));
    } finally { await cleanup(); }
  });
}

await test('named confirmation cancel is safe, confirm deletes only the deck', async () => {
  const { container, cleanup } = await renderAt(390, 844);
  try {
    await click(container.querySelector('[data-testid="deck-menu-missing"]'));
    await click(document.querySelector('[data-testid="deck-menu-delete"]'));
    assert.ok(document.body.textContent.includes('確定要刪除「沒有推し」嗎？'));
    await click(document.querySelector('[data-testid="deck-delete-cancel"]'));
    assert.ok(useDeckStore.getState().decks.some((deck) => deck.id === 'missing'));

    await click(container.querySelector('[data-testid="deck-menu-missing"]'));
    await click(document.querySelector('[data-testid="deck-menu-delete"]'));
    await click(document.querySelector('[data-testid="deck-delete-confirm"]'));
    assert.ok(!useDeckStore.getState().decks.some((deck) => deck.id === 'missing'));
    assert.ok(useDeckStore.getState().decks.some((deck) => deck.id === 'imported'));
    assert.equal(useDeckStore.getState().collection['hOS-001|BASE'], 2);
  } finally { await cleanup(); }
});

console.log(`\nDIC-1088 deck library UI: ${passed} tests passed`);
