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
  isRecognitionInfrastructureFailure,
  RECOGNITION_UNAVAILABLE_MESSAGE,
  RECOGNITION_UNAVAILABLE_CODE as CLIENT_CODE,
} from '../src/services/recognitionOutcome.ts';
import {
  runWebCameraScan,
  runNativeCameraScan,
  NO_TEXT_GUIDANCE,
} from '../src/services/scanRecognitionFlow.ts';

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

// ── 5. The REAL camera flows, fed by the REAL handler ─────────────────────────
// These are the functions ScanScreen's web and native camera branches call. The
// CR blocker was that the UI dropped the status, showed retake guidance and
// returned before local OCR, so all three are pinned here on production code.

const PHOTO = 'file:///tmp/scan.jpg';

function recorder() {
  const calls = { scanError: [], searchError: [], recognized: [], visionRecognized: [], candidates: [], status: [] };
  const ui = {
    setStatus: (label) => calls.status.push(label),
    setBusy: () => {},
    setScanError: (m) => calls.scanError.push(m),
    setSearchError: (m) => calls.searchError.push(m),
    setSearchResults: () => {},
    setSuggestions: () => {},
    setRecognizedText: () => {},
    setCandidateReason: () => {},
    showLowConfidenceCandidates: (c) => calls.candidates.push(c),
    onRecognized: (card) => calls.recognized.push(card),
    onVisionRecognized: (card) => calls.visionRecognized.push(card),
  };
  return { calls, ui };
}

const CARD = { id: 'x', name: 'ラプラス・ダークネス', cardNumber: 'hBP04-005' };

function io(overrides = {}) {
  const spy = { ocrCalls: 0, visionCalls: 0 };
  return {
    spy,
    io: {
      callRecognitionApi: async () => {
        throw new Error('callRecognitionApi not stubbed');
      },
      recognizeFromImage: async () => {
        spy.visionCalls++;
        return { success: false };
      },
      ocrText: async () => {
        spy.ocrCalls++;
        return '';
      },
      recognizeFromOcr: async () => ({ success: false, error: '找不到匹配的卡牌' }),
      searchCards: async () => [],
      mapApiCard: (c) => c,
      mapApiCandidates: (raw) =>
        Array.isArray(raw) && raw.length ? raw.map((c) => ({ card: c, confidence: 0 })) : undefined,
      ...overrides,
    },
  };
}

// The photo-blaming fragments the user must never see for a platform outage.
const BLAME_FRAGMENTS = ['調整角度', '光線', '請靠近卡號', '避免反光', '保持卡片平整'];
const assertNoBlame = (messages) => {
  for (const m of messages) {
    for (const fragment of BLAME_FRAGMENTS) {
      assert.ok(!m.includes(fragment), `photo-blaming copy leaked: ${m}`);
    }
  }
};

// 5a. Web camera + the real unprovisioned handler.
delete process.env.GEMINI_API_KEY;
{
  const { calls, ui } = recorder();
  const { spy, io: deps } = io({
    callRecognitionApi: async () => {
      const res = await post({ image: PIXEL });
      return { status: res.status, body: await res.json() };
    },
  });
  await runWebCameraScan(PHOTO, deps, ui);

  check('web camera: a 503 from the real handler still runs the local OCR fallback', () => {
    assert.equal(spy.visionCalls, 1, 'local vision fallback must run');
    assert.equal(spy.ocrCalls, 1, 'local OCR must not be skipped');
  });
  check('web camera: an unavailable backend never blames the photo', () => {
    assertNoBlame(calls.scanError);
  });
  check('web camera: the user is told the service is unavailable', () => {
    assert.deepEqual(calls.scanError, [RECOGNITION_UNAVAILABLE_MESSAGE]);
    assert.notEqual(calls.scanError[0], NO_TEXT_GUIDANCE);
  });
}

// 5b. Same outage, but the local OCR fallback actually finds the card.
{
  const { calls, ui } = recorder();
  const { spy, io: deps } = io({
    callRecognitionApi: async () => {
      const res = await post({ image: PIXEL });
      return { status: res.status, body: await res.json() };
    },
    ocrText: async () => 'hBP04-005',
    recognizeFromOcr: async () => ({ success: true, card: CARD, confidence: 0.9 }),
  });
  await runWebCameraScan(PHOTO, deps, ui);

  check('web camera: the OCR fallback can still recognise while the backend is down', () => {
    assert.deepEqual(calls.recognized, [CARD]);
    assert.deepEqual(calls.scanError, []);
    assert.equal(spy.visionCalls, 1);
  });
}

// 5c. Status must carry the decision even when a proxy strips the body code.
{
  const { calls, ui } = recorder();
  const { spy, io: deps } = io({
    callRecognitionApi: async () => ({ status: 503, body: { success: false, error: 'Service Unavailable' } }),
  });
  await runWebCameraScan(PHOTO, deps, ui);

  check('web camera: a bare 503 (code stripped) is still an outage, not a bad photo', () => {
    assert.equal(spy.ocrCalls, 1, 'dropping the HTTP status would skip OCR here');
    assert.deepEqual(calls.scanError, [RECOGNITION_UNAVAILABLE_MESSAGE]);
  });
}

