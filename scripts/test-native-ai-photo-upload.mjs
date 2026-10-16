#!/usr/bin/env node
/**
 * Native AI photo upload — server contract, consent gate, and disclosure consistency
 * (owner authorisation 2026-10-14: "正式支援上傳照片給 AI 並同步隱私告知").
 *
 *   • api/recognize-card refuses URIs / bare strings / bad base64 / unsupported or
 *     mismatched types / oversized or too many images with 400 + a stable code BEFORE a
 *     provider is resolved — zero provider calls even with GEMINI_API_KEY set.
 *   • a valid photo reaches the (mocked) Gemini call with its own MIME and bytes.
 *   • a client abort (Request.signal — what the runtime fires when the scanner disconnects)
 *     is forwarded to the provider fetch; the server holds no quota, so nothing can charge.
 *   • the consent gate uploads nothing until the current disclosure is accepted.
 *   • the in-app disclosure, privacy policy (zh + en), support FAQ and Play docs all say
 *     the same thing: photo → our backend → Google Gemini; no promise about Google's
 *     retention/training; Play answers needing the owner are marked, not self-signed.
 *
 * All network is mocked; no real provider call.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let checks = 0;
async function check(label, fn) {
  await fn();
  checks += 1;
  console.log(`  ✓ ${label}`);
}

const { default: handler } = await import('../api/recognize-card.ts');
const policy = await import('../src/services/recognitionImagePolicy.ts');
const consent = await import('../src/services/photoUploadDisclosure.ts');
const database = JSON.parse(read('public/data/database.json'));

const JPEG_B64 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 7)]).toString('base64');
const PNG_B64 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60, 1)]).toString('base64');
const JPEG = `data:image/jpeg;base64,${JPEG_B64}`;
const REPLY = 'CHARACTER: ラプラス・ダークネス\nHP: NONE\nRARITY: SEC\nBLOOM_LEVEL: NONE\nCARD_NUMBER: hBP04-005\nTITLE: NONE';

const savedKey = process.env.GEMINI_API_KEY;
process.env.GEMINI_API_KEY = 'test-key-must-not-leak';

let providerCalls = [];
let providerMode = 'ok';
globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (href.includes('database.json')) return Response.json(database);
  if (href.includes('generativelanguage.googleapis.com')) {
    const call = { body: JSON.parse(init.body), signal: init.signal };
    providerCalls.push(call);
    if (providerMode === 'hang') {
      return new Promise((_r, reject) => {
        const done = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (init.signal?.aborted) return done();
        init.signal?.addEventListener('abort', done);
      });
    }
    if (providerMode === 'reject') return new Response('upstream secret body', { status: 400 });
    return Response.json({ candidates: [{ content: { parts: [{ text: REPLY }] } }] });
  }
  throw new Error(`unexpected fetch ${href}`);
};

const logged = [];
for (const level of ['log', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...a) => { const line = a.map(String).join(' '); if (line.startsWith('  ✓') || line.startsWith('\n')) original(...a); else logged.push(line); };
}

const post = (body, signal) => handler(new Request('https://holohunter.dicoge.com/api/recognize-card', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
  signal,
}));

console.log('\nServer: image contract runs before any provider call');

const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(policy.MAX_RECOGNITION_IMAGE_BYTES + 10, 1)]).toString('base64');
for (const [label, body, code] of [
  ['file:// uri', { image: 'file:///data/user/0/com.dicoge.holohunter/cache/Camera/a.jpg' }, 'IMAGE_URI_NOT_ALLOWED'],
  ['content:// uri', { image: 'content://media/external/images/media/1' }, 'IMAGE_URI_NOT_ALLOWED'],
  ['raw base64 without a data: head (no longer wrapped as jpeg)', { image: JPEG_B64 }, 'IMAGE_NOT_DATA_URL'],
  ['invalid base64 body', { image: 'data:image/jpeg;base64,@@@@not-base64@@@@' }, 'IMAGE_INVALID_BASE64'],
  ['unsupported MIME', { image: `data:image/heic;base64,${JPEG_B64}` }, 'IMAGE_UNSUPPORTED_TYPE'],
  ['declared type that does not match the bytes', { image: `data:image/png;base64,${JPEG_B64}` }, 'IMAGE_TYPE_MISMATCH'],
  ['oversized image', { image: `data:image/jpeg;base64,${big}` }, 'IMAGE_TOO_LARGE'],
  ['three images', { images: [JPEG, JPEG, JPEG] }, 'IMAGE_TOO_MANY'],
  ['no image', {}, 'IMAGE_MISSING'],
]) {
  await check(`${label} → 400 ${code}, zero provider calls`, async () => {
    providerCalls = [];
    const res = await post(body);
    const json = await res.json();
    assert.equal(res.status, 400);
    assert.equal(json.code, code);
    assert.equal(providerCalls.length, 0);
    assert.ok(!JSON.stringify(json).includes(JPEG_B64.slice(0, 32)), 'rejection echoes no image data');
  });
}

await check('malformed JSON → 400 INVALID_REQUEST_BODY, body not echoed', async () => {
  providerCalls = [];
  const res = await post(`{"image":"data:image/jpeg;base64,${JPEG_B64}`);
  const json = await res.json();
  assert.equal(res.status, 400);
  assert.equal(json.code, 'INVALID_REQUEST_BODY');
  assert.ok(!JSON.stringify(json).includes(JPEG_B64.slice(0, 32)));
  assert.equal(providerCalls.length, 0);
});

await check('the deploy probe PNG still passes the contract (probe answers 404, no vision call)', async () => {
  const { RECOGNITION_PROBE_BODY } = await import('./ci/verify-recognition-availability.mjs');
  providerCalls = [];
  const res = await post(RECOGNITION_PROBE_BODY);
  assert.equal(res.status, 404);
  assert.equal(providerCalls.length, 0);
});

console.log('\nServer: valid photo, provider rejection, client abort');

await check('a valid JPEG + PNG reach the mocked Gemini call with their own MIME and bytes', async () => {
  providerCalls = []; providerMode = 'ok';
  const res = await post({ images: [JPEG, `data:image/png;base64,${PNG_B64}`] });
  assert.equal(res.status, 200);
  const parts = providerCalls[0].body.contents[0].parts.filter((p) => p.inline_data);
  assert.deepEqual(parts.map((p) => p.inline_data.mime_type), ['image/jpeg', 'image/png']);
  assert.deepEqual(parts.map((p) => p.inline_data.data), [JPEG_B64, PNG_B64]);
});

await check('provider rejection → 502, upstream body and key never surface', async () => {
  providerCalls = []; providerMode = 'reject';
  const res = await post({ image: JPEG });
  const text = await res.text();
  assert.equal(res.status, 502);
  assert.ok(!text.includes('upstream secret body') && !text.includes('test-key-must-not-leak'));
});

await check('client abort mid-call: Request.signal is forwarded, provider fetch is aborted, 499 CLIENT_ABORTED', async () => {
  providerCalls = []; providerMode = 'hang';
  const controller = new AbortController();
  const pending = post({ image: JPEG }, controller.signal);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(providerCalls.length, 1, 'provider was called');
  assert.equal(providerCalls[0].signal.aborted, false);
  controller.abort();
  const res = await pending;
  assert.equal(res.status, 499);
  assert.equal((await res.json()).code, 'CLIENT_ABORTED');
  assert.equal(providerCalls[0].signal.aborted, true, 'the client abort must reach the provider fetch');
});

await check('already-aborted request: no provider call at all', async () => {
  providerCalls = []; providerMode = 'ok';
  const controller = new AbortController();
  controller.abort();
  const res = await post({ image: JPEG }, controller.signal);
  assert.equal(res.status, 499);
  assert.equal(providerCalls.length, 0);
});

await check('the handler holds no scan quota (charging is app-side at commit only)', () => {
  const src = read('api/recognize-card.ts');
  assert.ok(!/scanQuota|incrementScan|scanCount/.test(src), 'server-side quota appeared — re-derive the abort/charge contract');
});

await check('server logs carry no image data, key or upstream body', () => {
  const all = logged.join('\n');
  assert.ok(!all.includes(JPEG_B64.slice(0, 32)) && !/data:image\//.test(all));
  assert.ok(!all.includes('test-key-must-not-leak') && !all.includes('upstream secret body'));
});

console.log('\nConsent gate (prominent disclosure before first upload)');

await check('no consent → prompt; decline uploads nothing and records nothing', async () => {
  let recorded = null; let prompts = 0;
  const ok = await consent.ensurePhotoUploadConsent({
    acceptedVersion: () => null, recordAcceptance: (v) => { recorded = v; },
    prompt: async () => { prompts += 1; return false; },
  });
  assert.equal(ok, false); assert.equal(recorded, null); assert.equal(prompts, 1);
});

await check('accept records the current version; concurrent callers share one prompt', async () => {
  let recorded = null; let prompts = 0; let release;
  const deps = {
    acceptedVersion: () => recorded, recordAcceptance: (v) => { recorded = v; },
    prompt: () => { prompts += 1; return new Promise((r) => { release = r; }); },
  };
  const a = consent.ensurePhotoUploadConsent(deps);
  const b = consent.ensurePhotoUploadConsent(deps);
  release(true);
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.equal(prompts, 1);
  assert.equal(recorded, consent.PHOTO_UPLOAD_DISCLOSURE_VERSION);
  assert.equal(await consent.ensurePhotoUploadConsent({ ...deps, prompt: async () => assert.fail('re-prompted') }), true);
});

await check('an older accepted version re-asks; a throwing prompt counts as decline', async () => {
  assert.equal(consent.hasPhotoUploadConsent('2020-01-01'), false);
  assert.equal(await consent.ensurePhotoUploadConsent({
    acceptedVersion: () => '2020-01-01', recordAcceptance: () => assert.fail('recorded'),
    prompt: async () => { throw new Error('dialog failed'); },
  }), false);
});

await check('ScanScreen wires the gate before every upload path (camera, gallery, auto-scan)', () => {
  const scan = read('src/screens/ScanScreen.tsx');
  const handleScan = scan.slice(scan.indexOf('const handleScan = async'), scan.indexOf('captureAndRecognize();', scan.indexOf('const handleScan = async')));
  assert.ok(handleScan.includes('await requestPhotoUploadConsent()'), 'manual scan must ask first');
  const gallery = scan.slice(scan.indexOf('const pickFromGallery'), scan.indexOf('launchImageLibraryAsync'));
  assert.ok(gallery.includes('await requestPhotoUploadConsent()'), 'gallery must ask before picking');
  const captureStart = scan.indexOf('const captureAndRecognize');
  const capture = scan.slice(captureStart, scan.indexOf('takePictureAsync', captureStart));
  assert.ok(capture.includes('if (!hasUploadConsent()) return;'), 'auto-scan / capture must not upload without consent');
  // v41 native automatic capture: its silent on-device probes (and so any trigger) also
  // wait for the accepted disclosure.
  const probeStart = scan.indexOf('const probeAllowed = ');
  assert.ok(probeStart > 0, 'native auto-capture probe gate not found');
  assert.ok(scan.slice(probeStart, scan.indexOf(';', probeStart)).includes('hasUploadConsent()'), 'native auto probes must wait for consent');
  assert.ok(/takePictureAsync\(\{\s*quality: 0\.7,\s*base64: true,/.test(scan), 'native capture must request bytes');
  // Behaviour (blur / close / late result through the real navigator) is proven by
  // scripts/test-scan-cancel-lifecycle.mjs; this only pins that commitCard keeps the guard.
  assert.ok(/if \(!mountedRef\.current \|\| !lifecycle\.isFocused\(\)\) return false;/.test(scan),
    'commitCard must refuse while the screen is unmounted or not focused');
});

console.log('\nDisclosure copy is the same story everywhere');

const zh = read('src/i18n/locales/zh.ts');
const ja = read('src/i18n/locales/ja.ts');
const privacy = read('public/privacy.html');
const support = read('public/support.html');
const dataSafety = read('docs/play/data-safety.md');

await check('in-app disclosure (zh + ja) names our server and Google Gemini, and makes no Google retention promise', () => {
  const zhBody = zh.match(/scan_ai_disclosure_body: '([^']+)'/)[1];
  const jaBody = ja.match(/scan_ai_disclosure_body: '([^']+)'/)[1];
  assert.ok(zhBody.includes('HoloHunter 的伺服器') && zhBody.includes('Google Gemini'));
  assert.ok(jaBody.includes('HoloHunter のサーバー') && jaBody.includes('Google Gemini'));
  assert.ok(zhBody.includes('無法代 Google 承諾') && jaBody.includes('約束できません'));
  for (const body of [zhBody, jaBody]) assert.ok(!/不會用於訓練|学習に使用しません|not be used (to|for) train/.test(body));
});

await check('privacy policy (zh + en) states the mobile upload and drops the on-device claim', () => {
  for (const claim of ['手機 App（iOS / Android）與網頁版皆會上傳影像', 'The image is uploaded on mobile (iOS / Android) as well as on the web']) {
    assert.ok(privacy.includes(claim), `missing: ${claim}`);
  }
  for (const stale of ['卡牌影像都不會離開您的裝置', 'the card image never leaves your device', '手機 App 的辨識在裝置端完成', 'On the mobile App recognition runs on-device']) {
    assert.ok(!privacy.includes(stale), `stale claim still present: ${stale}`);
  }
  assert.ok(privacy.includes('Google Gemini') && privacy.includes('/api/recognize-card'));
  assert.ok(privacy.includes('無法代 Google 承諾') && privacy.includes('cannot make promises on Google'));
  assert.ok(privacy.includes('2026 年 10 月 14 日') && privacy.includes('October 14, 2026'), 'policy date must move with the change');
  assert.ok(!/Google 不會(保存|用於訓練)|Google (will not|does not) (retain|store|train)/.test(privacy), 'no Google retention/training promise');
});

await check('support FAQ (zh + en) matches', () => {
  assert.ok(!support.includes('卡牌影像<strong>不會離開您的裝置</strong>') && !support.includes('the card image <strong>never leaves your device</strong>'));
  assert.ok(support.includes('Google Gemini'));
});

await check('Play Data safety draft declares Photos collected and leaves owner-only answers unsigned', () => {
  assert.ok(/\| Collected \| \*\*Yes\*\*/.test(dataSafety.slice(dataSafety.indexOf('### Photos and videos → Photos'))));
  assert.ok(dataSafety.includes('OWNER DECISION'), 'shared / ephemeral answers must be marked for the owner');
  assert.ok(!dataSafety.includes('Photos are therefore **not collected**'));
  for (const doc of ['docs/play/app-content.md', 'docs/play/store-listing.md', 'docs/play/README.md', 'docs/play/permissions.md', 'docs/play/submit-checklist.md']) {
    const text = read(doc);
    assert.ok(!/Photos = not collected|recognition is on-device\)|辨識在你的裝置上完成/.test(text), `${doc} still claims on-device recognition`);
  }
});

if (savedKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedKey;
console.log(`\n✅ native-ai-photo-upload: ${checks} checks passed`);
