#!/usr/bin/env node
/**
 * v41 native automatic capture on the REAL native ScanScreen (Platform.OS = 'android',
 * <CameraView> branch) — same device seams as test-scan-native-crop-render: camera,
 * manipulator and on-device OCR are fixtures, fetch → the REAL recognize-card handler
 * with the provider mocked. The on-device reader is fed a scripted sequence of texts,
 * standing in for "what is legible inside the frame" on each probe. No device, no
 * photo, no network, no provider call.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import { JSDOM } from 'jsdom';

register(
  'data:text/javascript,' + encodeURIComponent(`
    const RN = ${JSON.stringify(new URL('./fixtures/react-native-android-shim.mjs', import.meta.url).href)};
    const CAMERA = ${JSON.stringify(new URL('./fixtures/native-camera-fixture.mjs', import.meta.url).href)};
    const PICKER = ${JSON.stringify(new URL('./fixtures/native-image-picker-fixture.mjs', import.meta.url).href)};
    export async function resolve(specifier, context, next) {
      if (specifier === 'react-native' && !String(context.parentURL || '').endsWith('react-native-android-shim.mjs')) return { url: RN, shortCircuit: true };
      if (specifier === 'expo-camera') return { url: CAMERA, shortCircuit: true };
      if (specifier === 'expo-image-picker') return { url: PICKER, shortCircuit: true };
      if ((specifier.endsWith('/scanRuntime') || specifier.endsWith('/webOcr')) && context.parentURL) {
        return next(new URL(specifier + '.native.ts', context.parentURL).href, context);
      }
      return next(specifier, context);
    }
  `),
  import.meta.url,
);

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://holohunter.dicoge.com/', pretendToBeVisual: true });
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

// Measured window rects (preview below a 56px header, frame inside it).
const PREVIEW = { x: 0, y: 56, width: 390, height: 788 };
const FRAME = { x: 28, y: 150, width: 335, height: 468 };
const rectOf = (r) => ({ x: r.x, y: r.y, left: r.x, top: r.y, width: r.width, height: r.height, right: r.x + r.width, bottom: r.y + r.height });
const realRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
  const id = this.getAttribute?.('data-testid');
  if (id === 'scan-camera-box') return rectOf(PREVIEW);
  if (id === 'scan-frame') return rectOf(FRAME);
  return realRect.call(this);
};

const jpeg = (tag) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag.repeat(40))]).toString('base64');
const FULL_B64 = jpeg('context'), CROP_B64 = jpeg('crop');
// What the on-device reader "sees" inside the frame on each call (probe or fallback).
let frameText = '';
const ocrCalls = [];
const manipulations = [];
globalThis.require = (name) => {
  if (name === 'expo-image-manipulator') {
    return {
      SaveFormat: { JPEG: 'jpeg' },
      ImageManipulator: {
        manipulate(uri) {
          const ops = [];
          const ctx = {
            crop(r) { ops.push(['crop', r]); return ctx; },
            resize(r) { ops.push(['resize', r]); return ctx; },
            async renderAsync() {
              return { async saveAsync(o) {
                manipulations.push({ uri, ops, base64: !!o?.base64 });
                const isCrop = ops.some((x) => x[0] === 'crop');
                return { base64: o?.base64 ? (isCrop ? CROP_B64 : FULL_B64) : undefined, uri: isCrop ? 'file:///cache/ImageManipulator/frame.jpg' : 'file:///cache/ImageManipulator/full.jpg' };
              } };
            },
          };
          return ctx;
        },
      },
    };
  }
  if (name === 'expo-ocr-kit') return { recognizeText: async (uri) => { ocrCalls.push(uri); return { text: frameText }; } };
  throw new Error(`unexpected require ${name}`);
};
globalThis.__nativeCameraPhoto = { uri: 'file:///cache/Camera/shot.jpg', width: 3024, height: 4032, base64: jpeg('original') };

const DB = JSON.parse(fs.readFileSync(new URL('../public/data/database.json', import.meta.url), 'utf8'));
const handler = (await import('../api/recognize-card.ts')).default;
process.env.GEMINI_API_KEY = 'test-key-never-sent';
let providerDown = false;
const bodies = [];
globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (href === 'https://holohunter.dicoge.com/data/database.json') return Response.json(DB);
  if (href.includes('generativelanguage.googleapis.com')) {
    if (providerDown) return new Response('down', { status: 500 });
    return Response.json({ candidates: [{ content: { parts: [{ text: 'CARD_NUMBER: hBP01-010\nCHARACTER: 天音かなた' }] } }] });
  }
  if (href.includes('/api/recognize-card')) {
    bodies.push(JSON.parse(init.body));
    const res = await handler(new Request('https://holohunter.dicoge.com/api/recognize-card', { method: 'POST', body: init.body, headers: { 'Content-Type': 'application/json' } }));
    const text = await res.text();
    return { ok: res.ok, status: res.status, json: async () => JSON.parse(text) };
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
};

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ScanScreen } = await import('../src/screens/ScanScreen.tsx');
const { AUTO_CAPTURE_PROBE_INTERVAL_MS } = await import('../src/services/autoCapture.ts');
const { usePhotoUploadConsentStore } = await import('../src/store/photoUploadConsentStore.ts');
const { PHOTO_UPLOAD_DISCLOSURE_VERSION } = await import('../src/services/photoUploadDisclosure.ts');
const { useScanQuotaStore } = await import('../src/store/scanQuotaStore.ts');
const { useScanSessionStore } = await import('../src/stores/scanSessionStore.ts');

let passed = 0;
async function test(label, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (err) { process.exitCode = 1; console.error(`  ✗ ${label} — ${err.message}`); }
}
const tick = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const byTestId = (id) => document.querySelector(`[data-testid="${id}"]`);
const click = async (el) => {
  assert.ok(el, 'element exists');
  await act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); await Promise.resolve(); });
};
const probes = (n) => tick(AUTO_CAPTURE_PROBE_INTERVAL_MS * n + 400);
const takes = () => globalThis.__nativeCameraTakes ?? 0;
const appState = async (next) => { await act(async () => { globalThis.__setAppState(next); await Promise.resolve(); }); };

usePhotoUploadConsentStore.setState({ acceptedVersion: null });
useScanQuotaStore.getState().resetQuota();
useScanSessionStore.getState().clearSession();
const navigation = { navigate() {}, goBack() {}, openDrawer() {}, isFocused: () => true, addListener: () => () => {} };
const host = document.createElement('div');
document.body.appendChild(host);
const root = createRoot(host);
await act(async () => root.render(React.createElement(ScanScreen, { navigation })));
await tick(50);

try {
  await test('native shows the Auto / Manual pill (capability present on this build) and starts in automatic mode', () => {
    assert.ok(byTestId('scan-mode-pill'), 'mode pill rendered on native');
    assert.equal(byTestId('scan-mode-auto').getAttribute('aria-selected'), 'true');
    assert.ok(host.textContent.includes('將卡牌置於掃描框內'));
  });

  await test('before the photo disclosure is accepted, automatic capture takes no picture at all', async () => {
    frameText = 'hBP01-010';
    await probes(3);
    assert.equal(takes(), 0);
    assert.equal(bodies.length, 0);
  });

  usePhotoUploadConsentStore.setState({ acceptedVersion: PHOTO_UPLOAD_DISCLOSURE_VERSION });

  await test('no card number readable in the frame → probes only, never an upload (no blind timer capture)', async () => {
    frameText = '';
    await probes(3);
    assert.ok(takes() >= 2, `probes ran (${takes()})`);
    assert.equal(bodies.length, 0, 'nothing uploaded');
    const probeCalls = globalThis.__nativeCameraCalls;
    assert.ok(probeCalls.every((o) => o.shutterSound === false && o.base64 === false), 'probes are silent and carry no image bytes');
    assert.ok(ocrCalls.every((u) => u === 'file:///cache/ImageManipulator/frame.jpg'), 'the reader reads the FRAME crop only');
    assert.ok(manipulations.every((m) => m.base64 === false), 'probe crops are never encoded for upload');
  });

  await test('a card number held still in the frame → exactly ONE recognition request, shown as a preview, nothing charged', async () => {
    const remaining = useScanQuotaStore.getState().getRemaining();
    frameText = '天音かなた hBP01-010 U';
    for (let i = 0; i < 40 && bodies.length === 0; i++) await tick(100);
    await tick(600);
    assert.equal(bodies.length, 1, 'one request');
    assert.ok(byTestId('scan-match-best'), 'preview');
    assert.equal(useScanQuotaStore.getState().getRemaining(), remaining, 'no charge before an explicit add');
  });

  await test('while the result is on screen there are no probes', async () => {
    const t = takes();
    await probes(3);
    assert.equal(takes(), t);
  });

  await test('the same card left in the frame after closing the result is NOT scanned again', async () => {
    await click(byTestId('scan-match-retake'));
    await probes(4);
    assert.equal(bodies.length, 1, 'no second request for the card that was just scanned');
  });

  await test('removing the card re-arms; the next card held still is scanned once', async () => {
    frameText = '';
    await probes(2);
    frameText = 'hBP01-010';
    for (let i = 0; i < 50 && bodies.length === 1; i++) await tick(100);
    await tick(600);
    assert.equal(bodies.length, 2);
    await click(byTestId('scan-match-add'));
    await tick(50);
  });

  await test('the explicit add charges exactly once; automatic rounds charged nothing on their own', () => {
    assert.equal(useScanQuotaStore.getState().getRemaining(), 49);
    assert.equal(useScanSessionStore.getState().cardCount, 1);
  });

  await test('a service failure is NOT retried automatically: the panel waits for the user', async () => {
    await tick(5500); // the floating result card closes
    providerDown = true;
    frameText = '';
    await probes(2);
    frameText = 'hBP05-081';
    for (let i = 0; i < 50 && !byTestId('scan-service-failure'); i++) await tick(100);
    assert.ok(byTestId('scan-service-failure'), 'service panel');
    const t = takes(), n = bodies.length;
    await probes(4);
    assert.equal(takes(), t, 'no probes behind the panel');
    assert.equal(bodies.length, n, 'no automatic retry');
    await click(byTestId('scan-service-cancel'));
    providerDown = false;
  });

  await test('in the background nothing is probed; back in the foreground probing resumes', async () => {
    frameText = '';
    await appState('background');
    const t = takes();
    await probes(3);
    assert.equal(takes(), t, 'no camera use in the background');
    await appState('active');
    await probes(2);
    assert.ok(takes() > t, 'resumed');
  });

  await test('manual mode: the pill turns automatic capture off — a card in the frame is not captured', async () => {
    await click(byTestId('scan-mode-manual'));
    frameText = 'hBP02-033';
    const t = takes(), n = bodies.length;
    await probes(3);
    assert.equal(takes(), t);
    assert.equal(bodies.length, n);
    assert.ok(host.textContent.includes('點擊掃描按鈕拍攝卡牌'));
  });
} finally {
  await act(async () => root.unmount());
  host.remove();
}

if ((process.exitCode ?? 0) === 0) console.log(`\n✅ scan-native-auto-capture: ${passed} checks passed`);
else console.error('\n❌ scan-native-auto-capture failed');
process.exit();
