#!/usr/bin/env node
/**
 * v42 (CR 53bc745 FAIL; Android 41 user report "一直閃、不會偵測"): the SHIPPING Android
 * automatic-scan path — the native HoloHunterCardScanner view (CameraX preview + on-device
 * frame analysis, modules/holohunter-ocr-geometry) is PRESENT — on the REAL ScanScreen.
 * Frames arrive as native onFrameText events (fixture: scripts/fixtures/
 * native-frame-scanner-fixture.mjs, which models the Kotlin contract). Counted separately:
 * analysed frames delivered, still captures, probe files, recognition requests, charges.
 * No device, camera, ML Kit, provider or network. NOT a hardware test.
 * The still-photo probe fallback (module absent) stays covered by
 * test:scan-native-auto-capture.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import { JSDOM } from 'jsdom';
import { FrameScannerView } from './fixtures/native-frame-scanner-fixture.mjs';
let scannerModulePresent = true;

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
    requireNativeViewManager: (n) => (n === 'HoloHunterCardScanner' ? FrameScannerView : null),
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
const { FRAME_ANALYSIS_INTERVAL_MS } = await import('../src/services/nativeCardScanner.ts');

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
const appState = async (next) => { await act(async () => { globalThis.__setAppState(next); await Promise.resolve(); }); };
const settle = async (before) => { for (let i = 0; i < 60 && bodies.length === before; i++) await tick(20); await tick(150); };
const fs_ = globalThis.__frameScanner;
const stills = () => fs_.stills;

// An analysed upright frame (portrait, like a phone held upright) and where the scan frame
// lies in it — computed with the SAME cover-fit mapping the screen uses.
const FW = 960, FH = 1280;
const crop = planNativeCrop(PREVIEW, FRAME, { width: FW, height: FH }).crop;
const px = (nb) => ({ x: Math.round(crop.x + nb.x * crop.width), y: Math.round(crop.y + nb.y * crop.height), width: Math.round(nb.width * crop.width), height: Math.round(nb.height * crop.height) });
const STEADY = { x: 0.1, y: 0.86, width: 0.22, height: 0.04 };
let seq = 0;
const frame = (text, nb = STEADY, { grouped = false } = {}) => {
  if (!text) return { seq: ++seq, width: FW, height: FH, blocks: [] };
  const num = px(nb);
  const numberLine = { text, boundingBox: num, elements: [{ text, boundingBox: num }] };
  if (!grouped) return { seq: ++seq, width: FW, height: FH, blocks: [{ text, boundingBox: num, lines: [numberLine] }] };
  const above = { x: num.x, y: num.y - 4 * num.height, width: Math.round(num.width * 1.1), height: num.height };
  return { seq: ++seq, width: FW, height: FH, blocks: [{ text: `illustrator text\n${text}`,
    boundingBox: { x: num.x, y: above.y, width: above.width, height: num.y + num.height - above.y },
    lines: [{ text: 'illustrator text', boundingBox: above, elements: [] }, numberLine] }] };
};
const emit = async (payload, n = 1) => { for (let i = 0; i < n; i++) { await act(async () => { globalThis.__emitFrame(payload); await Promise.resolve(); }); await tick(5); } };
const emitInFlight = async (payload) => { await act(async () => { globalThis.__emitFrameInFlight(payload); await Promise.resolve(); }); await tick(5); };

usePhotoUploadConsentStore.setState({ acceptedVersion: PHOTO_UPLOAD_DISCLOSURE_VERSION });
useScanQuotaStore.getState().resetQuota();
useScanSessionStore.getState().clearSession();
const navListeners = { focus: new Set(), blur: new Set() };
let navFocused = true;
const navigation = {
  navigate() {}, goBack() {}, openDrawer() {}, isFocused: () => navFocused,
  addListener: (ev, cb) => { navListeners[ev]?.add(cb); return () => navListeners[ev]?.delete(cb); },
};
const navEvent = async (ev) => { navFocused = ev === 'focus'; await act(async () => { for (const cb of [...navListeners[ev]]) cb(); await Promise.resolve(); }); await tick(10); };
const host = document.createElement('div');
document.body.appendChild(host);
const root = createRoot(host);
await act(async () => root.render(React.createElement(ScanScreen, { navigation })));
await tick(50);
await emit(frame(''));                                  // first frame: geometry measured

try {
  await test('shipping Android path: the native frame-scanner view is mounted (not expo-camera); analysis active once ready; bounded interval; no torch', () => {
    assert.ok(byTestId('scan-frame-scanner'), 'frame scanner rendered');
    assert.equal(byTestId('native-camera-fixture'), null, 'expo-camera CameraView not mounted in automatic mode');
    assert.equal(fs_.mounts, 1);
    assert.equal(fs_.props.active, true);
    assert.equal(fs_.props.analysisIntervalMs, FRAME_ANALYSIS_INTERVAL_MS);
    assert.ok(FRAME_ANALYSIS_INTERVAL_MS >= 250);
    assert.equal(fs_.props.torch, false);
  });

  await test('no card: 12 analysed frames → 0 still photos, 0 probe files, 0 recognition requests (frames ARE analysed — not "zero camera activity")', async () => {
    const d = fs_.delivered;
    await emit(frame(''), 12);
    assert.equal(fs_.delivered, d + 12, 'frames reached the screen');
    assert.equal(stills(), 0);
    assert.equal(globalThis.__nativeCameraTakes ?? 0, 0, 'expo-camera never captured');
    assert.equal(manipulations.length, 0, 'no image files made');
    assert.equal(deleted.length, 0);
    assert.equal(bodies.length, 0);
  });

  await test('a card number MOVING through the frame → no still, no request', async () => {
    for (let i = 0; i < 8; i++) await emit(frame('hBP01-010', { ...STEADY, x: 0.05 + i * 0.08 }));
    assert.equal(stills(), 0);
    assert.equal(bodies.length, 0);
  });

  await test('a number only in the crop margin (outside the frame) → no still', async () => {
    await emit(frame('hBP01-010', { x: 0.1, y: 0.975, width: 0.22, height: 0.02 }), 4);
    assert.equal(stills(), 0);
  });

  await test('held still inside the frame → exactly ONE still capture + ONE recognition request, preview only (nothing charged); analysis switched off', async () => {
    await emit(frame(''), 3);                           // re-armed after the margin readings
    const remaining = useScanQuotaStore.getState().getRemaining();
    await emit(frame('hBP01-010'), 2);
    await settle(0);
    assert.equal(stills(), 1, 'one still');
    assert.deepEqual(fs_.stillCalls[0], { quality: 0.7, base64: true }, 'the normal recognition still');
    assert.equal(bodies.length, 1, 'one request');
    assert.ok(byTestId('scan-match-best'), 'preview shown');
    assert.equal(useScanQuotaStore.getState().getRemaining(), remaining, 'no charge before 加入');
    assert.equal(fs_.props.active, false, 'no frame analysis while the result is on screen');
  });

  await test('result on screen: frames are not delivered; even a late in-flight frame does not capture again', async () => {
    await emit(frame('hBP01-010'), 4);
    await emitInFlight(frame('hBP01-010'));
    await emitInFlight(frame('hBP01-010'));
    assert.equal(stills(), 1);
    assert.equal(bodies.length, 1);
  });

  await test('result closed, the same card still in the frame → NOT scanned again', async () => {
    await click(byTestId('scan-match-retake'));
    await tick(20);
    assert.equal(fs_.props.active, true);
    await emit(frame('hBP01-010'), 6);
    assert.equal(stills(), 1);
    assert.equal(bodies.length, 1);
  });

  await test('removed (3 frames without it) and a card placed → one new still + request; 加入 charges exactly 1', async () => {
    await emit(frame(''), 3);
    providerText = 'CARD_NUMBER: hSD01-003\nCHARACTER: ときのそら\nRARITY: C';
    await emit(frame('hSD01-003'), 2);
    await settle(1);
    assert.equal(stills(), 2);
    assert.equal(bodies.length, 2);
    const remaining = useScanQuotaStore.getState().getRemaining();
    await click(byTestId('scan-match-add'));
    await tick(30);
    assert.equal(useScanQuotaStore.getState().getRemaining(), remaining - 1);
    await tick(5500);                                   // the floating result card closes
  });

  await test('service failure: short reason + 重試／取消, NO automatic retry from frames; 重試 resends the same photo (no new still); 取消 ends it (0 charge)', async () => {
    await emit(frame(''), 3);
    providerDown = true;
    const remaining = useScanQuotaStore.getState().getRemaining();
    await emit(frame('hBP03-024'), 2);
    await settle(2);
    assert.ok(byTestId('scan-service-failure'), 'service panel');
    assert.equal(stills(), 3);
    assert.equal(bodies.length, 3);
    await emit(frame('hBP03-024'), 4);
    await emitInFlight(frame('hBP03-024'));
    assert.equal(bodies.length, 3, 'no automatic retry');
    await click(byTestId('scan-service-retry'));
    await settle(3);
    assert.equal(bodies.length, 4, 'manual retry = one request');
    assert.equal(stills(), 3, 'with the photo already taken');
    await click(byTestId('scan-service-cancel'));
    await tick(20);
    assert.equal(byTestId('scan-service-failure'), null);
    assert.equal(useScanQuotaStore.getState().getRemaining(), remaining, 'failure + retry + cancel use 0');
    providerDown = false;
  });

  await test('no match → 「辨識失敗，請再試一次」 + 重試／取消; 取消 with the card still there → no request; 重試 → one NEW still + request', async () => {
    providerText = 'CARD_NUMBER: NONE\nCHARACTER: NONE\nTITLE: NONE';
    await emit(frame(''), 3);
    await emit(frame('hBP04-013'), 2);
    await settle(4);
    assert.ok(byTestId('scan-match-none')?.textContent.includes('辨識失敗，請再試一次'));
    assert.equal(stills(), 4);
    await click(byTestId('scan-match-cancel'));
    await tick(20);
    await emit(frame('hBP04-013'), 6);
    assert.equal(bodies.length, 5, 'no request after 取消 while the card stays');
    providerText = 'CARD_NUMBER: hBP01-010\nCHARACTER: 天音かなた';
    await emit(frame(''), 3);
    providerText = 'CARD_NUMBER: NONE\nCHARACTER: NONE\nTITLE: NONE';
    await emit(frame('hBP04-014'), 2);
    await settle(5);
    assert.ok(byTestId('scan-match-none'));
    await click(byTestId('scan-match-retry'));
    await settle(6);
    assert.equal(stills(), 6, 'retry took a new still through the frame scanner');
    assert.equal(bodies.length, 7);
    await click(byTestId('scan-match-cancel'));
    providerText = 'CARD_NUMBER: hBP01-010\nCHARACTER: 天音かなた';
  });

  await test('background: analysis off; a frame already in flight with a steady card does NOT capture; foreground → analysis back on', async () => {
    await emit(frame(''), 3);
    const s = stills(), n = bodies.length;
    await appState('background');
    await tick(10);
    assert.equal(fs_.props.active, false, 'analysis off in the background');
    await emitInFlight(frame('hBP05-001'));
    await emitInFlight(frame('hBP05-001'));
    assert.equal(stills(), s);
    assert.equal(bodies.length, n);
    await appState('active');
    await tick(10);
    assert.equal(fs_.props.active, true);
  });

  await test('blur: analysis off and late frames dropped; focus again → a held card is captured once', async () => {
    await emit(frame(''), 3);
    const s = stills(), n = bodies.length;
    await navEvent('blur');
    assert.equal(fs_.props.active, false);
    await emitInFlight(frame('hBP05-002'));
    await emitInFlight(frame('hBP05-002'));
    assert.equal(stills(), s);
    await navEvent('focus');
    assert.equal(fs_.props.active, true);
    await emit(frame(''), 3);
    await emit(frame('hBP05-002'), 2);
    await settle(n);
    assert.equal(stills(), s + 1);
    assert.equal(bodies.length, n + 1);
    await click(byTestId('scan-match-retake'));
    await emit(frame(''), 3);
  });

  await test('ML Kit grouping the held number with the line above on alternate frames still triggers ONE capture (number element box measured)', async () => {
    const s = stills(), n = bodies.length;
    for (let i = 0; i < 2; i++) await emit(frame('hBP05-003', STEADY, { grouped: i % 2 === 0 }));
    await settle(n);
    assert.equal(stills(), s + 1);
    assert.equal(bodies.length, n + 1);
    await click(byTestId('scan-match-retake'));
    await emit(frame(''), 3);
  });

  await test('flash in automatic mode = continuous torch on the frame scanner (no capture flash exists on this path)', async () => {
    await click(byTestId('scan-top-bar-flash'));
    await tick(20);
    assert.equal(fs_.props.torch, true);
    await click(byTestId('scan-top-bar-flash'));
    await tick(20);
    assert.equal(fs_.props.torch, false);
  });

  await test('manual mode: the frame scanner is released (unmounted, no more frames) and expo-camera serves the shutter as before', async () => {
    const before = fs_.unmounts;
    await click(byTestId('scan-mode-manual'));
    await tick(50);
    assert.equal(fs_.unmounts, before + 1, 'native view destroyed → release()');
    assert.equal(byTestId('scan-frame-scanner'), null);
    assert.ok(byTestId('native-camera-fixture'), 'expo-camera for manual mode');
    assert.equal(globalThis.__emitFrame(frame('hBP01-010')), false, 'a released scanner delivers nothing');
    await click(byTestId('scan-mode-auto'));
    await tick(50);
    assert.ok(byTestId('scan-frame-scanner'), 'back in automatic mode');
  });
} finally {
  await act(async () => root.unmount());
  host.remove();
}
await test('unmount: the frame scanner is released and delivers nothing afterwards', () => {
  assert.equal(fs_.unmounts, fs_.mounts);
  assert.equal(globalThis.__emitFrame(frame('hBP01-010')), false);
});

if ((process.exitCode ?? 0) === 0) console.log(`\n✅ scan-android-frame-scanner: ${passed} checks passed`);
else console.error('\n❌ scan-android-frame-scanner failed');
