#!/usr/bin/env node
/**
 * DIC-1155 × DIC-1256 render gate (added in DIC-1272 recovery).
 *
 * The DIC-1155 sticky shortage summary carries BOTH a shortage-count badge and
 * a per-currency total badge. Store MVP must keep the count (it is deck-editing
 * information) and drop the money. test-store-mvp-ui-gates.mjs pins that as
 * source text, but a source-text pin cannot see the difference between "not
 * gated" and "gated the other way": wrapping the count badge in
 * {FEATURES.marketData && ...} leaves the asserted substring intact. Nothing
 * else in CI rendered this screen under EXPO_PUBLIC_STORE_MVP=1 at all.
 *
 * So this renders the real DeckEditorScreen shortage panel and counts live
 * testIDs. It asserts BOTH directions off the resolved flag, which is why the
 * runner below invokes it once per profile — over-gating the count badge fails
 * the STORE_MVP=1 leg, un-gating the total badge fails it too, and dropping the
 * price surfaces entirely fails the STORE_MVP=0 leg.
 *
 * Run: EXPO_PUBLIC_STORE_MVP=1 node --import ./scripts/register-web-render.mjs \
 *        scripts/test-dic1155-store-mvp-render.mjs
 */
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
const { useSettingsStore } = await import('../src/store/settingsStore.ts');
const { FEATURES, STORE_MVP } = await import('../src/config/releaseFlags.ts');

const oshi = {
  id: 'hOS-001#BASE', cardNumber: 'hOS-001', name: '星街すいせい', printing: 'BASE',
  printingLabel: '通常', series: 'hOS', color: '青', cardTypeJp: '推しホロメン',
};
const mainCard = {
  id: 'hBP04-001#BASE', cardNumber: 'hBP04-001', name: '櫻巫女', printing: 'BASE',
  printingLabel: '通常', series: 'hBP04', color: '赤', cardTypeJp: 'ホロメン',
};
const yellCard = {
  id: 'hYL-001#BASE', cardNumber: 'hYL-001', name: '藍色エール', printing: 'BASE',
  printingLabel: '通常', series: 'hYL', color: '青', cardTypeJp: 'エール',
};

const mockDeck = () => ({
  id: 'deck-1',
  name: '星街櫻巫女牌組',
  oshi: [{ card: oshi, qty: 1 }],
  main: Array.from({ length: 13 }, (_, i) => ({
    card: { ...mainCard, id: `main-${i}#BASE`, cardNumber: `hBP04-0${i < 10 ? `0${i}` : i}` },
    qty: i === 12 ? 2 : 4,
  })),
  yell: [{ card: yellCard, qty: 20 }],
  updatedAt: '2026-08-25T04:00:00Z',
});

async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function renderShortagePanel(width, height) {
  Object.defineProperty(document.documentElement, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(document.documentElement, 'clientHeight', { value: height, configurable: true });
  window.dispatchEvent(new window.Event('resize'));
  useSettingsStore.setState({ preferredLanguage: 'zh' });
  useDeckStore.setState({ decks: [mockDeck()], activeDeckId: 'deck-1', collection: {} });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(DeckEditorScreen)));
  await flush();
  await flush();

  const tab = container.querySelector('[data-testid="deck-mobile-panel-shortage"]');
  if (tab) {
    await act(async () => tab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    await flush();
  }
  return { container, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

const n = (c, sel) => c.querySelectorAll(sel).length;

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log(`DIC-1155 × Store-MVP render gate (STORE_MVP=${STORE_MVP}, marketData=${FEATURES.marketData})`);

// The desktop path composes the same sticky header through estimatePanel, so the
// gate is proven at every width the DIC-1155 matrix covers, not just the phone.
for (const [w, h] of [[390, 844], [430, 932], [768, 1024], [1366, 768]]) {
  await test(`${w}×${h}: shortage summary matches the Store-MVP profile`, async () => {
    const { container, cleanup } = await renderShortagePanel(w, h);
    try {
      const countBadge = container.querySelector('[data-testid="shortage-count-title"]');
      assert.ok(countBadge, `${w}px: shortage-count badge must render in BOTH profiles — it is deck-editing information, not market data`);
      assert.match(countBadge.textContent || '', /缺卡\s*\d+\s*張/, `${w}px: shortage count must state a real number`);

      const subtotals = n(container, '[data-testid^="sticky-gap-subtotal-"]');
      const rowPrices = n(container, '[data-testid^="gap-price-"]');
      const totalsCard = n(container, '[data-testid="deck-gap-totals"]');
      const alerts = n(container, '[data-testid^="price-alert-open-"],[data-testid^="price-alert-unavailable-"]');
      const text = container.textContent || '';

      if (FEATURES.marketData) {
        assert.ok(subtotals > 0, `${w}px: staging build must keep the sticky total badge`);
        assert.ok(rowPrices > 0, `${w}px: staging build must keep per-row estimates`);
        assert.ok(totalsCard > 0, `${w}px: staging build must keep the gap totals card`);
      } else {
        assert.strictEqual(subtotals, 0, `${w}px: Store MVP leaked ${subtotals} sticky total-price badge(s)`);
        assert.strictEqual(rowPrices, 0, `${w}px: Store MVP leaked ${rowPrices} per-row price(s)`);
        assert.strictEqual(totalsCard, 0, `${w}px: Store MVP leaked the gap totals card`);
        assert.strictEqual(alerts, 0, `${w}px: Store MVP leaked ${alerts} price-alert CTA(s)`);
        assert.ok(!text.includes('參考售價'), `${w}px: Store MVP leaked 參考售價 copy`);
        assert.ok(!/[¥￥]|\bJPY\b|\bTWD\b/.test(text), `${w}px: Store MVP leaked a currency token`);
      }
    } finally {
      await cleanup();
    }
  });
}

if (!FEATURES.watchlist) {
  await test('Store MVP: no price-alert editor anywhere in the deck editor', async () => {
    const { container, cleanup } = await renderShortagePanel(390, 844);
    try {
      assert.strictEqual(n(container, '[data-testid="price-alert-editor"]'), 0, 'Store MVP must not render the alert editor');
    } finally {
      await cleanup();
    }
  });
}

console.log(`DIC-1155 Store-MVP render gate PASSED (${passed} checks, STORE_MVP=${STORE_MVP})`);
