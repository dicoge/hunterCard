#!/usr/bin/env node
/**
 * .github/workflows/vercel-deploy-status-summary.yml — INLINE classifier
 * behaviour and security contract (DIC-1401 CR round 8).
 *
 * ROUND-7 REGRESSION AVOIDED
 * ---------------------------
 * Round 7 shipped a separate `scripts/ci/deploy-status-classify.sh` and
 * had the workflow do `actions/checkout@v4` at
 * `ref: ${{ github.event.deployment.sha }}` and then `bash` the checked-
 * out classifier — inside a job with `contents: write` and
 * `pull-requests: write`. `actions/checkout` persists the repo credential
 * by default, so any PR could replace that script and execute arbitrary
 * commands with the repo's write token (Mac-Codex Round-7 CR).
 *
 * Round 8 removes the script AND the checkout entirely and inlines the
 * classifier between marker comments in the workflow YAML. GitHub loads
 * `deployment_status` workflow definitions from the DEFAULT branch, so
 * the YAML text this suite reads is exactly the classifier that runs on
 * CI — never a PR-controlled file.
 *
 * BEHAVIOUR (what the classifier maps)
 * ------------------------------------
 *  - Vercel emits `Production – <project-name>` (U+2013 en-dash) for
 *    real Production deployments on both projects on this repo. Both
 *    values must resolve to `env_kind=production`.
 *  - Preview / Development qualifiers must NEVER resolve to production,
 *    otherwise day-to-day PR previews would post as Production
 *    successes on the deployed commit.
 *  - Empty / arbitrary / lookalike environment values resolve to
 *    `env_kind=unknown` (never production).
 *  - `state=success` → `verdict=success`; `state=error|failure` →
 *    `verdict=failure`; any other state → `verdict=ignore`.
 *
 * SECURITY (what the workflow MUST NOT do)
 * -----------------------------------------
 *  1. No `actions/checkout` in the summarize job.
 *  2. No `ref:` position anywhere in the workflow may reference
 *     `github.event.*` (would import attacker-controlled tree).
 *  3. No `bash scripts/…`, `sh scripts/…`, `node scripts/…` or
 *     `source scripts/…` anywhere in the workflow (would execute
 *     PR-controlled code with the write token).
 *  4. No `persist-credentials: true` (there should be no checkout at
 *     all, but if one is ever introduced, credentials must be off).
 *  5. Every event field must reach the shell via a step-level `env:`
 *     block, never inline `${{ github.event... }}` interpolated into a
 *     `run:` heredoc — otherwise shell metacharacters in
 *     Vercel-supplied strings could escape into command execution.
 *
 * Run: node scripts/test-deploy-status-classify.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = path.join(
  ROOT,
  '.github/workflows/vercel-deploy-status-summary.yml',
);
const WORKFLOW_TEXT = fs.readFileSync(WORKFLOW, 'utf8');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/**
 * Extract the inline classifier code from the workflow YAML between
 * `# BEGIN INLINE CLASSIFIER` and `# END INLINE CLASSIFIER` markers, and
 * strip the uniform YAML indentation so the result is executable bash.
 * The extracted text INCLUDES the marker comments themselves (harmless
 * — bash treats them as comments).
 */
function extractInlineClassifier(workflowText) {
  const startMarkerRE = /^[ \t]*# BEGIN INLINE CLASSIFIER\b.*$/m;
  const endMarkerRE = /^[ \t]*# END INLINE CLASSIFIER\b.*$/m;
  const startMatch = startMarkerRE.exec(workflowText);
  const endMatch = endMarkerRE.exec(workflowText);
  assert.ok(
    startMatch,
    '`# BEGIN INLINE CLASSIFIER` marker not found in workflow — the classifier must remain inline in the workflow YAML and marked for this suite to extract',
  );
  assert.ok(
    endMatch && endMatch.index > startMatch.index,
    '`# END INLINE CLASSIFIER` marker not found (or is before the start marker) in workflow',
  );
  const block = workflowText.slice(
    startMatch.index,
    endMatch.index + endMatch[0].length,
  );
  const lines = block.split('\n');
  const dataLines = lines.filter((l) => l.trim().length > 0);
  const minIndent = Math.min(
    ...dataLines.map((l) => (l.match(/^ */) || [''])[0].length),
  );
  return lines.map((l) => l.slice(minIndent)).join('\n');
}

const INLINE_CLASSIFIER = extractInlineClassifier(WORKFLOW_TEXT);

