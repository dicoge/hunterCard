#!/usr/bin/env node
/**
 * DIC-1401 Round-9 producer/consumer trust-boundary + inline classifier
 * behaviour tests.
 *
 * WHY THE SPLIT
 * -------------
 * `deployment_status` events cause GitHub Actions to load the workflow
 * YAML from the DEPLOYMENT'S ref (which is the PR head SHA for Vercel
 * preview deployments), NOT from the repository's default branch.
 * Mac-Codex Round-8 CR proved this empirically: main did not contain
 * the deploy-status workflow file at round-8, yet the round-8 file
 * executed at PR-head SHAs with write scope on runs 34273723734 and
 * 34273978980. This means any single-file `deployment_status` handler
 * with write permissions is trivially pwn'd: a PR author simply
 * rewrites the file in their branch.
 *
 * Round-9 splits this into:
 *  - Producer (.github/workflows/vercel-deploy-status-summary.yml):
 *      contents:read ONLY, no write scope, marshals event fields into
 *      an artifact. PR-controlled (loaded from deployed ref) but
 *      cannot alter the repo or post comments.
 *  - Consumer (.github/workflows/vercel-deploy-status-post.yml):
 *      on: workflow_run (types: [completed]) bound to the producer
 *      by name. `workflow_run` workflows are loaded from the DEFAULT
 *      BRANCH by GitHub Actions contract, so this YAML cannot be
 *      supplied by a PR before it merges. Holds contents:write +
 *      pull-requests:write. Downloads the producer's artifact,
 *      cross-checks the artifact's deploy_sha against GitHub's own
 *      `workflow_run.head_sha`, re-classifies the environment, and
 *      posts the summary.
 *
 * The consumer logs `github.workflow_ref` on every run so an auditor
 * can visually confirm from the run's own output that the executing
 * write workflow was loaded from the default branch.
 *
 * WHAT THIS SUITE COVERS
 * ----------------------
 * 1. BEHAVIOUR — the consumer's inline classifier maps every real
 *    Vercel-emitted `environment` string (as recorded in the
 *    Deployments API for this repo — deployment 6279247698 /
 *    holocard-hunter and deployment 6279257364 / holohunter-staging)
 *    to `env_kind=production`, while Preview / Development / empty /
 *    lookalike / ASCII-hyphen variants classify away from production.
 *    Extracts the exact bash between `BEGIN INLINE CLASSIFIER` /
 *    `END INLINE CLASSIFIER` markers in the consumer YAML and runs
 *    it in a fresh bash, so there is no drift channel between the
 *    tested classifier and the shipped one.
 * 2. SECURITY — nine assertions that fail CI on any regression of the
 *    round-9 trust boundary:
 *      producer permissions restricted to contents:read only,
 *      consumer uses workflow_run bound to producer's exact name,
 *      neither workflow uses actions/checkout,
 *      no `ref:` position anywhere references github.event.*,
 *      no `bash|sh|node scripts/...` invocation in either workflow,
 *      no `persist-credentials: true` anywhere,
 *      consumer never interpolates `${{ github.event.deployment* }}`
 *        into a run: body (all deployment data flows through the
 *        artifact and is validated),
 *      consumer emits provenance log referencing github.workflow_ref,
 *      consumer cross-checks producer head_sha against artifact
 *        deploy_sha (writes fail closed on mismatch),
 *      consumer validates deploy_sha format (40-char hex),
 *      artifact-name bridge between producer/consumer stays consistent,
 *      the deleted round-7 script stays deleted.
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
const PRODUCER_PATH = path.join(
  ROOT,
  '.github/workflows/vercel-deploy-status-summary.yml',
);
const CONSUMER_PATH = path.join(
  ROOT,
  '.github/workflows/vercel-deploy-status-post.yml',
);
const PRODUCER_TEXT = fs.readFileSync(PRODUCER_PATH, 'utf8');
const CONSUMER_TEXT = fs.readFileSync(CONSUMER_PATH, 'utf8');
const PRODUCER_NAME = 'Vercel deploy status summary';
const ARTIFACT_NAME = 'vercel-deploy-status-event';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/**
 * Extract the inline classifier from the consumer YAML between BEGIN
 * and END marker comments, and strip the uniform YAML indentation so
 * the result is executable bash. Includes the marker comments (bash
 * treats them as comments).
 */
