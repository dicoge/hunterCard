#!/usr/bin/env node
/**
 * DIC-1185 FinOps repair regression: nothing in this product may reach openrouter.ai.
 *
 * OpenRouter is a hard denylist. `/api/recognize-card` previously ran a Google → OpenRouter
 * fallback (DIC-1019); the OpenRouter adapter has been removed. This suite is
 * mutation-sensitive by construction:
 *   - a stubbed `fetch` throws the moment openrouter.ai is contacted, so ANY code path
 *     that reintroduces the host — even under an inherited OPENROUTER_API_KEY — fails
 *     loudly instead of silently spending FinOps budget.
 *   - static scans across the runtime source refuse strings like `openrouter.ai`,
 *     `OPENROUTER_API_KEY`, and `openrouter/`, so a reintroduced constant is caught
 *     before it can be wired up.
 *   - an AST semantic guard constant-folds string concatenation, template literals,
 *     and `[...].join()` reconstructions, and inspects computed property/element
 *     accesses. `'open' + 'router.ai'` or `e['OPEN' + 'ROUTER_API_KEY']` is treated
 *     identically to a raw literal (DIC-1190 CR).
 *   - non-recognition scripts (`add-zh-names.js`, `hello.ts`, `translate-effects.js`)
 *     are imported and exercised under a Proxy-wrapped `process.env` that logs
 *     every `OPENROUTER*` access AND a stubbed `fetch` that throws on any
 *     openrouter.ai contact, however the URL is assembled (DIC-1190 CR).
 *   - the recognition handler is exercised across every environment permutation
 *     (Google present, Google absent, OpenRouter-key-only, both keys) and every
 *     failure mode (Google 4xx/5xx/network/hang), and MUST fail closed at 503 the
 *     moment Google is unavailable — never fall over to another host.
 *
 * Do not "fix" this suite by removing checks: the whole point is that a mutation
 * to the code that reintroduces OpenRouter cannot pass here.
 *
 * Run: node --experimental-strip-types scripts/test-recognition-provider-fallback.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

import handler, { RECOGNITION_UNAVAILABLE_CODE, VISION_TOTAL_BUDGET_MS } from '../api/recognize-card.ts';
import {
  isRecognitionInfrastructureFailure,
  RECOGNITION_REQUEST_TIMEOUT_MS,
} from '../src/services/recognitionOutcome.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = (p) => path.resolve(__dirname, '..', p);
const database = JSON.parse(fs.readFileSync(repo('public/data/database.json'), 'utf8'));

const GOOGLE_HOST = 'generativelanguage.googleapis.com';
const OPENROUTER_HOST = 'openrouter.ai';

const GOOGLE_KEY = 'google-secret-value-must-not-leak';
const OPENROUTER_KEY = 'openrouter-secret-value-must-not-leak';

const REPLY = 'CHARACTER: ラプラス・ダークネス\nHP: NONE\nRARITY: SEC\nBLOOM_LEVEL: NONE\nCARD_NUMBER: hBP04-005\nTITLE: NONE';

const FULL_FRAME = 'data:image/jpeg;base64,ZnVsbC1mcmFtZQ==';
const CROP = 'data:image/png;base64,Y3JvcC1hcmVh';

const UPSTREAM_BODY = 'upstream stack trace: quota project holo-secret-project';

const savedGoogle = process.env.GEMINI_API_KEY;
const savedOpenRouter = process.env.OPENROUTER_API_KEY;

const hangUntilAborted = (signal) => new Promise((_resolve, reject) => {
  const keepAlive = setInterval(() => {}, 50);
  const done = () => { clearInterval(keepAlive); reject(new Error('The operation was aborted')); };
  if (signal?.aborted) return done();
  signal?.addEventListener('abort', done);
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Stub the network so Google can be driven deterministically, the database load resolves,
 * and any request to openrouter.ai fails the whole test loudly. This is the mutation
 * tripwire: a reintroduced OpenRouter adapter would fetch this host and this stub would
 * turn the fetch into an assertion failure before it can spend a real inference call.
 */
