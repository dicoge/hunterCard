#!/usr/bin/env node
/**
 * DIC-1019 regression: /api/recognize-card must survive an unprovisioned Google key.
 *
 * DIC-701 (855a34e70) silently swapped the vision provider from OpenRouter to Google
 * direct. No GEMINI_API_KEY was ever provisioned on Vercel and no OpenRouter fallback
 * was retained, so Production answered every scan with 503 RECOGNITION_UNAVAILABLE.
 *
 * These checks drive the REAL edge handler with a stubbed network and assert the
 * provider-selection contract, the exact OpenRouter wire shape, that no key value or
 * upstream body can reach a client, and that ranking output is provider-independent.
 *
 * Run: node --experimental-strip-types scripts/test-recognition-provider-fallback.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import handler, { RECOGNITION_UNAVAILABLE_CODE, VISION_TOTAL_BUDGET_MS } from '../api/recognize-card.ts';
import {
  isRecognitionInfrastructureFailure,
  RECOGNITION_REQUEST_TIMEOUT_MS,
} from '../src/services/recognitionOutcome.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const database = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../public/data/database.json'), 'utf8'),
);

const GOOGLE_HOST = 'generativelanguage.googleapis.com';
const OPENROUTER_HOST = 'openrouter.ai';

const GOOGLE_KEY = 'google-secret-value-must-not-leak';
const OPENROUTER_KEY = 'openrouter-secret-value-must-not-leak';

const REPLY = 'CHARACTER: ラプラス・ダークネス\nHP: NONE\nRARITY: SEC\nBLOOM_LEVEL: NONE\nCARD_NUMBER: hBP04-005\nTITLE: NONE';

// A distinct full-frame image and scan-area crop, exactly as the web scanner sends them.
const FULL_FRAME = 'data:image/jpeg;base64,ZnVsbC1mcmFtZQ==';
const CROP = 'data:image/png;base64,Y3JvcC1hcmVh';

// Upstream failure bodies the handler must never forward to a client.
const UPSTREAM_BODY = 'upstream stack trace: quota project holo-secret-project';

const savedGoogle = process.env.GEMINI_API_KEY;
const savedOpenRouter = process.env.OPENROUTER_API_KEY;

/**
 * An upstream that never answers, exactly like a hung provider: it only settles when
 * the handler's own AbortSignal fires, so the real per-leg timeout is what ends it.
 *
 * The keepalive is required, not decorative: AbortSignal.timeout() arms an unref'd
 * timer, so without a ref'd handle Node would consider the loop idle and exit before
 * the leg ever times out.
 */
