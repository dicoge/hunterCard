#!/usr/bin/env node
/**
 * DIC-1291 handoff — one commit / one PR onto protected main.
 *
 * Extracted from the workflow YAML so DIC-1292 CR blocker #1 can exercise
 * the real no-change / existing-PR / refresh shell paths with mock `git`
 * and `gh`, instead of relying on static string checks of the YAML.
 *
 * Ownership contract for DIC-1292 CR blocker #2: before `--force-with-
 * lease` ever touches `bot/official-catalog-sync`, the current remote tip
 * must prove ownership through ONE of two independent signals — being the
 * head of an open PR that github-actions[bot] itself opened, or having a
 * commit signature that only this workflow produces (committer email +
 * subject prefix). Anything else — a manual push, a stale unowned ref, a
 * different bot's branch that happens to share the name — fails closed.
 * The lease is bound to the exact validated SHA so a race between the
 * ownership check and the push still refuses. `main` and every other
 * branch are unreachable from this script by construction.
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';

// --- Frozen invariants ------------------------------------------------

// The exact set of paths this workflow may commit. Kept as a hard-coded
// list rather than an env var so a future edit cannot silently start
// committing e.g. build artefacts, secrets, or user-facing files by
// injecting an extra path at runtime.
export const SYNC_PATHS = Object.freeze([
  'data/official/',
  'data/database.json',
  'public/data/database.json',
  'docs/audits/official-catalog-audit.json',
  'docs/audits/official-production-lag-state.json',
]);

// Committer identity every commit this workflow makes uses. It is one of
// the two ownership signals we accept for the sync branch — see the
// `resolveOwnership` gate below.
export const AUTOMATION_COMMITTER_EMAIL = 'action@github.com';
export const COMMIT_MSG_PREFIX = 'chore: sync official catalog';

// The GitHub login that opens PRs when this workflow uses the built-in
// GITHUB_TOKEN. `github-actions` covers older Actions runners, the
// `[bot]` suffix is what the modern GraphQL surface returns.
export const AUTOMATION_LOGINS = Object.freeze(['github-actions', 'github-actions[bot]']);

// --- Public entry -----------------------------------------------------

export async function runHandoff({
  env = process.env,
  exec = defaultExec,
  log = console.log,
  now = () => new Date(),
} = {}) {
  const SYNC_BRANCH = env.SYNC_BRANCH ?? 'bot/official-catalog-sync';
  const BASE_BRANCH = env.BASE_BRANCH ?? 'main';

  assertConfigSafe({ SYNC_BRANCH, BASE_BRANCH, env });

  // -- Change gate ----------------------------------------------------
  // A no-diff run is a success. The workflow YAML also has this gate
  // (`steps.check.outputs.changed == 'true'`), but re-checking here means
  // a broken YAML edit that drops the gate still cannot spam PRs.
  const diffStat = exec('git', ['diff', '--stat', '--', ...SYNC_PATHS]).stdout;
  if (!diffStat.trim()) {
    log('No official-catalog changes to sync; exiting successfully.');
    return { outcome: 'no-op-no-changes' };
  }

  const commitMsg = `${COMMIT_MSG_PREFIX} ${isoDate(now())}`;

  // -- Existing open PR lookup ---------------------------------------
  const existingPR = lookupExistingSyncPR({ exec, SYNC_BRANCH, BASE_BRANCH });

  if (existingPR) {
    exec('git', ['fetch', '--no-tags', 'origin', existingPR.headRefOid]);
    const diffMatch = exec(
      'git',
      ['diff', '--quiet', existingPR.headRefOid, '--', ...SYNC_PATHS],
      { allowFail: true },
    );
    if (diffMatch.status === 0) {
      log(`Open PR #${existingPR.number} already carries this snapshot; leaving it untouched.`);
      return { outcome: 'no-op-already-open', prNumber: existingPR.number };
    }
  }

  // -- Rebuild the sync branch on top of origin/main -----------------
  // Every run branches from origin/main so old bot commits never
  // accumulate on the sync branch. The commit here is what the lease
  // below will push.
  exec('git', ['switch', '--force-create', SYNC_BRANCH, `origin/${BASE_BRANCH}`]);
  exec('git', ['add', '--', ...SYNC_PATHS]);
  const staged = exec('git', ['diff', '--staged', '--quiet'], { allowFail: true });
  if (staged.status === 0) {
    throw new Error('staged tree unexpectedly empty after rebase; aborting');
  }
  exec('git', ['commit', '-m', commitMsg]);

  // -- Ownership gate before any force-push --------------------------
  // Fetches the current remote head of the sync branch (if any). The
  // fetch is allowed to fail (fresh branch), but rev-parse is what
  // decides whether we're in create or overwrite territory.
  exec('git', ['fetch', '--no-tags', 'origin', SYNC_BRANCH], { allowFail: true });
  const remoteShaRes = exec(
    'git',
    ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${SYNC_BRANCH}`],
    { allowFail: true },
  );
  const remoteSha = remoteShaRes.status === 0 ? remoteShaRes.stdout.trim() : '';

  if (!remoteSha) {
    // Fresh branch — regular create, no force needed.
    exec('git', ['push', 'origin', `HEAD:refs/heads/${SYNC_BRANCH}`]);
  } else {
    const ownership = resolveOwnership({ exec, SYNC_BRANCH, remoteSha, existingPR });
    if (!ownership.ok) {
      throw new Error(
        `Remote ${SYNC_BRANCH} tip ${remoteSha} has unrecognized ownership ` +
          `(committer=${ownership.details.committerEmail}, subject=${JSON.stringify(ownership.details.subject)}, ` +
          `openPR=${existingPR ? '#' + existingPR.number + ' by ' + (existingPR.author?.login ?? '?') : 'none'}). ` +
          `Refusing to overwrite. Investigate manually before rerunning.`,
      );
    }
    // Bind the lease to the exact validated SHA. Between our fetch and
    // this push a concurrent writer could still have moved the ref;
    // --force-with-lease=<ref>:<expect> refuses in that case instead of
    // clobbering.
    exec('git', [
      'push',
      `--force-with-lease=refs/heads/${SYNC_BRANCH}:${remoteSha}`,
      'origin',
      `HEAD:refs/heads/${SYNC_BRANCH}`,
    ]);
  }

  // -- PR create / refresh ------------------------------------------
  if (!existingPR) {
    exec('gh', [
      'pr',
      'create',
      '--base',
      BASE_BRANCH,
      '--head',
      SYNC_BRANCH,
      '--title',
      commitMsg,
      '--body',
      [
        'Automated official-catalog snapshot from the scheduled `official-catalog-sync` workflow.',
        '',
        'Branch protection on `main` runs the required checks (Validate + Release-APK post-package guard) against this PR; merge is human-gated. Never merge with `--admin` / branch-protection bypass — the whole point of this handoff is that the same gates apply to bot changes as to human PRs.',
      ].join('\n'),
    ]);
    return { outcome: 'created-pr' };
  }

  log(`Refreshed existing PR #${existingPR.number} with new snapshot.`);
  return { outcome: 'refreshed-pr', prNumber: existingPR.number };
}

// --- Internals --------------------------------------------------------

function assertConfigSafe({ SYNC_BRANCH, BASE_BRANCH, env }) {
  if (typeof SYNC_BRANCH !== 'string' || SYNC_BRANCH.length === 0) {
    throw new Error('SYNC_BRANCH env var is required.');
  }
  if (typeof BASE_BRANCH !== 'string' || BASE_BRANCH.length === 0) {
    throw new Error('BASE_BRANCH env var is required.');
  }
  if (SYNC_BRANCH === BASE_BRANCH) {
    throw new Error(`SYNC_BRANCH must not equal BASE_BRANCH (${BASE_BRANCH}); refusing to configure a self-push loop into protected main.`);
  }
  if (!SYNC_BRANCH.startsWith('bot/')) {
    throw new Error(`SYNC_BRANCH must live under bot/… so branch-protection rules can distinguish it from human branches (got '${SYNC_BRANCH}').`);
  }
  if (!env.GH_TOKEN && !env.GITHUB_TOKEN) {
    throw new Error('GH_TOKEN or GITHUB_TOKEN must be set — the handoff needs the workflow token to talk to `gh`.');
  }
}

function lookupExistingSyncPR({ exec, SYNC_BRANCH, BASE_BRANCH }) {
  const raw = exec('gh', [
    'pr',
    'list',
    '--state',
    'open',
    '--head',
    SYNC_BRANCH,
    '--base',
    BASE_BRANCH,
    '--json',
    'number,headRefOid,author',
  ]).stdout.trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`gh pr list did not return JSON (got: ${raw.slice(0, 200)})`);
  }
  const pr = Array.isArray(parsed) ? parsed[0] : null;
  if (!pr) return null;

  // Ownership signal #1: only trust an open PR from this branch if it was
  // opened by github-actions[bot]. A human PR from someone who happens to
  // have pushed to `bot/…` must not shortcut the ownership gate below.
  const login = pr.author?.login ?? '';
  if (!AUTOMATION_LOGINS.includes(login)) {
    throw new Error(
      `Open PR #${pr.number} on ${SYNC_BRANCH} was authored by '${login}', not github-actions[bot]; ` +
        `refusing to touch a human-owned PR on the automation branch. Close/rename the PR before the next scheduled run.`,
    );
  }
  return pr;
}

function resolveOwnership({ exec, SYNC_BRANCH, remoteSha, existingPR }) {
  const committerEmail = exec('git', ['log', '-1', '--format=%ce', remoteSha]).stdout.trim();
  const subject = exec('git', ['log', '-1', '--format=%s', remoteSha]).stdout.trim();

  const ownedByOpenPR = Boolean(existingPR && existingPR.headRefOid === remoteSha);
  const ownedByAutomationSignature =
    committerEmail === AUTOMATION_COMMITTER_EMAIL && subject.startsWith(COMMIT_MSG_PREFIX);

  return {
    ok: ownedByOpenPR || ownedByAutomationSignature,
    details: { committerEmail, subject, ownedByOpenPR, ownedByAutomationSignature },
  };
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function defaultExec(cmd, args, { allowFail = false } = {}) {
  try {
    const stdout = execFileSync(cmd, args, {
      stdio: ['ignore', 'pipe', 'inherit'],
      encoding: 'utf8',
    });
    return { stdout, status: 0 };
  } catch (err) {
    if (allowFail) {
      return { stdout: (err.stdout ?? '').toString(), status: err.status ?? 1 };
    }
    throw err;
  }
}

// --- CLI entry --------------------------------------------------------

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/official-catalog-sync-handoff.mjs');

if (invokedDirectly) {
  runHandoff().then(
    (result) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    },
    (err) => {
      console.error(err?.message ?? String(err));
      process.exit(1);
    },
  );
}
