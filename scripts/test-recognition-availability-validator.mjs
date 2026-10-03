#!/usr/bin/env node
/**
 * DIC-P0 hBP09 — BEHAVIOURAL tests for the recognition availability validator.
 *
 * The companion suite `test-exact-sha-production-recovery.mjs` asserts the
 * SHAPE of the deploy workflow's recognition smoke: which endpoint it probes,
 * where the probe body comes from, how the exit codes are branched on. Those
 * are string checks over YAML and cannot see behaviour, so this file executes
 * the REAL production module — `scripts/ci/verify-recognition-availability.mjs`,
 * the same file the workflow invokes — two ways:
 *
 *   * by import, to assert the decision and its message; and
 *   * by subprocess, to assert the process EXIT CODE the workflow branches on.
 *
 * And, because the module's whole value is its agreement with the live
 * handler, the decisive fixtures are not hand-written: the REAL
 * api/recognize-card.ts handler is run against the module's own probe body,
 * unprovisioned and provisioned, and the module must classify the handler's
 * REAL answers. That includes the probe's zero-cost property — a provisioned
 * handler must answer the probe without one vision call leaving the process.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-ts.mjs \
 *        scripts/test-recognition-availability-validator.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RECOGNITION_AVAILABLE,
  RECOGNITION_FATAL,
  RECOGNITION_RETRY,
  RECOGNITION_PROBE_BODY,
  RECOGNITION_PROBE_IMAGE,
  RECOGNITION_PROBE_MESSAGES,
  RECOGNITION_PROBE_404_ERROR,
  RECOGNITION_PROBE_404_KEYS,
  RECOGNITION_UNAVAILABLE_CODE as MODULE_CODE,
  evaluateRecognitionAvailability,
} from './ci/verify-recognition-availability.mjs';

import handler, {
  RECOGNITION_UNAVAILABLE_CODE as SERVER_CODE,
  imageLongestEdge,
  isBelowLegibleResolution,
} from '../api/recognize-card.ts';
import {
  RECOGNITION_UNAVAILABLE_CODE as CLIENT_CODE,
} from '../src/services/recognitionOutcome.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HELPER = path.join(ROOT, 'scripts', 'ci', 'verify-recognition-availability.mjs');

let passed = 0;
function check(label, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

/** Run the production helper as the workflow does, and return its exit code. */
function runHelper(statusText, raw) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recognition-probe-'));
  const file = path.join(dir, 'recognition-probe.json');
  try {
    if (raw !== null) fs.writeFileSync(file, raw);
    const r = spawnSync(process.execPath, [HELPER, statusText, file], { encoding: 'utf8' });
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const decide = (statusText, raw) => evaluateRecognitionAvailability({ statusText, raw });

// ─────────────────────────────────────────────────────────────────────────
// One code, three owners: the module, the edge handler, and the client
// classifier must agree byte-for-byte, or the smoke grades a different
// contract than the one users experience.
// ─────────────────────────────────────────────────────────────────────────
console.log('\nThe stable code is shared by module, server and client:');
check('module and server agree on RECOGNITION_UNAVAILABLE', MODULE_CODE === SERVER_CODE);
check('module and client agree on RECOGNITION_UNAVAILABLE', MODULE_CODE === CLIENT_CODE);

// The probe answer is matched by exact error string, so it must still be the
// resolution-floor 404 arm of the real handler source, byte-for-byte, and that
// arm must still return BEFORE the vision call — otherwise the probe could
// reach a vision-path answer and the "no 200 is proof" rule would be wrong.
{
  const handlerSource = fs.readFileSync(path.join(ROOT, 'api', 'recognize-card.ts'), 'utf8');
  const at = handlerSource.indexOf(`error: '${RECOGNITION_PROBE_404_ERROR}'`);
  const arm = at >= 0 ? handlerSource.slice(at, handlerSource.indexOf('404)', at) + 4) : '';
  check(
    `the handler still answers the resolution-floor 404 "${RECOGNITION_PROBE_404_ERROR}"`,
    at >= 0 && arm.endsWith('404)') && arm.length < 200,
  );
  const visionAt = handlerSource.indexOf('callVision(images)');
  check(
    'the resolution-floor arm returns before the handler calls vision',
    at >= 0 && visionAt > at,
  );
  check('the probe answer key set is frozen', Object.isFrozen(RECOGNITION_PROBE_404_KEYS));
  check(
    'the only success message is the probe photo answer (CR 065f9384: no 200 can certify the probe)',
    JSON.stringify(Object.keys(RECOGNITION_PROBE_MESSAGES).filter((k) => k.startsWith('AVAILABLE_')))
      === JSON.stringify(['AVAILABLE_PHOTO_ANSWER']),
  );
}

// ─────────────────────────────────────────────────────────────────────────
// The probe body: valid, parseable, and BELOW the legibility floor as judged
// by the REAL handler helpers — that is what makes the probe free.
// ─────────────────────────────────────────────────────────────────────────
console.log('\nThe probe body is pinned against the real handler helpers:');
check(
  'the probe body carries exactly one image',
  Array.isArray(RECOGNITION_PROBE_BODY.images) && RECOGNITION_PROBE_BODY.images.length === 1
    && RECOGNITION_PROBE_BODY.images[0] === RECOGNITION_PROBE_IMAGE,
);
check(
  'the probe image is a PNG data URI',
  RECOGNITION_PROBE_IMAGE.startsWith('data:image/png;base64,'),
);
{
  const edge = imageLongestEdge(RECOGNITION_PROBE_IMAGE);
  check(
    'the REAL imageLongestEdge reads the probe header (no fail-open ambiguity)',
    edge !== null,
    'an unmeasurable probe would fail OPEN into a paid vision call',
  );
  check(
    `the probe's longest edge (${edge}px) sits below the 320px legibility floor`,
    typeof edge === 'number' && edge < 320,
  );
  check(
    'the REAL isBelowLegibleResolution refuses the probe frame',
    isBelowLegibleResolution([RECOGNITION_PROBE_IMAGE]) === true,
  );
}
check(
  '--emit-probe-body prints exactly the frozen probe body',
  (() => {
    const r = spawnSync(process.execPath, [HELPER, '--emit-probe-body'], { encoding: 'utf8' });
    if (r.status !== 0) return false;
    const parsed = JSON.parse(r.stdout);
    return JSON.stringify(parsed) === JSON.stringify(RECOGNITION_PROBE_BODY);
  })(),
);

// ─────────────────────────────────────────────────────────────────────────
// THE DECISIVE FIXTURES: the real handler's own answers to the probe.
// ─────────────────────────────────────────────────────────────────────────
const database = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../public/data/database.json'), 'utf8'),
);
let geminiCalls = 0;
globalThis.fetch = async (url) => {
  const href = String(url);
  if (href.includes('generativelanguage.googleapis.com')) {
    geminiCalls++;
    return Response.json({ candidates: [{ content: { parts: [{ text: 'CARD_NUMBER: NONE' }] } }] });
  }
  if (href.includes('database.json')) return Response.json(database);
  throw new Error(`unexpected fetch: ${href}`);
};

