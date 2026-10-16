#!/usr/bin/env node
/**
 * Scan trace + regression fixtures (2026-10-16).
 *
 * 1. Server trace from the REAL recognize-card handler (Gemini + catalog mocked): every
 *    field state (parsed / missing / empty / provider_unknown / parse_error / redacted),
 *    reply schema_mismatch, rejection no_candidate vs evidence_rejected vs
 *    printing_unresolved, requestId / allowlisted backendSha, and no raw reply anywhere.
 * 2. Safe names keep real punctuation; hostile values (email, key, token, base64,
 *    url, markup) never reach the wire, the log or the export.
 * 3. Old server × new client with the user-log shape: the v37 name-only / romaji wire
 *    becomes provenance legacy_debug, status legacy_no_verdict, number not_provided —
 *    no longer conflated with "unknown"; v1 exports stay readable.
 * 4. Matching fix: an older backend's accepted card below the app's 0.85 bar (picker
 *    route) is presented by evidence, not as 證據不足.
 * 5. Timeline: presented → discarded / cancelled in order, bounded.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

const DB = JSON.parse(fs.readFileSync(new URL('../public/data/database.json', import.meta.url), 'utf8'));
const handler = (await import('../api/recognize-card.ts')).default;
const trace = await import('../src/services/scanTrace.ts');
const diag = await import('../src/services/scanDiagnostics.ts');
const { presentLegacyDecision } = await import('../src/services/scanPresentation.ts');
const { recognizeCardFromImage } = await import('../src/services/cardRecognition.ts');

let passed = 0;
async function test(label, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (err) { process.exitCode = 1; console.error(`  ✗ ${label} — ${err.message}`); }
}
const HOSTILE = [/@[a-z0-9-]+\.[a-z]/i, /AIza[0-9A-Za-z_-]{10}/, /eyJ[0-9A-Za-z_-]{6}/, /https?:\/\//, /data:image\//, /<script/i, /CARD_NUMBER:/, /[A-Za-z0-9+/]{40,}/];
const assertClean = (text, where) => { for (const re of HOSTILE) assert.ok(!re.test(text), `${where} contains ${re}`); };

process.env.GEMINI_API_KEY = 'offline-mock-key';
const SHA = 'a'.repeat(40);
let reply = '';
let backend = 'v38';
let legacyFixture = null;
globalThis.fetch = async (url, init = {}) => {
  const h = String(url);
  if (h.endsWith('/data/database.json')) return Response.json(DB);
  if (h.includes('generativelanguage')) return Response.json({ candidates: [{ content: { parts: [{ text: reply }] } }] });
  if (h.includes('/api/recognize-card')) {
    if (backend === 'v37') return { ok: legacyFixture.status < 400, status: legacyFixture.status, json: async () => JSON.parse(JSON.stringify(legacyFixture.body)) };
    const res = await handler(new Request('https://holohunter.dicoge.com/api/recognize-card', { method: 'POST', body: init.body, headers: { 'Content-Type': 'application/json' } }));
    const t = await res.text();
    return { ok: res.ok, status: res.status, json: async () => JSON.parse(t) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
const JPEG = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 7)]).toString('base64')}`;
async function serve(text, sha = SHA) {
  reply = text;
  process.env.VERCEL_GIT_COMMIT_SHA = sha;
  const res = await handler(new Request('https://holohunter.dicoge.com/api/recognize-card', { method: 'POST', body: JSON.stringify({ image: JPEG }), headers: { 'Content-Type': 'application/json' } }));
  const t = await res.text();
  return { status: res.status, text: t, body: JSON.parse(t) };
}

// ============================ 1. server trace ============================
console.log('\nServer trace (real handler, mocked Gemini)');
await test('perfect read: fields parsed, matched, requestId + allowlisted backendSha, no raw reply on the wire', async () => {
  const r = await serve('CHARACTER: 天音かなた\nRARITY: U\nCARD_NUMBER: hBP01-010\nSET: hBP01\nLANGUAGE: ja\nTITLE: NONE');
  const t = r.body.trace;
  assert.equal(t.schema, 'scan-trace/1');
  assert.match(t.requestId, /^[0-9a-f]{16}$/);
  assert.equal(t.backendSha, SHA);
  assert.equal(t.model, 'gemini-3.5-flash-lite');
  assert.deepEqual(t.fields.number, { state: 'parsed', value: 'hbp01-010' });
  assert.deepEqual(t.fields.name, { state: 'parsed', value: '天音かなた' });
  assert.deepEqual(t.fields.language, { state: 'parsed', value: 'JA' });
  assert.deepEqual(t.fields.title, { state: 'provider_unknown' });
  assert.equal(t.verdict.status, 'matched');
  assert.equal(t.rejection, null);
  assert.ok(t.top[0].id.startsWith('hBP01-010') && t.top[0].evidence.includes('cardNumber exact'));
  assert.equal('raw' in r.body, false, 'no raw reply field');
  // Catalog card objects legitimately carry official image URLs; the diagnostic blocks never do.
  assertClean(JSON.stringify({ trace: { ...r.body.trace, backendSha: null }, debug: r.body.debug }), 'trace/debug');
  assert.ok(!r.text.includes('CARD_NUMBER:'), 'reply text not echoed');
});
await test('backendSha is null unless the env value is exactly 40 lowercase hex', async () => {
  for (const bad of ['main', 'A'.repeat(40), 'a'.repeat(39), `${SHA}; rm -rf`]) {
    assert.equal((await serve('CARD_NUMBER: hBP01-010\nCHARACTER: 天音かなた', bad)).body.trace.backendSha, null, bad);
  }
});
await test('field states: missing / empty / provider_unknown / parse_error are distinct', async () => {
  const t = (await serve('CHARACTER: 天音かなた\nCARD_NUMBER: hBP01-0100\nSET:\nLANGUAGE: UNKNOWN')).body.trace;
  assert.equal(t.fields.number.state, 'parse_error');
  assert.equal(t.fields.number.value, undefined, 'a rejected number is not echoed');
  assert.equal(t.fields.set.state, 'empty');
  assert.equal(t.fields.language.state, 'provider_unknown');
  assert.equal(t.fields.rarity.state, 'missing');
  assert.equal(t.fields.title.state, 'missing');
});
await test('a reply with none of the expected lines → replySchema schema_mismatch, no_candidate', async () => {
  const t = (await serve('Sorry, I cannot see a trading card in this image.')).body.trace;
  assert.equal(t.replySchema, 'schema_mismatch');
  assert.equal(t.candidateCount, 0);
  assert.equal(t.rejection, 'no_candidate');
});
await test('rejections: number not in catalog with name candidates → evidence_rejected; multi-printing → printing_unresolved', async () => {
  const a = (await serve('CHARACTER: 天音かなた\nCARD_NUMBER: hZZ99-999')).body.trace;
  assert.equal(a.verdict.reason, 'number_not_in_database');
  assert.ok(a.candidateCount > 0);
  assert.equal(a.rejection, 'evidence_rejected');
  const b = (await serve('CARD_NUMBER: hBP01-024')).body.trace;
  assert.equal(b.verdict.status, 'identity_only');
  assert.equal(b.rejection, 'printing_unresolved');
});

// ============================ 2. safe text vs hostile ============================
console.log('\nSafe card text vs hostile values');
await test('real names keep their punctuation, digits and scripts', () => {
  for (const n of ['ラプラス・ダークネス', 'AZKi', 'Houshou Marine', '常闇トワ（パラレル）', "Ninomae Ina'nis", 'Hakos Baelz!', 'さくらみこ 2nd']) {
    assert.equal(trace.safeCardText('name', n), n.normalize('NFKC'), n);
  }
});
await test('hostile values in reply lines are redacted on the wire and never echoed', async () => {
  const r = await serve('CHARACTER: contact me a@b.com\nTITLE: AIzaSyD-FAKEFAKEFAKEFAKE123\nSET: https://evil.example\nLANGUAGE: <script>\nRARITY: ' + 'QUJD'.repeat(20) + '\nCARD_NUMBER: hBP01-010');
  const f = r.body.trace.fields;
  for (const k of ['name', 'title', 'set', 'language', 'rarity']) assert.equal(f[k].state, 'redacted', k);
  assertClean(JSON.stringify({ trace: { ...r.body.trace, backendSha: null }, debug: r.body.debug }), 'trace/debug');
  for (const injected of ['a@b.com', 'AIzaSyD-FAKE', 'evil.example', '<script>', 'QUJDQUJD']) assert.ok(!r.text.includes(injected), `echoed ${injected}`);
  assert.equal(r.body.debug.extracted.characterName, '', 'debug copy blanked too');
});
await test('client projection drops unknown keys and re-redacts injected "parsed" values', () => {
  const t = trace.projectTrace({ schema: 'scan-trace/1', verdict: { status: 'no_match', reason: 'x' }, rawReply: 'CARD_NUMBER: x', apiKey: 'AIzaFAKE',
    fields: { name: { state: 'parsed', value: 'x@y.io' }, number: { state: 'hacked' } }, top: [{ id: 'javascript:alert(1)', evidence: 'cardNumber exact, evil' }], requestId: 'XYZ', backendSha: 'nope' });
  assert.deepEqual(Object.keys(t).sort(), ['backendSha', 'candidateCount', 'fields', 'model', 'rejection', 'replySchema', 'requestId', 'schema', 'top', 'verdict']);
  assert.equal(t.fields.name.state, 'redacted');
  assert.equal(t.fields.number.state, 'not_provided');
  assert.equal(t.top[0].id, '[redacted]');
  assert.deepEqual(t.top[0].evidence, ['cardNumber exact']);
  assert.equal(t.verdict.reason, null);
  assert.equal(t.requestId, null); assert.equal(t.backendSha, null);
  assert.equal(trace.projectTrace({ schema: 'other' }), undefined, 'unknown schema → dropped');
});

// ============================ 3. old server × new client ============================
console.log('\nOld server (v37 wire) × v38 client, user-log shape');
await test('real user v1 export shape still sanitises and exports (schema 1 readable)', () => {
  const v1 = JSON.parse(fs.readFileSync(new URL('./fixtures/user-log-shape/v1-export-2026-10-16.json', import.meta.url), 'utf8'));
  const now = Date.parse('2026-10-17T00:00:00Z');
  const out = JSON.parse(diag.buildExport(v1.entries, now));
  assert.equal(out.count, 4);
  assert.deepEqual(out.entries.map((e) => e.outcome), ['discarded', 'discarded', 'discarded', 'cancelled']);
  assert.equal(out.entries[3].extracted.name, 'Houshou Marine');
  assert.equal(out.entries[0].extracted.name, '[redacted]', 'a stored sentinel is never "un-redacted"');
  assert.equal(out.entries[0].trace, undefined, 'v1 entries carry no invented trace');
});
await test('v37 name-only/romaji wire → legacy_debug provenance, legacy_no_verdict, number not_provided (not "unknown")', async () => {
  backend = 'v37';
  legacyFixture = JSON.parse(fs.readFileSync(new URL('./fixtures/user-log-shape/v37-wire-name-only-romaji.json', import.meta.url), 'utf8'));
  const r = await recognizeCardFromImage(JPEG);
  backend = 'v38';
  const d = diag.diagnosticsFromResult(r);
  assert.equal(d.match.status, 'legacy_no_verdict');
  assert.equal(d.model, 'gemini-2.5-flash');
  assert.equal(d.trace.provenance, 'legacy_debug');
  assert.deepEqual(d.trace.fields.name, { state: 'parsed', value: 'Houshou Marine' });
  assert.equal(d.trace.fields.number.state, 'not_provided');
  assert.equal(d.trace.fields.set.state, 'not_provided');
  assert.equal(d.trace.serverVerdict.status, 'legacy_no_verdict');
  assert.equal(d.trace.candidateCount, 2);
  const e = diag.sanitizeEntry({ id: 'abcdefgh12345678', at: new Date().toISOString(), model: d.model, extracted: d.extracted, match: d.match, trace: d.trace, errors: d.errors });
  assert.equal(e.match.status, 'legacy_no_verdict');
  assert.equal(e.extracted.name, 'Houshou Marine');
  assert.equal(e.trace.provenance, 'legacy_debug');
});
await test('v38 wire → server_trace provenance with requestId / backendSha / per-field states', async () => {
  reply = 'CHARACTER: 天音かなた\nCARD_NUMBER: hBP01-010\nSET: NONE';
  process.env.VERCEL_GIT_COMMIT_SHA = SHA;
  const r = await recognizeCardFromImage(JPEG);
  const d = diag.diagnosticsFromResult(r);
  assert.equal(d.trace.provenance, 'server_trace');
  assert.equal(d.trace.backendSha, SHA);
  assert.match(d.trace.requestId, /^[0-9a-f]{16}$/);
  assert.equal(d.trace.fields.set.state, 'provider_unknown');
  assert.equal(d.trace.serverVerdict.status, 'matched');
});

// ============================ 4. matching fix (picker route) ============================
console.log('\nMatching fix: older backend accepted card below the app bar');
await test('v37 success at confidence 0.83 (picker decision) with evidence → best preview, not 證據不足', () => {
  const card = { id: 'hBP01-001_hBP01_OUR_hBP01-001_OUR', cardNumber: 'hBP01-001', rarity: 'OUR', sellPrice: 19800 };
  const other = { id: 'hBP01-001_hBP01_OSR_hBP01-001_OSR', cardNumber: 'hBP01-001', rarity: 'OSR', sellPrice: 680 };
  const filler = { id: 'hBP01-009_hBP01_C_hBP01-009_C', cardNumber: 'hBP01-009', rarity: 'C' };
  const cands = [
    { card, confidence: 0.83, evidence: ['cardNumber exact', 'character exact/contains', 'rarity'] },
    { card: other, confidence: 0.7, evidence: ['cardNumber exact', 'character exact/contains'] },
    { card: filler, confidence: 0.2, evidence: ['character exact/contains'] },
  ];
  const p = presentLegacyDecision({ action: 'picker', tier: 'mid', candidates: cands }, undefined, cands);
  assert.equal(p.kind, 'best');
  assert.equal(p.card.id, card.id);
  assert.equal(p.source, 'legacy_evidence');
  const commit = presentLegacyDecision({ action: 'commit', card, confidence: 0.9 }, undefined, cands);
  assert.equal(commit.source, 'legacy_evidence');
  assert.ok(commit.evidence.includes('cardNumber exact'));
});
await test('local OCR name-only picker (no evidence) stays an explicit no-match', () => {
  const p = presentLegacyDecision({ action: 'picker', tier: 'low', candidates: [{ card: { id: 'x', cardNumber: 'hBP01-001' }, confidence: 0.5 }] });
  assert.equal(p.kind, 'none');
  assert.equal(p.source, 'local_ocr');
});

// ============================ 5. timeline ============================
console.log('\nTimeline');
await test('presented → discarded / cancelled kept in order, bounded to MAX_TIMELINE, unknown events dropped', () => {
  const tl = [{ e: 'presented', t: 4000 }, { e: 'discarded', t: 9000 }, { e: 'hacked', t: 1 }, ...Array.from({ length: 20 }, (_, i) => ({ e: 'cancelled', t: 10000 + i }))];
  const e = diag.sanitizeEntry({ id: 'abcdefgh12345678', at: new Date().toISOString(), timeline: tl, outcome: 'cancelled' });
  assert.equal(e.timeline.length, diag.MAX_TIMELINE);
  assert.ok(e.timeline.every((x) => x.e !== 'hacked'));
  const short = diag.sanitizeEntry({ id: 'abcdefgh12345678', at: new Date().toISOString(), timeline: tl.slice(0, 2) });
  assert.deepEqual(short.timeline.map((x) => x.e), ['presented', 'discarded']);
});

if ((process.exitCode ?? 0) === 0) console.log(`\n✅ scan-trace: ${passed} checks passed`);
else console.error('\n❌ scan-trace failed');
