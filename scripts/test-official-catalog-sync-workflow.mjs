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
 * manually-pushed sync branch — must be caught here mechanically instead
 * of on the next 21:04 UTC schedule tick.
 *
 * Four layers, because static string checks alone are easy to lie past
 * (DIC-1292 CR blocker #1 was that the earlier version relied on them):
 *
 *   1. Static — the workflow file AND the extracted handoff module cannot
 *      contain any push target that resolves to protected main, in any
 *      literal or variable form (`main`, `$BASE_BRANCH`, `${BASE_BRANCH}`,
 *      quoted, force-lease variants, `refs/heads/main`, …). No
 *      branch-protection bypass, no user-supplied secret, no scope wider
 *      than the handoff needs.
 *   2. Structural — the DIC-1167 pipeline is preserved end-to-end, the
 *      change-check step still emits `changed=false`, the handoff step
 *      is gated on it and only calls the extracted module, third-party
 *      actions are version- / SHA-pinned.
 *   3. Behavioural — the extracted handoff module is driven end-to-end
 *      with mock `git` / `gh` implementations across six real scenarios:
 *      no-change, existing-PR-same, existing-PR-different, no-PR-fresh-
 *      branch, no-PR-owned-remote, and no-PR-HOSTILE-remote. Each
 *      scenario asserts the exact sequence of push / gh-pr / rev-parse
 *      calls the handoff makes. This is the layer DIC-1292 blocker #1
 *      required: real shell paths, not just YAML text.
 *   4. Mutation — a dozen deliberately-broken copies of the workflow AND
 *      the handoff module are re-run through the same static + structural
 *      + behavioural checks. Each mutation MUST be rejected, proving the
 *      earlier layers still bite instead of having rotted into no-ops.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

import {
  runHandoff,
  SYNC_PATHS as HANDOFF_SYNC_PATHS,
  AUTOMATION_COMMITTER_EMAIL,
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
  'handoff module must bind --force-with-lease to the validated remote SHA (DIC-1292 blocker #2)',
);
assert.ok(
  /resolveOwnership\s*\(/.test(handoffText) && /--format=%ce/.test(handoffText) && /startsWith\(COMMIT_MSG_PREFIX\)/.test(handoffText),
  'handoff module must gate the force-push on committer-email + subject-prefix ownership (DIC-1292 blocker #2)',
);
assert.ok(
  /AUTOMATION_LOGINS\.includes\(login\)/.test(handoffText),
  'handoff module must reject open PRs on the sync branch that were opened by non-automation users',
);
assert.strictEqual(AUTOMATION_COMMITTER_EMAIL, 'action@github.com');
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

await scenario('existing PR whose head differs refreshes with lease bound to validated remote SHA', async () => {
  const existingHead = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const remoteSha = existingHead; // remote tip = current PR head, owned via signal #1
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
      // Ownership signal #1 fires (remote SHA == PR head, PR author is
      // github-actions[bot]), so committer / subject queries still happen
      // as part of the resolveOwnership call but the ok=true path wins.
      [`git log -1 --format=%ce ${remoteSha}`]: () => ({ stdout: 'action@github.com\n' }),
      [`git log -1 --format=%s ${remoteSha}`]: () => ({ stdout: `${COMMIT_MSG_PREFIX} 2026-09-01\n` }),
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

await scenario('no existing PR, remote sync branch owned by automation signature: force-with-lease bound + gh pr create', async () => {
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
      // Ownership signal #2 fires: committer + subject prefix match the
      // automation identity even though there is no open PR to consult.
      [`git log -1 --format=%ce ${remoteSha}`]: () => ({ stdout: 'action@github.com\n' }),
      [`git log -1 --format=%s ${remoteSha}`]: () => ({ stdout: 'chore: sync official catalog 2026-09-01\n' }),
      [`git push --force-with-lease=refs/heads/${SYNC_BRANCH}:${remoteSha} origin HEAD:refs/heads/${SYNC_BRANCH}`]: () => ({ stdout: '' }),
      'gh pr create': () => ({ stdout: 'https://github.com/dicoge/hunterCard/pull/1000\n' }),
    },
  });
  assert.deepStrictEqual(result, { outcome: 'created-pr' });
  const pushCall = calls.find((c) => c.cmd === 'git' && c.args[0] === 'push');
  assert.ok(
    pushCall.args.some((a) => a === `--force-with-lease=refs/heads/${SYNC_BRANCH}:${remoteSha}`),
    'lease must be bound to the validated remote SHA even on the "no open PR" path',
  );
});

await scenario('no existing PR, remote sync branch owned by a HUMAN: fails closed without pushing', async () => {
  const remoteSha = 'cccccccccccccccccccccccccccccccccccccccc';
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
      // A human-committed tip on the sync branch — neither ownership signal
      // fires. The handoff MUST refuse to force-push.
      [`git log -1 --format=%ce ${remoteSha}`]: () => ({ stdout: 'malicious@example.com\n' }),
      [`git log -1 --format=%s ${remoteSha}`]: () => ({ stdout: 'wat: pretending to be automation\n' }),
    },
  });
  assert.ok(threw, 'hostile-remote scenario must throw');
  assert.match(threw.message, /unrecognized ownership/, 'error must name the ownership gate');
  assert.match(threw.message, new RegExp(remoteSha), 'error must include the offending SHA');
  const pushCall = calls.find((c) => c.cmd === 'git' && c.args[0] === 'push');
  assert.strictEqual(pushCall, undefined, 'hostile-remote scenario MUST NOT push');
  const prCreate = calls.find((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create');
  assert.strictEqual(prCreate, undefined, 'hostile-remote scenario MUST NOT open a PR');
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
    name: 'handoff drops the ownership gate',
    mutate: (text) => text.replace(/if \(!ownership\.ok\) \{[\s\S]*?\}\n/, ''),
  },
  {
    name: 'handoff drops the automation-login PR-author gate',
    mutate: (text) => text.replace(/if \(!AUTOMATION_LOGINS\.includes\(login\)\) \{[\s\S]*?\}\n/, ''),
  },
];