const hangUntilAborted = (signal) => new Promise((_resolve, reject) => {
  const keepAlive = setInterval(() => {}, 50);
  const done = () => {
    clearInterval(keepAlive);
    reject(new Error('The operation was aborted'));
  };
  if (signal?.aborted) return done();
  signal?.addEventListener('abort', done);
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Route both provider legs deterministically and record every outgoing request. */
function stubNetwork({
  google = 200, openrouter = 200,
  googleReply = REPLY, openrouterReply = REPLY,
  googleDelay = 0, openrouterDelay = 0,
} = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.includes('database.json')) return Response.json(database);

    const record = { href, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null };

    if (href.includes(GOOGLE_HOST)) {
      calls.push({ provider: 'gemini', at: Date.now(), ...record });
      if (google === 'hang') return hangUntilAborted(init.signal);
      if (googleDelay) await sleep(googleDelay);
      if (google === 'network') throw new Error(`connect ECONNREFUSED ${href}?key=${GOOGLE_KEY}`);
      if (google !== 200) return new Response(UPSTREAM_BODY, { status: google });
      return Response.json({ candidates: [{ content: { parts: [{ text: googleReply }] } }] });
    }
    if (href.includes(OPENROUTER_HOST)) {
      calls.push({ provider: 'openrouter', at: Date.now(), ...record });
      if (openrouter === 'hang') return hangUntilAborted(init.signal);
      if (openrouterDelay) await sleep(openrouterDelay);
      if (openrouter === 'network') throw new Error(`connect ECONNREFUSED ${href} bearer ${OPENROUTER_KEY}`);
      if (openrouter !== 200) return new Response(UPSTREAM_BODY, { status: openrouter });
      return Response.json({ choices: [{ message: { content: openrouterReply } }] });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
  return calls;
}

const post = (body = { images: [FULL_FRAME, CROP] }) =>
  handler(
    new Request('https://holohunter.dicoge.com/api/recognize-card', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

async function scan(env, network) {
  if (env.google) process.env.GEMINI_API_KEY = env.google;
  else delete process.env.GEMINI_API_KEY;
  if (env.openrouter) process.env.OPENROUTER_API_KEY = env.openrouter;
  else delete process.env.OPENROUTER_API_KEY;

  const calls = stubNetwork(network);
  const res = await post();
  const body = await res.json();
  return { res, body, bytes: JSON.stringify(body), calls };
}

const results = [];
const check = (label, fn) => {
  fn();
  results.push(label);
};

// ── 1. Google absent + OpenRouter present → the fallback actually recognises ──
{
  const { res, body, calls } = await scan(
    { openrouter: OPENROUTER_KEY },
    {},
  );
  check('no Google key falls through to OpenRouter instead of 503', () => {
    assert.equal(res.status, 200);
    assert.notEqual(body.code, RECOGNITION_UNAVAILABLE_CODE);
    assert.deepEqual(calls.map(c => c.provider), ['openrouter']);
  });
  check('the OpenRouter leg ranks the scanned card', () => {
    assert.equal(body.debug.normalizedCardNumber, 'hbp04-005');
    assert.equal(body.candidates[0].cardNumber, 'hBP04-005');
    assert.equal(body.debug.provider, 'openrouter');
    assert.equal(body.debug.model, 'google/gemini-2.5-flash');
  });

  const [or] = calls;
  check('OpenRouter is called with the documented chat-completions shape', () => {
    assert.equal(or.href, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(or.headers.Authorization, `Bearer ${OPENROUTER_KEY}`);
    assert.equal(or.body.model, 'google/gemini-2.5-flash');
    assert.equal(or.body.temperature, 0);
    assert.equal(or.body.max_tokens, 180);
    assert.equal(or.body.messages.length, 1);
    assert.equal(or.body.messages[0].role, 'user');
  });
  check('OpenRouter carries the prompt plus BOTH full-frame and crop as data URIs', () => {
    const content = or.body.messages[0].content;
    assert.equal(content[0].type, 'text');
    assert.ok(content[0].text.includes('CARD_NUMBER'), 'the real vision prompt must be sent');
    const images = content.filter(p => p.type === 'image_url').map(p => p.image_url.url);
    assert.deepEqual(images, [FULL_FRAME, CROP], 'losing the crop loses the tiny card number');
    for (const url of images) assert.ok(url.startsWith('data:'), url);
  });
}

// ── 2. Both keys present → Google direct wins, deterministically ──────────────
{
  const { res, body, calls } = await scan(
    { google: GOOGLE_KEY, openrouter: OPENROUTER_KEY },
    {},
  );
  check('both keys present: Google direct is used and OpenRouter is never called', () => {
    assert.equal(res.status, 200);
    assert.deepEqual(calls.map(c => c.provider), ['gemini']);
    assert.equal(body.debug.provider, 'gemini');
    assert.equal(body.debug.model, 'gemini-2.5-flash');
  });
  const [google] = calls;
  check('the Google key travels in a header, never in the request URL', () => {
    assert.ok(!google.href.includes(GOOGLE_KEY), google.href);
    assert.ok(!google.href.includes('key='), 'a ?key= URL leaks the secret into logs');
    assert.equal(google.headers['x-goog-api-key'], GOOGLE_KEY);
  });
  check('the Google leg still sends both images inline', () => {
    const parts = google.body.contents[0].parts;
    assert.equal(parts[0].text.includes('CARD_NUMBER'), true);
    const inline = parts.filter(p => p.inline_data);
    assert.equal(inline.length, 2);
    assert.deepEqual(inline.map(p => p.inline_data.mime_type), ['image/jpeg', 'image/png']);
    assert.deepEqual(inline.map(p => p.inline_data.data), ['ZnVsbC1mcmFtZQ==', 'Y3JvcC1hcmVh']);
  });
}

// ── 3. Google upstream 5xx with OpenRouter available → documented: fall over ───
// Trying the second provider strictly widens availability and changes nothing the
// client can observe: if BOTH legs fail the handler still answers 5xx, so the
// DIC-1013 "5xx → local OCR" contract is preserved (checked in 3b).
{
  const { res, body, calls } = await scan(
    { google: GOOGLE_KEY, openrouter: OPENROUTER_KEY },
    { google: 503 },
  );
  check('a Google upstream 5xx falls over to OpenRouter and still recognises', () => {
    assert.deepEqual(calls.map(c => c.provider), ['gemini', 'openrouter']);
    assert.equal(res.status, 200);
    assert.equal(body.debug.provider, 'openrouter');
    assert.equal(body.candidates[0].cardNumber, 'hBP04-005');
  });
}
{
  const { res, calls } = await scan(
    { google: GOOGLE_KEY, openrouter: OPENROUTER_KEY },
    { google: 'network' },
  );
  check('a Google transport failure also falls over to OpenRouter', () => {
    assert.deepEqual(calls.map(c => c.provider), ['gemini', 'openrouter']);
    assert.equal(res.status, 200);
  });
}
{
  // A rejected key is not a valid key: Google 4xx must reach the fallback too,
  // otherwise a typo'd GEMINI_API_KEY would disable recognition outright.
  const { res, body, calls } = await scan(
    { google: 'not-a-real-key', openrouter: OPENROUTER_KEY },
    { google: 400 },
  );
  check('a Google key the upstream rejects falls over to OpenRouter', () => {
    assert.deepEqual(calls.map(c => c.provider), ['gemini', 'openrouter']);
    assert.equal(res.status, 200);
    assert.equal(body.debug.provider, 'openrouter');
  });
}

// ── 3b. Both providers down → the 5xx → local OCR contract is preserved ───────
{
  const { res, body, calls } = await scan(
    { google: GOOGLE_KEY, openrouter: OPENROUTER_KEY },
    { google: 500, openrouter: 500 },
  );
  check('both providers down still answers 502, not 503', () => {
    assert.deepEqual(calls.map(c => c.provider), ['gemini', 'openrouter']);
    assert.equal(res.status, 502);
    assert.notEqual(body.code, RECOGNITION_UNAVAILABLE_CODE);
  });
  check('both providers down stays an infrastructure failure, so the client runs OCR', () => {
    assert.equal(isRecognitionInfrastructureFailure(res.status, body), true);
  });
}

// ── 4. Neither key → the DIC-1013 503 contract, with no upstream call ─────────
for (const env of [{}, { google: '   ', openrouter: '' }]) {
  const { res, body, bytes, calls } = await scan(env, {});
  const label = Object.keys(env).length ? 'blank' : 'absent';
  check(`${label} provider keys answer 503 RECOGNITION_UNAVAILABLE`, () => {
    assert.equal(res.status, 503);
    assert.equal(body.success, false);
    assert.equal(body.code, RECOGNITION_UNAVAILABLE_CODE);
  });
  check(`${label} provider keys never reach a provider`, () => {
    assert.deepEqual(calls, []);
  });
  check(`${label} provider keys never name an env var over the wire`, () => {
    assert.ok(!/GEMINI_API_KEY|OPENROUTER_API_KEY/.test(bytes), bytes);
  });
}

// ── 5. No secret and no upstream body may cross the wire, on any path ─────────
{
  const cases = [
    ['both upstreams 500', { google: GOOGLE_KEY, openrouter: OPENROUTER_KEY }, { google: 500, openrouter: 500 }],
    ['both upstreams 401', { google: GOOGLE_KEY, openrouter: OPENROUTER_KEY }, { google: 401, openrouter: 401 }],
    ['both transports fail', { google: GOOGLE_KEY, openrouter: OPENROUTER_KEY }, { google: 'network', openrouter: 'network' }],
    ['OpenRouter-only outage', { openrouter: OPENROUTER_KEY }, { openrouter: 500 }],
    ['successful scan', { google: GOOGLE_KEY, openrouter: OPENROUTER_KEY }, {}],
  ];
  for (const [label, env, network] of cases) {
    const { bytes } = await scan(env, network);
    check(`${label}: no provider key value reaches the client`, () => {
      assert.ok(!bytes.includes(GOOGLE_KEY), bytes);
      assert.ok(!bytes.includes(OPENROUTER_KEY), bytes);
      assert.ok(!/GEMINI_API_KEY|OPENROUTER_API_KEY|x-goog-api-key|Bearer/i.test(bytes), bytes);
    });
    check(`${label}: no upstream response body reaches the client`, () => {
      assert.ok(!bytes.includes('holo-secret-project'), bytes);
      assert.ok(!bytes.includes('stack trace'), bytes);
    });
  }
}

// ── 6. Ranking output is identical whichever provider served the reply ────────
{
  const viaGoogle = await scan({ google: GOOGLE_KEY }, {});
  const viaOpenRouter = await scan({ openrouter: OPENROUTER_KEY }, {});
  const strip = (b) => {
    const { debug, ...rest } = b;
    const { provider, model, ...restDebug } = debug;
    return { ...rest, debug: restDebug };
  };
  check('the same model reply ranks identically through either provider', () => {
    assert.equal(viaGoogle.res.status, viaOpenRouter.res.status);
    assert.deepEqual(strip(viaOpenRouter.body), strip(viaGoogle.body));
  });
  check('only the provider/model stamp differs between the two legs', () => {
    assert.deepEqual(
      [viaGoogle.body.debug.provider, viaOpenRouter.body.debug.provider],
      ['gemini', 'openrouter'],
    );
  });
}

// ── 7. An empty provider reply is still the existing empty-response 502 ───────
{
  const { res, body } = await scan({ openrouter: OPENROUTER_KEY }, { openrouterReply: '' });
  check('an empty OpenRouter reply keeps the existing 502 empty-response contract', () => {
    assert.equal(res.status, 502);
    assert.equal(body.success, false);
    assert.equal(body.debug.provider, 'openrouter');
  });
}
{
  const { res, body, calls } = await scan(
    { google: GOOGLE_KEY, openrouter: OPENROUTER_KEY },
    { googleReply: '' },
  );
  check('an empty Google reply retries on OpenRouter before giving up', () => {
    assert.deepEqual(calls.map(c => c.provider), ['gemini', 'openrouter']);
    assert.equal(res.status, 200);
    assert.equal(body.debug.provider, 'openrouter');
  });
}

// ── 8. Store MVP field-strip still holds on the fallback leg (DIC-908) ────────
{
  if (process.env.GEMINI_API_KEY) delete process.env.GEMINI_API_KEY;
  process.env.OPENROUTER_API_KEY = OPENROUTER_KEY;
  stubNetwork({});
  const res = await post({ images: [FULL_FRAME, CROP], storeMvp: true });
  const body = await res.json();
  check('Store MVP fields stay stripped when OpenRouter served the scan', () => {
    for (const candidate of body.candidates) {
      assert.ok(!('buyPrice' in candidate), 'buyPrice must not cross the wire');
      assert.ok(!('priceHistory' in candidate));
      assert.ok(!('ytStats' in candidate));
    }
  });
}

// ── 9. The fallback has to land before the caller's own deadline (DIC-1020 CR) ─
//
// A fallback that only succeeds after ScanScreen has aborted is not a fallback: the
// original head gave each leg 14s and ran them in sequence, so a hung Google plus a
// 2s OpenRouter success answered at ~16.1s against a client that gave up at 15.0s.
{
  check('the whole provider chain is budgeted inside the caller deadline', () => {
    assert.ok(
      VISION_TOTAL_BUDGET_MS < RECOGNITION_REQUEST_TIMEOUT_MS,
      `vision budget ${VISION_TOTAL_BUDGET_MS}ms must fit inside the ${RECOGNITION_REQUEST_TIMEOUT_MS}ms client deadline`,
    );
    // Ranking, the database load and the JSON round trip all happen outside the budget.
    assert.ok(
      RECOGNITION_REQUEST_TIMEOUT_MS - VISION_TOTAL_BUDGET_MS >= 3000,
      'the budget must leave headroom for ranking and the JSON round trip',
    );
  });

  const startedAt = Date.now();
  const { res, body, calls } = await scan(
    { google: GOOGLE_KEY, openrouter: OPENROUTER_KEY },
    { google: 'hang', openrouterDelay: 2000 },
  );
  const elapsed = Date.now() - startedAt;

  check('a hung Google leg times out and OpenRouter still recognises the card', () => {
    assert.deepEqual(calls.map(c => c.provider), ['gemini', 'openrouter']);
    assert.equal(res.status, 200);
    assert.equal(body.debug.provider, 'openrouter');
    assert.equal(body.candidates[0].cardNumber, 'hBP04-005');
  });
  check('that fallback answers well before the 15s client abort', () => {
    assert.ok(
      elapsed < RECOGNITION_REQUEST_TIMEOUT_MS - 2000,
      `fallback took ${elapsed}ms, the client aborts at ${RECOGNITION_REQUEST_TIMEOUT_MS}ms`,
    );
  });
  check('the primary leg is capped so it cannot starve the fallback behind it', () => {
    const handedOverAfter = calls[1].at - calls[0].at;
    assert.ok(
      handedOverAfter < VISION_TOTAL_BUDGET_MS,
      `primary leg held the budget for ${handedOverAfter}ms of ${VISION_TOTAL_BUDGET_MS}ms`,
    );
    assert.ok(handedOverAfter >= 1000, 'the primary leg must actually have been attempted');
  });
}

// A single configured provider is not capped — it may use the whole shared budget.
{
  const startedAt = Date.now();
  const { res, body } = await scan({ openrouter: OPENROUTER_KEY }, { openrouterDelay: 2000 });
  const elapsed = Date.now() - startedAt;
  check('a lone provider keeps answering normally under the shared budget', () => {
    assert.equal(res.status, 200);
    assert.equal(body.debug.provider, 'openrouter');
    assert.ok(elapsed < RECOGNITION_REQUEST_TIMEOUT_MS - 2000, `took ${elapsed}ms`);
  });
}

if (savedGoogle === undefined) delete process.env.GEMINI_API_KEY;
else process.env.GEMINI_API_KEY = savedGoogle;
if (savedOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
else process.env.OPENROUTER_API_KEY = savedOpenRouter;

for (const label of results) console.log(`  ✓ ${label}`);
console.log(`\n✅ recognition-provider-fallback: ${results.length} checks passed`);
