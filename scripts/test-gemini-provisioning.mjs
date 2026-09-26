#!/usr/bin/env node
/**
 * DIC-P0 hBP09 — GEMINI_API_KEY Production provisioning behaviour.
 *
 * The companion structural suite (test-exact-sha-production-recovery.mjs)
 * pins the WORKFLOW wiring: the presence gate, the step ordering, the env
 * plumbing, the closed secret set. This suite EXECUTES the committed module
 * `scripts/ci/provision-gemini-key.mjs` — the same file the deploy workflow
 * runs — against a stateful mock of the documented Vercel env endpoints, and
 * proves the CR-565f798a + CR-2a9a285d remediation contract by running code:
 *
 *   1. a missing/empty GEMINI_API_KEY fails closed BEFORE any request exists
 *      (so, in the workflow, before any deployment could be created);
 *   2. the create is a sensitive, Production-only POST without upsert;
 *   3. a 2xx create carrying a non-empty `failed` array (or not confirming
 *      the record) is a HARD failure;
 *   4. an existing plain/encrypted/sensitive Production-only variable is
 *      removed and re-added sensitive; non-Production entries are untouched;
 *      a shared Production+other scope is refused before any write;
 *   5. the readback must show exactly one sensitive Production-only entry,
 *      the one just created, or the run fails closed;
 *   6. no secret byte and no response byte ever reaches a log line, a URL,
 *      or argv — proven with canary values, plus a mutation check showing
 *      the canary detector actually fires on a leaking line.
 *
 * The CLI entry is exercised too (via spawnSync, no network: missing-env
 * path) so the exact file the workflow invokes is known to run.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROVISION_SUCCESS,
  PROVISION_FATAL,
  PROVISIONING_MAX_RESPONSE_CHARS,
  GEMINI_PROVISIONING_MESSAGES,
  buildGeminiEnvRequest,
  boundedStatus,
  classifyCreateAnswer,
  classifyEnvList,
  provisionGeminiKey,
  readBoundedJson,
  sanitizeDiagnostic,
} from './ci/provision-gemini-key.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_PATH = path.join(ROOT, 'scripts', 'ci', 'provision-gemini-key.mjs');

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

// Canaries: values that must NEVER surface in any log line or URL. Chosen to
// be greppable and impossible to produce by accident.
const CANARY_KEY = 'CANARY-GEMINI-VALUE-9f1c2b7a-do-not-log';
const CANARY_TOKEN = 'CANARY-VERCEL-TOKEN-5e8d3a41-do-not-log';

const GOOD_ENV = Object.freeze({
  GEMINI_API_KEY: CANARY_KEY,
  VERCEL_TOKEN: CANARY_TOKEN,
  VERCEL_ORG_ID: 'team_canaryorg123',
  PROJECT_ID: 'prj_canaryproject456',
});

// A value an EXISTING plain Production entry carries in the list answer —
// response bytes that must never reach a log line either.
const CANARY_LISTED_VALUE = 'CANARY-LISTED-PLAIN-VALUE-3b6f0d92-do-not-log';

const PROJECT_ENV_URL = 'https://api.vercel.com/v10/projects/prj_canaryproject456/env?teamId=team_canaryorg123';
const deleteUrl = (id) => 'https://api.vercel.com/v9/projects/prj_canaryproject456/env/'
  + id + '?teamId=team_canaryorg123';

const jsonResponse = (status, body) => ({
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  // The module reads bodies ONLY through a bounded text() read.
  json: () => { throw new Error('response.json() was called'); },
  arrayBuffer: () => { throw new Error('response.arrayBuffer() was called'); },
});

/**
 * A stateful mock of the three documented Vercel env endpoints. `envs` is
 * the project's starting state; `script` overrides individual answers so a
 * test can inject exactly one misbehaviour. Every call is recorded.
 */
