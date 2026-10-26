#!/usr/bin/env bash
# Staging Alpha ref guard (test-first release flow).
#
# The `staging-alpha` profile builds a store AAB for the Play closed-testing
# (Alpha) track from the staging branch. It is the ONLY non-main ref an
# AAB may come from, and only under all of these conditions:
#   - PROFILE is exactly `staging-alpha` and SUBMIT is exactly `false`: the
#     artifact is uploaded to the Alpha track by hand, never auto-submitted
#     (submit.production would publish to the Play production track);
#   - GITHUB_REF is exactly refs/heads/staging, and GITHUB_SHA is a full SHA
#     equal to the freshly fetched origin/staging tip (no stale dispatch);
#   - origin/main is an ancestor of that tip, so an Alpha never drops a fix
#     that production already ships;
#   - ci.yml has a successful `push` run for that exact SHA on staging.
# Production profiles keep using release-ref-guard.sh, which still accepts
# only main or a v* tag contained in main.
#
# Env: GITHUB_REF, GITHUB_SHA, GITHUB_REPOSITORY, PROFILE, SUBMIT,
#      GH_TOKEN (read access to Actions runs; used by `gh api`)
set -euo pipefail

REF="${GITHUB_REF:-}"
SHA="${GITHUB_SHA:-}"
REPO="${GITHUB_REPOSITORY:-}"
PROFILE="${PROFILE:-}"
SUBMIT="${SUBMIT:-}"

fail() {
  echo "::error::$1"
  exit 1
}

[ "$PROFILE" = "staging-alpha" ] ||
  fail "staging-alpha-ref-guard only vets profile=staging-alpha (got '$PROFILE')."
[ "$SUBMIT" = "false" ] ||
  fail "profile=staging-alpha requires submit=false exactly (got '$SUBMIT'). Upload the AAB to the Alpha track by hand; automatic submit is refused."
[ "$REF" = "refs/heads/staging" ] ||
  fail "profile=staging-alpha may only be built from refs/heads/staging (got '$REF')."
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] ||
  fail "GITHUB_SHA must be a full 40-character commit SHA (got '$SHA')."
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
  fail "GITHUB_REPOSITORY must be owner/name (got '$REPO')."

git fetch --no-tags --quiet origin staging:refs/remotes/origin/staging main:refs/remotes/origin/main ||
  fail "Unable to fetch origin/staging and origin/main — refusing to accept '$SHA' without a fresh comparison."
STAGING_TIP="$(git rev-parse --verify --quiet refs/remotes/origin/staging || true)"
[ "$SHA" = "$STAGING_TIP" ] ||
  fail "GITHUB_SHA ($SHA) is not the current origin/staging tip ($STAGING_TIP). Re-dispatch on the latest staging."
git merge-base --is-ancestor refs/remotes/origin/main "$SHA" ||
  fail "origin/main is not contained in staging @ $SHA. Merge main into staging (no force push) before building an Alpha."

# Only a completed, successful ci.yml run triggered by a push of this exact
# commit to staging counts. A PR run, a run of another commit, a failed or
# cancelled run, or a run of a different workflow does not.
SUCCESSFUL_RUNS="$(gh api "repos/$REPO/actions/workflows/ci.yml/runs?head_sha=$SHA&branch=staging&event=push&per_page=100" \
  --jq "[.workflow_runs[] | select(.head_sha == \"$SHA\" and .head_branch == \"staging\" and .event == \"push\" and .status == \"completed\" and .conclusion == \"success\" and .path == \".github/workflows/ci.yml\")] | length")" ||
  fail "Unable to read CI runs for $SHA — refusing without proof that CI passed."
[[ "$SUCCESSFUL_RUNS" =~ ^[0-9]+$ ]] && [ "$SUCCESSFUL_RUNS" -ge 1 ] ||
  fail "No successful ci.yml push run on staging for $SHA (found '$SUCCESSFUL_RUNS'). Wait for CI to pass on this exact commit."

echo "ref OK: staging @ $SHA (origin/staging tip, contains origin/main, CI passed)"
