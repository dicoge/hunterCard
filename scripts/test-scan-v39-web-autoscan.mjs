#!/usr/bin/env node
/**
 * Web auto-scan after a service failure (v39 PM review 2026-10-16), on the REAL web
 * ScanScreen. Web auto-scan is on by default and fires on every stable frame; after a
 * provider failure the scan ends (busy = false) and, without a pause, the loop captured a
 * NEW photo and uploaded again by itself — behind the manual-retry panel, replacing the
 * photo the user was offered to retry.
 *
 * Seams only: WebCamera → a fixture with a readable <video> that counts captures,
 * autoScanService → every frame stable, webOcr → reads nothing, fetch → the REAL
 * recognize-card handler with the provider and catalog mocked. No browser camera, no
 * network, no provider call.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import { JSDOM } from 'jsdom';

register(
  'data:text/javascript,' + encodeURIComponent(`
    const CAM = ${JSON.stringify(new URL('./fixtures/web-camera-fixture.mjs', import.meta.url).href)};
    const AUTO = ${JSON.stringify(new URL('./fixtures/auto-scan-stable-fixture.mjs', import.meta.url).href)};
    const OCR = ${JSON.stringify(new URL('./fixtures/web-ocr-empty-fixture.mjs', import.meta.url).href)};
    export async function resolve(specifier, context, next) {
      if (specifier.endsWith('/components/WebCamera')) return { url: CAM, shortCircuit: true };
      if (specifier.endsWith('/services/autoScanService')) return { url: AUTO, shortCircuit: true };
      if (specifier.endsWith('/webOcr') || specifier === './webOcr') return { url: OCR, shortCircuit: true };
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
Object.defineProperty(dom.window.navigator, 'mediaDevices', { value: { getUserMedia: async () => ({ getTracks: () => [] }) }, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// jsdom never decodes images: fail fast so imagePreprocessor takes its own documented
// fallback (send the original) instead of its 10 s timeout.
globalThis.Image = class { set src(_) { setTimeout(() => this.onerror?.(new Error('no decoder')), 0); } };
class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = NoopResizeObserver;
dom.window.ResizeObserver = NoopResizeObserver;
Object.defineProperty(dom.window, 'innerWidth', { value: 390, configurable: true });
Object.defineProperty(dom.window, 'innerHeight', { value: 844, configurable: true });
if (!dom.window.matchMedia) {
  dom.window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  globalThis.matchMedia = dom.window.matchMedia;
}

// A legible JPEG (SOF0 640×800) as a data URL — what a web capture uploads.
globalThis.__webCameraPhoto = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0x03, 0x20, 0x02, 0x80]), Buffer.alloc(2000, 7)]).toString('base64')}`;

const DB = JSON.parse(fs.readFileSync(new URL('../public/data/database.json', import.meta.url), 'utf8'));
const handler = (await import('../api/recognize-card.ts')).default;
process.env.GEMINI_API_KEY = 'test-key-never-sent';
let providerDown = true;
const bodies = [];
globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (href.endsWith('/data/database.json')) return Response.json(DB);
  if (href.includes('generativelanguage.googleapis.com')) {
    if (providerDown) return new Response('down', { status: 500 });
    return Response.json({ candidates: [{ content: { parts: [{ text: 'CARD_NUMBER: hBP01-010\nCHARACTER: 天音かなた' }] } }] });
  }
  if (href.includes('/api/recognize-card')) {
    bodies.push(JSON.parse(init.body));
    const res = await handler(new Request('https://holohunter.dicoge.com/api/recognize-card', { method: 'POST', body: init.body, headers: { 'Content-Type': 'application/json' } }));
    const text = await res.text();
    return new Response(text, { status: res.status, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response('{}', { status: 404 });
};

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ScanScreen } = await import('../src/screens/ScanScreen.tsx');
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
const waitFor = async (cond, ms = 3000) => { for (let t = 0; t < ms && !cond(); t += 20) await tick(20); return cond(); };

usePhotoUploadConsentStore.setState({ acceptedVersion: PHOTO_UPLOAD_DISCLOSURE_VERSION });
useScanQuotaStore.getState().resetQuota();
useScanSessionStore.getState().clearSession();
const navigation = { navigate() {}, goBack() {}, openDrawer() {}, isFocused: () => true, addListener: () => () => {} };
const host = document.createElement('div');
document.body.appendChild(host);
const root = createRoot(host);
await act(async () => root.render(React.createElement(ScanScreen, { navigation })));
await tick(20);

try {
  await test('the harness runs the real web auto-scan: camera allowed → a stable frame captures and uploads by itself', async () => {
    await click(byTestId('scan-permission-allow'));
    assert.ok(await waitFor(() => byTestId('scan-service-failure')), 'first auto-scan ended in a service failure');
    assert.equal(globalThis.__webCameraTakes, 1);
    assert.equal(bodies.length, 1, 'ONE remote request for the failed scan — the fallback is local only');
    assert.equal(bodies[0].images[0], globalThis.__webCameraPhoto);
  });
  await test('while the service-failure panel is up, auto-scan stays paused past its 3 s cooldown: no new capture, no new upload, photo kept for retry', async () => {
    const uploads = bodies.length;
    await tick(3600);
    assert.equal(globalThis.__webCameraTakes, 1, 'no new photo captured behind the panel');
    assert.equal(bodies.length, uploads, 'nothing uploaded by itself');
    assert.ok(byTestId('scan-service-retry'), 'the held photo is still offered for retry');
    assert.ok(!host.textContent.includes('找不到'), 'never shown as not found');
  });
  await test('the explicit retry resends the held photo (no capture) and shows the result; nothing added or charged', async () => {
    providerDown = false;
    const uploads = bodies.length;
    const remaining = useScanQuotaStore.getState().getRemaining();
    await click(byTestId('scan-service-retry'));
    assert.ok(await waitFor(() => byTestId('scan-match-best')), 'retried result previewed');
    assert.equal(bodies.length, uploads + 1, 'ONE remote request for the manual retry');
    assert.equal(globalThis.__webCameraTakes, 1, 'retry used the held photo');
    assert.equal(bodies[uploads].images[0], globalThis.__webCameraPhoto);
    assert.equal(useScanSessionStore.getState().cardCount, 0);
    assert.equal(useScanQuotaStore.getState().getRemaining(), remaining);
  });
  await test('CR 717c3fe P2 #1: local OCR THROWS after a service failure → typed failure kept, panel + same-photo retry, auto-scan paused: one capture, one upload past the cooldown', async () => {
    await click(byTestId('scan-match-retake'));   // close the preview → auto-scan may run again
    providerDown = true;
    globalThis.__webOcrThrows = true;
    const takes = globalThis.__webCameraTakes, uploads = bodies.length;
    assert.ok(await waitFor(() => byTestId('scan-service-failure')), 'service panel shown although OCR threw');
    await tick(3600);
    assert.equal(globalThis.__webCameraTakes, takes + 1, 'exactly one capture');
    assert.equal(bodies.length, uploads + 1, 'exactly one remote request');
    assert.ok(byTestId('scan-service-retry'), 'same-photo retry offered');
    assert.ok(byTestId('scan-service-failure').textContent.includes('辨識服務暫時無法使用'));
    assert.ok(!host.textContent.includes('找不到'));
    globalThis.__webOcrThrows = false;
  });
} finally {
  await act(async () => root.unmount());
  host.remove();
}

if ((process.exitCode ?? 0) === 0) console.log(`\n✅ scan-v39-web-autoscan: ${passed} checks passed`);
else console.error('\n❌ scan-v39-web-autoscan failed');
process.exit();