const postProbe = () =>
  handler(
    new Request('https://holohunter.dicoge.com/api/recognize-card', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(RECOGNITION_PROBE_BODY),
    }),
  );

const savedKey = process.env.GEMINI_API_KEY;
const savedOpenRouterKey = process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_API_KEY;

console.log('\nUnprovisioned: the real handler answers the incident 503, the module calls it fatal:');
delete process.env.GEMINI_API_KEY;
{
  const res = await postProbe();
  const raw = await res.text();
  const body = JSON.parse(raw);
  check('the real unprovisioned handler answers the probe with 503', res.status === 503);
  check('…carrying the stable RECOGNITION_UNAVAILABLE code', body.code === MODULE_CODE);
  check('…without spending a vision call', geminiCalls === 0);
  const got = decide(String(res.status), raw);
  check(
    'the module classifies the REAL 503 as fatal (unprovisioned)',
    got.code === RECOGNITION_FATAL && got.reason === 'UNPROVISIONED',
    `got ${JSON.stringify(got)}`,
  );
  const sub = runHelper(String(res.status), raw);
  check('…and reports it through exit code 1 as the workflow reads it', sub.code === RECOGNITION_FATAL);
  check(
    'the fatal diagnostic names the missing provider class, not the payload',
    /provisioned vision provider/.test(sub.stderr) && !sub.stderr.includes('辨識服務'),
    `stderr=${JSON.stringify(sub.stderr.slice(0, 200))}`,
  );
}

