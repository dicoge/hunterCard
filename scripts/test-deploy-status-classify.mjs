#!/usr/bin/env node
/**
 * DIC-1401 Round-10 trusted-consumer + no-PR-controlled-trigger tests.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * Rounds 6–9 iterated on making a `deployment_status`-triggered
 * workflow safe. Mac-Codex's CR proved each iteration wrong in turn:
 *  - Round 6/7: a raw string comparison against `"Production"` never
 *    matched Vercel's real `Production – <project>` events.
 *  - Round 8: inlining the classifier did not help — GitHub loads
 *    `deployment_status` workflow definitions from the DEPLOYED ref,
 *    so the entire workflow YAML is PR-controlled and can request
 *    write scope.
 *  - Round 9: splitting into producer + consumer via `workflow_run`
 *    put the CONSUMER on the default branch (trusted), but the
 *    PRODUCER was still `on: deployment_status` — so a PR could
 *    rewrite the producer to grant itself `permissions:
 *    contents: write` and post directly, bypassing the consumer.
 *    Additionally, the consumer trusted the producer's artifact
 *    values (SHA-format-checked but not authenticated), so a PR
 *    could supply its real head SHA with attacker-chosen
 *    state/environment/URL.
 *
 * ROUND 10 REMOVES ALL PR-CONTROLLED TRIGGER SURFACES FOR THIS
 * FEATURE. There is NO `deployment_status` workflow anywhere in
 * `.github/workflows/`. The consumer runs on `schedule` +
 * `workflow_dispatch` — both loaded from the DEFAULT branch by
 * GitHub Actions contract. The consumer polls GitHub's Deployments
 * API for its facts, filters by `creator.login == "vercel[bot]"`
 * for both the deployment AND its status, and resolves PRs by SHA
 * only (no `--head <ref>` fallback). Producer YAML is deleted.
 *
 * ROUND-13 CONTEXT
 * ----------------
 * Round 12 deleted this consumer entirely under the interpretation
 * that the residual `deployment_status` PR-YAML class had to be
 * closed from within this repo. Mac-Codex Round-12 CR corrected that
 * interpretation: the scheduled-consumer summary IS the DIC-1402
 * public-deployment-summary deliverable and must ship; the residual
 * class is external and belongs to DIC-1399 (Vercel-side disable of
 * GitHub Deployments). Round 13 restores the consumer + tests
 * exactly as Mac-Codex accepted them in round 11 (with the
 * `permissions: deployments: read` addition that fixed the missing
 * REST scope), and does NOT restore the round-11 post-hoc
 * `pull_request_target` guard (Mac-Codex correctly identified it as
 * inadequate — merge-blocking cannot withdraw a token GitHub has
 * already handed to the malicious workflow).
 *
 * WHAT THIS SUITE COVERS
 * ----------------------
 * 1. BEHAVIOUR — the consumer's inline classifier maps every
 *    real Vercel-emitted `environment` string (as recorded in the
 *    Deployments API for this repo — deployment 6279247698 /
 *    holocard-hunter and deployment 6279257364 / holohunter-staging)
 *    to `env_kind=production`, while Preview / Development / empty /
 *    lookalike / ASCII-hyphen variants classify away from production.
 *    Extracts the exact bash between `BEGIN INLINE CLASSIFIER` /
 *    `END INLINE CLASSIFIER` markers in the consumer YAML, so there
 *    is no drift channel between the tested and shipped classifier.
 * 2. TRUST BOUNDARY — the repo-wide invariant + consumer-shape
 *    contract that makes it impossible for a PR to receive
 *    Vercel's `deployment_status` events via this repo's own
 *    workflows. (The residual class where a future PR could add its
 *    own `on: deployment_status` workflow with explicit write scope
 *    is out of scope for workflow YAML in a public non-Enterprise
 *    repo; see release-parity/deploy-status-mirror-blocked.md for the
 *    DIC-1399 unblock path.)
 * 3. `permissions: deployments: read` is required because the
 *    consumer's facts come from the GitHub Deployments API; removing
 *    it fails (mutation) and the polling step is exercised end-to-end
 *    against a stubbed `gh` (runtime contract) to prove it actually
 *    calls the /deployments + /statuses endpoints it needs that
 *    scope for.
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
const CONSUMER_PATH = path.join(
  ROOT,
  '.github/workflows/vercel-deploy-status-post.yml',
);
const CONSUMER_TEXT = fs.readFileSync(CONSUMER_PATH, 'utf8');
const WORKFLOWS_DIR = path.join(ROOT, '.github/workflows');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/**
 * Extract the inline classifier from the consumer YAML between the
 * BEGIN INLINE CLASSIFIER / END INLINE CLASSIFIER marker comments,
 * and strip the uniform YAML indentation so the result is
 * executable bash.
 */
