#!/usr/bin/env node
/**
 * DIC-1291 handoff — one commit / one PR onto protected main.
 *
 * Extracted from the workflow YAML so the DIC-1292 mutation-sensitive test
 * can exercise the real no-change / existing-PR / refresh / hostile-remote
 * shell paths with mock `git` and `gh`, instead of relying on static
 * string checks of the YAML.
 *
 * Ownership contract for DIC-1292 CR round 2: before `--force-with-lease`
 * ever touches `bot/official-catalog-sync`, the current remote tip must
 * prove ownership through NON-FORGEABLE server-side provenance. The
 * previous round trusted `git log --format=%ce`/`%s` on the remote tip,
 * but a malicious pusher can fabricate both — `git commit --author='X
 * <action@github.com>' -m 'chore: sync official catalog 2026-09-02'`
 * takes seconds. The only signals we now accept are:
 *
 *   1. The remote tip SHA equals the head of the current open sync PR AND
 *      that PR was authored by github-actions[bot]. Both facts come from
 *      the GitHub API (`gh pr list … --json author`), which a pusher
 *      cannot forge — a random human pushing to bot/… does not become
 *      github-actions[bot] to the API.
 *   2. The GitHub API (`gh api /repos/{owner}/{repo}/commits/<sha>/pulls`)
 *      reports at least one prior PR from the sync branch, authored by
 *      github-actions[bot], that contains this exact commit SHA. GitHub
 *      builds those associations from the commit graph + PR history it
 *      itself recorded; a spoofed remote commit has a new SHA that no
 *      such PR contains, so this check refuses.
 *
 * Anything else — a manual push, a stale unowned ref, a different bot's
 * branch that happens to share the name, a spoofed committer identity —
 * fails closed. The lease is bound to the exact validated SHA so a race
 * between the ownership check and the push still refuses instead of
 * clobbering. `main` and every other branch are unreachable from this
 * script by construction.
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

// Subject prefix every commit this workflow writes uses. This is the
// commit message the handoff produces — NOT an ownership signal (a pusher
// can trivially spell the same subject on their own commits).
export const COMMIT_MSG_PREFIX = 'chore: sync official catalog';

// The GitHub login that opens PRs when this workflow uses the built-in
// GITHUB_TOKEN. `github-actions` covers older Actions runners, the
// `[bot]` suffix is what the modern GraphQL / REST surface returns.
// Used to authenticate PR ownership via the GitHub API — never via
// forgeable committer metadata on the branch itself.
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
    const provenance = resolveRemoteProvenance({ exec, SYNC_BRANCH, remoteSha, existingPR });
    if (!provenance.ok) {
      throw new Error(
        `Remote ${SYNC_BRANCH} tip ${remoteSha} has unrecognized ownership: ${provenance.reason}. ` +
          `Refusing to force-push over a ref this workflow cannot prove it produced. ` +
          `Investigate manually (delete or rename the branch if it is legitimate manual work) before rerunning.`,
      );
    }
    log(`Sync branch tip ${remoteSha} is bot-owned via ${provenance.via}; refreshing.`);
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

  // Server-side author gate: only trust an open PR from this branch if
  // it was opened by github-actions[bot]. A pusher can push whatever
  // commit metadata they want to bot/…, but they cannot fake being
  // github-actions[bot] on the API surface.
  const login = pr.author?.login ?? '';
  if (!AUTOMATION_LOGINS.includes(login)) {
    throw new Error(
      `Open PR #${pr.number} on ${SYNC_BRANCH} was authored by '${login}', not github-actions[bot]; ` +
        `refusing to touch a human-owned PR on the automation branch. Close/rename the PR before the next scheduled run.`,
    );
  }
  return pr;
}

/**
 * Prove that `remoteSha` is a commit this workflow itself produced, using
 * only NON-FORGEABLE server-side data. Two acceptable signals:
 *
 *   1. It's the current head of the open sync PR (author already
 *      verified as github-actions[bot] by lookupExistingSyncPR).
 *   2. GitHub reports that ≥1 prior PR from the sync branch, authored by
 *      github-actions[bot], contains this exact SHA. GitHub builds those
 *      associations from the commit graph it stores server-side; a
 *      spoofed remote commit has a new SHA that no such PR contains.
 *
 * Committer email + subject on the commit itself are IGNORED: they are
 * trivially forgeable with `git commit --author=… -m …`. Any earlier
 * design that trusted them was insecure.
 */
function resolveRemoteProvenance({ exec, SYNC_BRANCH, remoteSha, existingPR }) {
  if (existingPR && existingPR.headRefOid === remoteSha) {
    return { ok: true, via: `open PR #${existingPR.number} (author=${existingPR.author?.login})` };
  }

  const raw = exec('gh', [
    'api',
    `/repos/{owner}/{repo}/commits/${remoteSha}/pulls`,
    '-H',
    'Accept: application/vnd.github+json',
  ]).stdout.trim();
  let pulls;
  try {
    pulls = raw ? JSON.parse(raw) : [];
  } catch {
    return { ok: false, reason: `gh api commits/${remoteSha}/pulls returned non-JSON (${raw.slice(0, 200)})` };
  }
  if (!Array.isArray(pulls)) {
    return { ok: false, reason: `gh api commits/${remoteSha}/pulls returned a non-array response (${raw.slice(0, 200)})` };
  }

  const summarised = pulls.map((pr) => ({
    number: pr?.number,
    state: pr?.state,
    headRef: pr?.head?.ref,
    baseRef: pr?.base?.ref,
    login: pr?.user?.login,
  }));

  for (const pr of summarised) {
    if (pr.headRef === SYNC_BRANCH && AUTOMATION_LOGINS.includes(pr.login ?? '')) {
      return { ok: true, via: `historical bot PR #${pr.number} (state=${pr.state}, author=${pr.login})` };
    }
  }

  return {
    ok: false,
    reason:
      pulls.length === 0
        ? `no PR in this repo contains commit ${remoteSha} — the remote tip is not traceable to any prior bot run`
        : `commit ${remoteSha} is only associated with ${JSON.stringify(summarised)}; none is a github-actions[bot] PR from ${SYNC_BRANCH}`,
    associatedPRs: summarised,
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
