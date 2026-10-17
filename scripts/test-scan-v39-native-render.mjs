#!/usr/bin/env node
/**
 * v39 user report 2026-10-16 on the REAL native ScanScreen (Platform.OS = 'android',
 * <CameraView> branch), with the same device seams as test-scan-native-crop-render:
 * react-native → react-native-web forced to android (+ a BackHandler that can be
 * pressed), expo-camera / picker / manipulator / ocr → fixtures, fetch → the REAL
 * recognize-card handler with the provider and catalog mocked. No device, no photo, no
 * network, no provider call.
 *
 *   ✕       clears the status-bar inset, 48dp target, top layer above the overlay, and
 *           nothing the screen layers on later (the "last scanned" toast) covers it
 *   back    Android hardware back closes the top surface first, else leaves like ✕
 *   failure a service failure is never shown as a no-match; manual retry resends the SAME
 *           photo once (double tap = one request), adds/charges only on explicit add
 *   identity the v39 風真いろは log shows the corrected card without a price; the user picks
 *           the printing, charged once
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

const jpeg = (tag) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag.repeat(40))]).toString('base64');
const ORIGINAL_B64 = jpeg('original');
let ocrText = '';
globalThis.require = (name) => {
  // No frame measurement under jsdom here → no crop; the original photo is the upload.
  if (name === 'expo-image-manipulator') throw new Error('not used');
  if (name === 'expo-ocr-kit') return { recognizeText: async () => ({ text: ocrText }) };
  throw new Error(`unexpected require ${name}`);
};
globalThis.__nativeCameraPhoto = { uri: 'file:///cache/Camera/shot.jpg', width: 3024, height: 4032, base64: ORIGINAL_B64 };

const DB = JSON.parse(fs.readFileSync(new URL('../public/data/database.json', import.meta.url), 'utf8'));
const handler = (await import('../api/recognize-card.ts')).default;
process.env.GEMINI_API_KEY = 'test-key-never-sent';
let providerDown = false;
let providerDelayMs = 0;
let providerReply = 'CARD_NUMBER: hBP01-010\nCHARACTER: 天音かなた';
const bodies = [];
globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (href === 'https://holohunter.dicoge.com/data/database.json') return Response.json(DB);
  if (href.includes('generativelanguage.googleapis.com')) {
    if (providerDown) return new Response('down', { status: 500 });
    if (providerDelayMs) await new Promise((r) => setTimeout(r, providerDelayMs));
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
const { __setSafeAreaInsetsForTest } = await import('react-native-safe-area-context');
const { default: ScanScreen } = await import('../src/screens/ScanScreen.tsx');
const { SCAN_TOP_BAR_HEIGHT, SCAN_TOP_BAR_TOUCH } = await import('../src/components/ScanTopBar.tsx');
const { usePhotoUploadConsentStore } = await import('../src/store/photoUploadConsentStore.ts');
const { PHOTO_UPLOAD_DISCLOSURE_VERSION } = await import('../src/services/photoUploadDisclosure.ts');
const { useScanQuotaStore } = await import('../src/store/scanQuotaStore.ts');
const { useScanSessionStore } = await import('../src/stores/scanSessionStore.ts');
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
const px = (el, prop) => parseFloat(dom.window.getComputedStyle(el)[prop]);
const back = async () => { let handled; await act(async () => { handled = globalThis.__androidBackPress(); await Promise.resolve(); }); await tick(10); return handled; };
const settle = async (before) => { for (let i = 0; i < 40 && bodies.length === before; i++) await tick(10); await tick(120); };

const INSET = 32;
__setSafeAreaInsetsForTest({ top: INSET });
usePhotoUploadConsentStore.setState({ acceptedVersion: PHOTO_UPLOAD_DISCLOSURE_VERSION });
useScanQuotaStore.getState().resetQuota();
useScanSessionStore.getState().clearSession();
const navigations = [];
const listeners = { focus: new Set(), blur: new Set() };
const navigation = {
  navigate: (...args) => navigations.push(args), goBack() {}, openDrawer() {}, isFocused: () => true,
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
  await settle(before);
}

try {
  console.log('✕ close');
  await test('the native top bar clears the status-bar inset (edge-to-edge), and ✕ has a 48dp target around the 34dp Pen circle', () => {
    const bar = byTestId('scan-top-bar');
    assert.ok(bar, 'native camera chrome mounted');
    assert.equal(px(bar, 'paddingTop'), INSET, 'bar starts below the status bar, not at y = 0');
    const close = byTestId('scan-top-bar-close');
    assert.equal(px(close, 'width'), SCAN_TOP_BAR_TOUCH);
    assert.equal(px(close, 'height'), SCAN_TOP_BAR_TOUCH);
    assert.ok(SCAN_TOP_BAR_TOUCH >= 48);
    assert.equal(px(close.firstElementChild, 'width'), 34, 'Pen circle unchanged');
  });
  await test('z-order: the top bar layer is absolute at the top, above the overlay and its loading layer, and after the frame in the tree', () => {
    const layer = byTestId('scan-top-bar-layer');
    const cs = dom.window.getComputedStyle(layer);
    assert.equal(cs.position, 'absolute');
    assert.equal(px(layer, 'top'), 0);
    assert.ok(Number(cs.zIndex) > 10, `zIndex ${cs.zIndex} above the loading overlays (10)`);
    const frame = byTestId('scan-frame');
    assert.ok(frame.compareDocumentPosition(layer) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'rendered after the frame');
    assert.ok(layer.contains(byTestId('scan-top-bar-close')));
  });
  await test('✕ leaves to Home', async () => {
    navigations.length = 0;
    await click(byTestId('scan-top-bar-close'));
    assert.deepEqual(navigations, [['MainDrawer', { screen: 'Home' }]]);
  });

  console.log('Android hardware back');
  await test('back with nothing open leaves exactly like ✕', async () => {
    navigations.length = 0;
    assert.ok(globalThis.__androidBackListenerCount() >= 1, 'ScanScreen registered a hardwareBackPress listener');
    assert.equal(await back(), true);
    assert.deepEqual(navigations, [['MainDrawer', { screen: 'Home' }]]);
  });
  await test('back with a result preview open closes the preview only: no navigation, nothing added or charged', async () => {
    const remaining = useScanQuotaStore.getState().getRemaining();
    await shutter();
    assert.ok(byTestId('scan-match-best'), 'preview shown');
    navigations.length = 0;
    assert.equal(await back(), true);
    assert.equal(byTestId('scan-match-best'), null, 'preview closed');
    assert.deepEqual(navigations, []);
    assert.equal(useScanSessionStore.getState().cardCount, 0);
    assert.equal(useScanQuotaStore.getState().getRemaining(), remaining);
  });

  console.log('service failure → manual retry');
  let failedBody;
  await test('provider failure (502) + local OCR text that matches nothing → service failure panel, never 「找不到」/no-match', async () => {
    useScanDiagnosticsStore.getState().clear();
    providerDown = true;
    ocrText = 'ホロライブ 2nd';
    const takes = globalThis.__nativeCameraTakes ?? 0;
    await shutter();
    failedBody = bodies.at(-1);
    assert.equal(globalThis.__nativeCameraTakes, takes + 1);
    const panel = byTestId('scan-service-failure');
    assert.ok(panel, 'service failure panel shown');
    assert.ok(panel.textContent.includes('辨識服務暫時無法使用，請稍後重試'), panel.textContent);
    assert.equal(byTestId('scan-match-none'), null);
    assert.ok(!host.textContent.includes('找不到'), 'no "not found" text anywhere');
    const e = useScanDiagnosticsStore.getState().entries.at(-1);
    assert.ok(e.errors.includes('RECOGNITION_UNAVAILABLE') && e.errors.includes('HTTP_502'), e.errors.join());
    assert.ok(!e.errors.includes('NO_MATCH'));
    assert.equal(e.outcome, 'failed');
  });
  await test('a second tap on 重試 while the retry is on the wire sends nothing: ONE request, the SAME photo, no new capture', async () => {
    providerDown = false;
    providerReply = 'CARD_NUMBER: hBP01-010\nCHARACTER: 天音かなた';
    providerDelayMs = 150;
    const before = bodies.length;
    const takes = globalThis.__nativeCameraTakes;
    const retry = byTestId('scan-service-retry');
    assert.ok(retry, 'retry offered');
    const tap = () => act(async () => { retry.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); await Promise.resolve(); });
    await tap();
    for (let i = 0; i < 40 && bodies.length === before; i++) await tick(5);
    assert.equal(bodies.length, before + 1, 'first retry is in flight');
    await tap();
    await tick(400);
    providerDelayMs = 0;
    assert.equal(bodies.length, before + 1, 'one request for two taps');
    assert.deepEqual(bodies.at(-1).images, failedBody.images, 'the photo already taken, resent');
    assert.equal(globalThis.__nativeCameraTakes, takes, 'camera not used again');
    assert.ok(byTestId('scan-match-best'), 'the retried result is a preview');
    assert.equal(byTestId('scan-service-failure'), null);
  });
  await test('retry charged nothing; the explicit add charges exactly once; the held photo is dropped', async () => {
    const remaining = useScanQuotaStore.getState().getRemaining();
    await click(byTestId('scan-match-add'));
    await tick(20);
    assert.equal(useScanQuotaStore.getState().getRemaining(), remaining - 1);
    assert.equal(useScanSessionStore.getState().cardCount, 1);
    assert.equal(byTestId('scan-service-retry'), null);
  });
  await test('after an add, neither the result card nor the "last scanned" toast covers the ✕ (both were top: 60 over it)', () => {
    const absoluteAncestor = (el) => { while (el && dom.window.getComputedStyle(el).position !== 'absolute') el = el.parentElement; return el; };
    const barBottom = INSET + SCAN_TOP_BAR_HEIGHT;
    for (const id of ['scan-result-prices', 'scan-toast-price']) {
      const box = absoluteAncestor(byTestId(id));
      assert.ok(box, `${id} overlay shown`);
      assert.ok(px(box, 'top') >= barBottom, `${id}: top ${px(box, 'top')} must be below the bar bottom ${barBottom}`);
    }
  });
  await test('back on a service failure dismisses the panel (and the held photo), stays on Scan', async () => {
    providerDown = true;
    await shutter();
    assert.ok(byTestId('scan-service-failure'));
    navigations.length = 0;
    assert.equal(await back(), true);
    assert.equal(byTestId('scan-service-failure'), null);
    assert.deepEqual(navigations, []);
    providerDown = false;
  });

  console.log('corrected identity (real v39 風真いろは log)');
  await test('風真いろは read as hBP05-081 → identity hBP01-051 shown as corrected, no price on the sheet', async () => {
    ocrText = '';
    providerReply = 'CHARACTER: 風真いろは\nCARD_NUMBER: hBP05-081\nSET: hBP05\nLANGUAGE: JA\nRARITY: SR\nTITLE: NONE';
    await shutter();
    const sheet = byTestId('scan-match-identity');
    assert.ok(sheet, 'identity sheet');
    assert.ok(byTestId('scan-match-number-corrected'), 'corrected-number note shown');
    assert.ok(sheet.textContent.includes('hBP01-051'));
    assert.ok(!/[¥$]\s?\d/.test(sheet.textContent), 'no price before a printing is chosen');
    assert.equal(byTestId('scan-match-add'), null, 'no add on an identity');
  });
  await test('back on the printing list closes it; nothing added', async () => {
    const count = useScanSessionStore.getState().cardCount;
    await click(byTestId('scan-match-pick'));
    assert.ok(host.querySelectorAll('[data-testid="scan-candidate-meta"]').length >= 2, 'printings listed');
    assert.equal(await back(), true);
    assert.equal(host.querySelectorAll('[data-testid="scan-candidate-meta"]').length, 0);
    assert.equal(useScanSessionStore.getState().cardCount, count);
  });
  await test('picking the SR printing adds that exact printing once and charges once', async () => {
    await shutter();
    await click(byTestId('scan-match-pick'));
    const metas = [...host.querySelectorAll('[data-testid="scan-candidate-meta"]')];
    assert.ok(metas.every((m) => m.textContent.includes('hBP01-051')), 'only the corrected card');
    assert.ok(metas[0].textContent.includes('SR'), 'SR (rarity read) first');
    const remaining = useScanQuotaStore.getState().getRemaining();
    const count = useScanSessionStore.getState().cardCount;
    await click(metas[0]);
    await tick(20);
    assert.equal(useScanQuotaStore.getState().getRemaining(), remaining - 1);
    assert.equal(useScanSessionStore.getState().cardCount, count + 1);
    assert.equal(useScanSessionStore.getState().cards.at(-1).id, 'hBP01-051_hEB01_SR_hBP01-051_SR_02');
  });

  console.log('v41 concise copy: short reason + 重試／取消, no quota paragraph on failure screens, charges unchanged');
  const QUOTA_COPY = /額度|未使用|不扣/;
  await test('service failure: one short reason line and exactly the actions 重試 / 取消 — no quota sentence', async () => {
    providerReply = 'CARD_NUMBER: hBP01-010\nCHARACTER: 天音かなた';
    providerDown = true;
    ocrText = '';
    await shutter();
    const panel = byTestId('scan-service-failure');
    assert.ok(panel, 'service panel shown');
    assert.ok(panel.textContent.includes('⚠️ 辨識服務暫時無法使用，請稍後重試。'), panel.textContent);
    assert.ok(!QUOTA_COPY.test(panel.textContent), `no quota wording: ${panel.textContent}`);
    assert.equal(byTestId('scan-service-retry').textContent, '重試');
    assert.equal(byTestId('scan-service-cancel').textContent, '取消');
    assert.ok(!byTestId('scan-service-manual'), 'manual search is no longer a third action here');
  });
  await test('取消 drops the held photo and the panel: nothing uploaded, nothing charged; the next scan takes a NEW photo', async () => {
    const remaining = useScanQuotaStore.getState().getRemaining();
    const count = useScanSessionStore.getState().cardCount;
    const uploads = bodies.length, takes = globalThis.__nativeCameraTakes;
    await click(byTestId('scan-service-cancel'));
    await tick(50);
    assert.ok(!byTestId('scan-service-failure'), 'panel closed');
    assert.ok(!byTestId('scan-service-retry'), 'held photo dropped');
    assert.equal(bodies.length, uploads, 'cancel uploads nothing');
    assert.equal(useScanQuotaStore.getState().getRemaining(), remaining, 'cancel charges nothing');
    assert.equal(useScanSessionStore.getState().cardCount, count);
    providerDown = false;
    await shutter();
    assert.equal(globalThis.__nativeCameraTakes, takes + 1, 'new capture after cancel');
    assert.ok(byTestId('scan-match-best'));
    assert.equal(useScanQuotaStore.getState().getRemaining(), remaining, 'a preview charges nothing');
    await click(byTestId('scan-match-retake'));
  });
  // v42 (user 2026-10-17): version selection says only 請選擇卡片版本; failed recognition
  // says 辨識失敗，請再試一次; no number/name mismatch narrative on any scanner surface.
  const MISMATCH_COPY = /卡號與角色|不一致|對應|已依角色|讀不到卡號|資料庫沒有/;
  await test('version not resolved: body is exactly 「請選擇卡片版本」, the chooser stays, no price, no quota sentence', async () => {
    providerReply = 'CARD_NUMBER: hBP01-024';
    await shutter();
    const sheet = byTestId('scan-match-identity');
    assert.ok(sheet, 'identity sheet');
    assert.ok(sheet.textContent.includes('請選擇卡片版本'), sheet.textContent);
    assert.ok(!MISMATCH_COPY.test(sheet.textContent), sheet.textContent);
    assert.ok(!sheet.textContent.includes('此卡號有多個版本'), 'old long explanation gone');
    assert.ok(byTestId('scan-match-pick'), 'version chooser offered');
    assert.ok(!/[¥$]\s?\d/.test(sheet.textContent), 'no price');
    assert.ok(!QUOTA_COPY.test(sheet.textContent));
    await click(byTestId('scan-match-manual'));
    await tick(20);
  });
  await test('photo no-match (number/name conflict): 「辨識失敗，請再試一次」 only — the conflict is NOT shown; nothing charged', async () => {
    const remaining = useScanQuotaStore.getState().getRemaining();
    providerReply = 'CHARACTER: 宝鐘マリン\nCARD_NUMBER: hBP01-014';
    await shutter();
    const sheet = byTestId('scan-match-none');
    assert.ok(sheet, 'no-match sheet (the service answered)');
    assert.ok(sheet.textContent.includes('辨識失敗，請再試一次'), sheet.textContent);
    assert.ok(!MISMATCH_COPY.test(sheet.textContent), `no mismatch narrative: ${sheet.textContent}`);
    assert.ok(!QUOTA_COPY.test(sheet.textContent));
    await click(byTestId('scan-match-cancel'));
    assert.equal(useScanQuotaStore.getState().getRemaining(), remaining);
  });
  // v41 (PM requirement, Grok no-match N2): a no-match shows a short reason and the
  // same visible 重試／取消 pair as a service failure — not only 重拍／手動搜尋.
  const NO_MATCH = 'CARD_NUMBER: NONE\nCHARACTER: NONE\nTITLE: NONE';
  await test('no-match: 「辨識失敗，請再試一次」 + visible 重試 and 取消 (manual search still reachable)', async () => {
    providerReply = NO_MATCH;
    await shutter();
    const sheet = byTestId('scan-match-none');
    assert.ok(sheet, 'no-match sheet');
    assert.ok(sheet.textContent.includes('辨識失敗，請再試一次'), sheet.textContent);
    assert.ok(!MISMATCH_COPY.test(sheet.textContent), sheet.textContent);
    assert.equal(byTestId('scan-match-retry')?.textContent, '重試');
    assert.equal(byTestId('scan-match-cancel')?.textContent, '取消');
    assert.ok(byTestId('scan-match-manual'), 'manual search link kept');
    assert.ok(!QUOTA_COPY.test(sheet.textContent));
  });
  await test('no-match 取消 ends the round: sheet closed, no new request or capture (no auto-retry), nothing charged or added', async () => {
    const remaining = useScanQuotaStore.getState().getRemaining();
    const count = useScanSessionStore.getState().cardCount;
    const before = bodies.length;
    const takes = globalThis.__nativeCameraTakes;
    await click(byTestId('scan-match-cancel'));
    await tick(1500);
    assert.equal(byTestId('scan-match-none'), null, 'sheet closed');
    assert.equal(bodies.length, before, 'no provider request');
    assert.equal(globalThis.__nativeCameraTakes, takes, 'no new capture');
    assert.equal(useScanQuotaStore.getState().getRemaining(), remaining, 'cancel uses 0');
    assert.equal(useScanSessionStore.getState().cardCount, count);
  });
  await test('no-match 重試 really scans again: one new capture + one request through the normal shutter path; a match then charges only on 加入', async () => {
    providerReply = NO_MATCH;
    await shutter();
    assert.ok(byTestId('scan-match-none'));
    // A card this suite has not added yet (the list refuses a card it already holds).
    providerReply = 'CARD_NUMBER: hSD01-003\nCHARACTER: ときのそら\nRARITY: C';
    const remaining = useScanQuotaStore.getState().getRemaining();
    const count = useScanSessionStore.getState().cardCount;
    const before = bodies.length;
    const takes = globalThis.__nativeCameraTakes;
    await click(byTestId('scan-match-retry'));
    await settle(before);
    assert.equal(bodies.length, before + 1, 'exactly one new recognition request');
    assert.equal(globalThis.__nativeCameraTakes, takes + 1, 'a NEW photo, not the failed one');
    assert.equal(byTestId('scan-match-none'), null);
    assert.ok(byTestId('scan-match-best'), 'the new round shows its result');
    assert.equal(useScanQuotaStore.getState().getRemaining(), remaining, 'retry itself uses 0');
    await click(byTestId('scan-match-add'));
    await tick(20);
    assert.equal(useScanQuotaStore.getState().getRemaining(), remaining - 1, 'the explicit 加入 uses exactly 1');
    assert.equal(useScanSessionStore.getState().cardCount, count + 1);
  });
  await test('no-match in 日本語: 再試行／キャンセル', async () => {
    const { useSettingsStore } = await import('../src/store/settingsStore.ts');
    const prev = useSettingsStore.getState().preferredLanguage;
    try {
      await act(async () => { useSettingsStore.setState({ preferredLanguage: 'ja' }); });
      providerReply = NO_MATCH;
      await shutter();
      assert.ok(byTestId('scan-match-none')?.textContent.includes('認識できませんでした。もう一度お試しください'));
      assert.equal(byTestId('scan-match-retry')?.textContent, '再試行');
      assert.equal(byTestId('scan-match-cancel')?.textContent, 'キャンセル');
      await click(byTestId('scan-match-cancel'));
    } finally {
      await act(async () => { useSettingsStore.setState({ preferredLanguage: prev }); });
    }
  });
  await test('corrected identity: only 「請選擇卡片版本」 + chooser (conflict kept in local diagnostics); a double tap on a version adds it once and charges once', async () => {
    providerReply = 'CHARACTER: 宝鐘マリン\nCARD_NUMBER: hBP01-014\nRARITY: SR';
    await shutter();
    const note = byTestId('scan-match-number-corrected');
    assert.ok(note, 'corrected note');
    assert.equal(note.textContent, '請選擇卡片版本');
    assert.ok(!MISMATCH_COPY.test(byTestId('scan-match-identity').textContent));
    const diag = useScanDiagnosticsStore.getState().entries.at(-1);
    assert.equal(diag?.presentation?.reason, 'number_name_conflict', 'the conflict is recorded in the LOCAL diagnostics log');
    await click(byTestId('scan-match-pick'));
    const first = host.querySelector('[data-testid="scan-candidate-meta"]');
    assert.ok(first.textContent.includes('hEB01-014') && first.textContent.includes('SR'));
    const remaining = useScanQuotaStore.getState().getRemaining();
    const count = useScanSessionStore.getState().cardCount;
    await act(async () => {
      first.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      first.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await tick(30);
    assert.equal(useScanQuotaStore.getState().getRemaining(), remaining - 1, 'charged exactly once');
    assert.equal(useScanSessionStore.getState().cardCount, count + 1, 'added exactly once');
    assert.equal(useScanSessionStore.getState().cards.at(-1).id, 'hEB01-014_hEB01_SR_hEB01-014_SR');
  });

  console.log('CR 717c3fe P2 #2: app goes to the background');
  const appState = async (next) => { await act(async () => { globalThis.__setAppState(next); await Promise.resolve(); }); await tick(10); };
  await test('a failed scan holding a retry photo: background clears the panel and the held photo; foreground scans afresh', async () => {
    providerReply = 'CARD_NUMBER: hBP01-010\nCHARACTER: 天音かなた';
    providerDown = true;
    ocrText = '';
    await shutter();
    assert.ok(byTestId('scan-service-retry'), 'retry photo held');
    assert.ok(globalThis.__appStateListenerCount() >= 1, 'ScanScreen listens to AppState');
    await appState('background');
    assert.ok(!byTestId('scan-service-failure'), 'panel gone');
    assert.ok(!byTestId('scan-service-retry'), 'held photo dropped');
    await appState('active');
    providerDown = false;
    const takes = globalThis.__nativeCameraTakes;
    await shutter();
    assert.equal(globalThis.__nativeCameraTakes, takes + 1, 'a NEW photo was taken');
    assert.ok(byTestId('scan-match-best'), 'foreground scanner works');
    await click(byTestId('scan-match-retake'));
  });
  await test('a scan still on the wire when the app goes inactive: its late result is dropped — no preview, no add, no charge', async () => {
    useScanDiagnosticsStore.getState().clear();
    const remaining = useScanQuotaStore.getState().getRemaining();
    const count = useScanSessionStore.getState().cardCount;
    providerDelayMs = 200;
    const before = bodies.length;
    await click(byTestId('scan-primary-action'));
    for (let i = 0; i < 40 && bodies.length === before; i++) await tick(5);
    assert.equal(bodies.length, before + 1, 'request in flight');
    await appState('inactive');
    await tick(400);
    providerDelayMs = 0;
    assert.ok(!byTestId('scan-match-best'), 'no stale preview');
    assert.ok(!byTestId('scan-service-failure'));
    assert.equal(useScanQuotaStore.getState().getRemaining(), remaining);
    assert.equal(useScanSessionStore.getState().cardCount, count);
    assert.equal(useScanDiagnosticsStore.getState().entries.at(-1).outcome, 'cancelled');
    await appState('active');
    await shutter();
    assert.ok(byTestId('scan-match-best'), 'usable again after foreground');
    await click(byTestId('scan-match-retake'));
  });
  await test('the system gallery picker backgrounding the app is part of the scan: the pick is still recognised once', async () => {
    globalThis.__nativePickerAsset = { uri: 'file:///cache/ImagePicker/pick.jpg', base64: ORIGINAL_B64, width: 1200, height: 1680 };
    globalThis.__onPickerOpen = async () => { globalThis.__setAppState('background'); globalThis.__setAppState('active'); };
    const before = bodies.length;
    await click(byTestId('scan-gallery-action'));
    for (let i = 0; i < 40 && bodies.length === before; i++) await tick(10);
    await tick(80);
    globalThis.__onPickerOpen = undefined;
    assert.equal(bodies.length, before + 1, 'gallery photo uploaded once');
    assert.ok(byTestId('scan-match-best'), 'gallery result shown');
    await click(byTestId('scan-match-retake'));
  });
  // CR 1419441: the picker may hand its asset back BEFORE the app is active again.
  const pickWhileBackgrounded = async () => {
    globalThis.__onPickerOpen = async () => { globalThis.__setAppState('background'); };
    await click(byTestId('scan-gallery-action'));
    await tick(150);
    globalThis.__onPickerOpen = undefined;
  };
  await test('picker returns its photo while the app is still in the background → nothing sent or shown until it is active, then exactly one upload', async () => {
    const before = bodies.length;
    const remaining = useScanQuotaStore.getState().getRemaining();
    const listeners = globalThis.__appStateListenerCount();
    await pickWhileBackgrounded();
    assert.equal(bodies.length, before, 'no provider request while backgrounded');
    assert.ok(!byTestId('scan-match-best'), 'no preview while backgrounded');
    assert.equal(useScanQuotaStore.getState().getRemaining(), remaining);
    assert.equal(globalThis.__appStateListenerCount(), listeners + 1, 'waiting for foreground');
    await appState('active');
    for (let i = 0; i < 40 && bodies.length === before; i++) await tick(10);
    await tick(80);
    assert.equal(bodies.length, before + 1, 'one upload after returning');
    assert.ok(byTestId('scan-match-best'), 'result shown in the foreground');
    assert.equal(globalThis.__appStateListenerCount(), listeners, 'foreground waiter removed');
    assert.equal(useScanQuotaStore.getState().getRemaining(), remaining, 'still nothing charged before add');
    await click(byTestId('scan-match-retake'));
  });
  await test('cancelled (hardware back) while waiting for the foreground → the picked photo is never sent; a fresh scan still works', async () => {
    const before = bodies.length;
    const listeners = globalThis.__appStateListenerCount();
    await pickWhileBackgrounded();
    navigations.length = 0;
    assert.equal(await back(), true);
    assert.deepEqual(navigations, [['MainDrawer', { screen: 'Home' }]]);
    assert.equal(globalThis.__appStateListenerCount(), listeners, 'waiter removed on cancel');
    await appState('active');
    await tick(200);
    assert.equal(bodies.length, before, 'the picked photo was dropped, never uploaded');
    assert.ok(!byTestId('scan-match-best'));
    await shutter();
    assert.equal(bodies.length, before + 1, 'a fresh camera scan works');
    assert.ok(byTestId('scan-match-best'));
    await click(byTestId('scan-match-retake'));
  });
} finally {
  await act(async () => root.unmount());
  host.remove();
  __setSafeAreaInsetsForTest(null);
}
await test('unmount removes the AppState and hardware-back listeners', () => {
  assert.equal(globalThis.__appStateListenerCount(), 0);
  assert.equal(globalThis.__androidBackListenerCount(), 0);
});

if ((process.exitCode ?? 0) === 0) console.log(`\n✅ scan-v39-native-render: ${passed} checks passed`);
else console.error('\n❌ scan-v39-native-render failed');