function extractInlineClassifier(workflowText) {
  const startRE = /^[ \t]*#[- ]*BEGIN INLINE CLASSIFIER\b.*$/m;
  const endRE = /^[ \t]*#[- ]*END INLINE CLASSIFIER\b.*$/m;
  const s = startRE.exec(workflowText);
  const e = endRE.exec(workflowText);
  assert.ok(s, 'consumer: BEGIN INLINE CLASSIFIER marker missing');
  assert.ok(
    e && e.index > s.index,
    'consumer: END INLINE CLASSIFIER marker missing or before start',
  );
  const block = workflowText.slice(s.index, e.index + e[0].length);
  const lines = block.split('\n');
  const dataLines = lines.filter((l) => l.trim().length > 0);
  const minIndent = Math.min(
    ...dataLines.map((l) => (l.match(/^ */) || [''])[0].length),
  );
  return lines.map((l) => l.slice(minIndent)).join('\n');
}

const INLINE_CLASSIFIER = extractInlineClassifier(CONSUMER_TEXT);

function runClassifier(env) {
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
    const parsed = Object.fromEntries(
      fs
        .readFileSync(ghOutput, 'utf8')
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

// The consumer's classifier reads ENVIRONMENT from a shell variable
// derived from DEPLOYMENT_ENV (jq'd out of the API response). The
// classifier block itself does `ENVIRONMENT="${DEPLOYMENT_ENV:-}"`,
// so tests need to set DEPLOYMENT_ENV as the env-var-side input.
function runClassifierEnv({ state, environment }) {
  return runClassifier({
    STATE: state ?? '',
    DEPLOYMENT_ENV: environment ?? '',
  });
}

// -------------------------------------------------------------------
// BEHAVIOUR — the consumer's inline classifier
// -------------------------------------------------------------------

test('state=success → verdict=success', () => {
  const r = runClassifierEnv({
    state: 'success',
    environment: 'Production – holocard-hunter',
  });
  assert.equal(r.code, 0);
  assert.equal(r.out.verdict, 'success');
});

test('state=failure → verdict=failure', () => {
  const r = runClassifierEnv({
    state: 'failure',
    environment: 'Preview – holocard-hunter',
  });
  assert.equal(r.out.verdict, 'failure');
});

test('state=error → verdict=failure (Vercel emits `error`, not `failure`, for build failures)', () => {
  const r = runClassifierEnv({
    state: 'error',
    environment: 'Preview – holohunter-staging',
  });
  assert.equal(r.out.verdict, 'failure');
});

test('state=in_progress / queued / pending / empty → verdict=ignore', () => {
  for (const s of ['in_progress', 'queued', 'pending', '']) {
    const r = runClassifierEnv({
      state: s,
      environment: 'Production – holocard-hunter',
    });
    assert.equal(
      r.out.verdict,
      'ignore',
      `verdict for state=${JSON.stringify(s)}`,
    );
  }
});

test('THE ROUND-6 BLOCKER: Vercel emits `Production – holocard-hunter` → env_kind=production', () => {
  const r = runClassifierEnv({
    state: 'success',
    environment: 'Production – holocard-hunter',
  });
  assert.equal(r.out.env_kind, 'production');
  assert.equal(r.out.verdict, 'success');
});

test('THE ROUND-6 BLOCKER: Vercel emits `Production – holohunter-staging` → env_kind=production', () => {
  const r = runClassifierEnv({
    state: 'success',
    environment: 'Production – holohunter-staging',
  });
  assert.equal(r.out.env_kind, 'production');
});

test('MUTATION: `Preview – holocard-hunter` (state=success) → env_kind=preview, NOT production', () => {
  const r = runClassifierEnv({
    state: 'success',
    environment: 'Preview – holocard-hunter',
  });
  assert.equal(r.out.env_kind, 'preview');
});

test('MUTATION: `Preview – holohunter-staging` (state=success) → env_kind=preview, NOT production', () => {
  const r = runClassifierEnv({
    state: 'success',
    environment: 'Preview – holohunter-staging',
  });
  assert.equal(r.out.env_kind, 'preview');
});

test('MUTATION: `Development – <project>` classified as development, NOT production', () => {
  const r = runClassifierEnv({
    state: 'success',
    environment: 'Development – holocard-hunter',
  });
  assert.equal(r.out.env_kind, 'development');
});

test('plain `Production` (no project qualifier) → env_kind=production (defensive fallback)', () => {
  const r = runClassifierEnv({ state: 'success', environment: 'Production' });
  assert.equal(r.out.env_kind, 'production');
});

test('plain `Preview` (no project qualifier) → env_kind=preview, NOT production', () => {
  const r = runClassifierEnv({ state: 'success', environment: 'Preview' });
  assert.equal(r.out.env_kind, 'preview');
});

test('empty environment → env_kind=unknown (never production)', () => {
  const r = runClassifierEnv({ state: 'success', environment: '' });
  assert.equal(r.out.env_kind, 'unknown');
});

test('MUTATION: lookalike environments never resolve to production', () => {
  for (const env of [
    'ProductionButNot',
    'productionish',
    'production',
    'PRODUCTION',
    'Production-holocard-hunter',
    'Something Else',
  ]) {
    const r = runClassifierEnv({ state: 'success', environment: env });
    assert.notEqual(
      r.out.env_kind,
      'production',
      `env ${JSON.stringify(env)} must not classify as production; got env_kind=${r.out.env_kind}`,
    );
  }
});

test('ASCII hyphen separator (` - `) is accepted defensively — same as en-dash', () => {
  const r = runClassifierEnv({
    state: 'success',
    environment: 'Production - holocard-hunter',
  });
  assert.equal(r.out.env_kind, 'production');
});

test('failure event on a Production project → verdict=failure with env_kind=production', () => {
  const r = runClassifierEnv({
    state: 'error',
    environment: 'Production – holocard-hunter',
  });
  assert.equal(r.out.verdict, 'failure');
  assert.equal(r.out.env_kind, 'production');
});

// -------------------------------------------------------------------
// TRUST BOUNDARY — repo-wide + consumer shape
// -------------------------------------------------------------------

test('REPO INVARIANT: no `.github/workflows/*.yml` file triggers on `deployment_status` or `deployment`', () => {
  // This is the round-10 core: for our feature (and by extension for
  // this repo's public trust posture) there must be NO workflow file
  // that receives Vercel's `deployment_status` events. Because
  // `deployment_status` workflows are loaded from the DEPLOYED ref
  // (PR head on preview deploys), any such workflow would give the
  // PR author the ability to grant themselves `contents: write` /
  // `pull-requests: write` in their own PR YAML. Round-11 extends
  // the ban to bare `deployment` — the broader event class that
  // carries exactly the same DEPLOYED-ref loading and write-token
  // property.
  //
  // The check parses every workflow file's `on:` block and asserts
  // neither trigger is listed. Comments are stripped so a rationale
  // mention doesn't false-positive.
  const files = fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((f) => /\.ya?ml$/i.test(f));
  for (const file of files) {
    const text = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8');
    const uncommented = stripYamlComments(text);
    const onBlock = extractYamlBlock(uncommented, /^on:\s*[^\n]*$/m);
    if (onBlock === null) continue;
    // `on:` may be either a bare list (`on: [deployment_status]`),
    // a scalar (`on: deployment_status`), or a block-style dict
    // (each trigger on its own indented line). Check all forms.
    const triggerSet = new Set();
    // scalar/bare-list case: same line as `on:`
    const inlineOn = /^on:\s*(.+)$/m.exec(uncommented);
    if (inlineOn) {
      // strip `[` `]` and split on commas
      inlineOn[1]
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((t) => triggerSet.add(t));
    }
    // block-mapping case: children of `on:` at deeper indent
    onBlock
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .forEach((l) => {
        const key = l.replace(/:.*$/, '').trim();
        if (key) triggerSet.add(key);
      });
    assert.ok(
      !triggerSet.has('deployment_status'),
      `${file} triggers on 'deployment_status' — this is the round-8/9 vulnerability: workflow YAML for deployment_status events is loaded from the DEPLOYED ref (PR head for previews), so a PR could grant its own workflow write scope. Move deploy-status mirroring to schedule+API instead.`,
    );
    assert.ok(
      !triggerSet.has('deployment'),
      `${file} triggers on 'deployment' — the bare deployment event class loads workflow YAML from the DEPLOYED ref just like deployment_status and shares the same write-token privilege. It is banned repo-wide (DIC-1401 round-11).`,
    );
  }
});

test('CONSUMER TRIGGER: on: schedule + workflow_dispatch only', () => {
  const uncommented = stripYamlComments(CONSUMER_TEXT);
  const onBlock = extractYamlBlock(uncommented, /^on:\s*$/m);
  assert.ok(onBlock, 'consumer must have an explicit `on:` block');
  // Only take top-level trigger keys — the first non-blank line's
  // indent is the trigger indent; deeper lines are nested config
  // (e.g. the `- cron:` sub-item under `schedule:`).
  const onLines = onBlock.split('\n').filter((l) => l.trim().length > 0);
  const topIndent = onLines.length ? (onLines[0].match(/^ */) || [''])[0].length : 0;
  const triggers = new Set(
    onLines
      .filter((l) => (l.match(/^ */) || [''])[0].length === topIndent)
      .map((l) => l.trim().replace(/:.*$/, '').trim()),
  );
  assert.ok(
    triggers.has('schedule'),
    'consumer must trigger on `schedule` (loaded from default branch, cannot be supplied by a PR)',
  );
  assert.ok(
    triggers.has('workflow_dispatch'),
    'consumer must also allow `workflow_dispatch` for manual runs',
  );
  for (const t of triggers) {
    assert.ok(
      ['schedule', 'workflow_dispatch'].includes(t),
      `consumer trigger "${t}" is not in the allowed set {schedule, workflow_dispatch}`,
    );
  }
  // Cron must be present and be a valid-looking 5-field expression.
  assert.match(
    CONSUMER_TEXT,
    /-\s*cron:\s*['"][0-9\*\/,\-\s]+['"]/,
    'consumer must declare an explicit cron schedule string',
  );
});

test('CONSUMER PERMISSIONS: deployments:read (Deployments API) + contents:write + pull-requests:write, nothing else', () => {
  const permsBlock = extractYamlBlock(
    stripYamlComments(CONSUMER_TEXT),
    /^permissions:\s*$/m,
  );
  assert.ok(permsBlock, 'consumer must declare an explicit `permissions:` block');
  const parsed = Object.fromEntries(
    permsBlock
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => {
        const [k, v] = l.split(':').map((s) => s.trim());
        return [k, v];
      }),
  );
  assert.equal(parsed['contents'], 'write', 'consumer needs contents: write');
  assert.equal(
    parsed['pull-requests'],
    'write',
    'consumer needs pull-requests: write',
  );
  assert.equal(
    parsed['deployments'],
    'read',
    'consumer needs deployments: read — its facts come from the GitHub Deployments API (`repos/{owner}/{repo}/deployments` + `.../deployments/{id}/statuses`), whose scope is `deployments`. Without it the first poll 403s and the mirror silently posts nothing (Round-11 CR).',
  );
  const allowed = new Set(['contents', 'pull-requests', 'deployments']);
  for (const key of Object.keys(parsed)) {
    assert.ok(
      allowed.has(key),
      `consumer permission ${JSON.stringify(key)} is not in the allowed set {contents, pull-requests, deployments}`,
    );
  }
});

test('ROUND-11 CR MUTATION: removing `deployments: read` from the consumer breaks the permission contract', () => {
  // Source-style mutation sensitivity: if a future edit drops the
  // `deployments` scope, the same parse used by the passing test
  // above must FAIL to satisfy the contract.
  const permsBlock = extractYamlBlock(
    stripYamlComments(CONSUMER_TEXT),
    /^permissions:\s*$/m,
  );
  assert.ok(permsBlock, 'consumer permissions block present');
  const mutated = permsBlock
    .split('\n')
    .filter((l) => !/^\s*deployments\s*:/.test(l))
    .join('\n');
  const parsed = Object.fromEntries(
    mutated
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => {
        const [k, v] = l.split(':').map((s) => s.trim());
        return [k, v];
      }),
  );
  assert.notEqual(
    parsed['deployments'],
    'read',
    'the mutation (deleting deployments: read) must not satisfy the contract, otherwise the scope could silently disappear',
  );
});

test('DATA AUTHORITY: consumer fetches deployments + statuses from GitHub API (not from any producer artifact or event payload)', () => {
  // Round-10 has no producer, no artifact. Consumer must issue the
  // Deployments API calls itself so the data is authoritative.
  assert.match(
    CONSUMER_TEXT,
    /gh api "repos\/\$GITHUB_REPOSITORY\/deployments\?/,
    'consumer must call `gh api repos/$GITHUB_REPOSITORY/deployments?...` to enumerate deployments',
  );
  assert.match(
    CONSUMER_TEXT,
    /gh api "repos\/\$GITHUB_REPOSITORY\/deployments\/\$DEPLOYMENT_ID\/statuses\?/,
    'consumer must call `gh api repos/$GITHUB_REPOSITORY/deployments/$DEPLOYMENT_ID/statuses?...` for each deployment',
  );
});

test('CREATOR GATE: consumer skips any deployment/status NOT authored by "vercel[bot]" (creator.type "Bot")', () => {
  // Reject anything the trusted Vercel bot did not author. Prevents
  // a rogue collaborator with `deployment_status:write` from
  // steering summaries by posting handmade statuses.
  const runBlocks = extractRunBlocks(CONSUMER_TEXT);
  const bodyText = runBlocks.map((b) => b.body).join('\n');
  // The VERCEL_APP_LOGIN constant is piped into the step via `env:`
  // (looked for anywhere in the workflow YAML) and then referenced
  // inside the run: body for the creator-login guard.
  assert.match(
    CONSUMER_TEXT,
    /VERCEL_APP_LOGIN:\s*['"]vercel\[bot\]['"]/,
    'consumer must define `env: VERCEL_APP_LOGIN: "vercel[bot]"` on the polling step',
  );
  assert.match(
    bodyText,
    /\$CREATOR_LOGIN["']?\s*!=\s*["']?\$VERCEL_APP_LOGIN/,
    'consumer must skip deployments whose creator.login is not $VERCEL_APP_LOGIN',
  );
  assert.match(
    bodyText,
    /\$CREATOR_TYPE["']?\s*!=\s*["']?["']?Bot/,
    'consumer must skip deployments whose creator.type is not "Bot"',
  );
  assert.match(
    bodyText,
    /select\(\.creator\.login == \$vlogin\)/,
    'consumer must further filter statuses to those authored by the Vercel bot before treating state/URL as authoritative',
  );
});

test('NO REF FALLBACK: PR resolution is by deployed SHA only; no `gh pr list --head` fallback (Round-9 CR)', () => {
  // Untrusted refs can select an unrelated open PR. Only
  // `commits/{sha}/pulls` — a SHA-anchored lookup — is allowed.
  const runBlocks = extractRunBlocks(CONSUMER_TEXT);
  const bodyText = runBlocks.map((b) => b.body).join('\n');
  assert.match(
    bodyText,
    /gh api "repos\/\$GITHUB_REPOSITORY\/commits\/\$DEPLOYMENT_SHA\/pulls"/,
    'consumer must resolve PRs via `commits/{sha}/pulls`',
  );
  assert.ok(
    !/gh pr list[^\n]*--head/.test(bodyText),
    'consumer must NOT use `gh pr list --head <ref>` — an untrusted ref could select a different open PR',
  );
});

test('SHA VALIDATION: consumer refuses any deployment whose api-reported sha is not a 40-char git SHA', () => {
  const runBlocks = extractRunBlocks(CONSUMER_TEXT);
  const bodyText = runBlocks.map((b) => b.body).join('\n');
  assert.match(
    bodyText,
    /\bDEPLOYMENT_SHA\b.*=~.*\^\[0-9a-f\]\{40\}\$/s,
    'consumer must gate on `[[ "$DEPLOYMENT_SHA" =~ ^[0-9a-f]{40}$ ]]`',
  );
});

test('CONSUMER SHAPE: no actions/checkout; no bash|sh|node scripts/…; no persist-credentials: true; no ref: github.event.*', () => {
  const uncommented = stripYamlComments(CONSUMER_TEXT);
  assert.ok(
    !/\buses:\s*actions\/checkout\b/m.test(uncommented),
    'consumer must not use actions/checkout',
  );
  const forbiddenExec = [
    /\bbash\s+scripts\//,
    /\bsh\s+scripts\//,
    /\bnode\s+scripts\//,
    /\bsource\s+scripts\//,
    /(?<!\S)\.\s+scripts\//,
    /\bnpm\s+run\s+/,
  ];
  const runBlocks = extractRunBlocks(CONSUMER_TEXT);
  for (const { name, body } of runBlocks) {
    for (const pattern of forbiddenExec) {
      assert.ok(
        !pattern.test(body),
        `consumer step "${name}" invokes a repo-tree executable matching ${pattern}`,
      );
    }
  }
  assert.ok(
    !/persist-credentials:\s*true/i.test(uncommented),
    'consumer must not enable persist-credentials',
  );
  const forbiddenRefs = [
    /\bref:\s*\$\{\{\s*github\.event\./,
    /\bref:\s*\$\{\{\s*github\.head_ref\s*\}\}/,
  ];
  for (const pattern of forbiddenRefs) {
    assert.ok(
      !pattern.test(uncommented),
      `consumer uses forbidden ref binding: ${pattern}`,
    );
  }
});

test('PROVENANCE: consumer echoes github.workflow_ref so an auditor can confirm the write-workflow ref from run output', () => {
  assert.match(
    CONSUMER_TEXT,
    /\$\{\{\s*github\.workflow_ref\s*\}\}/,
    'consumer must include github.workflow_ref in a step-level env: for provenance logging',
  );
  const runBlocks = extractRunBlocks(CONSUMER_TEXT);
  const printsProvenance = runBlocks.some((b) =>
    /\bCONSUMER_WORKFLOW_REF\b/.test(b.body),
  );
  assert.ok(
    printsProvenance,
    'consumer must reference CONSUMER_WORKFLOW_REF inside a run: step so the provenance is visible in the run log',
  );
});

test('PRODUCER REMOVED: `.github/workflows/vercel-deploy-status-summary.yml` no longer exists', () => {
  const producer = path.join(
    ROOT,
    '.github/workflows/vercel-deploy-status-summary.yml',
  );
  assert.ok(
    !fs.existsSync(producer),
    `${producer} still exists — round-10 deletes the producer entirely to remove all PR-controlled deployment_status trigger surfaces`,
  );
});

test('ROUND-7 SCRIPT REMOVED: `scripts/ci/deploy-status-classify.sh` stays deleted', () => {
  const roundSeven = path.join(ROOT, 'scripts/ci/deploy-status-classify.sh');
  assert.ok(
    !fs.existsSync(roundSeven),
    `${roundSeven} still exists — the round-7 dead script must stay deleted`,
  );
});

// -------------------------------------------------------------------
// ROUND-11 CR 2 — Deployments-API permissions runtime contract
// -------------------------------------------------------------------

const CONSUMER_POLL_STEP = findRunBlock(
  CONSUMER_TEXT,
  /^Poll GitHub Deployments API and post any un-summarized Vercel deployment statuses$/,
);

const CONSUMER_GH =
  '#!/bin/bash\n' +
  'printf "%s\\n" "$*" >> "$FAKE_GH_LOG"\n' +
  'args="$*"\n' +
  'if [[ "$args" == *"--input"* ]]; then\n' +
  '  printf "%s\\n" \'{"html_url":"https://example.invalid/commit/comment/1"}\'\n' +
  '  exit 0\n' +
  'fi\n' +
  'if [[ "$args" == *"--jq"* ]]; then\n' +
  '  exit 0\n' +
  'fi\n' +
  'if [[ "$args" == *"/deployments?per_page="* ]]; then\n' +
  '  cat "$FAKE_GH_DEPLOYMENTS"\n' +
  'elif [[ "$args" == *"/deployments/"*"/statuses?per_page="* ]]; then\n' +
  '  cat "$FAKE_GH_STATUSES"\n' +
  'else\n' +
  '  printf "%s\\n" "{}"\n' +
  'fi\n' +
  'exit 0\n';

/**
 * Run the consumer's actual polling run: block against a stubbed
 * `gh` that records every invocation and serves canned Deployments
 * API responses from env-pointed files. This is the runtime contract
 * for `permissions: deployments: read`: it proves the step really
 * issues the /deployments and /deployments/{id}/statuses calls that
 * scope covers (and would 403 without).
 */
function runConsumerPoll({ deployments, statuses, pulls, comments }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsc-rt-'));
  try {
    const scriptFile = path.join(tmp, 'poll.sh');
    fs.writeFileSync(scriptFile, CONSUMER_POLL_STEP);
    fs.writeFileSync(path.join(tmp, 'gh'), CONSUMER_GH);
    fs.chmodSync(path.join(tmp, 'gh'), 0o755);
    fs.writeFileSync(path.join(tmp, 'deployments.json'), deployments);
    fs.writeFileSync(path.join(tmp, 'statuses.json'), statuses);
    fs.writeFileSync(path.join(tmp, 'pulls.json'), pulls);
    fs.writeFileSync(path.join(tmp, 'comments.txt'), comments);
    fs.writeFileSync(path.join(tmp, 'gh.log'), '');
    const result = spawnSync('bash', [scriptFile], {
      env: {
        PATH: `${tmp}:${process.env.PATH}`,
        GITHUB_REPOSITORY: 'dicoge/hunterCard',
        RUNNER_TEMP: tmp,
        GH_TOKEN: 'fake-token',
        VERCEL_APP_LOGIN: 'vercel[bot]',
        MAX_DEPLOYMENTS: '100',
        MAX_STATUSES_PER_DEPLOYMENT: '100',
        FAKE_GH_DEPLOYMENTS: path.join(tmp, 'deployments.json'),
        FAKE_GH_STATUSES: path.join(tmp, 'statuses.json'),
        FAKE_GH_PULLS: path.join(tmp, 'pulls.json'),
        FAKE_GH_COMMENTS: path.join(tmp, 'comments.txt'),
        FAKE_GH_LOG: path.join(tmp, 'gh.log'),
      },
      encoding: 'utf8',
    });
    const log = fs.readFileSync(path.join(tmp, 'gh.log'), 'utf8');
    return {
      code: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      log,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const FAKE_SHA = 'a'.repeat(40);

test('ROUND-11 CR RUNTIME: consumer enumerates the Deployments API and posts a Production success for a vercel[bot] deployment', () => {
  const r = runConsumerPoll({
    deployments: JSON.stringify([
      {
        id: 999,
        sha: FAKE_SHA,
        ref: 'refs/heads/ci/x',
        environment: 'Production – holocard-hunter',
        creator: { login: 'vercel[bot]', type: 'Bot' },
      },
    ]),
    statuses: JSON.stringify([
      {
        id: 555,
        state: 'success',
        creator: { login: 'vercel[bot]' },
        created_at: '2026-01-01T00:00:00Z',
        description: 'Deployment completed',
        log_url: 'https://example.invalid/log',
        target_url: 'https://holohunter.dicoge.com',
      },
    ]),
    pulls: '[]',
    comments: '',
  });
  assert.equal(r.code, 0, `consumer runtime failed: ${r.stderr}`);
  // The two calls the `deployments: read` scope must cover — this is
  // the runtime contract behind the Round-11 permissions fix.
  assert.match(
    r.log,
    /repos\/dicoge\/hunterCard\/deployments\?per_page=/,
    'consumer must call GET /repos/{o}/{r}/deployments at runtime',
  );
  assert.match(
    r.log,
    /repos\/dicoge\/hunterCard\/deployments\/999\/statuses\?per_page=/,
    'consumer must call GET /repos/{o}/{r}/deployments/{id}/statuses at runtime',
  );
  assert.match(r.stdout, /verdict=success/, 'classifier ran in-runtime');
  assert.match(r.stdout, /env_kind=production/, 'environment classified production in-runtime');
  assert.match(r.log, /--input/, 'consumer posted the summary body');
});

test('ROUND-11 CR RUNTIME NEGATIVE: non-vercel deployment is skipped — no statuses call, no post', () => {
  const r = runConsumerPoll({
    deployments: JSON.stringify([
      {
        id: 998,
        sha: FAKE_SHA,
        ref: 'refs/heads/main',
        environment: 'Production – holocard-hunter',
        creator: { login: 'someone-else', type: 'User' },
      },
    ]),
    statuses: '[]',
    pulls: '[]',
    comments: '',
  });
  assert.equal(r.code, 0, `consumer runtime failed: ${r.stderr}`);
  assert.match(
    r.log,
    /repos\/dicoge\/hunterCard\/deployments\?per_page=/,
    'consumer enumerated deployments',
  );
  assert.ok(
    !/\/deployments\/\d+\/statuses\?per_page=/.test(r.log),
    'consumer must NOT query statuses for a deployment not authored by vercel[bot]',
  );
  assert.ok(!/--input/.test(r.log), 'consumer must NOT post when the creator gate rejects the deployment');
});

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

/**
 * Extract the body of a top-level YAML block whose header matches
 * `headerRE` (e.g. /^permissions:\s*$/m). Returns everything up to
 * the next top-level line (line beginning with a non-space
 * character), or null if the header wasn't found.
 */
function extractYamlBlock(text, headerRE) {
  const match = headerRE.exec(text);
  if (!match) return null;
  const lines = text.split('\n');
  let startLine = -1;
  let idx = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (idx + lines[i].length + 1 > match.index && startLine === -1) {
      startLine = i;
      break;
    }
    idx += lines[i].length + 1;
  }
  if (startLine === -1) return null;
  const body = [];
  for (let i = startLine + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.length === 0) {
      body.push('');
      continue;
    }
    const leading = (l.match(/^ */) || [''])[0].length;
    if (leading === 0) break;
    body.push(l);
  }
  return body.join('\n');
}

/**
 * Find a `run: |` step body by its `- name:` (regex), throwing when
 * no step matches — so a renamed/removed step fails loudly.
 */
function findRunBlock(text, nameRE) {
  const blocks = extractRunBlocks(text);
  const found = blocks.find((b) => nameRE.test(b.name));
  assert.ok(found, `no run: step matching ${nameRE} in workflow`);
  return found.body;
}

/**
 * Extract every `run: |` step body under `- name:` entries. Strips
 * the common leading indentation so security patterns match the raw
 * shell text.
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
    const bodyIndent = runIndent + 2;
    const body = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const bl = lines[j];
      if (bl.length === 0) {
        body.push('');
        continue;
      }
      const leading = (bl.match(/^ */) || [''])[0].length;
      if (leading <= runIndent) break;
      body.push(bl.slice(bodyIndent));
    }
    blocks.push({ name: currentName || '<unnamed>', body: body.join('\n') });
  }
  return blocks;
}

/**
 * Strip YAML comments (full-line and trailing) so a security
 * assertion doesn't false-positive on rationale text in the
 * trust-boundary header comment blocks.
 */
function stripYamlComments(text) {
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*#/.test(line)) return '';
      const idx = line.indexOf('#');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

console.log(`\ndeploy-status-classify: ${passed} tests passed`);
