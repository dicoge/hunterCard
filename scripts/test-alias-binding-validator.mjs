#!/usr/bin/env node
/**
 * DIC-1430 — BEHAVIOURAL tests for the canonical alias binding validator.
 *
 * Why this file exists
 * --------------------
 * The companion suite `test-exact-sha-production-recovery.mjs` asserts the
 * SHAPE of the deploy workflow: which endpoints it calls, which it must never
 * call, what order the steps run in. Those checks are string and regex matches
 * over YAML, and they are worth keeping — but they cannot see behaviour. The
 * inline alias validator shipped a High-severity bug (a missing top-level
 * `deploymentId` was accepted whenever the optional nested `deployment.id`
 * matched) and all 89 of those checks passed, because not one of them ran the
 * validator.
 *
 * So this file executes the REAL production module —
 * `scripts/ci/verify-alias-binding.mjs`, the same file the workflow invokes —
 * against fixtures. Two ways, deliberately:
 *
 *   * by import, to assert the decision and its message; and
 *   * by subprocess, to assert the process EXIT CODE the workflow branches on,
 *     since a correct decision reported through the wrong exit code would let
 *     a fatal record retry, or a mismatch be read as success.
 *
 * There is no second copy of the validator here. The only re-implementation in
 * this file is `priorInlineValidator` — the OLD, buggy logic, preserved solely
 * to prove the regression is really gone and would be caught again.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALIAS_BINDING_FATAL,
  ALIAS_BINDING_RETRY,
  ALIAS_BINDING_SUCCESS,
  evaluateAliasBinding,
} from './ci/verify-alias-binding.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = path.join(ROOT, 'scripts', 'ci', 'verify-alias-binding.mjs');

const HOST = 'holohunter.dicoge.com';
const THIS_RUN = 'dpl_thisRunDeployment0000000001';
const OTHER_RUN = 'dpl_someoneElsesDeployment000002';

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
function runHelper(raw, expectedId = THIS_RUN, host = HOST) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-binding-'));
  const file = path.join(dir, 'alias-binding.json');
  try {
    fs.writeFileSync(file, raw);
    const r = spawnSync(process.execPath, [HELPER, file, host, expectedId], {
      encoding: 'utf8',
    });
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const decide = (raw, expectedId = THIS_RUN) =>
  evaluateAliasBinding({ raw, host: HOST, expectedDeploymentId: expectedId });

// ─────────────────────────────────────────────────────────────────────────
// Fixtures — every shape the alias API can hand back on a 200, plus the
// shapes that mean the response is not trustworthy at all.
// ─────────────────────────────────────────────────────────────────────────
const FIXTURES = [
  {
    name: 'valid, top-level id only (nested mirror absent)',
    raw: JSON.stringify({ alias: HOST, deploymentId: THIS_RUN }),
    expect: 'success',
  },
  {
    name: 'valid, top-level id with a matching nested deployment.id',
    raw: JSON.stringify({
      alias: HOST,
      deploymentId: THIS_RUN,
      deployment: { id: THIS_RUN, url: 'holocard-hunter.vercel.app' },
    }),
    expect: 'success',
  },
  {
    name: 'malformed JSON',
    raw: '{"alias": "holohunter.dicoge.com", "deploymentId": ',
    expect: 'fatal',
  },
  {
    name: 'explicit API error object',
    raw: JSON.stringify({ error: { code: 'forbidden', message: 'Not authorized' } }),
    expect: 'fatal',
  },
  {
    name: 'THE REGRESSION: top-level id absent, nested deployment.id matches',
    raw: JSON.stringify({ alias: HOST, deployment: { id: THIS_RUN } }),
    expect: 'fatal',
  },
  {
    name: 'top-level id is an empty string',
    raw: JSON.stringify({ alias: HOST, deploymentId: '' }),
    expect: 'fatal',
  },
  {
    name: 'top-level id is the wrong type (number)',
    raw: JSON.stringify({ alias: HOST, deploymentId: 12345 }),
    expect: 'fatal',
  },
  {
    name: 'top-level id is null',
    raw: JSON.stringify({ alias: HOST, deploymentId: null }),
    expect: 'fatal',
  },
  {
    name: 'nested deployment.id conflicts with the top-level id',
    raw: JSON.stringify({
      alias: HOST,
      deploymentId: THIS_RUN,
      deployment: { id: OTHER_RUN },
    }),
    expect: 'fatal',
  },
  {
    name: 'nested deployment.id is present but the wrong type',
    raw: JSON.stringify({
      alias: HOST,
      deploymentId: THIS_RUN,
      deployment: { id: { nested: true } },
    }),
    expect: 'fatal',
  },
  {
    name: 'nested deployment is present but not an object',
    raw: JSON.stringify({ alias: HOST, deploymentId: THIS_RUN, deployment: 'dpl_x' }),
    expect: 'fatal',
  },
  {
    name: 'response body is a JSON array, not an object',
    raw: JSON.stringify([{ deploymentId: THIS_RUN }]),
    expect: 'fatal',
  },
  {
    name: 'well-formed but bound to a DIFFERENT deployment (propagation)',
    raw: JSON.stringify({ alias: HOST, deploymentId: OTHER_RUN }),
    expect: 'retry',
  },
  {
    name: 'well-formed, different deployment, nested mirror agrees (propagation)',
    raw: JSON.stringify({
      alias: HOST,
      deploymentId: OTHER_RUN,
      deployment: { id: OTHER_RUN },
    }),
    expect: 'retry',
  },
  {
    name: 'nested deployment object present without an id key (mirror optional)',
    raw: JSON.stringify({
      alias: HOST,
      deploymentId: THIS_RUN,
      deployment: { url: 'holocard-hunter.vercel.app' },
    }),
    expect: 'success',
  },
];

const CODE_FOR = {
  success: ALIAS_BINDING_SUCCESS,
  fatal: ALIAS_BINDING_FATAL,
  retry: ALIAS_BINDING_RETRY,
};

console.log('\nAlias binding validator — in-process decisions (production module):');
for (const f of FIXTURES) {
  const got = decide(f.raw);
  check(
    `${f.name} → ${f.expect}`,
    got.status === f.expect && got.code === CODE_FOR[f.expect],
    `got status=${got.status} code=${got.code}: ${got.message}`,
  );
}

console.log('\nAlias binding validator — process exit codes (as the workflow reads them):');
for (const f of FIXTURES) {
  const r = runHelper(f.raw);
  check(
    `${f.name} → exit ${CODE_FOR[f.expect]}`,
    r.code === CODE_FOR[f.expect],
    `got exit ${r.code}; stderr=${r.stderr.trim().slice(0, 200)}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// The three outcomes must stay mutually distinguishable. A validator whose
// fatal and retryable states collide would either hang a broken record
// through the whole window or abort on ordinary propagation lag.
// ─────────────────────────────────────────────────────────────────────────
console.log('\nExit codes are unambiguous:');
check(
  'success / retry / fatal are three distinct codes',
  new Set([ALIAS_BINDING_SUCCESS, ALIAS_BINDING_RETRY, ALIAS_BINDING_FATAL]).size === 3,
);
check('success is exit 0 (the only code a shell reads as pass)', ALIAS_BINDING_SUCCESS === 0);
check('fatal is exit 1', ALIAS_BINDING_FATAL === 1);
check('retryable is exit 2, never 0 and never 1', ALIAS_BINDING_RETRY === 2);

// ─────────────────────────────────────────────────────────────────────────
// Diagnostics: fatal states must be loud, and nothing may echo the payload.
// ─────────────────────────────────────────────────────────────────────────
console.log('\nDiagnostics:');
{
  const r = runHelper(JSON.stringify({ alias: HOST, deployment: { id: THIS_RUN } }));
  check(
    'the missing-top-level fatal is annotated with ::error:: for the Actions log',
    /::error::/.test(r.stderr),
    `stderr=${r.stderr.trim().slice(0, 200)}`,
  );
  check(
    'the missing-top-level fatal names the required top-level field',
    /top-level deploymentId/i.test(r.stderr),
  );
}
{
  // A response body carrying a credential-shaped value must not be echoed back
  // into the log by the diagnostics path.
  const raw = JSON.stringify({
    error: { code: 'forbidden', message: 'token sk_live_SHOULD_NEVER_BE_LOGGED' },
    secretish: 'sk_live_SHOULD_NEVER_BE_LOGGED',
  });
  const r = runHelper(raw);
  check(
    'an explicit API error is fatal',
    r.code === ALIAS_BINDING_FATAL,
    `got exit ${r.code}`,
  );
  check(
    'the raw alias body is never echoed into the log',
    !r.stdout.includes('SHOULD_NEVER_BE_LOGGED')
      && !r.stderr.includes('SHOULD_NEVER_BE_LOGGED'),
    'diagnostics must be bounded and specific, never a payload dump',
  );
}
{
  const r = runHelper(JSON.stringify({ alias: HOST, deploymentId: THIS_RUN }), '');
  check(
    'an empty expected deployment id is fatal, never an accidental match',
    r.code === ALIAS_BINDING_FATAL,
    `got exit ${r.code}`,
  );
}
{
  const r = spawnSync(process.execPath, [HELPER], { encoding: 'utf8' });
  check(
    'the helper fails closed when invoked with no arguments',
    r.status === ALIAS_BINDING_FATAL,
    `got exit ${r.status}`,
  );
}
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-binding-missing-'));
  const r = spawnSync(
    process.execPath,
    [HELPER, path.join(dir, 'nope.json'), HOST, THIS_RUN],
    { encoding: 'utf8' },
  );
  fs.rmSync(dir, { recursive: true, force: true });
  check(
    'an unreadable alias response file is fatal, not a silent pass',
    r.status === ALIAS_BINDING_FATAL,
    `got exit ${r.status}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// MUTATION / REGRESSION PROOF
// ─────────────────────────────────────────────────────────────────────────
// `priorInlineValidator` is the exact decision the workflow's inline
// `node -e` validator made before this remediation, transcribed from commit
// 7e8e9d295. It is NOT an alternative implementation under test — it is the
// bug, kept so the suite can demonstrate two things:
//
//   1. the old logic really did accept a record with no top-level
//      `deploymentId`, and
//   2. the fixtures above really do discriminate, i.e. this suite would have
//      failed against the old validator instead of passing 89/89 beside it.
//
// If someone reintroduces the collect-whichever-ids-are-present shape, the
// first assertion below still passes and the production assertions fail.
function priorInlineValidator(raw, expectedId) {
  let a;
  try {
    a = JSON.parse(raw);
  } catch {
    return 1;
  }
  if (a && a.error) return 1;
  const ids = [a.deploymentId, a.deployment && a.deployment.id]
    .filter((v) => typeof v === 'string' && v.length > 0);
  if (ids.length === 0) return 2;
  if (ids.some((v) => v !== ids[0])) return 1;
  if (ids[0] !== expectedId) return 2;
  return 0;
}

console.log('\nMutation proof — the prior inline validator fails these fixtures:');
const MISSING_TOP_LEVEL = JSON.stringify({ alias: HOST, deployment: { id: THIS_RUN } });

check(
  'the PRIOR validator accepted a missing top-level deploymentId (the High finding, reproduced)',
  priorInlineValidator(MISSING_TOP_LEVEL, THIS_RUN) === ALIAS_BINDING_SUCCESS,
  'if this stops reproducing, the transcription of the old bug has drifted',
);
check(
  'the PRODUCTION validator rejects that same record as fatal',
  decide(MISSING_TOP_LEVEL).code === ALIAS_BINDING_FATAL,
  `got ${JSON.stringify(decide(MISSING_TOP_LEVEL))}`,
);
check(
  'the production helper rejects it through its exit code too',
  runHelper(MISSING_TOP_LEVEL).code === ALIAS_BINDING_FATAL,
);

// The suite as a whole must discriminate: run every fixture through the old
// validator and require that at least one disagrees with production. A suite
// that both implementations satisfy is exactly the failure mode being fixed.
const divergent = FIXTURES.filter(
  (f) => priorInlineValidator(f.raw, THIS_RUN) !== CODE_FOR[f.expect],
);
check(
  'the fixture set discriminates between the prior and current validators',
  divergent.length > 0,
  'no fixture distinguishes them, so these tests could not have caught the regression',
);
console.log(
  `    (${divergent.length} fixture(s) the prior validator got wrong: `
    + `${divergent.map((f) => f.name).join('; ')})`,
);

// A second mutation: the "empty top-level string" shape. The old filter
// dropped empty strings silently and fell through to "no deployment id yet",
// which retried until timeout instead of reporting a malformed contract.
check(
  'the PRIOR validator treated an empty top-level id as retryable, not fatal',
  priorInlineValidator(JSON.stringify({ alias: HOST, deploymentId: '' }), THIS_RUN)
    === ALIAS_BINDING_RETRY,
);
check(
  'the PRODUCTION validator treats an empty top-level id as fatal',
  decide(JSON.stringify({ alias: HOST, deploymentId: '' })).code === ALIAS_BINDING_FATAL,
);

// ─────────────────────────────────────────────────────────────────────────
// Guard the contract itself: the module must expose the three codes.
// ─────────────────────────────────────────────────────────────────────────
assert.equal(typeof evaluateAliasBinding, 'function');

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ DIC-1430 alias binding validator behaviour: ${passed} checks passed`);
} else {
  console.error('\n❌ DIC-1430 alias binding validator behaviour FAILED');
}
