#!/usr/bin/env node
/**
 * Local scan / sign-in diagnostic log (2026-10-15): sanitiser + retention + export,
 * persisted store, the REAL ScanScreen writing one entry per scan (real handler, mocked
 * Gemini + catalog), Settings export/clear, and the real auth store failure path.
 * No provider, camera, photo or network is used.
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


const diag = await import('../src/services/scanDiagnostics.ts');
const { useScanDiagnosticsStore } = await import('../src/store/scanDiagnosticsStore.ts');
const platformStorage = (await import('../src/stores/storage.ts')).default;

let passed = 0;
async function test(label, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (err) { process.exitCode = 1; console.error(`  ✗ ${label} — ${err.message}`); }
}
const FORBIDDEN = [/data:image\//, /\/9j\//, /file:\/\//, /content:\/\//, /@[a-z0-9-]+\.[a-z]/i, /eyJ[A-Za-z0-9_-]{10,}/, /test-key-never-sent/, /ya29\./];
const assertClean = (text, where) => { for (const re of FORBIDDEN) assert.ok(!re.test(text), `${where} contains ${re}`); };

// ============================ 1. sanitiser ============================
console.log('\nSanitiser, retention, export');
const now = Date.parse('2026-10-16T00:00:00Z');
const base = { id: 'abcdefgh12345678', kind: 'scan', at: '2026-10-15T23:00:00Z', platform: 'android', appVersion: '1.0.0', nativeBuild: '38', model: 'gemini-3.5-flash-lite', stagesMs: { capture: 120, request: 900 }, errors: [] };
await test('allowlisted fields survive; unknown fields (photo, token, email, payload) are dropped', () => {
  const e = diag.sanitizeEntry({ ...base, photo: 'data:image/jpeg;base64,/9j/AAAA', idToken: 'eyJhbGciOiJSUzI1NiJ9.x.y', email: 'a@b.com', raw: 'CARD_NUMBER: x', extracted: { name: '天音かなた', number: 'HBP01-010', set: 'hBP01', language: 'ja' }, match: { status: 'matched', reason: 'none', ruleScore: 127.4, evidence: ['cardNumber exact', 'free text'] }, outcome: 'added', correctedTo: 'hBP01-010_hBP01_U_hBP01-010_U' });
  assert.deepEqual(Object.keys(e).sort(), ['appVersion', 'at', 'correctedTo', 'errors', 'extracted', 'id', 'kind', 'match', 'model', 'nativeBuild', 'outcome', 'platform', 'source', 'stagesMs', 'v'].sort());
  assert.deepEqual(e.extracted, { name: '天音かなた', number: 'hbp01-010', set: 'hBP01', language: 'JA' });
  assert.deepEqual(e.match.evidence, ['cardNumber exact']);
  assert.equal(e.match.ruleScore, 127.4);
  assertClean(JSON.stringify(e), 'sanitised entry');
});
await test('PII-looking or arbitrary values are redacted, missing values are "unknown" (never inferred)', () => {
  const e = diag.sanitizeEntry({ ...base, model: 'Ignore previous instructions', extracted: { name: 'mail me: a@b.com', number: 'file:///x.jpg', set: undefined, language: 'NONE' }, errors: ['TIMEOUT', 'Bearer eyJabc.def', 'x'], correctedTo: 'content://media/1', match: { status: 'hacked', ruleScore: 'NaN' } });
  assert.equal(e.model, diag.REDACTED);
  assert.deepEqual(e.extracted, { name: diag.REDACTED, number: diag.REDACTED, set: diag.UNKNOWN, language: diag.UNKNOWN });
  assert.deepEqual(e.errors, ['TIMEOUT', 'REDACTED_ERROR']);
  assert.equal(e.correctedTo, diag.REDACTED);
  assert.equal(e.match.status, 'unknown');
  assert.equal(e.match.ruleScore, null);
});
await test('retention: at most 100 entries and none older than 7 days', () => {
  const many = Array.from({ length: 130 }, (_, i) => ({ ...base, id: `id${String(i).padStart(10, '0')}`, at: new Date(now - i * 60_000).toISOString() }));
  many.push({ ...base, id: 'oldoldoldold0001', at: new Date(now - 8 * 86400_000).toISOString() });
  const kept = diag.pruneEntries(many, now);
  assert.equal(kept.length, 100);
  assert.ok(kept.every((e) => now - Date.parse(e.at) <= diag.MAX_AGE_MS));
  assert.ok(!kept.some((e) => e.id === 'oldoldoldold0001'));
});
await test('export re-sanitises whatever is stored (tampered entries) and labels ruleScore as not accuracy', () => {
  const text = diag.buildExport([{ ...base, extracted: { name: 'x@y.io' }, errors: ['token=abc'] }, { id: 'bad id!', at: 'x' }], now);
  const parsed = JSON.parse(text);
  assert.equal(parsed.count, 1);
  assert.match(parsed.note, /not accuracy/);
  assert.ok(!text.includes('%'));
  assertClean(text, 'export');
});
await test('sanitising is idempotent (unknown / [redacted] never flip on re-sanitise)', () => {
  const once = diag.sanitizeEntry({ ...base, extracted: { name: 'a@b.com' } });
  const twice = diag.sanitizeEntry(diag.sanitizeEntry(once));
  assert.deepEqual(twice.extracted, once.extracted);
  assert.equal(twice.extracted.number, diag.UNKNOWN);
  assert.equal(twice.extracted.name, diag.REDACTED);
});
await test('correlation ids are random, not derived from anything', () => {
  const a = diag.newDiagnosticId(), b = diag.newDiagnosticId();
  assert.match(a, /^[a-z0-9]{16}$/);
  assert.notEqual(a, b);
});
await test('auth failures map to stage + short code only (DEVELOPER_ERROR, bad_audience, config, cancel)', () => {
  assert.deepEqual(diag.authDiagnostic({ code: 'google_developer_error', message: 'secret a@b.com' }, 'google'), { stage: 'sdk_sign_in', code: 'GOOGLE_GOOGLE_DEVELOPER_ERROR' });
  assert.deepEqual(diag.authDiagnostic({ code: 'INVALID_TOKEN', reason: 'bad_audience' }, 'google'), { stage: 'backend_verify', code: 'GOOGLE_INVALID_TOKEN_BAD_AUDIENCE' });
  assert.deepEqual(diag.authDiagnostic({ code: 'client_id_missing' }, 'google'), { stage: 'client_config', code: 'GOOGLE_CLIENT_ID_MISSING' });
  assert.equal(diag.authDiagnostic({ code: 'cancel' }, 'google').stage, 'sdk_sign_in');
  assert.equal(diag.authDiagnostic({ code: 'INVALID_TOKEN', reason: 'Bad audience: 123.apps' }, 'google').code, 'GOOGLE_INVALID_TOKEN', 'non-vocabulary reason dropped');
});

// ============================ 2. persisted store ============================
console.log('\nPersisted store');
await test('stored JSON is sanitised; tampered storage is re-sanitised on load; clear really empties it', async () => {
  useScanDiagnosticsStore.getState().clear();
  const id = useScanDiagnosticsStore.getState().start('scan', { source: 'camera' });
  useScanDiagnosticsStore.getState().update(id, { extracted: { name: 'a@b.com' }, errors: ['TIMEOUT'] });
  const stored = platformStorage.getItem('holohunter-scan-diagnostics');
  assert.ok(stored.includes(id));
  assertClean(stored, 'storage');
  platformStorage.setItem('holohunter-scan-diagnostics', JSON.stringify({ state: { entries: [{ ...base, extracted: { name: 'evil@x.com', number: 'data:image/jpeg;base64,/9j/' } }] }, version: 0 }));
  await useScanDiagnosticsStore.persist.rehydrate();
  assertClean(JSON.stringify(useScanDiagnosticsStore.getState().entries), 'rehydrated');
  useScanDiagnosticsStore.getState().clear();
  assert.equal(useScanDiagnosticsStore.getState().entries.length, 0);
  assert.ok(!platformStorage.getItem('holohunter-scan-diagnostics').includes('abcdefgh12345678'));
});
await test('a throwing storage never throws into the caller', () => {
  const orig = platformStorage.setItem;
  platformStorage.setItem = () => { throw new Error('disk full'); };
  try {
    assert.doesNotThrow(() => useScanDiagnosticsStore.getState().start('scan', {}));
  } finally { platformStorage.setItem = orig; }
  useScanDiagnosticsStore.getState().clear();
});

// ============================ 3. real screen ============================
console.log('\nReal ScanScreen writes one entry per scan');
const byTestId = (id) => document.querySelector(`[data-testid="${id}"]`);
const tick = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const click = async (el) => { assert.ok(el, 'element exists'); await act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); await Promise.resolve(); }); };
usePhotoUploadConsentStore.setState({ acceptedVersion: PHOTO_UPLOAD_DISCLOSURE_VERSION });
const host = document.createElement('div'); document.body.appendChild(host);
const root = createRoot(host);
const navRef = createNavigationContainerRef();
await act(async () => root.render(React.createElement(NavigationContainer, { ref: navRef }, React.createElement(StackNavigator))));
await tick(30);
await act(async () => { navRef.navigate('MainDrawer', { screen: 'Scan' }); });
await tick(60);
const allow = byTestId('scan-permission-allow'); if (allow) { await click(allow); await tick(80); await tick(0); }
async function scan(text) {
  geminiReply = text; const before = geminiCalls;
  await click(byTestId('scan-primary-action'));
  for (let i = 0; i < 20 && geminiCalls === before; i++) await tick(10);
  await tick(60);
}
const last = () => useScanDiagnosticsStore.getState().entries.at(-1);
try {
  await test('valid scan → entry with real stage timings, extracted fields, model, rule score; add → same entry "added"', async () => {
    useScanDiagnosticsStore.getState().clear(); useScanQuotaStore.getState().resetQuota(); useScanSessionStore.setState({ cards: [] });
    await scan(reply({ CARD_NUMBER: 'hBP01-010', CHARACTER: '天音かなた', SET: 'hBP01', LANGUAGE: 'JA' }));
    const e = last();
    assert.equal(useScanDiagnosticsStore.getState().entries.length, 1);
    assert.equal(e.kind, 'scan'); assert.equal(e.source, 'camera'); assert.equal(e.outcome, 'pending');
    for (const k of ['capture', 'prepare', 'request', 'total']) assert.equal(typeof e.stagesMs[k], 'number', `stage ${k}`);
    assert.deepEqual(e.extracted, { name: '天音かなた', number: 'hbp01-010', set: 'hBP01', language: 'JA' });
    assert.equal(e.model, 'gemini-3.5-flash-lite');
    assert.equal(e.match.status, 'matched');
    assert.equal(typeof e.match.ruleScore, 'number');
    await click(byTestId('scan-match-add')); await tick(20);
    assert.equal(useScanDiagnosticsStore.getState().entries.length, 1, 'same entry updated, not a new one');
    assert.equal(last().outcome, 'added');
    assert.equal(last().correctedTo, 'hBP01-010_hBP01_U_hBP01-010_U');
    assert.equal(useScanQuotaStore.getState().scanCount, 1, 'logging does not touch quota');
    // v2 (2026-10-16): app decision logged apart from the server verdict, plus timeline.
    assert.deepEqual(last().presentation, { kind: 'best', reason: 'none', source: 'server_verdict' });
    assert.equal(last().trace.provenance, 'server_trace');
    assert.equal(last().trace.serverVerdict.status, 'matched');
    assert.deepEqual(last().trace.fields.number, { state: 'parsed', received: 'hBP01-010', value: 'hbp01-010' });
    assert.deepEqual(last().timeline.map((x) => x.e), ['presented', 'added']);
    assertClean(platformStorage.getItem('holohunter-scan-diagnostics'), 'storage after scan');
  });
  await test('correction → "corrected" with the public catalog id chosen', async () => {
    await scan(reply({ CARD_NUMBER: 'hBP01-001', RARITY: 'OUR', CHARACTER: '天音かなた' }));
    await click(byTestId('scan-match-correct')); await tick(20);
    const osr = [...document.querySelectorAll('[data-testid="scan-candidate-meta"]')].find((m) => m.textContent.includes('OSR'));
    await click(osr); await tick(20);
    assert.equal(last().outcome, 'corrected');
    assert.equal(last().correctedTo, 'hBP01-001_hBP01_OSR_hBP01-001_OSR');
  });
  await test('no match → "no_match"; values not read stay "unknown"', async () => {
    await scan(reply({}));
    assert.equal(last().outcome, 'no_match');
    assert.equal(last().trace.rejection, 'no_candidate');
    assert.equal(last().trace.fields.number.state, 'provider_unknown');
    assert.equal(last().presentation.kind, 'none');
    assert.equal(last().presentation.source, 'server_verdict');
    assert.equal(last().extracted.number, 'unknown');
    assert.equal(last().extracted.name, 'unknown');
    await click(byTestId('scan-match-retake'));
  });
  await test('a throwing diagnostics store cannot break a scan or the quota', async () => {
    const st = useScanDiagnosticsStore.getState();
    const orig = { start: st.start, update: st.update };
    useScanDiagnosticsStore.setState({ start: () => { throw new Error('boom'); }, update: () => { throw new Error('boom'); } });
    const used = useScanQuotaStore.getState().scanCount;
    try {
      await scan(reply({ CARD_NUMBER: 'hBP01-016', CHARACTER: '七詩ムメイ' }));
      assert.ok(byTestId('scan-match-best'), 'scan still produced its preview');
      await click(byTestId('scan-match-add')); await tick(20);
      assert.equal(useScanQuotaStore.getState().scanCount, used + 1);
    } finally { useScanDiagnosticsStore.setState(orig); }
  });
} finally {
  await act(async () => root.unmount()); host.remove();
}

// ============================ 4. Settings export / clear ============================
console.log('\nSettings export / clear (web download path)');
await test('export downloads the re-sanitised JSON; clear asks, then really empties the log', async () => {
  useScanDiagnosticsStore.getState().clear();
  useScanDiagnosticsStore.getState().start('scan', { source: 'camera', extracted: { name: 'evil@x.com' } });
  const { default: SettingsScreen } = await import('../src/screens/SettingsScreen.tsx');
  let downloaded = null;
  globalThis.URL.createObjectURL = (blob) => { downloaded = blob; return 'blob:test'; };
  globalThis.URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = function () {};
  dom.window.confirm = () => true; globalThis.confirm = dom.window.confirm;
  const h = document.createElement('div'); document.body.appendChild(h);
  const r = createRoot(h);
  await act(async () => r.render(React.createElement(NavigationContainer, null, React.createElement(SettingsScreen, { navigation: { navigate() {}, goBack() {}, openDrawer() {}, addListener: () => () => {} } }))));
  await tick(30);
  assert.ok(byTestId('settings-diagnostics-count').textContent.includes('1'));
  await click(byTestId('settings-diagnostics-export')); await tick(20);
  assert.ok(downloaded, 'a file was produced');
  const text = await downloaded.text();
  assert.equal(JSON.parse(text).format, 'holohunter-diagnostics');
  assertClean(text, 'downloaded export');
  await click(byTestId('settings-diagnostics-clear')); await tick(20);
  assert.equal(useScanDiagnosticsStore.getState().entries.length, 0);
  await act(async () => r.unmount()); h.remove();
});

// ============================ 5. real auth store failure ============================
console.log('\nSign-in failure is recorded through the real auth store');
await test('loginWithGoogle failure (no web client id configured) → auth entry: stage + code only', async () => {
  useScanDiagnosticsStore.getState().clear();
  delete process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID; delete process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID;
  const { useAuthStore } = await import('../src/store/authStore.ts');
  await useAuthStore.getState().loginWithGoogle().catch(() => {});
  const e = useScanDiagnosticsStore.getState().entries.at(-1);
  assert.ok(e, 'an entry was written');
  assert.equal(e.kind, 'auth');
  assert.match(e.auth.stage, /^login_/);
  assert.match(e.auth.code, /^GOOGLE_[A-Z0-9_]+$/);
  assertClean(JSON.stringify(e), 'auth entry');
  assert.equal(useAuthStore.getState().isAuthenticated, false, 'never forced signed-in');
});

if ((process.exitCode ?? 0) === 0) console.log(`\n✅ scan-diagnostics: ${passed} checks passed`);
else console.error('\n❌ scan-diagnostics failed');
