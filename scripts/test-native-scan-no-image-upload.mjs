#!/usr/bin/env node
/**
 * Native scan upload contract (supersedes the DIC-1248 "no image leaves the device" gate).
 *
 * Owner product decision 2026-10-14: the native app formally uploads the card photo to our
 * backend (/api/recognize-card), which forwards it to the existing Google Gemini provider,
 * with an in-app disclosure first. The old gate asserted the opposite — that native POSTed
 * the bare `file://` uri — which is the defect this change fixes: the server wrapped that
 * path as base64 and Gemini could never decode it.
 *
 * This gate keeps the old one's method (run the REAL recognizeCardFromImage under
 * React-Native-shaped globals with every transport intercepted) and asserts the NEW
 * contract on the bytes that go out:
 *
 *   1. what is POSTed is a data:image/<sniffed type>;base64 URL of exactly the captured
 *      bytes — never the uri, never a re-wrapped string;
 *   2. no base64 → nothing is sent (the uri alone is refused locally, not uploaded);
 *   3. timeout and cancellation abort the request; Tesseract (web OCR) is never loaded,
 *      so the native OCR fallback (expo-ocr-kit via the flow's ocrText) is reached;
 *   4. failed / timed-out / cancelled scans never charge the shared 50/month quota, a
 *      success charges exactly once, and concurrent successes cannot over- or
 *      under-count (charge is a single atomic increment at commit; there is no reserve to
 *      roll back, so nothing is ever deleted from the count);
 *   5. nothing logged contains image data.
 *
 * Every provider / network call is a mock. No real photo, device or Gemini call.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.EXPO_PUBLIC_STORE_MVP ??= '1';

let checks = 0;
async function check(label, fn) {
  await fn();
  checks += 1;
  process.stdout.write(`  ok  ${label}\n`);
}

// ------------------------------------------------------------ module aliasing
// Native resolution: Metro picks `*.native.ts`; mirror that for the two modules whose
// platform split this contract depends on, and record every resolved url so the test can
// prove the web OCR module (and tesseract.js) never loads.
const { port1, port2 } = new MessageChannel();
const resolved = [];
port1.on('message', (url) => resolved.push(url));
port1.unref();

register(
  'data:text/javascript,' +
    encodeURIComponent(`
      import { existsSync, readFileSync } from 'node:fs';
      import { fileURLToPath } from 'node:url';
      import { extname } from 'node:path';
      let port;
      export function initialize(data) { port = data.port; }
      const RN_STUB = 'data:text/javascript,' + encodeURIComponent(
        "export const Platform = { OS: 'android', select: (o) => (o.android !== undefined ? o.android : o.default) };" +
        "export default { Platform };"
      );
      // authStore drags in expo-auth-session (native-only); the quota store only reads
      // its role, so a role holder stands in. Real role mapping: test:guest-scan-quota.
      const AUTH_STUB = 'data:text/javascript,' + encodeURIComponent(
        "let state = { role: 'guest', isGuest: true, isAuthenticated: false };" +
        "export const useAuthStore = { getState: () => state, setState: (p) => { state = { ...state, ...p }; } };"
      );
      const NATIVE_SPLIT = ['scanRuntime', 'webOcr'];
      export async function resolve(specifier, context, next) {
        if (specifier === 'react-native') return { url: RN_STUB, shortCircuit: true };
        if (specifier.endsWith('/authStore')) return { url: AUTH_STUB, shortCircuit: true };
        if (specifier === 'tesseract.js') port.postMessage('tesseract.js');
        const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
        if (isRelative && extname(specifier) === '' && context.parentURL) {
          const base = specifier.split('/').pop();
          const candidates = NATIVE_SPLIT.includes(base) ? ['.native.ts', '.ts'] : ['.ts', '/index.ts'];
          for (const ext of candidates) {
            const url = new URL(specifier + ext, context.parentURL);
            if (existsSync(fileURLToPath(url))) {
              port.postMessage(url.href);
              return next(url.href, context);
            }
          }
        }
        return next(specifier, context);
      }
      // The native catalog loader (src/utils/staticData.ts) imports the bundled JSON with a
      // plain import, as Metro does; Node needs it loaded as JSON (same as register-ts.mjs).
      export async function load(url, context, next) {
        if (url.endsWith('.json')) {
          return { format: 'json', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true };
        }
        return next(url, context);
      }
    `),
  import.meta.url,
  { data: { port: port2 }, transferList: [port2] },
);

// ------------------------------------------------- React-Native-shaped globals
delete globalThis.document;
delete globalThis.Image;
delete globalThis.HTMLCanvasElement;
globalThis.window = globalThis;
delete globalThis.window.location;

// Logs must never carry image data: capture everything printed during the probe.
const logged = [];
for (const level of ['log', 'warn', 'error', 'info']) {
  const original = console[level].bind(console);
  console[level] = (...args) => { logged.push(args.map(String).join(' ')); if (process.env.VERBOSE) original(...args); };
}

// A JPEG signature plus a body long enough to look like a photo on the wire.
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 0x5a)]);
const JPEG_B64 = JPEG_BYTES.toString('base64');
const PNG_B64 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 1)]).toString('base64');
const FILE_URI = 'file:///data/user/0/com.dicoge.holohunter/cache/Camera/scan-1.jpg';
const CONTENT_URI = 'content://media/external/images/media/1024';

const API_CARD = {
  id: 'hBP04-005_hBP04_SEC', cardNumber: 'hBP04-005', name: 'ラプラス・ダークネス', sellPrice: 1280,
  series: 'hBP04', rarity: 'SEC', imageUrl: '', prices: [], priceHistory: {}, type: '', grade: '',
};

// ------------------------------------------------------------- transport mock
const captured = [];
let mode = 'success';
globalThis.XMLHttpRequest = class {
  open(method, url) { this._url = String(url); }
  setRequestHeader() {}
  send(body) { captured.push({ url: this._url, body, transport: 'xhr' }); queueMicrotask(() => this.onerror?.(new Error('xhr blocked'))); }
  abort() {}
};
const hang = (signal) => new Promise((_r, reject) => {
  const done = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  if (signal?.aborted) return done();
  signal?.addEventListener('abort', done);
});
globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (href.startsWith('file:') || href.startsWith('content:')) throw new Error('local file read is not the upload path');
  captured.push({ url: href, body: init.body, signal: init.signal });
  if (!href.includes('/api/recognize-card')) throw new Error(`unexpected fetch ${href}`);
  if (mode === 'hang') return hang(init.signal);
  if (mode === 'provider-502') return Response.json({ success: false, error: 'gemini API error (500)' }, { status: 502 });
  if (mode === 'network') throw new TypeError('Network request failed');
  return Response.json({ success: true, card: API_CARD, confidence: 0.95, candidates: [API_CARD] });
};

// Collapse the 15s request deadline so the timeout leg runs in milliseconds.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
// Track the request-deadline timers so the suite can prove none is leaked.
const deadlineTimers = new Set();
globalThis.setTimeout = (fn, ms, ...rest) => {
  if (ms !== 15000) return realSetTimeout(fn, ms, ...rest);
  const id = realSetTimeout((...a) => { deadlineTimers.delete(id); fn(...a); }, 5, ...rest);
  deadlineTimers.add(id);
  return id;
};
globalThis.clearTimeout = (id) => { deadlineTimers.delete(id); return realClearTimeout(id); };

const { recognizeCardFromImage } = await import(pathToFileURL(path.join(ROOT, 'src/services/cardRecognition.ts')).href);
const { runNativeCameraScan, NO_TEXT_GUIDANCE, PHOTO_NOT_UPLOADED_GUIDANCE } = await import(
  pathToFileURL(path.join(ROOT, 'src/services/scanRecognitionFlow.ts')).href
);
const { RECOGNITION_UNAVAILABLE_MESSAGE } = await import(pathToFileURL(path.join(ROOT, 'src/services/recognitionOutcome.ts')).href);
const { SCAN_RUNTIME } = await import(pathToFileURL(path.join(ROOT, 'src/services/scanRuntime.native.ts')).href);
const { useScanQuotaStore } = await import(pathToFileURL(path.join(ROOT, 'src/store/scanQuotaStore.ts')).href);
const { useAuthStore } = await import('../src/store/authStore');
const { MONTHLY_SCAN_LIMIT } = await import(pathToFileURL(path.join(ROOT, 'src/services/permissionService.ts')).href);

const lastBody = () => JSON.parse(captured.filter((c) => c.url.includes('/api/recognize-card')).at(-1).body);
const reset = (m) => { captured.length = 0; mode = m; };

process.stdout.write('\nNative upload payload\n');

await check('the probe really runs the native split (scanRuntime.native, webOcr.native) without a DOM', () => {
  assert.equal(SCAN_RUNTIME, 'native');
  assert.equal(typeof globalThis.Image, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');
  assert.ok(resolved.some((u) => u.endsWith('/src/services/webOcr.native.ts')), 'webOcr.native.ts was not resolved');
  assert.ok(resolved.some((u) => u.endsWith('/src/services/scanRuntime.native.ts')));
});

await check('a camera capture uploads a data:image/jpeg URL of exactly the captured bytes', async () => {
  reset('success');
  const result = await recognizeCardFromImage(FILE_URI, { base64: JPEG_B64 });
  assert.equal(result.success, true);
  const body = lastBody();
  assert.equal(body.image, `data:image/jpeg;base64,${JPEG_B64}`);
  assert.ok(!captured.some((c) => String(c.body).includes('file://')), 'the device path must not be on the wire');
  assert.ok(captured.every((c) => typeof c.body === 'string'), 'JSON body only — no Blob / FormData side channel');
});

await check('the MIME type comes from the bytes (PNG library pick → data:image/png)', async () => {
  reset('success');
  await recognizeCardFromImage(CONTENT_URI, { base64: PNG_B64 });
  assert.ok(lastBody().image.startsWith('data:image/png;base64,'));
});

await check('line-wrapped base64 from a platform encoder is normalised, not rejected', async () => {
  reset('success');
  const wrapped = JPEG_B64.replace(/(.{76})/g, '$1\n');
  await recognizeCardFromImage(FILE_URI, { base64: wrapped });
  assert.equal(lastBody().image, `data:image/jpeg;base64,${JPEG_B64}`);
});

await check('native frame crop: [context photo, crop] are sent as two validated data URLs of exactly those bytes', async () => {
  reset('success');
  await recognizeCardFromImage(FILE_URI, { base64: JPEG_B64, cropBase64: PNG_B64 });
  const body = lastBody();
  assert.deepEqual(body.images, [`data:image/jpeg;base64,${JPEG_B64}`, `data:image/png;base64,${PNG_B64}`]);
  assert.equal(body.image, body.images[0], 'v37 servers read `image`; it stays the first image');
});

await check('native frame crop: if the pair would exceed the request cap the crop (the card) goes alone', async () => {
  reset('success');
  const bigJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2_400_000, 1)]).toString('base64');
  const crop = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(800_000, 2)]).toString('base64');
  await recognizeCardFromImage(FILE_URI, { base64: bigJpeg, cropBase64: crop });
  assert.deepEqual(lastBody().images, [`data:image/jpeg;base64,${crop}`]);
});

await check('native frame crop: a corrupt crop is dropped and the valid context photo is still sent', async () => {
  reset('success');
  await recognizeCardFromImage(FILE_URI, { base64: JPEG_B64, cropBase64: FILE_URI });
  assert.deepEqual(lastBody().images, [`data:image/jpeg;base64,${JPEG_B64}`]);
});

for (const [label, base64, code] of [
  ['no base64 (uri only)', undefined, 'IMAGE_MISSING'],
  ['a file:// uri in the base64 field', FILE_URI, 'IMAGE_URI_NOT_ALLOWED'],
  ['a content:// uri in the base64 field', CONTENT_URI, 'IMAGE_URI_NOT_ALLOWED'],
  ['corrupt base64', 'not*base64*at*all!!', 'IMAGE_INVALID_BASE64'],
  ['bytes that are not JPEG/PNG/WebP (e.g. HEIC)', Buffer.from('\0\0\0\x18ftypheic' + 'x'.repeat(40)).toString('base64'), 'IMAGE_UNSUPPORTED_TYPE'],
  ['an oversized photo', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2_600_000, 1)]).toString('base64'), 'IMAGE_TOO_LARGE'],
]) {
  await check(`${label} → nothing is sent, refused locally as ${code}`, async () => {
    reset('success');
    const result = await recognizeCardFromImage(FILE_URI, { base64 });
    assert.equal(captured.length, 0, 'no request may be made');
    assert.equal(result.success, false);
    assert.equal(result.imageRejected, code);
  });
}

await check('timeout aborts the request and reports timedOut + serviceUnavailable', async () => {
  reset('hang');
  const result = await recognizeCardFromImage(FILE_URI, { base64: JPEG_B64 });
  assert.equal(result.timedOut, true);
  assert.equal(result.serviceUnavailable, true);
  assert.equal(captured[0].signal.aborted, true, 'the fetch signal must be aborted');
});

await check('cancellation aborts the in-flight request and returns cancelled', async () => {
  reset('hang');
  const controller = new AbortController();
  const pending = recognizeCardFromImage(FILE_URI, { base64: JPEG_B64, signal: controller.signal });
  await new Promise((r) => realSetTimeout(r, 1));
  controller.abort();
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(captured[0].signal.aborted, true);
});

await check('an already-cancelled scan sends nothing', async () => {
  reset('success');
  const controller = new AbortController();
  controller.abort();
  const result = await recognizeCardFromImage(FILE_URI, { base64: JPEG_B64, signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.equal(captured.length, 0);
});

/** A signal whose listener registrations are counted, to prove cleanup. */
function countedSignal(controller) {
  const signal = controller.signal;
  const counts = { add: 0, remove: 0 };
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...a) => { counts.add += 1; return add(...a); };
  signal.removeEventListener = (...a) => { counts.remove += 1; return remove(...a); };
  return { signal, counts };
}

