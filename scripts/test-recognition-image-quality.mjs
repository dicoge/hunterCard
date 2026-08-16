#!/usr/bin/env node
/**
 * DIC-1021 regression: an unreadable photo must fail honestly, never confidently.
 *
 * QA scanned the shipped 100x140 thumbnail data/images/hBP07-029.jpg. The model cannot
 * read a card number at that size, but it does not answer NONE — it invents one. The
 * invented number then scores as "cardNumber exact" (+100) and the response came back
 * with five confident candidates, none of them the actual hBP07-029.
 *
 * The same pipeline recognises this card correctly from a full-resolution image, so the
 * defect is that an illegible frame is allowed to produce a match at all.
 *
 * Run: node --experimental-strip-types scripts/test-recognition-image-quality.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import handler, { imageLongestEdge, isBelowLegibleResolution } from '../api/recognize-card.ts';
import { isRecognitionInfrastructureFailure } from '../src/services/recognitionOutcome.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = (p) => path.resolve(__dirname, '..', p);

const database = JSON.parse(fs.readFileSync(repo('public/data/database.json'), 'utf8'));

// The exact image QA scanned, as shipped in this repository.
const THUMBNAIL_PATH = 'data/images/hBP07-029.jpg';
const THUMBNAIL = `data:image/jpeg;base64,${fs.readFileSync(repo(THUMBNAIL_PATH)).toString('base64')}`;

/** A legible-size PNG header — only the dimensions are read, so the pixels are irrelevant. */
function pngOfSize(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8; // bit depth
  bytes[25] = 2; // colour type
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

const LEGIBLE = pngOfSize(1000, 1400);

// Both replies were captured live from the exact-head Preview deployment, through
// openrouter/google/gemini-2.5-flash, on this same card.
const REPLY_FROM_FULL_RESOLUTION = [
  'CHARACTER: 大神ミオ',
  'HP: 200',
  'RARITY: UR',
  'BLOOM_LEVEL: 2nd',
  'CARD_NUMBER: hBP07-029',
  'TITLE: 緑の地母神',
].join('\n');

// What the model answered for the 100x140 thumbnail: a different character, a different
// set, an invented number — stated with no hedging at all.
const REPLY_FROM_THUMBNAIL = [
  'CHARACTER: Oozora Subaru',
  'HP: 200',
  'RARITY: C',
  'BLOOM_LEVEL: 1st',
  'CARD_NUMBER: hBP01-024',
  'TITLE: NONE',
].join('\n');

const savedGoogle = process.env.GEMINI_API_KEY;
const savedOpenRouter = process.env.OPENROUTER_API_KEY;
process.env.GEMINI_API_KEY = 'test-key';
delete process.env.OPENROUTER_API_KEY;

function stubNetwork(reply) {
  const providerCalls = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('database.json')) return Response.json(database);
    providerCalls.push(href);
    return Response.json({ candidates: [{ content: { parts: [{ text: reply }] } }] });
  };
  return providerCalls;
}

async function scan(images, reply) {
  const providerCalls = stubNetwork(reply);
  const res = await handler(new Request('https://holohunter.dicoge.com/api/recognize-card', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images }),
  }));
  return { res, body: await res.json(), providerCalls };
}

const results = [];
const check = (label, fn) => { fn(); results.push(label); };

// ── 1. Real shipped JPEG dimensions are read from the header bytes ────────────
{
  check('the shipped hBP07-029 thumbnail measures 140px on its longest edge', () => {
    assert.equal(imageLongestEdge(THUMBNAIL), 140);
  });
  check('a legible-size PNG measures its real longest edge', () => {
    assert.equal(imageLongestEdge(LEGIBLE), 1400);
  });
  check('an unmeasurable payload returns null so callers fail open', () => {
    assert.equal(imageLongestEdge('data:image/jpeg;base64,ZnVsbC1mcmFtZQ=='), null);
    assert.equal(imageLongestEdge('not-an-image'), null);
  });
  check('only positively measured, too-small images are refused', () => {
    assert.equal(isBelowLegibleResolution([THUMBNAIL]), true);
    assert.equal(isBelowLegibleResolution([LEGIBLE]), false);
    // The crop is smaller than the full frame; one legible image is enough.
    assert.equal(isBelowLegibleResolution([LEGIBLE, THUMBNAIL]), false);
    assert.equal(isBelowLegibleResolution(['data:image/jpeg;base64,ZnVsbC1mcmFtZQ==']), false);
    assert.equal(isBelowLegibleResolution([]), false);
  });
}