function extractInlineClassifier(workflowText, label) {
  const startRE = /^[ \t]*#[- ]*BEGIN INLINE CLASSIFIER\b.*$/m;
  const endRE = /^[ \t]*#[- ]*END INLINE CLASSIFIER\b.*$/m;
  const startMatch = startRE.exec(workflowText);
  const endMatch = endRE.exec(workflowText);
  assert.ok(
    startMatch,
    `${label}: BEGIN INLINE CLASSIFIER marker missing — the consumer classifier must remain inline for this suite to extract`,
  );
  assert.ok(
    endMatch && endMatch.index > startMatch.index,
    `${label}: END INLINE CLASSIFIER marker missing or before start`,
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

const INLINE_CLASSIFIER = extractInlineClassifier(CONSUMER_TEXT, 'consumer');

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

// -------------------------------------------------------------------
// BEHAVIOUR — the consumer's inline classifier
// -------------------------------------------------------------------

test('state=success → verdict=success', () => {
  const r = runClassifier({
    STATE: 'success',
    ENVIRONMENT: 'Production – holocard-hunter',
  });
  assert.equal(r.code, 0);
  assert.equal(r.out.verdict, 'success');
});

test('state=failure → verdict=failure', () => {
  const r = runClassifier({
    STATE: 'failure',
    ENVIRONMENT: 'Preview – holocard-hunter',
  });
  assert.equal(r.out.verdict, 'failure');
});

test('state=error → verdict=failure (Vercel emits `error`, not `failure`, for build failures)', () => {
  const r = runClassifier({
    STATE: 'error',
    ENVIRONMENT: 'Preview – holohunter-staging',
  });
  assert.equal(r.out.verdict, 'failure');
});

test('state=in_progress / queued / pending / empty → verdict=ignore', () => {
  for (const s of ['in_progress', 'queued', 'pending', '']) {
    const r = runClassifier({
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

test('THE ROUND-6 BLOCKER: Vercel emits `Production – holocard-hunter` → env_kind=production', () => {
  const r = runClassifier({
    STATE: 'success',
    ENVIRONMENT: 'Production – holocard-hunter',
  });
  assert.equal(r.out.env_kind, 'production');
  assert.equal(r.out.verdict, 'success');
});

test('THE ROUND-6 BLOCKER: Vercel emits `Production – holohunter-staging` → env_kind=production', () => {
  const r = runClassifier({
    STATE: 'success',
    ENVIRONMENT: 'Production – holohunter-staging',
  });
  assert.equal(r.out.env_kind, 'production');
});

test('MUTATION: `Preview – holocard-hunter` (state=success) → env_kind=preview, NOT production', () => {
  const r = runClassifier({
    STATE: 'success',
    ENVIRONMENT: 'Preview – holocard-hunter',
  });
  assert.equal(r.out.env_kind, 'preview');
  assert.notEqual(r.out.env_kind, 'production');
});

test('MUTATION: `Preview – holohunter-staging` (state=success) → env_kind=preview, NOT production', () => {
  const r = runClassifier({
    STATE: 'success',
    ENVIRONMENT: 'Preview – holohunter-staging',
  });
  assert.equal(r.out.env_kind, 'preview');
});

test('MUTATION: `Development – <project>` classified as development, NOT production', () => {
  const r = runClassifier({
    STATE: 'success',
    ENVIRONMENT: 'Development – holocard-hunter',
  });
  assert.equal(r.out.env_kind, 'development');
});

test('plain `Production` (no project qualifier) → env_kind=production (defensive fallback)', () => {
  const r = runClassifier({ STATE: 'success', ENVIRONMENT: 'Production' });
  assert.equal(r.out.env_kind, 'production');
});

test('plain `Preview` (no project qualifier) → env_kind=preview, NOT production', () => {
  const r = runClassifier({ STATE: 'success', ENVIRONMENT: 'Preview' });
  assert.equal(r.out.env_kind, 'preview');
});

test('empty environment → env_kind=unknown (never production)', () => {
  const r = runClassifier({ STATE: 'success', ENVIRONMENT: '' });
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
    const r = runClassifier({ STATE: 'success', ENVIRONMENT: env });
    assert.notEqual(
      r.out.env_kind,
      'production',
      `env ${JSON.stringify(env)} must not classify as production; got env_kind=${r.out.env_kind}`,
    );
  }
});

test('ASCII hyphen separator (` - `) is accepted defensively — same as en-dash', () => {
  const r = runClassifier({
    STATE: 'success',
    ENVIRONMENT: 'Production - holocard-hunter',
  });
  assert.equal(r.out.env_kind, 'production');
});

test('failure event on a Production project → verdict=failure with env_kind=production', () => {
  const r = runClassifier({
    STATE: 'error',
    ENVIRONMENT: 'Production – holocard-hunter',
  });
  assert.equal(r.out.verdict, 'failure');
  assert.equal(r.out.env_kind, 'production');
});

// -------------------------------------------------------------------
// SECURITY / TRUST BOUNDARY (DIC-1401 CR round 9)
// -------------------------------------------------------------------

test('SECURITY: PRODUCER `permissions:` is contents:read only (no write scopes)', () => {
  // The producer is loaded from the DEPLOYED ref (PR head on preview
  // deploys), so it is PR-controlled. Any write scope on this file
  // would hand the write token to the PR author on every
  // deployment_status event. The only safe posture is read-only.
  const permsBlock = extractYamlBlock(PRODUCER_TEXT, /^permissions:\s*$/m);
  assert.ok(
    permsBlock,
    'producer must declare an explicit `permissions:` block (defaults are too broad)',
  );
  const permLines = permsBlock
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  // Only `contents: read` allowed. Any other key, or `contents: write`,
  // is forbidden.
  for (const line of permLines) {
    const [key, value] = line.split(':').map((s) => s.trim());
    if (key === 'contents') {
      assert.equal(
        value,
        'read',
        `producer permissions.contents must be "read"; got ${JSON.stringify(value)}`,
      );
    } else {
      // Any other permission key at all is a red flag for a
      // PR-controlled producer.
      assert.fail(
        `producer must not declare permission ${JSON.stringify(key)} (only contents:read is allowed) — a PR author would inherit this scope`,
      );
    }
  }
});

test('SECURITY: CONSUMER uses on: workflow_run bound to the producer name (trusted default-branch dispatch)', () => {
  // workflow_run is the trust primitive: GitHub loads workflow_run
  // workflow definitions from the DEFAULT branch, so this consumer's
  // YAML cannot be supplied by a PR. The binding to the producer name
  // must be exact so a rename of the producer breaks the chain
  // (dead-service, not privilege escalation).
  assert.match(
    CONSUMER_TEXT,
    /on:\s*\n\s+workflow_run:\s*\n\s+workflows:\s*\[\s*"Vercel deploy status summary"\s*\]/,
    'consumer must trigger on `workflow_run` for workflows: ["Vercel deploy status summary"]',
  );
  assert.match(
    CONSUMER_TEXT,
    /types:\s*\[\s*completed\s*\]/,
    'consumer must subscribe to types: [completed]',
  );
});

test('SECURITY: CONSUMER holds contents:write, pull-requests:write, actions:read (and only those)', () => {
  const permsBlock = extractYamlBlock(CONSUMER_TEXT, /^permissions:\s*$/m);
  assert.ok(permsBlock, 'consumer must declare an explicit `permissions:` block');
  const parsed = Object.fromEntries(
    permsBlock
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'))
      .map((l) => {
        const [k, v] = l.split(':').map((s) => s.trim());
        return [k, v];
      }),
  );
  assert.equal(parsed['contents'], 'write', 'consumer must have contents: write');
  assert.equal(parsed['pull-requests'], 'write', 'consumer must have pull-requests: write');
  assert.equal(parsed['actions'], 'read', 'consumer must have actions: read (needed to download the producer artifact from a different workflow run)');
  // No id-token, no packages, no unnecessary elevation.
  const allowed = new Set(['contents', 'pull-requests', 'actions']);
  for (const key of Object.keys(parsed)) {
    assert.ok(
      allowed.has(key),
      `consumer permission ${JSON.stringify(key)} is not on the allowed set (contents,pull-requests,actions)`,
    );
  }
});

test('SECURITY: neither workflow uses actions/checkout', () => {
  for (const [label, text] of [
    ['producer', PRODUCER_TEXT],
    ['consumer', CONSUMER_TEXT],
  ]) {
    assert.ok(
      !/\buses:\s*actions\/checkout\b/m.test(text),
      `${label} contains an actions/checkout step — the deploy-status trust boundary must never bring the deployed tree onto the runner`,
    );
  }
});

test('SECURITY: no `ref:` position in either workflow references github.event.*', () => {
  const forbidden = [
    /\bref:\s*\$\{\{\s*github\.event\.deployment\.sha\s*\}\}/,
    /\bref:\s*\$\{\{\s*github\.event\.deployment\.ref\s*\}\}/,
    /\bref:\s*\$\{\{\s*github\.event\.deployment_status\./,
    /\bref:\s*\$\{\{\s*github\.event\.pull_request\./,
    /\bref:\s*\$\{\{\s*github\.head_ref\s*\}\}/,
  ];
  for (const [label, text] of [
    ['producer', PRODUCER_TEXT],
    ['consumer', CONSUMER_TEXT],
  ]) {
    for (const pattern of forbidden) {
      assert.ok(
        !pattern.test(text),
        `${label} uses forbidden ref binding: ${pattern}`,
      );
    }
  }
});

test('SECURITY: no `bash|sh|node|source|npm scripts/…` invocation inside any run: step', () => {
  const forbidden = [
    /\bbash\s+scripts\//,
    /\bsh\s+scripts\//,
    /\bnode\s+scripts\//,
    /\bsource\s+scripts\//,
    /(?<!\S)\.\s+scripts\//,
    /\bnpm\s+run\s+/,
  ];
  for (const [label, text] of [
    ['producer', PRODUCER_TEXT],
    ['consumer', CONSUMER_TEXT],
  ]) {
    const runBlocks = extractRunBlocks(text);
    for (const { name, body } of runBlocks) {
      for (const pattern of forbidden) {
        assert.ok(
          !pattern.test(body),
          `${label} step "${name}" invokes a repo-tree executable matching ${pattern}. Body:\n${body}`,
        );
      }
    }
  }
});

test('SECURITY: no `persist-credentials: true` anywhere in either workflow (excluding comments)', () => {
  // Strip full-line and trailing YAML comments before searching so an
  // explanatory comment like "No `persist-credentials: true` anywhere"
  // in the trust-boundary preamble does not trip this check.
  for (const [label, text] of [
    ['producer', PRODUCER_TEXT],
    ['consumer', CONSUMER_TEXT],
  ]) {
    const stripped = text
      .split('\n')
      .map((line) => {
        // Drop full-line comments.
        if (/^\s*#/.test(line)) return '';
        // Drop trailing comments (naive but adequate for our YAML —
        // no `#` inside quoted strings in these workflow files).
        const hashIdx = line.indexOf('#');
        return hashIdx === -1 ? line : line.slice(0, hashIdx);
      })
      .join('\n');
    assert.ok(
      !/persist-credentials:\s*true/i.test(stripped),
      `${label} sets persist-credentials: true — must not`,
    );
  }
});

test('SECURITY: consumer never interpolates github.event.deployment* into a run: body', () => {
  // The consumer receives every deployment field via the artifact and
  // re-validates them (SHA format + head_sha cross-check). It must
  // NEVER read github.event.deployment.* directly in a run: body,
  // both because those are producer-supplied and because bypassing
  // the artifact skips validation.
  //
  // Allowed interpolations: `github.event.workflow_run.*` (populated
  // by GitHub, describes the producer run — includes the trusted
  // head_sha we cross-check against). `github.token`, `github.run_id`,
  // `github.workflow_ref`, `github.repository`, `runner.temp`, and
  // `steps.*.outputs.*` are all also fine.
  const runBlocks = extractRunBlocks(CONSUMER_TEXT);
  const forbiddenInBody = /\$\{\{\s*github\.event\.deployment[^}]*\}\}/;
  for (const { name, body } of runBlocks) {
    assert.ok(
      !forbiddenInBody.test(body),
      `consumer step "${name}" interpolates github.event.deployment* directly into a run: body — the consumer MUST read those fields from the producer's artifact after re-validation, not from event context. Body:\n${body}`,
    );
  }
});

test('PROVENANCE: consumer references github.workflow_ref so an auditor can confirm the write-workflow ref from run output', () => {
  // github.workflow_ref is set by GitHub and formatted as
  // `<owner>/<repo>/<workflow-path>@<ref>`. Printing it during the
  // run gives an audit-trail entry proving this consumer's YAML was
  // loaded from the default branch (workflow_run contract).
  assert.match(
    CONSUMER_TEXT,
    /\$\{\{\s*github\.workflow_ref\s*\}\}/,
    'consumer must include github.workflow_ref in a step-level env: for provenance logging',
  );
  // And the value should actually be printed (echo/printf) in a
  // run: body — searching for the env var name in run: bodies.
  const runBlocks = extractRunBlocks(CONSUMER_TEXT);
  const printsProvenance = runBlocks.some((b) =>
    /\bCONSUMER_WORKFLOW_REF\b/.test(b.body),
  );
  assert.ok(
    printsProvenance,
    'consumer must reference CONSUMER_WORKFLOW_REF inside a run: step (echoing github.workflow_ref) so the provenance is visible in the run log',
  );
});

test('SECURITY: consumer cross-checks producer head_sha with artifact deploy_sha (fails closed on mismatch)', () => {
  // A PR that rewrites the producer to lie about deploy_sha in the
  // artifact cannot forge github.event.workflow_run.head_sha (that
  // value is set by GitHub, not the producer YAML). Cross-checking
  // binds the write-action to the actually-deployed commit.
  const runBlocks = extractRunBlocks(CONSUMER_TEXT);
  const hasCrossCheck = runBlocks.some(
    (b) =>
      /PRODUCER_HEAD_SHA/.test(b.body) &&
      /DEPLOY_SHA/.test(b.body) &&
      /!=\s*"?\$PRODUCER_HEAD_SHA"?/.test(b.body),
  );
  assert.ok(
    hasCrossCheck,
    'consumer must include a `[ "$DEPLOY_SHA" != "$PRODUCER_HEAD_SHA" ]` guard that exits non-zero on mismatch',
  );
});

test('SECURITY: consumer validates deploy_sha format (must be a 40-char git SHA)', () => {
  // DEPLOY_SHA is used verbatim in `gh api repos/.../commits/{sha}`
  // and in the comment body. Format-validating it prevents both
  // URL/shell metacharacter injection and pointing the write action
  // at arbitrary strings.
  const runBlocks = extractRunBlocks(CONSUMER_TEXT);
  const validates = runBlocks.some((b) =>
    /\bDEPLOY_SHA\b.*=~.*\^\[0-9a-f\]\{40\}\$/s.test(b.body),
  );
  assert.ok(
    validates,
    'consumer must gate write actions on `[[ "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]]` (or an equivalent regex check)',
  );
});

test('SECURITY: artifact-name bridge is consistent between producer and consumer', () => {
  // If the two workflows disagree on the artifact name, the consumer
  // silently downloads nothing and the summary path stays inert. Not
  // a security issue on its own but pin the invariant.
  assert.match(
    PRODUCER_TEXT,
    new RegExp(`name:\\s*${ARTIFACT_NAME}\\b`),
    `producer must upload artifact named "${ARTIFACT_NAME}"`,
  );
  assert.match(
    CONSUMER_TEXT,
    new RegExp(`name:\\s*${ARTIFACT_NAME}\\b`),
    `consumer must download artifact named "${ARTIFACT_NAME}"`,
  );
  // Consumer must use the producer's run id (workflow_run.id) when
  // downloading — otherwise it would only see its own run's
  // artifacts (which are empty).
  assert.match(
    CONSUMER_TEXT,
    /run-id:\s*\$\{\{\s*github\.event\.workflow_run\.id\s*\}\}/,
    'consumer must download from run-id: ${{ github.event.workflow_run.id }} (producer run)',
  );
});

test('SECURITY: producer name (the workflow_run trigger key) matches the producer file', () => {
  // The consumer's `on: workflow_run` looks up the producer by
  // top-level `name:` field. If the producer's name changes, the
  // consumer stops firing. Pin the name.
  assert.match(
    PRODUCER_TEXT,
    new RegExp(`^name:\\s*${PRODUCER_NAME}\\s*$`, 'm'),
    `producer top-level name must be exactly "${PRODUCER_NAME}"`,
  );
});

test('SECURITY: no `scripts/ci/deploy-status-classify.sh` file exists on disk', () => {
  const roundSevenScript = path.join(ROOT, 'scripts/ci/deploy-status-classify.sh');
  assert.ok(
    !fs.existsSync(roundSevenScript),
    `${roundSevenScript} still exists — round-7 script must stay deleted`,
  );
});

test('SECURITY: producer uses ONLY on: deployment_status (no other triggers)', () => {
  // A future maintainer could easily add `pull_request:` or `push:`
  // to the producer's `on:` block, which would leak state. Pin the
  // trigger.
  const onBlock = extractYamlBlock(PRODUCER_TEXT, /^on:\s*$/m);
  assert.ok(onBlock, 'producer must have an explicit `on:` block');
  const triggers = onBlock
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
    .map((l) => l.replace(/:.*$/, ''));
  assert.deepEqual(
    triggers,
    ['deployment_status'],
    `producer must only trigger on deployment_status; got ${JSON.stringify(triggers)}`,
  );
});

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

/**
 * Extract the body of a top-level YAML block whose header matches
 * `headerRE` (e.g. /^permissions:\s*$/m or /^on:\s*$/m). Returns
 * everything up to the next top-level line (line beginning with a
 * non-space character), or null if the header wasn't found.
 */
function extractYamlBlock(text, headerRE) {
  const match = headerRE.exec(text);
  if (!match) return null;
  const lines = text.split('\n');
  let startLine = -1;
  let searchIdx = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (searchIdx + lines[i].length + 1 > match.index && startLine === -1) {
      startLine = i;
      break;
    }
    searchIdx += lines[i].length + 1;
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
 * Small YAML-aware extractor: returns every `run: |` step body under
 * `- name:` entries, so security assertions can inspect just the
 * shell code without being fooled by YAML comments or metadata.
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

console.log(`\ndeploy-status-classify: ${passed} tests passed`);