console.log('\nProvisioned: the real handler answers about the photo for FREE, the module calls it available:');
process.env.GEMINI_API_KEY = 'test-key';
{
  geminiCalls = 0;
  const res = await postProbe();
  const raw = await res.text();
  const body = JSON.parse(raw);
  check('the real provisioned handler answers the probe with the photo-level 404', res.status === 404);
  check('…a photo answer, not a service code', body.success === false && body.code === undefined);
  check(
    '…the exact resolution-floor answer the module matches on',
    body.error === RECOGNITION_PROBE_404_ERROR
      && Array.isArray(body.candidates) && body.candidates.length === 0,
  );
  check(
    '…carrying exactly the key set the module matches on',
    JSON.stringify(Object.keys(body).sort()) === JSON.stringify(RECOGNITION_PROBE_404_KEYS),
    `keys=${JSON.stringify(Object.keys(body).sort())}`,
  );
  check(
    'ZERO vision calls left the process (the probe is free when provisioned)',
    geminiCalls === 0,
    `gemini was called ${geminiCalls} time(s)`,
  );
  const got = decide(String(res.status), raw);
  check(
    'the module classifies the REAL 404 as available',
    got.code === RECOGNITION_AVAILABLE && got.reason === 'AVAILABLE_PHOTO_ANSWER',
    `got ${JSON.stringify(got)}`,
  );
  const sub = runHelper(String(res.status), raw);
  check('…and reports it through exit code 0 as the workflow reads it', sub.code === RECOGNITION_AVAILABLE);
}