await check('abort while the payload is being prepared (valid base64, aborted right after the call): no fetch, cancelled', async () => {
  reset('success');
  const controller = new AbortController();
  const pending = recognizeCardFromImage(FILE_URI, { base64: JPEG_B64, signal: controller.signal });
  controller.abort(); // lands inside the await of payload preparation
  const result = await pending;
  assert.equal(captured.length, 0, 'a cancelled scan must not upload');
  assert.equal(result.cancelled, true);
  assert.equal(deadlineTimers.size, 0, 'no request timer was armed');
});

await check('success / timeout / cancel each release the deadline timer and the abort listener', async () => {
  for (const [m, abortMidway] of [['success', false], ['hang', false], ['hang', true]]) {
    reset(m);
    const ctrl = new AbortController();
    const wrapped = countedSignal(ctrl);
    const pending = recognizeCardFromImage(FILE_URI, { base64: JPEG_B64, signal: wrapped.signal });
    if (abortMidway) { await new Promise((r) => realSetTimeout(r, 1)); ctrl.abort(); }
    await pending;
    assert.equal(wrapped.counts.add, wrapped.counts.remove, `${m}${abortMidway ? '+abort' : ''}: listener leaked`);
    assert.equal(deadlineTimers.size, 0, `${m}${abortMidway ? '+abort' : ''}: deadline timer leaked`);
  }
});

