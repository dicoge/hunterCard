#!/usr/bin/env bash
# Vercel per-project branch guard (DIC-1401).
#
# HoloHunter runs two independent Vercel projects against the same repo:
#   - holocard-hunter   (Production, canonical domain holohunter.dicoge.com,
#                        Production Branch = main)
#   - holohunter-staging (isolated staging lane, test.holohunter.dicoge.com,
#                        Production Branch = staging)
#
# Each project's "Production Branch" setting lives in the Vercel dashboard
# (DIC-1399 secrets/config are still blocked, so it may not even be applied
# yet). This script is a code-level, secret-free second guard: it is wired
# as the FIRST step of vercel.json's buildCommand on both branches so a
# misconfigured project (or a future settings drift) can never silently
# ship the wrong branch as its Production deployment.
#
# THE BINDING IS TO PROJECT IDENTITY, NOT TO ANY BRANCH-DECLARED VALUE.
# The earlier version compared the branch's own EXPECTED_VERCEL_BRANCH (read
# from that same branch's vercel.json) with VERCEL_GIT_COMMIT_REF, so a
# misconfigured project building the wrong branch would see a self-consistent
# expected==actual and pass. That is exactly the failure this guard exists to
# stop, so the trusted identity now comes from Vercel's runtime env — either
# VERCEL_PROJECT_ID (immutable UUID Vercel assigns to the project) or
# VERCEL_PROJECT_PRODUCTION_URL (the project's assigned Production domain,
# not the current deployment's URL). Both are per-PROJECT and do not travel
# with the branch being built. The registry file
# (scripts/ci/vercel-project-registry.tsv) is committed to every branch and
# is therefore identical regardless of which branch Vercel checks out.
#
# It only restricts VERCEL_ENV=production builds. Preview deployments (PRs,
# other feature branches) are left alone on both projects — this guard must
# never break existing preview-deploy behaviour.
#
# Vercel-provided env (see https://vercel.com/docs/environment-variables/system-environment-variables):
#   VERCEL_ENV                       — "production" | "preview" | "development"
#   VERCEL_GIT_COMMIT_REF            — branch name of the commit being built
#   VERCEL_PROJECT_ID                — immutable per-project UUID
#   VERCEL_PROJECT_PRODUCTION_URL    — the project's assigned Production domain
# Overridable for tests:
#   VERCEL_PROJECT_REGISTRY_PATH     — path to the registry TSV
set -euo pipefail

REGISTRY_PATH="${VERCEL_PROJECT_REGISTRY_PATH:-scripts/ci/vercel-project-registry.tsv}"
VERCEL_ENV_VALUE="${VERCEL_ENV:-}"
ACTUAL_REF="${VERCEL_GIT_COMMIT_REF:-}"
PROJECT_ID_VALUE="${VERCEL_PROJECT_ID:-}"
PROJECT_PRODUCTION_URL_VALUE="${VERCEL_PROJECT_PRODUCTION_URL:-}"

fail() {
  echo "::error::$1" >&2
  exit 1
}

[ -r "$REGISTRY_PATH" ] ||
  fail "Vercel project registry is missing or unreadable at '${REGISTRY_PATH}'. Refusing to build until the trusted project→branch mapping is available."

# Non-production contexts (Preview / Development) are not gated: every branch
# must still be able to preview-build on either project.
if [ "$VERCEL_ENV_VALUE" != "production" ]; then
  echo "vercel-branch-guard: VERCEL_ENV='${VERCEL_ENV_VALUE:-<unset>}' (not production) — preview/dev build, guard not enforced."
  exit 0
fi

[ -n "$ACTUAL_REF" ] ||
  fail "VERCEL_ENV=production but VERCEL_GIT_COMMIT_REF is empty. Refusing a Production deployment whose source branch cannot be verified."

if [ -z "$PROJECT_ID_VALUE" ] && [ -z "$PROJECT_PRODUCTION_URL_VALUE" ]; then
  fail "VERCEL_ENV=production but neither VERCEL_PROJECT_ID nor VERCEL_PROJECT_PRODUCTION_URL is set. Refusing to build — cannot bind this Production build to a Vercel project identity."
fi

# Walk the registry once. project_id matches take priority over
# production_url matches so that once a project's UUID is populated, a stale
# domain entry cannot override it.
resolved_from=""
allowed_branch=""
resolved_priority=0  # 2 = project_id, 1 = production_url, 0 = none

# Read TSV: kind<TAB>value<TAB>branch<TAB>label. Skip blanks and comments.
while IFS=$'\t' read -r kind value branch label; do
  case "${kind:-}" in
    ""|"#"*) continue ;;
  esac
  case "$kind" in
    project_id)
      if [ -n "$PROJECT_ID_VALUE" ] && [ "$value" = "$PROJECT_ID_VALUE" ] && [ "$resolved_priority" -lt 2 ]; then
        resolved_from="project_id(${label:-<no-label>})"
        allowed_branch="$branch"
        resolved_priority=2
      fi
      ;;
    production_url)
      if [ -n "$PROJECT_PRODUCTION_URL_VALUE" ] && [ "$value" = "$PROJECT_PRODUCTION_URL_VALUE" ] && [ "$resolved_priority" -lt 1 ]; then
        resolved_from="production_url(${label:-<no-label>})"
        allowed_branch="$branch"
        resolved_priority=1
      fi
      ;;
    *)
      fail "vercel-project-registry.tsv contains unknown identity kind '${kind}' — refusing to build until the registry is corrected."
      ;;
  esac
done < "$REGISTRY_PATH"

if [ "$resolved_priority" -eq 0 ]; then
  fail "Vercel project identity {VERCEL_PROJECT_ID='${PROJECT_ID_VALUE:-<unset>}', VERCEL_PROJECT_PRODUCTION_URL='${PROJECT_PRODUCTION_URL_VALUE:-<unset>}'} is not present in ${REGISTRY_PATH}. Refusing to build — an unregistered project must not deploy Production for this repo."
fi

if [ "$ACTUAL_REF" != "$allowed_branch" ]; then
  fail "Vercel project resolved via ${resolved_from} is contracted to Production branch '${allowed_branch}', but this Production build was triggered for '${ACTUAL_REF}'. Refusing to deploy — a project must only ever serve its assigned branch as Production (holocard-hunter=main, holohunter-staging=staging)."
fi

echo "vercel-branch-guard OK: Production build on '${ACTUAL_REF}' matches contracted branch '${allowed_branch}' for ${resolved_from}."