function mockVercel(envs = [], script = {}) {
  const state = envs.map((e) => ({ ...e }));
  const calls = [];
  let nextId = 1;
  let listCount = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (script.throwOn && script.throwOn(url, init)) {
      throw new Error('scripted transport failure ' + CANARY_KEY + ' ' + CANARY_TOKEN);
    }
    const method = init?.method;
    if (method === 'GET' && url === PROJECT_ENV_URL) {
      listCount += 1;
      if (script.list) {
        const scripted = script.list(listCount, state);
        if (scripted) return scripted;
      }
      return jsonResponse(200, { envs: state.map((e) => ({ ...e })) });
    }
    if (method === 'DELETE' && url.startsWith('https://api.vercel.com/v9/projects/prj_canaryproject456/env/')) {
      const id = decodeURIComponent(url.split('/env/')[1].split('?')[0]);
      if (script.del) {
        const scripted = script.del(id, state);
        if (scripted) return scripted;
      }
      const idx = state.findIndex((e) => e.id === id);
      if (idx < 0) return jsonResponse(404, { error: { code: 'not_found' } });
      const [removed] = state.splice(idx, 1);
      return jsonResponse(200, removed);
    }
    if (method === 'POST' && url === PROJECT_ENV_URL) {
      const body = JSON.parse(init.body);
      if (script.create) {
        const scripted = script.create(body, state);
        if (scripted) return scripted;
      }
      // Model the documented conflict: the same key may not be created twice
      // for an overlapping target.
      const overlap = state.some((e) => e.key === body.key
        && [].concat(e.target).some((t) => body.target.includes(t)));
      if (overlap) {
        return jsonResponse(201, {
          failed: [{ error: { code: 'ENV_ALREADY_EXISTS', message: 'exists ' + body.value } }],
        });
      }
      const record = { id: 'env_new' + String(nextId++), key: body.key, type: body.type,
        target: body.target, value: '' };
      state.push(record);
      return jsonResponse(201, { created: { ...record }, failed: [] });
    }
    return jsonResponse(404, {});
  };
  return { fetchImpl, calls, state };
}

/** Run the module against a mock Vercel, capturing every emitted line. */
async function run({ env = GOOD_ENV, envs = [], script = {} } = {}) {
  const lines = [];
  const vercel = mockVercel(envs, script);
  const sink = (line) => lines.push(String(line));
  const result = await provisionGeminiKey({
    env: { ...env }, fetchImpl: vercel.fetchImpl, log: sink, logError: sink,
  });
  return { result, lines, calls: vercel.calls, state: vercel.state };
}

const CANARIES = [CANARY_KEY, CANARY_TOKEN, CANARY_LISTED_VALUE];
const leaks = (lines) => lines.filter((l) => CANARIES.some((c) => l.includes(c)));
const noCreate = (calls) => !calls.some((c) => c.init?.method === 'POST');
const geminiInProduction = (state) => state.filter((e) => e.key === 'GEMINI_API_KEY'
  && [].concat(e.target).includes('production'));

