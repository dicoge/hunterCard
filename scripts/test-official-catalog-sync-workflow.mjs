#!/usr/bin/env node
/**
 * DIC-1291: Official Catalog Sync must hand changes off through a
 * pull-request against protected `main`, not push directly.
 *
 * The failure this guards against is exactly the one from run 33558958119:
 * the workflow finished the whole DIC-1167 pipeline (discovery, ingestion,
 * merge, buy-price alignment, native generation, hEB01 validation, data-
 * change detection), staged 5 files and then blew up on
 * `git push origin HEAD:main` with GH006 because protected main requires
 * two checks. A "fix" that quietly reintroduces that push — or that gets
 * around the block with `--force`, `--admin`, a PAT with bypass rights, or
 * a `permissions:` block wide enough to sidestep review — must be caught
 * here mechanically instead of on the next 21:04 UTC schedule tick.
 *
 * Three layers, because static string checks alone are easy to lie past:
 *   1. Static YAML — the workflow file itself never contains a direct
 *      push to `main`, never opens the door to force-push against
 *      protected branches, and never carries scopes the PR handoff does
 *      not need.
 *   2. Structural YAML — the pipeline is preserved end-to-end (the
 *      DIC-1167 steps have to be there before a PR is opened), the
 *      handoff step calls the real PR APIs, and the change check /
 *      no-op success branch is wired so a no-diff run cannot fail.
 *   3. Behavioural — a mutated copy of the workflow that swaps the PR
 *      handoff for the old direct push must be REJECTED by the same
 *      checks. This catches the case where someone reintroduces the
 *      GH006 push while leaving the surrounding structure intact.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_PATH = path.join(ROOT, '.github/workflows/official-catalog-sync.yml');

const workflowText = fs.readFileSync(WORKFLOW_PATH, 'utf8');
const workflow = parseYaml(workflowText);

// ------------------------------------------------------------------- layer 1
// Static YAML: no direct-to-main push, no branch-protection bypass, and no
// scopes wider than the PR handoff needs.

// The exact `HEAD:main` push that GH006 rejected on run 33558958119 must
// not reappear. Neither may any equivalent form (`refs/heads/main`,
// `origin main`, `origin +main`), and none of them may be hidden behind a
// force flag.
const FORBIDDEN_PUSH_PATTERNS = [
  /git\s+push[^\n]*\bHEAD\s*:\s*main\b/,
  /git\s+push[^\n]*\brefs\/heads\/main\b/,
  /git\s+push[^\n]*\borigin\s+main\b/,
  /git\s+push[^\n]*\borigin\s+\+main\b/,
  // Explicit force-push against main in any of the common shapes.
  /git\s+push[^\n]*--force[^\n]*\bmain\b/,
  /git\s+push[^\n]*-f\s+origin\s+main\b/,
];
for (const pattern of FORBIDDEN_PUSH_PATTERNS) {
  assert.ok(
    !pattern.test(workflowText),
    `official-catalog-sync.yml must not push to main directly (matched ${pattern})`,
  );
}

// The bypasses that would silently defeat branch protection even without a
// literal `HEAD:main` push. `--admin` merges past required checks; a
// user-supplied `PAT`/`ADMIN`/`BYPASS` secret typically exists precisely
// so a workflow can circumvent protection. `gh api ... /branches/main/
// protection` writes would let the workflow relax protection on itself.
const FORBIDDEN_BYPASS_PATTERNS = [
  /gh\s+pr\s+merge[^\n]*--admin\b/,
  /\bsecrets\.[A-Z0-9_]*(?:PAT|ADMIN|BYPASS)[A-Z0-9_]*\b/,
  /gh\s+api[^\n]*\/branches\/main\/protection\b/,
  /allow_force_pushes/i,
  /enforce_admins[^\n]*false/,
];
for (const pattern of FORBIDDEN_BYPASS_PATTERNS) {
  assert.ok(
    !pattern.test(workflowText),
    `official-catalog-sync.yml must not bypass branch protection (matched ${pattern})`,
  );
}

// The only secret this workflow may reference is the built-in GITHUB_TOKEN.
// A stray user-managed secret is either a bypass token or a data leak; the
// PR handoff needs neither.
const secretReferences = [...workflowText.matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/g)].map(
  (m) => m[1],
);
for (const name of secretReferences) {
  assert.strictEqual(
    name,
    'GITHUB_TOKEN',
    `official-catalog-sync.yml may only reference secrets.GITHUB_TOKEN (found secrets.${name})`,
  );
}

// Permission scopes stay bounded. `contents: write` is needed to update the
// bot-owned sync branch; `pull-requests: write` is needed to open/refresh
// the PR. Nothing else — the old `issues: write` from the direct-push
// design is intentionally gone.
const ALLOWED_PERMISSIONS = new Set(['contents', 'pull-requests']);
const ALLOWED_PERMISSION_LEVELS = new Set(['read', 'write', 'none']);
const permissions = workflow.permissions;
assert.ok(
  permissions && typeof permissions === 'object' && !Array.isArray(permissions),
  'official-catalog-sync.yml must declare an explicit `permissions:` block, not inherit repo-wide defaults',
);
assert.notStrictEqual(
  permissions,
  'write-all',
  'official-catalog-sync.yml must not request `permissions: write-all`',
);
for (const [scope, level] of Object.entries(permissions)) {
  assert.ok(
    ALLOWED_PERMISSIONS.has(scope),
    `official-catalog-sync.yml permission scope "${scope}" is not on the PR-handoff allow-list`,
  );
  assert.ok(
    ALLOWED_PERMISSION_LEVELS.has(level),
    `official-catalog-sync.yml permission "${scope}: ${level}" must be read/write/none, not a custom level`,
  );
}

// ------------------------------------------------------------------- layer 2
// Structural YAML: the pipeline is preserved end-to-end, the handoff calls
// the real PR APIs, and a no-diff run is a success rather than a failure.

const trigger = workflow.on ?? workflow.true; // `on:` is a YAML boolean key in YAML 1.1.
assert.ok(trigger, 'official-catalog-sync.yml must declare triggers');
assert.ok(
  Object.prototype.hasOwnProperty.call(trigger, 'workflow_dispatch'),
  'official-catalog-sync.yml must keep workflow_dispatch for manual reruns',
);
assert.ok(
  Array.isArray(trigger.schedule) && trigger.schedule.some((s) => typeof s.cron === 'string'),
  'official-catalog-sync.yml must keep the scheduled cron trigger',
);

const jobs = workflow.jobs ?? {};
const jobName = Object.keys(jobs)[0];
const job = jobs[jobName];
assert.ok(job, 'official-catalog-sync.yml must define a job');

// Two runs must not race to refresh the sync branch or open duplicate PRs.
assert.ok(
  job.concurrency && typeof job.concurrency.group === 'string' && job.concurrency.group.length > 0,
  'sync job must declare a concurrency group so scheduled + manual runs cannot race',
);

const steps = job.steps ?? [];
const stepRuns = steps.map((s) => s.run ?? '').join('\n');
const stepUses = steps.map((s) => s.uses ?? '').filter(Boolean);

// The DIC-1167 pipeline stays in place as ordered, distinct steps: any of
// these missing regresses either the catalog data or the branch-protection
// PR path (the change check / handoff blocks are what make the PR safe).
const REQUIRED_PIPELINE_COMMANDS = [
  'scripts/scrape-official-cards.js',
  'scripts/sync-official-catalog-to-database.mjs',
  'scripts/regen-buy-alignment.mjs',
  'scripts/generate-native-database.mjs',
  'scripts/test-official-catalog-sync.mjs',
];
for (const cmd of REQUIRED_PIPELINE_COMMANDS) {
  assert.ok(
    stepRuns.includes(cmd),
    `official-catalog-sync.yml must invoke DIC-1167 pipeline step \`${cmd}\``,
  );
}

// The exact set of paths the pipeline may commit — same set the change
// check uses. Locking this here means a future edit cannot silently start
// committing e.g. build artefacts, secrets, or user-facing files.
const EXPECTED_SYNC_PATHS = [
  'data/official/',
  'data/database.json',
  'public/data/database.json',
  'docs/audits/official-catalog-audit.json',
  'docs/audits/official-production-lag-state.json',
];
for (const p of EXPECTED_SYNC_PATHS) {
  assert.ok(
    workflowText.includes(p),
    `official-catalog-sync.yml must scope its commit to \`${p}\``,
  );
}

// PR handoff is present: the workflow must open/refresh a real PR via `gh`
// (the only auth path GITHUB_TOKEN can use), and the sync branch it pushes
// to must be a deterministic bot-owned branch (not `main`, and not a per-
// run random name that would multiply into a PR storm).
assert.ok(
  /gh\s+pr\s+create\b/.test(stepRuns),
  'official-catalog-sync.yml must open the sync PR through `gh pr create`',
);
assert.ok(
  /gh\s+pr\s+list\b/.test(stepRuns),
  'official-catalog-sync.yml must look up an existing sync PR before creating a new one',
);
const syncBranch = job.env?.SYNC_BRANCH ?? workflow.env?.SYNC_BRANCH;
assert.ok(
  typeof syncBranch === 'string' && syncBranch.length > 0,
  'workflow must declare a deterministic `SYNC_BRANCH` env var for the bot-owned handoff branch',
);
assert.notStrictEqual(
  syncBranch,
  'main',
  'SYNC_BRANCH must not be main — the whole point is that we open a PR against main',
);
assert.ok(
  syncBranch.startsWith('bot/'),
  `SYNC_BRANCH must live under bot/… so branch-protection rules can distinguish it from human branches (got \`${syncBranch}\`)`,
);
// Any force-push in this workflow must be scoped to the sync branch only,
// and only in the safe --force-with-lease form. The push target is
// allowed to spell the branch as either the literal name or the
// `$SYNC_BRANCH` env var — the alternative would be inlining the branch
// name and losing the single source of truth in `env.SYNC_BRANCH`.
const rawForcePushes = stepRuns.match(/git\s+push[^\n]*--force\b[^\n]*/g) ?? [];
for (const line of rawForcePushes) {
  assert.ok(
    /--force-with-lease\b/.test(line),
    `plain --force push forbidden — use --force-with-lease: \`${line.trim()}\``,
  );
  assert.ok(
    line.includes(syncBranch) || line.includes('$SYNC_BRANCH') || line.includes('${SYNC_BRANCH}'),
    `force-push must target the sync branch \`${syncBranch}\` only: \`${line.trim()}\``,
  );
  assert.ok(
    !/\bmain\b/.test(line),
    `force-push must not reference main: \`${line.trim()}\``,
  );
}

