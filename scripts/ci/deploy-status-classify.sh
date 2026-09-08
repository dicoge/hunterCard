#!/usr/bin/env bash
# Classifies a GitHub deployment_status event for the DIC-1401 public
# deploy-status mirror (.github/workflows/vercel-deploy-status-summary.yml).
#
# Emits two GITHUB_OUTPUT-formatted lines that downstream workflow steps
# gate on:
#   verdict=success|failure|ignore    — should we post any summary at all?
#   env_kind=production|preview|development|unknown
#                                     — used ONLY to decide whether the
#                                       Production-success branch runs.
#                                       Failure summaries are posted for
#                                       every env_kind so preview breakage
#                                       is still visible.
#
# Why this script exists (Round-6 CR blocker): Vercel actually emits
# `environment="Production – <project-name>"` (U+2013 en-dash surrounded by
# spaces) on this repo's two projects. The earlier workflow gated the
# Production-success summary on the raw string equality
# `environment == 'Production'`, which never matched Vercel's real events
# for `holocard-hunter` / `holohunter-staging`, so no Production success
# was ever published on the deployed commit. Extracting the classification
# here makes the mapping directly testable (mutation cases in
# scripts/test-deploy-status-classify.mjs run this script with the real
# Vercel-emitted values).
#
# The classifier accepts the project-qualified forms Vercel produces AND
# refuses to admit Preview / Development into the Production branch. It
# also handles a defensive fallback: the plain unqualified strings
# `Production` / `Preview` / `Development` are honoured (in case Vercel or
# a future GitHub Deployments consumer emits them plain), but any other
# environment value classifies as `unknown` — never `production`.
#
# Vercel-side reference (subject to change; the mutation coverage guards
# against silent regressions):
#   https://vercel.com/docs/deployments/environments
#
# Inputs (env vars, mirroring the workflow's classify step):
#   STATE       — github.event.deployment_status.state
#                 (success | failure | error | in_progress | queued | pending)
#   ENVIRONMENT — github.event.deployment_status.environment
#                 (e.g. "Production – holocard-hunter",
#                       "Preview – holohunter-staging",
#                       "Production", "" (unknown))
# Outputs (both stdout AND GITHUB_OUTPUT when set):
#   verdict=...   env_kind=...
set -euo pipefail

STATE_INPUT="${STATE:-}"
ENV_INPUT="${ENVIRONMENT:-}"

case "$STATE_INPUT" in
  success)        VERDICT=success ;;
  error|failure)  VERDICT=failure ;;
  *)              VERDICT=ignore ;;
esac

# Extract the environment "kind" — the string before Vercel's project
# qualifier separator. Vercel uses " – " (space U+2013 en-dash space);
# an ASCII " - " (space hyphen space) is defensively accepted so a Vercel
# side-string change never silently reclassifies Preview as Production.
#
# Bash pattern-strip on the en-dash relies on this file being read as
# UTF-8 (which it is — set-euo-pipefail is one shebang line, no locale
# reset). The literal below is U+2013.
ENV_PREFIX="${ENV_INPUT%% – *}"
if [ "$ENV_PREFIX" = "$ENV_INPUT" ]; then
  ENV_PREFIX="${ENV_INPUT%% - *}"
fi
# Trim any trailing whitespace that survived (defensive).
ENV_PREFIX="${ENV_PREFIX%"${ENV_PREFIX##*[![:space:]]}"}"

case "$ENV_PREFIX" in
  Production)   ENV_KIND=production ;;
  Preview)      ENV_KIND=preview ;;
  Development)  ENV_KIND=development ;;
  "")           ENV_KIND=unknown ;;
  *)            ENV_KIND=unknown ;;
esac

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "verdict=$VERDICT"
    echo "env_kind=$ENV_KIND"
  } >> "$GITHUB_OUTPUT"
fi

echo "verdict=$VERDICT"
echo "env_kind=$ENV_KIND"
