#!/usr/bin/env node
/**
 * scripts/ci/deploy-status-classify.sh behaviour (DIC-1401 Round-6 CR).
 *
 * The DIC-1401 public deploy-status mirror
 * (.github/workflows/vercel-deploy-status-summary.yml) publishes:
 *  - a failure summary for every failing deployment_status, and
 *  - a Production-success summary ONLY on the deployed commit.
 *
 * Round-5 gated the Production-success branch on the raw string equality
 * `github.event.deployment_status.environment == 'Production'`, but the two
 * Vercel projects on this repo emit the project-qualified form
 * `Production – <project-name>` (U+2013 en-dash surrounded by spaces).
 * The raw comparison therefore never matched real events and every
 * Production success on this repo was silently dropped. Extracting the
 * classification into a script lets these tests spawn it with the exact
 * event `environment` strings the two projects actually emit (recorded in
 * GitHub's Deployments API — see Mac-Codex Round-6 CR: deployment
 * 6279247698 status 17862908668 for holocard-hunter, deployment 6279257364
 * status 17862933404 for holohunter-staging), plus mutation cases for the
 * Preview equivalents which must NEVER be admitted into the Production
 * branch.
 *
 * The workflow-shape assertions at the bottom lock in that the workflow
 * gates the Production branch on `steps.classify.outputs.env_kind ==
 * 'production'` rather than the pre-fix raw string comparison, so a future
 * revert cannot silently reopen the bug.
 *
 * Run: node scripts/test-deploy-status-classify.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/ci/deploy-status-classify.sh');
const WORKFLOW = path.join(
  ROOT,
  '.github/workflows/vercel-deploy-status-summary.yml',
);

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/**
 * Spawns the classifier in a fresh bash. Captures both the direct stdout
 * (verdict= / env_kind= lines) and the GITHUB_OUTPUT file the workflow
 * reads, so we assert the workflow-visible outputs, not just the
 * developer-visible logs.
 */
