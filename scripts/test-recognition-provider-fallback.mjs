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

// ── 7. AST semantic guard with identifier-binding + decoder folding ──────────
// (DIC-1190 CR — second iteration)
//
// The first AST guard folded direct expressions only. A reviewer bypassed it by
// declaring `const codes = [111, 112, …]; const host = String.fromCharCode(...codes);`
// and using `host` in a fetch URL — the fold couldn't cross the identifier binding.
//
// This pass extends the folder to:
//   - Track every `const` binding in the file (flat, safety-first: a name
//     collision across scopes folds to the last-seen value, which errs on the
//     side of DETECTING assembly).
//   - Fold numeric literals into numbers and array literals into arrays.
//   - Fold `String.fromCharCode(...)` with numeric args OR a spread of a
//     folded numeric array.
//   - Fold `arr.map(cb).join(sep)` where `cb` is a single-param arrow function
//     whose body is itself foldable given the parameter binding.
//   - Fold `Array.from(str).join(sep)` returning `str.split('').join(sep)`.
//   - Fold `Buffer.from([nums]).toString('utf8'|'ascii')`.
//
// Anything the folder resolves is checked against the denylist string patterns
// AND — as a second, positive-form assertion — every fetch URL in the
// recognition handler is required to fold to a host in a fixed allowlist.
// A fetch URL that the folder cannot resolve is itself a FAIL: "prove it's
// safe" rather than "detect that it's bad".
{
  function collectConstBindings(sf) {
    const bindings = new Map();
    function visit(node) {
      if (
        ts.isVariableDeclaration(node) &&
        node.parent &&
        ts.isVariableDeclarationList(node.parent) &&
        (node.parent.flags & ts.NodeFlags.Const) !== 0 &&
        ts.isIdentifier(node.name) &&
        node.initializer
      ) {
        const value = fold(node.initializer, bindings);
        if (value !== null && value !== undefined) {
          // First writer wins by preference: a legitimate top-level `const` is
          // shadowed only by a later declaration in the same file, which we
          // still want to detect (safety-first: last write wins here so an
          // attacker's inner rebind is what gets folded).
          bindings.set(node.name.text, value);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
    return bindings;
  }

  function fold(node, table) {
    if (!node) return null;
    if (ts.isParenthesizedExpression(node)) return fold(node.expression, table);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return node.text;
    }
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isIdentifier(node)) {
      if (table && table.has(node.text)) return table.get(node.text);
      return null;
    }
    if (ts.isArrayLiteralExpression(node)) {
      const out = [];
      for (const el of node.elements) {
        if (ts.isSpreadElement(el)) {
          const arr = fold(el.expression, table);
          if (!Array.isArray(arr)) return null;
          out.push(...arr);
        } else {
          const v = fold(el, table);
          if (v === null && el.kind !== ts.SyntaxKind.NullKeyword) return null;
          out.push(v);
        }
      }
      return out;
    }
    if (ts.isTemplateExpression(node)) {
      let out = node.head.text;
      for (const span of node.templateSpans) {
        const v = fold(span.expression, table);
        if (v === null || v === undefined) return null;
        out += String(v);
        out += span.literal.text;
      }
      return out;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = fold(node.left, table);
      const r = fold(node.right, table);
      if (l === null || l === undefined || r === null || r === undefined) return null;
      return l + r;
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;

      // String.fromCharCode(a, b, ...) or String.fromCharCode(...arr)
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'String' &&
        callee.name.text === 'fromCharCode'
      ) {
        const codes = [];
        for (const arg of node.arguments) {
          if (ts.isSpreadElement(arg)) {
            const arr = fold(arg.expression, table);
            if (!Array.isArray(arr)) return null;
            for (const c of arr) {
              if (typeof c !== 'number') return null;
              codes.push(c);
            }
          } else {
            const v = fold(arg, table);
            if (typeof v !== 'number') return null;
            codes.push(v);
          }
        }
        return String.fromCharCode(...codes);
      }

      // Buffer.from([nums]).toString('utf8'|'ascii'|'latin1'|undef)
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'toString' &&
        ts.isCallExpression(callee.expression) &&
        ts.isPropertyAccessExpression(callee.expression.expression) &&
        ts.isIdentifier(callee.expression.expression.expression) &&
        callee.expression.expression.expression.text === 'Buffer' &&
        callee.expression.expression.name.text === 'from'
      ) {
        const src = callee.expression.arguments[0];
        const arr = fold(src, table);
        if (Array.isArray(arr) && arr.every((n) => typeof n === 'number')) {
          const enc = node.arguments[0] ? fold(node.arguments[0], table) : 'utf8';
          if (typeof enc === 'string' || enc === undefined) {
            try { return Buffer.from(arr).toString(enc || 'utf8'); } catch { return null; }
          }
        }
      }

      // Array.from(x).join(sep)
      // Also plain arr.map(cb).join(sep) / [...].join(sep)
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'join') {
        const sep = node.arguments[0] ? fold(node.arguments[0], table) : ',';
        if (typeof sep !== 'string') return null;
        const receiver = callee.expression;

        // Direct array or identifier-bound array
        {
          const arr = fold(receiver, table);
          if (Array.isArray(arr)) {
            if (arr.every((v) => typeof v === 'string' || typeof v === 'number')) {
              return arr.join(sep);
            }
          }
        }

        // arr.map(cb).join(sep)
        if (
          ts.isCallExpression(receiver) &&
          ts.isPropertyAccessExpression(receiver.expression) &&
          receiver.expression.name.text === 'map'
        ) {
          const srcArr = fold(receiver.expression.expression, table);
          if (Array.isArray(srcArr)) {
            const cb = receiver.arguments[0];
            if (
              cb &&
              (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) &&
              cb.parameters.length >= 1 &&
              ts.isIdentifier(cb.parameters[0].name)
            ) {
              const paramName = cb.parameters[0].name.text;
              const body =
                ts.isBlock(cb.body)
                  ? cb.body.statements.length === 1 && ts.isReturnStatement(cb.body.statements[0])
                    ? cb.body.statements[0].expression
                    : null
                  : cb.body;
              if (body) {
                const out = [];
                for (const el of srcArr) {
                  const scoped = new Map(table);
                  scoped.set(paramName, el);
                  const v = fold(body, scoped);
                  if (v === null || v === undefined) return null;
                  out.push(v);
                }
                if (out.every((v) => typeof v === 'string' || typeof v === 'number')) {
                  return out.join(sep);
                }
              }
            }
          }
        }

        // Array.from(x)
        if (
          ts.isCallExpression(receiver) &&
          ts.isPropertyAccessExpression(receiver.expression) &&
          ts.isIdentifier(receiver.expression.expression) &&
          receiver.expression.expression.text === 'Array' &&
          receiver.expression.name.text === 'from'
        ) {
          const v = fold(receiver.arguments[0], table);
          if (typeof v === 'string') return v.split('').join(sep);
          if (Array.isArray(v) && v.every((e) => typeof e === 'string' || typeof e === 'number')) {
            return v.join(sep);
          }
        }
      }
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

  // Files that must not issue ANY outbound fetch — architecturally simpler
  // than trying to prove every URL is safe. Even a benign new fetch here is
  // a fail; that is intentional (fail-closed against a fetch reintroduction).
  const noFetchAllowed = new Set([
    'api/hello.ts',
    'scripts/add-zh-names.js',
    'scripts/translate-effects.js',
  ]);
  // For files that legitimately fetch (only api/recognize-card.ts today), every
  // fetch URL must constant-fold to a URL whose host is in this allowlist.
  const fetchHostAllowlist = {
    'api/recognize-card.ts': new Set([
      'generativelanguage.googleapis.com',
      'holohunter.dicoge.com',
    ]),
  };

  // Modules that ship a fetch primitive. Any import from these is treated as
  // acquiring the fetch primitive — see collectFetchAliases below.
  const FETCH_MODULE_NAMES = new Set([
    'node-fetch', 'undici', 'axios', 'got', 'superagent', 'ky', 'phin', 'wretch',
    'cross-fetch', 'isomorphic-fetch', 'isomorphic-unfetch', 'unfetch',
  ]);
  // Property names on the global object that expose the fetch primitive.
  const GLOBAL_CONTAINERS = new Set(['globalThis', 'window', 'self', 'global']);

  // Resolve a member-access node (dot OR computed) to `{ receiver, name }`
  // when the member name folds to a string, else null. Symmetrises dot and
  // computed access so downstream rules never rely on syntax alone. (DIC-1190
  // CR round 5 — computed `R['call']` bypass.)
  function resolveMember(node, bindings) {
    if (!node) return null;
    if (ts.isPropertyAccessExpression(node)) {
      return { receiver: node.expression, name: node.name.text };
    }
    if (ts.isElementAccessExpression(node)) {
      const key = fold(node.argumentExpression, bindings);
      if (typeof key === 'string') return { receiver: node.expression, name: key };
    }
    return null;
  }

  // A node is a "fetch primitive reference" when it evaluates (statically) to
  // the fetch function itself, or to a wrapped/bound version of it. Any such
  // reference in a no-fetch-allowed file is a violation on its own — even
  // before it is called — because the file has no legitimate reason to obtain
  // the primitive. (DIC-1190 CR round 3.)
  function isFetchPrimitiveRef(node, aliases, bindings) {
    if (!node) return false;
    if (ts.isParenthesizedExpression(node)) return isFetchPrimitiveRef(node.expression, aliases, bindings);
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      return isFetchPrimitiveRef(node.expression, aliases, bindings);
    }
    if (ts.isNonNullExpression(node)) return isFetchPrimitiveRef(node.expression, aliases, bindings);
    // Bare `fetch` identifier or an aliased identifier
    if (ts.isIdentifier(node)) {
      if (node.text === 'fetch') return true;
      if (aliases && aliases.has(node.text)) return true;
      return false;
    }
    // Member access (dot OR computed):
    //   - globalThis.fetch / globalThis['fetch'] / window.fetch / ...
    //   - <primitive>.bind / .call / .apply and their computed equivalents
    //     — these do NOT detach the callable, so the reference is still a
    //     primitive for the purpose of both the no-fetch-file rule and the
    //     URL enforcement.
    const member = resolveMember(node, bindings);
    if (member) {
      if (
        member.name === 'fetch' &&
        ts.isIdentifier(member.receiver) &&
        GLOBAL_CONTAINERS.has(member.receiver.text)
      ) return true;
      if (['bind', 'call', 'apply'].includes(member.name)) {
        if (isFetchPrimitiveRef(member.receiver, aliases, bindings)) return true;
      }
      // require('undici').fetch / require('undici').default / and their
      // computed equivalents.
      if ((member.name === 'fetch' || member.name === 'default') && ts.isCallExpression(member.receiver)) {
        const inner = member.receiver;
        if (
          ts.isIdentifier(inner.expression) &&
          inner.expression.text === 'require'
        ) {
          const mod = fold(inner.arguments[0], bindings);
          if (typeof mod === 'string' && FETCH_MODULE_NAMES.has(mod)) return true;
        }
      }
    }
    // <primitive>.bind(null) / R['call'](url) / R['apply'](null, [url]) —
    // a call whose callee is a member access on a fetch primitive with a
    // .bind/.call/.apply name yields (or invokes) a callable equivalent to
    // fetch. The bare bind form (returns a callable) is treated as primitive.
    if (ts.isCallExpression(node)) {
      const calleeMember = resolveMember(node.expression, bindings);
      if (
        calleeMember &&
        calleeMember.name === 'bind' &&
        isFetchPrimitiveRef(calleeMember.receiver, aliases, bindings)
      ) return true;
    }
    // require('node-fetch') / require('undici') / etc.
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    ) {
      const arg = node.arguments[0];
      const mod = arg ? fold(arg, bindings) : null;
      if (typeof mod === 'string' && FETCH_MODULE_NAMES.has(mod)) return true;
    }
    return false;
  }

  // Walk the AST and collect every local identifier that is bound (via const,
  // let, destructuring, or import) to a fetch primitive. Fixed-point iteration
  // handles chains like `const A = fetch; const B = A`.
  function collectFetchAliases(sf, bindings) {
    const aliases = new Set();
    const gainedAliases = () => aliases.size;
    let prev = -1;
    while (prev !== aliases.size) {
      prev = aliases.size;
      function visit(node) {
        // const/let/var X = <fetch primitive>
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer &&
          isFetchPrimitiveRef(node.initializer, aliases, bindings)
        ) {
          aliases.add(node.name.text);
        }
        // const { fetch } = globalThis|window|self|global
        // const { fetch: X } = globalThis|...
        if (
          ts.isVariableDeclaration(node) &&
          ts.isObjectBindingPattern(node.name) &&
          node.initializer &&
          ts.isIdentifier(node.initializer) &&
          GLOBAL_CONTAINERS.has(node.initializer.text)
        ) {
          for (const el of node.name.elements) {
            if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
              const propName = el.propertyName
                ? (ts.isIdentifier(el.propertyName)
                    ? el.propertyName.text
                    : (ts.isStringLiteral(el.propertyName) ? el.propertyName.text : null))
                : el.name.text;
              if (propName === 'fetch') aliases.add(el.name.text);
            }
          }
        }
        // import default/named from 'node-fetch'|'undici'|...
        if (
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          FETCH_MODULE_NAMES.has(node.moduleSpecifier.text)
        ) {
          const clause = node.importClause;
          if (clause) {
            if (clause.name && ts.isIdentifier(clause.name)) aliases.add(clause.name.text);
            if (clause.namedBindings) {
              if (ts.isNamedImports(clause.namedBindings)) {
                for (const spec of clause.namedBindings.elements) {
                  if (spec.name && ts.isIdentifier(spec.name)) aliases.add(spec.name.text);
                }
              }
              if (ts.isNamespaceImport(clause.namedBindings)) {
                // import * as m from 'undici': flag any m.<x>() call heuristically
                // by treating the namespace binding itself as aliased.
                aliases.add(clause.namedBindings.name.text);
              }
            }
          }
        }
        // Assignment: X = fetch; X = globalThis.fetch. Rare in const-heavy code
        // but robust to detect.
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(node.left) &&
          isFetchPrimitiveRef(node.right, aliases, bindings)
        ) {
          aliases.add(node.left.text);
        }
        ts.forEachChild(node, visit);
      }
      visit(sf);
    }
    // Suppress lint noise about unused helper
    void gainedAliases;
    return aliases;
  }

  // Detects `<fetchPrimitive>[<opaqueKey>]` — a computed member access on a
  // known fetch primitive whose key cannot be statically resolved. Since we
  // cannot prove the key is not `call`/`apply`, we can't trust the URL
  // position, and since we cannot prove it's not something that just returns
  // the primitive (`.bind`, prototype indirection), we must treat any
  // resulting call as a fetch invocation with an unresolvable URL. (DIC-1190
  // CR round 6 — runtime-decoded computed key bypass.)
  function isOpaqueMemberOnFetchPrimitive(node, aliases, bindings) {
    if (!ts.isElementAccessExpression(node)) return false;
    const key = fold(node.argumentExpression, bindings);
    if (typeof key === 'string') return false; // resolvable → other rules handle
    return isFetchPrimitiveRef(node.expression, aliases, bindings);
  }

  // A CallExpression is a "fetch call" if its callee resolves to the fetch
  // primitive by any of the aliasing pathways above, OR if it is a call on
  // an opaque computed member of a fetch primitive (fail-closed for the
  // URL-allowlist rule).
  function isFetchCall(node, aliases, bindings) {
    if (!ts.isCallExpression(node)) return false;
    const callee = node.expression;
    if (isFetchPrimitiveRef(callee, aliases, bindings)) return true;
    if (isOpaqueMemberOnFetchPrimitive(callee, aliases, bindings)) return true;
    return false;
  }

  // Given a fetch CallExpression, return the AST node that carries the REAL
  // request URL. Normalises `Function.prototype.call/apply` invocation
  // semantics (DIC-1190 CR round 4): reading `arguments[0]` blindly lets a
  // reviewer smuggle an OpenRouter URL through `fetch.call(<allowlisted URL
  // as thisArg>, <opaque url>)` — argument 0 is `thisArg`, not the URL.
  //   - direct call `fetch(url, init)` → arguments[0]
  //   - `.call(thisArg, url, init)`    → arguments[1]
  //   - `.apply(thisArg, [url, init])` → arguments[1] element 0, IF the
  //     arguments array is a statically-visible literal; otherwise return a
  //     sentinel that the URL check treats as unresolvable (fail-closed).
  const UNRESOLVABLE_URL_ARG = Symbol('unresolvable-url-arg');
  // Returns { methodName: 'call'|'apply'|null } for the callee's invocation
  // semantics. Symmetrises dot and computed forms (DIC-1190 CR round 5).
  function callApplyMethodOf(callee, aliases, bindings) {
    const member = resolveMember(callee, bindings);
    if (!member) return null;
    if (member.name !== 'call' && member.name !== 'apply') return null;
    if (!isFetchPrimitiveRef(member.receiver, aliases, bindings)) return null;
    return member.name;
  }

  function extractFetchUrlArg(callNode, aliases, bindings) {
    // Opaque computed member on a fetch primitive — invocation semantics
    // unknown, URL position cannot be trusted → fail-closed (round 6).
    if (isOpaqueMemberOnFetchPrimitive(callNode.expression, aliases, bindings)) {
      return UNRESOLVABLE_URL_ARG;
    }
    const methodName = callApplyMethodOf(callNode.expression, aliases, bindings);
    if (methodName === 'call') {
      return callNode.arguments[1] || null;
    }
    if (methodName === 'apply') {
      const argsArray = callNode.arguments[1];
      if (!argsArray) return null;
      if (ts.isArrayLiteralExpression(argsArray)) {
        const first = argsArray.elements[0];
        // A leading spread makes the URL position indeterminate — fail-closed.
        if (first && ts.isSpreadElement(first)) return UNRESOLVABLE_URL_ARG;
        return first || null;
      }
      // Non-literal argsArray (identifier, computed expression, opaque call
      // result) is not statically resolvable — fail-closed.
      const folded = fold(argsArray, bindings);
      if (Array.isArray(folded) && folded.length > 0 && typeof folded[0] === 'string') {
        return { syntheticFoldedString: folded[0] };
      }
      return UNRESOLVABLE_URL_ARG;
    }
    return callNode.arguments[0] || null;
  }

  function analyzeSource(displayPath, source, {
    isNoFetchFile = false,
    hostAllowlist = null,
  } = {}) {
    const kind = displayPath.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const sf = ts.createSourceFile(displayPath, source, ts.ScriptTarget.Latest, true, kind);
    const bindings = collectConstBindings(sf);
    const fetchAliases = collectFetchAliases(sf, bindings);
    const violations = [];

    function visit(node) {
      const folded = fold(node, bindings);
      if (typeof folded === 'string' && folded.length < 4096) {
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
        const key = fold(node.argumentExpression, bindings);
        if (typeof key === 'string' && /OPENROUTER/i.test(key)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          violations.push({ line: line + 1, kind: 'element access to OPENROUTER*', value: key });
        }
      }

      // (DIC-1190 CR round 3) In no-fetch files, forbid ACQUIRING the fetch
      // primitive at all, not just calling it. The reviewer's wrapper bypass
      // (`const reviewRequest = globalThis.fetch; reviewRequest(url)`) is
      // caught here at the RHS of the const declaration — before the aliased
      // call in the uncalled function ever needs to be reached.
      if (isNoFetchFile) {
        // The RHS/initializer of a `const X = <fetch primitive>` acquires the
        // primitive. Also flag any bare reference to fetch/aliased fetch that
        // is not itself the LHS of a declaration and not a comment/string.
        // Restrict to Expression positions to avoid double-counting.
        const parent = node.parent;
        const isDeclarationName =
          parent &&
          (ts.isVariableDeclaration(parent) ||
            ts.isBindingElement(parent) ||
            ts.isParameter(parent) ||
            ts.isImportSpecifier(parent) ||
            ts.isImportClause(parent) ||
            ts.isNamespaceImport(parent) ||
            ts.isPropertyAssignment(parent) ||
            ts.isShorthandPropertyAssignment(parent)) &&
          parent.name === node;
        if (!isDeclarationName && isFetchPrimitiveRef(node, fetchAliases, bindings)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          violations.push({
            line: line + 1,
            kind: 'fetch primitive reference in no-fetch-allowed file',
            value: `${node.getText(sf).slice(0, 80).replace(/\s+/g, ' ')}`,
          });
        }
        // Also flag imports from FETCH_MODULE_NAMES at the module level.
        if (
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          FETCH_MODULE_NAMES.has(node.moduleSpecifier.text)
        ) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          violations.push({
            line: line + 1,
            kind: 'import from fetch-provider module in no-fetch-allowed file',
            value: node.moduleSpecifier.text,
          });
        }
      }

      if (isFetchCall(node, fetchAliases, bindings)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        if (isNoFetchFile) {
          violations.push({
            line: line + 1,
            kind: 'fetch() call in no-fetch-allowed file',
            value: `${node.getText(sf).slice(0, 80).replace(/\s+/g, ' ')}…`,
          });
        } else if (hostAllowlist) {
          // Normalise `.call/.apply` invocation semantics before host check
          // (DIC-1190 CR round 4 for dot access; round 5 for computed access;
          // round 6 for opaque computed member fail-closed).
          const urlSlot = extractFetchUrlArg(node, fetchAliases, bindings);
          const invocationShape = (() => {
            if (isOpaqueMemberOnFetchPrimitive(node.expression, fetchAliases, bindings)) {
              return 'opaque-member';
            }
            return callApplyMethodOf(node.expression, fetchAliases, bindings) || 'direct';
          })();

          let urlValue = null;
          if (urlSlot === UNRESOLVABLE_URL_ARG) {
            urlValue = null;
          } else if (urlSlot && typeof urlSlot === 'object' && 'syntheticFoldedString' in urlSlot) {
            urlValue = urlSlot.syntheticFoldedString;
          } else if (urlSlot) {
            urlValue = fold(urlSlot, bindings);
          }

          let ok = false;
          let describe = urlValue === null || urlValue === undefined ? '<unresolvable at parse time>' : String(urlValue);
          if (typeof urlValue === 'string') {
            try {
              const u = new URL(urlValue);
              if (hostAllowlist.has(u.host)) ok = true;
              describe = `host=${u.host}`;
            } catch {
              // Not a valid URL string
            }
          }
          if (!ok) {
            violations.push({
              line: line + 1,
              kind: 'fetch() URL not in host allowlist',
              value: `via ${invocationShape}: ${describe}; allowlist: ${[...hostAllowlist].join(', ')}`,
            });
          }
        }
      }

      ts.forEachChild(node, visit);
    }
    visit(sf);

    // Deduplicate: constant folding recurses, so a single assembled `openrouter.ai`
    // fires at every enclosing binary-plus node. Keep the innermost occurrence.
    const seen = new Set();
    return violations.filter((v) => {
      const k = `${v.line}:${v.kind}:${v.value}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // 7a. Real runtime files must be clean.
  for (const relPath of runtimeFiles) {
    const source = fs.readFileSync(repo(relPath), 'utf8');
    const unique = analyzeSource(relPath, source, {
      isNoFetchFile: noFetchAllowed.has(relPath),
      hostAllowlist: fetchHostAllowlist[relPath] || null,
    });
    check(`${relPath}: AST guard finds no assembled/computed OpenRouter reference or non-allowlisted fetch`, () => {
      assert.equal(
        unique.length,
        0,
        `AST guard found ${unique.length} violation(s):\n` +
          unique.map((v) => `  ${relPath}:${v.line} [${v.kind}] ${v.value}`).join('\n'),
      );
    });
  }

  // 7b. Mutation-sensitivity coverage (DIC-1190 CR): pin the guard against the
  // exact bypass shapes past reviewers have discovered. If a future refactor
  // ever weakens the folder or the fetch enforcement, these canaries fail
  // BEFORE the real runtime files get a chance to slip through unnoticed.
  const mutationCases = [
    {
      label: 'reviewer bypass: aliased env + `.join()` assembly of key + `+` assembly of host',
      // Simulates DIC-1190 CR round 1: aliased process.env + fragment concat.
      displayPath: 'test-fixture:reviewer-round-1.ts',
      isNoFetchFile: true,
      source: `
        export async function _unreachable() {
          const envAlias = process.env;
          const keyName = ['OPEN', 'ROUTER', '_API', '_KEY'].join('');
          const host = 'open' + 'router' + '.ai';
          const bearer = envAlias[keyName];
          if (bearer) {
            await fetch('https://' + host + '/api/v1/chat/completions', {
              headers: { Authorization: 'Bearer ' + bearer },
            });
          }
        }
      `,
      expectAtLeast: [
        'OPENROUTER_API_KEY env-key string',
        'openrouter.ai host string',
        'element access to OPENROUTER*',
        'fetch() call in no-fetch-allowed file',
      ],
    },
    {
      label: 'reviewer bypass: identifier-bound numeric decoders with no literals',
      // Simulates DIC-1190 CR round 2: uncalled function in api/hello.ts style.
      displayPath: 'test-fixture:reviewer-round-2.ts',
      isNoFetchFile: true,
      source: `
        const keyCodes = [79, 80, 69, 78, 82, 79, 85, 84, 69, 82, 95, 65, 80, 73, 95, 75, 69, 89];
        const hostCodes = [111, 112, 101, 110, 114, 111, 117, 116, 101, 114, 46, 97, 105];
        export async function _unreachable() {
          const envAlias = process.env;
          const keyName = keyCodes.map((c) => String.fromCharCode(c)).join('');
          const host = String.fromCharCode(...hostCodes);
          const bearer = envAlias[keyName];
          if (bearer) {
            await fetch('https://' + host + '/api/v1', {
              headers: { Authorization: 'Bearer ' + bearer },
            });
          }
        }
      `,
      expectAtLeast: [
        'OPENROUTER_API_KEY env-key string',
        'openrouter.ai host string',
        'element access to OPENROUTER*',
        'fetch() call in no-fetch-allowed file',
      ],
    },
    {
      label: 'smuggled fetch in fetch-allowed file (recognize-card): non-allowlisted host',
      displayPath: 'test-fixture:recognize-card-smuggle.ts',
      isNoFetchFile: false,
      hostAllowlist: new Set(['generativelanguage.googleapis.com', 'holohunter.dicoge.com']),
      source: `
        const otherCodes = [111, 112, 101, 110, 114, 111, 117, 116, 101, 114, 46, 97, 105];
        export async function _unreachableSmuggle() {
          const otherHost = String.fromCharCode(...otherCodes);
          await fetch('https://' + otherHost + '/api/v1/metrics');
        }
      `,
      expectAtLeast: [
        'openrouter.ai host string',
        'fetch() URL not in host allowlist',
      ],
    },
    {
      label: 'smuggled fetch in fetch-allowed file: URL unresolvable at parse time',
      displayPath: 'test-fixture:recognize-card-opaque.ts',
      isNoFetchFile: false,
      hostAllowlist: new Set(['generativelanguage.googleapis.com', 'holohunter.dicoge.com']),
      source: `
        export async function _opaque(dynamicUrl: string) {
          // A fetch to a runtime-computed URL that the folder cannot resolve
          // must still fail — "prove it's safe" not "detect that it's bad".
          await fetch(dynamicUrl);
        }
      `,
      expectAtLeast: ['fetch() URL not in host allowlist'],
    },
    {
      // DIC-1190 CR round 3: alias the fetch primitive itself so a static
      // `isFetchCall` that only recognises `fetch(...)` and `.fetch(...)`
      // misses the aliased call.
      label: 'reviewer round-3 bypass: `const R = globalThis.fetch` + base64 decoders + R(url)',
      displayPath: 'test-fixture:reviewer-round-3-wrapper.ts',
      isNoFetchFile: true,
      source: `
        const reviewRequest = globalThis.fetch;
        export async function _unreachable() {
          const envAlias = process.env;
          // Base64 decoders the folder does not trace — no plaintext for
          // the key name or the host anywhere in source.
          const keyName = Buffer.from('T1BFTlJPVVRFUl9BUElfS0VZ', 'base64').toString('utf8');
          const host = Buffer.from('b3BlbnJvdXRlci5haQ==', 'base64').toString('utf8');
          const bearer = envAlias[keyName];
          if (bearer) {
            await reviewRequest('https://' + host + '/api/v1', {
              method: 'POST',
              headers: { Authorization: 'Bearer ' + bearer },
            });
          }
        }
      `,
      expectAtLeast: [
        'fetch primitive reference in no-fetch-allowed file',
        'fetch() call in no-fetch-allowed file',
      ],
    },
    {
      label: 'wrapper bypass variants: destructuring, bind, and node-fetch import',
      displayPath: 'test-fixture:reviewer-round-3-variants.ts',
      isNoFetchFile: true,
      source: `
        import wrappedFetch from 'node-fetch';
        const { fetch: destructuredFetch } = globalThis;
        const boundFetch = globalThis.fetch.bind(null);
        const chained = destructuredFetch;
        export async function _v1() { await wrappedFetch('https://example.test'); }
        export async function _v2() { await destructuredFetch('https://example.test'); }
        export async function _v3() { await boundFetch('https://example.test'); }
        export async function _v4() { await chained('https://example.test'); }
      `,
      expectAtLeast: [
        'import from fetch-provider module in no-fetch-allowed file',
        'fetch primitive reference in no-fetch-allowed file',
        'fetch() call in no-fetch-allowed file',
      ],
    },
    {
      // In fetch-allowed files, an aliased fetch call must ALSO have its URL
      // resolved against the host allowlist. The wrapper bypass in
      // recognize-card would otherwise leak past URL enforcement.
      label: 'aliased fetch in fetch-allowed file: URL still enforced through wrapper',
      displayPath: 'test-fixture:recognize-card-alias-wrapper.ts',
      isNoFetchFile: false,
      hostAllowlist: new Set(['generativelanguage.googleapis.com', 'holohunter.dicoge.com']),
      source: `
        const R = globalThis.fetch;
        export async function _smuggle() {
          const host = Buffer.from('b3BlbnJvdXRlci5haQ==', 'base64').toString('utf8');
          await R('https://' + host + '/api/v1/metrics');
        }
      `,
      expectAtLeast: ['fetch() URL not in host allowlist'],
    },
    {
      // DIC-1190 CR round 4: fetch.call(<allowlistedUrl as thisArg>, <smuggled>)
      // argument 0 folds to an allowlisted URL; the REAL URL sits at
      // argument 1 (call semantics). The invocation-shape normaliser must
      // inspect argument 1, not argument 0.
      label: 'reviewer round-4 bypass: fetch.call(allowlistedHost, opaqueOpenRouterUrl)',
      displayPath: 'test-fixture:reviewer-round-4-call.ts',
      isNoFetchFile: false,
      hostAllowlist: new Set(['generativelanguage.googleapis.com', 'holohunter.dicoge.com']),
      source: `
        const DATABASE_URL = 'https://holohunter.dicoge.com/data/database.json';
        export async function _unreachable() {
          const openrouterUrl = Buffer.from('aHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MQ==', 'base64').toString('utf8');
          await fetch.call(DATABASE_URL, openrouterUrl, { method: 'POST' });
        }
      `,
      expectAtLeast: ['fetch() URL not in host allowlist'],
    },
    {
      // .apply(thisArg, [url, init]): the URL is arguments[1] element 0 when
      // the arguments array is a literal.
      label: 'reviewer round-4 bypass: fetch.apply(null, [opaqueOpenRouterUrl])',
      displayPath: 'test-fixture:reviewer-round-4-apply-literal.ts',
      isNoFetchFile: false,
      hostAllowlist: new Set(['generativelanguage.googleapis.com', 'holohunter.dicoge.com']),
      source: `
        export async function _unreachable() {
          const openrouterUrl = Buffer.from('aHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MQ==', 'base64').toString('utf8');
          await fetch.apply(null, [openrouterUrl, { method: 'POST' }]);
        }
      `,
      expectAtLeast: ['fetch() URL not in host allowlist'],
    },
    {
      // Opaque .apply arguments-array (non-literal): the URL slot cannot be
      // resolved statically → must fail closed. A reviewer must not be able
      // to launder a smuggled URL through an identifier-bound arguments array.
      label: 'reviewer round-4 bypass: fetch.apply with non-literal args array (fail-closed)',
      displayPath: 'test-fixture:reviewer-round-4-apply-opaque.ts',
      isNoFetchFile: false,
      hostAllowlist: new Set(['generativelanguage.googleapis.com', 'holohunter.dicoge.com']),
      source: `
        export async function _opaque(argsArray: unknown[]) {
          // The arguments array is a runtime value; the folder cannot see
          // through it. The URL check must fail closed.
          // @ts-ignore
          await fetch.apply(null, argsArray);
        }
      `,
      expectAtLeast: ['fetch() URL not in host allowlist'],
    },
    {
      // fetch.call via a wrapped alias — combines round-3 wrapping with
      // round-4 semantics. The guard must trace through both layers.
      label: 'wrapped-alias + .call combined: aliased fetch primitive used with .call semantics',
      displayPath: 'test-fixture:reviewer-round-4-wrapped-call.ts',
      isNoFetchFile: false,
      hostAllowlist: new Set(['generativelanguage.googleapis.com', 'holohunter.dicoge.com']),
      source: `
        const R = globalThis.fetch;
        const DATABASE_URL = 'https://holohunter.dicoge.com/data/database.json';
        export async function _unreachable() {
          const openrouterUrl = Buffer.from('aHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MQ==', 'base64').toString('utf8');
          await R.call(DATABASE_URL, openrouterUrl);
        }
      `,
      expectAtLeast: ['fetch() URL not in host allowlist'],
    },
    {
      // DIC-1190 CR round 5: computed-member forms of .call. R['call'](...) is
      // an ElementAccessExpression whose key folds to 'call'; the URL still
      // sits at arguments[1]. Dot-only detection missed this.
      label: "reviewer round-5 bypass: R['call'](allowlistedHost, opaqueOpenRouterUrl)",
      displayPath: 'test-fixture:reviewer-round-5-computed-call.ts',
      isNoFetchFile: false,
      hostAllowlist: new Set(['generativelanguage.googleapis.com', 'holohunter.dicoge.com']),
      source: `
        const DATABASE_URL = 'https://holohunter.dicoge.com/data/database.json';
        export async function _unreachable() {
          const R = globalThis.fetch;
          const openrouterUrl = Buffer.from('aHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MQ==', 'base64').toString('utf8');
          await R['call'](DATABASE_URL, openrouterUrl, { method: 'POST' });
        }
      `,
      expectAtLeast: ['fetch() URL not in host allowlist'],
    },
    {
      // R['apply'](...) — same story as .apply but through a computed key.
      label: "reviewer round-5 bypass: R['apply'](null, [opaqueOpenRouterUrl])",
      displayPath: 'test-fixture:reviewer-round-5-computed-apply.ts',
      isNoFetchFile: false,
      hostAllowlist: new Set(['generativelanguage.googleapis.com', 'holohunter.dicoge.com']),
      source: `
        export async function _unreachable() {
          const R = globalThis.fetch;
          const openrouterUrl = Buffer.from('aHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MQ==', 'base64').toString('utf8');
          await R['apply'](null, [openrouterUrl, { method: 'POST' }]);
        }
      `,
      expectAtLeast: ['fetch() URL not in host allowlist'],
    },
    {
      // Directly on the fetch identifier, computed form of .call.
      // Confirms the fold also crosses fetch['call'](...).
      label: "reviewer round-5 bypass: fetch['call'](allowlistedHost, opaqueOpenRouterUrl)",
      displayPath: 'test-fixture:reviewer-round-5-direct-computed-call.ts',
      isNoFetchFile: false,
      hostAllowlist: new Set(['generativelanguage.googleapis.com', 'holohunter.dicoge.com']),
      source: `
        const DATABASE_URL = 'https://holohunter.dicoge.com/data/database.json';
        export async function _unreachable() {
          const openrouterUrl = Buffer.from('aHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MQ==', 'base64').toString('utf8');
          await fetch['call'](DATABASE_URL, openrouterUrl);
        }
      `,
      expectAtLeast: ['fetch() URL not in host allowlist'],
    },
    {
      // Method key itself assembled from fragments: R[['c','a','l','l'].join('')].
      // The folder resolves the key to 'call' → invocation semantics kick in.
      label: 'reviewer round-5 bypass: computed key assembled from fragments (R[[…].join()])',
      displayPath: 'test-fixture:reviewer-round-5-assembled-key.ts',
      isNoFetchFile: false,
      hostAllowlist: new Set(['generativelanguage.googleapis.com', 'holohunter.dicoge.com']),
      source: `
        const DATABASE_URL = 'https://holohunter.dicoge.com/data/database.json';
        export async function _unreachable() {
          const R = globalThis.fetch;
          const openrouterUrl = Buffer.from('aHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MQ==', 'base64').toString('utf8');
          const method = ['c', 'a', 'l', 'l'].join('');
          await R[method](DATABASE_URL, openrouterUrl);
        }
      `,
      expectAtLeast: ['fetch() URL not in host allowlist'],
    },
    {
      // DIC-1190 CR round 6: the computed key itself is decoded at runtime
      // (e.g., `atob('Y2FsbA==')` → 'call'). The folder cannot see through
      // atob, so `resolveMember` returns null — but the receiver is a known
      // fetch primitive, so we must fail-closed regardless of the key.
      label: "reviewer round-6 bypass: R[atob('Y2FsbA==')](...) — runtime-decoded 'call' key",
      displayPath: 'test-fixture:reviewer-round-6-decoded-call.ts',
      isNoFetchFile: false,
      hostAllowlist: new Set(['generativelanguage.googleapis.com', 'holohunter.dicoge.com']),
      source: `
        const DATABASE_URL = 'https://holohunter.dicoge.com/data/database.json';
        export async function _unreachable() {
          const R = globalThis.fetch;
          const openrouterUrl = Buffer.from('aHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MQ==', 'base64').toString('utf8');
          const method = atob('Y2FsbA==');
          await R[method](DATABASE_URL, openrouterUrl);
        }
      `,
      expectAtLeast: ['fetch() URL not in host allowlist'],
    },
    {
      label: "reviewer round-6 bypass: R[atob('YXBwbHk=')](...) — runtime-decoded 'apply' key",
      displayPath: 'test-fixture:reviewer-round-6-decoded-apply.ts',
      isNoFetchFile: false,
      hostAllowlist: new Set(['generativelanguage.googleapis.com', 'holohunter.dicoge.com']),
      source: `
        export async function _unreachable() {
          const R = globalThis.fetch;
          const openrouterUrl = Buffer.from('aHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MQ==', 'base64').toString('utf8');
          const method = atob('YXBwbHk=');
          await R[method](null, [openrouterUrl, { method: 'POST' }]);
        }
      `,
      expectAtLeast: ['fetch() URL not in host allowlist'],
    },
    {
      // Direct opaque access on `fetch` itself (no alias). Even
      // fetch[runtimeKey](...) must fail-closed because we cannot prove the
      // key isn't `call`/`apply`.
      label: 'reviewer round-6 bypass: fetch[runtimeKey](...) directly on the primitive',
      displayPath: 'test-fixture:reviewer-round-6-direct-decoded.ts',
      isNoFetchFile: false,
      hostAllowlist: new Set(['generativelanguage.googleapis.com', 'holohunter.dicoge.com']),
      source: `
        const DATABASE_URL = 'https://holohunter.dicoge.com/data/database.json';
        export async function _unreachable(runtimeKey: string) {
          const openrouterUrl = Buffer.from('aHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MQ==', 'base64').toString('utf8');
          // @ts-ignore — reading an arbitrary key off fetch, callable at runtime
          await fetch[runtimeKey](DATABASE_URL, openrouterUrl);
        }
      `,
      expectAtLeast: ['fetch() URL not in host allowlist'],
    },
  ];

  for (const mc of mutationCases) {
    const analyzeOpts = {
      isNoFetchFile: !!mc.isNoFetchFile,
      hostAllowlist: mc.hostAllowlist || null,
    };
    const found = analyzeSource(mc.displayPath, mc.source, analyzeOpts);
    const foundKinds = new Set(found.map((v) => v.kind));
    check(`mutation coverage — ${mc.label}`, () => {
      const missing = mc.expectAtLeast.filter((k) => !foundKinds.has(k));
      assert.equal(
        missing.length,
        0,
        `AST guard missed expected violation kind(s): [${missing.join(', ')}]. ` +
          `Actual violations:\n` +
          (found.length
            ? found.map((v) => `  ${mc.displayPath}:${v.line} [${v.kind}] ${v.value}`).join('\n')
            : '  (none)'),
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

    check('add-zh-names.js addZhNames() never fails via OpenRouter fallback', () => {
      // Main's post-merge behavior throws when a card name has no Traditional-
      // Chinese entry — that is the pipeline's fail-closed data invariant, not
      // an OpenRouter contact. Any OTHER thrown error (or a network failure
      // reaching openrouter.ai) must still fail this suite. The subsequent
      // tripwires verify zero outbound fetches and zero OPENROUTER env reads.
      if (addZhError === null) return;
      assert.match(
        addZhError.message,
        /missing Traditional-Chinese names/,
        `unexpected addZhNames() error (not the missing-translations fail-closed): ${addZhError.stack}`,
      );
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