// No-change runs succeed. The workflow expresses this by gating the
// handoff on `steps.check.outputs.changed == 'true'`; if that gate is
// missing the job either always pushes (undoing the dedup) or fails on
// clean runs (turning every quiet day red).
const changedStep = steps.find((s) => s.id === 'check');
assert.ok(
  changedStep && typeof changedStep.run === 'string' && changedStep.run.includes('changed=false'),
  'workflow must record a `changed=false` output when the pipeline produced no diff',
);
const gatedSteps = steps.filter(
  (s) => typeof s.if === 'string' && s.if.includes("steps.check.outputs.changed == 'true'"),
);
assert.ok(
  gatedSteps.length >= 1,
  'the PR-handoff step must be gated on `steps.check.outputs.changed == \'true\'` so no-change runs are a success',
);

// The checkout must anchor to `main` at fetch-depth 0 so the workflow
// rebuilds the sync branch on top of the current main every run — the
// dedup contract in the handoff assumes that starting point.
const checkoutStep = steps.find((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/checkout@'));
assert.ok(checkoutStep, 'workflow must check out the repository');
assert.strictEqual(
  checkoutStep.with?.ref,
  '${{ env.BASE_BRANCH }}',
  'checkout must pin to the base branch env var so the sync branch is rebuilt from main every run',
);
assert.strictEqual(
  Number(checkoutStep.with?.['fetch-depth']),
  0,
  'checkout must use fetch-depth: 0 so the handoff can fetch arbitrary PR-head commits',
);

// Every third-party action must be pinned to a major (or SHA) — the
// scheduler already runs unattended; a floating tag would let a supply-
// chain compromise reach protected main through the very PR the handoff
// opens.
for (const uses of stepUses) {
  assert.ok(
    /@(?:v\d+(?:\.\d+){0,2}|[0-9a-f]{40})$/.test(uses),
    `workflow action \`${uses}\` must be pinned to a version (vN) or full SHA`,
  );
}

// ------------------------------------------------------------------- layer 3
// Behavioural: a mutated workflow that reinstates the direct `HEAD:main`
// push must be REJECTED. Without this layer the layer-1 regex could rot
// (someone renames the constant, the check greens up, the workflow
// silently loses its safety). Re-running the same static checks against a
// deliberately-broken copy proves they still bite.
const MUTATIONS = [
  {
    name: 'direct HEAD:main push (the GH006 regression)',
    mutate: (text) =>
      text.replace(
        /- name: Open or refresh sync PR[\s\S]*$/m,
        [
          '- name: Commit and push catalog changes',
          "  if: steps.check.outputs.changed == 'true'",
          '  run: |',
          '    git add -- data/official/ data/database.json public/data/database.json docs/audits/official-catalog-audit.json docs/audits/official-production-lag-state.json',
          '    git commit -m "chore: sync official catalog"',
          '    git push origin HEAD:main',
        ].join('\n'),
      ),
  },
  {
    name: 'refs/heads/main push',
    mutate: (text) => text.replace(/git push --force-with-lease origin "\$SYNC_BRANCH:\$SYNC_BRANCH"/, 'git push origin HEAD:refs/heads/main'),
  },
  {
    name: 'force-push to main',
    mutate: (text) => text.replace(/git push --force-with-lease origin "\$SYNC_BRANCH:\$SYNC_BRANCH"/, 'git push --force origin main'),
  },
  {
    name: 'gh pr merge --admin bypass',
    mutate: (text) => text.replace(/gh pr create \\/, 'gh pr merge --admin \\\n              && gh pr create \\'),
  },
  {
    name: 'user-supplied bypass PAT',
    mutate: (text) => text.replace(/GH_TOKEN: \$\{\{ secrets.GITHUB_TOKEN \}\}/, 'GH_TOKEN: ${{ secrets.ADMIN_BYPASS_PAT }}'),
  },
  {
    name: 'widened permissions (write-all)',
    mutate: (text) =>
      text.replace(/permissions:\n  contents: write\n  pull-requests: write/, 'permissions: write-all'),
  },
  {
    name: 'dropped pipeline step (native database)',
    mutate: (text) =>
      text.replace(/\s+- name: Generate native database asset[\s\S]*?generate-native-database\.mjs/, ''),
  },
  {
    name: 'no-change run turned into failure',
    mutate: (text) => text.replace(/echo "changed=false" >> "\$GITHUB_OUTPUT"/, 'exit 1'),
  },
  {
    name: 'sync branch renamed to main',
    mutate: (text) => text.replace(/SYNC_BRANCH: bot\/official-catalog-sync/, 'SYNC_BRANCH: main'),
  },
];

for (const { name, mutate } of MUTATIONS) {
  const mutated = mutate(workflowText);
  assert.notStrictEqual(
    mutated,
    workflowText,
    `mutation "${name}" did not actually change the workflow — the regex/replacement drifted from the source`,
  );
  const rejected = detectAnyPolicyViolation(mutated);
  assert.ok(
    rejected,
    `mutation "${name}" must be rejected by the static + structural checks; the safety net has rotted`,
  );
}

console.log('✓ DIC-1291 official-catalog-sync workflow safety invariants passed');

// ------------------------------------------------------------------- helpers

function detectAnyPolicyViolation(text) {
  for (const pattern of FORBIDDEN_PUSH_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  for (const pattern of FORBIDDEN_BYPASS_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  const secrets = [...text.matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
  if (secrets.some((n) => n !== 'GITHUB_TOKEN')) return true;

  let parsed;
  try {
    parsed = parseYaml(text);
  } catch {
    return true;
  }
  const perms = parsed?.permissions;
  if (!perms || typeof perms !== 'object' || Array.isArray(perms)) return true;
  for (const [scope, level] of Object.entries(perms)) {
    if (!ALLOWED_PERMISSIONS.has(scope)) return true;
    if (!ALLOWED_PERMISSION_LEVELS.has(level)) return true;
  }

  const mutatedJob = Object.values(parsed?.jobs ?? {})[0];
  const mutatedSteps = mutatedJob?.steps ?? [];
  const mutatedRuns = mutatedSteps.map((s) => s.run ?? '').join('\n');
  for (const cmd of REQUIRED_PIPELINE_COMMANDS) {
    if (!mutatedRuns.includes(cmd)) return true;
  }
  const mutatedSyncBranch = mutatedJob?.env?.SYNC_BRANCH ?? parsed?.env?.SYNC_BRANCH;
  if (typeof mutatedSyncBranch !== 'string' || mutatedSyncBranch === 'main' || !mutatedSyncBranch.startsWith('bot/')) {
    return true;
  }
  const mutatedCheckStep = mutatedSteps.find((s) => s.id === 'check');
  if (!mutatedCheckStep || typeof mutatedCheckStep.run !== 'string' || !mutatedCheckStep.run.includes('changed=false')) {
    return true;
  }

  return false;
}