// ── 2. QA's exact failure case: no invented card may reach the user ───────────
{
  const { res, body, providerCalls } = await scan([THUMBNAIL], REPLY_FROM_THUMBNAIL);
  check('the thumbnail QA scanned is refused instead of matched', () => {
    assert.equal(res.status, 404);
    assert.equal(body.success, false);
  });
  check('no invented candidate is offered for an illegible photo', () => {
    assert.deepEqual(body.candidates, []);
    const wire = JSON.stringify(body);
    assert.ok(!wire.includes('hBP01-024'), 'the hallucinated card must not reach the client');
    assert.ok(!wire.includes('hBP08-024'), 'nor the one QA saw');
  });
  check('an illegible photo never spends a provider call', () => {
    assert.deepEqual(providerCalls, []);
  });
  check('the refusal asks for a closer photo, not a lighting fix or a backend excuse', () => {
    assert.match(body.error, /重新拍攝/);
  });
  check('the refusal stays a photo-level outcome, not an infrastructure failure', () => {
    // 404 must not trip the DIC-1013 branch that reports the deployment as broken.
    assert.equal(isRecognitionInfrastructureFailure(res.status, body), false);
  });
}

// ── 3. A broken deployment outranks a bad photo (DIC-1013 ordering) ───────────
{
  delete process.env.GEMINI_API_KEY;
  const { res, body } = await scan([THUMBNAIL], REPLY_FROM_THUMBNAIL);
  check('an unprovisioned backend still answers 503 for an illegible photo', () => {
    // Telling the user to retake the shot when the deployment cannot recognise at all
    // is the exact DIC-1013 defect; the resolution guard must not reintroduce it.
    assert.equal(res.status, 503);
    assert.equal(body.code, 'RECOGNITION_UNAVAILABLE');
    assert.equal(isRecognitionInfrastructureFailure(res.status, body), true);
  });
  process.env.GEMINI_API_KEY = 'test-key';
}

// ── 4. The actual card still survives extraction and candidate handling ───────
{
  const { res, body, providerCalls } = await scan([LEGIBLE], REPLY_FROM_FULL_RESOLUTION);
  check('a legible photo of hBP07-029 is recognised as hBP07-029', () => {
    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.card.cardNumber, 'hBP07-029');
    assert.equal(body.card.name, '大神ミオ');
    assert.equal(body.card.rarity, 'UR');
  });
  check('the real card leads the candidate list', () => {
    assert.equal(body.candidates[0].cardNumber, 'hBP07-029');
    assert.ok(body.candidates.some(c => c.cardNumber === 'hBP07-029' && c.rarity === 'UR'));
  });
  check('a legible photo is still sent to the provider exactly once', () => {
    assert.equal(providerCalls.length, 1);
  });
}

// ── 5. Deterministic ranking itself is untouched by the guard ─────────────────
{
  // Fed the same hallucinated reply from a legible image, ranking must behave exactly as
  // before: the guard is the only thing that changed, not the scoring.
  const { res, body } = await scan([LEGIBLE], REPLY_FROM_THUMBNAIL);
  check('ranking still scores an exact card number the same way', () => {
    assert.equal(res.status, 200);
    assert.equal(body.candidates[0].cardNumber, 'hBP01-024');
    assert.match(body.debug.reason, /cardNumber exact/);
  });
}

if (savedGoogle === undefined) delete process.env.GEMINI_API_KEY;
else process.env.GEMINI_API_KEY = savedGoogle;
if (savedOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
else process.env.OPENROUTER_API_KEY = savedOpenRouter;

for (const label of results) console.log(`  ✓ ${label}`);
console.log(`\n✅ recognition-image-quality: ${results.length} checks passed`);
