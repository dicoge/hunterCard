#!/usr/bin/env node
/**
 * Scan best-match fix (2026-10-15) — behavioural regression.
 *
 * 1. Frame geometry: one portrait 63:88 frame for overlay, web ROI and native crop,
 *    across screen sizes, safe areas, cover-fit, non-zero origins and orientation.
 * 2. Native capture helper with a fake expo-image-manipulator: exact crop rect, size
 *    caps, crop uri for OCR, fail-safe fallbacks, sanitised logs.
 * 3. The server verdict on the real catalog: no filler, explicit failures, printing
 *    resolution, contradiction and coverage checks.
 * 4. The REAL ScanScreen through the real navigator and stores, with the REAL
 *    recognize-card handler behind a mocked Gemini reply: preview before commit,
 *    secondary correction, one charge per confirmed card, 49→50 and never 51.
 *
 * No provider, camera, photo or network is used: Gemini and the database download
 * are mocked inside globalThis.fetch.
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


// ---- network: the REAL recognize-card handler behind /api/recognize-card; only the
//      Gemini call and the database download are mocked (no provider is contacted).
import fs from 'node:fs';
const DB = JSON.parse(fs.readFileSync(new URL('../public/data/database.json', import.meta.url), 'utf8'));
let geminiReply = '';
let geminiCalls = 0;
const recognitionBodies = [];
const realHandler = (await import('../api/recognize-card.ts')).default;
process.env.GEMINI_API_KEY = 'test-key-never-sent';
globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  // Only the handler's canonical catalog URL gets the catalog; app screens (Search,
  // Home) fall through to 404 so jsdom does not render 3,900 cards.
  if (href === 'https://holohunter.dicoge.com/data/database.json') return Response.json(DB);
  if (href.includes('generativelanguage.googleapis.com')) {
    geminiCalls += 1;
    return Response.json({ candidates: [{ content: { parts: [{ text: geminiReply }] } }] });
  }
  if (href.includes('/api/recognize-card')) {
    recognitionBodies.push(JSON.parse(init.body));
    const res = await realHandler(new Request('https://holohunter.dicoge.com/api/recognize-card', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: init.body,
    }));
    const text = await res.text();
    return { ok: res.ok, status: res.status, json: async () => JSON.parse(text) };
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
};
const reply = (o) => Object.entries({ CHARACTER: 'NONE', HP: 'NONE', RARITY: 'NONE', BLOOM_LEVEL: 'NONE', CARD_NUMBER: 'NONE', TITLE: 'NONE', ...o })
  .map(([k, v]) => `${k}: ${v}`).join('\n');

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { NavigationContainer, createNavigationContainerRef } = await import('@react-navigation/native');
const { StackNavigator } = await import('../src/navigation/AppNavigator.tsx');
const { useScanSessionStore } = await import('../src/stores/scanSessionStore.ts');
const { useScanQuotaStore } = await import('../src/store/scanQuotaStore.ts');
const { usePhotoUploadConsentStore } = await import('../src/store/photoUploadConsentStore.ts');
const { PHOTO_UPLOAD_DISCLOSURE_VERSION } = await import('../src/services/photoUploadDisclosure.ts');
const { MONTHLY_SCAN_LIMIT } = await import('../src/services/permissionService.ts');
const { rankCandidates } = await import('../api/recognize-card.ts');
const geo = await import('../src/utils/scanFrame.ts');
const { mapViewportRectToSource } = await import('../src/utils/scanGeometry.ts');
const { prepareNativeScanImages } = await import('../src/services/nativeScanCapture.ts');
const { presentMatch, presentCandidates, withoutPrintingPrice } = await import('../src/services/scanPresentation.ts');

let passed = 0;
async function test(label, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (err) { process.exitCode = 1; console.error(`  ✗ ${label} — ${err.message}`); }
}
const near = (a, b, eps = 1.5) => Math.abs(a - b) <= eps;

// ============================ 1. frame geometry ============================
console.log('\nScan frame geometry (overlay = web ROI = native crop)');
const SCREENS = [
  { name: 'iPhone SE 320×568', width: 320, height: 568 },
  { name: 'phone 390×844', width: 390, height: 844 },
  { name: 'tall Android 412×915', width: 412, height: 915 },
  { name: 'tablet 768×1024', width: 768, height: 1024 },
  { name: 'desktop 1440×900', width: 1440, height: 900 },
  { name: 'landscape phone 844×390', width: 844, height: 390 },
];
await test('frame keeps the 63:88 card ratio and fits inside every viewport', () => {
  for (const s of SCREENS) {
    const f = geo.computeScanFrameSize(s);
    assert.ok(near(f.height / f.width, 88 / 63, 0.02), `${s.name}: ratio ${f.height / f.width}`);
    assert.ok(f.width <= s.width, `${s.name}: wider than viewport`);
    const r = geo.defaultScanFrameRect(s);
    assert.ok(r.x >= 0 && r.x + r.width <= s.width, `${s.name}: x out of bounds`);
    if (s.height >= geo.FRAME_RESERVED.top + geo.FRAME_RESERVED.bottom + geo.MIN_FRAME_WIDTH * geo.CARD_ASPECT) {
      assert.ok(r.y >= geo.FRAME_RESERVED.top && r.y + r.height <= s.height - geo.FRAME_RESERVED.bottom + 1, `${s.name}: overlaps bars`);
    }
  }
});
await test('frame is LARGER than v37 (min(0.64w, 280) × 1.4) on phones and desktop', () => {
  for (const s of SCREENS.slice(1, 5)) {
    const v37 = Math.min(s.width * 0.64, 280);
    assert.ok(geo.computeScanFrameSize(s).width > v37, `${s.name}: ${geo.computeScanFrameSize(s).width} <= v37 ${v37}`);
  }
});
await test('safe-area insets shrink the frame instead of letting it run under the notch / home bar', () => {
  const plain = geo.computeScanFrameSize({ width: 390, height: 700 });
  const inset = geo.computeScanFrameSize({ width: 390, height: 700 }, { top: 47, bottom: 34 });
  assert.ok(inset.height < plain.height);
  const r = geo.defaultScanFrameRect({ width: 390, height: 700 }, { top: 47, bottom: 34 });
  assert.ok(r.y >= 47 + geo.FRAME_RESERVED.top);
});

await test('native crop: portrait 4:3 photo behind a tall preview maps the frame through cover-fit', () => {
  const preview = { x: 0, y: 0, width: 390, height: 844 };
  const frame = geo.defaultScanFrameRect(preview);
  const plan = geo.planNativeCrop(preview, frame, { width: 3024, height: 4032 });
  assert.equal(plan.ok, true);
  // cover scale = max(390/3024, 844/4032) = 0.2093; visible width = 390/0.2093 = 1863px centred
  const scale = Math.max(390 / 3024, 844 / 4032);
  const offsetX = (3024 * scale - 390) / 2;
  const expectX = (frame.x - frame.width * geo.CROP_PAD.padXRatio + offsetX) / scale;
  assert.ok(near(plan.crop.x, expectX, 2), `x ${plan.crop.x} vs ${expectX}`);
  assert.ok(near(plan.crop.height / plan.crop.width, (frame.height * 1.08) / (frame.width * 1.12), 0.02), 'crop keeps padded frame aspect');
  assert.ok(plan.crop.x + plan.crop.width <= 3024 && plan.crop.y + plan.crop.height <= 4032);
});
await test('native crop: non-zero preview offset (status bar / header) moves the crop by exactly that offset', () => {
  const photo = { width: 1200, height: 1600 };
  const base = geo.planNativeCrop({ x: 0, y: 0, width: 300, height: 400 }, { x: 50, y: 60, width: 200, height: 280 }, photo);
  const shifted = geo.planNativeCrop({ x: 0, y: 100, width: 300, height: 400 }, { x: 50, y: 160, width: 200, height: 280 }, photo);
  assert.deepEqual(shifted, base);
});
await test('native crop: unrotated photo (landscape pixels, portrait preview) is refused, not mis-cropped', () => {
  const plan = geo.planNativeCrop({ x: 0, y: 0, width: 390, height: 844 }, { x: 40, y: 100, width: 300, height: 419 }, { width: 4032, height: 3024 });
  assert.deepEqual(plan, { ok: false, reason: 'orientation_mismatch' });
});
await test('native crop: landscape preview + landscape photo is accepted (device rotated)', () => {
  const plan = geo.planNativeCrop({ x: 0, y: 0, width: 844, height: 390 }, { x: 330, y: 40, width: 220, height: 307 }, { width: 4032, height: 1868 });
  assert.equal(plan.ok, true);
});
await test('native crop: missing layout / photo size / off-screen frame fail closed with a reason', () => {
  assert.equal(geo.planNativeCrop(null, { x: 0, y: 0, width: 1, height: 1 }, { width: 10, height: 10 }).reason, 'no_layout');
  assert.equal(geo.planNativeCrop({ x: 0, y: 0, width: 390, height: 844 }, { x: 10, y: 10, width: 100, height: 140 }, null).reason, 'no_photo_size');
  assert.equal(geo.planNativeCrop({ x: 0, y: 0, width: 390, height: 844 }, { x: 500, y: 10, width: 100, height: 140 }, { width: 3000, height: 4000 }).reason, 'frame_outside_preview');
});
await test('web ROI: object-fit cover video (1280×720) in a portrait viewport with a non-zero origin', () => {
  const video = { x: 0, y: 56, width: 390, height: 788 };
  const local = geo.defaultScanFrameRect({ width: video.width, height: video.height });
  const overlay = { ...local, x: video.x + local.x, y: video.y + local.y };
  const crop = mapViewportRectToSource(video, { width: 1280, height: 720 }, overlay, geo.CROP_PAD);
  const scale = Math.max(390 / 1280, 788 / 720);
  const offsetX = (1280 * scale - 390) / 2;
  assert.ok(near(crop.x, (local.x - local.width * 0.06 + offsetX) / scale, 1));
  assert.ok(near(crop.y, Math.max(0, (local.y - local.height * 0.04) / scale), 1));
  assert.ok(crop.x + crop.width <= 1280 && crop.y + crop.height <= 720);
});

// ===================== 2. native capture → [context, crop] =====================
console.log('\nNative capture helper (fake expo-image-manipulator)');
function fakeManipulator(log, { fail = false } = {}) {
  const ctx = (uri) => {
    const ops = [];
    const c = {
      crop(r) { ops.push(['crop', r]); return c; },
      resize(r) { ops.push(['resize', r]); return c; },
      async renderAsync() {
        if (fail) throw new Error('native boom');
        return { async saveAsync(o) { log.push({ uri, ops, o }); const isCrop = ops.some((x) => x[0] === 'crop'); return { base64: isCrop ? 'CROPB64' : 'FULLB64', uri: isCrop ? 'file:///cache/crop.jpg' : 'file:///cache/full.jpg' }; } };
      },
    };
    return c;
  };
  return () => ({ ImageManipulator: { manipulate: ctx }, SaveFormat: { JPEG: 'jpeg' } });
}
const SHOT = { uri: 'file:///cache/shot.jpg', width: 3024, height: 4032, base64: 'ORIGINALB64' };
await test('crops exactly the planned rect, caps sizes, returns full context + crop + the crop uri for OCR', async () => {
  const plan = geo.planNativeCrop({ x: 0, y: 0, width: 390, height: 844 }, geo.defaultScanFrameRect({ width: 390, height: 844 }), SHOT);
  const log = [];
  const out = await prepareNativeScanImages(SHOT, plan, { requireImpl: fakeManipulator(log), log: () => {} });
  const cropCall = log.find((l) => l.ops.some((o) => o[0] === 'crop'));
  assert.deepEqual(cropCall.ops[0][1], { originX: plan.crop.x, originY: plan.crop.y, width: plan.crop.width, height: plan.crop.height });
  const fullCall = log.find((l) => !l.ops.some((o) => o[0] === 'crop'));
  assert.deepEqual(fullCall.ops[0], ['resize', { height: 1280 }]);
  assert.equal(cropCall.o.base64, true);
  assert.deepEqual({ b: out.base64, c: out.cropBase64, u: out.cropUri }, { b: 'FULLB64', c: 'CROPB64', u: 'file:///cache/crop.jpg' });
});
await test('missing module / native failure / refused plan → original photo only, sanitised reason, never throws', async () => {
  const msgs = [];
  const plan = geo.planNativeCrop({ x: 0, y: 0, width: 390, height: 844 }, { x: 40, y: 100, width: 300, height: 419 }, SHOT);
  const a = await prepareNativeScanImages(SHOT, plan, { requireImpl: () => { throw new Error('no module'); }, log: (m) => msgs.push(m) });
  const b = await prepareNativeScanImages(SHOT, plan, { requireImpl: fakeManipulator([], { fail: true }), log: (m) => msgs.push(m) });
  const c = await prepareNativeScanImages(SHOT, { ok: false, reason: 'orientation_mismatch' }, { requireImpl: fakeManipulator([]), log: (m) => msgs.push(m) });
  for (const r of [a, b, c]) { assert.equal(r.base64, 'ORIGINALB64'); assert.equal(r.cropBase64, null); }
  assert.deepEqual([a.cropSkipped, b.cropSkipped, c.cropSkipped], ['manipulator_unavailable', 'manipulator_failed', 'orientation_mismatch']);
  assert.ok(msgs.every((m) => !m.includes('file://') && !m.includes('B64')), 'logs carry no uri / image data');
});

// ===================== 3. server verdict on the real catalog =====================
console.log('\nServer verdict (real catalog, extraction fixtures)');
const verdict = (o) => rankCandidates(DB.cards, { characterName: '', hp: '', rarity: '', bloom: '', cardNumberRaw: '', cardTitle: '', ...o });
await test('blank extraction → no candidates at all, no_evidence (v37 ranked every original print at +1.5)', () => {
  const r = verdict({});
  assert.equal(r.candidates.length, 0);
  assert.equal(r.match.status, 'no_match');
  assert.equal(r.match.reason, 'no_evidence');
});
await test('metadata-only (rarity / HP / type) → no candidates', () => {
  const r = verdict({ rarity: 'SEC', hp: '200', bloom: '1st' });
  assert.equal(r.candidates.length, 0);
  assert.equal(r.match.status, 'no_match');
});
await test('number not in the catalog → explicit no_match, not a name-based filler card', () => {
  const r = verdict({ cardNumberRaw: 'hZZ99-999', characterName: '天音かなた' });
  assert.equal(r.match.status, 'no_match');
  assert.equal(r.match.reason, 'number_not_in_database');
  assert.equal(r.match.best, null);
});
await test('exact number contradicted by the character → number_name_conflict, offered only as correction', () => {
  const r = verdict({ cardNumberRaw: 'hBP01-010', characterName: 'さくらみこ' });
  assert.equal(r.match.reason, 'number_name_conflict');
  assert.equal(r.match.best, null);
  assert.equal(r.match.alternatives[0].cardNumber, 'hBP01-010');
});
await test('unique printing by number → matched, printing resolved, evidence names the number', () => {
  const r = verdict({ cardNumberRaw: 'hBP01-010', characterName: '天音かなた' });
  assert.equal(r.match.status, 'matched');
  assert.equal(r.match.best.id, 'hBP01-010_hBP01_U_hBP01-010_U');
  assert.ok(r.match.evidence.includes('cardNumber exact'));
});
await test('several printings, rarity read singles one out → matched with the others as correction', () => {
  const r = verdict({ cardNumberRaw: 'hBP01-001', rarity: 'OUR' });
  assert.equal(r.match.status, 'matched');
  assert.equal(r.match.best.rarity, 'OUR');
  assert.deepEqual(r.match.alternatives.map((c) => c.rarity), ['OSR']);
});
await test('several printings, nothing singles one out → identity_only (no price may be shown)', () => {
  const r = verdict({ cardNumberRaw: 'hBP01-024' });
  assert.equal(r.match.status, 'identity_only');
  assert.equal(r.match.printingResolved, false);
  assert.ok(r.match.alternatives.length >= 3 && r.match.alternatives.every((c) => c.cardNumber === 'hBP01-024'));
  const p = presentMatch({ match: { ...r.match, alternatives: r.match.alternatives.map((c) => ({ card: c, confidence: 0 })) }, card: r.match.best });
  assert.equal(p.kind, 'identity');
  assert.equal(p.card.sellPrice, null);
  assert.deepEqual(p.card.prices, []);
});
await test('one-character OCR slip is accepted only when the character independently agrees', () => {
  assert.equal(verdict({ cardNumberRaw: 'hBP01-910', characterName: '天音かなた' }).match.status, 'matched');
  assert.equal(verdict({ cardNumberRaw: 'hBP01-910' }).match.status, 'no_match');
});
await test('language / set identity: the printing comes from the catalog id, never from a sibling set', () => {
  const r = verdict({ cardNumberRaw: 'hBP01-001', rarity: 'OSR', characterName: '天音かなた' });
  assert.equal(r.match.best.id, 'hBP01-001_hBP01_OSR_hBP01-001_OSR');
  assert.equal(r.match.best.series, 'hBP01');
});
await test('client: candidates with mixed numbers are a no-match with suggestions, never a forced picker', () => {
  const p = presentCandidates([{ card: { cardNumber: 'a-1', id: 'x' }, confidence: 0.4 }, { card: { cardNumber: 'b-2', id: 'y' }, confidence: 0.3 }]);
  assert.equal(p.kind, 'none');
  assert.equal(p.suggestions.length, 2);
  assert.equal(withoutPrintingPrice({ sellPrice: 5, buyPrice: 3, prices: [1] }).sellPrice, null);
});

// ===================== 4. the real screen =====================
console.log('\nReal ScanScreen: preview, correction, quota');
const byTestId = (el, id) => el.querySelector(`[data-testid="${id}"]`);
const tick = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const click = async (el) => {
  assert.ok(el, 'element to click exists');
  await act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); await Promise.resolve(); });
};
usePhotoUploadConsentStore.setState({ acceptedVersion: PHOTO_UPLOAD_DISCLOSURE_VERSION });
const reset = (used = 0) => { useScanSessionStore.setState({ cards: [] }); useScanQuotaStore.getState().resetQuota(); useScanQuotaStore.setState({ scanCount: used }); };
const session = () => useScanSessionStore.getState().cards.map((c) => c.id);
const used = () => useScanQuotaStore.getState().scanCount;

const host = dom.window.document.createElement('div');
dom.window.document.body.appendChild(host);
const root = createRoot(host);
const navRef = createNavigationContainerRef();
await act(async () => root.render(React.createElement(NavigationContainer, { ref: navRef }, React.createElement(StackNavigator))));
await tick(30);
await act(async () => { navRef.navigate('MainDrawer', { screen: 'Scan' }); });
await tick(60);
const allow = byTestId(host, 'scan-permission-allow');
if (allow) { await click(allow); await tick(80); await tick(0); }

async function scan(replyText) {
  geminiReply = replyText;
  const before = geminiCalls;
  await click(byTestId(host, 'scan-primary-action'));
  for (let i = 0; i < 20 && geminiCalls === before; i++) await tick(10);
  await tick(60);
  assert.equal(geminiCalls, before + 1, 'the shutter ran exactly one (mocked) recognition');
}

try {
  await test('the shutter sends full frame + portrait ROI crop, both validated JPEG data URLs', async () => {
    reset();
    await scan(reply({ CARD_NUMBER: 'hBP01-010', CHARACTER: '天音かなた' }));
    const body = recognitionBodies.at(-1);
    assert.equal(body.images.length, 2);
    assert.ok(body.images.every((i) => i.startsWith('data:image/jpeg;base64,/9j/')));
    await click(byTestId(host, 'scan-match-retake'));
  });

  await test('valid best match is SHOWN as a preview — nothing added or charged until 加入', async () => {
    reset();
    await scan(reply({ CARD_NUMBER: 'hBP01-010', CHARACTER: '天音かなた' }));
    assert.ok(byTestId(host, 'scan-match-best'), 'best-match preview is visible');
    assert.equal(host.textContent.includes('%'), false, 'no percentage anywhere on screen');
    assert.ok(byTestId(host, 'scan-match-evidence').textContent.includes('hBP01-010'));
    assert.deepEqual(session(), []);
    assert.equal(used(), 0);
    const add = byTestId(host, 'scan-match-add');
    await click(add);
    await click(add);
    await tick(20);
    assert.deepEqual(session(), ['hBP01-010_hBP01_U_hBP01-010_U']);
    assert.equal(used(), 1, 'one confirmed add = one charge, double tap ignored');
  });

  await test('correction is secondary: 更正 → pick the other printing → that one added, charged once', async () => {
    reset();
    await scan(reply({ CARD_NUMBER: 'hBP01-001', RARITY: 'OUR', CHARACTER: '天音かなた' }));
    assert.ok(byTestId(host, 'scan-match-best'));
    await click(byTestId(host, 'scan-match-correct'));
    await tick(20);
    assert.equal(byTestId(host, 'scan-match-best'), null, 'preview replaced by the correction list');
    const metas = [...host.querySelectorAll('[data-testid="scan-candidate-meta"]')];
    const osr = metas.find((m) => m.textContent.includes('OSR'));
    assert.ok(osr, 'the other printing is offered');
    await click(osr);
    await tick(20);
    assert.deepEqual(session(), ['hBP01-001_hBP01_OSR_hBP01-001_OSR']);
    assert.equal(used(), 1);
  });

  await test('no valid match → explicit failure, no card, no picker, no charge', async () => {
    reset();
    await scan(reply({ CARD_NUMBER: 'hZZ99-999', CHARACTER: '天音かなた' }));
    assert.ok(byTestId(host, 'scan-match-none'));
    assert.equal(host.querySelector('[data-testid="scan-candidate-meta"]'), null);
    assert.deepEqual(session(), []);
    assert.equal(used(), 0);
    await click(byTestId(host, 'scan-match-retake'));
  });

  await test('blank photo reading → explicit failure, no filler candidates', async () => {
    reset();
    await scan(reply({}));
    assert.ok(byTestId(host, 'scan-match-none'));
    assert.equal(byTestId(host, 'scan-match-suggestions'), null);
    await click(byTestId(host, 'scan-match-retake'));
  });

  await test('identity without printing: no price shown; 選擇版本 → pick → charged once', async () => {
    reset();
    await scan(reply({ CARD_NUMBER: 'hBP01-024' }));
    const sheet = byTestId(host, 'scan-match-identity');
    assert.ok(sheet);
    assert.ok(!/[¥$]\s?\d/.test(sheet.textContent), 'no price for an unresolved printing');
    await click(byTestId(host, 'scan-match-pick'));
    await tick(20);
    const metas = [...host.querySelectorAll('[data-testid="scan-candidate-meta"]')];
    assert.ok(metas.length >= 3);
    await click(metas[0]);
    await tick(20);
    assert.equal(session().length, 1);
    assert.ok(session()[0].startsWith('hBP01-024'));
    assert.equal(used(), 1);
  });

  await test(`quota 49 → add → ${MONTHLY_SCAN_LIMIT}; at the limit a scan is refused and the count never reaches 51`, async () => {
    reset(MONTHLY_SCAN_LIMIT - 1);
    await scan(reply({ CARD_NUMBER: 'hBP01-010', CHARACTER: '天音かなた' }));
    await click(byTestId(host, 'scan-match-add'));
    await tick(20);
    assert.equal(used(), MONTHLY_SCAN_LIMIT);
    useScanSessionStore.setState({ cards: [] });
    const before = geminiCalls;
    await click(byTestId(host, 'scan-primary-action'));
    await tick(60);
    assert.equal(geminiCalls, before, 'no upload at the limit');
    assert.equal(used(), MONTHLY_SCAN_LIMIT);
    assert.deepEqual(session(), []);
  });

  await test('leaving the screen with a preview open discards it: nothing added, nothing charged', async () => {
    reset();
    await scan(reply({ CARD_NUMBER: 'hBP01-010', CHARACTER: '天音かなた' }));
    assert.ok(byTestId(host, 'scan-match-best'));
    await act(async () => { navRef.navigate('MainDrawer', { screen: 'Tutorial' }); });
    await tick(30);
    await act(async () => { navRef.navigate('MainDrawer', { screen: 'Scan' }); });
    await tick(60);
    assert.equal(byTestId(host, 'scan-match-best'), null);
    assert.deepEqual(session(), []);
    assert.equal(used(), 0);
  });
} finally {
  await act(async () => root.unmount());
  host.remove();
}

if ((process.exitCode ?? 0) === 0) console.log(`\n✅ scan-best-match: ${passed} checks passed`);
else console.error('\n❌ scan-best-match failed');
