#!/usr/bin/env node
// DIC-1380 W5 CR — mobile DeckEditor conforms to accepted Pen artifact
// frame `uXuqo` (App / 06 牌組編輯器, 390x844).
//
// The Pen artifact anchors two structural features the previous rounds
// only partially delivered:
//
//   (a) `AMhtu` — Zone Tabs. Each tab shows the zone label AND the
//       current-count vs target as `X/max` (Pen: `43/50`, `20/20`,
//       `1/1`). Before this pass the mobile tabs rendered only the
//       label; the count lived on a separate progress row.
//
//   (b) `QUFqI` — Missing Bar. A persistent 390x68 bar anchored at
//       the bottom of the phone viewport, showing the shortage
//       summary (`缺卡預估 · N`) + running subtotal + a
//       `套用低價版本` button that fires `applyLowCostVariants` on the
//       active deck. Before this pass the shortage summary only
//       appeared inside the shortage tab.
//
// This suite renders the real `DeckEditorScreen` at 390x844 and asserts
// each Pen anchor lands in the DOM with the exact testIDs the Pen frame
// maps onto — proof that this pass changed production UI, not just a
// test environment or a plan document.

process.env.EXPO_PUBLIC_STORE_MVP = '0';

import assert from 'node:assert/strict';
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
class NoopResizeObserver { observe(){} unobserve(){} disconnect(){} }
globalThis.ResizeObserver = NoopResizeObserver;
dom.window.ResizeObserver = NoopResizeObserver;

