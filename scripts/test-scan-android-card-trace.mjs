#!/usr/bin/env node
/**
 * v44 P0 (user: "the camera is on the card and steady, but it never scans"): the 21
 * prepared frame traces (scripts/fixtures/v44-card-frames, number-free synthetic card
 * images) through the REAL ScanScreen with the Android frame-scanner module present.
 * Each frame is the decoded PNG reduced by the production luminance sampler; the card
 * detector, the stability machine, the capture, the recognition request (real handler,
 * provider stubbed) and the explicit 加入 commit all run for real. Counted per case:
 * stills taken, recognition requests, quota commits. No OCR text is given to anything.
 * No device, camera, CameraX, ML Kit, provider or network — NOT a hardware test.
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
let PREVIEW = { x: 0, y: 56, width: 390, height: 788 };
let FRAME = { x: 28, y: 150, width: 335, height: 468 };
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



const { frameFromPng } = await import('./lib/card-frames.mjs');
const DIR = new URL('./fixtures/v44-card-frames/', import.meta.url);
const SPEC = JSON.parse(fs.readFileSync(new URL('auto-frame-traces.json', DIR), 'utf8'));
// CR e8f14dc P2 #1 (held-out, reviewer): a dark card face that only its white border
// separates from the table must trigger like the bright control; blank stays blank.
SPEC.assets.outlinedDarkCard = { path: 'held-out/outlined-dark-card.png', size: [320, 480] };
SPEC.assets.brightCardControl = { path: 'held-out/bright-card-control.png', size: [320, 480] };
const four = (image) => Array.from({ length: 4 }, () => ({ image, dtMs: 700 }));
SPEC.cases.push(
  { name: 'heldout_outlined_dark_card_triggers_once', events: four('outlinedDarkCard'), expected: { captures: 1, mockRecognitionRequests: 1, quotaCommits: 0 } },
  { name: 'heldout_bright_card_control_triggers_once', events: four('brightCardControl'), expected: { captures: 1, mockRecognitionRequests: 1, quotaCommits: 0 } },
);
const FRAMES = Object.fromEntries(Object.entries(SPEC.assets).map(([k, a]) => [k, frameFromPng(new URL(a.path, DIR))]));
// What the stubbed provider "recognises" for each card picture (any real, uniquely priced card).
const PROVIDER_FOR = { cardB: 'CARD_NUMBER: hSD01-003\nCHARACTER: ときのそら\nRARITY: C' };
const PROVIDER_DEFAULT = 'CARD_NUMBER: hBP01-010\nCHARACTER: 天音かなた';

const tick = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const byTestId = (id) => document.querySelector(`[data-testid="${id}"]`);
const click = async (el) => { await act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); await Promise.resolve(); }); };
const fs_ = globalThis.__frameScanner;
const navListeners = { focus: new Set(), blur: new Set() };
let navFocused = true;
const navigation = {
  navigate() {}, goBack() {}, openDrawer() {}, isFocused: () => navFocused,
  addListener: (ev, cb) => { navListeners[ev]?.add(cb); return () => navListeners[ev]?.delete(cb); },
};
const settle = async () => { await tick(20); for (let i = 0; i < 40 && document.body.textContent.includes('辨識中'); i++) await tick(25); await tick(60); };

async function runCase(c) {
  usePhotoUploadConsentStore.setState({ acceptedVersion: PHOTO_UPLOAD_DISCLOSURE_VERSION });
  useScanQuotaStore.getState().resetQuota();
  useScanSessionStore.getState().clearSession();
  globalThis.__frameScannerCaptureMode = 'immediate';
  fs_.pending.length = 0;
  navFocused = true;
  globalThis.__setAppState('active');
  const first = c.events.find((e) => e.image)?.image ?? 'blank';
  const size = SPEC.assets[first].size;
  PREVIEW = { x: 0, y: 0, width: size[0], height: size[1] };
  const f = SPEC.frameOverrides[first]?.scanFrame ?? SPEC.initialState.scanFrame;
  FRAME = { x: f.x, y: f.y, width: f.width, height: f.height };
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(ScanScreen, { navigation })));
  await tick(50);
  const base = { stills: fs_.stills, requests: bodies.length };
  // A quota commit = one successful incrementScan (scanCount + 1); setting the allowance
  // to 0 for a case is not a commit.
  let commits = 0;
  const unsubscribe = useScanQuotaStore.subscribe((state, prev) => { if (state.scanCount === prev.scanCount + 1) commits += 1; });
  let lateDeliveredWhileAway = 0;
  try {
    for (const ev of c.events) {
      if (ev.action === 'background' || ev.action === 'foreground') {
        await act(async () => { globalThis.__setAppState(ev.action === 'background' ? 'background' : 'active'); await Promise.resolve(); });
        await tick(20);
      } else if (ev.action === 'blur') {
        navFocused = false;
        await act(async () => { for (const cb of [...navListeners.blur]) cb(); await Promise.resolve(); });
        await tick(20);
      } else if (ev.action === 'cancel') {
        await click(byTestId('scan-top-bar-close'));
        await tick(20);
      } else if (ev.action === 'resolvePendingCaptureAndRecognition') {
        await act(async () => { globalThis.__settleCapture(true); await Promise.resolve(); });
        await settle();
      } else if (ev.action === 'tapAddResult') {
        const add = byTestId('scan-match-add');
        if (add) await click(add);
        await tick(30);
      } else if (ev.action === 'closeResult') {
        await tick(5600);                                   // the floating result card closes itself
      } else if (ev.image) {
        usePhotoUploadConsentStore.setState({ acceptedVersion: ev.consent === false ? null : PHOTO_UPLOAD_DISCLOSURE_VERSION });
        if (ev.allowance === 0) useScanQuotaStore.setState({ scanCount: 50 });
        globalThis.__frameScannerCaptureMode = ev.captureMode === 'deferred' ? 'deferred' : 'immediate';
        providerDown = ev.mockResponse === '503';
        providerText = PROVIDER_FOR[ev.image] ?? PROVIDER_DEFAULT;
        const payload = { ...FRAMES[ev.image], seq: Math.random() };
        if (AppState.currentState !== 'active' || !navFocused) {
          // A frame the native view had already started: force it through, the screen must drop it.
          await act(async () => { if (globalThis.__emitFrameInFlight(payload) !== false) lateDeliveredWhileAway += 1; await Promise.resolve(); });
        } else {
          await act(async () => { globalThis.__emitFrame(payload); await Promise.resolve(); });
        }
        await settle();
      }
    }
    await settle();
    return {
      captures: fs_.stills - base.stills,
      mockRecognitionRequests: bodies.length - base.requests,
      quotaCommits: commits,
      lateDeliveredWhileAway,
    };
  } finally {
    unsubscribe();
    providerDown = false;
    await act(async () => root.unmount());
    host.remove();
  }
}

const { AppState } = await import('react-native');
let passed = 0;
const results = {};
for (const c of SPEC.cases) {
  try {
    const got = await runCase(c);
    results[c.name] = got;
    for (const k of ['captures', 'mockRecognitionRequests', 'quotaCommits']) {
      assert.equal(got[k], c.expected[k], `${k}: got ${got[k]}, expected ${c.expected[k]}`);
    }
    if (c.expected.lateFrameMustBeIgnored) assert.ok(got.lateDeliveredWhileAway > 0, 'the trace really delivered frames while away');
    passed += 1;
    console.log(`  ✓ ${c.name} ${JSON.stringify(got)}`);
  } catch (err) {
    process.exitCode = 1;
    console.error(`  ✗ ${c.name} — ${err.message}`);
  }
}
console.log(`    COUNTS ${JSON.stringify(results)}`);
if ((process.exitCode ?? 0) === 0) console.log(`\n✅ scan-android-card-trace: ${passed}/${SPEC.cases.length} traces passed`);
else console.error('\n❌ scan-android-card-trace failed');