function stubNetworkWithOpenRouterDenylist({
  google = 200,
  googleReply = REPLY,
  googleDelay = 0,
} = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.includes('database.json')) return Response.json(database);

    if (href.includes(OPENROUTER_HOST) || /openrouter/i.test(href)) {
      const violation = new Error(
        `DIC-1185 denylist violation: outbound fetch reached OpenRouter host (${href}). ` +
        `OpenRouter routes are removed; no code path may open a connection to openrouter.ai, ` +
        `even under an inherited OPENROUTER_API_KEY.`,
      );
      calls.push({ provider: 'openrouter', href, denylistTripped: true });
      throw violation;
    }

    const record = { href, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null };
    if (href.includes(GOOGLE_HOST)) {
      calls.push({ provider: 'gemini', at: Date.now(), ...record });
      if (google === 'hang') return hangUntilAborted(init.signal);
      if (googleDelay) await sleep(googleDelay);
      if (google === 'network') throw new Error(`connect ECONNREFUSED ${href}`);
      if (google !== 200) return new Response(UPSTREAM_BODY, { status: google });
      return Response.json({ candidates: [{ content: { parts: [{ text: googleReply }] } }] });
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

  const calls = stubNetworkWithOpenRouterDenylist(network);
  const res = await post();
  const body = await res.json();
  return { res, body, bytes: JSON.stringify(body), calls };
}

const results = [];
const check = (label, fn) => { fn(); results.push(label); };

