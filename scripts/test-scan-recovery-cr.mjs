#!/usr/bin/env node
/**
 * CR 7fe5ec4 (2026-10-16) — four findings, each pinned with real wire fixtures or the
 * real handler. No provider, image, camera or quota.
 *
 *  #1 legacy (v37) ACCEPTANCE is judged by exact-number / conflict evidence on every
 *     route: native success, web success, ScanScreen decision (gallery / web picker &
 *     commit). Fuzzy-number and number/name-conflict successes are no-matches; an exact
 *     positive is a preview; a local OCR exact read keeps its own route.
 *  #2 a supplied server verdict survives without a trace (4a566fa response): provenance
 *     legacy_debug, serverVerdict matched / no_match; v37 stays legacy_no_verdict.
 *  #3 ranking and trace share one expected-line reader: an indented CARD_NUMBER line
 *     matches AND traces as parsed; blank / missing / NONE / invalid agree.
 *  #4 the received field is kept (safe) next to the normalised value: hBP01-0100 →
 *     parse_error + received, no value, no acceptance; hostile values never stored.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

const DB = JSON.parse(fs.readFileSync(new URL('../public/data/database.json', import.meta.url), 'utf8'));
const handler = (await import('../api/recognize-card.ts')).default;
const { recognizeCardFromImage, candidateEvidence } = await import('../src/services/cardRecognition.ts');
const { runNativeCameraScan, runWebCameraScan, decideRecognizedOutcome } = await import('../src/services/scanRecognitionFlow.ts');
const { presentLegacyDecision, presentCandidates } = await import('../src/services/scanPresentation.ts');
const diag = await import('../src/services/scanDiagnostics.ts');
const fixture = (n) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8'));

let passed = 0;
async function test(label, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (err) { process.exitCode = 1; console.error(`  ✗ ${label} — ${err.message}`); }
}

process.env.GEMINI_API_KEY = 'offline-mock-key';
let wire = null;
let reply = '';
globalThis.fetch = async (url, init = {}) => {
  const h = String(url);
  if (h.endsWith('/data/database.json')) return Response.json(DB);
  if (h.includes('generativelanguage')) return Response.json({ candidates: [{ content: { parts: [{ text: reply }] } }] });
  if (h.includes('/api/recognize-card')) {
    if (wire) return { ok: wire.status < 400, status: wire.status, json: async () => JSON.parse(JSON.stringify(wire.body)) };
    const res = await handler(new Request('https://holohunter.dicoge.com/api/recognize-card', { method: 'POST', body: init.body, headers: { 'Content-Type': 'application/json' } }));
    const t = await res.text();
    return { ok: res.ok, status: res.status, json: async () => JSON.parse(t) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
const JPEG = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 7)]).toString('base64')}`;
const mapCands = (raw) => (Array.isArray(raw) && raw.length ? raw.map((c) => ({ card: { ...c }, confidence: c.confidence ?? 0, evidence: candidateEvidence(c.reason) })) : undefined);

/** Runs one route; returns what the user would be shown and anything committed. */
async function route(name, which) {
  wire = fixture(name);
  const seen = { p: null, committed: [] };
  const noop = () => {};
  // ScanScreen's adapters: onRecognized → handleRecognized → decideRecognizedOutcome →
  // presentLegacyDecision(decision, undefined, candidates); showLowConfidenceCandidates
  // → presentCandidates. Neither commits.
  const decide = (card, confidence, candidates) => {
    const d = decideRecognizedOutcome(card, confidence, candidates, false);
    seen.p = presentLegacyDecision(d, undefined, candidates ?? []);
  };
  const ui = {
    setStatus: noop, setBusy: noop, setScanError: noop, setSearchError: noop, setSearchResults: noop, setSuggestions: noop,
    setRecognizedText: noop, setCandidateReason: noop,
    showLowConfidenceCandidates: (c) => { seen.p = presentCandidates(c); },
    onRecognized: decide,
    onVisionRecognized: (c) => { seen.committed.push(c.id); },
    showPresentation: (p) => { seen.p = p; },
  };
  const io = {
    callRecognitionApi: async () => ({ status: wire.status, body: JSON.parse(JSON.stringify(wire.body)) }),
    recognizeFromImage: (u) => recognizeCardFromImage(u), ocrText: async () => '', recognizeFromOcr: async () => ({ success: false }),
    searchCards: async () => [], mapApiCard: (c) => ({ ...c }), mapApiCandidates: mapCands,
  };
  if (which === 'native') await runNativeCameraScan(JPEG, io, ui);
  else if (which === 'web') await runWebCameraScan(JPEG, io, ui);
  else {
    // ScanScreen gallery: recognizeCardFromImage → success → handleRecognized(card, confidence, candidates)
    const r = await recognizeCardFromImage(JPEG);
    decide(r.card, r.confidence ?? 0.9, r.candidates);
  }
  wire = null;
  return seen;
}

