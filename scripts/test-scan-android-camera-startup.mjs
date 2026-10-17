#!/usr/bin/env node
/**
 * v43 P0 (user device 2026-10-18: 「為什麼自動掃描沒開相機」): CAMERA STARTUP on the SHIPPING
 * Android automatic path — the HoloHunterCardScanner module is PRESENT — on the REAL
 * ScanScreen, from the first entry: permission granted / unknown → granted / denied,
 * mount → ready (= the preview streams), a preview that NEVER streams (the v42 device
 * symptom: no event at all), a native start error, retry, the manual camera, background /
 * foreground. Readiness is not mocked into existence: with __frameScannerStartMode='stall'
 * the native stand-in sends nothing, exactly like a 0×0 preview surface.
 * Fixtures model the Kotlin contract (pinned statically by test:scan-ocr-geometry).
 * No device, camera, CameraX, ML Kit, provider or network. NOT a hardware test.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import { JSDOM } from 'jsdom';
import { FrameScannerView } from './fixtures/native-frame-scanner-fixture.mjs';
let scannerModulePresent = true;
let viewManagerThrows = false;   // the view manager fails to load (module registered, view not)

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
let ocrThrows = false;
// Hold the on-device reader (a probe stays in flight until released).
let ocrHold = null;
const holdReader = () => { let release; const p = new Promise((r) => { release = r; }); ocrHold = p; return () => { ocrHold = null; release(); }; };
// Where the printed number sits in the probe crop (normalised); a steady, in-frame spot
// unless a test moves it. A function lets a test move it on every probe.
let numberBox = () => ({ x: 0.1, y: 0.86, width: 0.22, height: 0.04 });
// v42 (PM BLOCK_GROUPING_REPRO): the SAME printed number, alternately grouped by ML Kit
// with the line above it into one block, or standalone. Number line/element: fixed.
let alternateGrouping = false;
let geometryOn = false;
let groupingParity = 0;
const geometryCalls = [];
const groupedFrame = (uri) => {
  const d = cropDims.get(uri) ?? { w: 900, h: 1200 };
  const b = numberBox();
  const num = { x: Math.round(b.x * d.w), y: Math.round(b.y * d.h), width: Math.round(b.width * d.w), height: Math.round(b.height * d.h) };
  const grouped = (groupingParity++ % 2) === 0;
  const above = { x: num.x, y: num.y - 4 * num.height, width: Math.round(num.width * 1.1), height: num.height };
  const numberLine = { text: frameText, boundingBox: num, elements: [{ text: frameText, boundingBox: num }] };
  return grouped
    ? { text: `illustrator text\n${frameText}`, boundingBox: { x: num.x, y: above.y, width: above.width, height: num.y + num.height - above.y },
      lines: [{ text: 'illustrator text', boundingBox: above, elements: [] }, numberLine] }
    : { text: frameText, boundingBox: num, lines: [numberLine] };
};
const cropDims = new Map();
const ocrCalls = [];
const manipulations = [];
const deleted = [];
let cropSeq = 0;
globalThis.__nativeCameraUniqueUris = true;
globalThis.require = (name) => {
  if (name === 'expo-file-system/legacy') return { deleteAsync: async (uri) => { deleted.push(uri); } };
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
                const n = ++cropSeq;
                const outUri = isCrop ? `file:///cache/ImageManipulator/frame-${n}.jpg` : `file:///cache/ImageManipulator/full-${n}.jpg`;
                // Report the saved size like the real manipulator does.
                const c = ops.find((x) => x[0] === 'crop')?.[1];
                const r = ops.find((x) => x[0] === 'resize')?.[1];
                let w = c ? c.width : 3024, h = c ? c.height : 4032;
                if (r?.width) { h = Math.round(h * r.width / w); w = r.width; } else if (r?.height) { w = Math.round(w * r.height / h); h = r.height; }
                cropDims.set(outUri, { w, h });
                return { base64: o?.base64 ? (isCrop ? CROP_B64 : FULL_B64) : undefined, uri: outUri, width: w, height: h };
              } };
            },
          };
          return ctx;
        },
      },
    };
  }
  if (name === 'expo-ocr-kit') return { recognizeText: async (uri) => {
    ocrCalls.push(uri);
    if (ocrHold) await ocrHold;
    if (ocrThrows) throw new Error('reader crashed');
    if (alternateGrouping && frameText) {
      const f = groupedFrame(uri);
      return { text: f.text, blocks: [{ text: f.text, boundingBox: f.boundingBox }] };   // block-only export (v41 native)
    }
    const d = cropDims.get(uri) ?? { w: 900, h: 1200 };
    const b = numberBox();
    const blocks = frameText ? [{ text: frameText, boundingBox: { x: Math.round(b.x * d.w), y: Math.round(b.y * d.h), width: Math.round(b.width * d.w), height: Math.round(b.height * d.h) } }] : [];
    return { text: frameText, blocks };
  } };
  // v42: the local native module modules/holohunter-ocr-geometry, reached through
  // expo-modules-core like on a device; only exposed when a test turns it on.
  if (name === 'expo-modules-core') return {
    requireNativeViewManager: (n) => {
      if (n === 'HoloHunterCardScanner' && viewManagerThrows) throw new Error("Unable to find the 'HoloHunterCardScanner' view manager");
      return n === 'HoloHunterCardScanner' ? FrameScannerView : null;
    },
    requireOptionalNativeModule: (n) => (n === 'HoloHunterCardScanner' && scannerModulePresent ? {} : n === 'HoloHunterOcrGeometry' && geometryOn ? {
      recognizeGeometry: async (uri) => {
        geometryCalls.push(uri);
        ocrCalls.push(uri);
        if (!frameText) return { text: '', blocks: [] };
        const f = groupedFrame(uri);
        return { text: f.text, blocks: [{ text: f.text, boundingBox: f.boundingBox, lines: f.lines }] };
      },
    } : null),
  };
  throw new Error(`unexpected require ${name}`);
};
globalThis.__nativeCameraPhoto = { uri: 'file:///cache/Camera/shot.jpg', width: 3024, height: 4032, base64: jpeg('original') };
globalThis.__frameScannerStillBase64 = jpeg('still');

const DB = JSON.parse(fs.readFileSync(new URL('../public/data/database.json', import.meta.url), 'utf8'));
const handler = (await import('../api/recognize-card.ts')).default;
process.env.GEMINI_API_KEY = 'test-key-never-sent';
let providerDown = false;
const bodies = [];
let providerText = 'CARD_NUMBER: hBP01-010\nCHARACTER: 天音かなた';
globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (href === 'https://holohunter.dicoge.com/data/database.json') return Response.json(DB);
  if (href.includes('generativelanguage.googleapis.com')) {
    if (providerDown) return new Response('down', { status: 500 });
    return Response.json({ candidates: [{ content: { parts: [{ text: providerText }] } }] });
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
const { planNativeCrop } = await import('../src/utils/scanFrame.ts');
const { usePhotoUploadConsentStore } = await import('../src/store/photoUploadConsentStore.ts');
const { PHOTO_UPLOAD_DISCLOSURE_VERSION } = await import('../src/services/photoUploadDisclosure.ts');
const { useScanQuotaStore } = await import('../src/store/scanQuotaStore.ts');
const { useScanSessionStore } = await import('../src/stores/scanSessionStore.ts');
const { FRAME_ANALYSIS_INTERVAL_MS, frameCropInFrame } = await import('../src/services/nativeCardScanner.ts');
const { DEFAULT_FRAME_REGION } = await import('../src/services/autoCapture.ts');


const { FRAME_SCANNER_STARTUP_TIMEOUT_MS } = await import('../src/services/nativeCardScanner.ts');
let passed = 0;
async function test(label, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (err) { process.exitCode = 1; console.error(`  ✗ ${label} — ${err.message}`); }
  finally { await unmountScreen(); }
}
const tick = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const byTestId = (id) => document.querySelector(`[data-testid="${id}"]`);
const text = () => document.body.textContent;
const click = async (el) => {
  assert.ok(el, 'element exists');
  await act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); await Promise.resolve(); });
};
const appState = async (next) => { await act(async () => { globalThis.__setAppState(next); await Promise.resolve(); }); await tick(10); };
const fs_ = globalThis.__frameScanner;
const takes = () => globalThis.__nativeCameraTakes ?? 0;
const INIT = '相機初始化中';
const FAILED = '相機未能啟動';

usePhotoUploadConsentStore.setState({ acceptedVersion: PHOTO_UPLOAD_DISCLOSURE_VERSION });
useScanQuotaStore.getState().resetQuota();
useScanSessionStore.getState().clearSession();
const navigation = { navigate() {}, goBack() {}, openDrawer() {}, isFocused: () => true, addListener: () => () => {} };
let root = null, host = null;
const mountScreen = async () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(React.createElement(ScanScreen, { navigation })));
  await tick(50);
};
async function unmountScreen() {
  if (root) { await act(async () => root.unmount()); host.remove(); root = null; }
  delete globalThis.__cameraPermission;
  delete globalThis.__cameraPermissionAnswer;
  globalThis.__cameraPermissionRequests = 0;
  globalThis.__frameScannerStartMode = undefined;
  globalThis.__frameScannerFailMount = false;
  globalThis.__setAppState('active');
}
// Nothing may be captured or sent while the camera is starting / failing.
const assertNoCapture = (base) => {
  assert.equal(fs_.stills, base.stills, 'no still from the frame scanner');
  assert.equal(takes(), base.takes, 'no expo-camera still');
  assert.equal(bodies.length, base.requests, 'no recognition request');
};
const baseline = () => ({ stills: fs_.stills, takes: takes(), requests: bodies.length });
const manualShutterWorks = async () => {
  const t0 = takes(), n = bodies.length;
  await click(byTestId('scan-primary-action'));
  for (let i = 0; i < 60 && bodies.length === n; i++) await tick(20);
  assert.equal(takes(), t0 + 1, 'the manual camera takes the photo');
  assert.equal(bodies.length, n + 1, 'one recognition request');
};

await test('granted at entry: the automatic camera mounts, its preview streams → ready (no 「相機初始化中」), analysis on; no error and NO capture over the startup window', async () => {
  const base = baseline(), mounts = fs_.mounts;
  await mountScreen();
  assert.ok(byTestId('scan-frame-scanner'), 'automatic camera (frame scanner) mounted');
  assert.equal(fs_.mounts, mounts + 1);
  assert.ok(!text().includes(INIT), 'preview shown');
  assert.equal(fs_.props.active, true);
  await tick(FRAME_SCANNER_STARTUP_TIMEOUT_MS + 300);
  assert.ok(!text().includes(FAILED), 'a streaming preview is never declared failed');
  assertNoCapture(base);
});

await test('permission unknown at entry → asked once → granted: the automatic camera mounts and becomes ready', async () => {
  globalThis.__cameraPermission = null;
  globalThis.__cameraPermissionAnswer = { granted: true, canAskAgain: true, status: 'granted' };
  const mounts = fs_.mounts;
  await mountScreen();
  await tick(50);
  assert.equal(globalThis.__cameraPermissionRequests, 1, 'asked at entry');
  assert.ok(byTestId('scan-frame-scanner'));
  assert.equal(fs_.mounts, mounts + 1);
  assert.ok(!text().includes(INIT));
  assert.equal(fs_.props.active, true);
});

await test('permission denied: no camera is mounted, the permission screen explains it; granting from there mounts the automatic camera → ready', async () => {
  const denied = { granted: false, canAskAgain: true, status: 'denied' };
  globalThis.__cameraPermission = denied;
  globalThis.__cameraPermissionAnswer = denied;
  const mounts = fs_.mounts, base = baseline();
  await mountScreen();
  assert.ok(byTestId('camera-permission-denied'), 'permission screen');
  assert.ok(!byTestId('scan-frame-scanner') && !byTestId('native-camera-fixture'), 'no camera without permission');
  assert.equal(fs_.mounts, mounts);
  globalThis.__cameraPermissionAnswer = { granted: true, canAskAgain: true, status: 'granted' };
  await click(byTestId('camera-permission-request'));
  await tick(50);
  assert.ok(byTestId('scan-frame-scanner'));
  assert.ok(!text().includes(INIT));
  assertNoCapture(base);
});

await test('preview never streams (v42 device symptom): 「相機初始化中」 only for a bounded time, then 「相機未能啟動」 + 重試 + 改用手動拍照; nothing captured or sent meanwhile', async () => {
  globalThis.__frameScannerStartMode = 'stall';
  const base = baseline();
  await mountScreen();
  assert.ok(text().includes(INIT));
  await tick(FRAME_SCANNER_STARTUP_TIMEOUT_MS - 1500);
  assert.ok(!text().includes(FAILED), 'not declared failed early');
  await tick(1800);
  assert.ok(text().includes(FAILED), 'start failure shown');
  assert.ok(byTestId('scan-camera-retry'), '重試');
  assert.ok(byTestId('scan-camera-manual'), '改用手動拍照');
  assert.equal(fs_.props.active, false, 'no analysis without a preview');
  assertNoCapture(base);
});

await test('start failure → 改用手動拍照: the manual camera (expo-camera) mounts, is ready, and its shutter takes ONE photo + ONE request', async () => {
  globalThis.__frameScannerStartMode = 'stall';
  await mountScreen();
  await tick(FRAME_SCANNER_STARTUP_TIMEOUT_MS + 300);
  const unmounts = fs_.unmounts;
  await click(byTestId('scan-camera-manual'));
  await tick(50);
  assert.equal(fs_.unmounts, unmounts + 1, 'the stalled automatic camera is released');
  assert.ok(byTestId('native-camera-fixture'), 'manual camera');
  assert.ok(!text().includes(FAILED) && !text().includes(INIT), 'manual camera ready');
  await manualShutterWorks();
});

await test('start failure → 重試: a fresh native view; when its preview streams it is ready, analysis on, no error — retry is only on the tap', async () => {
  globalThis.__frameScannerStartMode = 'stall';
  const mounts = fs_.mounts, base = baseline();
  await mountScreen();
  await tick(FRAME_SCANNER_STARTUP_TIMEOUT_MS + 300);
  assert.equal(fs_.mounts, mounts + 1, 'no automatic remount');
  globalThis.__frameScannerStartMode = undefined;
  await click(byTestId('scan-camera-retry'));
  await tick(50);
  assert.equal(fs_.mounts, mounts + 2, 'one fresh view');
  assert.ok(!text().includes(FAILED) && !text().includes(INIT));
  assert.equal(fs_.props.active, true);
  assertNoCapture(base);
});

await test('native start error (critical camera error) → the short message (not the native one) + 重試 + 改用手動拍照; manual works', async () => {
  globalThis.__frameScannerFailMount = true;
  await mountScreen();
  assert.ok(text().includes(FAILED));
  assert.ok(!text().includes('Camera error'), 'native detail stays out of the UI');
  assert.ok(byTestId('scan-camera-manual'));
  await click(byTestId('scan-camera-manual'));
  await tick(50);
  assert.ok(byTestId('native-camera-fixture'));
  await manualShutterWorks();
});

await test('background before the preview streams: no failure is declared while away; back in front the wait restarts and a streaming preview is ready', async () => {
  globalThis.__frameScannerStartMode = 'stall';
  await mountScreen();
  await tick(2000);
  await appState('background');
  await tick(FRAME_SCANNER_STARTUP_TIMEOUT_MS + 300);
  assert.ok(!text().includes(FAILED), 'nothing declared while in the background');
  await appState('active');
  await tick(FRAME_SCANNER_STARTUP_TIMEOUT_MS - 1500);
  assert.ok(!text().includes(FAILED), 'the wait restarted on foreground');
  await act(async () => { globalThis.__frameScannerStream(); await Promise.resolve(); });
  await tick(20);
  assert.ok(!text().includes(INIT), 'preview streams → ready');
  await tick(1800);
  assert.ok(!text().includes(FAILED));
  assert.equal(fs_.props.active, true);
});

await test('ready, then background → foreground: the preview stays ready (no 「相機初始化中」, no failure), analysis back on, nothing captured', async () => {
  const base = baseline();
  await mountScreen();
  assert.equal(fs_.props.active, true);
  await appState('background');
  assert.equal(fs_.props.active, false);
  await appState('active');
  assert.equal(fs_.props.active, true);
  await tick(FRAME_SCANNER_STARTUP_TIMEOUT_MS + 300);
  assert.ok(!text().includes(INIT) && !text().includes(FAILED));
  assertNoCapture(base);
});

// ── CR c5acd45: a CRITICAL camera error AFTER the preview streamed ──
const STOPPED = '相機已停止運作';
const FW = 960, FH = 1280;
const crop = planNativeCrop(PREVIEW, FRAME, { width: FW, height: FH }).crop;
const STEADY = { x: 0.1, y: 0.86, width: 0.22, height: 0.04 };
let seq = 0;
const frame = (txt) => {
  if (!txt) return { seq: ++seq, width: FW, height: FH, blocks: [] };
  const b = { x: Math.round(crop.x + STEADY.x * crop.width), y: Math.round(crop.y + STEADY.y * crop.height), width: Math.round(STEADY.width * crop.width), height: Math.round(STEADY.height * crop.height) };
  return { seq: ++seq, width: FW, height: FH, blocks: [{ text: txt, boundingBox: b, lines: [{ text: txt, boundingBox: b, elements: [{ text: txt, boundingBox: b }] }] }] };
};
const emit = async (payload, n = 1) => { let r; for (let i = 0; i < n; i++) { await act(async () => { r = globalThis.__emitFrame?.(payload); await Promise.resolve(); }); await tick(5); } return r; };
const settleRequests = async (n) => { for (let i = 0; i < 60 && bodies.length === n; i++) await tick(20); await tick(150); };
const failurePanel = (msg) => {
  assert.ok(text().includes(msg), `「${msg}」 shown`);
  assert.ok(byTestId('scan-camera-retry'), '重試');
  assert.ok(byTestId('scan-camera-manual'), '改用手動拍照');
};
const streamingThenSteady = async () => {
  await mountScreen();
  assert.ok(!text().includes(INIT), 'streaming → ready');
  await emit(frame(''));                                  // geometry measured
  await emit(frame('hBP01-010'));                         // ONE steady observation
};

await test('streaming → ready → CRITICAL camera error: 「相機已停止運作」 + 重試 + 改用手動拍照, analysis off; an analysis started before the error and delivered in the SAME batch → no still, no request', async () => {
  await streamingThenSteady();
  const base = baseline(), attempts = fs_.stillAttempts ?? 0;
  const late = globalThis.__startFrameUnguarded(frame('hBP01-010'));   // 2nd steady frame in ML Kit
  await act(async () => { globalThis.__frameScannerCriticalError(); late(); await Promise.resolve(); });
  await tick(200);
  failurePanel(STOPPED);
  assert.equal(fs_.stillAttempts ?? 0, attempts, 'the screen did not even ask the failed camera for a still');
  assert.ok(!text().includes('辨識失敗'), 'no recognition-failure banner');
  assert.equal(fs_.props.active, false, 'analysis off');
  assertNoCapture(base);
  assert.equal(await emit(frame('hBP01-010'), 3), false, 'the failed view analyses nothing');
  await tick(FRAME_SCANNER_STARTUP_TIMEOUT_MS + 300);
  failurePanel(STOPPED);
  assertNoCapture(base);
});

await test('after the error: a late ready (even forced past the native latch) cannot clear it; late frames take no photo', async () => {
  await streamingThenSteady();
  const base = baseline();
  await act(async () => { globalThis.__frameScannerCriticalError(); await Promise.resolve(); });
  await tick(20);
  assert.equal(globalThis.__frameScannerStream(), false, 'native latch: no ready after a failure');
  await act(async () => { globalThis.__frameScannerStream({ force: true }); await Promise.resolve(); });
  await tick(20);
  failurePanel(STOPPED);
  assert.equal(fs_.props.active, false, 'still no analysis');
  for (let i = 0; i < 3; i++) await act(async () => { globalThis.__startFrameUnguarded(frame('hBP01-010'))(); await Promise.resolve(); });
  await tick(200);
  assertNoCapture(base);
});

await test('the camera fails while the still is pending: the scan is cancelled (no request, 0 charge, no 辨識失敗), the camera panel is shown', async () => {
  globalThis.__frameScannerCaptureMode = 'deferred';
  try {
    await streamingThenSteady();
    const remaining = useScanQuotaStore.getState().getRemaining(), n = bodies.length, s = fs_.stills;
    await emit(frame('hBP01-010'));                       // 2nd steady → trigger → still pending
    await tick(20);
    assert.equal(fs_.stills, s + 1, 'still requested');
    await act(async () => { globalThis.__frameScannerCriticalError(); await Promise.resolve(); });
    await tick(200);
    failurePanel(STOPPED);
    assert.ok(!text().includes('辨識失敗'), 'a camera failure is not a recognition failure');
    assert.equal(bodies.length, n, 'no request');
    assert.equal(useScanQuotaStore.getState().getRemaining(), remaining, '0 charge');
  } finally {
    globalThis.__frameScannerCaptureMode = 'immediate';
    fs_.pending.length = 0;
  }
});

await test('post-ready failure → 重試: ONE new mount, it streams → ready, analysis on; two fresh steady frames → exactly one still + one request', async () => {
  await streamingThenSteady();
  await act(async () => { globalThis.__frameScannerCriticalError(); await Promise.resolve(); });
  await tick(20);
  const mounts = fs_.mounts;
  await click(byTestId('scan-camera-retry'));
  await tick(50);
  assert.equal(fs_.mounts, mounts + 1, 'a new native view');
  assert.ok(!text().includes(STOPPED) && !text().includes(INIT), 'ready again');
  assert.equal(fs_.props.active, true);
  const s = fs_.stills, n = bodies.length;
  await emit(frame(''));
  await emit(frame('hBP01-010'));
  await tick(50);
  assert.equal(fs_.stills, s, 'one fresh frame is not enough');
  await emit(frame('hBP01-010'));
  await settleRequests(n);
  assert.equal(fs_.stills, s + 1, 'exactly one still');
  assert.equal(bodies.length, n + 1, 'exactly one request');
});

await test('post-ready failure → 改用手動拍照: the manual camera mounts, is ready, and its shutter works', async () => {
  await streamingThenSteady();
  await act(async () => { globalThis.__frameScannerCriticalError(); await Promise.resolve(); });
  await tick(20);
  const unmounts = fs_.unmounts;
  await click(byTestId('scan-camera-manual'));
  await tick(50);
  assert.equal(fs_.unmounts, unmounts + 1, 'the failed automatic camera is released');
  assert.ok(byTestId('native-camera-fixture'));
  assert.ok(!text().includes(STOPPED) && !text().includes(INIT));
  await manualShutterWorks();
});

// ── CR dee6f4b: Android WITHOUT a loadable frame scanner → manual only, never periodic stills ──
const { AUTO_CAPTURE_PROBE_INTERVAL_MS } = await import('../src/services/autoCapture.ts');
const UNAVAILABLE = '此裝置無法自動偵測';
const androidWithoutScanner = (label, setup) => test(label, async () => {
  setup(true);
  try {
    const { Platform } = await import('react-native');
    assert.equal(Platform.OS, 'android');
    frameText = 'hBP01-010';                       // a readable number would be "seen" by any probe
    const base = baseline(), ocr0 = ocrCalls.length, man0 = manipulations.length, mounts = fs_.mounts;
    const attempts0 = fs_.stillAttempts ?? 0, calls0 = (globalThis.__nativeCameraCalls ?? []).length;
    await mountScreen();
    await tick(AUTO_CAPTURE_PROBE_INTERVAL_MS * 3 + 300);            // three legacy probe ticks
    console.log(`    COUNTS ${JSON.stringify({ stillAttempts: takes() - base.takes, ocr: ocrCalls.length - ocr0, crops: manipulations.length - man0, requests: bodies.length - base.requests })}`);
    assert.equal(takes(), base.takes, 'NO periodic still (expo-camera take attempts)');
    assert.equal((globalThis.__nativeCameraCalls ?? []).length, calls0, 'takePictureAsync never called');
    assert.equal(fs_.stillAttempts ?? 0, attempts0);
    assert.equal(ocrCalls.length, ocr0, 'NO on-device OCR probe');
    assert.equal(manipulations.length, man0, 'NO probe crop file');
    assert.equal(bodies.length, base.requests, 'NO recognition request');
    assert.equal(fs_.mounts, mounts, 'no frame scanner mounted');
    assert.ok(byTestId('native-camera-fixture'), 'the manual camera (expo-camera) is mounted');
    assert.ok(!text().includes(INIT), 'manual camera ready');
    assert.ok(byTestId('scan-hint')?.textContent.includes(UNAVAILABLE), 'explains that automatic detection is unavailable');
    assert.ok(!byTestId('scan-mode-pill'), 'no automatic mode offered');
    await manualShutterWorks();                                     // the shutter goes through the expo-camera ref
  } finally {
    setup(false);
    frameText = '';
  }
});
await androidWithoutScanner('Android, scanner view manager THROWS while OCR + ImageManipulator are installed: manual camera + 「此裝置無法自動偵測」, 0 still attempts / 0 OCR / 0 requests over 3 probe intervals; the manual shutter works', (on) => { viewManagerThrows = on; });
await androidWithoutScanner('Android, scanner module absent while OCR + ImageManipulator are installed: same — manual only, no periodic stills', (on) => { scannerModulePresent = !on; });

if ((process.exitCode ?? 0) === 0) console.log(`\n✅ scan-android-camera-startup: ${passed} checks passed`);
else console.error('\n❌ scan-android-camera-startup failed');