function run(env) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-'));
  const ghOutput = path.join(tmp, 'github_output');
  fs.writeFileSync(ghOutput, '');
  try {
    const result = spawnSync('bash', [SCRIPT], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        GITHUB_OUTPUT: ghOutput,
        ...env,
      },
      encoding: 'utf8',
    });
    const outputFile = fs.readFileSync(ghOutput, 'utf8');
    const parsed = Object.fromEntries(
      outputFile
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const idx = line.indexOf('=');
          return [line.slice(0, idx), line.slice(idx + 1)];
        }),
    );
    return {
      code: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      out: parsed,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// -- state → verdict --------------------------------------------------------

test('state=success → verdict=success', () => {
  const r = run({ STATE: 'success', ENVIRONMENT: 'Production – holocard-hunter' });
  assert.equal(r.code, 0);
  assert.equal(r.out.verdict, 'success');
});

test('state=failure → verdict=failure', () => {
  const r = run({ STATE: 'failure', ENVIRONMENT: 'Preview – holocard-hunter' });
  assert.equal(r.code, 0);
  assert.equal(r.out.verdict, 'failure');
});

test('state=error → verdict=failure (Vercel emits `error`, not `failure`, for build failures)', () => {
  const r = run({ STATE: 'error', ENVIRONMENT: 'Preview – holohunter-staging' });
  assert.equal(r.out.verdict, 'failure');
});

test('state=in_progress / queued / pending → verdict=ignore (workflow-level filter belt+suspenders)', () => {
  for (const s of ['in_progress', 'queued', 'pending', '']) {
    const r = run({ STATE: s, ENVIRONMENT: 'Production – holocard-hunter' });
    assert.equal(r.out.verdict, 'ignore', `verdict for state=${JSON.stringify(s)}`);
  }
});

// -- environment → env_kind (the round-6 blocker; real Vercel strings) ------

test('THE ROUND-6 BLOCKER: Vercel emits `Production – holocard-hunter` → env_kind=production', () => {
  // This is the exact environment string recorded on GitHub deployment
  // 6279247698 / status 17862908668 for the holocard-hunter project.
  const r = run({
    STATE: 'success',
    ENVIRONMENT: 'Production – holocard-hunter',
  });
  assert.equal(r.out.env_kind, 'production');
  assert.equal(r.out.verdict, 'success');
});

test('THE ROUND-6 BLOCKER: Vercel emits `Production – holohunter-staging` → env_kind=production', () => {
  // GitHub deployment 6279257364 / status 17862933404 for the
  // holohunter-staging project.
  const r = run({
    STATE: 'success',
    ENVIRONMENT: 'Production – holohunter-staging',
  });
  assert.equal(r.out.env_kind, 'production');
  assert.equal(r.out.verdict, 'success');
});

test('MUTATION: `Preview – holocard-hunter` (state=success) → env_kind=preview, NOT production', () => {
  // If this ever classified `preview` as `production`, day-to-day PR
  // preview builds would be posted as Production success comments on
  // every PR. This is the mirror image of the Round-6 blocker.
  const r = run({
    STATE: 'success',
    ENVIRONMENT: 'Preview – holocard-hunter',
  });
  assert.equal(r.out.env_kind, 'preview');
  assert.notEqual(r.out.env_kind, 'production');
});

test('MUTATION: `Preview – holohunter-staging` (state=success) → env_kind=preview, NOT production', () => {
  const r = run({
    STATE: 'success',
    ENVIRONMENT: 'Preview – holohunter-staging',
  });
  assert.equal(r.out.env_kind, 'preview');
  assert.notEqual(r.out.env_kind, 'production');
});

test('MUTATION: `Development – <project>` classified as development, NOT production', () => {
  const r = run({ STATE: 'success', ENVIRONMENT: 'Development – holocard-hunter' });
  assert.equal(r.out.env_kind, 'development');
});

test('Plain `Production` (no project qualifier) still classifies as production (defensive fallback)', () => {
  const r = run({ STATE: 'success', ENVIRONMENT: 'Production' });
  assert.equal(r.out.env_kind, 'production');
});

test('Plain `Preview` (no project qualifier) classifies as preview, NOT production', () => {
  const r = run({ STATE: 'success', ENVIRONMENT: 'Preview' });
  assert.equal(r.out.env_kind, 'preview');
});

test('Empty environment → env_kind=unknown (never production)', () => {
  const r = run({ STATE: 'success', ENVIRONMENT: '' });
  assert.equal(r.out.env_kind, 'unknown');
});

test('MUTATION: arbitrary environment string (`Production-lookalike`) → env_kind=unknown', () => {
  // The classifier must not treat any hyphen-suffixed variant it does not
  // recognise as `production`; only the exact `Production` prefix followed
  // by the en-dash separator (or nothing) is admitted.
  for (const env of [
    'ProductionButNot',
    'productionish',
    'production',
    'PRODUCTION',
    'Production-holocard-hunter',        // ASCII hyphen without spaces
    'Something Else',
  ]) {
    const r = run({ STATE: 'success', ENVIRONMENT: env });
    assert.notEqual(
      r.out.env_kind,
      'production',
      `environment ${JSON.stringify(env)} MUST NOT classify as production; got env_kind=${r.out.env_kind}`,
    );
  }
});

test('ASCII hyphen separator (` - `) is accepted defensively — same result as en-dash', () => {
  // If Vercel ever swaps the U+2013 en-dash for a plain ASCII hyphen (they
  // have shifted the string historically), the classifier must not
  // silently reclassify Production as unknown and drop the summary again.
  const r = run({
    STATE: 'success',
    ENVIRONMENT: 'Production - holocard-hunter',
  });
  assert.equal(r.out.env_kind, 'production');
});

test('failure event on a Production project still emits verdict=failure with env_kind=production', () => {
  // The failure summary is emitted for every kind (preview and prod), but
  // the env_kind is still reported so downstream text can specialise.
  const r = run({
    STATE: 'error',
    ENVIRONMENT: 'Production – holocard-hunter',
  });
  assert.equal(r.out.verdict, 'failure');
  assert.equal(r.out.env_kind, 'production');
});

// -- workflow shape: lock in the fix so a revert cannot silently reopen ----

test('workflow: Production-success gates use env_kind, not the pre-fix raw string comparison', () => {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');
  // Neither the compose nor the post step may compare
  // github.event.deployment_status.environment to any raw string
  // ("Production", "Preview", etc.) as a gate on the Production-success
  // branch — that is exactly the round-6 blocker.
  assert.ok(
    !/deployment_status\.environment\s*==\s*['"]Production['"]/.test(workflow),
    'workflow still gates a Production step on a raw environment == "Production" comparison; this is the exact Round-6 CR blocker (Vercel emits `Production – <project>` and the raw compare never matches).',
  );
  // And they MUST gate on env_kind == 'production' from the classifier.
  const productionGateOccurrences = workflow.match(
    /steps\.classify\.outputs\.env_kind\s*==\s*['"]production['"]/g,
  );
  assert.ok(
    productionGateOccurrences && productionGateOccurrences.length >= 2,
    'workflow must gate BOTH the Production-success compose step and the Production-success post step on `steps.classify.outputs.env_kind == "production"`.',
  );
});

test('workflow: classify step exports STATE and ENVIRONMENT to the classifier script', () => {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(
    workflow,
    /STATE:\s*\$\{\{\s*github\.event\.deployment_status\.state\s*\}\}/,
    'STATE env var must be piped into the classifier',
  );
  assert.match(
    workflow,
    /ENVIRONMENT:\s*\$\{\{\s*github\.event\.deployment_status\.environment\s*\}\}/,
    'ENVIRONMENT env var must be piped into the classifier — the round-6 fix depends on the classifier seeing the real Vercel-emitted environment string',
  );
  assert.match(
    workflow,
    /bash\s+scripts\/ci\/deploy-status-classify\.sh/,
    'workflow must invoke the checked-in classifier script (so this test suite exercises the same code path CI does)',
  );
});

test('workflow: failure summary is still emitted for BOTH Production and Preview failures (unchanged)', () => {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');
  // The failure branch must remain gated only on verdict, not on env_kind
  // — a Preview build failure must still get a public failure summary.
  assert.match(
    workflow,
    /steps\.classify\.outputs\.verdict\s*==\s*['"]failure['"]/,
    'failure summary branch must still gate on verdict==failure',
  );
});

console.log(`\ndeploy-status-classify: ${passed} tests passed`);
