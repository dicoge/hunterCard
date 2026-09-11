#!/usr/bin/env node
// DIC-1409 CR fix — Search + Scan routes on the Pen v2 shell, asserted
// against the REAL shipped screens (the CR found both routes still wore
// legacy COLORS chrome + the drawer header while the phase evidence
// rendered a synthetic overlay).
//
//   1. SearchScreen renders inside the shared RouteShell with the Pen
//      search idiom, and a suggestion tap drives the REAL handler
//      (navigate('SearchResults', { query })) — a stubbed-string test
//      cannot pass without the handler firing.
//   2. ScanScreen's web pre-camera state carries the Pen App/04 top
//      action row (`x7iIL`: close + REAL quota pill + flash) and the
//      close button dispatches the nested MainDrawer/Home navigation.
//   3. ScanOverlay (the live-camera chrome) mounts the same top bar and
//      its flash button dispatches the real onFlash contract.

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
class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = NoopResizeObserver;
dom.window.ResizeObserver = NoopResizeObserver;
Object.defineProperty(dom.window, 'innerWidth', { value: 390, configurable: true });
Object.defineProperty(dom.window, 'innerHeight', { value: 844, configurable: true });
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
if (!dom.window.matchMedia) {
  dom.window.matchMedia = () => ({
    matches: false,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
  });
  globalThis.matchMedia = dom.window.matchMedia;
}
// Deterministic camera seam at the web-platform API boundary: a fake
// MediaStream from getUserMedia + inert media-element play/srcObject.
const makeFakeTrack = () => ({ kind: 'video', stop() {}, addEventListener() {}, removeEventListener() {} });
const makeFakeStream = () => {
  const track = makeFakeTrack();
  return {
    getTracks: () => [track],
    getVideoTracks: () => [track],
    getAudioTracks: () => [],
    addEventListener() {}, removeEventListener() {},
  };
};
Object.defineProperty(dom.window.navigator, 'mediaDevices', {
  configurable: true,
  value: { getUserMedia: async () => makeFakeStream() },
});
dom.window.HTMLMediaElement.prototype.play = function play() { return Promise.resolve(); };
Object.defineProperty(dom.window.HTMLMediaElement.prototype, 'srcObject', {
  configurable: true,
  get() { return this.__srcObject ?? null; },
  set(v) { this.__srcObject = v; },
});

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Animated } = await import('react-native-web');
const { NavigationContainer, createNavigationContainerRef } = await import('@react-navigation/native');
const { default: SearchScreen } = await import('../src/screens/SearchScreen.tsx');
const { default: ScanScreen, ScanNativePermissionGate } = await import('../src/screens/ScanScreen.tsx');
const { StackNavigator } = await import('../src/navigation/AppNavigator.tsx');
const { default: ScanOverlay } = await import('../src/components/ScanOverlay.tsx');
const { PALETTE } = await import('../src/theme/tokensV2.ts');

const hexToRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

const byTestId = (el, id) => el.querySelector(`[data-testid="${id}"]`);
const click = async (el) => {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
};

