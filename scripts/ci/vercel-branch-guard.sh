#!/usr/bin/env bash
# Vercel per-project branch guard (DIC-1401).
#
# HoloHunter runs two independent Vercel projects against the same repo:
#   - holocard-hunter   (Production, canonical domain holohunter.dicoge.com,
#                        Production Branch = main)
#   - holohunter-staging (isolated staging lane, test.holohunter.dicoge.com,
#                        Production Branch = staging)
#
# Each project's "Production Branch" setting lives only in the Vercel
# dashboard (DIC-1399 secrets/config are still blocked, so it may not even be
# applied yet). This script is a code-level, secret-free second guard: it is
# wired as the FIRST step of vercel.json's buildCommand on both branches so a
# misconfigured project (or a future settings drift) can never silently ship
# the wrong branch as its Production deployment.
#
# It only restricts VERCEL_ENV=production builds. Preview deployments (PRs,
# other feature branches) are left alone on both projects — this guard must
# never break existing preview-deploy behaviour.
#
# Required build-time env:
#   EXPECTED_VERCEL_BRANCH — set as a literal in each branch's own vercel.json
#                            buildCommand (main -> "main", staging -> "staging").
# Vercel-provided env (see https://vercel.com/docs/environment-variables/system-environment-variables):
#   VERCEL_ENV             — "production" | "preview" | "development"
#   VERCEL_GIT_COMMIT_REF  — branch name of the commit being built
set -euo pipefail

EXPECTED="${EXPECTED_VERCEL_BRANCH:-}"
VERCEL_ENV_VALUE="${VERCEL_ENV:-}"
ACTUAL_REF="${VERCEL_GIT_COMMIT_REF:-}"

fail() {
  echo "::error::$1" >&2
  exit 1
}

[ -n "$EXPECTED" ] ||
  fail "EXPECTED_VERCEL_BRANCH is not set on this build. Refusing to build until vercel.json pins the branch this project/lane is contracted to serve."

# Non-production contexts (Preview / Development) are not gated: every branch
# must still be able to preview-build on either project.
if [ "$VERCEL_ENV_VALUE" != "production" ]; then
  echo "vercel-branch-guard: VERCEL_ENV='${VERCEL_ENV_VALUE:-<unset>}' (not production) — preview/dev build, guard not enforced."
  exit 0
fi

[ -n "$ACTUAL_REF" ] ||
  fail "VERCEL_ENV=production but VERCEL_GIT_COMMIT_REF is empty. Refusing a Production deployment whose source branch cannot be verified."

if [ "$ACTUAL_REF" != "$EXPECTED" ]; then
  fail "This Vercel project's Production Branch is contracted to '$EXPECTED' but the triggered Production build is for '$ACTUAL_REF'. Refusing to deploy — a project must only ever serve its assigned branch as Production (holocard-hunter=main, holohunter-staging=staging)."
fi

echo "vercel-branch-guard OK: Production build on '$ACTUAL_REF' matches contracted branch '$EXPECTED'."
