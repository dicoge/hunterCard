#!/usr/bin/env node
/**
 * DIC-1291 / DIC-1292: Official Catalog Sync must hand changes off through
 * a pull-request against protected `main`, not push directly.
 *
 * The failure this guards against is exactly the one from run 33558958119:
 * the workflow finished the whole DIC-1167 pipeline (discovery, ingestion,
 * merge, buy-price alignment, native generation, hEB01 validation, data-
 * change detection), staged 5 files and then blew up on
 * `git push origin HEAD:main` with GH006 because protected main requires
 * two checks. A "fix" that quietly reintroduces that push — or that gets
 * around the block with `--force`, `--admin`, a PAT with bypass rights, a
 * variable-form refspec that expands to main, or a stealth overwrite of a
 * manually-pushed sync branch whose committer email was forged to match
 * automation — must be caught here mechanically instead of on the next
 * 21:04 UTC schedule tick.
 *
 * Four layers, because static string checks alone are easy to lie past
 * (DIC-1292 CR blocker #1 was that the earlier version relied on them,
 * and CR round 2 caught that even our first ownership gate trusted
 * forgeable `git log --format=%ce`/`%s` metadata):
 *
 *   1. Static — the workflow file AND the extracted handoff module
 *      cannot contain any push target that resolves to protected main,
 *      in any literal or variable form (`main`, `$BASE_BRANCH`,
 *      `${BASE_BRANCH}`, quoted, force-lease variants,
 *      `refs/heads/main`, …). No branch-protection bypass, no
 *      user-supplied secret, no scope wider than the handoff needs, and
 *      no `git log --format=%ce`/`%s` reads on a remote SHA that would
 *      re-open the forgeable-metadata gap.
 *   2. Structural — the DIC-1167 pipeline is preserved end-to-end, the
 *      change-check step still emits `changed=false`, the handoff step
 *      is gated on it and only calls the extracted module, third-party
 *      actions are version- / SHA-pinned, and the ownership check calls
 *      `gh api /repos/{owner}/{repo}/commits/<sha>/pulls` (server-side
 *      provenance) instead of trusting local committer metadata.
 *   3. Behavioural — the extracted handoff module is driven end-to-end
 *      with mock `git` / `gh` implementations across the real
 *      scenarios: no-change, existing-PR-same, existing-PR-different,
 *      no-PR-fresh-branch, no-PR-remote-owned-via-historical-bot-PR,
 *      no-PR-remote-with-SPOOFED-committer-metadata (must throw), and
 *      open-PR-authored-by-a-human (must throw). Each scenario asserts
 *      the exact sequence of push / gh-pr / gh-api calls the handoff
 *      makes.
 *   4. Mutation — deliberately-broken copies of the workflow AND the
 *      handoff module are re-run through the earlier layers AND, for
 *      handoff mutations, executed through cache-busted fresh imports
 *      against the same hostile scenarios the real code sees. DIC-1292
 *      CR round 3 rejected static-only mutation checks: a logical
 *      bypass such as `if (true || (pr.headRef === SYNC_BRANCH && …))`
 *      preserves every regex-required string but disables the check at
 *      runtime. Every handoff mutation now has to survive the hostile
 *      behavioural scenarios; a mutation that all scenarios still
 *      accept as safe is treated as a rot in the safety net, and the
 *      test fails naming the mutation.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

import {
  runHandoff,
  SYNC_PATHS as HANDOFF_SYNC_PATHS,
  AUTOMATION_LOGINS,
  COMMIT_MSG_PREFIX,
} from '../.github/scripts/official-catalog-sync-handoff.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_PATH = path.join(ROOT, '.github/workflows/official-catalog-sync.yml');
const HANDOFF_PATH = path.join(ROOT, '.github/scripts/official-catalog-sync-handoff.mjs');

const workflowText = fs.readFileSync(WORKFLOW_PATH, 'utf8');
const workflow = parseYaml(workflowText);
const handoffText = fs.readFileSync(HANDOFF_PATH, 'utf8');

// ------------------------------------------------------------------- layer 1
// Static: no protected-main push, in any form, in either file.

// Every literal or variable-form spelling of a push destination that would
// resolve to the base branch. DIC-1292 blocker #1: the previous regex set
// only caught the literal `main` form and missed `$BASE_BRANCH` /
// `${BASE_BRANCH}` / quoted variants, force-lease refspecs whose dst side
// named the base branch, and template-literal spellings inside the Node
// handoff whose `git push` prefix lives on a different source line.
//
// These patterns are deliberately context-free (no leading `git push`
// requirement) so they still fire when the destination string is spelled
// as a bare argument literal in JS source. The strings themselves never
// appear in prose or comments in either file — verified by grep at write
// time — so false-positive risk is zero and the regex will not rot into
// a no-op the way a `git push`-prefixed one did.
const FORBIDDEN_TARGET_PATTERNS = [
  // Literal `main` as a push destination in any shape.
  { name: 'HEAD:main destination', re: /HEAD\s*:\s*\+?main\b/ },
  { name: 'HEAD:refs/heads/main destination', re: /HEAD\s*:\s*refs\/heads\/main\b/ },
  { name: 'quoted refs/heads/main destination', re: /['"`]\+?refs\/heads\/main\b/ },
  { name: '--force-with-lease=main', re: /--force-with-lease=(?:refs\/heads\/)?main\b/ },
  // Variable spellings that expand to the base branch. The BASE_BRANCH
  // env var IS "main" (asserted below); catching every spelling of that
  // var on the destination side of a push refspec closes the DIC-1292 gap.
  { name: 'HEAD:$BASE_BRANCH destination', re: /HEAD\s*:\s*\+?\$\{?BASE_BRANCH\}?/ },
  { name: 'HEAD:refs/heads/$BASE_BRANCH destination', re: /HEAD\s*:\s*refs\/heads\/\$\{?BASE_BRANCH\}?/ },
  { name: 'quoted refs/heads/${BASE_BRANCH} template', re: /['"`]refs\/heads\/\$\{?BASE_BRANCH\}?/ },
  { name: '--force-with-lease=$BASE_BRANCH', re: /--force-with-lease=(?:refs\/heads\/)?\$\{?BASE_BRANCH\}?/ },
  // Shell-only shapes that don't wear a `HEAD:` prefix but still push
  // straight at the base branch. Guarded by `git\s+push` so a passing
  // reference to `origin main` in prose doesn't trip.
  { name: 'git push origin main', re: /git\s+push[^\n]*\borigin\s+["']?\+?main\b/ },
  { name: 'git push origin +main', re: /git\s+push[^\n]*\borigin\s+\+main\b/ },
  { name: 'git push --force main', re: /git\s+push[^\n]*--force\b[^\n]*\bmain\b/ },
  { name: 'git push -f origin main', re: /git\s+push[^\n]*-f\s+origin\s+["']?main\b/ },
  { name: 'git push origin $BASE_BRANCH', re: /git\s+push[^\n]*\borigin\s+["']?\+?\$\{?BASE_BRANCH\}?/ },
];

const SUSPECT_FILES = { workflow: workflowText, handoff: handoffText };
for (const [label, text] of Object.entries(SUSPECT_FILES)) {
  for (const { name, re } of FORBIDDEN_TARGET_PATTERNS) {
    assert.ok(!re.test(text), `${label} must not push to protected main (matched "${name}": ${re})`);
  }
}

// The bypasses that would silently defeat branch protection even without a
// literal `HEAD:main` push. `--admin` merges past required checks; a
// user-supplied `PAT` / `ADMIN` / `BYPASS` secret typically exists precisely
// so a workflow can circumvent protection. `gh api ... /branches/main/
// protection` writes would let the workflow relax protection on itself.
const FORBIDDEN_BYPASS_PATTERNS = [
  { name: 'gh pr merge --admin', re: /gh\s+pr\s+merge[^\n]*--admin\b/ },
  { name: 'PAT/ADMIN/BYPASS secret', re: /\bsecrets\.[A-Z0-9_]*(?:PAT|ADMIN|BYPASS)[A-Z0-9_]*\b/ },
  { name: 'branches/main/protection write', re: /gh\s+api[^\n]*\/branches\/main\/protection\b/ },
  { name: 'allow_force_pushes on main', re: /allow_force_pushes/i },
  { name: 'enforce_admins false', re: /enforce_admins[^\n]*false/ },
  // A plain `--force` push anywhere would sidestep the ownership + lease
  // discipline the handoff enforces. Only `--force-with-lease` is allowed.
  { name: 'plain --force push', re: /git\s+push[^\n]*--force\b(?!-with-lease)/ },
  { name: '-f push', re: /git\s+push[^\n]*(^|\s)-f(\s|$)/m },
];
for (const [label, text] of Object.entries(SUSPECT_FILES)) {
  for (const { name, re } of FORBIDDEN_BYPASS_PATTERNS) {
    assert.ok(!re.test(text), `${label} must not bypass branch protection (matched "${name}": ${re})`);
  }
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
// Structural YAML: pipeline preserved, dedicated no-change gate, handoff
// delegates to the extracted module.

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

// The DIC-1167 pipeline stays in place as ordered, distinct steps.
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
// check uses AND the same set the extracted handoff freezes.
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
assert.deepStrictEqual(
  [...HANDOFF_SYNC_PATHS],
  EXPECTED_SYNC_PATHS,
  'handoff module SYNC_PATHS must match the workflow-side sync path set exactly',
);

// The handoff step is a thin wrapper that runs the extracted module — the
// mutation-sensitive scenarios below only cover the module, so any
// inlined shell logic here would slip past them.
assert.ok(
  /node\s+\.github\/scripts\/official-catalog-sync-handoff\.mjs\b/.test(stepRuns),
  'workflow must delegate the handoff to .github/scripts/official-catalog-sync-handoff.mjs so scenarios drive the real code path',
);
assert.ok(
  !/\bgh\s+pr\s+(create|list|merge)\b/.test(stepRuns),
  'workflow must not call `gh pr create/list/merge` inline — that belongs in the extracted handoff module',
);
assert.ok(
  !/\bgit\s+push\b/.test(stepRuns),
  'workflow must not call `git push` inline — every push must go through the extracted handoff module so ownership + lease checks apply',
);

const workflowSyncBranch = job.env?.SYNC_BRANCH ?? workflow.env?.SYNC_BRANCH;
const workflowBaseBranch = job.env?.BASE_BRANCH ?? workflow.env?.BASE_BRANCH;
assert.strictEqual(workflowBaseBranch, 'main', 'BASE_BRANCH env var must be `main`');
assert.ok(
  typeof workflowSyncBranch === 'string' && workflowSyncBranch.startsWith('bot/'),
  `SYNC_BRANCH must live under bot/… (got \`${workflowSyncBranch}\`)`,
);
assert.notStrictEqual(
  workflowSyncBranch,
  workflowBaseBranch,
  'SYNC_BRANCH must not equal BASE_BRANCH',
);

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

for (const uses of stepUses) {
  assert.ok(
    /@(?:v\d+(?:\.\d+){0,2}|[0-9a-f]{40})$/.test(uses),
    `workflow action \`${uses}\` must be pinned to a version (vN) or full SHA`,
  );
}

// Handoff module invariants that live at the source-text level (the
// behavioural layer covers behaviour, this covers "the guard code is there
// at all"). The lease MUST be bound to a specific SHA — a bare
// `--force-with-lease` without the `<ref>:<expect>` form would still
// overwrite a stale remote that changed after our fetch.
assert.ok(
  /--force-with-lease=refs\/heads\/\$\{SYNC_BRANCH\}:\$\{remoteSha\}/.test(handoffText),
  'handoff module must bind --force-with-lease to the validated remote SHA (DIC-1292 CR round 1)',
);

// DIC-1292 CR round 2: the ownership check must call the server-side
// GitHub API — never trust local `git log --format=%ce` / `--format=%s`
// on the remote SHA (both are trivially forgeable via `git commit
// --author=… -m …`). Two rules pinned here:
assert.ok(
  /resolveRemoteProvenance\s*\(/.test(handoffText),
  'handoff module must gate the force-push on a resolveRemoteProvenance() call',
);
assert.ok(
  /gh['"\s,\[\]]+api['"\s,\[\]]+`?\/?repos\/\{owner\}\/\{repo\}\/commits\/\$\{remoteSha\}\/pulls/.test(handoffText),
  'handoff module must call `gh api /repos/{owner}/{repo}/commits/<sha>/pulls` — non-forgeable server-side provenance (DIC-1292 CR round 2)',
);
// Match the quoted-arg form only, so the docstring can still reference
// the historical `--format=%ce`/`%s` gap by name for context. A real
// call would appear as `'--format=%ce'` / `"--format=%ce"` inside an
// exec(git, [...]) array; that form is what we ban.
assert.ok(
  !/['"]--format=%ce['"]/.test(handoffText),
  'handoff module must NOT read the remote SHA committer email — that is forgeable and CR round 2 rejected trusting it',
);
assert.ok(
  !/['"]--format=%s['"]/.test(handoffText),
  'handoff module must NOT read the remote SHA commit subject — that is forgeable and CR round 2 rejected trusting it',
);
assert.ok(
  !/AUTOMATION_COMMITTER_EMAIL/.test(handoffText),
  'handoff module must no longer export or use AUTOMATION_COMMITTER_EMAIL — the forgeable committer-email ownership signal was removed in CR round 2',
);

assert.ok(
  /AUTOMATION_LOGINS\.includes\(/.test(handoffText),
  'handoff module must reject open PRs on the sync branch that were opened by non-automation users',
);
assert.deepStrictEqual([...AUTOMATION_LOGINS], ['github-actions', 'github-actions[bot]']);
assert.strictEqual(COMMIT_MSG_PREFIX, 'chore: sync official catalog');

// ------------------------------------------------------------------- layer 3
// Behavioural: drive the extracted handoff end-to-end. Each scenario
// asserts the EXACT sequence of git / gh calls so a regression in the
// shell path (e.g. dropping the ownership check, unbinding the lease,
// re-adding a direct push) fails here instead of on production.

const SYNC_BRANCH = 'bot/official-catalog-sync';
const BASE_BRANCH = 'main';
const NOW = () => new Date('2026-09-02T00:00:00Z');
const COMMIT_MSG = `${COMMIT_MSG_PREFIX} 2026-09-02`;

await scenario('no-change run is a silent success', async () => {
  const { result, calls } = await drive({
    on: {
      'git diff --stat -- data/official/ data/database.json public/data/database.json docs/audits/official-catalog-audit.json docs/audits/official-production-lag-state.json': () => ({ stdout: '' }),
    },
  });
  assert.deepStrictEqual(result, { outcome: 'no-op-no-changes' });
  assertNoPush(calls);
  assert.ok(!calls.some((c) => c.cmd === 'gh'), 'no-change run must not touch gh');
});

await scenario('existing PR whose head already carries this snapshot is left untouched', async () => {
  const existingHead = 'ffffffffffffffffffffffffffffffffffffffff';
  const { result, calls } = await drive({
    on: {
      diffStat: () => ({ stdout: ' data/database.json | 1 +' }),
      ghPrList: () => ({
        stdout: JSON.stringify([{ number: 174, headRefOid: existingHead, author: { login: 'github-actions[bot]' } }]),
      }),
      'git fetch --no-tags origin ffffffffffffffffffffffffffffffffffffffff': () => ({ stdout: '' }),
      'git diff --quiet ffffffffffffffffffffffffffffffffffffffff --': () => ({ stdout: '', status: 0 }),
    },
  });
  assert.deepStrictEqual(result, { outcome: 'no-op-already-open', prNumber: 174 });
  assertNoPush(calls);
  assert.ok(!calls.some((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create'), 'must not open a duplicate PR');
  assert.ok(!calls.some((c) => c.cmd === 'git' && c.args[0] === 'switch'), 'must not rebuild the sync branch when the PR already matches');
});

await scenario('existing PR whose head differs refreshes with lease bound to validated remote SHA (open-PR provenance)', async () => {
  const existingHead = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const remoteSha = existingHead; // remote tip = current PR head, owned via open-PR provenance
  const { result, calls } = await drive({
    on: {
      diffStat: () => ({ stdout: ' data/database.json | 1 +' }),
      ghPrList: () => ({
        stdout: JSON.stringify([{ number: 174, headRefOid: existingHead, author: { login: 'github-actions[bot]' } }]),
      }),
      [`git fetch --no-tags origin ${existingHead}`]: () => ({ stdout: '' }),
      [`git diff --quiet ${existingHead} --`]: () => ({ stdout: '', status: 1 }),
      [`git switch --force-create ${SYNC_BRANCH} origin/${BASE_BRANCH}`]: () => ({ stdout: '' }),
      'git add --': () => ({ stdout: '' }),
      'git diff --staged --quiet': () => ({ stdout: '', status: 1 }),
      [`git commit -m ${COMMIT_MSG}`]: () => ({ stdout: '' }),
      [`git fetch --no-tags origin ${SYNC_BRANCH}`]: () => ({ stdout: '' }),
      [`git rev-parse --verify --quiet refs/remotes/origin/${SYNC_BRANCH}`]: () => ({ stdout: `${remoteSha}\n`, status: 0 }),
      // Open-PR provenance fires (remote SHA == open PR head, PR author
      // verified as github-actions[bot] via `gh pr list --json author`).
      // No `gh api …/commits/<sha>/pulls` call is needed for this branch.
      [`git push --force-with-lease=refs/heads/${SYNC_BRANCH}:${remoteSha} origin HEAD:refs/heads/${SYNC_BRANCH}`]: () => ({ stdout: '' }),
    },
  });
  assert.deepStrictEqual(result, { outcome: 'refreshed-pr', prNumber: 174 });
  const pushCall = calls.find((c) => c.cmd === 'git' && c.args[0] === 'push');
  assert.ok(pushCall, 'refresh scenario must push');
  assert.ok(
    pushCall.args.includes(`--force-with-lease=refs/heads/${SYNC_BRANCH}:${remoteSha}`),
    `lease must be bound to the validated remote SHA (got args: ${JSON.stringify(pushCall.args)})`,
  );
  assert.ok(!pushCall.args.some((a) => a === 'main' || a === BASE_BRANCH || /main\b/.test(a)), 'push must never mention the base branch');
  assert.ok(!calls.some((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create'), 'refresh must not open a new PR');
  // Forgeable local-metadata reads MUST NOT happen on any path.
  assert.ok(!calls.some((c) => c.cmd === 'git' && c.args[0] === 'log' && c.args.some((a) => a === '--format=%ce' || a === '--format=%s')), 'must NOT read forgeable committer email/subject on any code path (DIC-1292 CR round 2)');
});

await scenario('no existing PR, no remote branch: plain push (no force) + gh pr create', async () => {
  const { result, calls } = await drive({
    on: {
      diffStat: () => ({ stdout: ' data/database.json | 1 +' }),
      ghPrList: () => ({ stdout: '[]' }),
      [`git switch --force-create ${SYNC_BRANCH} origin/${BASE_BRANCH}`]: () => ({ stdout: '' }),
      'git add --': () => ({ stdout: '' }),
      'git diff --staged --quiet': () => ({ stdout: '', status: 1 }),
      [`git commit -m ${COMMIT_MSG}`]: () => ({ stdout: '' }),
      [`git fetch --no-tags origin ${SYNC_BRANCH}`]: () => ({ stdout: '', status: 1 }),
      [`git rev-parse --verify --quiet refs/remotes/origin/${SYNC_BRANCH}`]: () => ({ stdout: '', status: 1 }),
      [`git push origin HEAD:refs/heads/${SYNC_BRANCH}`]: () => ({ stdout: '' }),
      'gh pr create': () => ({ stdout: 'https://github.com/dicoge/hunterCard/pull/999\n' }),
    },
  });
  assert.deepStrictEqual(result, { outcome: 'created-pr' });
  const pushCall = calls.find((c) => c.cmd === 'git' && c.args[0] === 'push');
  assert.ok(pushCall, 'fresh scenario must push');
  assert.ok(!pushCall.args.some((a) => a.startsWith('--force')), 'fresh push must not use --force (no remote to overwrite)');
  assert.ok(pushCall.args.includes(`HEAD:refs/heads/${SYNC_BRANCH}`), 'fresh push must target the sync branch, never main');
  const prCreate = calls.find((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create');
  assert.ok(prCreate, 'fresh scenario must open the PR');
  assert.ok(prCreate.args.includes(BASE_BRANCH), 'PR base must be main');
  assert.ok(prCreate.args.includes(SYNC_BRANCH), 'PR head must be the sync branch');
});

await scenario('no existing PR, remote sync branch traceable to a historical bot PR: lease bound + gh pr create', async () => {
  const remoteSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const { result, calls } = await drive({
    on: {
      diffStat: () => ({ stdout: ' data/database.json | 1 +' }),
      ghPrList: () => ({ stdout: '[]' }),
      [`git switch --force-create ${SYNC_BRANCH} origin/${BASE_BRANCH}`]: () => ({ stdout: '' }),
      'git add --': () => ({ stdout: '' }),
      'git diff --staged --quiet': () => ({ stdout: '', status: 1 }),
      [`git commit -m ${COMMIT_MSG}`]: () => ({ stdout: '' }),
      [`git fetch --no-tags origin ${SYNC_BRANCH}`]: () => ({ stdout: '' }),
      [`git rev-parse --verify --quiet refs/remotes/origin/${SYNC_BRANCH}`]: () => ({ stdout: `${remoteSha}\n`, status: 0 }),
      // Server-side provenance: GitHub reports this SHA is the head of a
      // prior (closed / merged) PR from the sync branch, authored by
      // github-actions[bot]. This association is built from the commit
      // graph GitHub itself recorded — a spoofed remote commit has a new
      // SHA that no such PR contains, so this path cannot be forged.
      [`gh api /repos/{owner}/{repo}/commits/${remoteSha}/pulls`]: () => ({
        stdout: JSON.stringify([
          {
            number: 170,
            state: 'closed',
            head: { ref: SYNC_BRANCH },
            base: { ref: BASE_BRANCH },
            user: { login: 'github-actions[bot]' },
          },
        ]),
      }),
      [`git push --force-with-lease=refs/heads/${SYNC_BRANCH}:${remoteSha} origin HEAD:refs/heads/${SYNC_BRANCH}`]: () => ({ stdout: '' }),
      'gh pr create': () => ({ stdout: 'https://github.com/dicoge/hunterCard/pull/1000\n' }),
    },
  });
  assert.deepStrictEqual(result, { outcome: 'created-pr' });
  const pushCall = calls.find((c) => c.cmd === 'git' && c.args[0] === 'push');
  assert.ok(
    pushCall.args.some((a) => a === `--force-with-lease=refs/heads/${SYNC_BRANCH}:${remoteSha}`),
    'lease must be bound to the validated remote SHA on the "no open PR, historical bot PR" path',
  );
  // The gh api commit-pulls call must have actually happened — that's
  // the whole point of DIC-1292 CR round 2.
  const apiCall = calls.find((c) => c.cmd === 'gh' && c.args[0] === 'api' && c.args[1].includes(`commits/${remoteSha}/pulls`));
  assert.ok(apiCall, 'must call `gh api /repos/{owner}/{repo}/commits/<sha>/pulls` for server-side provenance');
  assert.ok(!calls.some((c) => c.cmd === 'git' && c.args[0] === 'log' && c.args.some((a) => a === '--format=%ce' || a === '--format=%s')), 'must NOT read forgeable committer email/subject on any code path (DIC-1292 CR round 2)');
});

await scenario('HOSTILE REGRESSION: remote tip with SPOOFED committer=action@github.com and subject "chore: sync official catalog …" fails closed', async () => {
  // The DIC-1292 CR round 2 attack: an outsider force-pushes to
  // bot/official-catalog-sync a commit crafted with
  //   git commit --author='X <action@github.com>' -m 'chore: sync official catalog 2026-09-02'
  // and hopes the handoff trusts committer email + subject prefix. It
  // must not. Only server-side PR association is trusted, and GitHub
  // reports no bot PR contains this SHA.
  const remoteSha = 'ccccccccccccccccccccccccccccccccccccccc0';
  let threw = null;
  const { calls } = await drive({
    expectThrow: (err) => (threw = err),
    on: {
      diffStat: () => ({ stdout: ' data/database.json | 1 +' }),
      ghPrList: () => ({ stdout: '[]' }),
      [`git switch --force-create ${SYNC_BRANCH} origin/${BASE_BRANCH}`]: () => ({ stdout: '' }),
      'git add --': () => ({ stdout: '' }),
      'git diff --staged --quiet': () => ({ stdout: '', status: 1 }),
      [`git commit -m ${COMMIT_MSG}`]: () => ({ stdout: '' }),
      [`git fetch --no-tags origin ${SYNC_BRANCH}`]: () => ({ stdout: '' }),
      [`git rev-parse --verify --quiet refs/remotes/origin/${SYNC_BRANCH}`]: () => ({ stdout: `${remoteSha}\n`, status: 0 }),
      // Server-side provenance: GitHub has NEVER seen this SHA inside a
      // bot-authored PR from bot/…, so the check refuses. The spoofed
      // committer / subject the attacker set locally are never read —
      // if the handoff still reads them, the `drive` mock throws
      // "no handler for git log --format=…" and the scenario fails,
      // which is exactly the safety net we want.
      [`gh api /repos/{owner}/{repo}/commits/${remoteSha}/pulls`]: () => ({ stdout: '[]' }),
    },
  });
  assert.ok(threw, 'hostile-remote scenario must throw');
  assert.match(threw.message, /unrecognized ownership/, 'error must name the ownership gate');
  assert.match(threw.message, new RegExp(remoteSha), 'error must include the offending SHA');
  const pushCall = calls.find((c) => c.cmd === 'git' && c.args[0] === 'push');
  assert.strictEqual(pushCall, undefined, 'hostile-remote scenario MUST NOT push');
  const prCreate = calls.find((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create');
  assert.strictEqual(prCreate, undefined, 'hostile-remote scenario MUST NOT open a PR');
  assert.ok(!calls.some((c) => c.cmd === 'git' && c.args[0] === 'log' && c.args.some((a) => a === '--format=%ce' || a === '--format=%s')), 'MUST NOT read forgeable committer email/subject — that is the whole class of vulnerability CR round 2 rejected');
});

await scenario('HOSTILE REGRESSION 2: SHA associated only with a non-bot PR (e.g. attacker opened their own PR containing the SHA) fails closed', async () => {
  // An attacker could open their OWN PR whose branch contains a
  // malicious commit; that commit's SHA would show up in the
  // commits/<sha>/pulls API. But since the PR wasn't opened from the
  // bot's sync branch AND wasn't authored by github-actions[bot], the
  // provenance check must still refuse.
  const remoteSha = 'ccccccccccccccccccccccccccccccccccccccc1';
  let threw = null;
  const { calls } = await drive({
    expectThrow: (err) => (threw = err),
    on: {
      diffStat: () => ({ stdout: ' data/database.json | 1 +' }),
      ghPrList: () => ({ stdout: '[]' }),
      [`git switch --force-create ${SYNC_BRANCH} origin/${BASE_BRANCH}`]: () => ({ stdout: '' }),
      'git add --': () => ({ stdout: '' }),
      'git diff --staged --quiet': () => ({ stdout: '', status: 1 }),
      [`git commit -m ${COMMIT_MSG}`]: () => ({ stdout: '' }),
      [`git fetch --no-tags origin ${SYNC_BRANCH}`]: () => ({ stdout: '' }),
      [`git rev-parse --verify --quiet refs/remotes/origin/${SYNC_BRANCH}`]: () => ({ stdout: `${remoteSha}\n`, status: 0 }),
      [`gh api /repos/{owner}/{repo}/commits/${remoteSha}/pulls`]: () => ({
        stdout: JSON.stringify([
          {
            number: 999,
            state: 'open',
            head: { ref: 'attacker/pwn' },
            base: { ref: BASE_BRANCH },
            user: { login: 'someone-else' },
          },
        ]),
      }),
    },
  });
  assert.ok(threw, 'non-bot-PR association must not be accepted as ownership');
  assert.match(threw.message, /unrecognized ownership/, 'error must name the ownership gate');
  const pushCall = calls.find((c) => c.cmd === 'git' && c.args[0] === 'push');
  assert.strictEqual(pushCall, undefined, 'non-bot-PR scenario MUST NOT push');
});

await scenario('open PR authored by a random human on the sync branch: fails closed without pushing', async () => {
  let threw = null;
  const { calls } = await drive({
    expectThrow: (err) => (threw = err),
    on: {
      diffStat: () => ({ stdout: ' data/database.json | 1 +' }),
      ghPrList: () => ({
        stdout: JSON.stringify([{ number: 555, headRefOid: 'dddddddddddddddddddddddddddddddddddddddd', author: { login: 'someone-else' } }]),
      }),
    },
  });
  assert.ok(threw, 'human-authored PR scenario must throw');
  assert.match(threw.message, /not github-actions\[bot\]/, 'error must name the PR-author gate');
  assert.strictEqual(calls.find((c) => c.cmd === 'git' && c.args[0] === 'push'), undefined, 'must not push');
});

// ------------------------------------------------------------------- layer 4
// Mutation: broken copies of both files must be rejected. This exists so
// the earlier layers cannot silently rot as the code evolves.

const WORKFLOW_MUTATIONS = [
  {
    name: 'direct HEAD:main push replaces handoff (the GH006 regression)',
    mutate: (text) =>
      text.replace(
        /- name: Open or refresh sync PR[\s\S]*$/m,
        [
          '- name: Commit and push catalog changes',
          "  if: steps.check.outputs.changed == 'true'",
          '  run: |',
          '    git add -- data/official/ data/database.json',
          '    git commit -m "chore: sync official catalog"',
          '    git push origin HEAD:main',
        ].join('\n'),
      ),
  },
  {
    name: 'HEAD:$BASE_BRANCH variable-form push',
    mutate: (text) =>
      text.replace(
        /- name: Open or refresh sync PR[\s\S]*$/m,
        [
          '- name: Push directly',
          "  if: steps.check.outputs.changed == 'true'",
          '  run: |',
          '    git push origin HEAD:$BASE_BRANCH',
        ].join('\n'),
      ),
  },
  {
    name: 'HEAD:${BASE_BRANCH} braced variable push',
    mutate: (text) =>
      text.replace(
        /- name: Open or refresh sync PR[\s\S]*$/m,
        [
          '- name: Push directly',
          "  if: steps.check.outputs.changed == 'true'",
          '  run: |',
          '    git push origin HEAD:${BASE_BRANCH}',
        ].join('\n'),
      ),
  },
  {
    name: 'refs/heads/$BASE_BRANCH push',
    mutate: (text) =>
      text.replace(
        /- name: Open or refresh sync PR[\s\S]*$/m,
        [
          '- name: Push directly',
          "  if: steps.check.outputs.changed == 'true'",
          '  run: |',
          '    git push origin HEAD:refs/heads/$BASE_BRANCH',
        ].join('\n'),
      ),
  },
  {
    name: 'force-with-lease targeting main',
    mutate: (text) =>
      text.replace(
        /- name: Open or refresh sync PR[\s\S]*$/m,
        [
          '- name: Push directly',
          "  if: steps.check.outputs.changed == 'true'",
          '  run: |',
          '    git push --force-with-lease=refs/heads/main origin HEAD:main',
        ].join('\n'),
      ),
  },
  {
    name: 'gh pr merge --admin bypass',
    mutate: (text) =>
      text.replace(
        /node \.github\/scripts\/official-catalog-sync-handoff\.mjs/,
        'node .github/scripts/official-catalog-sync-handoff.mjs && gh pr merge --admin 174',
      ),
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

for (const { name, mutate } of WORKFLOW_MUTATIONS) {
  const mutated = mutate(workflowText);
  assert.notStrictEqual(
    mutated,
    workflowText,
    `workflow mutation "${name}" did not actually change the file — the regex/replacement drifted from the source`,
  );
  const rejected = detectWorkflowPolicyViolation(mutated);
  assert.ok(
    rejected,
    `workflow mutation "${name}" must be rejected by the static + structural checks; the safety net has rotted`,
  );
}

const HANDOFF_MUTATIONS = [
  {
    name: 'handoff pushes HEAD:main directly',
    mutate: (text) => text.replace(/`HEAD:refs\/heads\/\$\{SYNC_BRANCH\}`/g, "'HEAD:refs/heads/main'"),
  },
  {
    name: 'handoff pushes to $BASE_BRANCH template',
    mutate: (text) => text.replace(/`HEAD:refs\/heads\/\$\{SYNC_BRANCH\}`/g, '`HEAD:refs/heads/${BASE_BRANCH}`'),
  },
  {
    name: 'handoff unbinds the lease (bare --force-with-lease)',
    mutate: (text) =>
      text.replace(/`--force-with-lease=refs\/heads\/\$\{SYNC_BRANCH\}:\$\{remoteSha\}`/, "'--force-with-lease'"),
  },
  {
    name: 'handoff drops the server-side provenance gate',
    mutate: (text) => text.replace(/if \(!provenance\.ok\) \{[\s\S]*?\}\n/, ''),
  },
  {
    name: 'handoff drops the automation-login PR-author gate',
    mutate: (text) => text.replace(/if \(!AUTOMATION_LOGINS\.includes\(login\)\) \{[\s\S]*?\}\n/, ''),
  },
  {
    name: 'handoff re-introduces forgeable committer-email ownership signal (CR round 2 regression)',
    mutate: (text) =>
      text.replace(
        /const raw = exec\('gh', \[\n {4}'api',/,
        [
          "const committerEmail = exec('git', ['log', '-1', '--format=%ce', remoteSha]).stdout.trim();",
          "if (committerEmail === 'action@github.com') { return { ok: true, via: 'committer signature (INSECURE)' }; }",
          "const raw = exec('gh', [",
          "    'api',",
        ].join('\n  '),
      ),
  },
  {
    name: 'handoff re-introduces forgeable subject-prefix ownership signal (CR round 2 regression)',
    mutate: (text) =>
      text.replace(
        /const raw = exec\('gh', \[\n {4}'api',/,
        [
          "const subject = exec('git', ['log', '-1', '--format=%s', remoteSha]).stdout.trim();",
          "if (subject.startsWith(COMMIT_MSG_PREFIX)) { return { ok: true, via: 'subject prefix (INSECURE)' }; }",
          "const raw = exec('gh', [",
          "    'api',",
        ].join('\n  '),
      ),
  },
  {
    name: 'handoff drops the historical-bot-PR head/author check (accepts ANY PR association)',
    mutate: (text) =>
      text.replace(
        /if \(pr\.headRef === SYNC_BRANCH && AUTOMATION_LOGINS\.includes\(pr\.login \?\? ''\)\) \{[\s\S]*?\}\n/,
        'return { ok: true, via: `association #${pr.number}` };\n',
      ),
  },
];

for (const { name, mutate } of HANDOFF_MUTATIONS) {
  const mutated = mutate(handoffText);
  assert.notStrictEqual(
    mutated,
    handoffText,
    `handoff mutation "${name}" did not actually change the file — the regex/replacement drifted from the source`,
  );
  assert.ok(
    detectHandoffPolicyViolation(mutated),
    `handoff mutation "${name}" must be rejected by the static checks; the safety net has rotted`,
  );
  // DIC-1292 CR round 3: static string presence is insufficient. Every
  // mutation must ALSO fail behaviourally when run against the hostile
  // scenarios below, so a future logical-bypass mutation that keeps every
  // required string cannot slip past both layers.
  await verifyMutationBehaviourallyCaught({ name, mutatedText: mutated });
  console.log(`  ✓ handoff mutation "${name}" caught statically + behaviourally`);
}

// DIC-1292 CR round 3: mutations that keep every regex-required string
// but disable the gate at runtime (`if (true || …)`, `if (false && …)`,
// early-return before the loop). These are undetectable by any string
// check by construction — they exist SPECIFICALLY to prove the
// behavioural harness works. If any of these ever slip past every
// hostile scenario, the whole safety net is a fiction.
const HANDOFF_MUTATIONS_BEHAVIORAL_ONLY = [
  {
    name: 'logical bypass: `if (true || (pr.headRef === SYNC_BRANCH && …))` (the CR round-3 exemplar)',
    mutate: (text) =>
      text.replace(
        /if \(pr\.headRef === SYNC_BRANCH && AUTOMATION_LOGINS\.includes\(pr\.login \?\? ''\)\)/,
        "if (true || (pr.headRef === SYNC_BRANCH && AUTOMATION_LOGINS.includes(pr.login ?? '')))",
      ),
  },
  {
    name: 'logical bypass: outer provenance gate short-circuited (`if (false && !provenance.ok)`)',
    mutate: (text) => text.replace(/if \(!provenance\.ok\)/, 'if (false && !provenance.ok)'),
  },
  {
    name: 'logical bypass: PR-author gate short-circuited (`if (false && !AUTOMATION_LOGINS.includes(login))`)',
    mutate: (text) =>
      text.replace(/if \(!AUTOMATION_LOGINS\.includes\(login\)\)/, 'if (false && !AUTOMATION_LOGINS.includes(login))'),
  },
  {
    name: 'logical bypass: early ok-return before the provenance loop',
    mutate: (text) =>
      text.replace(
        /for \(const pr of summarised\) \{/,
        "return { ok: true, via: 'debug' };\n  for (const pr of summarised) {",
      ),
  },
  {
    name: 'logical bypass: force-with-lease built from a stale local (`_hijacked`) SHA instead of the validated remote',
    mutate: (text) =>
      text.replace(
        /`--force-with-lease=refs\/heads\/\$\{SYNC_BRANCH\}:\$\{remoteSha\}`/,
        '`--force-with-lease=refs/heads/${SYNC_BRANCH}:${remoteSha.replace(/./g, "0")}`',
      ),
  },
];

for (const { name, mutate } of HANDOFF_MUTATIONS_BEHAVIORAL_ONLY) {
  const mutated = mutate(handoffText);
  assert.notStrictEqual(
    mutated,
    handoffText,
    `handoff behavioural-only mutation "${name}" did not actually change the file — the regex/replacement drifted from the source`,
  );
  await verifyMutationBehaviourallyCaught({ name, mutatedText: mutated });
  console.log(`  ✓ behavioural-only mutation "${name}" caught by hostile-scenario harness`);
}

// A meta-check: an IDENTITY mutation (mutated text === original text is
// disallowed above, so we test a semantically-equivalent no-op) MUST NOT
// be flagged as behaviourally caught — otherwise the harness would flag
// legitimate refactors as regressions. This proves the harness has real
// signal-to-noise and isn't just "everything fails".
await (async () => {
  const noop = handoffText.replace(/`Refreshed existing PR #\$\{existingPR\.number\} with new snapshot\.`/, "`Refreshed existing PR #${existingPR.number} with new snapshot.` /* noop */");
  const caught = await mutationBehaviourResult({ mutatedText: noop });
  assert.strictEqual(
    caught,
    null,
    `harness identity check failed: a semantically-identical mutation was reported as behaviourally caught by "${caught}" — the hostile scenarios are producing false positives.`,
  );
})();