async function renderInto(element) {
  const host = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  return {
    container: host,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

let passed = 0;
async function test(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    process.exitCode = 1;
    console.error(`  ✗ ${label} — ${err.message}`);
  }
}

await test('SearchScreen renders the shared RouteShell + Pen search idiom (no legacy chrome)', async () => {
  const calls = [];
  const navigation = { navigate: (...a) => calls.push(a), goBack() {}, openDrawer() {} };
  const { container, cleanup } = await renderInto(React.createElement(SearchScreen, { navigation }));
  try {
    assert.ok(byTestId(container, 'search-shell'), 'RouteShell mounts (search-shell)');
    assert.ok(byTestId(container, 'shell-bottom-tab-bar'), 'shared bottom tab bar mounts');
    assert.ok(byTestId(container, 'search-input-wrap'), 'Pen $app-elev search field mounts');
    assert.ok(byTestId(container, 'search-suggestions'), 'suggestion card mounts');
  } finally { await cleanup(); }
});

await test('SearchScreen suggestion tap drives the REAL navigate handler with the query', async () => {
  const calls = [];
  const navigation = { navigate: (...a) => calls.push(a), goBack() {}, openDrawer() {} };
  const { container, cleanup } = await renderInto(React.createElement(SearchScreen, { navigation }));
  try {
    const tag = byTestId(container, 'search-suggestion-星街すいせい');
    assert.ok(tag, 'suggestion tag mounts');
    await click(tag);
    const hit = calls.find((c) => c[0] === 'SearchResults');
    assert.ok(hit, 'tap navigates to SearchResults');
    assert.equal(hit[1]?.query, '星街すいせい', 'real query param travels with the navigation');
  } finally { await cleanup(); }
});

await test('ScanScreen web pre-camera state carries the Pen top action row with the REAL quota pill', async () => {
  const calls = [];
  const navigation = { navigate: (...a) => calls.push(a), goBack() {}, openDrawer() {} };
  const { container, cleanup } = await renderInto(React.createElement(ScanScreen, { navigation }));
  try {
    assert.ok(byTestId(container, 'scan-top-bar'), 'Pen x7iIL top bar mounts on the pre-camera state');
    assert.ok(byTestId(container, 'scan-quota-pill'), 'REAL scan-quota store pill mounts in the top bar');
    const flash = byTestId(container, 'scan-top-bar-flash');
    assert.ok(flash, 'flash slot present (disabled pre-camera)');
    const close = byTestId(container, 'scan-top-bar-close');
    assert.ok(close, 'close button mounts');
    await click(close);
    const hit = calls.find((c) => c[0] === 'MainDrawer');
    assert.ok(hit && hit[1]?.screen === 'Home', 'close dispatches nested MainDrawer/Home navigation');
  } finally { await cleanup(); }
});

await test('ScanOverlay (live-camera chrome) mounts the top bar; flash dispatches the real contract', async () => {
  let flashCalls = 0;
  const props = {
    scanLineAnim: new Animated.Value(0),
    pulseAnim: new Animated.Value(1),
    borderAnim: new Animated.Value(0),
    isScanning: false,
    flash: false,
    autoScanEnabled: true,
    isCameraReady: true,
    cameraError: null,
    onFlash: () => { flashCalls += 1; },
    onScan() {}, onFlip() {}, onGallery() {}, onManualSearch() {},
    onToggleAutoScan() {}, onRetry() {}, onClose() {},
  };
  const { container, cleanup } = await renderInto(React.createElement(ScanOverlay, props));
  try {
    assert.ok(byTestId(container, 'scan-top-bar'), 'top bar mounts over the camera');
    assert.ok(byTestId(container, 'scan-quota-pill'), 'quota pill mounts over the camera');
    assert.ok(byTestId(container, 'scan-mode-switch'), 'Pen mode switch still mounts');
    assert.ok(byTestId(container, 'scan-tips-row'), 'Pen tips row still mounts');
    const flash = byTestId(container, 'scan-top-bar-flash');
    await click(flash);
    assert.equal(flashCalls, 1, 'top-bar flash drives the real onFlash contract');
  } finally { await cleanup(); }
});

await test('NATIVE permission-loading state renders the Pen top bar + v2 chrome (ScanNativePermissionGate)', async () => {
  const calls = [];
  const { container, cleanup } = await renderInto(
    React.createElement(ScanNativePermissionGate, {
      permission: null,
      onClose: (...a) => calls.push(a),
      onRequestPermission() {}, openSettingsImpl() {},
    }),
  );
  try {
    const gate = byTestId(container, 'scan-native-gate');
    assert.ok(gate, 'native gate mounts');
    assert.equal(
      dom.window.getComputedStyle(gate).backgroundColor,
      hexToRgb(PALETTE.appBg),
      'native loading surface uses the Pen $app-bg (legacy COLORS chrome removed)',
    );
    assert.ok(byTestId(container, 'scan-top-bar'), 'Pen top bar mounts on native loading state');
    assert.ok(byTestId(container, 'scan-quota-pill'), 'real quota pill mounts on native loading state');
    await click(byTestId(container, 'scan-top-bar-close'));
    assert.equal(calls.length, 1, 'close dispatches from the native loading state');
  } finally { await cleanup(); }
});

await test('NATIVE permission-denied state keeps the DIC-1286 recovery contract on the Pen shell', async () => {
  const closes = [];
  let settingsOpens = 0;
  const { container, cleanup } = await renderInto(
    React.createElement(ScanNativePermissionGate, {
      permission: { granted: false, canAskAgain: false, status: 'denied' },
      onClose: () => closes.push(1),
      onRequestPermission() {},
      openSettingsImpl: () => { settingsOpens += 1; },
    }),
  );
  try {
    const gate = byTestId(container, 'scan-native-gate');
    assert.ok(gate, 'native denied gate mounts');
    assert.ok(byTestId(container, 'scan-top-bar'), 'Pen top bar mounts on native denied state');
    assert.equal(byTestId(container, 'camera-permission-request'), null, 'permanent denial hides the re-ask button (DIC-1286 contract)');
    const settings = byTestId(container, 'camera-permission-open-settings');
    assert.ok(settings, 'settings recovery path mounts');
    await click(settings);
    assert.equal(settingsOpens, 1, 'settings recovery invokes the real openSettings impl');
    await click(byTestId(container, 'scan-top-bar-close'));
    assert.equal(closes.length, 1, 'close dispatches from the native denied state');
  } finally { await cleanup(); }
});

await test('SHIPPED Scan route reaches camera-ready through the real StackNavigator (deterministic getUserMedia seam)', async () => {
  const navRef = createNavigationContainerRef();
  const { container, cleanup } = await renderInto(
    React.createElement(NavigationContainer, { ref: navRef }, React.createElement(StackNavigator)),
  );
  try {
    await act(async () => { navRef.navigate('MainDrawer', { screen: 'Scan' }); });
    await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
    assert.equal(navRef.getCurrentRoute()?.name, 'Scan', 'harness drives the shipped Scan route, not a direct mount');
    const allow = byTestId(container, 'scan-permission-allow');
    assert.ok(allow, 'route shows the real permission gate first');
    await click(allow);
    await act(async () => { await new Promise((r) => setTimeout(r, 80)); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    assert.ok(container.querySelector('video'), 'camera element mounts from the seam stream');
    assert.ok(byTestId(container, 'scan-top-bar'), 'camera-ready chrome: Pen top bar');
    assert.ok(byTestId(container, 'scan-tips-row'), 'camera-ready chrome: Pen tips row');
    assert.ok(byTestId(container, 'scan-mode-switch'), 'camera-ready chrome: Pen mode switch');
    assert.equal(navRef.getCurrentRoute()?.name, 'Scan', 'route stays on Scan at camera-ready');
  } finally { await cleanup(); }
});

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ DIC-1409 Scan/Search shell parity: ${passed} checks passed`);
} else {
  console.error('\n❌ DIC-1409 Scan/Search shell parity failed');
}
