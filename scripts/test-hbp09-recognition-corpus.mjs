#!/usr/bin/env node
/**
 * DIC-P0 hBP09 — recognition regression corpus.
 *
 * On 2026-09-24 the user scanned multiple physical hBP09 cards against
 * canonical Production and none were recognised: every request answered 503
 * RECOGNITION_UNAVAILABLE (no GEMINI_API_KEY in the deployment). The catalog
 * was never the problem — Production and the committed database both carry
 * all 244 hBP09 rows — but nothing PINNED that, so "is hBP09 ready?" was a
 * production incident question instead of a test failure.
 *
 * This suite pins the deterministic half of hBP09 recognition against the
 * REAL handler and the COMMITTED catalog (vision itself is stubbed; its
 * availability is the deploy smoke's job, see
 * scripts/ci/verify-recognition-availability.mjs):
 *
 *   1. catalog readiness — every number hBP09-001…hBP09-111 is present;
 *   2. ranking exactness — for EVERY distinct hBP09 number, an exact vision
 *      transcription ranks that card first with `cardNumber exact`;
 *   3. transcription tolerance — official-format variants the model emits
 *      (case, trailing dot, em-dash, dropped `h`, O-for-0) normalise to the
 *      same number;
 *   4. the incident trio end-to-end — hBP09-008 / hBP09-050 / hBP09-111 are
 *      recognised through the real handler when provisioned, and answer the
 *      exact incident 503 payload (status + stable code) when not.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-ts.mjs \
 *        scripts/test-hbp09-recognition-corpus.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import handler, {
  RECOGNITION_UNAVAILABLE_CODE,
  normalizeCardNumber,
  rankCandidates,
} from '../api/recognize-card.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const database = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../public/data/database.json'), 'utf8'),
);
const cards = database.cards;

let passed = 0;
let failed = 0;
function check(label, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

// ── 1. Catalog readiness ──────────────────────────────────────────────────
const rows = Object.values(cards);
const hbp09Rows = rows.filter((c) => String(c.cardNumber || '').startsWith('hBP09'));
const hbp09Numbers = [...new Set(hbp09Rows.map((c) => c.cardNumber))].sort();
const EXPECTED_NUMBERS = Array.from({ length: 111 }, (_, i) => `hBP09-${String(i + 1).padStart(3, '0')}`);

console.log('\nCatalog readiness (the committed database this deploy ships):');
{
  const present = new Set(hbp09Numbers);
  const missing = EXPECTED_NUMBERS.filter((n) => !present.has(n));
  check(
    'every number hBP09-001…hBP09-111 is present',
    missing.length === 0,
    `missing: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '…' : ''}`,
  );
  check(
    `the hBP09 set carries at least one printing per number (${hbp09Rows.length} rows)`,
    hbp09Rows.length >= EXPECTED_NUMBERS.length,
  );
}

// ── 2. Ranking exactness for the WHOLE set ────────────────────────────────
// The scanner's deterministic half: given an exact transcription of the tiny
// bottom-edge number — the model's primary output — the right card must rank
// first for every single hBP09 number, not just the ones a user has already
// reported. One aggregated check per property keeps the log readable at 111
// numbers; failures print the offending numbers.
console.log('\nRanking exactness across all distinct hBP09 numbers:');
{
  const wrongTop = [];
  const notExact = [];
  for (const number of hbp09Numbers) {
    const ranking = rankCandidates(cards, { cardNumberRaw: number });
    const top = ranking.candidates[0];
    if (!top || top.cardNumber !== number) wrongTop.push(number);
    else if (!/cardNumber exact/.test(ranking.reason)) notExact.push(number);
  }
  check(
    `an exact transcription ranks its own card first for all ${hbp09Numbers.length} numbers`,
    wrongTop.length === 0,
    `wrong top candidate for: ${wrongTop.slice(0, 10).join(', ')}${wrongTop.length > 10 ? '…' : ''}`,
  );
  check(
    'every one of those wins as `cardNumber exact`, not a fuzzy rescue',
    notExact.length === 0,
    `non-exact wins for: ${notExact.slice(0, 10).join(', ')}${notExact.length > 10 ? '…' : ''}`,
  );
}

// ── 3. Transcription tolerance ────────────────────────────────────────────
// The shapes the vision model actually emits for a bottom-edge code, from
// prior QA: stray case, a trailing period, unicode dashes, the `h` prefix
// dropped, and O read for 0. All must land on the same normalized number.
console.log('\nTranscription variants normalise to the same number:');
{
  const VARIANTS = {
    'hBP09-008': ['hBP09-008', 'HBP09-008', 'hbp09-008.', 'hBP09—008', 'BP09-008', 'hBPO9-008', ' hBP09-008 '],
    'hBP09-050': ['hBP09-050', 'hbp09–050', 'BP09-050'],
    'hBP09-111': ['hBP09-111', 'hBP09-111.', 'HBP09-111'],
  };
  for (const [number, variants] of Object.entries(VARIANTS)) {
    const want = number.toLowerCase();
    const bad = variants.filter((v) => normalizeCardNumber(v) !== want);
    check(
      `${number}: ${variants.length} official-format variants all normalise to ${want}`,
      bad.length === 0,
      `failed variants: ${bad.map((v) => JSON.stringify(v)).join(', ')}`,
    );
  }
}

// ── 4. The incident trio, end-to-end through the REAL handler ─────────────
// The same three cards Hermes reproduced against Production on 2026-09-24
// with official 400×559 images: hBP09-008 (C), hBP09-050 (RR), hBP09-111 (C).
// Vision is stubbed to the transcription a legible official image yields; the
// full-frame stand-in declares 1000×1400 so the legibility floor passes.
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAA+gAAAV4CAIAAAAAAAAA';
const INCIDENT_TRIO = ['hBP09-008', 'hBP09-050', 'hBP09-111'];

let geminiReply = 'CARD_NUMBER: NONE';
let geminiCalls = 0;
globalThis.fetch = async (url) => {
  const href = String(url);
  if (href.includes('generativelanguage.googleapis.com')) {
    geminiCalls++;
    return Response.json({ candidates: [{ content: { parts: [{ text: geminiReply }] } }] });
  }
  if (href.includes('database.json')) return Response.json(database);
  throw new Error(`unexpected fetch: ${href}`);
};

const post = () =>
  handler(
    new Request('https://holohunter.dicoge.com/api/recognize-card', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: PIXEL }),
    }),
  );

const savedKey = process.env.GEMINI_API_KEY;
const savedOpenRouterKey = process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_API_KEY;

console.log('\nThe incident trio is recognised end-to-end when provisioned:');
process.env.GEMINI_API_KEY = 'test-key';
for (const number of INCIDENT_TRIO) {
  const printings = hbp09Rows.filter((c) => c.cardNumber === number);
  const row = printings[0];
  assert.ok(row, `${number} missing from the committed database`);
  geminiReply = [
    `CARD_NUMBER: ${number}`,
    `CHARACTER: ${row.name}`,
    `RARITY: ${row.rarity}`,
  ].join('\n');
  const res = await post();
  const body = await res.json();
  check(
    `${number} (${row.name}) is recognised: the top candidate is the scanned number`,
    res.status === 200 && body.candidates?.[0]?.cardNumber === number,
    `status=${res.status} top=${body.candidates?.[0]?.cardNumber} code=${body.code}`,
  );
  check(
    `${number} is never answered with the incident 503 while provisioned`,
    body.code !== RECOGNITION_UNAVAILABLE_CODE,
  );
}
check('vision was exercised for the provisioned trio', geminiCalls === INCIDENT_TRIO.length);

console.log('\nThe incident trio answers the EXACT incident payload when unprovisioned:');
delete process.env.GEMINI_API_KEY;
{
  geminiCalls = 0;
  geminiReply = 'CARD_NUMBER: hBP09-008';
  const res = await post();
  const body = await res.json();
  check('an unprovisioned deployment answers 503', res.status === 503);
  check(
    'with the stable RECOGNITION_UNAVAILABLE code (what the deploy smoke fails closed on)',
    body.success === false && body.code === RECOGNITION_UNAVAILABLE_CODE,
  );
  check('and never spends a vision call while unprovisioned', geminiCalls === 0);
}

if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
else process.env.GEMINI_API_KEY = savedKey;
if (savedOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
else process.env.OPENROUTER_API_KEY = savedOpenRouterKey;

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ DIC-P0 hBP09 recognition corpus: ${passed} checks passed`);
} else {
  console.error(`\n❌ DIC-P0 hBP09 recognition corpus FAILED (${failed} of ${passed + failed} checks)`);
}
