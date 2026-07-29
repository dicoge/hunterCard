#!/usr/bin/env node
/**
 * weekly-github-cleanup.js
 *
 * Weekly maintenance for dicoge/hunterCard:
 *  1. Stale PR reminders — open PRs with no new commit/comment in 7+ days get
 *     a reminder comment (never auto-closed).
 *  2. Merged-branch cleanup — deletes the source branch of merged PRs
 *     (never touches the base branch).
 *  3. Release note draft — collects PR titles merged into main in the last 7
 *     days into a changelog and creates/updates a GitHub draft Release.
 *
 * Requires the `gh` CLI, authenticated with `repo` + `workflow` scope.
 *
 * Usage: node scripts/weekly-github-cleanup.js
 */

import { execFileSync } from 'child_process';

const REPO = 'dicoge/hunterCard';
const OWNER = 'dicoge';
const NAME = 'hunterCard';
const STALE_DAYS = 7;
const STALE_MARKER = '<!-- weekly-cleanup:stale-reminder -->';
// --dry-run: read-only pass — logs what WOULD happen without commenting,
// deleting branches, or creating a release. Useful for verification.
const DRY_RUN = process.argv.includes('--dry-run');

function ghApi(pathAndQuery, extraArgs = []) {
  const args = ['api', pathAndQuery, ...extraArgs];
  const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 32 });
  return JSON.parse(out);
}

function ghApiRawOk(args) {
  try {
    execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 32 });
    return true;
  } catch (err) {
    return false;
  }
}

function daysSince(dateStr) {
  return (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24);
}

// --- 1. Stale PR reminders -------------------------------------------------

function fetchOpenPRs() {
  return ghApi(`repos/${REPO}/pulls?state=open&per_page=100`);
}

function lastActivityDate(pr) {
  // updated_at already reflects the latest commit push OR comment/review
  // activity on the PR/issue timeline, which is what "no new commit or
  // comment" means here.
  return pr.updated_at;
}

function alreadyReminded(prNumber) {
  try {
    const comments = ghApi(`repos/${REPO}/issues/${prNumber}/comments?per_page=100`);
    // Skip only if the existing reminder is itself recent (within the stale
    // window), so a PR that goes stale again after a previous reminder still
    // gets nudged.
    return comments.some(
      (c) =>
        typeof c.body === 'string' &&
        c.body.includes(STALE_MARKER) &&
        daysSince(c.created_at) < STALE_DAYS
    );
  } catch (err) {
    return false;
  }
}

function remindStalePRs(prs) {
  let reminded = 0;
  let skipped = 0;

  for (const pr of prs) {
    const idleDays = daysSince(lastActivityDate(pr));
    if (idleDays < STALE_DAYS) continue;

    if (alreadyReminded(pr.number)) {
      skipped += 1;
      continue;
    }

    const body = [
      STALE_MARKER,
      `### ⏰ Stale PR 提醒`,
      ``,
      `這個 PR 已經 ${Math.floor(idleDays)} 天沒有新的 commit 或留言了。麻煩確認是否還在進行中、需要協助，或可以合併/關閉。`,
    ].join('\n');

    if (DRY_RUN) {
      console.log(`[dry-run] Would remind stale PR #${pr.number} (idle ${Math.floor(idleDays)}d)`);
    } else {
      ghApiRawOk(['api', `repos/${REPO}/issues/${pr.number}/comments`, '-f', `body=${body}`]);
      console.log(`Reminded stale PR #${pr.number} (idle ${Math.floor(idleDays)}d)`);
    }
    reminded += 1;
  }

  return { reminded, skipped };
}

// --- 2. Merged branch cleanup ----------------------------------------------

function fetchMergedPRs(days) {
  const all = ghApi(`repos/${REPO}/pulls?state=closed&per_page=100&sort=updated&direction=desc`);
  return all.filter((pr) => pr.merged_at && daysSince(pr.merged_at) <= days);
}

function fetchDefaultBranch() {
  const repoInfo = ghApi(`repos/${REPO}`);
  return repoInfo.default_branch;
}

function deleteMergedBranches(mergedPRs, defaultBranch) {
  let deleted = 0;
  let skipped = 0;

  // Only consider branches that live in this repo (skip forks), and never
  // delete the default/base branch.
  const seen = new Set();
  for (const pr of mergedPRs) {
    const branch = pr.head && pr.head.ref;
    const headRepoFullName = pr.head && pr.head.repo && pr.head.repo.full_name;
    if (!branch || branch === defaultBranch || headRepoFullName !== REPO) {
      skipped += 1;
      continue;
    }
    if (seen.has(branch)) continue;
    seen.add(branch);

    if (DRY_RUN) {
      console.log(`[dry-run] Would delete merged branch ${branch} (PR #${pr.number})`);
      deleted += 1;
      continue;
    }

    const ok = ghApiRawOk(['api', '-X', 'DELETE', `repos/${REPO}/git/refs/heads/${branch}`]);
    if (ok) {
      deleted += 1;
      console.log(`Deleted merged branch ${branch} (PR #${pr.number})`);
    } else {
      // Already deleted or protected — not an error worth failing the run over.
      skipped += 1;
    }
  }

  return { deleted, skipped };
}

// --- 3. Release note draft --------------------------------------------------

function buildChangelog(mergedPRs, defaultBranch) {
  const mainMerges = mergedPRs.filter((pr) => pr.base && pr.base.ref === defaultBranch);
  const lines = mainMerges
    .sort((a, b) => new Date(a.merged_at) - new Date(b.merged_at))
    .map((pr) => `- ${pr.title} (#${pr.number})`);
  return { mainMerges, lines };
}

function createDraftRelease(lines) {
  if (lines.length === 0) return null;

  const today = new Date().toISOString().slice(0, 10);
  const tagName = `weekly-draft-${today}`;
  const body = ['## 本週變更', '', ...lines].join('\n');

  if (DRY_RUN) {
    console.log(`[dry-run] Would create draft release ${tagName} with ${lines.length} entries`);
    return tagName;
  }

  try {
    ghApi(`repos/${REPO}/releases`, [
      '-f',
      `tag_name=${tagName}`,
      '-f',
      `name=Weekly Draft ${today}`,
      '-f',
      `body=${body}`,
      '-F',
      'draft=true',
    ]);
    return tagName;
  } catch (err) {
    console.error(`Failed to create draft release: ${err.message}`);
    return null;
  }
}

// --- main -------------------------------------------------------------------

function main() {
  const defaultBranch = fetchDefaultBranch();

  const openPRs = fetchOpenPRs();
  const { reminded, skipped: staleSkipped } = remindStalePRs(openPRs);

  const mergedPRs = fetchMergedPRs(STALE_DAYS);
  const { deleted, skipped: branchSkipped } = deleteMergedBranches(mergedPRs, defaultBranch);

  const { lines } = buildChangelog(mergedPRs, defaultBranch);
  const releaseTag = createDraftRelease(lines);

  console.log('--- Weekly GitHub Cleanup Summary ---');
  console.log(`Stale PR reminders: ${reminded} 已提醒, ${staleSkipped} 已跳過(重複提醒中)`);
  console.log(`Merged branch cleanup: ${deleted} 已刪除, ${branchSkipped} 已跳過`);
  console.log(
    releaseTag
      ? `Release draft: 已建立 ${releaseTag}，共 ${lines.length} 筆變更`
      : `Release draft: 本週無 main 分支 merge，未建立 draft`
  );
}

main();