if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
else process.env.GEMINI_API_KEY = savedKey;
if (savedOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
else process.env.OPENROUTER_API_KEY = savedOpenRouterKey;

// ─────────────────────────────────────────────────────────────────────────
// Synthetic fixtures — every response class the canonical host can hand back.
// ─────────────────────────────────────────────────────────────────────────
const CODE_FOR = {
  success: RECOGNITION_AVAILABLE,
  fatal: RECOGNITION_FATAL,
  retry: RECOGNITION_RETRY,
};

const FIXTURES = [
  {
    name: 'handler 404 photo answer (resolution floor)',
    status: '404',
    raw: JSON.stringify({ success: false, error: '照片解析度太低，無法讀取卡號，請靠近卡片重新拍攝', candidates: [] }),
    expect: 'success',
  },
  {
    name: 'CR 065f9384: the handler no-match 404 only follows a vision run the probe never reaches',
    status: '404',
    raw: JSON.stringify({ success: false, error: '無法辨識此卡牌', candidates: [] }),
    expect: 'retry',
  },
  {
    name: 'the floor answer with an extra key is not the exact handler answer',
    status: '404',
    raw: JSON.stringify({
      success: false, error: '照片解析度太低，無法讀取卡號，請靠近卡片重新拍攝', candidates: [], cached: true,
    }),
    expect: 'retry',
  },
  {
    name: 'the floor answer carrying a code is not the exact handler answer',
    status: '404',
    raw: JSON.stringify({
      success: false, code: 'X', error: '照片解析度太低，無法讀取卡號，請靠近卡片重新拍攝', candidates: [],
    }),
    expect: 'retry',
  },
  {
    name: 'platform 404 (HTML, function missing) proves nothing',
    status: '404',
    raw: '<!doctype html><h1>404</h1>',
    expect: 'retry',
  },
  {
    name: 'a 404 whose body is a JSON array is not a handler answer',
    status: '404',
    raw: JSON.stringify([{ success: false }]),
    expect: 'retry',
  },
  {
    name: 'a JSON 404 without success:false is not a handler photo answer',
    status: '404',
    raw: JSON.stringify({ error: 'NOT_FOUND' }),
    expect: 'retry',
  },
  {
    name: 'CR 2195bb74: a JSON 404 {success:false,error:NOT_FOUND} is not a handler photo answer',
    status: '404',
    raw: JSON.stringify({ success: false, error: 'NOT_FOUND' }),
    expect: 'retry',
  },
  {
    name: 'a success:false 404 with candidates but an unknown error is not a handler photo answer',
    status: '404',
    raw: JSON.stringify({ success: false, error: 'NOT_FOUND', candidates: [] }),
    expect: 'retry',
  },
  {
    name: 'the handler error string without a candidates array is not the handler shape',
    status: '404',
    raw: JSON.stringify({ success: false, error: '照片解析度太低，無法讀取卡號，請靠近卡片重新拍攝' }),
    expect: 'retry',
  },
  {
    name: 'the handler error string with non-empty candidates is not the handler shape',
    status: '404',
    raw: JSON.stringify({ success: false, error: '無法辨識此卡牌', candidates: [{ cardNumber: 'hBP09-001' }] }),
    expect: 'retry',
  },
  {
    name: 'the handler error string with success:true is not the handler shape',
    status: '404',
    raw: JSON.stringify({ success: true, error: '無法辨識此卡牌', candidates: [] }),
    expect: 'retry',
  },
  {
    name: 'CR 065f9384: a 200 {success:true,card:{},candidates:[null]} is impossible for the probe',
    status: '200',
    raw: JSON.stringify({ success: true, card: {}, candidates: [null] }),
    expect: 'retry',
  },
  {
    name: 'CR 065f9384: a 200 {success:false,lowConfidence:true,candidates:[null]} is impossible for the probe',
    status: '200',
    raw: JSON.stringify({ success: false, lowConfidence: true, candidates: [null] }),
    expect: 'retry',
  },
  {
    name: 'a fully vision-shaped 200 low-confidence answer is still not proof for the probe',
    status: '200',
    raw: JSON.stringify({
      success: false, lowConfidence: true, error: '辨識信心不足，請從候選卡中選擇',
      candidates: [{ cardNumber: 'hBP09-001', confidence: 0.4 }], confidence: 0.4,
    }),
    expect: 'retry',
  },
  {
    name: 'a fully vision-shaped 200 accepted answer is still not proof for the probe',
    status: '200',
    raw: JSON.stringify({
      success: true, card: { cardNumber: 'hBP09-001' },
      candidates: [{ cardNumber: 'hBP09-001', confidence: 0.9 }], confidence: 0.9,
    }),
    expect: 'retry',
  },
  {
    name: 'a 200 carrying the exact floor answer body is still not proof (wrong status)',
    status: '200',
    raw: JSON.stringify({ success: false, error: '照片解析度太低，無法讀取卡號，請靠近卡片重新拍攝', candidates: [] }),
    expect: 'retry',
  },
  {
    name: 'a 200 that is not JSON proves nothing',
    status: '200',
    raw: 'OK',
    expect: 'retry',
  },
  {
    name: 'CR 2195bb74: a JSON 200 {error:STALE_CACHE} is not a handler vision answer',
    status: '200',
    raw: JSON.stringify({ error: 'STALE_CACHE' }),
    expect: 'retry',
  },
  {
    name: 'a JSON 200 health page {status:ok} is not a handler vision answer',
    status: '200',
    raw: JSON.stringify({ status: 'ok' }),
    expect: 'retry',
  },
  { name: 'an empty JSON 200 object is not a handler vision answer', status: '200', raw: '{}', expect: 'retry' },
  {
    name: 'a 200 success:true without a card object is not the handler shape',
    status: '200',
    raw: JSON.stringify({ success: true, card: null, candidates: [{ cardNumber: 'hBP09-001' }] }),
    expect: 'retry',
  },
  {
    name: 'a 200 success:true with zero candidates is not the handler shape',
    status: '200',
    raw: JSON.stringify({ success: true, card: { cardNumber: 'hBP09-001' }, candidates: [] }),
    expect: 'retry',
  },
  {
    name: 'a 200 success:false without lowConfidence:true is not the handler shape',
    status: '200',
    raw: JSON.stringify({ success: false, candidates: [{ cardNumber: 'hBP09-001' }] }),
    expect: 'retry',
  },
  {
    name: 'a 200 low-confidence answer with zero candidates is not the handler shape',
    status: '200',
    raw: JSON.stringify({ success: false, lowConfidence: true, candidates: [] }),
    expect: 'retry',
  },
  {
    name: 'THE INCIDENT: 503 with the stable code',
    status: '503',
    raw: JSON.stringify({ success: false, code: MODULE_CODE, error: '辨識服務暫時無法使用，請稍後再試或改用手動搜尋' }),
    expect: 'fatal',
  },
  {
    name: 'the stable code is authoritative on ANY status (proxy rewrote 503→200)',
    status: '200',
    raw: JSON.stringify({ success: false, code: MODULE_CODE }),
    expect: 'fatal',
  },
  {
    name: 'platform 503 without the stable code (cold start) retries',
    status: '503',
    raw: JSON.stringify({ error: 'FUNCTION_COLD_START' }),
    expect: 'retry',
  },
  {
    name: 'non-JSON 503 retries',
    status: '503',
    raw: 'Service Unavailable',
    expect: 'retry',
  },
  {
    name: 'a 502 (provider trouble is not the unprovisioned class) retries',
    status: '502',
    raw: JSON.stringify({ success: false, error: 'gemini API error (500)' }),
    expect: 'retry',
  },
  { name: 'connection failure (curl 000)', status: '000', raw: '', expect: 'retry' },
  { name: '429 rate limiting retries', status: '429', raw: '', expect: 'retry' },
  { name: 'a redirect proves nothing', status: '308', raw: '', expect: 'retry' },
  {
    name: 'a 400 means the probe contract itself broke',
    status: '400',
    raw: JSON.stringify({ success: false, error: 'Invalid image' }),
    expect: 'fatal',
  },
  {
    name: 'a 405 means the probe contract itself broke',
    status: '405',
    raw: JSON.stringify({ success: false, error: 'Method not allowed' }),
    expect: 'fatal',
  },
  { name: 'a non-numeric status is unusable', status: 'abc', raw: '', expect: 'fatal' },
  { name: 'a two-digit status is unusable', status: '40', raw: '', expect: 'fatal' },
];

console.log('\nSynthetic fixtures — in-process decisions:');
for (const f of FIXTURES) {
  const got = decide(f.status, f.raw);
  check(
    `${f.name} → ${f.expect}`,
    got.status === f.expect && got.code === CODE_FOR[f.expect],
    `got status=${got.status} code=${got.code}: ${got.message}`,
  );
}

console.log('\nSynthetic fixtures — process exit codes (as the workflow reads them):');
for (const f of FIXTURES) {
  const r = runHelper(f.status, f.raw);
  check(
    `${f.name} → exit ${CODE_FOR[f.expect]}`,
    r.code === CODE_FOR[f.expect],
    `got exit ${r.code}; stderr=${r.stderr.trim().slice(0, 200)}`,
  );
}

console.log('\nDegenerate invocations fail closed or stay in the bounded lane:');
{
  const r = spawnSync(process.execPath, [HELPER], { encoding: 'utf8' });
  check('no arguments is fatal', r.status === RECOGNITION_FATAL, `got exit ${r.status}`);
}
{
  const r = spawnSync(process.execPath, [HELPER, '503'], { encoding: 'utf8' });
  check('a status without a body path is fatal', r.status === RECOGNITION_FATAL, `got exit ${r.status}`);
}
{
  // A connection-level failure often leaves no file behind; the status owns
  // the decision and 503-without-a-body must stay retryable, never a false
  // "unprovisioned" and never a false "available".
  const r = runHelper('503', null);
  check('an unreadable body file with a bare 503 retries', r.code === RECOGNITION_RETRY, `got exit ${r.code}`);
  const ok = runHelper('404', null);
  check('an unreadable body file can never be read as available', ok.code === RECOGNITION_RETRY, `got exit ${ok.code}`);
}

// ─────────────────────────────────────────────────────────────────────────
// Exit codes stay mutually distinguishable.
// ─────────────────────────────────────────────────────────────────────────
console.log('\nExit codes are unambiguous:');
check(
  'success / retry / fatal are three distinct codes',
  new Set([RECOGNITION_AVAILABLE, RECOGNITION_RETRY, RECOGNITION_FATAL]).size === 3,
);
check('success is exit 0', RECOGNITION_AVAILABLE === 0);
check('fatal is exit 1', RECOGNITION_FATAL === 1);
check('retryable is exit 2, never 0 and never 1', RECOGNITION_RETRY === 2);

// ─────────────────────────────────────────────────────────────────────────
// Diagnostics: fixed table, no payload byte reaches the log.
// ─────────────────────────────────────────────────────────────────────────
const ESC = '';
const ATTACK_MARKERS = ['INJECTED', 'SHOULD_NEVER_BE_LOGGED'];
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[ ---]/;

function attackerBytesIn(text) {
  const hits = [];
  for (const m of ATTACK_MARKERS) {
    if (text.includes(m)) hits.push(`marker:${m}`);
  }
  if (CONTROL_CHARS.test(text)) hits.push('control-characters');
  return hits;
}

const ATTACKS = [
  {
    name: 'ANSI + forged workflow command inside a fatal 503 body',
    status: '503',
    raw: JSON.stringify({ code: MODULE_CODE, error: `${ESC}[2J::error::INJECTED` }),
    expect: 'fatal',
  },
  {
    name: 'markers inside an extra key of an otherwise success-shaped 404 body',
    status: '404',
    raw: JSON.stringify({
      success: false,
      error: '照片解析度太低，無法讀取卡號，請靠近卡片重新拍攝',
      candidates: [],
      debug: '::warning::INJECTED',
    }),
    expect: 'retry',
  },
  {
    name: 'markers inside a vision-shaped 200 body',
    status: '200',
    raw: JSON.stringify({
      success: true, card: { name: `${ESC}[31m::error::INJECTED` }, candidates: [{ note: 'INJECTED' }],
    }),
    expect: 'retry',
  },
  {
    name: 'malformed JSON whose parse error quotes the fragment',
    status: '503',
    raw: '::error::INJECTED_PARSE_FRAGMENT',
    expect: 'retry',
  },
  {
    name: 'a secret-shaped value in a retryable platform body',
    status: '502',
    raw: JSON.stringify({ error: 'token sk_live_SHOULD_NEVER_BE_LOGGED' }),
    expect: 'retry',
  },
];

const FIXED_MESSAGES = new Set(Object.values(RECOGNITION_PROBE_MESSAGES));

console.log('\nAdversarial fixtures — decisions unchanged, no attacker byte in the log:');
for (const a of ATTACKS) {
  const got = decide(a.status, a.raw);
  check(
    `${a.name} → ${a.expect}`,
    got.status === a.expect && got.code === CODE_FOR[a.expect],
    `got status=${got.status} code=${got.code}`,
  );
  check(
    `${a.name} → message is a fixed table entry`,
    FIXED_MESSAGES.has(got.message),
    `message was ${JSON.stringify(got.message)}`,
  );
  const r = runHelper(a.status, a.raw);
  const combined = r.stdout + r.stderr;
  const leaks = attackerBytesIn(combined);
  check(
    `${a.name} → nothing attacker-controlled reaches stdout/stderr`,
    leaks.length === 0,
    `leaked: ${leaks.join(', ')} in ${JSON.stringify(combined.slice(0, 200))}`,
  );
}

console.log('\nThe fixed message table:');
for (const [key, message] of Object.entries(RECOGNITION_PROBE_MESSAGES)) {
  check(
    `message ${key} is a bounded, single-line, marker-free constant`,
    !message.includes('::') && !message.includes('\n') && message.length <= 240
      && !CONTROL_CHARS.test(message),
    `message was ${JSON.stringify(message)}`,
  );
}
check('the message table is frozen', Object.isFrozen(RECOGNITION_PROBE_MESSAGES));
check('the probe body is frozen', Object.isFrozen(RECOGNITION_PROBE_BODY));

// ─────────────────────────────────────────────────────────────────────────
// MUTATION PROOF: the plausible wrong decisions must be caught by fixtures.
// ─────────────────────────────────────────────────────────────────────────
// WRONG FIX 1: "any 404 means provisioned" — a platform 404 for a missing
// function would then read as a healthy scanner.
const platform404 = FIXTURES.find((f) => f.name.startsWith('platform 404'));
check(
  'MUTATION: a status-only 404 rule is caught (platform 404 fixture decides retry, not success)',
  platform404 !== undefined && decide(platform404.status, platform404.raw).code === RECOGNITION_RETRY,
);
// WRONG FIX 2: "every 503 is fatal" — a cold-start platform 503 would then
// abort a healthy deploy instead of retrying inside the bounded window.
const platform503 = FIXTURES.find((f) => f.name.startsWith('platform 503'));
check(
  'MUTATION: a status-only 503 rule is caught (code-less 503 fixture decides retry, not fatal)',
  platform503 !== undefined && decide(platform503.status, platform503.raw).code === RECOGNITION_RETRY,
);
// WRONG FIX 3: "trust the status over the stable code" — a proxy rewriting
// 503→200 would hide the incident class this gate exists for.
check(
  'MUTATION: a status-first rule is caught (stable code on a 200 stays fatal)',
  decide('200', JSON.stringify({ success: false, code: MODULE_CODE })).code === RECOGNITION_FATAL,
);
// WRONG FIX 4 (the CR 2195bb74 false PASS): "any JSON 404 with success:false
// is a photo answer" — any layer's JSON NOT_FOUND would then read as a
// provisioned scanner.
check(
  'MUTATION: a success:false-only 404 rule is caught (JSON NOT_FOUND decides retry, not success)',
  decide('404', JSON.stringify({ success: false, error: 'NOT_FOUND' })).code === RECOGNITION_RETRY,
);
// WRONG FIX 5 (the CR 2195bb74 false PASS): "any JSON 200 means the vision
// path ran" — a stale cached body would then read as a provisioned scanner.
check(
  'MUTATION: an any-JSON-200 rule is caught (STALE_CACHE decides retry, not success)',
  decide('200', JSON.stringify({ error: 'STALE_CACHE' })).code === RECOGNITION_RETRY,
);
// WRONG FIX 6 (the CR 065f9384 false PASS): "a vision-shaped 200 means the
// vision path ran" — the handler cannot answer the fixed sub-floor probe with
// a 200 at all, so any 200 that looks like one came from somewhere else.
check(
  'MUTATION: a vision-shaped-200 rule is caught (success:true,card:{},candidates:[null] decides retry)',
  decide('200', JSON.stringify({ success: true, card: {}, candidates: [null] })).code === RECOGNITION_RETRY,
);
check(
  'MUTATION: a low-confidence-200 rule is caught (lowConfidence,candidates:[null] decides retry)',
  decide('200', JSON.stringify({ success: false, lowConfidence: true, candidates: [null] })).code
    === RECOGNITION_RETRY,
);
// WRONG FIX 7: "the no-match 404 is also a photo answer" — it only follows a
// vision run the probe never reaches, so for the probe it is not this handler.
check(
  'MUTATION: a no-match-404 rule is caught (無法辨識此卡牌 decides retry)',
  decide('404', JSON.stringify({ success: false, error: '無法辨識此卡牌', candidates: [] })).code
    === RECOGNITION_RETRY,
);
// WRONG FIX 8: "right fields, ignore extras" — any layer wrapping the floor
// answer would then certify Production.
check(
  'MUTATION: an extra-keys-tolerated rule is caught (floor answer + extra key decides retry)',
  decide('404', JSON.stringify({
    success: false, error: RECOGNITION_PROBE_404_ERROR, candidates: [], raw: 'x',
  })).code === RECOGNITION_RETRY,
);

assert.equal(typeof evaluateRecognitionAvailability, 'function');

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ DIC-P0 recognition availability validator behaviour: ${passed} checks passed`);
} else {
  console.error('\n❌ DIC-P0 recognition availability validator behaviour FAILED');
}