console.log('✓ DIC-1291 / DIC-1292 official-catalog-sync workflow + handoff safety invariants passed');

// --------------------------------------------------------------- helpers

async function scenario(name, body) {
  try {
    await body();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

/**
 * Drive runHandoff with a mock exec and a keyed handler table. Each handler
 * is looked up by the concatenation of `cmd + ' ' + args.join(' ')`, with
 * `startsWith` fallbacks for the "diffStat" / "ghPrList" convenience keys.
 * The mock records every call so scenarios can assert exact sequences.
 */
async function drive({ on = {}, expectThrow = null, runHandoffFn = runHandoff } = {}) {
  const outcome = await driveScenario({ mocks: on, runHandoffFn });
  if (outcome.threw) {
    if (!expectThrow) throw outcome.threw;
    expectThrow(outcome.threw);
  }
  return { result: outcome.result, calls: outcome.calls, stdoutLog: outcome.stdoutLog };
}

/**
 * Run a hostile scenario against `runHandoffFn` (either the real handoff
 * or a cache-busted mutated copy). Never throws — catches every error and
 * returns it as `threw` so verifiers can assert on both branches.
 */
async function driveScenario({ mocks, runHandoffFn }) {
  const calls = [];
  const stdoutLog = [];
  const exec = (cmd, args, opts = {}) => {
    const key = `${cmd} ${args.join(' ')}`;
    calls.push({ cmd, args: [...args], opts });

    if (cmd === 'git' && args[0] === 'diff' && args[1] === '--stat' && mocks.diffStat) {
      return normalizeResponse(mocks.diffStat(args));
    }
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list' && mocks.ghPrList) {
      return normalizeResponse(mocks.ghPrList(args));
    }
    if (mocks[key]) return normalizeResponse(mocks[key](args));

    for (const [handlerKey, handler] of Object.entries(mocks)) {
      if (handlerKey === 'diffStat' || handlerKey === 'ghPrList') continue;
      if (key.startsWith(handlerKey)) return normalizeResponse(handler(args));
    }

    if (opts.allowFail) return { stdout: '', status: 1 };
    throw new Error(`mock exec: no handler for \`${key}\``);
  };
  const env = { SYNC_BRANCH, BASE_BRANCH, GH_TOKEN: 'mock-token' };

  let result;
  let threw;
  try {
    result = await runHandoffFn({ env, exec, log: (line) => stdoutLog.push(line), now: NOW });
  } catch (err) {
    threw = err;
  }
  return { result, calls, stdoutLog, threw };
}

// --- Behavioural mutation harness (DIC-1292 CR round 3) ------------

/**
 * Hostile scenarios exercised against every handoff mutation. Each
 * scenario provides mocks that let BOTH the correct handoff AND every
 * mutation execute to completion (forgeable-metadata mocks are always
 * present, so a mutation that re-adds `git log --format=%ce` reads a
 * spoofed value and continues into the push path rather than throwing
 * "no handler"). `verifySafe` returns `null` for the correct handoff
 * and a string describing the observed violation for a mutation that
 * slipped past the ownership gate. If ALL scenarios return null for a
 * mutation, the mutation is behaviourally invisible and the harness
 * fails naming it.
 *
 * Wrapped in a function so the whole thing hoists (function
 * declarations do, `const` array literals don't) — the mutation loops
 * at the top of the file call this indirectly before its position in
 * source order is reached at run-time.
 */
function buildHostileScenarios() {
  const SPOOFED_ONLY_SHA = 'ccccccccccccccccccccccccccccccccccccccc0';
  const ATTACKER_PR_SHA = 'ccccccccccccccccccccccccccccccccccccccc1';
  const HUMAN_PR_HEAD_SHA = 'dddddddddddddddddddddddddddddddddddddddd';
  const HISTORICAL_BOT_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  // Mocks a mutated handoff may reach for even though the correct one does
  // not. Providing them lets a bypass execute the push path so the
  // scenario's verifier catches it via `calls`, rather than being masked
  // by a "no handler" throw at the very moment it takes the wrong branch.
  const forgeableMetadataMocksFor = (sha) => ({
    [`git log -1 --format=%ce ${sha}`]: () => ({ stdout: 'action@github.com\n' }),
    [`git log -1 --format=%s ${sha}`]: () => ({ stdout: 'chore: sync official catalog 2026-09-02\n' }),
  });

  // Also provide permissive push / create / api handlers so a mutation
  // that goes all the way through the push path completes, and its args
  // end up in `calls` for the verifier to inspect.
  const permissivePushMocks = () => ({
    'git push ': () => ({ stdout: '' }),
    'gh pr create': () => ({ stdout: 'https://github.com/dicoge/hunterCard/pull/9999\n' }),
  });

  return [
  {
    name: 'sanity: correct handoff on no-change is a silent success',
    mocks: { diffStat: () => ({ stdout: '' }) },
    verifySafe: ({ result, calls, threw }) => {
      if (threw) return `unexpected throw: ${threw.message}`;
      if (result?.outcome !== 'no-op-no-changes') return `expected no-op-no-changes, got ${JSON.stringify(result)}`;
      const push = calls.find((c) => c.cmd === 'git' && c.args[0] === 'push');
      if (push) return `unexpected push on no-change path: ${JSON.stringify(push.args)}`;
      return null;
    },
  },
  {
    name: 'hostile: remote tip with SPOOFED committer/subject + empty PR association MUST throw and MUST NOT push',
    mocks: {
      diffStat: () => ({ stdout: ' data/database.json | 1 +' }),
      ghPrList: () => ({ stdout: '[]' }),
      [`git switch --force-create ${SYNC_BRANCH} origin/${BASE_BRANCH}`]: () => ({ stdout: '' }),
      'git add --': () => ({ stdout: '' }),
      'git diff --staged --quiet': () => ({ stdout: '', status: 1 }),
      [`git commit -m ${COMMIT_MSG}`]: () => ({ stdout: '' }),
      [`git fetch --no-tags origin ${SYNC_BRANCH}`]: () => ({ stdout: '' }),
      [`git rev-parse --verify --quiet refs/remotes/origin/${SYNC_BRANCH}`]: () => ({ stdout: `${SPOOFED_ONLY_SHA}\n`, status: 0 }),
      ...forgeableMetadataMocksFor(SPOOFED_ONLY_SHA),
      [`gh api /repos/{owner}/{repo}/commits/${SPOOFED_ONLY_SHA}/pulls`]: () => ({ stdout: '[]' }),
      ...permissivePushMocks(),
    },
    verifySafe: ({ threw, calls }) => {
      if (!threw) return 'correct handoff must throw on spoofed-metadata + empty association';
      const push = calls.find((c) => c.cmd === 'git' && c.args[0] === 'push');
      if (push) return `MUST NOT push: ${JSON.stringify(push.args)}`;
      const created = calls.find((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create');
      if (created) return 'MUST NOT open a PR';
      return null;
    },
  },
  {
    name: 'hostile: remote tip associated with an ATTACKER PR (non-bot login, non-sync head) MUST throw',
    mocks: {
      diffStat: () => ({ stdout: ' data/database.json | 1 +' }),
      ghPrList: () => ({ stdout: '[]' }),
      [`git switch --force-create ${SYNC_BRANCH} origin/${BASE_BRANCH}`]: () => ({ stdout: '' }),
      'git add --': () => ({ stdout: '' }),
      'git diff --staged --quiet': () => ({ stdout: '', status: 1 }),
      [`git commit -m ${COMMIT_MSG}`]: () => ({ stdout: '' }),
      [`git fetch --no-tags origin ${SYNC_BRANCH}`]: () => ({ stdout: '' }),
      [`git rev-parse --verify --quiet refs/remotes/origin/${SYNC_BRANCH}`]: () => ({ stdout: `${ATTACKER_PR_SHA}\n`, status: 0 }),
      ...forgeableMetadataMocksFor(ATTACKER_PR_SHA),
      [`gh api /repos/{owner}/{repo}/commits/${ATTACKER_PR_SHA}/pulls`]: () => ({
        stdout: JSON.stringify([
          {
            number: 999,
            state: 'open',
            head: { ref: 'attacker/pwn' },
            base: { ref: BASE_BRANCH },
            user: { login: 'someone-else' },
          },
        ]),
      }),
      ...permissivePushMocks(),
    },
    verifySafe: ({ threw, calls }) => {
      if (!threw) return 'correct handoff must throw on non-bot PR association';
      const push = calls.find((c) => c.cmd === 'git' && c.args[0] === 'push');
      if (push) return `MUST NOT push on attacker-associated SHA: ${JSON.stringify(push.args)}`;
      return null;
    },
  },
  {
    name: 'hostile: open PR on the sync branch authored by a HUMAN MUST throw at the lookup gate',
    mocks: {
      diffStat: () => ({ stdout: ' data/database.json | 1 +' }),
      ghPrList: () => ({
        stdout: JSON.stringify([{ number: 555, headRefOid: HUMAN_PR_HEAD_SHA, author: { login: 'someone-else' } }]),
      }),
      // Handlers the mutation might reach if it drops the login gate.
      [`git fetch --no-tags origin ${HUMAN_PR_HEAD_SHA}`]: () => ({ stdout: '' }),
      [`git diff --quiet ${HUMAN_PR_HEAD_SHA} --`]: () => ({ stdout: '', status: 1 }),
      [`git switch --force-create ${SYNC_BRANCH} origin/${BASE_BRANCH}`]: () => ({ stdout: '' }),
      'git add --': () => ({ stdout: '' }),
      'git diff --staged --quiet': () => ({ stdout: '', status: 1 }),
      [`git commit -m ${COMMIT_MSG}`]: () => ({ stdout: '' }),
      [`git fetch --no-tags origin ${SYNC_BRANCH}`]: () => ({ stdout: '' }),
      [`git rev-parse --verify --quiet refs/remotes/origin/${SYNC_BRANCH}`]: () => ({ stdout: `${HUMAN_PR_HEAD_SHA}\n`, status: 0 }),
      ...forgeableMetadataMocksFor(HUMAN_PR_HEAD_SHA),
      // If a bypass reaches the gh api call, still return empty so the
      // bypass MUST take a different code path to push — which then the
      // verifier catches via `calls`.
      [`gh api /repos/{owner}/{repo}/commits/${HUMAN_PR_HEAD_SHA}/pulls`]: () => ({ stdout: '[]' }),
      ...permissivePushMocks(),
    },
    verifySafe: ({ threw, calls }) => {
      if (!threw) return 'correct handoff must throw when the open PR on the sync branch is human-authored';
      const push = calls.find((c) => c.cmd === 'git' && c.args[0] === 'push');
      if (push) return `MUST NOT push while a human owns the open PR: ${JSON.stringify(push.args)}`;
      return null;
    },
  },
  {
    name: 'happy: refresh via historical-bot-PR provenance MUST push lease-bound to sync branch, never main',
    mocks: {
      diffStat: () => ({ stdout: ' data/database.json | 1 +' }),
      ghPrList: () => ({ stdout: '[]' }),
      [`git switch --force-create ${SYNC_BRANCH} origin/${BASE_BRANCH}`]: () => ({ stdout: '' }),
      'git add --': () => ({ stdout: '' }),
      'git diff --staged --quiet': () => ({ stdout: '', status: 1 }),
      [`git commit -m ${COMMIT_MSG}`]: () => ({ stdout: '' }),
      [`git fetch --no-tags origin ${SYNC_BRANCH}`]: () => ({ stdout: '' }),
      [`git rev-parse --verify --quiet refs/remotes/origin/${SYNC_BRANCH}`]: () => ({ stdout: `${HISTORICAL_BOT_SHA}\n`, status: 0 }),
      ...forgeableMetadataMocksFor(HISTORICAL_BOT_SHA),
      [`gh api /repos/{owner}/{repo}/commits/${HISTORICAL_BOT_SHA}/pulls`]: () => ({
        stdout: JSON.stringify([
          {
            number: 170,
            state: 'closed',
            head: { ref: SYNC_BRANCH },
            base: { ref: BASE_BRANCH },
            user: { login: 'github-actions[bot]' },
          },
        ]),
      }),
      ...permissivePushMocks(),
    },
    verifySafe: ({ threw, calls }) => {
      if (threw) return `correct handoff must succeed on historical-bot-PR provenance, threw: ${threw.message}`;
      const push = calls.find((c) => c.cmd === 'git' && c.args[0] === 'push');
      if (!push) return 'must push';
      if (push.args.some((a) => /(^|[/=:'"` ])main($|[/'"` ])/.test(a))) {
        return `push must not mention the base branch: ${JSON.stringify(push.args)}`;
      }
      const expectedLease = `--force-with-lease=refs/heads/${SYNC_BRANCH}:${HISTORICAL_BOT_SHA}`;
      if (!push.args.some((a) => a === expectedLease)) {
        return `lease must be bound to the validated remote SHA (${expectedLease}); got ${JSON.stringify(push.args)}`;
      }
      return null;
    },
  },
  ];
}

async function importFreshHandoff(mutatedText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `handoff-mut-${crypto.randomBytes(4).toString('hex')}-`));
  const file = path.join(dir, `handoff-${crypto.randomBytes(4).toString('hex')}.mjs`);
  fs.writeFileSync(file, mutatedText);
  try {
    const mod = await import(pathToFileURL(file).href);
    return {
      runHandoff: mod.runHandoff,
      cleanup: () => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      },
    };
  } catch (err) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    return { syntaxError: err };
  }
}

/**
 * Runs every hostile scenario against the mutated module. Returns the
 * name of the first scenario whose safety verifier flagged a violation,
 * or `null` if all scenarios still passed (i.e. mutation is invisible).
 */
async function mutationBehaviourResult({ mutatedText }) {
  const imported = await importFreshHandoff(mutatedText);
  if (imported.syntaxError) {
    return `syntax error at import: ${imported.syntaxError.message}`;
  }
  try {
    for (const scen of buildHostileScenarios()) {
      const outcome = await driveScenario({ mocks: scen.mocks, runHandoffFn: imported.runHandoff });
      const violation = scen.verifySafe(outcome);
      if (violation !== null) return `${scen.name} → ${violation}`;
    }
    return null;
  } finally {
    imported.cleanup();
  }
}

async function verifyMutationBehaviourallyCaught({ name, mutatedText }) {
  const caught = await mutationBehaviourResult({ mutatedText });
  assert.ok(
    caught !== null,
    `mutation "${name}" was NOT caught behaviourally — every hostile scenario still saw safe behaviour from the mutated handoff module. Static string presence is insufficient (DIC-1292 CR round 3); add coverage that exercises the code path this mutation altered.`,
  );
}

function normalizeResponse(res) {
  const { stdout = '', status = 0 } = res ?? {};
  return { stdout, status };
}

function assertNoPush(calls) {
  const push = calls.find((c) => c.cmd === 'git' && c.args[0] === 'push');
  assert.strictEqual(push, undefined, `expected no git push, got: ${push ? JSON.stringify(push) : '(none)'}`);
}

function detectWorkflowPolicyViolation(text) {
  for (const { re } of FORBIDDEN_TARGET_PATTERNS) if (re.test(text)) return true;
  for (const { re } of FORBIDDEN_BYPASS_PATTERNS) if (re.test(text)) return true;
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

function detectHandoffPolicyViolation(text) {
  for (const { re } of FORBIDDEN_TARGET_PATTERNS) if (re.test(text)) return true;
  for (const { re } of FORBIDDEN_BYPASS_PATTERNS) if (re.test(text)) return true;
  // The bound lease must remain intact.
  if (!/--force-with-lease=refs\/heads\/\$\{SYNC_BRANCH\}:\$\{remoteSha\}/.test(text)) return true;
  // The server-side provenance gate must remain intact — and it must not
  // be joined by a forgeable committer-email / subject-prefix shortcut
  // (DIC-1292 CR round 2). Any `git log --format=%ce`/`%s` read on the
  // remote SHA reopens the whole class of vulnerability.
  if (!/resolveRemoteProvenance\s*\(/.test(text)) return true;
  if (!/if \(!provenance\.ok\)/.test(text)) return true;
  if (!/\/repos\/\{owner\}\/\{repo\}\/commits\/\$\{remoteSha\}\/pulls/.test(text)) return true;
  if (/['"]--format=%ce['"]/.test(text)) return true;
  if (/['"]--format=%s['"]/.test(text)) return true;
  if (/AUTOMATION_COMMITTER_EMAIL/.test(text)) return true;
  // Historical PR association must still require the head branch to be
  // the sync branch AND the author to be automation. Dropping either
  // half accepts a random attacker PR as ownership.
  if (!/pr\.headRef === SYNC_BRANCH && AUTOMATION_LOGINS\.includes\(pr\.login \?\? ''\)/.test(text)) return true;
  if (!/AUTOMATION_LOGINS\.includes\(login\)/.test(text)) return true;
  return false;
}
