#!/usr/bin/env node
// DIC-1427 QA P0 — Pen `App / 04 掃描卡牌` (eurld) / `App / 05 掃描估值清單`
// (wC1cO) IA on the shipped scan surfaces with the real camera/permission and
// session behavior intact.
//
// eurld deltas closed here (on the real ScanOverlay used by both camera
// stacks): the Pen shutter row — 相簿 box LEFT with its label, the gradient
// shutter CENTER, and a REAL 估值清單 count box RIGHT that opens the session
// panel — plus the Pen mode pill rendered ONLY where auto-scan is a real
// capability (web), never as an inert fake control.
//
// wC1cO deltas closed on the real ScanSessionPanel: Pen summary card
// (本次掃描總計 · N 張 + big total + 複製結果 + 版本待確認 warning), item
// rows with thumb/name/version chip/price, and the full-width 繼續掃描 bar.
// All state flows through the real useScanSessionStore.

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

process.env.EXPO_PUBLIC_STORE_MVP = '0';

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
const { Animated } = await import('react-native');
const { default: ScanOverlay } = await import('../src/components/ScanOverlay.tsx');
const { default: ScanSessionPanel } = await import('../src/components/ScanSessionPanel.tsx');
const { useScanSessionStore } = await import('../src/stores/scanSessionStore.ts');

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function render(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  await flush();
  return {
    container,
    cleanup: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const CARD = (n, extra = {}) => ({
  id: `hBP01-0${n}`,
  cardNumber: `hBP01-0${n}`,
  name: `テスト卡 ${n}`,
  type: 'Member',
  rarity: 'UR',
  series: 'hBP01',
  sellPrice: 1000 * n,
  yuyuName: `テスト卡 ${n}`,
  color: '青',
  imageUrl: `https://example.com/${n}.png`,
  prices: [{ name: 'UR', sellPrice: 1000 * n, rarity: 'UR' }],
  ...extra,
});

function seedSession(cards) {
  useScanSessionStore.setState({ cards: [], totalValue: 0, cardCount: 0 });
  for (const c of cards) useScanSessionStore.getState().addCard(c, { force: true });
}

function overlayProps(extra = {}) {
  return {
    scanLineAnim: new Animated.Value(0),
    pulseAnim: new Animated.Value(1),
    borderAnim: new Animated.Value(0),
    isScanning: false,
    flash: false,
    autoScanActive: false,
    isCameraReady: true,
    cameraError: null,
    onFlash() {}, onScan() {}, onGallery() {}, onClose() {}, onRetry() {},
    ...extra,
  };
}

console.log('── DIC-1427 · App 04/05 scan Pen parity ──');

await test('eurld shutter row (Pen BUFW2): 相簿 box + gradient shutter + REAL 估值清單 count box', async () => {
  seedSession([CARD(1), CARD(2)]);
  const events = [];
  const { container, cleanup } = await render(React.createElement(ScanOverlay, overlayProps({
    onGallery: () => events.push('gallery'),
    onScan: () => events.push('scan'),
    onOpenSession: () => events.push('session'),
  })));
  try {
    const gallery = container.querySelector('[data-testid="scan-gallery-action"]');
    assert.ok(gallery, '相簿 control (Pen TOYLP)');
    assert.ok(gallery.textContent.includes('相簿'), '相簿 carries its Pen label, not an unlabeled icon');

    const shutter = container.querySelector('[data-testid="scan-primary-action"]');
    assert.ok(shutter, 'shutter (Pen TbHVE)');

    const sessionBox = container.querySelector('[data-testid="scan-session-entry"]');
    assert.ok(sessionBox, '估值清單 count box (Pen AQf9b)');
    assert.ok(sessionBox.textContent.includes('2'), 'count box carries the REAL session count');
    await act(async () => sessionBox.click());
    assert.deepEqual(events, ['session'], 'count box opens the session list');
  } finally { await cleanup(); }
});

await test('eurld mode pill (Pen Cys7V): a REAL toggle only where auto-scan exists', async () => {
  const events = [];
  const { container, cleanup } = await render(React.createElement(ScanOverlay, overlayProps({
    autoScanSupported: true,
    autoScanActive: true,
    onToggleAutoScan: (v) => events.push(v),
  })));
  try {
    const auto = container.querySelector('[data-testid="scan-mode-auto"]');
    const manual = container.querySelector('[data-testid="scan-mode-manual"]');
    assert.ok(auto && manual, 'mode pill renders with both segments');
    assert.equal(auto.getAttribute('aria-selected'), 'true', '自動掃描 active');
    await act(async () => manual.click());
    assert.deepEqual(events, [false], 'switching to 手動 fires the real toggle');
  } finally { await cleanup(); }
});

await test('eurld mode pill absent when auto-scan is not a real capability (no fake control)', async () => {
  const { container, cleanup } = await render(React.createElement(ScanOverlay, overlayProps({
    autoScanSupported: false,
  })));
  try {
    assert.equal(container.querySelector('[data-testid="scan-mode-auto"]'), null, 'no inert 自動掃描 segment on native');
  } finally { await cleanup(); }
});

await test('wC1cO summary card (Pen Ahd5w): real total + count + 複製結果 + 版本待確認 warning', async () => {
  seedSession([
    CARD(1), CARD(2),
    // Two listings under the same version code → resolveVersionForCard reports
    // confident=false, the REAL 版本待確認 state.
    CARD(3, { prices: [
      { name: 'SR', sellPrice: 500, rarity: 'SR' },
      { name: 'SR', sellPrice: 900, rarity: 'SR' },
    ] }),
  ]);
  const { container, cleanup } = await render(React.createElement(ScanSessionPanel, {
    preferredCurrency: 'JPY',
    onViewCard() {},
    onContinueScanning() {},
    initialExpanded: true,
  }));
  try {
    const summary = container.querySelector('[data-testid="scan-session-summary"]');
    assert.ok(summary, 'Pen summary card renders');
    assert.ok(summary.textContent.includes('3'), 'summary carries the real card count');
    assert.ok(container.querySelector('[data-testid="scan-session-copy-results"]'), '複製結果 stays real');
    const warning = container.querySelector('[data-testid="scan-session-pending-note"]');
    assert.ok(warning, '版本待確認 warning renders for the real unconfident card');
    assert.ok(warning.textContent.includes('1'), 'warning carries the real pending count');
  } finally { await cleanup(); }
});

await test('wC1cO item rows (Pen Wkmt7): thumb + name + version chip + price from the real session', async () => {
  seedSession([CARD(1), CARD(2)]);
  const { container, cleanup } = await render(React.createElement(ScanSessionPanel, {
    preferredCurrency: 'JPY',
    onViewCard() {},
    onContinueScanning() {},
    initialExpanded: true,
  }));
  try {
    const rows = container.querySelectorAll('[data-testid^="scan-session-item-"]');
    assert.equal(rows.length, 2, 'one Pen row per real session card');
    assert.ok(rows[0].querySelector('img'), 'row carries the real card thumb (Pen Ba296)');
    assert.ok(rows[0].textContent.includes('テスト卡 1'), 'row carries the real name');
    assert.ok(rows[0].textContent.includes('¥1,000'), 'row carries the real price');
  } finally { await cleanup(); }
});

await test('wC1cO 繼續掃描 bar (Pen G3y9k) and 清除 keep their real session actions', async () => {
  seedSession([CARD(1)]);
  const events = [];
  const { container, cleanup } = await render(React.createElement(ScanSessionPanel, {
    preferredCurrency: 'JPY',
    onViewCard() {},
    onContinueScanning: () => events.push('continue'),
    initialExpanded: true,
  }));
  try {
    const cont = container.querySelector('[data-testid="scan-session-continue"]');
    assert.ok(cont, '繼續掃描 bar renders');
    await act(async () => cont.click());
    assert.deepEqual(events, ['continue']);

    const clear = container.querySelector('[data-testid="scan-session-clear"]');
    assert.ok(clear, '清除 action renders');
    await act(async () => clear.click());
    await flush();
    assert.equal(useScanSessionStore.getState().cardCount, 0, '清除 really clears the session store');
  } finally { await cleanup(); }
});

console.log(`\nPassed ${passed} tests.`);
