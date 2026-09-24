#!/usr/bin/env node
/**
 * DIC-P0 hBP09 — GEMINI_API_KEY Production provisioning behaviour.
 *
 * The companion structural suite (test-exact-sha-production-recovery.mjs)
 * pins the WORKFLOW wiring: the presence gate, the step ordering, the env
 * plumbing, the closed secret set. This suite EXECUTES the committed module
 * `scripts/ci/provision-gemini-key.mjs` — the same file the deploy workflow
 * runs — against a mock transport, and proves the CR-565f798a remediation
 * contract by running the code:
 *
 *   1. a missing/empty GEMINI_API_KEY fails closed BEFORE any request exists
 *      (so, in the workflow, before any deployment could be created);
 *   2. the one request the module may make hits exactly the bounded Vercel
 *      v10 env upsert endpoint, as a sensitive var targeting Production ONLY;
 *   3. an API rejection or transport failure fails closed;
 *   4. no secret byte ever reaches a log line, the request URL, or argv —
 *      proven with canary values, plus a mutation check showing the canary
 *      detector actually fires on a leaking line.
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
  GEMINI_PROVISIONING_MESSAGES,
  buildGeminiEnvRequest,
  boundedStatus,
  provisionGeminiKey,
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

/** Run the module with a scripted transport, capturing every emitted line. */
async function run({ env, status = 200, throwOnFetch = false }) {
  const lines = [];
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (throwOnFetch) throw new Error('scripted transport failure ' + CANARY_KEY);
    return {
      status,
      // Poisoned body accessors: the module must never read a response body.
      text: () => { throw new Error('response body was read'); },
      json: () => { throw new Error('response body was read'); },
      arrayBuffer: () => { throw new Error('response body was read'); },
    };
  };
  const sink = (line) => lines.push(String(line));
  const result = await provisionGeminiKey({ env, fetchImpl, log: sink, logError: sink });
  return { result, lines, calls };
}

const leaks = (lines) => lines.filter(
  (l) => l.includes(CANARY_KEY) || l.includes(CANARY_TOKEN),
);

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
// 2 — the request contract: bounded endpoint, sensitive, Production-only,
//     secrets in body/header ONLY (never URL, never argv)
// ─────────────────────────────────────────────────────────────────────────
{
  const { result, lines, calls } = await run({ env: { ...GOOD_ENV }, status: 200 });
  check('a 200 upsert answer is success', result.code === PROVISION_SUCCESS,
    `got code=${result.code} reason=${result.reason}`);
  check('exactly ONE request is made', calls.length === 1,
    `transport was called ${calls.length} time(s)`);

  const { url, init } = calls[0] ?? { url: '', init: {} };
  check(
    'the request hits the exact bounded v10 Production env upsert endpoint',
    url === 'https://api.vercel.com/v10/projects/prj_canaryproject456/env?teamId=team_canaryorg123&upsert=true',
    `got url=${JSON.stringify(url)}`,
  );
  check('the request is a POST', init?.method === 'POST', `got ${init?.method}`);
  check(
    'the token travels ONLY in the Authorization header',
    init?.headers?.Authorization === 'Bearer ' + CANARY_TOKEN && !url.includes(CANARY_TOKEN),
    'a token in the URL would land in request logs everywhere along the path',
  );
  check('the key value never appears in the URL', !url.includes(CANARY_KEY));

  let body = null;
  try {
    body = JSON.parse(init?.body ?? '');
  } catch {
    check('the request body parses as JSON', false, 'unparseable body');
  }
  if (body) {
    check(
      'the body carries ONLY key/value/type/target',
      JSON.stringify(Object.keys(body).sort()) === JSON.stringify(['key', 'target', 'type', 'value']),
      `body keys: ${JSON.stringify(Object.keys(body).sort())}`,
    );
    check('the env var name is exactly GEMINI_API_KEY', body.key === 'GEMINI_API_KEY',
      `got ${JSON.stringify(body.key)}`);
    check('the value is the GitHub secret, verbatim', body.value === CANARY_KEY);
    check(
      'the var is SENSITIVE (Vercel refuses to read it back after creation)',
      body.type === 'sensitive',
      `got type=${JSON.stringify(body.type)}`,
    );
    check(
      'the target is Production ONLY — never preview, never development',
      JSON.stringify(body.target) === JSON.stringify(['production']),
      `got target=${JSON.stringify(body.target)}`,
    );
  }

  check('the success path emits the fixed provisioned line',
    lines.includes(GEMINI_PROVISIONING_MESSAGES.PROVISIONED),
    `lines: ${JSON.stringify(lines)}`);
  check('the success path leaks no secret into any line', leaks(lines).length === 0);

  const { result: created } = await run({ env: { ...GOOD_ENV }, status: 201 });
  check('a 201 (created) answer is success too', created.code === PROVISION_SUCCESS);
}

// ─────────────────────────────────────────────────────────────────────────
// 3 — API rejection / transport failure fail closed, without leaking
// ─────────────────────────────────────────────────────────────────────────
{
  for (const status of [400, 401, 403, 409, 429, 500]) {
    const { result, lines } = await run({ env: { ...GOOD_ENV }, status });
    check(`HTTP ${status} from the env API → fatal exit code`,
      result.code === PROVISION_FATAL, `got code=${result.code}`);
    check(`HTTP ${status} → the bounded status is reported, no secret leaks`,
      lines.some((l) => l.includes('HTTP ' + String(status))) && leaks(lines).length === 0,
      `lines: ${JSON.stringify(lines.map((l) => l.slice(0, 60)))}`);
  }
  const { result, lines } = await run({ env: { ...GOOD_ENV }, throwOnFetch: true });
  check('a transport-level failure → fatal exit code', result.code === PROVISION_FATAL);
  check(
    'a transport-level failure emits the fixed line, never the exception text',
    lines.length === 1
      && lines[0].includes(GEMINI_PROVISIONING_MESSAGES.REQUEST_FAILED)
      && leaks(lines).length === 0,
    `lines: ${JSON.stringify(lines)}`,
  );
  check('boundedStatus refuses non-integer shapes', boundedStatus('200\n200') === 'unreadable'
    && boundedStatus(undefined) === 'unreadable' && boundedStatus(99) === 'unreadable'
    && boundedStatus(503) === '503');
}

// ─────────────────────────────────────────────────────────────────────────
// 4 — MUTATION: the canary detector itself must be able to fire, and the
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
// 5 — the CLI file the workflow actually invokes runs, reads env not argv,
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
