#!/usr/bin/env node
// DIC-1409 Phase 4 mutation-sensitive tests: App 04 掃描卡牌 / App 05
// 掃描估值清單 / App 06 牌組編輯器 / App 07 我的 carry the shared Pen v2
// shell/tokens with their real stores and navigation wiring.
//
// Assertions are pinned to the Pen file (`docs/pen-v2/
// holohunter-landing-v2-updated.pen`, frames eurld / wC1cO / uXuqo / siVsa)
// and to shipped store/navigation contracts.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

// Full profile (same pattern as test-store-mvp-behavior): the 我的 stats
// tiles and 估值清單 price surfaces only exist with Store MVP off.
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
Object.defineProperty(dom.window.document.documentElement, 'clientWidth', { value: 390, configurable: true });
Object.defineProperty(dom.window.document.documentElement, 'clientHeight', { value: 844, configurable: true });
Object.defineProperty(dom.window, 'innerWidth', { value: 390, configurable: true });
Object.defineProperty(dom.window, 'innerHeight', { value: 844, configurable: true });

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const rn = await import('react-native');
const { PALETTE } = await import('../src/theme/tokensV2.ts');

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
function hexToRgb(hex) {
  const v = hex.replace('#', '');
  return `rgb(${parseInt(v.slice(0, 2), 16)}, ${parseInt(v.slice(2, 4), 16)}, ${parseInt(v.slice(4, 6), 16)})`;
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('── DIC-1409 Phase 4 · App 04–07 shell parity ──');

// ── App / 04 掃描卡牌 (Pen frame eurld) — ScanOverlay ─────────────────────

const overlaySource = readFileSync(new URL('../src/components/ScanOverlay.tsx', import.meta.url), 'utf8');

await test('ScanOverlay scan frame is the Pen portrait card window (node Aj73G, 1.4 aspect)', () => {
  assert.match(
    overlaySource,
    /SCAN_AREA_HEIGHT\s*=\s*SCAN_AREA_SIZE\s*\*\s*1\.4\b/,
    'portrait aspect constant from Pen 250×350',
  );
  assert.match(overlaySource, /borderRadius:\s*16/, 'Pen r16 frame corner');
  assert.match(overlaySource, /width:\s*32,\s*\n\s*height:\s*32,\s*\n\s*borderColor:\s*'#FFFFFF'/, 'Pen 32px white corner brackets');
});

async function renderOverlay(props = {}) {
  const { default: ScanOverlay } = await import('../src/components/ScanOverlay.tsx');
  const base = {
    scanLineAnim: new rn.Animated.Value(0),
    pulseAnim: new rn.Animated.Value(1),
    borderAnim: new rn.Animated.Value(0),
    isScanning: false,
    flash: false,
    autoScanEnabled: true,
    isCameraReady: true,
    cameraError: null,
    onFlash: () => {},
    onScan: () => {},
    onFlip: () => {},
    onGallery: () => {},
    onManualSearch: () => {},
    onToggleAutoScan: () => {},
    onRetry: () => {},
  };
  return render(React.createElement(ScanOverlay, { ...base, ...props }));
}

await test('ScanOverlay renders the three Pen tip chips and the segmented mode switch', async () => {
  const { container, cleanup } = await renderOverlay();
  try {
    const tips = container.querySelector('[data-testid="scan-tips-row"]');
    assert.ok(tips, 'tips row (Pen node Cc84X)');
    assert.equal(tips.children.length, 3, 'three tip chips');
    const auto = container.querySelector('[data-testid="scan-mode-auto"]');
    const manual = container.querySelector('[data-testid="scan-mode-manual"]');
    assert.ok(auto && manual, 'mode switch segments (Pen node Cys7V)');
    assert.equal(auto.getAttribute('aria-selected'), 'true', '自動掃描 active');
  } finally { await cleanup(); }
});

await test('ScanOverlay mode switch toggles only when the inactive segment is pressed', async () => {
  let toggles = 0;
  const { container, cleanup } = await renderOverlay({ onToggleAutoScan: () => { toggles += 1; } });
  try {
    await act(async () => container.querySelector('[data-testid="scan-mode-auto"]').click());
    assert.equal(toggles, 0, 'active segment press is a no-op');
    await act(async () => container.querySelector('[data-testid="scan-mode-manual"]').click());
    assert.equal(toggles, 1, 'inactive segment dispatches onToggleAutoScan');
  } finally { await cleanup(); }
});

// ── App / 05 掃描估值清單 (Pen frame wC1cO) — ScanSessionPanel ────────────

await test('ScanSessionPanel carries Pen v2 tokens on the real session store', async () => {
  const { useScanSessionStore } = await import('../src/stores/scanSessionStore.ts');
  const { default: ScanSessionPanel } = await import('../src/components/ScanSessionPanel.tsx');
  const added = useScanSessionStore.getState().addCard({
    id: 'hBP01-081',
    name: '星街すいせい',
    rarity: 'UR',
    series: 'hBP01',
    prices: [{ name: 'UR', sellPrice: 3600, rarity: 'UR' }],
  });
  assert.equal(added, true, 'real store accepts the scanned card');
  const { container, cleanup } = await render(
    React.createElement(ScanSessionPanel, { onContinueScanning: () => {}, preferredCurrency: 'JPY' }),
  );
  try {
    const header = container.querySelector('[data-testid="scan-session-header"]');
    assert.ok(header, 'session header renders');
    const total = container.querySelector('[data-testid="scan-session-total-price"]');
    assert.ok(total, 'session total renders on the full profile');
    const style = dom.window.getComputedStyle(total);
    assert.equal(style.color, hexToRgb(PALETTE.accent2), 'Pen $accent-2 price (was legacy green)');
    await act(async () => header.click());
    assert.ok(
      container.querySelector('[data-testid="scan-session-total-row"]'),
      'expanded total row (Pen Summary node Ahd5w)',
    );
    assert.ok(
      container.querySelector('[data-testid="scan-session-copy-results"]'),
      'copy-results action (Pen node aEGHU)',
    );
  } finally {
    useScanSessionStore.getState().clearSession();
    await cleanup();
  }
});

// ── App / 06 牌組編輯器 (Pen frame uXuqo) — DeckEditorScreen ──────────────

await test('DeckEditor renders inside the shared shell with 牌組 tab active (library state)', async () => {
  const { default: DeckEditorScreen } = await import('../src/screens/DeckEditorScreen.tsx');
  const { container, cleanup } = await render(React.createElement(DeckEditorScreen));
  try {
    assert.ok(container.querySelector('[data-testid="deck-shell"]'), 'shared shell root');
    assert.ok(container.querySelector('[data-testid="shell-status-bar"]'), 'status bar');
    const deckTab = container.querySelector('[data-testid="shell-bottom-tab-deck"]');
    assert.ok(deckTab, '牌組 tab renders');
    assert.equal(deckTab.getAttribute('aria-selected'), 'true', '牌組 tab active');
    assert.ok(
      container.querySelector('[data-testid="deck-library-grid"]'),
      'existing DIC-1088 library grid contract intact inside the shell',
    );
  } finally { await cleanup(); }
});

// ── App / 07 我的 (Pen frame siVsa) — SettingsScreen ──────────────────────

async function renderSettings(navigate = () => {}) {
  const { default: SettingsScreen } = await import('../src/screens/SettingsScreen.tsx');
  return render(React.createElement(SettingsScreen, { navigation: { navigate } }));
}

await test('我的 renders the shell with account card, stats tiles, and 我的 tab active', async () => {
  const { container, cleanup } = await renderSettings();
  try {
    assert.ok(container.querySelector('[data-testid="me-shell"]'), 'shell root');
    assert.equal(
      container.querySelector('[data-testid="shell-app-bar-title"]').textContent,
      '我的',
      'Pen App/07 app bar title (node l66Pu)',
    );
    const meTab = container.querySelector('[data-testid="shell-bottom-tab-me"]');
    assert.equal(meTab.getAttribute('aria-selected'), 'true', '我的 tab active');
    const card = container.querySelector('[data-testid="me-account-card"]');
    assert.ok(card, 'account card (Pen node ZYJRw)');
    const style = dom.window.getComputedStyle(card);
    assert.equal(style.backgroundColor, hexToRgb(PALETTE.appSurface), 'Pen $app-surface card');
    assert.ok(container.querySelector('[data-testid="me-stat-collection"]'), 'collection stat tile (real deck store)');
    assert.ok(container.querySelector('[data-testid="me-stat-alerts"]'), 'alert stat tile (real price-alert store)');
  } finally { await cleanup(); }
});

await test('我的 keeps the full existing settings surface (language / currency / account auth)', async () => {
  const { container, cleanup } = await renderSettings();
  try {
    const text = container.textContent;
    assert.ok(text.includes('顯示語言') || text.includes('言語'), 'language section retained');
    assert.ok(text.includes('顯示幣別') || text.includes('通貨'), 'currency section retained');
    assert.ok(
      container.textContent.includes('Google'),
      'auth surface retained (guest login or linked providers)',
    );
  } finally { await cleanup(); }
});

await test('我的 bottom tab dispatches every shell destination (nested MainDrawer form)', async () => {
  // DIC-1409 CR fix: presses use navigate('MainDrawer', { screen }) so
  // they also resolve from root-stack screens.
  const calls = [];
  const { container, cleanup } = await renderSettings((route, params) => calls.push(params?.screen ?? route));
  try {
    for (const key of ['home', 'search', 'deck']) {
      await act(async () => container.querySelector(`[data-testid="shell-bottom-tab-${key}"]`).click());
    }
    assert.deepEqual(calls, ['Home', 'Search', 'DeckEditor']);
  } finally { await cleanup(); }
});

console.log(`\nPassed ${passed} tests.`);