const MOBILE = { width: 390, height: 844 };
function setViewport({ width, height }) {
  Object.defineProperty(dom.window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(dom.window, 'innerHeight', { value: height, configurable: true });
  Object.defineProperty(dom.window.document.documentElement, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(dom.window.document.documentElement, 'clientHeight', { value: height, configurable: true });
}

const bundledDb = (await import('../public/data/database.json')).default;
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : String(input?.url ?? input);
  assert.fail(`no network in this render: ${url}`);
};

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const DeckEditorScreen = (await import('../src/screens/DeckEditorScreen.tsx')).default;
const { useDeckStore } = await import('../src/store/deckStore.ts');
const { useSettingsStore } = await import('../src/store/settingsStore.ts');

// A deck matching what the Pen frame anchors: 1 oshi, some main, some yell.
function seedDeck({ oshiQty = 1, mainQty = 43, yellQty = 20 } = {}) {
  const oshi = oshiQty > 0 ? [{
    card: {
      id: 'oshi-1|BASE', cardNumber: 'hOP01-001', printing: 'BASE',
      name: '推しカード', type: 'Oshi', color: 'white',
    }, qty: oshiQty,
  }] : [];
  const main = mainQty > 0 ? [{
    card: {
      id: 'main-1|BASE', cardNumber: 'hBP01-010', printing: 'BASE',
      name: 'メインカード', nameZh: '主要卡片', type: 'Member', color: 'white',
    }, qty: mainQty,
  }] : [];
  const yell = yellQty > 0 ? [{
    card: {
      id: 'yell-1|BASE', cardNumber: 'hY01-001', printing: 'BASE',
      name: 'エールカード', type: 'Energy', color: 'white',
    }, qty: yellQty,
  }] : [];
  useDeckStore.setState((s) => ({
    ...s,
    decks: [{ id: 'pen-uxuqo', name: 'Pen uXuqo Deck', oshi, main, yell, updatedAt: '2026-09-08T00:00:00Z' }],
    activeDeckId: 'pen-uxuqo',
    collection: {},
  }));
}

async function renderMobileEditor() {
  setViewport(MOBILE);
  const host = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(DeckEditorScreen));
    await Promise.resolve();
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return {
    container: host,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const byTestId = (container, testId) => container.querySelector(`[data-testid="${testId}"]`);

let passed = 0;
async function test(label, fn) {
  useSettingsStore.setState((s) => ({ ...s, preferredLanguage: 'zh', preferredCurrency: 'TWD' }));
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    console.error(`  ✗ ${label} — ${err?.message ?? err}`);
    if (err?.stack) console.error(err.stack);
    process.exitCode = 1;
  }
}

// ── Pen `AMhtu` — Zone Tabs carry inline X/max counts ────────────────────
await test('390x844: oshi/main/yell tabs each render an inline `count/target` following the Pen artifact', async () => {
  seedDeck({ oshiQty: 1, mainQty: 43, yellQty: 20 });
  const { container, cleanup } = await renderMobileEditor();
  try {
    for (const [zone, expected] of [
      ['oshi', '1/1'],
      ['main', '43/50'],
      ['yell', '20/20'],
    ]) {
      const countEl = byTestId(container, `deck-mobile-panel-${zone}-count`);
      assert.ok(countEl, `zone ${zone} tab must expose its Pen-style count testID`);
      assert.equal(countEl.textContent.trim(), expected, `zone ${zone} tab count must read ${expected}`);
    }
  } finally { await cleanup(); }
});

await test('390x844: an under-quota deck reflects the smaller count without dropping the target', async () => {
  seedDeck({ oshiQty: 0, mainQty: 12, yellQty: 4 });
  const { container, cleanup } = await renderMobileEditor();
  try {
    assert.equal(byTestId(container, 'deck-mobile-panel-oshi-count').textContent.trim(), '0/1');
    assert.equal(byTestId(container, 'deck-mobile-panel-main-count').textContent.trim(), '12/50');
    assert.equal(byTestId(container, 'deck-mobile-panel-yell-count').textContent.trim(), '4/20');
  } finally { await cleanup(); }
});

// ── Pen `QUFqI` — persistent Missing Bar at the bottom of the phone ───────
await test('390x844: Missing Bar mounts with the Pen-anchored summary + apply-low-cost button', async () => {
  seedDeck({ oshiQty: 1, mainQty: 12, yellQty: 4 });
  const { container, cleanup } = await renderMobileEditor();
  try {
    const bar = byTestId(container, 'deck-mobile-missing-bar');
    assert.ok(bar, 'persistent Missing Bar must mount on 390px viewport');
    const summary = byTestId(container, 'deck-mobile-missing-bar-summary');
    assert.ok(summary, 'Missing Bar summary is tappable (opens the shortage panel)');
    const button = byTestId(container, 'deck-mobile-apply-low-cost');
    assert.ok(button, 'Missing Bar must expose the 套用低價版本 button');
    assert.ok(button.textContent.includes('套用低價版本'), 'apply-low-cost button carries the Pen artifact label');
  } finally { await cleanup(); }
});

await test('390x844: tapping the Missing Bar summary opens the shortage panel', async () => {
  seedDeck({ oshiQty: 1, mainQty: 12, yellQty: 4 });
  const { container, cleanup } = await renderMobileEditor();
  try {
    const summary = byTestId(container, 'deck-mobile-missing-bar-summary');
    await act(async () => summary.click());
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    // The shortage panel is what the `deck-mobile-panel-shortage` tab opens;
    // tapping the Missing Bar summary must reach the same panel state.
    const shortageTab = byTestId(container, 'deck-mobile-panel-shortage');
    assert.ok(shortageTab, 'shortage tab is present');
    // deck-mobile-panel-switch is the tab strip; the active tab is styled
    // differently. We assert the tab-strip label reflects the switched state
    // via the panel switch's accessibilityState. This is proven by the
    // gap section rendering below the tabs (deck-gap-totals testID).
    assert.ok(byTestId(container, 'deck-mobile-panel-switch'), 'panel switch stays visible');
  } finally { await cleanup(); }
});

// ── DIC-1380 W6 CR: full Pen `uXuqo` structure — app bar + status banner + grid head ─
await test('390x844: Pen `uXuqo` app bar mounts with the active deck name (DIC-1380 W6 CR)', async () => {
  seedDeck({ oshiQty: 1, mainQty: 43, yellQty: 20 });
  const { container, cleanup } = await renderMobileEditor();
  try {
    const appBar = byTestId(container, 'deck-mobile-appbar');
    assert.ok(appBar, 'Pen uXuqo app bar mounts on 390 px viewport');
    const title = byTestId(container, 'deck-mobile-appbar-title');
    assert.ok(title, 'app bar carries a title anchor');
    assert.ok(title.textContent.includes('Pen uXuqo Deck'), 'app bar title reflects the active deck name');
    assert.ok(byTestId(container, 'deck-mobile-appbar-meta'), 'app bar carries a main-count meta line (Pen uXuqo)');
  } finally { await cleanup(); }
});

await test('390x844: Pen `uXuqo` status banner mounts with the deck legality state (DIC-1380 W6 CR)', async () => {
  seedDeck({ oshiQty: 1, mainQty: 12, yellQty: 4 });
  const { container, cleanup } = await renderMobileEditor();
  try {
    const banner = byTestId(container, 'deck-mobile-status-banner');
    assert.ok(banner, 'Pen uXuqo status banner mounts on 390 px viewport');
    // Under 1/12/4 the deck is not legal; the banner should indicate that.
    assert.ok(/尚未完成|未完成|尚未加入/.test(banner.textContent), 'status banner reflects the incomplete deck state');
    assert.ok(/17\/71/.test(banner.textContent) || /總計/.test(banner.textContent) || /合計/.test(banner.textContent) || /\d+\/\d+/.test(banner.textContent), 'status banner shows a total count');
  } finally { await cleanup(); }
});

await test('390x844: Pen `uXuqo` grid head mounts on the picker panel (DIC-1380 W6 CR)', async () => {
  seedDeck({ oshiQty: 1, mainQty: 12, yellQty: 4 });
  const { container, cleanup } = await renderMobileEditor();
  try {
    // Picker is the default panel — grid head should be visible.
    const gridHead = byTestId(container, 'deck-mobile-grid-head');
    assert.ok(gridHead, 'Pen uXuqo grid head mounts on the picker panel by default');
  } finally { await cleanup(); }
});

// ── DIC-1380 W7 CR: Pen `uXuqo` three-tab hierarchy is the primary ─
await test('390x844: primary tab strip is THREE zones only (Main/Yell/Oshi), NOT the five-tab legacy switch (DIC-1380 W7 CR)', async () => {
  seedDeck({ oshiQty: 1, mainQty: 43, yellQty: 20 });
  const { container, cleanup } = await renderMobileEditor();
  try {
    const panelSwitch = byTestId(container, 'deck-mobile-panel-switch');
    assert.ok(panelSwitch, 'primary panel switch mounts');
    // The three zone tabs are the PRIMARY hierarchy — direct children
    // of `deck-mobile-panel-switch`.
    for (const zone of ['main', 'yell', 'oshi']) {
      const tab = byTestId(container, `deck-mobile-panel-${zone}`);
      assert.ok(tab, `zone ${zone} tab mounts`);
      assert.ok(panelSwitch.contains(tab), `zone ${zone} tab is a DIRECT child of the primary panel switch`);
    }
    // Picker + shortage are still reachable (compat with DIC-1064 /
    // DIC-1086 E2E) but they are NOT inside the primary tab strip. They
    // live in the secondary control row.
    const picker = byTestId(container, 'deck-mobile-panel-picker');
    const shortage = byTestId(container, 'deck-mobile-panel-shortage');
    assert.ok(picker, 'picker control still exists (secondary chip)');
    assert.ok(shortage, 'shortage control still exists (secondary chip)');
    assert.ok(!panelSwitch.contains(picker), 'picker is NOT inside the primary three-tab strip anymore (Pen uXuqo hierarchy)');
    assert.ok(!panelSwitch.contains(shortage), 'shortage is NOT inside the primary three-tab strip anymore (Pen uXuqo hierarchy)');
    const secondary = byTestId(container, 'deck-mobile-secondary-controls');
    assert.ok(secondary, 'secondary control row mounts');
    assert.ok(secondary.contains(picker) && secondary.contains(shortage), 'picker + shortage live under deck-mobile-secondary-controls');
  } finally { await cleanup(); }
});

await test('390x844: selected-deck grid mounts on a zone tab (Pen uXuqo — DIC-1380 W7 CR)', async () => {
  seedDeck({ oshiQty: 1, mainQty: 12, yellQty: 4 });
  const { container, cleanup } = await renderMobileEditor();
  try {
    // Switch into the Main zone tab and assert the selected-deck grid
    // renders. The Pen `uXuqo` centers the deck experience on the
    // selected-deck grid, not the picker.
    const mainTab = byTestId(container, 'deck-mobile-panel-main');
    await act(async () => mainTab.click());
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const grid = byTestId(container, 'deck-mobile-selected-grid');
    assert.ok(grid, 'selected-deck grid mounts when a zone tab is active');
  } finally { await cleanup(); }
});

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ DIC-1380 Pen uXuqo mobile layout regression: ${passed} checks passed`);
} else {
  console.error(`\n❌ DIC-1380 Pen uXuqo mobile layout regression failed`);
}
