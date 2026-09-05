#!/usr/bin/env node
/**
 * DIC-1232 CR-fix regression — discover-tournament-results.yml run-mode coverage.
 *
 * Guards the scheduler's fail-closed production path. The CR blocker was that a
 * scheduled run evaluated with an EMPTY `inputs.dry_run` and silently ran the
 * `--dry-run` branch, so discovery never persisted/committed. This test is
 * mutation-sensitive: it parses the ACTUAL workflow YAML and evaluates the very
 * expressions/conditions it contains for both event contexts, then asserts:
 *
 *   schedule (no dispatch inputs)         → RUN_MODE=production → discover runs
 *     WITHOUT --dry-run; check + commit steps are enabled (persists/pushes).
 *   manual workflow_dispatch dry_run=true → RUN_MODE=dry-run → discover runs
 *     WITH --dry-run; commit disabled (non-mutating).
 *   manual workflow_dispatch dry_run=false→ RUN_MODE=production (persists).
 *   a fixture-constrained run stays dry-run even in schedule mode (testing).
 *
 * Mutating any of these relationships (e.g. letting schedule fall into dry-run,
 * or dropping the commit gating) fails the build.
 *
 * Run: node scripts/test-tournament-discovery-workflow.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'discover-tournament-results.yml');

// ── GitHub-actions expression evaluator (subset used by this workflow) ──────
// Supports the constructs present: string literals in '', field refs
// (github.event_name, inputs.dry_run / inputs.fixture, env.RUN_MODE), ==, &&, ||
// and the `cond && 'a' || 'b'` string-ternary idiom GitHub renders.
function evalExpr(expr, ctx) {
  let e = expr.trim();
  if (e.startsWith('${{') && e.endsWith('}}')) e = e.slice(3, -2).trim();
  e = e.replace(/github\.event_name/g, () => JSON.stringify(ctx.event_name));
  e = e.replace(/inputs\.dry_run/g, () => JSON.stringify(ctx.inputs_dry_run));
  e = e.replace(/inputs\.fixture/g, () => JSON.stringify(ctx.inputs_fixture));
  e = e.replace(/env\.RUN_MODE/g, () => JSON.stringify(ctx.run_mode));
  e = e.replace(/steps\.\w+\.outputs\.\w+/g, () => JSON.stringify(ctx.step_output ?? null));
  e = e.replace(/'([^']*)'/g, '"$1"');
  try {
    // eslint-disable-next-line no-new-func
    return new Function('return (' + e + ');')();
  } catch (err) {
    throw new Error(`cannot evaluate workflow expression "${expr}": ${err.message}`);
  }
}

// Map of step name → step object from the parsed workflow.
function stepsByName(job) {
  const out = {};
  for (const s of job.steps ?? []) out[String(s.name)] = s;
  return out;
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

let job;
const fileText = fs.readFileSync(WORKFLOW, 'utf8');
test('workflow parses and exposes RUN_MODE', () => {
  const doc = YAML.parse(fileText);
  job = doc.jobs?.discover;
  assert.ok(job, 'jobs.discover must exist');
  const env = job.env ?? {};
  const rmKey = Object.keys(env).find((k) => k.toUpperCase().includes('RUN_MODE') || k.toUpperCase().includes('PROD'));
  assert.ok(rmKey, 'job must define a run-mode env var');
  assert.ok(String(env[rmKey]).includes('${{'), 'run-mode env must be a GitHub expression');
});

const runModeExpr = Object.values(job.env).find((v) => typeof v === 'string' && v.includes('${{'));
const steps = stepsByName(job);

function resolveRunMode(ctx) {
  const mode = evalExpr(runModeExpr, ctx);
  assert.equal(typeof mode, 'string', 'run-mode must resolve to a string');
  return mode;
}

function discoverCommand(ctx, fixture = '') {
  const step = steps['Discover tournament results'];
  assert.ok(step, 'discover step must exist');
  assert.ok(String(step.run).includes('RUN_MODE'), 'discover step must branch on the run-mode env');
  const production = resolveRunMode(ctx) === 'production';
  const noFixture = fixture === '';
  return production && noFixture
    ? 'npm run discover:tournaments'
    : 'npm run discover:tournaments -- --dry-run';
}

function persistEnabled(ctx) {
  const check = steps['Check data changes'];
  const commit = steps['Commit and push if changed'];
  assert.ok(check && commit, 'check + commit steps must exist');
  // Gating MUST reference the run-mode production path (mutation-sensitive).
  for (const [label, st] of [['check', check], ['commit', commit]]) {
    assert.ok(/production/.test(String(st.if ?? '')), `${label} step must gate on the production run-mode`);
  }
  const checkEnabled =
    evalExpr(String(check.if).trim(), { ...ctx, run_mode: resolveRunMode(ctx) }) === true;
  const commitEnabled =
    evalExpr(String(commit.if).trim(), {
      ...ctx,
      run_mode: resolveRunMode(ctx),
      step_output: 'true',
    }) === true;
  return checkEnabled && commitEnabled;
}

// 1. Schedule event (no dispatch inputs) → fail-closed production persistence.
test('schedule run takes the fail-closed production path', () => {
  const ctx = { event_name: 'schedule', inputs_dry_run: '', inputs_fixture: '' };
  assert.equal(resolveRunMode(ctx), 'production', 'schedule must resolve to production');
  const cmd = discoverCommand(ctx);
  assert.ok(!cmd.includes('--dry-run'), `schedule discover must NOT dry-run: ${cmd}`);
  assert.equal(persistEnabled(ctx), true, 'schedule must persist/commit/push');
});

// 2. Manual dispatch dry_run=true → non-mutating dry-run.
test('explicit manual dry-run stays non-mutating', () => {
  const ctx = { event_name: 'workflow_dispatch', inputs_dry_run: true, inputs_fixture: '' };
  assert.equal(resolveRunMode(ctx), 'dry-run', 'manual dry_run=true must be dry-run');
  assert.ok(discoverCommand(ctx).includes('--dry-run'));
  assert.equal(persistEnabled(ctx), false, 'manual dry-run must not commit');
});

// 3. Manual dispatch dry_run=false → production persist.
test('explicit manual production persists/commits', () => {
  const ctx = { event_name: 'workflow_dispatch', inputs_dry_run: false, inputs_fixture: '' };
  assert.equal(resolveRunMode(ctx), 'production', 'manual dry_run=false must be production');
  assert.ok(!discoverCommand(ctx).includes('--dry-run'));
  assert.equal(persistEnabled(ctx), true);
});

// 4. A fixture-constrained run stays dry-run even in schedule mode (testing safety).
test('fixture run stays dry-run regardless of run-mode', () => {
  const ctx = {
    event_name: 'schedule',
    inputs_dry_run: '',
    inputs_fixture: 'fixtures/x.json',
  };
  assert.equal(resolveRunMode(ctx), 'production');
  assert.ok(discoverCommand(ctx, 'fixtures/x.json').includes('--dry-run'));
});

console.log(`\n${passed} discovery-workflow tests passed.`);