// ── 1. Static scan: no runtime source may build an OpenRouter request ─────────
// This is the earliest tripwire. Prose comments that document the DIC-1185
// removal are allowed to *mention* OpenRouter; what is banned is any construct
// that would actually issue an outbound call — a URL string, an env read, or
// the Authorization+model shape OpenRouter's chat-completions API expects.
{
  const runtimeFiles = [
    'api/recognize-card.ts',
    'api/hello.ts',
    'scripts/add-zh-names.js',
    'scripts/translate-effects.js',
  ];
  // Patterns that indicate ACTIVE code (not documentation). Each would cause a
  // real request to openrouter.ai if reintroduced.
  const forbidden = [
    { pattern: /openrouter\.ai\/api/i, label: 'openrouter.ai/api URL' },
    { pattern: /openrouter\.ai\/v\d/i, label: 'openrouter.ai/v* URL' },
    { pattern: /process\.env\.OPENROUTER/, label: 'process.env.OPENROUTER read' },
    { pattern: /readKey\(['"]OPENROUTER/, label: 'readKey("OPENROUTER…") call' },
    { pattern: /env\[['"]OPENROUTER/i, label: 'env["OPENROUTER…"] read' },
    { pattern: /['"]HTTP-Referer['"]\s*:.*holohunter/i, label: 'OpenRouter HTTP-Referer header' },
    { pattern: /['"]X-Title['"]/, label: 'OpenRouter X-Title header' },
    { pattern: /google\/gemini-[\d.]+-flash['"]/i, label: 'OpenRouter model slug (google/gemini-*)' },
  ];
  for (const relPath of runtimeFiles) {
    const source = fs.readFileSync(repo(relPath), 'utf8');
    const lines = source.split('\n');
    let violations = 0;
    for (const { pattern, label } of forbidden) {
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          violations++;
          check(`${relPath}:${i + 1} must not carry ${label}`, () => {
            assert.fail(`OpenRouter code reintroduced at ${relPath}:${i + 1}: ${lines[i].trim()}`);
          });
        }
      }
    }
    check(`${relPath}: no ACTIVE OpenRouter code path`, () => {
      assert.equal(violations, 0, `${violations} forbidden pattern(s) found`);
    });
  }
}

// ── 2. Google present + OpenRouter env present: only Google is called ─────────
// The inherited-key scenario the FinOps patrol flagged. Even with
// OPENROUTER_API_KEY set on the process, the handler must not touch openrouter.ai.
{
  const { res, body, calls } = await scan(
    { google: GOOGLE_KEY, openrouter: OPENROUTER_KEY },
    {},
  );
  check('inherited OPENROUTER_API_KEY does not cause any OpenRouter fetch', () => {
    for (const call of calls) {
      assert.notEqual(call.provider, 'openrouter', `unexpected OpenRouter call: ${JSON.stringify(call)}`);
      assert.ok(!call.denylistTripped, 'OpenRouter denylist tripped — a fallback fetch was attempted');
    }
    assert.deepEqual(calls.map(c => c.provider), ['gemini']);
  });
  check('Google direct still recognises when both env vars are present', () => {
    assert.equal(res.status, 200);
    assert.equal(body.debug.provider, 'gemini');
    assert.equal(body.debug.model, 'gemini-2.5-flash');
    assert.equal(body.candidates[0].cardNumber, 'hBP04-005');
  });
  const [google] = calls;
  check('the Google key travels in a header, never in the request URL', () => {
    assert.ok(!google.href.includes(GOOGLE_KEY), google.href);
    assert.ok(!google.href.includes('key='), 'a ?key= URL leaks the secret into logs');
    assert.equal(google.headers['x-goog-api-key'], GOOGLE_KEY);
  });
  check('Google leg carries both frame and crop as inline data URIs', () => {
    const parts = google.body.contents[0].parts;
    assert.equal(parts[0].text.includes('CARD_NUMBER'), true);
    const inline = parts.filter(p => p.inline_data);
    assert.equal(inline.length, 2);
    assert.deepEqual(inline.map(p => p.inline_data.mime_type), ['image/jpeg', 'image/png']);
    assert.deepEqual(inline.map(p => p.inline_data.data), ['ZnVsbC1mcmFtZQ==', 'Y3JvcC1hcmVh']);
  });
}

// ── 3. OpenRouter-key-only environment: 503 fail-closed, no fetch attempted ───
// This is the exact production risk the FinOps repair addresses: an unprovisioned
// Google key + a stray OPENROUTER_API_KEY must NEVER "fall over" to OpenRouter.
{
  const { res, body, calls, bytes } = await scan({ openrouter: OPENROUTER_KEY }, {});
  check('OpenRouter-only env answers 503 RECOGNITION_UNAVAILABLE', () => {
    assert.equal(res.status, 503);
    assert.equal(body.success, false);
    assert.equal(body.code, RECOGNITION_UNAVAILABLE_CODE);
  });
  check('OpenRouter-only env issues no provider fetch at all', () => {
    for (const call of calls) {
      assert.notEqual(call.provider, 'openrouter', 'OpenRouter fallback was attempted');
    }
    // Only the database load may have run; no provider host may appear.
    assert.deepEqual(calls, [], 'no provider call is permitted without a Google key');
  });
  check('OpenRouter-only env never names either env var over the wire', () => {
    assert.ok(!/GEMINI_API_KEY|OPENROUTER_API_KEY/.test(bytes), bytes);
    assert.ok(!bytes.includes(OPENROUTER_KEY), bytes);
  });
}

// ── 4. Google failure modes must not fall over to OpenRouter ─────────────────
// Under the removed adapter, a Google 5xx / 4xx / transport error / hang used to
// try OpenRouter next. Every one of these must now surface as a Google-only 502,
// with the OpenRouter denylist untripped.
{
  const failureModes = [
    ['upstream 500', { google: 500 }, 502],
    ['upstream 401', { google: 401 }, 502],
    ['transport failure', { google: 'network' }, 502],
    ['empty reply', { googleReply: '' }, 502],
  ];
  for (const [label, network, expectedStatus] of failureModes) {
    const { res, body, calls, bytes } = await scan(
      { google: GOOGLE_KEY, openrouter: OPENROUTER_KEY },
      network,
    );
    check(`Google ${label} does not fall over to OpenRouter`, () => {
      for (const call of calls) {
        assert.notEqual(call.provider, 'openrouter', `OpenRouter fallback attempted after Google ${label}`);
      }
      assert.deepEqual(calls.map(c => c.provider), ['gemini']);
    });
    check(`Google ${label} surfaces as ${expectedStatus}, not 200 via OpenRouter`, () => {
      assert.equal(res.status, expectedStatus);
      assert.notEqual(body.code, RECOGNITION_UNAVAILABLE_CODE, 'a real backend failure is not "unprovisioned"');
    });
    check(`Google ${label}: no OpenRouter key value leaks into the response`, () => {
      assert.ok(!bytes.includes(OPENROUTER_KEY), bytes);
      assert.ok(!bytes.includes(GOOGLE_KEY), bytes);
      assert.ok(!/x-goog-api-key|Bearer/i.test(bytes), bytes);
      assert.ok(!bytes.includes('holo-secret-project'), bytes);
    });
  }
}

// ── 5. A hung Google leg times out cleanly within the caller deadline ────────
// With the sequential fallback gone, the single-leg budget is the whole vision
// budget. It still has to land before the 15s client abort (DIC-1020 CR).
{
  check('the single-leg vision budget fits inside the caller deadline', () => {
    assert.ok(
      VISION_TOTAL_BUDGET_MS < RECOGNITION_REQUEST_TIMEOUT_MS,
      `vision budget ${VISION_TOTAL_BUDGET_MS}ms must fit inside the ${RECOGNITION_REQUEST_TIMEOUT_MS}ms client deadline`,
    );
    assert.ok(
      RECOGNITION_REQUEST_TIMEOUT_MS - VISION_TOTAL_BUDGET_MS >= 3000,
      'the budget must leave headroom for ranking and the JSON round trip',
    );
  });

  const startedAt = Date.now();
  const { res, body, calls } = await scan(
    { google: GOOGLE_KEY, openrouter: OPENROUTER_KEY },
    { google: 'hang' },
  );
  const elapsed = Date.now() - startedAt;

  check('a hung Google leg surfaces as an infrastructure failure, not an OpenRouter fallback', () => {
    for (const call of calls) {
      assert.notEqual(call.provider, 'openrouter', 'OpenRouter fallback attempted after hang');
    }
    assert.equal(res.status, 502);
    assert.equal(isRecognitionInfrastructureFailure(res.status, body), true);
  });
  check('a hung Google leg still returns well before the 15s client abort', () => {
    assert.ok(
      elapsed < RECOGNITION_REQUEST_TIMEOUT_MS,
      `hung leg took ${elapsed}ms, client aborts at ${RECOGNITION_REQUEST_TIMEOUT_MS}ms`,
    );
  });
}

// ── 6. Store MVP field strip still holds on the Google-only path (DIC-908) ────
{
  process.env.GEMINI_API_KEY = GOOGLE_KEY;
  delete process.env.OPENROUTER_API_KEY;
  stubNetworkWithOpenRouterDenylist({});
  const res = await post({ images: [FULL_FRAME, CROP], storeMvp: true });
  const body = await res.json();
  check('Store MVP fields stay stripped on the Google-only recognition path', () => {
    for (const candidate of body.candidates) {
      assert.ok(!('buyPrice' in candidate), 'buyPrice must not cross the wire');
      assert.ok(!('priceHistory' in candidate));
      assert.ok(!('ytStats' in candidate));
    }
  });
}

// ── 7. AST semantic guard: constant-fold + inspect (DIC-1190 CR) ─────────────
// Literal-regex checks alone are bypassable by string assembly
// (`'open' + 'router.ai'`), aliased env access
// (`const e = process.env; e.OPENROUTER_API_KEY`), or `.join('')`
// reconstruction. This section parses each runtime file with the TypeScript
// compiler, constant-folds every statically-resolvable string expression, and
// walks every property/element access — so an assembled URL, a computed env
// key, or an aliased property access lands in the same trap as a raw literal.
{
  function constantFold(node) {
    if (!node) return null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return node.text;
    }
    if (ts.isTemplateExpression(node)) {
      let out = node.head.text;
      for (const span of node.templateSpans) {
        const v = constantFold(span.expression);
        if (v === null) return null;
        out += v;
        out += span.literal.text;
      }
      return out;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = constantFold(node.left);
      const r = constantFold(node.right);
      if (l === null || r === null) return null;
      return l + r;
    }
    if (ts.isParenthesizedExpression(node)) return constantFold(node.expression);
    // [...].join(sep) with literal string parts
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'join' &&
      ts.isArrayLiteralExpression(node.expression.expression)
    ) {
      const parts = [];
      for (const el of node.expression.expression.elements) {
        const v = constantFold(el);
        if (v === null) return null;
        parts.push(v);
      }
      const sep = node.arguments[0] ? constantFold(node.arguments[0]) : ',';
      if (sep === null) return null;
      return parts.join(sep);
    }
    // String.fromCharCode(...) reassembly of a denylisted host
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'String' &&
      node.expression.name.text === 'fromCharCode'
    ) {
      const codes = [];
      for (const arg of node.arguments) {
        if (ts.isNumericLiteral(arg)) codes.push(Number(arg.text));
        else return null;
      }
      return String.fromCharCode(...codes);
    }
    return null;
  }

  const runtimeFiles = [
    'api/recognize-card.ts',
    'api/hello.ts',
    'scripts/add-zh-names.js',
    'scripts/translate-effects.js',
  ];
  const denyStringPatterns = [
    { pattern: /openrouter\.ai/i, label: 'openrouter.ai host string' },
    { pattern: /openrouter\/[a-z]/i, label: 'openrouter/… model slug' },
    { pattern: /OPENROUTER_API_KEY/, label: 'OPENROUTER_API_KEY env-key string' },
    { pattern: /OPENROUTER_URL/, label: 'OPENROUTER_URL identifier string' },
  ];

  for (const relPath of runtimeFiles) {
    const source = fs.readFileSync(repo(relPath), 'utf8');
    const kind = relPath.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const sf = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true, kind);

    const violations = [];
    function visit(node) {
      const folded = constantFold(node);
      if (folded !== null && folded.length < 2048) {
        for (const { pattern, label } of denyStringPatterns) {
          if (pattern.test(folded)) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            violations.push({
              line: line + 1,
              kind: label,
              value: folded.length > 120 ? folded.slice(0, 120) + '…' : folded,
            });
          }
        }
      }
      if (ts.isPropertyAccessExpression(node) && /OPENROUTER/i.test(node.name.text)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        violations.push({ line: line + 1, kind: 'property access to OPENROUTER*', value: node.name.text });
      }
      if (ts.isElementAccessExpression(node)) {
        const key = constantFold(node.argumentExpression);
        if (typeof key === 'string' && /OPENROUTER/i.test(key)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          violations.push({ line: line + 1, kind: 'element access to OPENROUTER*', value: key });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);

    // Deduplicate: constant folding recurses, so a single assembled `openrouter.ai`
    // fires at every enclosing binary-plus node. Keep the innermost occurrence.
    const seen = new Set();
    const unique = violations.filter((v) => {
      const k = `${v.line}:${v.kind}:${v.value}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    check(`${relPath}: AST guard finds no assembled/computed OpenRouter reference`, () => {
      assert.equal(
        unique.length,
        0,
        `AST guard found ${unique.length} violation(s):\n` +
          unique.map((v) => `  ${relPath}:${v.line} [${v.kind}] ${v.value}`).join('\n'),
      );
    });
  }
}

// ── 8. Runtime tripwire on non-recognition modules (DIC-1190 CR) ─────────────
// The AST guard cannot see runtime-generated identifiers. This section imports
// each non-recognition module and exercises its documented entry points under
// two independent tripwires:
//
//   - a Proxy wrapping `process.env` logs every read whose key contains
//     `OPENROUTER`, however that key is assembled at runtime;
//   - `globalThis.fetch` throws the moment `openrouter.ai` appears in the URL,
//     regardless of how the URL was constructed.
//
// A canary `OPENROUTER_API_KEY` is deliberately left in the environment so a
// mutation that reads the env AND uses it in a Bearer/Authorization header
// takes its real network branch instead of no-oping on an unset var.
{
  const originalEnv = process.env;
  const originalFetch = globalThis.fetch;

  let readOpenRouterKeys = [];
  function installEnvTripwire() {
    readOpenRouterKeys = [];
    process.env = new Proxy(originalEnv, {
      get(target, prop) {
        if (typeof prop === 'string' && /OPENROUTER/i.test(prop)) {
          readOpenRouterKeys.push(prop);
        }
        return target[prop];
      },
      set(target, prop, value) { target[prop] = value; return true; },
      deleteProperty(target, prop) { delete target[prop]; return true; },
      has(target, prop) { return prop in target; },
      ownKeys(target) { return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor(target, prop) { return Object.getOwnPropertyDescriptor(target, prop); },
    });
  }
  function restoreEnv() { process.env = originalEnv; }

  function makeFetchTripwire(label) {
    const outbound = [];
    globalThis.fetch = async (url, init) => {
      const href = String(url);
      outbound.push({ href, hasInit: !!init });
      if (/openrouter/i.test(href)) {
        throw new Error(`DIC-1185 denylist violation: ${label} reached ${href}`);
      }
      throw new Error(`unexpected fetch from ${label}: ${href}`);
    };
    return outbound;
  }

  const CANARY = 'canary-inherited-openrouter-key-DIC1185';
  originalEnv.OPENROUTER_API_KEY = CANARY;

  // -- 8a. scripts/add-zh-names.js ------------------------------------------
  {
    const outbound = makeFetchTripwire('scripts/add-zh-names.js');
    installEnvTripwire();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dic1185-addzh-'));
    const tmpDb = path.join(tmpDir, 'database.json');
    fs.writeFileSync(tmpDb, JSON.stringify({
      cards: {
        c1: { name: 'ラプラス・ダークネス' },
        c2: { name: 'ThisNameWillNotBeInTheStaticMap' },
      },
    }));
    let addZhError = null;
    try {
      const mod = await import(pathToFileURL(repo('scripts/add-zh-names.js')).href);
      await mod.addZhNames(tmpDb);
    } catch (e) { addZhError = e; }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv();

    check('add-zh-names.js addZhNames() completes without throwing', () => {
      assert.equal(addZhError, null, addZhError && addZhError.stack);
    });
    check('add-zh-names.js addZhNames() issues zero outbound fetches', () => {
      assert.deepEqual(outbound, [], `unexpected fetches: ${outbound.map((o) => o.href).join(', ')}`);
    });
    check('add-zh-names.js addZhNames() never reads any OPENROUTER* env key', () => {
      assert.deepEqual(
        readOpenRouterKeys,
        [],
        `unexpected OPENROUTER env reads: ${readOpenRouterKeys.join(', ')}`,
      );
    });
  }

  // -- 8b. scripts/translate-effects.js top-level import + helpers ----------
  {
    const outbound = makeFetchTripwire('scripts/translate-effects.js');
    installEnvTripwire();
    let helperResult = null;
    let importError = null;
    try {
      // Fresh import each run to defeat ESM caching by appending a cache-buster,
      // otherwise a rerun would return the previous module without triggering
      // its top-level side effects again.
      const mod = await import(
        pathToFileURL(repo('scripts/translate-effects.js')).href + `?dic1185=${Date.now()}`
      );
      helperResult = {
        finalize: mod.finalize('テスト', []),
        collected: mod.collectStrings({ c: { arts: [{ name: 'a', effect: 'b' }] } }),
      };
    } catch (e) { importError = e; }
    restoreEnv();

    check('translate-effects.js top-level import + helper calls do not throw', () => {
      assert.equal(importError, null, importError && importError.stack);
      assert.ok(helperResult && typeof helperResult.finalize === 'string');
      assert.ok(helperResult && Array.isArray(helperResult.collected));
    });
    check('translate-effects.js import + helpers issue zero outbound fetches', () => {
      assert.deepEqual(outbound, [], `unexpected fetches: ${outbound.map((o) => o.href).join(', ')}`);
    });
    check('translate-effects.js import + helpers never read OPENROUTER* env', () => {
      assert.deepEqual(
        readOpenRouterKeys,
        [],
        `unexpected OPENROUTER env reads: ${readOpenRouterKeys.join(', ')}`,
      );
    });
  }

  // -- 8c. api/hello.ts: exercise the default handler under stub -----------
  {
    const outbound = makeFetchTripwire('api/hello.ts');
    installEnvTripwire();
    const helloMod = await import('../api/hello.ts');
    const nodeHandler = helloMod.default;
    const req = { url: '/api/hello', method: 'GET', headers: { host: 'localhost' } };
    const chunks = [];
    let status = 0;
    const outHeaders = {};
    const res = {
      status(s) { status = s; return this; },
      setHeader(k, v) { outHeaders[String(k).toLowerCase()] = v; return this; },
      send(b) { if (b !== undefined && b !== null) chunks.push(b); return this; },
      end(b) { if (b !== undefined && b !== null) chunks.push(b); return this; },
      get headersSent() { return status !== 0; },
    };
    await nodeHandler(req, res);
    const bodyText = Buffer.concat(
      chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c)))),
    ).toString('utf8');
    restoreEnv();

    check('hello.ts default handler issues zero outbound fetches', () => {
      assert.deepEqual(outbound, [], `unexpected fetches: ${outbound.map((o) => o.href).join(', ')}`);
    });
    check('hello.ts default handler never reads any OPENROUTER* env key', () => {
      assert.deepEqual(
        readOpenRouterKeys,
        [],
        `unexpected OPENROUTER env reads: ${readOpenRouterKeys.join(', ')}`,
      );
    });
    check('hello.ts response body never mentions OpenRouter or the env key', () => {
      assert.ok(!/openrouter/i.test(bodyText), bodyText);
      assert.ok(!/OPENROUTER_API_KEY/.test(bodyText), bodyText);
      assert.ok(!bodyText.includes(CANARY), 'canary key value must not leak into the response');
    });
  }

  delete originalEnv.OPENROUTER_API_KEY;
  globalThis.fetch = originalFetch;
}

if (savedGoogle === undefined) delete process.env.GEMINI_API_KEY;
else process.env.GEMINI_API_KEY = savedGoogle;
if (savedOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
else process.env.OPENROUTER_API_KEY = savedOpenRouter;

for (const label of results) console.log(`  ✓ ${label}`);
console.log(`\n✅ recognition-provider-fallback (DIC-1185 denylist): ${results.length} checks passed`);
