#!/usr/bin/env node
/**
 * v39 user report 2026-10-16, offline (no provider, no network, no photo):
 *
 *  1. Two real v39 logs ended as number_name_conflict. The user corrected both cards:
 *     風真いろは read as hBP05-081 is hBP01-051 (footer SR), 宝鐘マリン read as hBP01-014 is
 *     hEB01-014. The REAL handler + ranking + catalog run on a mocked reply holding only
 *     the fields the logs recorded (scripts/fixtures/v39-user-logs). The supported
 *     correction names the card, never its printing: identity only, no price.
 *  2. Negatives: no corroboration, a tie between near numbers, truncated / extra-digit
 *     numbers, an agreeing exact number — none of them is turned into a correction.
 *  3. Service failures: the handler's bounded provider category (timeout / busy / error),
 *     the client's classification, and the flows never showing a no-match for them.
 *  4. The readable diagnostics summary on the user's actual 7-entry export.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

const DB = JSON.parse(fs.readFileSync(new URL('../public/data/database.json', import.meta.url), 'utf8'));
const handler = (await import('../api/recognize-card.ts')).default;
const { rankCandidates } = await import('../api/recognize-card.ts');
const { recognizeCardFromImage, candidateEvidence } = await import('../src/services/cardRecognition.ts');
const { runNativeCameraScan, runWebCameraScan } = await import('../src/services/scanRecognitionFlow.ts');
const { presentMatch, matchFromWire } = await import('../src/services/scanPresentation.ts');
const { classifyHttpFailure } = await import('../src/services/recognitionOutcome.ts');
const diag = await import('../src/services/scanDiagnostics.ts');
const logFixture = (n) => JSON.parse(fs.readFileSync(new URL(`./fixtures/v39-user-logs/${n}.json`, import.meta.url), 'utf8'));

let passed = 0;
async function test(label, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (err) { process.exitCode = 1; console.error(`  ✗ ${label} — ${err.message}`); }
}

// ---- offline network: catalog + mocked provider; the app's /api call hits the real handler
process.env.GEMINI_API_KEY = 'offline-mock-key';
let provider = { kind: 'reply', text: '' };
let apiOverride = null;
const realTimeout = AbortSignal.timeout;
globalThis.fetch = async (url, init = {}) => {
  const h = String(url);
  if (h.endsWith('/data/database.json')) return Response.json(DB);
  if (h.includes('generativelanguage')) {
    if (provider.kind === 'status') return new Response('upstream detail must never leak', { status: provider.status });
    if (provider.kind === 'throw') throw new TypeError('fetch failed: secret upstream detail');
    if (provider.kind === 'nonjson') return new Response('<html>oops</html>', { status: 200 });
    if (provider.kind === 'hang') {
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted'))));
    }
    return Response.json({ candidates: [{ content: { parts: [{ text: provider.text }] } }] });
  }
  if (h.includes('/api/recognize-card')) {
    if (apiOverride) return apiOverride();
    const res = await handler(new Request('https://holohunter.dicoge.com/api/recognize-card', { method: 'POST', body: init.body, headers: { 'Content-Type': 'application/json' } }));
    const t = await res.text();
    return { ok: res.ok, status: res.status, json: async () => JSON.parse(t) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
// A JPEG big enough for the legibility floor (SOF0 640×800).
const JPEG = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0x03, 0x20, 0x02, 0x80]), Buffer.alloc(2000, 7)]).toString('base64')}`;
const replyOf = (fields) => Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n');
async function callHandler(text) {
  provider = { kind: 'reply', text };
  const res = await handler(new Request('https://x/api/recognize-card', { method: 'POST', body: JSON.stringify({ images: [JPEG] }) }));
  return { status: res.status, body: await res.json() };
}
const mapCands = (raw) => (Array.isArray(raw) && raw.length ? raw.map((c) => ({ card: { ...c }, confidence: c.confidence ?? 0, evidence: candidateEvidence(c.reason) })) : undefined);
const printingsOf = (num) => Object.values(DB.cards).filter((c) => c.cardNumber === num);

console.log('#1 the two real v39 logs, replayed through the real handler (logged fields only)');
for (const [name, expected, firstRarity] of [['iroha-4866fa1a60b22ec0', 'hBP01-051', 'SR'], ['marine-abcc4aea241e5f3b', 'hEB01-014', 'SR']]) {
  const fx = logFixture(name);
  await test(`${fx.received.CHARACTER} read as ${fx.received.CARD_NUMBER}: before = number_name_conflict (logged), after = identity ${expected}, printing unresolved`, async () => {
    assert.equal(fx.loggedVerdict.reason, 'number_name_conflict');
    const { status, body } = await callHandler(replyOf(fx.received));
    assert.equal(status, 200);
    assert.equal(body.match.status, 'identity_only');
    assert.equal(body.match.printingResolved, false, 'the corrected number never resolves a printing');
    assert.equal(body.match.reason, 'number_name_conflict', 'the conflict stays visible');
    assert.equal(body.card.cardNumber, expected, `user-corrected identity ${fx.userGroundTruth.cardNumber}`);
    assert.ok(body.match.alternatives.every((c) => c.cardNumber === expected), 'only printings of the corrected card');
    assert.equal(body.match.alternatives.length, printingsOf(expected).length, 'every printing of it is offered');
    assert.equal(body.match.alternatives[0].rarity, firstRarity, 'the rarity read orders, never decides');
    assert.ok(!body.match.evidence.includes('cardNumber exact'), 'a corrected number is never called exact');
    assert.ok(body.match.evidence.some((e) => e.startsWith('cardNumber fuzzy')) && body.match.evidence.includes('character exact/contains'));
    // the read number really belongs to another card (catalog = official)
    assert.ok(printingsOf(fx.received.CARD_NUMBER).every((c) => c.name === fx.catalogForReceivedNumber.name));
  });
  await test(`${fx.received.CHARACTER}: the app shows an identity WITHOUT price, flagged as corrected; each printing keeps its own price`, async () => {
    const { body } = await callHandler(replyOf(fx.received));
    const p = presentMatch({ match: matchFromWire(body.match, mapCands), card: { ...body.card }, candidates: mapCands(body.candidates) });
    assert.equal(p.kind, 'identity');
    assert.equal(p.numberCorrected, true);
    assert.equal(p.card.sellPrice, null);
    assert.deepEqual(p.card.prices, []);
    assert.equal(p.card.buyPrice, null);
    for (const alt of p.printings) {
      const own = DB.cards[alt.card.id];
      assert.ok(own, `printing ${alt.card.id} is a catalog row`);
      assert.equal(alt.card.sellPrice, own.sellPrice ?? null, `${alt.card.id} carries its own price, no sibling's`);
    }
    assert.equal(new Set(p.printings.map((x) => x.card.id)).size, p.printings.length, 'no duplicate printing');
  });
}

console.log('#2 negatives — nothing is corrected without support, on a tie, or on a bad token');
await test('conflict with no third reading (no rarity / HP / type) stays no_match', async () => {
  const { status, body } = await callHandler(replyOf({ CHARACTER: '宝鐘マリン', CARD_NUMBER: 'hBP01-014', TITLE: 'NONE' }));
  assert.equal(status, 404);
  assert.equal(body.match.status, 'no_match');
  assert.equal(body.match.reason, 'number_name_conflict');
  assert.deepEqual(body.candidates, []);
  assert.equal(body.match.alternatives[0].cardNumber, 'hBP01-014', 'the read number is still offered first as a correction');
});
await test('tie: ジジ・ムリン read as hBP01-082 SR has three near numbers with SR → no_match, nothing guessed', async () => {
  const r = rankCandidates(DB.cards, { characterName: 'ジジ・ムリン', cardNumberRaw: 'hBP01-082', rarity: 'SR' });
  assert.equal(r.match.status, 'no_match');
  assert.equal(r.match.reason, 'number_name_conflict');
  assert.equal(r.match.best, null);
});
for (const bad of ['hBP05-0810', 'hBP05-081SR', 'xhBP05-081', 'hBP05-08']) {
  await test(`invalid whole token "${bad}" with 風真いろは/SR is not a card number → no correction, no identity`, async () => {
    const { body } = await callHandler(replyOf({ CHARACTER: '風真いろは', CARD_NUMBER: bad, RARITY: 'SR' }));
    assert.equal(body.match.status, 'no_match');
    assert.equal(body.match.reason, 'no_card_number');
    assert.equal(body.card, undefined);
  });
}
await test('exact number agreeing with the name is unchanged: matched, printing resolved', async () => {
  const { body } = await callHandler(replyOf({ CHARACTER: '天音かなた', CARD_NUMBER: 'hBP01-010' }));
  assert.equal(body.match.status, 'matched');
  assert.equal(body.card.id, 'hBP01-010_hBP01_U_hBP01-010_U');
  assert.equal(body.match.printingResolved, true);
});
await test('read number not in the catalog stays number_not_in_database (no correction there)', async () => {
  const { body } = await callHandler(replyOf({ CHARACTER: '風真いろは', CARD_NUMBER: 'hBP11-051', RARITY: 'SR' }));
  assert.equal(body.match.reason, 'number_not_in_database');
  assert.equal(body.card, undefined);
});

console.log('#3 service failures: bounded server category, client classification, never a no-match');
const providerCases = [
  ['upstream 429', { kind: 'status', status: 429 }, 'PROVIDER_BUSY'],
  ['upstream 503', { kind: 'status', status: 503 }, 'PROVIDER_BUSY'],
  ['upstream 500', { kind: 'status', status: 500 }, 'PROVIDER_ERROR'],
  ['transport failure', { kind: 'throw' }, 'PROVIDER_ERROR'],
  ['non-JSON 200 reply', { kind: 'nonjson' }, 'PROVIDER_ERROR'],
];
for (const [label, p, code] of providerCases) {
  await test(`${label} → 502 code ${code}, no upstream text in the body`, async () => {
    provider = p;
    const res = await handler(new Request('https://x/api/recognize-card', { method: 'POST', body: JSON.stringify({ images: [JPEG] }) }));
    const text = await res.text();
    assert.equal(res.status, 502);
    assert.equal(JSON.parse(text).code, code);
    assert.ok(!/upstream detail|secret|oops|offline-mock-key/.test(text));
  });
}
await test('our own provider deadline → 502 PROVIDER_TIMEOUT (deadline shortened offline)', async () => {
  AbortSignal.timeout = () => realTimeout.call(AbortSignal, 20);
  provider = { kind: 'hang' };
  // AbortSignal.timeout's timer is unref'd; keep the loop alive while we wait on it.
  const keepAlive = setInterval(() => {}, 10);
  try {
    const res = await handler(new Request('https://x/api/recognize-card', { method: 'POST', body: JSON.stringify({ images: [JPEG] }) }));
    assert.equal(res.status, 502);
    assert.equal((await res.json()).code, 'PROVIDER_TIMEOUT');
  } finally { AbortSignal.timeout = realTimeout; clearInterval(keepAlive); }
});
await test('client classification: codes and statuses map to what is provable; a generic 502 stays unavailable', () => {
  assert.equal(classifyHttpFailure(502, { code: 'PROVIDER_TIMEOUT' }), 'timeout');
  assert.equal(classifyHttpFailure(502, { code: 'PROVIDER_BUSY' }), 'busy');
  assert.equal(classifyHttpFailure(502, { code: 'PROVIDER_ERROR' }), 'unavailable');
  assert.equal(classifyHttpFailure(502, { success: false, error: '辨識服務發生錯誤，請稍後再試' }), 'unavailable', 'old server generic 502');
  assert.equal(classifyHttpFailure(502, null), 'unavailable', 'non-JSON body');
  assert.equal(classifyHttpFailure(429, null), 'busy');
  assert.equal(classifyHttpFailure(503, null), 'busy');
  assert.equal(classifyHttpFailure(503, { code: 'RECOGNITION_UNAVAILABLE' }), 'unavailable', 'our unprovisioned 503 is not "busy"');
});
const apiCases = [
  ['generic 502 (the 12:16:32 log shape)', () => ({ ok: false, status: 502, json: async () => ({ success: false, error: '辨識服務發生錯誤，請稍後再試' }) }), 'unavailable', 502],
  ['502 PROVIDER_TIMEOUT', () => ({ ok: false, status: 502, json: async () => ({ success: false, code: 'PROVIDER_TIMEOUT' }) }), 'timeout', 502],
  ['429', () => ({ ok: false, status: 429, json: async () => { throw new SyntaxError('not json'); } }), 'busy', 429],
  ['fetch rejected (no response)', () => { throw new TypeError('Network request failed'); }, 'network', undefined],
];
for (const [label, respond, kind, httpStatus] of apiCases) {
  await test(`recognizeCardFromImage on ${label} → serviceUnavailable, failure "${kind}", no match verdict`, async () => {
    apiOverride = respond;
    try {
      const r = await recognizeCardFromImage(JPEG);
      assert.equal(r.serviceUnavailable, true);
      assert.equal(r.failure, kind);
      assert.equal(r.httpStatus, httpStatus);
      assert.equal(r.match, undefined);
      const d = diag.diagnosticsFromResult(r);
      assert.ok(d.errors.includes('RECOGNITION_UNAVAILABLE'));
      assert.ok(!d.errors.includes('NO_MATCH'));
    } finally { apiOverride = null; }
  });
}

function recorder() {
  const seen = { failure: [], searchError: [], searchResults: 0, scanError: [], presented: [], recognized: [] };
  const noop = () => {};
  return {
    seen,
    ui: {
      setStatus: noop, setBusy: noop, setSuggestions: noop, setRecognizedText: noop, setCandidateReason: noop,
      setScanError: (m) => seen.scanError.push(m),
      setSearchError: (m) => seen.searchError.push(m),
      setSearchResults: () => { seen.searchResults += 1; },
      showLowConfidenceCandidates: (c) => seen.presented.push({ kind: 'low', c }),
      onRecognized: (card) => seen.recognized.push(card.id),
      onVisionRecognized: (card) => seen.recognized.push(card.id),
      showPresentation: (p) => seen.presented.push(p),
      onServiceFailure: (k) => seen.failure.push(k),
    },
  };
}
const baseIo = (over) => ({
  callRecognitionApi: async () => ({ status: 502, body: { success: false } }),
  recognizeFromImage: async () => ({ success: false, serviceUnavailable: true, failure: 'unavailable' }),
  // v39 12:16:32: local OCR read SOME text that resolved to nothing
  ocrText: async () => 'ホロライブ 2nd',
  recognizeFromOcr: async () => ({ success: false, error: '找不到匹配的卡牌' }),
  searchCards: async () => [{ id: 'x' }],
  mapApiCard: (c) => ({ ...c }),
  mapApiCandidates: mapCands,
  ...over,
});
await test('native: service failure + local OCR text that matches nothing → service failure, never 「找不到」 or a search list', async () => {
  const { seen, ui } = recorder();
  await runNativeCameraScan('file:///crop.jpg', baseIo(), ui);
  assert.deepEqual(seen.failure, ['unavailable']);
  assert.deepEqual(seen.searchError, []);
  assert.equal(seen.searchResults, 0);
  assert.deepEqual(seen.presented, []);
});
await test('native: service failure, local OCR reads nothing → the same service failure (kind kept)', async () => {
  const { seen, ui } = recorder();
  await runNativeCameraScan('file:///crop.jpg', baseIo({ ocrText: async () => '', recognizeFromImage: async () => ({ success: false, serviceUnavailable: true, failure: 'timeout' }) }), ui);
  assert.deepEqual(seen.failure, ['timeout']);
  assert.deepEqual(seen.scanError, []);
});
await test('native: a real service no-match (not a failure) still shows the no-match + search route', async () => {
  const { seen, ui } = recorder();
  await runNativeCameraScan('file:///crop.jpg', baseIo({ recognizeFromImage: async () => ({ success: false, error: '' }) }), ui);
  assert.deepEqual(seen.failure, []);
  assert.equal(seen.searchError.length, 1);
});
await test('native: service failure but local OCR finds a card → shown for confirmation (not a failure)', async () => {
  const { seen, ui } = recorder();
  await runNativeCameraScan('file:///crop.jpg', baseIo({ recognizeFromOcr: async () => ({ success: true, card: { id: 'hBP01-010_hBP01_U_hBP01-010_U' }, confidence: 0.95 }) }), ui);
  assert.deepEqual(seen.failure, []);
  assert.deepEqual(seen.recognized, ['hBP01-010_hBP01_U_hBP01-010_U']);
});
for (const [label, call, kind] of [
  ['502 PROVIDER_BUSY', async () => ({ status: 502, body: { success: false, code: 'PROVIDER_BUSY' } }), 'busy'],
  ['our deadline (TimeoutError)', async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }, 'timeout'],
  ['no response (TypeError)', async () => { throw new TypeError('Failed to fetch'); }, 'network'],
  ['generic 502', async () => ({ status: 502, body: null }), 'unavailable'],
]) {
  await test(`web: ${label} → service failure "${kind}", no 「找不到」, no search list`, async () => {
    const { seen, ui } = recorder();
    await runWebCameraScan(JPEG, baseIo({ callRecognitionApi: call, recognizeFromImage: async () => ({ success: false, serviceUnavailable: true }) }), ui);
    assert.deepEqual(seen.failure, [kind]);
    assert.deepEqual(seen.searchError, []);
    assert.equal(seen.searchResults, 0);
  });
}
await test('web: after a service failure the fallback is LOCAL only — one remote request per scan, never a second upload', async () => {
  const calls = { api: 0, image: 0, ocr: 0 };
  const { seen, ui } = recorder();
  await runWebCameraScan(JPEG, baseIo({
    callRecognitionApi: async () => { calls.api += 1; return { status: 502, body: { success: false, code: 'PROVIDER_ERROR' } }; },
    recognizeFromImage: async () => { calls.image += 1; return { success: false, serviceUnavailable: true }; },
    ocrText: async () => { calls.ocr += 1; return ''; },
  }), ui);
  assert.deepEqual(calls, { api: 1, image: 0, ocr: 1 });
  assert.deepEqual(seen.failure, ['unavailable']);
});
await test('web: local OCR after a service failure can still find a card (shown for confirmation, no remote call)', async () => {
  let image = 0;
  const { seen, ui } = recorder();
  await runWebCameraScan(JPEG, baseIo({
    callRecognitionApi: async () => ({ status: 502, body: null }),
    recognizeFromImage: async () => { image += 1; return { success: false }; },
    recognizeFromOcr: async () => ({ success: true, card: { id: 'hBP01-010_hBP01_U_hBP01-010_U' }, confidence: 0.95 }),
  }), ui);
  assert.equal(image, 0);
  assert.deepEqual(seen.failure, []);
  assert.deepEqual(seen.recognized, ['hBP01-010_hBP01_U_hBP01-010_U']);
});

console.log('#4 readable summary of the user\'s actual export');
await test('build 39 and build 38 are separate groups (newest first); received name/number and the read number\'s real owner are readable', async () => {
  const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/v39-user-logs/export-20261016.json', import.meta.url), 'utf8'));
  // Re-sanitised exactly as the app would; a name is added to the trace top only by v40 servers.
  const out = JSON.parse(diag.buildExport(fx.entries, Date.parse(fx.exportedAt)));
  assert.equal(out.count, 7);
  const text = out.summary.join('\n');
  const g39 = text.indexOf('App build 39'), g38 = text.indexOf('App build 38');
  assert.ok(g39 > 0 && g38 > g39, 'v39 group first, then v38');
  assert.ok(text.slice(g39, g38).includes('風真いろは／卡號 hBP05-081'));
  assert.ok(text.slice(g39, g38).includes('宝鐘マリン／卡號 hBP01-014'));
  assert.ok(!text.slice(g38).includes('hBP05-081'), 'no v39 record in the v38 group');
  assert.ok(text.includes('可重試：是'), 'the service failure is marked retryable');
  assert.ok(text.includes('排序分數不是準確率'));
  assert.ok(!/準確率\s*\d|accuracy\s*\d|\d+\s*%/.test(text), 'no score shown as a percentage or accuracy');
  assert.deepEqual(out.entries.map((e) => e.id), fx.entries.map((e) => e.id), 'technical entries kept');
});
await test('with a v40 trace (catalog names on top candidates) the summary says whose number it really is', async () => {
  const fx = logFixture('iroha-4866fa1a60b22ec0');
  const { body } = await callHandler(replyOf(fx.received));
  const r = { debug: body.debug, trace: body.trace, match: body.match };
  const d = diag.diagnosticsFromResult({ ...r, trace: (await import('../src/services/scanTrace.ts')).projectTrace(body.trace) });
  const entry = diag.sanitizeEntry({ id: 'abcdefgh12345678', at: new Date().toISOString(), kind: 'scan', nativeBuild: '40', model: d.model, extracted: d.extracted, match: d.match, errors: d.errors, trace: d.trace });
  const text = diag.buildReadableSummary([entry]).join('\n');
  assert.ok(text.includes('風真いろは'));
  assert.ok(/hBP01-051 SR 風真いろは/.test(text), text);
  assert.ok(text.includes('已辨識卡牌，版本未定'));
  for (const re of [/data:image/, /file:\/\//, /offline-mock-key/, /CARD_NUMBER:/]) assert.ok(!re.test(JSON.stringify(entry) + text));
});

if ((process.exitCode ?? 0) === 0) console.log(`\n✅ scan-v39-recovery: ${passed} checks passed`);
else console.error('\n❌ scan-v39-recovery failed');