// ------------------------------------------------- flow + quota (real store)
process.stdout.write('\nNative flow, OCR fallback and the shared 50/month quota\n');

function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function seedQuota(count, role = 'guest') {
  useAuthStore.setState({ role, isGuest: role === 'guest', isAuthenticated: role !== 'guest' });
  useScanQuotaStore.setState({ scanCount: count, currentMonth: monthKey() });
}
const count = () => useScanQuotaStore.getState().scanCount;

/** Mirrors ScanScreen.commitCard: the ONE place a scan is charged (atomic increment). */
function harness({ ocrText = '', base64 = JPEG_B64, signal, mounted = () => true } = {}) {
  const committed = [];
  const errors = [];
  let ocrCalls = 0;
  const commit = (card) => {
    if (!mounted()) return false;
    if (!useScanQuotaStore.getState().incrementScan()) return false;
    committed.push(card.id);
    return true;
  };
  const io = {
    callRecognitionApi: async () => { throw new Error('web-only'); },
    recognizeFromImage: (uri) => recognizeCardFromImage(uri, { base64, signal }),
    ocrText: async () => { ocrCalls += 1; return ocrText; },
    recognizeFromOcr: async () => ({ success: false, error: 'no match' }),
    searchCards: async () => [],
    mapApiCard: (c) => c,
    mapApiCandidates: () => undefined,
  };
  const ui = {
    setStatus() {}, setBusy() {}, setSearchError() {}, setSearchResults() {}, setSuggestions() {},
    setRecognizedText() {}, setCandidateReason() {}, showLowConfidenceCandidates() {},
    setScanError: (m) => errors.push(m),
    onRecognized: (card, confidence) => { if (confidence >= 0.85) commit(card); },
    onVisionRecognized: (card) => commit(card),
  };
  return { io, ui, committed, errors, ocrCalls: () => ocrCalls };
}

