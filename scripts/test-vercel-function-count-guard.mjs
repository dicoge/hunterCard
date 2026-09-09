#!/usr/bin/env node
/**
 * Regression tests for scripts/ci/vercel-function-count-guard.mjs.
 *
 * Two layers:
 * 1. Pure-function unit tests of evaluateFunctionCount against fixture
 *    classified results (under/at/over the Hobby cap, undeclared runtimes).
 * 2. A REAL-REPO mutation: count the api/ route files as deployed today and
 *    assert the node count is at-or-under the cap (12). Because Vercel
 *    failed twice when this count hit 13, a future PR adding a 13th
 *    Node-runtime api route must fail HERE, in the public Validate job.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyRouteRuntimes,
  collectApiRouteFiles,
  evaluateFunctionCount,
  VERCEL_HOBBY_SERVERLESS_FUNCTION_LIMIT,
} from './ci/vercel-function-count-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ------------------------------------------------ pure-function unit tests

test('under the cap passes', () => {
  const r = evaluateFunctionCount({ nodeCount: 11, missingRuntime: [], count: 11 }, 12);
  assert.equal(r.ok, true);
});

test('exactly at the cap passes', () => {
  const r = evaluateFunctionCount({ nodeCount: 12, missingRuntime: [], count: 12 }, 12);
  assert.equal(r.ok, true);
});

test('one over the cap fails with the actionable cap message (the exact PR #186 regression)', () => {
  const r = evaluateFunctionCount({ nodeCount: 13, missingRuntime: [], count: 13 }, 12);
  assert.equal(r.ok, false);
  assert.match(r.reasons[0], /13 Node-runtime api\/\* routes exceed the Vercel Hobby per-deployment serverless-function cap of 12/);
});

test('undeclared-runtime route fails even under the cap (count must be knowable)', () => {
  const r = evaluateFunctionCount(
    { nodeCount: 10, missingRuntime: ['api/undeclared.ts'], count: 10 },
    12,
  );
  assert.equal(r.ok, false);
  assert.match(r.reasons[0], /declares no runtime/);
});

test('classifyRouteRuntimes splits node/edge/missing by config.runtime', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.tmp-function-count-'));
  try {
    const nodeFile = path.join(dir, 'a.ts');
    const edgeFile = path.join(dir, 'b.ts');
    const unsetFile = path.join(dir, 'c.ts');
    fs.writeFileSync(nodeFile, "export const config = { runtime: 'nodejs' };\n");
    fs.writeFileSync(edgeFile, "export const config = { runtime: 'edge' };\n");
    fs.writeFileSync(unsetFile, 'export default async function h() {}\n');
    const c = classifyRouteRuntimes([nodeFile, edgeFile, unsetFile]);
    assert.deepEqual(c.node, [nodeFile]);
    assert.deepEqual(c.edge, [edgeFile]);
    assert.deepEqual(c.missingRuntime, [unsetFile]);
    assert.equal(c.count, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------- real-repo config assertion

test('THIS REPO: api/ has no undeclared-runtime routes', () => {
  const routes = collectApiRouteFiles(path.join(ROOT, 'api'));
  const c = classifyRouteRuntimes(routes);
  assert.deepEqual(c.missingRuntime, []);
});

test('THIS REPO: Node-runtime api/* route count is at-or-under the Hobby cap of 12', () => {
  const routes = collectApiRouteFiles(path.join(ROOT, 'api'));
  const c = classifyRouteRuntimes(routes);
  const r = evaluateFunctionCount(c, VERCEL_HOBBY_SERVERLESS_FUNCTION_LIMIT);
  assert.equal(
    r.ok,
    true,
    `repo has ${r.nodeCount} Node-runtime api routes, above the ${r.limit} Hobby cap — ` +
      'Vercel deployments would fail; replace any new api route with build-time static evidence',
  );
});

// ------------------------------------------- public-diagnostic wiring (DIC-1401)

const ciWorkflow = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');

test('ci.yml Validate runs the function-count guard PUBLICLY (the CR round-2 diagnostic mirror)', () => {
  assert.match(ciWorkflow, /run: npm run test:vercel-function-count-guard/);
});

test('ci.yml: the function-count guard is not neutered on the Validate path', () => {
  const step = ciWorkflow.split('\n').find((l) => l.includes('test:vercel-function-count-guard'));
  assert.ok(step, 'not invoking vercel-function-count-guard');
  assert.ok(!/\|\| true|&& false|continue-on-error/.test(ciWorkflow.split('test:vercel-function-count-guard')[0].slice(-400)));
});

// DIC-1401 Round 10 removed the `on: deployment_status` producer
// entirely (it was PR-controlled and Mac-Codex's Round-9 CR showed
// the producer YAML could grant itself write, bypassing the trusted
// consumer). The single remaining workflow is a schedule-triggered
// trusted-default-branch consumer that polls GitHub's Deployments API
// and posts the failure / Production-success summary — still citing
// test:vercel-function-count-guard as the diagnostic mirror.
const deployStatusConsumer = fs.readFileSync(
  path.join(ROOT, '.github/workflows/vercel-deploy-status-post.yml'),
  'utf8',
);

test('deploy-status mirror consumer surfaces the failure body with the function-count-guard diagnostic + log_url', () => {
  assert.match(deployStatusConsumer, /vercel-function-count-guard/);
  assert.match(deployStatusConsumer, /log_url/i);
});

console.log(`\nvercel-function-count-guard: ${passed} tests passed`);