// ============================ #1 ============================
console.log('\n#1 legacy acceptance judged by evidence on every route');
for (const which of ['native', 'web', 'gallery']) {
  await test(`${which}: v37 success via cardNumber fuzzy-1 (read hBP01-910, accepted hBP01-010 at 0.86) → no-match, no card, no price`, async () => {
    const { p, committed } = await route('v37-wire/success-fuzzy-number', which);
    assert.equal(p.kind, 'none');
    assert.equal(p.card, undefined);
    assert.deepEqual(committed, []);
  });
  await test(`${which}: v37 success with exact number but the read name belongs to other cards → conflict no-match`, async () => {
    const { p } = await route('v37-wire/success-number-name-conflict', which);
    assert.equal(p.kind, 'none');
    assert.equal(p.reason, 'number_name_conflict');
  });
  await test(`${which}: v37 exact + name success → best PREVIEW of hBP01-010 (explicit add, not committed)`, async () => {
    const { p, committed } = await route('v37-wire/success-exact-positive', which);
    assert.equal(p.kind, 'best');
    assert.equal(p.card.id, 'hBP01-010_hBP01_U_hBP01-010_U');
    assert.ok(p.evidence.includes('cardNumber exact'));
    assert.deepEqual(committed, []);
  });
}
await test('local OCR exact number (no backend evidence) keeps its own best preview route', () => {
  const card = { id: 'hBP01-010_hBP01_U_hBP01-010_U', cardNumber: 'hBP01-010' };
  const p = presentLegacyDecision({ action: 'commit', card, confidence: 0.95 });
  assert.equal(p.kind, 'best');
  assert.equal(p.source, 'local_ocr');
});

// ============================ #2 ============================
console.log('\n#2 supplied verdict kept without a trace');
await test('4a566fa matched response (no trace) → match matched AND trace.serverVerdict matched, provenance legacy_debug', async () => {
  wire = fixture('base4a-wire/matched-no-trace');
  const r = await recognizeCardFromImage(JPEG); wire = null;
  const d = diag.diagnosticsFromResult(r);
  assert.equal(d.match.status, 'matched');
  assert.equal(d.trace.provenance, 'legacy_debug');
  assert.equal(d.trace.serverVerdict.status, 'matched');
  const e = diag.sanitizeEntry({ id: 'abcdefgh12345678', at: new Date().toISOString(), match: d.match, trace: d.trace });
  assert.equal(e.trace.serverVerdict.status, e.match.status, 'export stages agree');
});
await test('4a566fa no-match response (no trace) → serverVerdict no_match with its reason', async () => {
  wire = fixture('base4a-wire/no-match-no-trace');
  const r = await recognizeCardFromImage(JPEG); wire = null;
  const d = diag.diagnosticsFromResult(r);
  assert.equal(d.match.status, 'no_match');
  assert.deepEqual(d.trace.serverVerdict, { status: 'no_match', reason: 'number_not_in_database' });
});
await test('a truly verdict-less v37 response stays legacy_no_verdict', async () => {
  wire = fixture('v37-wire/success-exact-positive');
  const r = await recognizeCardFromImage(JPEG); wire = null;
  const d = diag.diagnosticsFromResult(r);
  assert.equal(d.match.status, 'legacy_no_verdict');
  assert.equal(d.trace.serverVerdict.status, 'legacy_no_verdict');
});