for (const role of ['guest', 'free_user']) {
  await check(`${role}: a successful AI scan charges exactly once`, async () => {
    seedQuota(10, role);
    reset('success');
    const h = harness();
    await runNativeCameraScan(FILE_URI, h.io, h.ui);
    assert.deepEqual(h.committed, [API_CARD.id]);
    assert.equal(count(), 11);
  });
}

for (const [label, m, extra] of [
  ['provider failure (502)', 'provider-502', {}],
  ['network failure', 'network', {}],
  ['timeout', 'hang', {}],
  ['refused photo (no bytes)', 'success', { base64: null }],
]) {
  await check(`${label}: no charge, and the native OCR fallback is reached`, async () => {
    seedQuota(10);
    reset(m);
    const h = harness(extra);
    await runNativeCameraScan(FILE_URI, h.io, h.ui);
    assert.equal(count(), 10, 'quota must be untouched — and not decremented either');
    assert.deepEqual(h.committed, []);
    assert.equal(h.ocrCalls(), 1, 'expo-ocr-kit fallback (io.ocrText) must run');
    // A backend that never looked at the photo must not be blamed on the photo (DIC-1013).
    assert.deepEqual(h.errors, [label.startsWith('refused') ? PHOTO_NOT_UPLOADED_GUIDANCE : RECOGNITION_UNAVAILABLE_MESSAGE]);
    assert.notEqual(h.errors[0], NO_TEXT_GUIDANCE);
  });
}