// 5d. A photo the backend genuinely could not place must stay on the user-facing
//     path — an outage and an unrecognisable photo are not the same event.
process.env.GEMINI_API_KEY = 'test-key';
geminiStatus = 200;
geminiReply = 'CARD_NUMBER: hZZ99-999\nCHARACTER: 不存在\nRARITY: C';
{
  const { calls, ui } = recorder();
  const { spy, io: deps } = io({
    callRecognitionApi: async () => {
      const res = await post({ image: PIXEL });
      return { status: res.status, body: await res.json() };
    },
  });
  // The ranker always emits a top-5, so a card it cannot place surfaces as
  // 200 + lowConfidence rather than the handler's 404 arm.
  const unmatched = await post({ image: PIXEL });
  const unmatchedBody = await unmatched.json();
  check('the real handler hands back a candidate list for a card it cannot place', () => {
    assert.equal(unmatched.status, 200);
    assert.equal(unmatchedBody.success, false);
    assert.ok(unmatchedBody.candidates.length > 0);
    assert.equal(isRecognitionInfrastructureFailure(unmatched.status, unmatchedBody), false);
  });

  await runWebCameraScan(PHOTO, deps, ui);
  check('web camera: an unplaced card opens the candidate picker, not an outage notice', () => {
    assert.equal(calls.candidates.length, 1);
    assert.deepEqual(calls.scanError, []);
    assert.equal(spy.ocrCalls, 0, 'the backend answered about this photo; OCR must not re-run');
  });
}
geminiReply = 'CARD_NUMBER: hBP04-005\nCHARACTER: ラプラス・ダークネス\nRARITY: SEC';

// 5d2. And when the backend answers about the photo with no candidates at all,
//      the retake guidance is still the right advice.
{
  const { calls, ui } = recorder();
  const { spy, io: deps } = io({
    callRecognitionApi: async () => ({ status: 404, body: { success: false, error: '無法辨識此卡牌', candidates: [] } }),
  });
  await runWebCameraScan(PHOTO, deps, ui);

  check('web camera: an unmatched card still gets the retake guidance (contract preserved)', () => {
    assert.equal(calls.scanError.length, 1);
    assert.ok(calls.scanError[0].includes('請靠近卡號'), calls.scanError[0]);
    assert.equal(spy.ocrCalls, 0, 'the matched-nothing path must not change');
  });
}

// 5g. The real handler's upstream-502 is infrastructure, not a bad photo.
geminiStatus = 500;
{
  const { calls, ui } = recorder();
  const { spy, io: deps } = io({
    callRecognitionApi: async () => {
      const res = await post({ image: PIXEL });
      return { status: res.status, body: await res.json() };
    },
  });
  const outage = await post({ image: PIXEL });
  check('the real handler answers 502 when the vision upstream is down', () => {
    assert.equal(outage.status, 502);
    assert.equal(isRecognitionUnavailable(outage.status, null), false, '502 is not the 503 code');
    assert.equal(isRecognitionInfrastructureFailure(outage.status, null), true);
  });

  await runWebCameraScan(PHOTO, deps, ui);
  check('web camera: a real upstream 502 still runs the local OCR fallback', () => {
    assert.equal(spy.visionCalls, 1);
    assert.equal(spy.ocrCalls, 1, 'an infrastructure outage must not skip OCR');
  });
  check('web camera: a real upstream 502 never blames the photo', () => {
    assertNoBlame(calls.scanError);
    assert.deepEqual(calls.scanError, [RECOGNITION_UNAVAILABLE_MESSAGE]);
  });
}
geminiStatus = 200;

// 5h. The infrastructure predicate draws the line where the handler does.
check('every 5xx is infrastructure; 404/400 stay the caller-visible outcome', () => {
  for (const s of [500, 502, 503, 504]) {
    assert.equal(isRecognitionInfrastructureFailure(s, null), true, `${s} must be infrastructure`);
  }
  for (const s of [200, 400, 404]) {
    assert.equal(isRecognitionInfrastructureFailure(s, null), false, `${s} must not be infrastructure`);
  }
  // The 503-specific meaning survives: only 503 / the explicit code is "unprovisioned".
  assert.equal(isRecognitionUnavailable(502, null), false);
  assert.equal(isRecognitionUnavailable(503, null), true);
  assert.equal(isRecognitionInfrastructureFailure(200, { code: RECOGNITION_UNAVAILABLE_CODE }), true);
});

// 5e. Native camera carries serviceUnavailable into the final outcome.
{
  const { calls, ui } = recorder();
  const { spy, io: deps } = io({
    recognizeFromImage: async () => ({
      success: false,
      serviceUnavailable: true,
      error: RECOGNITION_UNAVAILABLE_MESSAGE,
    }),
  });
  await runNativeCameraScan(PHOTO, deps, ui);

  check('native camera: local OCR still runs after the backend reports unavailable', () => {
    assert.equal(spy.ocrCalls, 1);
  });
  check('native camera: the outcome keeps the unavailable notice, not generic photo guidance', () => {
    assert.deepEqual(calls.scanError, [RECOGNITION_UNAVAILABLE_MESSAGE]);
    assertNoBlame(calls.scanError);
  });
}

// 5f. Native camera without an outage keeps the existing generic guidance.
{
  const { calls, ui } = recorder();
  const { io: deps } = io();
  await runNativeCameraScan(PHOTO, deps, ui);

  check('native camera: an ordinary empty-OCR scan keeps the existing guidance', () => {
    assert.deepEqual(calls.scanError, [NO_TEXT_GUIDANCE]);
  });
}

if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
else process.env.GEMINI_API_KEY = savedKey;

for (const label of results) console.log(`  ✓ ${label}`);
console.log(`\n✅ recognition-unavailable: ${results.length} checks passed`);
