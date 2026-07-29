#!/usr/bin/env node
/**
 * ci-failure-report.js
 *
 * Scans dicoge/hunterCard for GitHub Actions workflow runs that failed in the
 * last 24 hours, matches each failed run to its originating PR (via head_sha),
 * and leaves an explanatory comment on that PR — skipping runs already
 * reported (dedup marker embedded in the comment body).
 *
 * Requires the `gh` CLI to be installed and authenticated with a token that
 * has `repo` + `workflow` scope (see ~/.openclaw/workspace/TOOLS.md).
 *
 * Usage: node scripts/ci-failure-report.js
 */

import { execFileSync } from 'child_process';

const REPO = 'dicoge/hunterCard';
const LOOKBACK_HOURS = 24;
const MARKER_PREFIX = '<!-- ci-failure-report:run-';

function ghApi(pathAndQuery, extraArgs = []) {
  const args = ['api', pathAndQuery, ...extraArgs];
  const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 32 });
  return JSON.parse(out);
}

function ghApiRaw(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 32 });
}

function isWithinLookback(dateStr) {
  const runDate = new Date(dateStr).getTime();
  const cutoff = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000;
  return runDate >= cutoff;
}

function fetchFailedRuns() {
  // status=failure returns runs whose overall conclusion is failure.
  const data = ghApi(
    `repos/${REPO}/actions/runs?status=failure&per_page=100`
  );
  const runs = (data.workflow_runs || []).filter((r) => isWithinLookback(r.created_at));
  return runs;
}

function findPRForSha(sha) {
  try {
    const prs = ghApi(`repos/${REPO}/commits/${sha}/pulls`, [
      '-H',
      'Accept: application/vnd.github.groot-preview+json',
    ]);
    if (Array.isArray(prs) && prs.length > 0) {
      // Prefer an open PR if there are several associated with the sha.
      const open = prs.find((p) => p.state === 'open');
      return open || prs[0];
    }
  } catch (err) {
    // No associated PR found (e.g. push directly to main) — not an error.
  }
  return null;
}

function findFailedStep(runId) {
  const data = ghApi(`repos/${REPO}/actions/runs/${runId}/jobs`);
  const jobs = data.jobs || [];
  const failures = [];
  for (const job of jobs) {
    if (job.conclusion !== 'failure') continue;
    const steps = job.steps || [];
    const failedSteps = steps.filter((s) => s.conclusion === 'failure');
    failures.push({
      jobName: job.name,
      steps: failedSteps.map((s) => s.name),
    });
  }
  return failures;
}

function alreadyReported(prNumber, runId) {
  const marker = `${MARKER_PREFIX}${runId} -->`;
  try {
    const comments = ghApi(`repos/${REPO}/issues/${prNumber}/comments?per_page=100`);
    return comments.some((c) => typeof c.body === 'string' && c.body.includes(marker));
  } catch (err) {
    return false;
  }
}

function buildCommentBody(run, failedSteps) {
  const marker = `${MARKER_PREFIX}${run.id} -->`;
  const stepSummary =
    failedSteps.length > 0
      ? failedSteps
          .map((f) => `- **${f.jobName}**: ${f.steps.length > 0 ? f.steps.join(', ') : '(no step-level detail)'}`)
          .join('\n')
      : '- (unable to retrieve job/step detail)';

  return [
    marker,
    `### ⚠️ CI 失敗通知`,
    ``,
    `Workflow **${run.name}** 在 run [#${run.run_number}](${run.html_url}) 失敗。`,
    ``,
    `- 分支/commit: \`${run.head_branch}\` @ \`${run.head_sha.slice(0, 7)}\``,
    `- 失敗的 job / step：`,
    stepSummary,
    ``,
    `請檢查 log 確認是否需要修正後重新推送。`,
  ].join('\n');
}

function postComment(prNumber, body) {
  ghApiRaw([
    'api',
    `repos/${REPO}/issues/${prNumber}/comments`,
    '-f',
    `body=${body}`,
  ]);
}

function main() {
  const runs = fetchFailedRuns();
  let processed = 0;
  let skipped = 0;
  let noPr = 0;

  for (const run of runs) {
    const pr = findPRForSha(run.head_sha);
    if (!pr) {
      noPr += 1;
      continue;
    }

    if (alreadyReported(pr.number, run.id)) {
      skipped += 1;
      continue;
    }

    const failedSteps = findFailedStep(run.id);
    const body = buildCommentBody(run, failedSteps);
    postComment(pr.number, body);
    processed += 1;
    console.log(`Reported run ${run.id} (${run.name}) on PR #${pr.number}`);
  }

  console.log(
    `CI failure report done: ${processed} 已回報, ${skipped} 已跳過(重複), ${noPr} 無對應 PR, 共掃到 ${runs.length} 個 24 小時內失敗的 run`
  );
}

main();