for (const { name, mutate } of HANDOFF_MUTATIONS) {
  const mutated = mutate(handoffText);
  assert.notStrictEqual(
    mutated,
    handoffText,
    `handoff mutation "${name}" did not actually change the file — the regex/replacement drifted from the source`,
  );
  const rejected = detectHandoffPolicyViolation(mutated);
  assert.ok(
    rejected,
    `handoff mutation "${name}" must be rejected by the static checks; the safety net has rotted`,
  );
}

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
async function drive({ on = {}, expectThrow = null } = {}) {
  const calls = [];
  const stdoutLog = [];
  const exec = (cmd, args, opts = {}) => {
    const key = `${cmd} ${args.join(' ')}`;
    calls.push({ cmd, args: [...args], opts });

    // Convenience aliases keep scenario setup compact.
    if (cmd === 'git' && args[0] === 'diff' && args[1] === '--stat' && on.diffStat) {
      return normalizeResponse(on.diffStat(args));
    }
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list' && on.ghPrList) {
      return normalizeResponse(on.ghPrList(args));
    }
    if (on[key]) return normalizeResponse(on[key](args));

    // Prefix match — lets a handler like `gh pr create` match the full
    // invocation without repeating its long argument list.
    for (const [handlerKey, handler] of Object.entries(on)) {
      if (handlerKey === 'diffStat' || handlerKey === 'ghPrList') continue;
      if (key.startsWith(handlerKey)) return normalizeResponse(handler(args));
    }

    if (opts.allowFail) return { stdout: '', status: 1 };
    throw new Error(`mock exec: no handler for \`${key}\``);
  };
  const env = {
    SYNC_BRANCH,
    BASE_BRANCH,
    GH_TOKEN: 'mock-token',
  };

  let result;
  try {
    result = await runHandoff({ env, exec, log: (line) => stdoutLog.push(line), now: NOW });
  } catch (err) {
    if (!expectThrow) throw err;
    expectThrow(err);
  }
  return { result, calls, stdoutLog };
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
  // The bound lease + ownership gate must remain intact.
  if (!/--force-with-lease=refs\/heads\/\$\{SYNC_BRANCH\}:\$\{remoteSha\}/.test(text)) return true;
  if (!/resolveOwnership\s*\(/.test(text)) return true;
  if (!/if \(!ownership\.ok\)/.test(text)) return true;
  if (!/AUTOMATION_LOGINS\.includes\(login\)/.test(text)) return true;
  return false;
}