// ============================ #3 ============================
console.log('\n#3 ranking and trace read the same lines');
const serve = async (text) => {
  reply = text;
  const res = await handler(new Request('https://x/api/recognize-card', { method: 'POST', body: JSON.stringify({ image: JPEG }), headers: { 'Content-Type': 'application/json' } }));
  return { status: res.status, body: await res.json() };
};
await test('indented / spaced valid CARD_NUMBER line still matches, and the trace agrees', async () => {
  const r = await serve('CHARACTER: 天音かなた\n  CARD_NUMBER:   hBP01-010  \n\tRARITY : U');
  assert.equal(r.status, 200);
  assert.equal(r.body.match.status, 'matched');
  assert.equal(r.body.debug.normalizedCardNumber, 'hbp01-010');
  assert.deepEqual(r.body.trace.fields.number, { state: 'parsed', received: 'hBP01-010', value: 'hbp01-010' });
  assert.equal(r.body.trace.fields.rarity.value, 'U');
});
for (const [label, line, state, reason] of [
  ['blank', 'CARD_NUMBER:', 'empty', 'no_card_number'],
  ['missing', '', 'missing', 'no_card_number'],
  ['NONE', 'CARD_NUMBER: NONE', 'provider_unknown', 'no_card_number'],
  ['invalid hBP01-0100', 'CARD_NUMBER: hBP01-0100', 'parse_error', 'no_card_number'],
  ['fuzzy label "CARD NUMBER" is not read', 'CARD NUMBER: hBP01-010', 'missing', 'no_card_number'],
]) {
  await test(`${label}: ranking (${reason}) and trace (${state}) agree`, async () => {
    const r = await serve(`CHARACTER: 天音かなた\n${line}`);
    assert.equal(r.body.match.status, 'no_match');
    assert.equal(r.body.match.reason, reason);
    assert.equal(r.body.debug.normalizedCardNumber, null);
    assert.equal(r.body.trace.fields.number.state, state);
  });
}

// ============================ #4 ============================
console.log('\n#4 received field kept next to the normalised value');
await test('received hBP01-0100 → parse_error, received kept, no normalised value, no acceptance', async () => {
  const r = await serve('CHARACTER: 天音かなた\nCARD_NUMBER: hBP01-0100');
  assert.deepEqual(r.body.trace.fields.number, { state: 'parse_error', received: 'hBP01-0100' });
  assert.equal(r.body.success, false);
  assert.equal(r.body.debug.extracted.cardNumberRaw, 'hBP01-0100');
});
await test('received formatted valid token vs canonical: hBP0l-O1O → received kept, value hbp01-010', async () => {
  const r = await serve('CHARACTER: 天音かなた\nCARD_NUMBER: hBP0l-O1O');
  assert.deepEqual(r.body.trace.fields.number, { state: 'parsed', received: 'hBP0l-O1O', value: 'hbp01-010' });
});
await test('legacy (v37) received cardNumberRaw kept beside its normalised number in the log', async () => {
  wire = fixture('v37-wire/success-fuzzy-number');
  const r = await recognizeCardFromImage(JPEG); wire = null;
  const n = diag.diagnosticsFromResult(r).trace.fields.number;
  assert.equal(n.received, 'hBP01-910');
  assert.equal(n.value, 'hbp01-910');
});
await test('hostile received values never reach the wire, the log or the export', async () => {
  const r = await serve('CHARACTER: me a@b.com\nCARD_NUMBER: AIzaSyD-FAKEFAKEFAKE1234\nSET: https://x.y\nTITLE: <b>x</b>');
  const text = JSON.stringify(r.body);
  for (const s of ['a@b.com', 'AIzaSyD', 'https://x.y', '<b>']) assert.ok(!text.includes(s), `wire has ${s}`);
  const stored = diag.sanitizeEntry({ id: 'abcdefgh12345678', at: new Date().toISOString(), trace: {
    provenance: 'legacy_debug', fields: {
      number: { state: 'parse_error', received: 'eyJhbGciOiJIUzI1NiJ9.x.y' },
      name: { state: 'parsed', received: 'x@y.io', value: 'ok' },
      set: { state: 'parsed', received: 'QUJD'.repeat(10), value: 'hBP01' },
    } } });
  const out = diag.buildExport([stored]);
  for (const s of ['eyJhbGci', 'x@y.io', 'QUJDQUJD']) assert.ok(!out.includes(s), `export has ${s}`);
  assert.equal(stored.trace.fields.number.received, undefined);
});

if ((process.exitCode ?? 0) === 0) console.log(`\n✅ scan-recovery-cr: ${passed} checks passed`);
else console.error('\n❌ scan-recovery-cr failed');
