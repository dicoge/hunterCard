#!/usr/bin/env node
/**
 * v44 CR e8f14dc P2 #3 / #4: the printing version and its price END TO END on the native
 * path — real ScanScreen, the frame scanner triggers ONE still, the REAL recognize-card
 * handler (provider stubbed: hBD24-023), the client recognition mapping, the result /
 * version chooser, 加入, and the scan session (effective price, total, sync form).
 * hBD24-023 has an ent07 aggregation row (JPY 8,980, 2026-10-1x) and an hPR row (JPY
 * 9,980, 2026-08-25) of the same shop listing.
 *   default: one proven version at its latest quote 8,980 everywhere (never 9,980).
 *   `conflict`: both quotes at the SAME time (database copied in memory) → no current
 *   price; after 加入 the session card stays unpriced (effective null, not in the total).
 * No device, camera, provider or network.
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




const MODE = process.argv[2] === 'conflict' ? 'conflict' : 'latest';
const ENT07 = 'hBD24-023_ent07', HPR = 'hBD24-023_hPR_P_hBD24-023_P';
if (MODE === 'conflict') DB.cards[HPR] = { ...DB.cards[HPR], timestamp: DB.cards[ENT07].timestamp };
providerText = 'CARD_NUMBER: hBD24-023\nCHARACTER: 癒月ちょこ\nRARITY: P';
const { frameFromPng } = await import('./lib/card-frames.mjs');
const { getEffectivePrice, toSyncEntry } = await import('../src/stores/scanSessionStore.ts');
const CARD = frameFromPng(new URL('./fixtures/v44-card-frames/images/cardA.png', import.meta.url));
PREVIEW = { x: 0, y: 0, width: 320, height: 480 };
FRAME = { x: 30, y: 55, width: 260, height: 360 };
const tick = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const byTestId = (id) => document.querySelector(`[data-testid="${id}"]`);
const all = (id) => [...document.querySelectorAll(`[data-testid="${id}"]`)];
const click = async (el) => { await act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); await Promise.resolve(); }); await tick(40); };
const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

usePhotoUploadConsentStore.setState({ acceptedVersion: PHOTO_UPLOAD_DISCLOSURE_VERSION });
useScanQuotaStore.getState().resetQuota();
useScanSessionStore.getState().clearSession();
let commits = 0;
useScanQuotaStore.subscribe((s, p) => { if (s.scanCount === p.scanCount + 1) commits += 1; });
const navigation = { navigate() {}, goBack() {}, openDrawer() {}, isFocused: () => true, addListener: () => () => {} };
const host = document.createElement('div');
document.body.appendChild(host);
const root = createRoot(host);
await act(async () => root.render(React.createElement(ScanScreen, { navigation })));
await tick(50);
for (let i = 0; i < 4; i += 1) { await act(async () => { globalThis.__emitFrame({ ...CARD, seq: i + 1 }); await Promise.resolve(); }); await tick(30); }
for (let i = 0; i < 60 && !byTestId('scan-match-best') && !byTestId('scan-match-identity') && !byTestId('scan-match-none'); i++) await tick(25);

const shown = {};
let passed = 0;
const check = (label, fn) => { try { fn(); passed += 1; console.log(`  ✓ ${label}`); } catch (e) { process.exitCode = 1; console.error(`  ✗ ${label} — ${e.message}`); } };
check('ONE still, ONE recognition request (automatic, no shutter)', () => {
  assert.equal(globalThis.__frameScanner.stills, 1);
  assert.equal(bodies.length, 1);
});
// Whatever the screen presents, the user must not be offered 8,980 and 9,980 as two versions.
if (byTestId('scan-match-identity')) {
  await click(byTestId('scan-match-pick'));
  shown.chooser = all('scan-candidate-meta').map(text);
  shown.sources = all('scan-candidate-source').map(text);
} else {
  shown.best = text(byTestId('scan-match-best'));
}
console.log(`    SHOWN ${JSON.stringify(shown)}`);
check('the presentation offers ONE hBD24-023 version (never 8,980 and 9,980 side by side)', () => {
  const blob = JSON.stringify(shown);
  assert.ok(!(blob.includes('8,980') && blob.includes('9,980')), blob);
  if (shown.chooser) assert.equal(shown.chooser.filter((m) => m.includes('hBD24-023')).length, 1, shown.chooser.join(' | '));
  if (MODE === 'latest') assert.ok(!blob.includes('9,980'), 'the old quote is not offered as the price');
  else assert.ok(blob.includes('報價不一致') || !/¥\d/.test(blob), 'conflict: no price claimed');
});
// 加入: either the result sheet's 加入 or picking the one version.
if (shown.chooser) {
  const row = all('scan-candidate-meta')[0];
  let el = row; while (el && el.getAttribute('tabindex') == null && el.getAttribute('role') !== 'button') el = el.parentElement;
  await click(el);
} else if (byTestId('scan-match-add')) {
  await click(byTestId('scan-match-add'));
}
await tick(60);
const session = useScanSessionStore.getState();
const card = session.cards[0];
console.log(`    SESSION ${JSON.stringify({ id: card?.id, sellPrice: card?.sellPrice, versionConfident: card?.versionConfident, effective: card && getEffectivePrice(card), total: session.totalValue, quotes: card?.priceQuotes?.map((q) => q.price), commits })}`);
check('加入 records ONE card and charges exactly once', () => {
  assert.equal(session.cards.length, 1);
  assert.equal(commits, 1);
});
if (MODE === 'latest') {
  check('session: effective price and total are the version\'s latest quote 8,980 (not the old 9,980); both quotes kept', () => {
    assert.equal(getEffectivePrice(card), 8980);
    assert.equal(session.totalValue, 8980);
    assert.deepEqual([...card.priceQuotes.map((q) => q.price)].sort(), [8980, 9980]);
    assert.ok([ENT07, HPR].includes(card.id));
  });
} else {
  check('session: a same-time quote conflict stays UNPRICED after 加入 (effective null, total 0); both quotes kept', () => {
    assert.equal(card.priceConflict, true);
    assert.equal(card.sellPrice, null);
    assert.equal(getEffectivePrice(card), null);
    assert.equal(session.totalValue, 0);
    assert.deepEqual([...card.priceQuotes.map((q) => q.price)].sort(), [8980, 9980]);
  });
  check('sync form (later normalization) carries no price for it either', () => {
    const e = toSyncEntry(card, false);
    assert.equal(e.card.sellPrice, null);
    assert.ok(e.priceVersions.every((v) => v.sellPrice == null), JSON.stringify(e.priceVersions));
  });
}
await act(async () => root.unmount());
host.remove();
if ((process.exitCode ?? 0) === 0) console.log(`\n✅ scan-printing-version-flow (${MODE}): ${passed} checks passed`);
else console.error(`\n❌ scan-printing-version-flow (${MODE}) failed`);
