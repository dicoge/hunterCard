#!/usr/bin/env bash
# Stage promotion proof (test-first release flow).
#
# Read-only. Runs in every CI run and decides by event, so it can never be
# "skipped" (a skipped required check counts as passing on GitHub):
#   - push / workflow_dispatch, and pull requests whose base is not main:
#     explicit no-op success. Staging and feature work is unaffected.
#   - pull_request / pull_request_target into main: the change must be a
#     normal promotion of what was already tested on staging:
#       * the head is the `staging` branch of this same repository (no fork,
#         no feature or bot branch straight into main);
#       * the head SHA is the live origin/staging tip (no stale head);
#       * origin/main is contained in that SHA (nothing on main is dropped);
#       * ci.yml has a completed, successful `push` run of that exact SHA on
#         staging (code AND data pushes to staging run CI).
#   - any other event: fail closed.
# This proves the PR content; it only blocks a merge once the check is made
# required on main by branch protection (a platform setting).
#
# Env: EVENT_NAME, BASE_REF, HEAD_REF, HEAD_SHA, HEAD_REPO, GITHUB_REPOSITORY,
#      GH_TOKEN (read access to Actions runs; used by `gh api`)
set -euo pipefail

EVENT="${EVENT_NAME:-}"
BASE="${BASE_REF:-}"
HEAD="${HEAD_REF:-}"
SHA="${HEAD_SHA:-}"
HEAD_REPO="${HEAD_REPO:-}"
REPO="${GITHUB_REPOSITORY:-}"

fail() {
  echo "::error::$1"
  exit 1
}

case "$EVENT" in
  push|workflow_dispatch)
    echo "stage promotion proof: '$EVENT' is not a promotion — no-op."
    exit 0
    ;;
  pull_request|pull_request_target)
    if [ "$BASE" != "main" ]; then
      echo "stage promotion proof: pull request into '$BASE' is not a promotion to main — no-op."
      exit 0
    fi
    ;;
  *)
    fail "stage promotion proof does not recognise event '$EVENT' — refusing rather than passing an unknown path."
    ;;
esac

[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
  fail "GITHUB_REPOSITORY must be owner/name (got '$REPO')."
[ "$HEAD_REPO" = "$REPO" ] ||
  fail "A promotion to main must come from this repository's staging branch, not '$HEAD_REPO'."
[ "$HEAD" = "staging" ] ||
  fail "Pull requests into main must be promotions from 'staging' (got head '$HEAD'). Land the change on staging first, let staging CI pass, then promote."
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] ||
  fail "HEAD_SHA must be a full 40-character commit SHA (got '$SHA')."

LIVE_STAGING="$(git ls-remote origin refs/heads/staging | awk '{print $1}')" ||
  fail "Unable to read the live origin/staging tip."
[ "$SHA" = "$LIVE_STAGING" ] ||
  fail "Promotion head $SHA is not the live origin/staging tip ($LIVE_STAGING). Update the pull request to the current staging."

git fetch --no-tags --quiet origin +main:refs/remotes/origin/main +staging:refs/remotes/origin/staging ||
  fail "Unable to fetch origin/main and origin/staging for the ancestry check."
[ "$(git rev-parse --verify --quiet refs/remotes/origin/staging || true)" = "$SHA" ] ||
  fail "origin/staging moved while checking; re-run this check against the current staging tip."
git merge-base --is-ancestor refs/remotes/origin/main "$SHA" ||
  fail "origin/main is not contained in staging @ $SHA. Merge main into staging (normal merge) and let staging CI pass before promoting."

SUCCESSFUL_RUNS="$(gh api "repos/$REPO/actions/workflows/ci.yml/runs?head_sha=$SHA&branch=staging&event=push&per_page=100" \
  --jq "[.workflow_runs[] | select(.head_sha == \"$SHA\" and .head_branch == \"staging\" and .event == \"push\" and .status == \"completed\" and .conclusion == \"success\" and .path == \".github/workflows/ci.yml\")] | length")" ||
  fail "Unable to read CI runs for $SHA — refusing without proof that staging CI passed."
[[ "$SUCCESSFUL_RUNS" =~ ^[0-9]+$ ]] && [ "$SUCCESSFUL_RUNS" -ge 1 ] ||
  fail "No completed successful ci.yml push run on staging for $SHA (found '$SUCCESSFUL_RUNS'). Wait for staging CI to pass on this exact commit, then re-run this check."

echo "stage promotion proof OK: staging @ $SHA (live tip, contains main, staging push CI passed)"