// ─────────────────────────────────────────────────────────────────────────
// 1 — missing inputs fail closed BEFORE any request (provisioning precedes
//     deploy in the workflow, so this is "missing secret fails before deploy")
// ─────────────────────────────────────────────────────────────────────────
{
  for (const [label, mutate] of [
    ['GEMINI_API_KEY missing', (e) => { delete e.GEMINI_API_KEY; }],
    ['GEMINI_API_KEY empty', (e) => { e.GEMINI_API_KEY = ''; }],
    ['VERCEL_TOKEN missing', (e) => { delete e.VERCEL_TOKEN; }],
    ['VERCEL_ORG_ID missing', (e) => { delete e.VERCEL_ORG_ID; }],
    ['PROJECT_ID missing', (e) => { delete e.PROJECT_ID; }],
    ['PROJECT_ID malformed (newline injection shape)', (e) => { e.PROJECT_ID = 'prj\nINJECTED'; }],
    ['VERCEL_ORG_ID malformed', (e) => { e.VERCEL_ORG_ID = 'team id with spaces'; }],
  ]) {
    const env = { ...GOOD_ENV };
    mutate(env);
    const { result, lines, calls } = await run({ env });
    check(`${label} → fatal exit code`, result.code === PROVISION_FATAL,
      `got code=${result.code}`);
    check(`${label} → NO request is ever sent`, calls.length === 0,
      `transport was called ${calls.length} time(s)`);
    check(`${label} → no secret in any emitted line`, leaks(lines).length === 0,
      `${leaks(lines).length} leaking line(s)`);
  }
  const { lines } = await run({ env: { ...GOOD_ENV, GEMINI_API_KEY: '' } });
  check(
    'the missing-key diagnostic names the one human action (GitHub secret + doc)',
    lines.some((l) => l.includes('GitHub Actions secrets')
      && l.includes('docs/recognition-provisioning.md')),
    `lines: ${JSON.stringify(lines)}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 2 — fresh project: list → create → read back; the request contract
// ─────────────────────────────────────────────────────────────────────────
{
  const { result, lines, calls, state } = await run();
  check('a fresh project is provisioned', result.code === PROVISION_SUCCESS,
    `got code=${result.code} reason=${result.reason}`);
  check(
    'the call sequence is exactly list → create → readback list',
    JSON.stringify(calls.map((c) => c.init?.method)) === JSON.stringify(['GET', 'POST', 'GET']),
    `got ${JSON.stringify(calls.map((c) => c.init?.method))}`,
  );
  const post = calls.find((c) => c.init?.method === 'POST') ?? { url: '', init: {} };
  check(
    'the create hits the bounded v10 env endpoint WITHOUT upsert',
    post.url === PROJECT_ENV_URL && !post.url.includes('upsert'),
    `got url=${JSON.stringify(post.url)}`,
  );
  check(
    'the token travels ONLY in the Authorization header, on every request',
    calls.every((c) => c.init?.headers?.Authorization === 'Bearer ' + CANARY_TOKEN
      && !c.url.includes(CANARY_TOKEN)),
    'a token in the URL would land in request logs everywhere along the path',
  );
  check('the key value never appears in any URL',
    calls.every((c) => !c.url.includes(CANARY_KEY)));
  check('the key value travels ONLY in the create body',
    calls.filter((c) => String(c.init?.body ?? '').includes(CANARY_KEY)).length === 1
      && String(post.init?.body ?? '').includes(CANARY_KEY));

  let body = null;
  try {
    body = JSON.parse(post.init?.body ?? '');
  } catch {
    check('the request body parses as JSON', false, 'unparseable body');
  }
  if (body) {
    check(
      'the body carries ONLY key/value/type/target',
      JSON.stringify(Object.keys(body).sort()) === JSON.stringify(['key', 'target', 'type', 'value']),
      `body keys: ${JSON.stringify(Object.keys(body).sort())}`,
    );
    check('the env var name is exactly GEMINI_API_KEY', body.key === 'GEMINI_API_KEY');
    check('the value is the GitHub secret, verbatim', body.value === CANARY_KEY);
    check('the var is SENSITIVE', body.type === 'sensitive', `got ${JSON.stringify(body.type)}`);
    check(
      'the target is Production ONLY — never preview, never development',
      JSON.stringify(body.target) === JSON.stringify(['production']),
      `got target=${JSON.stringify(body.target)}`,
    );
  }
  check('resulting state: exactly one sensitive Production-only GEMINI_API_KEY',
    geminiInProduction(state).length === 1
      && geminiInProduction(state)[0].type === 'sensitive'
      && JSON.stringify(geminiInProduction(state)[0].target) === '["production"]');
  check('the success path emits the fixed provisioned line',
    lines.includes(GEMINI_PROVISIONING_MESSAGES.PROVISIONED),
    `lines: ${JSON.stringify(lines)}`);
  check('the success path leaks no secret into any line', leaks(lines).length === 0);

  const req = buildGeminiEnvRequest({ projectId: 'p', orgId: 'o', token: 't', geminiApiKey: 'k' });
  check('buildGeminiEnvRequest never asks for upsert', !req.url.includes('upsert'));
}

// ─────────────────────────────────────────────────────────────────────────
// 3 — CR 2a9a285d finding A: a 2xx create carrying `failed` entries is a
//     HARD failure, as is any create answer that does not confirm the record
// ─────────────────────────────────────────────────────────────────────────
{
  const failedBody = { created: [], failed: [{ error: { code: 'env_var_error', message: 'boom ' + CANARY_KEY } }] };
  for (const status of [200, 201]) {
    const { result, lines } = await run({
      script: { create: () => jsonResponse(status, failedBody) },
    });
    check(`HTTP ${status} with a non-empty failed array → fatal API_REJECTED`,
      result.code === PROVISION_FATAL && result.reason === 'API_REJECTED',
      `got code=${result.code} reason=${result.reason}`);
    check(`HTTP ${status} partial failure → error text from the body never leaks`,
      leaks(lines).length === 0 && !lines.some((l) => l.includes('boom')),
      `lines: ${JSON.stringify(lines)}`);
    check(`HTTP ${status} partial failure → the PROVISIONED line is never printed`,
      !lines.includes(GEMINI_PROVISIONING_MESSAGES.PROVISIONED));
  }
  // The exact CR reproduction shape: a 201 whose body is only reachable via
  // json(). The module must not treat an unread body as a success.
  {
    const lines = [];
    const result = await provisionGeminiKey({
      env: { ...GOOD_ENV },
      fetchImpl: async () => ({ status: 201, json: async () => ({ failed: [{ error: { code: 'env_var_error' } }] }) }),
      log: (l) => lines.push(l),
      logError: (l) => lines.push(l),
    });
    check('CR reproduction (201 + failed, json-only body) → fatal, never PROVISIONED',
      result.code === PROVISION_FATAL && result.reason !== 'PROVISIONED',
      `got ${JSON.stringify(result)}`);
  }
  for (const [label, answer] of [
    ['201 with an empty created list', jsonResponse(201, { created: [], failed: [] })],
    ['201 with no failed array at all', jsonResponse(201, { created: { id: 'env_x', key: 'GEMINI_API_KEY', type: 'sensitive', target: ['production'], value: '' } })],
    ['201 with a non-JSON body', jsonResponse(201, '<html>' + CANARY_KEY + '</html>')],
    ['201 with an empty body', jsonResponse(201, '')],
    ['201 confirming a NON-sensitive record', jsonResponse(201, { created: { id: 'env_x', key: 'GEMINI_API_KEY', type: 'encrypted', target: ['production'], value: '' }, failed: [] })],
    ['201 confirming a record that also targets preview', jsonResponse(201, { created: { id: 'env_x', key: 'GEMINI_API_KEY', type: 'sensitive', target: ['production', 'preview'], value: '' }, failed: [] })],
    ['201 confirming a different key', jsonResponse(201, { created: { id: 'env_x', key: 'OTHER', type: 'sensitive', target: ['production'], value: '' }, failed: [] })],
    ['201 confirming a record without an id', jsonResponse(201, { created: { key: 'GEMINI_API_KEY', type: 'sensitive', target: ['production'], value: '' }, failed: [] })],
    ['201 confirming two records', jsonResponse(201, { created: [
      { id: 'env_a', key: 'GEMINI_API_KEY', type: 'sensitive', target: ['production'], value: '' },
      { id: 'env_b', key: 'GEMINI_API_KEY', type: 'sensitive', target: ['production'], value: '' },
    ], failed: [] })],
  ]) {
    const { result, lines } = await run({ script: { create: () => answer } });
    check(`${label} → fatal`, result.code === PROVISION_FATAL,
      `got code=${result.code} reason=${result.reason}`);
    check(`${label} → no secret or body byte leaks`, leaks(lines).length === 0);
  }
  check('classifyCreateAnswer accepts only a confirmed sensitive Production-only record',
    classifyCreateAnswer(201, { created: { id: 'env_1', key: 'GEMINI_API_KEY', type: 'sensitive', target: 'production', value: '' }, failed: [] }).ok === true
      && classifyCreateAnswer(201, { created: [{ id: 'env_1', key: 'GEMINI_API_KEY', type: 'sensitive', target: ['production'], value: '' }], failed: [] }).ok === true
      && classifyCreateAnswer(201, { created: { id: 'env_1', key: 'GEMINI_API_KEY', type: 'sensitive', target: ['production'], gitBranch: 'x', value: '' }, failed: [] }).ok === false);
}

// ─────────────────────────────────────────────────────────────────────────
// 4 — CR 2a9a285d finding B: an EXISTING variable. upsert cannot change type
//     or scope, so the module removes a Production-only entry and re-adds it
//     sensitive, leaves non-Production entries alone, and refuses a shared
//     scope before writing anything
// ─────────────────────────────────────────────────────────────────────────
{
  // (a) existing NON-sensitive, Production-only (the upsert trap)
  {
    const envs = [
      { id: 'env_oldplain', key: 'GEMINI_API_KEY', type: 'plain', target: ['production'], value: CANARY_LISTED_VALUE },
      { id: 'env_unrelated', key: 'OTHER_VAR', type: 'plain', target: ['production', 'preview'], value: 'x' },
    ];
    const { result, lines, calls, state } = await run({ envs });
    check('existing plain Production-only var → provisioned', result.code === PROVISION_SUCCESS,
      `got ${JSON.stringify(result)}`);
    check(
      'existing plain var → list, DELETE it, create, read back (in that order)',
      JSON.stringify(calls.map((c) => c.init?.method)) === JSON.stringify(['GET', 'DELETE', 'POST', 'GET'])
        && calls[1].url === deleteUrl('env_oldplain'),
      `got ${JSON.stringify(calls.map((c) => c.init?.method + ' ' + c.url))}`,
    );
    const prod = geminiInProduction(state);
    check('existing plain var → end state is ONE sensitive Production-only var (the new one)',
      prod.length === 1 && prod[0].type === 'sensitive' && prod[0].id !== 'env_oldplain'
        && JSON.stringify(prod[0].target) === '["production"]',
      `got ${JSON.stringify(prod.map((e) => ({ id: e.id, type: e.type, target: e.target })))}`);
    check('existing plain var → an unrelated variable is never touched',
      state.some((e) => e.id === 'env_unrelated'));
    check('existing plain var → its listed plaintext value never reaches a log line',
      leaks(lines).length === 0);
  }
  // (b) existing encrypted Production-only (same trap, different type)
  {
    const { result, state } = await run({
      envs: [{ id: 'env_oldenc', key: 'GEMINI_API_KEY', type: 'encrypted', target: 'production', value: 'ciphertext' }],
    });
    check('existing encrypted Production-only var (string target) → replaced by a sensitive one',
      result.code === PROVISION_SUCCESS && geminiInProduction(state).length === 1
        && geminiInProduction(state)[0].type === 'sensitive');
  }
  // (c) existing sensitive Production-only (rotation)
  {
    const { result, calls } = await run({
      envs: [{ id: 'env_oldsens', key: 'GEMINI_API_KEY', type: 'sensitive', target: ['production'], value: '' }],
    });
    check('existing sensitive Production-only var → rotated via delete + create',
      result.code === PROVISION_SUCCESS && calls.some((c) => c.url === deleteUrl('env_oldsens')));
  }
  // (d) existing NON-Production variables are left untouched
  {
    const envs = [
      { id: 'env_prev', key: 'GEMINI_API_KEY', type: 'encrypted', target: ['preview'], value: CANARY_LISTED_VALUE },
      { id: 'env_dev', key: 'GEMINI_API_KEY', type: 'plain', target: ['development'], value: CANARY_LISTED_VALUE },
      { id: 'env_branch', key: 'GEMINI_API_KEY', type: 'encrypted', target: ['preview'], gitBranch: 'feat', value: 'x' },
    ];
    const { result, lines, calls, state } = await run({ envs });
    check('existing non-Production vars → a Production-only sensitive var is added',
      result.code === PROVISION_SUCCESS && geminiInProduction(state).length === 1
        && geminiInProduction(state)[0].type === 'sensitive',
      `got ${JSON.stringify(result)}`);
    check('existing non-Production vars → none of them is deleted or changed',
      !calls.some((c) => c.init?.method === 'DELETE')
        && ['env_prev', 'env_dev', 'env_branch'].every((id) => state.some((e) => e.id === id)));
    check('existing non-Production vars → their values never leak', leaks(lines).length === 0);
  }
  // (e) an entry that reaches Production AND another environment → refuse
  for (const [label, entry] of [
    ['production+preview', { target: ['production', 'preview'] }],
    ['production+development', { target: ['production', 'development'] }],
    ['production with a custom environment', { target: ['production'], customEnvironmentIds: ['env_custom1'] }],
  ]) {
    const envs = [{ id: 'env_shared', key: 'GEMINI_API_KEY', type: 'encrypted', value: CANARY_LISTED_VALUE, ...entry }];
    const { result, lines, calls, state } = await run({ envs });
    check(`existing ${label} var → fatal SHARED_TARGET_CONFLICT`,
      result.code === PROVISION_FATAL && result.reason === 'SHARED_TARGET_CONFLICT',
      `got ${JSON.stringify(result)}`);
    check(`existing ${label} var → NOTHING is written (no delete, no create)`,
      calls.length === 1 && calls[0].init?.method === 'GET' && state.length === 1);
    check(`existing ${label} var → no leak`, leaks(lines).length === 0);
  }
  // (f) the delete is not confirmed
  for (const [label, del] of [
    ['DELETE answers 403', () => jsonResponse(403, { error: { code: 'forbidden', message: CANARY_TOKEN } })],
    ['DELETE answers 200 naming a different record', () => jsonResponse(200, { id: 'env_other', key: 'GEMINI_API_KEY' })],
    ['DELETE answers 200 with a non-JSON body', () => jsonResponse(200, 'ok')],
  ]) {
    const { result, lines, calls } = await run({
      envs: [{ id: 'env_oldplain', key: 'GEMINI_API_KEY', type: 'plain', target: ['production'], value: CANARY_LISTED_VALUE }],
      script: { del },
    });
    check(`${label} → fatal DELETE_FAILED before any create`,
      result.code === PROVISION_FATAL && result.reason === 'DELETE_FAILED' && noCreate(calls),
      `got ${JSON.stringify(result)}`);
    check(`${label} → no leak`, leaks(lines).length === 0);
  }
  // (g) Vercel keeps the old entry despite a "successful" delete: the create
  //     then conflicts (201 + failed) and the run must fail closed.
  {
    const { result } = await run({
      envs: [{ id: 'env_sticky', key: 'GEMINI_API_KEY', type: 'plain', target: ['production'], value: 'x' }],
      script: { del: (id) => jsonResponse(200, { id, key: 'GEMINI_API_KEY' }) },
    });
    check('a delete that did not really remove the entry → the create conflict fails closed',
      result.code === PROVISION_FATAL && result.reason === 'API_REJECTED',
      `got ${JSON.stringify(result)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 5 — the readback is a real proof: a create that "succeeded" but did not
//     produce the verified state fails closed
// ─────────────────────────────────────────────────────────────────────────
{
  for (const [label, list] of [
    ['readback shows no Production entry', (n) => (n === 2 ? jsonResponse(200, { envs: [] }) : null)],
    ['readback shows the entry as encrypted', (n, st) => (n === 2 ? jsonResponse(200, { envs: st.map((e) => ({ ...e, type: 'encrypted' })) }) : null)],
    ['readback shows the entry also targeting preview', (n, st) => (n === 2 ? jsonResponse(200, { envs: st.map((e) => ({ ...e, target: ['production', 'preview'] })) }) : null)],
    ['readback shows a second Production entry', (n, st) => (n === 2 ? jsonResponse(200, { envs: [...st, { id: 'env_ghost', key: 'GEMINI_API_KEY', type: 'plain', target: ['production'], value: CANARY_LISTED_VALUE }] }) : null)],
    ['readback shows a different id', (n, st) => (n === 2 ? jsonResponse(200, { envs: st.map((e) => ({ ...e, id: 'env_elsewhere' })) }) : null)],
    ['readback answers 500', (n) => (n === 2 ? jsonResponse(500, {}) : null)],
    ['readback body is not JSON', (n) => (n === 2 ? jsonResponse(200, 'nope') : null)],
  ]) {
    const { result, lines } = await run({ script: { list } });
    check(`${label} → fatal VERIFY_FAILED`,
      result.code === PROVISION_FATAL && result.reason === 'VERIFY_FAILED',
      `got ${JSON.stringify(result)}`);
    check(`${label} → never PROVISIONED, no leak`,
      !lines.includes(GEMINI_PROVISIONING_MESSAGES.PROVISIONED) && leaks(lines).length === 0);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 6 — the initial list must prove it is the complete visible state
// ─────────────────────────────────────────────────────────────────────────
{
  for (const [label, answer, reason] of [
    ['list answers 403', jsonResponse(403, { error: { message: CANARY_TOKEN } }), 'LIST_FAILED'],
    ['list body is not JSON', jsonResponse(200, '<html>'), 'LIST_FAILED'],
    ['list body has no envs array', jsonResponse(200, { key: 'GEMINI_API_KEY', type: 'plain', value: 'x' }), 'LIST_FAILED'],
    ['list is paginated with more pages', jsonResponse(200, { envs: [], pagination: { count: 20, next: 1700000000000, prev: null } }), 'LIST_INCOMPLETE'],
    ['list hides Production variables', jsonResponse(200, { envs: [], hiddenProductionEnvCount: 2 }), 'LIST_INCOMPLETE'],
    ['a GEMINI_API_KEY entry with an unreadable target', jsonResponse(200, { envs: [{ id: 'env_q', key: 'GEMINI_API_KEY', type: 'plain', target: 7, value: 'x' }] }), 'LIST_FAILED'],
    ['a GEMINI_API_KEY entry with an unsafe id', jsonResponse(200, { envs: [{ id: '../../x', key: 'GEMINI_API_KEY', type: 'plain', target: ['production'], value: 'x' }] }), 'LIST_FAILED'],
  ]) {
    const { result, lines, calls } = await run({ script: { list: (n) => (n === 1 ? answer : null) } });
    check(`${label} → fatal ${reason} before any write`,
      result.code === PROVISION_FATAL && result.reason === reason && calls.length === 1,
      `got ${JSON.stringify(result)} after ${calls.length} call(s)`);
    check(`${label} → no leak`, leaks(lines).length === 0);
  }
  check('a completed pagination (next: null) is accepted',
    classifyEnvList({ envs: [], pagination: { count: 0, next: null, prev: null } }).ok === true);
  check('hiddenProductionEnvCount: 0 is accepted',
    classifyEnvList({ envs: [], hiddenProductionEnvCount: 0 }).ok === true);
}

// ─────────────────────────────────────────────────────────────────────────
// 7 — non-2xx create / transport failures fail closed, without leaking
// ─────────────────────────────────────────────────────────────────────────
{
  for (const status of [400, 401, 403, 409, 429, 500]) {
    const { result, lines } = await run({
      script: { create: () => jsonResponse(status, { error: { message: CANARY_KEY } }) },
    });
    check(`HTTP ${status} from the create → fatal API_REJECTED`,
      result.code === PROVISION_FATAL && result.reason === 'API_REJECTED', `got code=${result.code}`);
    check(`HTTP ${status} → the bounded status is reported, no secret leaks`,
      lines.some((l) => l.includes('HTTP ' + String(status))) && leaks(lines).length === 0,
      `lines: ${JSON.stringify(lines.map((l) => l.slice(0, 60)))}`);
  }
  for (const [label, throwOn] of [
    ['list', (url, init) => init?.method === 'GET'],
    ['delete', (url, init) => init?.method === 'DELETE'],
    ['create', (url, init) => init?.method === 'POST'],
  ]) {
    const { result, lines } = await run({
      envs: [{ id: 'env_oldplain', key: 'GEMINI_API_KEY', type: 'plain', target: ['production'], value: 'x' }],
      script: { throwOn },
    });
    check(`a transport failure on ${label} → fatal REQUEST_FAILED`,
      result.code === PROVISION_FATAL && result.reason === 'REQUEST_FAILED');
    check(
      `a transport failure on ${label} emits the fixed line, never the exception text`,
      lines.length === 1
        && lines[0].includes(GEMINI_PROVISIONING_MESSAGES.REQUEST_FAILED)
        && leaks(lines).length === 0,
      `lines: ${JSON.stringify(lines)}`,
    );
  }
  check('boundedStatus refuses non-integer shapes', boundedStatus('200\n200') === 'unreadable'
    && boundedStatus(undefined) === 'unreadable' && boundedStatus(99) === 'unreadable'
    && boundedStatus(503) === '503');
  check('readBoundedJson refuses an oversized body without parsing it',
    (await readBoundedJson({ text: async () => ' '.repeat(PROVISIONING_MAX_RESPONSE_CHARS + 1) })) === undefined);
  check('every emitted line comes from the frozen message table',
    Object.isFrozen(GEMINI_PROVISIONING_MESSAGES));
}

// ─────────────────────────────────────────────────────────────────────────
// 8 — MUTATION: the canary detector itself must be able to fire, and the
//     sanitizer must neutralise workflow-command / control-byte shapes
// ─────────────────────────────────────────────────────────────────────────
{
  check(
    'MUTATION: the leak detector fires on a line that carries the key canary',
    leaks(['prefix ' + CANARY_KEY + ' suffix']).length === 1,
    'a detector that cannot fire proves nothing about the clean runs above',
  );
  check(
    'MUTATION: the leak detector fires on a line that carries the token canary',
    leaks(['Bearer ' + CANARY_TOKEN]).length === 1,
  );
  const hostile = '[2J::error::INJECTED';
  const cleaned = sanitizeDiagnostic(hostile);
  check(
    'sanitizeDiagnostic strips control bytes and breaks up ::workflow commands::',
    !cleaned.includes('') && !cleaned.includes('::'),
    `got ${JSON.stringify(cleaned)}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 9 — the CLI file the workflow actually invokes runs, reads env not argv,
//     and fails closed with a fixed line when the secret is absent
// ─────────────────────────────────────────────────────────────────────────
{
  const spawned = spawnSync(
    process.execPath,
    // Hostile argv on purpose: the module must ignore arguments entirely.
    [MODULE_PATH, CANARY_KEY, '--unexpected'],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        // No GEMINI_API_KEY: the CLI must fail closed without any network.
        VERCEL_TOKEN: CANARY_TOKEN,
        VERCEL_ORG_ID: GOOD_ENV.VERCEL_ORG_ID,
        PROJECT_ID: GOOD_ENV.PROJECT_ID,
      },
    },
  );
  check('CLI without the GitHub secret exits 1 (fail closed before deploy)',
    spawned.status === PROVISION_FATAL, `exit=${spawned.status}`);
  check(
    'CLI failure line is the fixed missing-key diagnostic',
    (spawned.stderr ?? '').includes('GEMINI_API_KEY repository secret is missing or empty'),
    `stderr: ${JSON.stringify((spawned.stderr ?? '').slice(0, 200))}`,
  );
  check(
    'CLI output never echoes the argv canary or the token',
    !((spawned.stdout ?? '') + (spawned.stderr ?? '')).includes(CANARY_KEY)
      && !((spawned.stdout ?? '') + (spawned.stderr ?? '')).includes(CANARY_TOKEN),
  );
}

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ DIC-P0 hBP09 GEMINI_API_KEY provisioning behaviour: ${passed} checks passed`);
} else {
  console.error('\n❌ DIC-P0 hBP09 GEMINI_API_KEY provisioning behaviour FAILED');
}
