#!/usr/bin/env node
/**
 * The NATIVE ScanScreen branch really crops to the on-screen frame (CR 2026-10-15 P2_1).
 *
 * The review found the native <ScanOverlay> never received `scanAreaRef`, so the frame
 * measured null at every capture and native silently uploaded the full photo. Helper
 * tests with synthetic rects could not see that. This renders the REAL ScanScreen with
 * Platform.OS = 'android' (so `isWeb` is false and the <CameraView> branch mounts) and
 * drives the real shutter. Only device seams are replaced:
 *
 *   • react-native   → react-native-web with Platform.OS forced to 'android'
 *   • expo-camera    → a CameraView that renders its children and returns a fixed photo
 *   • require('expo-image-manipulator' | 'expo-ocr-kit') → recorders
 *   • getBoundingClientRect for the camera box / scan frame → known window rects
 *     (react-native-web's measureInWindow reads it)
 *   • fetch → the REAL recognize-card handler with Gemini + catalog mocked
 *
 * It asserts what the actual branch produced: the manipulator crop rect equals the
 * frame mapped through planNativeCrop, the upload carries [context, crop], and the local
 * OCR fallback reads the CROP uri. It fails if the native scanAreaRef wiring is removed.
 * This is a rendered-component regression, not device QA.
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
      // Metro resolves *.native.ts for native bundles; mirror that for the platform split.
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

// ---- window rects the device would report (preview below a 56px header) ----
const PREVIEW = { x: 0, y: 56, width: 390, height: 788 };
let FRAME = { x: 28, y: 150, width: 335, height: 468 };
const rectOf = (r) => ({ x: r.x, y: r.y, left: r.x, top: r.y, width: r.width, height: r.height, right: r.x + r.width, bottom: r.y + r.height });
const realRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
  const id = this.getAttribute?.('data-testid');
  if (id === 'scan-camera-box') return rectOf(PREVIEW);
  if (id === 'scan-frame') return rectOf(FRAME);
  return realRect.call(this);
};

// ---- device modules reached through require() ----
const jpeg = (tag) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag.repeat(40))]).toString('base64');
const FULL_B64 = jpeg('context'), CROP_B64 = jpeg('crop'), ORIGINAL_B64 = jpeg('original');
const manipulations = [];
const ocrUris = [];
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
              return { async saveAsync() {
                manipulations.push({ uri, ops });
                const isCrop = ops.some((o) => o[0] === 'crop');
                return { base64: isCrop ? CROP_B64 : FULL_B64, uri: isCrop ? 'file:///cache/ImageManipulator/crop.jpg' : 'file:///cache/ImageManipulator/full.jpg' };
              } };
            },
          };
          return ctx;
        },
      },
    };
  }
  if (name === 'expo-ocr-kit') return { recognizeText: async (uri) => { ocrUris.push(uri); return { text: '' }; } };
  throw new Error(`unexpected require ${name}`);
};
globalThis.__nativeCameraPhoto = { uri: 'file:///cache/Camera/shot.jpg', width: 3024, height: 4032, base64: ORIGINAL_B64 };

// ---- network: real handler, mocked provider + catalog ----
const DB = JSON.parse(fs.readFileSync(new URL('../public/data/database.json', import.meta.url), 'utf8'));
const handler = (await import('../api/recognize-card.ts')).default;
process.env.GEMINI_API_KEY = 'test-key-never-sent';
let providerDown = false;
let providerReply = 'CARD_NUMBER: hBP01-010\nCHARACTER: 天音かなた';
const bodies = [];
globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (href === 'https://holohunter.dicoge.com/data/database.json') return Response.json(DB);
  if (href.includes('generativelanguage.googleapis.com')) {
    if (providerDown) return new Response('down', { status: 500 });
    return Response.json({ candidates: [{ content: { parts: [{ text: providerReply }] } }] });
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
const { Platform } = await import('react-native');
const { default: ScanScreen } = await import('../src/screens/ScanScreen.tsx');
const { usePhotoUploadConsentStore } = await import('../src/store/photoUploadConsentStore.ts');
const { PHOTO_UPLOAD_DISCLOSURE_VERSION } = await import('../src/services/photoUploadDisclosure.ts');
const { useScanQuotaStore } = await import('../src/store/scanQuotaStore.ts');
const { planNativeCrop } = await import('../src/utils/scanFrame.ts');
const { useScanDiagnosticsStore } = await import('../src/store/scanDiagnosticsStore.ts');

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

usePhotoUploadConsentStore.setState({ acceptedVersion: PHOTO_UPLOAD_DISCLOSURE_VERSION });
useScanQuotaStore.getState().resetQuota();
const listeners = { focus: new Set(), blur: new Set() };
const navigation = {
  navigate() {}, goBack() {}, openDrawer() {}, isFocused: () => true,
  addListener: (ev, cb) => { listeners[ev]?.add(cb); return () => listeners[ev]?.delete(cb); },
};
const host = document.createElement('div');
document.body.appendChild(host);
const root = createRoot(host);
await act(async () => root.render(React.createElement(ScanScreen, { navigation })));
await tick(50);

async function shutter() {
  const before = bodies.length;
  await click(byTestId('scan-primary-action'));
  for (let i = 0; i < 30 && bodies.length === before; i++) await tick(10);
  await tick(80);
}

try {
  await test('the harness really runs the native branch (Platform android, CameraView mounted, no WebCamera)', async () => {
    assert.equal(Platform.OS, 'android');
    const { SCAN_RUNTIME } = await import('../src/services/scanRuntime.native.ts');
    assert.equal(SCAN_RUNTIME, 'native');
    assert.ok(byTestId('native-camera-fixture'), 'CameraView fixture rendered');
    assert.ok(byTestId('scan-frame'), 'native ScanOverlay frame rendered');
    assert.equal(document.querySelector('video'), null, 'no web camera');
  });

  await test('native capture crops exactly the measured frame mapped into the photo (cover-fit, window offsets)', async () => {
    await shutter();
    const crop = manipulations.find((m) => m.ops.some((o) => o[0] === 'crop'));
    assert.ok(crop, 'expo-image-manipulator crop ran — the frame was measured');
    const plan = planNativeCrop(PREVIEW, FRAME, { width: 3024, height: 4032 });
    assert.equal(plan.ok, true);
    assert.deepEqual(crop.ops[0][1], { originX: plan.crop.x, originY: plan.crop.y, width: plan.crop.width, height: plan.crop.height });
    assert.equal(crop.uri, 'file:///cache/Camera/shot.jpg');
  });

  await test('the upload is [context photo, frame crop], never the device uri or the uncropped original', () => {
    const body = bodies.at(-1);
    assert.deepEqual(body.images, [`data:image/jpeg;base64,${FULL_B64}`, `data:image/jpeg;base64,${CROP_B64}`]);
    assert.ok(!JSON.stringify(body).includes('file://'));
    assert.ok(byTestId('scan-match-best'), 'result shown as preview');
  });

  await test('when the backend is down, native OCR reads the CROP file, not the full photo', async () => {
    await click(byTestId('scan-match-retake'));
    providerDown = true;
    ocrUris.length = 0;
    await shutter();
    providerDown = false;
    assert.deepEqual(ocrUris, ['file:///cache/ImageManipulator/crop.jpg']);
  });

  await test('measurement fallback kept: an unmeasurable frame sends the original photo only, no crop', async () => {
    FRAME = { x: 0, y: 0, width: 0, height: 0 };
    manipulations.length = 0;
    await shutter();
    assert.equal(manipulations.length, 0, 'no manipulation without a measured frame');
    assert.deepEqual(bodies.at(-1).images, [`data:image/jpeg;base64,${ORIGINAL_B64}`]);
  });
  // CR c9793eb P2: a no-match must keep what the backend read, in the real native
  // camera and gallery result paths, through the sanitiser — never the raw payload.
  const NO_MATCH_REPLY = 'CARD_NUMBER: hBP11-010\nCHARACTER: 天音かなた\nSET: hBP11\nLANGUAGE: JA\nTITLE: NONE';
  const FORBIDDEN = [/data:image\//, /file:\/\//, /content:\/\//, /@[a-z0-9-]+\.[a-z]/i, /test-key-never-sent/, /CARD_NUMBER:/, /\/9j\//];
  const assertNoMatchEntry = (e, source) => {
    assert.ok(e, `a ${source} diagnostic entry exists`);
    assert.equal(e.source, source);
    assert.equal(e.model, 'gemini-3.5-flash-lite');
    assert.deepEqual(e.extracted, { name: '天音かなた', number: 'hbp11-010', set: 'hBP11', language: 'JA' });
    assert.equal(e.match.status, 'no_match');
    assert.equal(e.match.reason, 'number_not_in_database');
    assert.ok(e.errors.includes('NO_MATCH'));
    assert.equal(e.outcome, 'no_match');
  };

  await test('native camera no-match keeps model + read name/set/language through the sanitiser', async () => {
    FRAME = { x: 28, y: 150, width: 335, height: 468 };
    useScanDiagnosticsStore.getState().clear();
    providerReply = NO_MATCH_REPLY;
    await shutter();
    assert.ok(byTestId('scan-match-none'), 'explicit no-match shown');
    assertNoMatchEntry(useScanDiagnosticsStore.getState().entries.at(-1), 'camera');
    await click(byTestId('scan-match-cancel'));
  });

  await test('native gallery no-match records the same fields on its own entry', async () => {
    globalThis.__nativePickerAsset = { uri: 'file:///cache/ImagePicker/pick.jpg', base64: ORIGINAL_B64, width: 1200, height: 1680 };
    const before = bodies.length;
    await click(byTestId('scan-gallery-action'));
    for (let i = 0; i < 30 && bodies.length === before; i++) await tick(10);
    await tick(80);
    assert.equal(bodies.length, before + 1, 'gallery pick uploaded once');
    const entries = useScanDiagnosticsStore.getState().entries;
    assertNoMatchEntry(entries.at(-1), 'gallery');
    assert.equal(entries.length, 2, 'one entry per scan');
  });

  await test('the exported file keeps those fields and carries no payload, uri, key, image or email', () => {
    const text = useScanDiagnosticsStore.getState().exportText();
    const parsed = JSON.parse(text);
    assert.equal(parsed.count, 2);
    assert.ok(parsed.entries.every((e) => e.extracted.name === '天音かなた' && e.model === 'gemini-3.5-flash-lite'));
    for (const re of FORBIDDEN) assert.ok(!re.test(text), `export contains ${re}`);
  });

  await test('hostile debug values (email, key, overlong, bad status) are dropped or redacted, never stored', async () => {
    const { diagnosticDebug } = await import('../src/services/cardRecognition.ts');
    const d = diagnosticDebug({
      model: 'gemini-3.5-flash-lite', provider: 'gemini', rawModelOutput: 'CARD_NUMBER: x', apiKey: 'AIzaSyFAKE',
      normalizedCardNumber: 'x'.repeat(200), matchStatus: 'hacked',
      extracted: { characterName: 'mail me a@b.com', setCode: 'AIzaSyFAKEKEYVALUE1234567890', language: 'J'.repeat(100), cardNumberRaw: 'hBP11-010' },
    });
    assert.deepEqual(Object.keys(d).sort(), ['extracted', 'matchReason', 'matchStatus', 'model', 'normalizedCardNumber', 'provider']);
    assert.equal(d.normalizedCardNumber, null, 'overlong dropped');
    assert.equal(d.extracted.language, undefined, 'overlong dropped');
    // cardNumberRaw (the received number) is kept on purpose (CR 2026-10-16 #4) and
    // re-validated before storage; the raw reply and unknown keys are not.
    assert.equal(d.extracted.cardNumberRaw, 'hBP11-010');
    assert.ok(!('rawModelOutput' in d) && !('apiKey' in d));
    const { sanitizeEntry, diagnosticsFromResult } = await import('../src/services/scanDiagnostics.ts');
    const fields = diagnosticsFromResult({ success: false, debug: d, match: { status: 'hacked' } });
    const e = sanitizeEntry({ id: 'abcdefgh12345678', at: new Date().toISOString(), model: fields.model, extracted: fields.extracted, match: fields.match, errors: fields.errors });
    assert.equal(e.extracted.name, '[redacted]');
    assert.equal(e.extracted.set, '[redacted]');
    assert.equal(e.match.status, 'unknown', 'unknown status fails closed');
  });
} finally {
  await act(async () => root.unmount());
  host.remove();
}

if ((process.exitCode ?? 0) === 0) console.log(`\n✅ scan-native-crop-render: ${passed} checks passed`);
else console.error('\n❌ scan-native-crop-render failed');