await check('cancel mid-request: no charge, no OCR, nothing committed', async () => {
  seedQuota(10);
  reset('hang');
  const controller = new AbortController();
  const h = harness({ signal: controller.signal });
  const pending = runNativeCameraScan(FILE_URI, h.io, h.ui);
  await new Promise((r) => realSetTimeout(r, 1));
  controller.abort();
  await pending;
  assert.equal(count(), 10);
  assert.equal(h.ocrCalls(), 0);
  assert.deepEqual(h.committed, []);
});

await check('flow: abort during payload preparation → no upload, no OCR fallback, no charge', async () => {
  seedQuota(10);
  reset('success');
  const controller = new AbortController();
  const h = harness({ signal: controller.signal });
  const pending = runNativeCameraScan(FILE_URI, h.io, h.ui);
  controller.abort();
  await pending;
  assert.equal(captured.length, 0);
  assert.equal(h.ocrCalls(), 0);
  assert.equal(count(), 10);
  assert.deepEqual(h.committed, []);
});

await check('a success that lands after the screen unmounted is not committed or charged', async () => {
  seedQuota(10);
  reset('success');
  const h = harness({ mounted: () => false });
  await runNativeCameraScan(FILE_URI, h.io, h.ui);
  assert.equal(count(), 10);
  assert.deepEqual(h.committed, []);
});

await check('concurrent successes at 1 remaining: exactly one charged, count never exceeds 50 or goes down', async () => {
  seedQuota(MONTHLY_SCAN_LIMIT - 1);
  reset('success');
  const seen = [];
  const unsub = useScanQuotaStore.subscribe((s) => seen.push(s.scanCount));
  const a = harness();
  const b = harness();
  await Promise.all([runNativeCameraScan(FILE_URI, a.io, a.ui), runNativeCameraScan(FILE_URI, b.io, b.ui)]);
  unsub();
  assert.equal(count(), MONTHLY_SCAN_LIMIT);
  assert.equal(a.committed.length + b.committed.length, 1);
  assert.ok(seen.every((v, i) => i === 0 || v >= seen[i - 1]), `count went down: ${seen}`);
});

// ---------------------------------------------------------- web OCR + logs
process.stdout.write('\nNo web OCR on native; no image data in logs\n');

await check('tesseract.js and the web OCR module were never loaded on the native path', () => {
  assert.ok(!resolved.includes('tesseract.js'), 'tesseract.js was resolved on native');
  assert.ok(!resolved.some((u) => u.endsWith('/src/services/webOcr.ts')), 'webOcr.ts (Tesseract) was resolved on native');
  const stub = fs.readFileSync(path.join(ROOT, 'src/services/webOcr.native.ts'), 'utf8');
  assert.ok(!/tesseract/i.test(stub.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), 'webOcr.native.ts must not reference tesseract in code');
});

await check('nothing logged during any scan carries image data or a device path payload', () => {
  const all = logged.join('\n');
  assert.ok(!/data:image\//.test(all), 'a data:image URL was logged');
  assert.ok(!all.includes(JPEG_B64.slice(0, 40)), 'base64 image content was logged');
  assert.ok(!/[A-Za-z0-9+/]{200,}/.test(all), 'a long base64 run was logged');
});

process.stdout.write(`\nPASS — ${checks} checks\n`);
process.exit(0);