/**
 * Spawn a fresh bash on the extracted inline classifier with the given
 * STATE / ENVIRONMENT env vars — exactly how the workflow step runs it.
 * Reads back both stdout AND the GITHUB_OUTPUT file the workflow
 * downstream steps gate on, so we assert workflow-visible outputs.
 */
function runInline(env) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-'));
  const scriptFile = path.join(tmp, 'classifier.sh');
  const ghOutput = path.join(tmp, 'github_output');
  fs.writeFileSync(scriptFile, INLINE_CLASSIFIER);
  fs.writeFileSync(ghOutput, '');
  try {
    const result = spawnSync('bash', [scriptFile], {
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

// ------------------------------------------------------------------
// BEHAVIOUR — state → verdict
// ------------------------------------------------------------------

test('state=success → verdict=success', () => {
  const r = runInline({
    STATE: 'success',
    ENVIRONMENT: 'Production – holocard-hunter',
  });
  assert.equal(r.code, 0);
  assert.equal(r.out.verdict, 'success');
});

test('state=failure → verdict=failure', () => {
  const r = runInline({
    STATE: 'failure',
    ENVIRONMENT: 'Preview – holocard-hunter',
  });
  assert.equal(r.out.verdict, 'failure');
});

test('state=error → verdict=failure (Vercel emits `error`, not `failure`, for build failures)', () => {
  const r = runInline({
    STATE: 'error',
    ENVIRONMENT: 'Preview – holohunter-staging',
  });
  assert.equal(r.out.verdict, 'failure');
});

test('state=in_progress / queued / pending / empty → verdict=ignore', () => {
  for (const s of ['in_progress', 'queued', 'pending', '']) {
    const r = runInline({
      STATE: s,
      ENVIRONMENT: 'Production – holocard-hunter',
    });
    assert.equal(
      r.out.verdict,
      'ignore',
      `verdict for state=${JSON.stringify(s)}`,
    );
  }
});

// ------------------------------------------------------------------
// BEHAVIOUR — environment → env_kind (the round-6 blocker; real Vercel
// strings recorded in GitHub Deployments API for this repo)
// ------------------------------------------------------------------

test('THE ROUND-6 BLOCKER: Vercel emits `Production – holocard-hunter` → env_kind=production', () => {
  // GitHub deployment 6279247698 / status 17862908668 for holocard-hunter.
  const r = runInline({
    STATE: 'success',
    ENVIRONMENT: 'Production – holocard-hunter',
  });
  assert.equal(r.out.env_kind, 'production');
  assert.equal(r.out.verdict, 'success');
});

test('THE ROUND-6 BLOCKER: Vercel emits `Production – holohunter-staging` → env_kind=production', () => {
  // GitHub deployment 6279257364 / status 17862933404 for holohunter-staging.
  const r = runInline({
    STATE: 'success',
    ENVIRONMENT: 'Production – holohunter-staging',
  });
  assert.equal(r.out.env_kind, 'production');
});

test('MUTATION: `Preview – holocard-hunter` (state=success) → env_kind=preview, NOT production', () => {
  const r = runInline({
    STATE: 'success',
    ENVIRONMENT: 'Preview – holocard-hunter',
  });
  assert.equal(r.out.env_kind, 'preview');
  assert.notEqual(r.out.env_kind, 'production');
});

test('MUTATION: `Preview – holohunter-staging` (state=success) → env_kind=preview, NOT production', () => {
  const r = runInline({
    STATE: 'success',
    ENVIRONMENT: 'Preview – holohunter-staging',
  });
  assert.equal(r.out.env_kind, 'preview');
});

test('MUTATION: `Development – <project>` classified as development, NOT production', () => {
  const r = runInline({
    STATE: 'success',
    ENVIRONMENT: 'Development – holocard-hunter',
  });
  assert.equal(r.out.env_kind, 'development');
});

test('plain `Production` (no project qualifier) → env_kind=production (defensive fallback)', () => {
  const r = runInline({ STATE: 'success', ENVIRONMENT: 'Production' });
  assert.equal(r.out.env_kind, 'production');
});

test('plain `Preview` (no project qualifier) → env_kind=preview, NOT production', () => {
  const r = runInline({ STATE: 'success', ENVIRONMENT: 'Preview' });
  assert.equal(r.out.env_kind, 'preview');
});

test('empty environment → env_kind=unknown (never production)', () => {
  const r = runInline({ STATE: 'success', ENVIRONMENT: '' });
  assert.equal(r.out.env_kind, 'unknown');
});

test('MUTATION: lookalike environments never resolve to production', () => {
  for (const env of [
    'ProductionButNot',
    'productionish',
    'production',
    'PRODUCTION',
    'Production-holocard-hunter', // ASCII hyphen without surrounding spaces
    'Something Else',
  ]) {
    const r = runInline({ STATE: 'success', ENVIRONMENT: env });
    assert.notEqual(
      r.out.env_kind,
      'production',
      `env ${JSON.stringify(env)} must not classify as production; got env_kind=${r.out.env_kind}`,
    );
  }
});

test('ASCII hyphen separator (` - `) is accepted defensively — same as en-dash', () => {
  const r = runInline({
    STATE: 'success',
    ENVIRONMENT: 'Production - holocard-hunter',
  });
  assert.equal(r.out.env_kind, 'production');
});

test('failure event on a Production project still emits verdict=failure with env_kind=production', () => {
  const r = runInline({
    STATE: 'error',
    ENVIRONMENT: 'Production – holocard-hunter',
  });
  assert.equal(r.out.verdict, 'failure');
  assert.equal(r.out.env_kind, 'production');
});

// ------------------------------------------------------------------
// SECURITY CONTRACT (DIC-1401 CR round 8)
// ------------------------------------------------------------------

test('SECURITY: workflow does not check out any repo tree in the write-token summarize job', () => {
  // A checkout would bring PR-controlled code into a job with
  // contents:write / pull-requests:write. Anything the job then
  // executed from the checked-out tree could exfiltrate or misuse the
  // repo credentials that actions/checkout persists by default. The
  // ONLY safe posture is: no checkout at all in this workflow.
  assert.ok(
    !/\buses:\s*actions\/checkout\b/m.test(WORKFLOW_TEXT),
    'workflow contains an actions/checkout step — the deploy-status mirror runs with write token and MUST NOT check out the PR tree (Round-7 blocker)',
  );
});

test('SECURITY: no `ref:` position references github.event.* (would import attacker-controlled tree)', () => {
  // Even if a future refactor re-introduces actions/checkout with
  // persist-credentials: false, checking out the deployment SHA still
  // executes attacker-controlled code if any run step invokes
  // something from that tree. Fail closed by banning event refs in
  // any `ref:` position at all.
  const forbidden = [
    /\bref:\s*\$\{\{\s*github\.event\.deployment\.sha\s*\}\}/,
    /\bref:\s*\$\{\{\s*github\.event\.deployment\.ref\s*\}\}/,
    /\bref:\s*\$\{\{\s*github\.event\.deployment_status\./,
    /\bref:\s*\$\{\{\s*github\.event\.pull_request\./,
    /\bref:\s*\$\{\{\s*github\.head_ref\s*\}\}/,
  ];
  for (const pattern of forbidden) {
    assert.ok(
      !pattern.test(WORKFLOW_TEXT),
      `workflow uses forbidden ref binding: ${pattern}`,
    );
  }
});

test('SECURITY: no `bash|sh|node scripts/…` invocation inside any run: step', () => {
  // The classifier stays inline. No step in this workflow may source
  // or execute any file under scripts/ — those files are PR-controlled
  // in the deployed tree even without a checkout, so a future
  // regression that re-adds a checkout would immediately grant
  // arbitrary execution again. Belt-and-suspenders with the no-checkout
  // assertion above.
  //
  // We inspect only the extracted run: bodies so YAML comments
  // (which may legitimately mention `bash scripts/...` in the trust-
  // boundary explanation at the top of the file) don't trip this check.
  const forbidden = [
    /\bbash\s+scripts\//,
    /\bsh\s+scripts\//,
    /\bnode\s+scripts\//,
    /\bsource\s+scripts\//,
    /(?<!\S)\.\s+scripts\//,
    /\bnpm\s+run\s+/,
  ];
  const runBlocks = extractRunBlocks(WORKFLOW_TEXT);
  for (const { name, body } of runBlocks) {
    for (const pattern of forbidden) {
      assert.ok(
        !pattern.test(body),
        `step "${name}" invokes a repo-tree executable matching ${pattern}. Body:\n${body}`,
      );
    }
  }
});

test('SECURITY: workflow does not enable persist-credentials anywhere', () => {
  // Belt-and-suspenders: if a future checkout is re-introduced (against
  // the no-checkout assertion), credentials must at least be off.
  assert.ok(
    !/persist-credentials:\s*true/i.test(WORKFLOW_TEXT),
    'workflow persists repository credentials on a checkout — must not',
  );
});

test('SECURITY: no run: step interpolates untrusted `github.event.*` values directly into bash', () => {
  // Every event field must flow via step `env:` and be referenced with
  // "$VAR" expansion — otherwise a Vercel/GitHub-supplied string
  // containing backticks or $(...) could escape into command execution
  // when GitHub Actions substitutes it into the run: script.
  //
  // Allowed interpolations (workflow-controlled or safe metadata):
  //   github.token, github.repository, github.event.deployment_status.state
  //   used in the job-level `if:` guard (not inside a shell), and
  //   steps.*.outputs.* (produced by trusted earlier steps).
  // Anything else under github.event.* used inside a `run:` script is
  // banned.
  const runBlocks = extractRunBlocks(WORKFLOW_TEXT);
  const forbiddenInRun = /\$\{\{\s*github\.event\.(?!deployment_status\.state\b)[^}]+\}\}/;
  for (const { name, body } of runBlocks) {
    assert.ok(
      !forbiddenInRun.test(body),
      `step "${name}" interpolates github.event.* directly into a run: script — move that value into a step-level env: block and reference it as "$VAR" inside the shell. Body:\n${body}`,
    );
  }
});

test('SECURITY: no `scripts/ci/deploy-status-classify.sh` file exists (round-7 script must be gone)', () => {
  // The round-7 script is the exact artefact whose checked-out
  // execution was the blocker. It must not linger — every drift
  // between it and the inline classifier is a risk of a future
  // maintainer re-wiring the workflow through it.
  const roundSevenScript = path.join(ROOT, 'scripts/ci/deploy-status-classify.sh');
  assert.ok(
    !fs.existsSync(roundSevenScript),
    `${roundSevenScript} still exists — the round-7 checked-out-and-executed script must be deleted (round-8 inlines the classifier).`,
  );
});

// ------------------------------------------------------------------
// FUNCTIONAL WORKFLOW SHAPE (unchanged from round-7 — locks the fix in)
// ------------------------------------------------------------------

test('workflow: Production-success steps gate on env_kind, not the pre-fix raw string comparison', () => {
  assert.ok(
    !/deployment_status\.environment\s*==\s*['"]Production['"]/.test(WORKFLOW_TEXT),
    'workflow still gates a Production step on `environment == "Production"` — this is the round-6 blocker (Vercel emits `Production – <project>` and the raw compare never matches).',
  );
  const productionGateOccurrences = WORKFLOW_TEXT.match(
    /steps\.classify\.outputs\.env_kind\s*==\s*['"]production['"]/g,
  );
  assert.ok(
    productionGateOccurrences && productionGateOccurrences.length >= 2,
    'workflow must gate BOTH the Production-success compose step and the Production-success post step on `steps.classify.outputs.env_kind == "production"`.',
  );
});

test('workflow: classify step exports STATE and ENVIRONMENT to the inline classifier', () => {
  assert.match(
    WORKFLOW_TEXT,
    /STATE:\s*\$\{\{\s*github\.event\.deployment_status\.state\s*\}\}/,
    'STATE env var must be piped into the classifier',
  );
  assert.match(
    WORKFLOW_TEXT,
    /ENVIRONMENT:\s*\$\{\{\s*github\.event\.deployment_status\.environment\s*\}\}/,
    'ENVIRONMENT env var must be piped into the classifier',
  );
});

test('workflow: failure summary still emitted for BOTH Production and Preview failures', () => {
  assert.match(
    WORKFLOW_TEXT,
    /steps\.classify\.outputs\.verdict\s*==\s*['"]failure['"]/,
    'failure summary branch must still gate on verdict==failure',
  );
});

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/**
 * Very small YAML-aware extractor for `run:` blocks in the summarize
 * job. Not a full YAML parser — just enough to identify each `run: |`
 * block by the step's `name:` and return its body.
 */
function extractRunBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let currentName = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const nameMatch = /^\s*-\s+name:\s+(.+?)\s*$/.exec(line);
    if (nameMatch) {
      currentName = nameMatch[1];
      continue;
    }
    const runMatch = /^(\s*)run:\s*\|\s*$/.exec(line);
    if (!runMatch) continue;
    const runIndent = runMatch[1].length;
    const bodyIndent = runIndent + 2; // YAML block scalar body is at least +2
    const body = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const bl = lines[j];
      if (bl.length === 0) {
        body.push('');
        continue;
      }
      const leading = (bl.match(/^ */) || [''])[0].length;
      // A line at or less than the run's indent ends the block, UNLESS
      // it's a blank line (already handled above).
      if (leading <= runIndent) break;
      body.push(bl.slice(bodyIndent));
    }
    blocks.push({ name: currentName || '<unnamed>', body: body.join('\n') });
  }
  return blocks;
}

console.log(`\ndeploy-status-classify: ${passed} tests passed`);
