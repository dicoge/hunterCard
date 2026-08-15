#!/usr/bin/env node
/**
 * QA DIC-1013 regression: an unprovisioned recognition backend must be reported as
 * an unavailable SERVICE, never as an unrecognisable PHOTO.
 *
 * The shipped Preview and Production deployments both answered POST
 * /api/recognize-card with HTTP 500 `GEMINI_API_KEY not set`, the client discarded
 * the status, the local OCR fallback then came up empty, and the user was told to
 * "調整角度或光線" — so album upload looked like a bad photo instead of a missing
 * deployment secret, and QA could not create a scan session at all.
 *
 * Exercises the REAL edge handler and the REAL client classifier (not source text):
 * network is stubbed so the Gemini + database legs are driven deterministically.
 *
 * Run: node --experimental-strip-types scripts/test-recognition-unavailable.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import handler, { RECOGNITION_UNAVAILABLE_CODE } from '../api/recognize-card.ts';
import {
  isRecognitionUnavailable,
  RECOGNITION_UNAVAILABLE_MESSAGE,
  RECOGNITION_UNAVAILABLE_CODE as CLIENT_CODE,
} from '../src/services/recognitionOutcome.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const database = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../public/data/database.json'), 'utf8'),
);

// The exact retake hint the user must NEVER see for a backend outage.
const RETAKE_HINT = '無法從卡牌識別到卡號，請調整角度或光線後重試';
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let geminiReply = 'CARD_NUMBER: hBP04-005\nCHARACTER: ラプラス・ダークネス\nRARITY: SEC';
let geminiStatus = 200;
let geminiCalls = 0;

globalThis.fetch = async (url) => {
  const href = String(url);
  if (href.includes('generativelanguage.googleapis.com')) {
    geminiCalls++;
    if (geminiStatus !== 200) {
      return new Response('upstream boom', { status: geminiStatus });
    }
    return Response.json({ candidates: [{ content: { parts: [{ text: geminiReply }] } }] });
  }
  if (href.includes('database.json')) return Response.json(database);
  throw new Error(`unexpected fetch: ${href}`);
};

const post = (body) =>
  handler(
    new Request('https://holocard-hunter.vercel.app/api/recognize-card', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

const results = [];
const check = (label, fn) => {
  fn();
  results.push(label);
};

// ── 1. No key → the exact production failure, now classified ──────────────────
const savedKey = process.env.GEMINI_API_KEY;
delete process.env.GEMINI_API_KEY;

const missing = await post({ image: PIXEL });
const missingBody = await missing.json();
const missingBytes = JSON.stringify(missingBody);

check('unprovisioned key answers 503, not 500', () => {
  assert.equal(missing.status, 503);
});
check('unprovisioned key carries the stable RECOGNITION_UNAVAILABLE code', () => {
  assert.equal(missingBody.success, false);
  assert.equal(missingBody.code, RECOGNITION_UNAVAILABLE_CODE);
  assert.equal(missingBody.code, CLIENT_CODE, 'server and client must agree on the code');
});
check('response never names the env var over the wire', () => {
  assert.ok(!/GEMINI_API_KEY/.test(missingBytes), missingBytes);
});
check('response never blames the photo', () => {
  assert.ok(!missingBytes.includes('調整角度'), missingBytes);
});
check('vision is not called when the key is absent', () => {
  assert.equal(geminiCalls, 0);
});

// ── 2. The real client classifier agrees with the real response ───────────────
check('client classifies the real 503 as unavailable', () => {
  assert.equal(isRecognitionUnavailable(missing.status, missingBody), true);
});
check('client message is the service notice, not the retake hint', () => {
  const shown = isRecognitionUnavailable(missing.status, missingBody)
    ? RECOGNITION_UNAVAILABLE_MESSAGE
    : RETAKE_HINT;
  assert.equal(shown, RECOGNITION_UNAVAILABLE_MESSAGE);
  assert.notEqual(shown, RETAKE_HINT);
});
check('code alone is enough when only the body survives a proxy', () => {
  assert.equal(isRecognitionUnavailable(200, { code: RECOGNITION_UNAVAILABLE_CODE }), true);
});

// ── 3. An upstream outage is NOT a misconfiguration ───────────────────────────
process.env.GEMINI_API_KEY = 'test-key';
geminiStatus = 500;
const upstream = await post({ image: PIXEL });
const upstreamBody = await upstream.json();

check('upstream vision failure stays 502', () => {
  assert.equal(upstream.status, 502);
});
check('upstream vision failure is not marked unavailable', () => {
  assert.notEqual(upstreamBody.code, RECOGNITION_UNAVAILABLE_CODE);
  assert.equal(isRecognitionUnavailable(upstream.status, upstreamBody), false);
});
check('a matched card is never treated as unavailable', () => {
  assert.equal(isRecognitionUnavailable(200, { success: true }), false);
  assert.equal(isRecognitionUnavailable(404, { success: false }), false);
});

// ── 4. Happy path still recognises through the same handler ───────────────────
geminiStatus = 200;
const ok = await post({ image: PIXEL });
const okBody = await ok.json();

check('a provisioned key still ranks the scanned card end-to-end', () => {
  assert.equal(ok.status, 200);
  // hBP04-005 exists under two series, so the ranker deliberately drops below the
  // auto-accept bar and hands the user a candidate picker — the point here is that
  // the card IS recognised, not that it is auto-committed.
  assert.equal(okBody.debug.normalizedCardNumber, 'hbp04-005');
  assert.equal(okBody.candidates[0].cardNumber, 'hBP04-005');
});
check('a ranked result is never classified as unavailable', () => {
  assert.equal(isRecognitionUnavailable(ok.status, okBody), false);
});
check('vision was actually exercised once a key exists', () => {
  assert.ok(geminiCalls >= 1);
});

if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
else process.env.GEMINI_API_KEY = savedKey;

for (const label of results) console.log(`  ✓ ${label}`);
console.log(`\n✅ recognition-unavailable: ${results.length} checks passed`);
