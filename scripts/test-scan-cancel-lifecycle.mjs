#!/usr/bin/env node
/**
 * Leaving the Scan screen cancels the running scan (CR remediation 2026-10-14, P2_1).
 *
 * The Scan route lives in a drawer, so closing it or switching drawer items blurs it
 * without unmounting. Before this fix a delayed recognition resolved off-screen and
 * committed a card, charging the shared 50/month quota.
 *
 * Part 1 drives the production coordinator (src/services/scanLifecycle) directly.
 * Part 2 renders the REAL ScanScreen through the REAL StackNavigator/drawer under jsdom
 * (react-native-web), presses the real shutter, holds /api/recognize-card open, leaves the
 * screen through the real close button or a real drawer navigation, then resolves a
 * high-confidence card late. Assertions read the real scanSessionStore and scanQuotaStore.
 * Only the network and the camera/canvas platform seams are mocked; no provider is called.
 */
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
if (!dom.window.matchMedia) {
  dom.window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  globalThis.matchMedia = dom.window.matchMedia;
}

// ---- platform seams: camera stream, video frame size, canvas encode ----
const track = { kind: 'video', stop() {}, addEventListener() {}, removeEventListener() {} };
const stream = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [], addEventListener() {}, removeEventListener() {} };
Object.defineProperty(dom.window.navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => stream } });
dom.window.HTMLMediaElement.prototype.play = function play() { return Promise.resolve(); };
Object.defineProperty(dom.window.HTMLMediaElement.prototype, 'srcObject', {
  configurable: true, get() { return this.__srcObject ?? null; }, set(v) { this.__srcObject = v; },
});
// A frame exists (readyState stays 0, so the auto-scan loop never fires on its own).
Object.defineProperty(dom.window.HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 1280 });
Object.defineProperty(dom.window.HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 960 });
const JPEG_DATA_URL = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(900, 3)]).toString('base64')}`;
dom.window.HTMLCanvasElement.prototype.getContext = function getContext() {
  return { drawImage() {}, translate() {}, scale() {}, imageSmoothingEnabled: true, imageSmoothingQuality: 'high' };
};
dom.window.HTMLCanvasElement.prototype.toDataURL = () => JPEG_DATA_URL;

// ---- network: /api/recognize-card is held open until the test releases it ----
const CARD = {
  id: 'hBP04-005_hBP04_SEC', cardNumber: 'hBP04-005', name: 'ラプラス・ダークネス', sellPrice: 1280,
  series: 'hBP04', rarity: 'SEC', imageUrl: '', prices: [], priceHistory: {}, type: '', grade: '',
};
const recognitionCalls = [];
globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (!href.includes('/api/recognize-card')) {
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  }
  let release;
  const gate = new Promise((r) => { release = r; });
  const call = { signal: init.signal, body: init.body, release: () => release() };
  recognitionCalls.push(call);
  await gate; // deliberately ignores abort: models a result that arrives late anyway
  return {
    ok: true,
    status: 200,
    json: async () => ({ success: true, card: CARD, confidence: 0.97, candidates: [CARD] }),
  };
};

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { NavigationContainer, createNavigationContainerRef } = await import('@react-navigation/native');
const { StackNavigator } = await import('../src/navigation/AppNavigator.tsx');
const { useScanSessionStore } = await import('../src/stores/scanSessionStore.ts');
const { useScanQuotaStore } = await import('../src/store/scanQuotaStore.ts');
const { usePhotoUploadConsentStore } = await import('../src/store/photoUploadConsentStore.ts');
const { PHOTO_UPLOAD_DISCLOSURE_VERSION } = await import('../src/services/photoUploadDisclosure.ts');
const lifecycleModule = await import('../src/services/scanLifecycle.ts');

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

// ======================= Part 1: the production coordinator =======================
console.log('\nscanLifecycle coordinator');
const { createScanLifecycle, bindScanLifecycleToNavigation, guardForJob } = lifecycleModule;

function fakeNavigation(focused = true) {
  const listeners = { focus: new Set(), blur: new Set() };
  return {
    isFocused: () => focused,
    addListener: (ev, cb) => { listeners[ev].add(cb); return () => listeners[ev].delete(cb); },
    emit: (ev) => { focused = ev === 'focus'; for (const cb of [...listeners[ev]]) cb(); },
    count: (ev) => listeners[ev].size,
  };
}

await test('blur aborts the job, retires it, and focus does not revive it', () => {
  const lc = createScanLifecycle();
  const nav = fakeNavigation();
  let cancelled = 0;
  const unbind = bindScanLifecycleToNavigation(nav, lc, () => { cancelled += 1; });
  const job = lc.begin();
  assert.equal(job.isCurrent(), true);
  nav.emit('blur');
  assert.equal(job.signal.aborted, true);
  assert.equal(job.isCurrent(), false);
  assert.equal(cancelled, 1, 'busy UI reset callback runs');
  nav.emit('focus');
  assert.equal(job.isCurrent(), false, 'a retired job stays retired after re-focus');
  unbind();
  assert.equal(nav.count('blur') + nav.count('focus'), 0, 'listeners released');
});

await test('cannot begin while unfocused; a new scan retires the previous one', () => {
  const lc = createScanLifecycle();
  lc.setFocused(false);
  assert.equal(lc.begin(), null);
  lc.setFocused(true);
  const a = lc.begin();
  const b = lc.begin();
  assert.equal(a.signal.aborted, true);
  assert.equal(a.isCurrent(), false);
  assert.equal(b.isCurrent(), true);
  lc.end(a); // ending a stale job must not release the newer one
  assert.equal(lc.hasLiveJob(), true);
  lc.end(b);
  assert.equal(lc.hasLiveJob(), false);
});

await test('guardForJob drops every late callback of a retired job', () => {
  const lc = createScanLifecycle();
  const job = lc.begin();
  const calls = [];
  const ui = guardForJob(job, { onVisionRecognized: (c) => calls.push(c), setBusy: (b) => calls.push(b) });
  ui.setBusy(true);
  lc.cancel();
  ui.onVisionRecognized('late-card');
  ui.setBusy(false);
  assert.deepEqual(calls, [true]);
});

// ======================= Part 2: the real screen =======================
console.log('\nReal ScanScreen through the real navigator');

const byTestId = (el, id) => el.querySelector(`[data-testid="${id}"]`);
const tick = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const click = async (el) => {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
};

usePhotoUploadConsentStore.setState({ acceptedVersion: PHOTO_UPLOAD_DISCLOSURE_VERSION });
const resetStores = () => {
  useScanSessionStore.setState({ cards: [] });
  useScanQuotaStore.getState().resetQuota();
};
const sessionCount = () => useScanSessionStore.getState().cards.length;
const quotaUsed = () => useScanQuotaStore.getState().scanCount;

const host = dom.window.document.createElement('div');
dom.window.document.body.appendChild(host);
const root = createRoot(host);
const navRef = createNavigationContainerRef();
await act(async () => root.render(React.createElement(NavigationContainer, { ref: navRef }, React.createElement(StackNavigator))));
await tick(30);

async function openScanCamera() {
  await act(async () => { navRef.navigate('MainDrawer', { screen: 'Scan' }); });
  await tick(60);
  assert.equal(navRef.getCurrentRoute()?.name, 'Scan');
  const allow = byTestId(host, 'scan-permission-allow');
  if (allow) { await click(allow); await tick(80); await tick(0); }
  assert.ok(byTestId(host, 'scan-primary-action'), 'camera-ready shutter is rendered');
}
async function pressShutter() {
  const before = recognitionCalls.length;
  await click(byTestId(host, 'scan-primary-action'));
  await tick(30);
  assert.equal(recognitionCalls.length, before + 1, 'the shutter really started a recognition request');
  return recognitionCalls[recognitionCalls.length - 1];
}
const shutterBusy = () => byTestId(host, 'scan-primary-action')?.getAttribute('aria-disabled') === 'true';

try {
  await test('close button mid-recognition: request aborted; late high-confidence card is not added or charged', async () => {
    resetStores();
    await openScanCamera();
    const call = await pressShutter();
    assert.equal(shutterBusy(), true, 'scan is in progress');
    await click(byTestId(host, 'scan-top-bar-close'));
    await tick(30);
    assert.equal(navRef.getCurrentRoute()?.name, 'Home');
    assert.equal(call.signal.aborted, true, 'close aborted the in-flight request');
    call.release();
    await tick(50);
    assert.equal(sessionCount(), 0, 'no card committed off-screen');
    assert.equal(quotaUsed(), 0, 'quota untouched');
  });

  await test('returning to Scan: the old job stays dead and the shutter is not stuck busy', async () => {
    await act(async () => { navRef.navigate('MainDrawer', { screen: 'Scan' }); });
    await tick(60);
    assert.equal(shutterBusy(), false, 'busy UI was cleared on cancel');
    assert.equal(sessionCount(), 0);
    assert.equal(quotaUsed(), 0);
  });

  await test('drawer switch (blur, no close button): late result still ignored, also after re-focus', async () => {
    resetStores();
    await openScanCamera();
    const call = await pressShutter();
    await act(async () => { navRef.navigate('MainDrawer', { screen: 'Search' }); });
    await tick(30);
    assert.equal(navRef.getCurrentRoute()?.name, 'Search');
    assert.equal(call.signal.aborted, true, 'blur aborted the in-flight request');
    await act(async () => { navRef.navigate('MainDrawer', { screen: 'Scan' }); });
    await tick(60);
    call.release(); // lands while Scan is focused again — but it belongs to the retired job
    await tick(50);
    assert.equal(sessionCount(), 0, 're-focus does not revive the old job');
    assert.equal(quotaUsed(), 0);
    assert.equal(shutterBusy(), false);
  });

  await test('normal scan while focused: the card is added and charged exactly once', async () => {
    resetStores();
    await openScanCamera();
    const call = await pressShutter();
    call.release();
    await tick(80);
    assert.equal(sessionCount(), 1);
    assert.equal(quotaUsed(), 1);
    assert.equal(useScanSessionStore.getState().cards[0].id, CARD.id);
  });
} finally {
  await act(async () => root.unmount());
  host.remove();
}

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ scan-cancel-lifecycle: ${passed} checks passed`);
} else {
  console.error('\n❌ scan-cancel-lifecycle failed');
}
