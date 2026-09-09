#!/usr/bin/env bash
# Record build provenance for the EAS `production` profile (AAB / iOS
# archive) at SUBMISSION time, closing the DIC-1401 CR round-2 gap:
#
#   The parity contract reads `build-provenance.json`'s commit field as the
#   mobile production build's source SHA. Only `production-apk` produced that
#   file; `production` ran `eas build --no-wait` and recorded NO provenance,
#   so the formal AAB's source SHA was unverifiable and a parity check could
#   pass on an arbitrary hand-typed SHA. This script makes the `production`
#   path emit the SAME evidence shape before the job exits, with an immutable
#   commit that cannot be re-typed later.
#
# The immutable source SHA is the checkout the build was dispatched from
# (GITHUB_SHA, set by the workflow_dispatch run). The EAS build ID is read
# live from `eas build --json --no-wait`, so the record ties a real EAS cloud
# build to a real reviewed commit even though the artifact is still queued.
#
# Usage: record-eas-build-provenance.sh <raw-eas-json> <profile>
# Env:   GITHUB_SHA, GITHUB_REF, GITHUB_SERVER_URL, GITHUB_REPOSITORY,
#        GITHUB_RUN_ID, GITHUB_STEP_SUMMARY
set -euo pipefail

RAW="${1:?usage: record-eas-build-provenance.sh <raw-eas-json> <profile>}"
PROFILE="${2:?usage: record-eas-build-provenance.sh <raw-eas-json> <profile>}"

fail() {
  echo "::error::$1"
  exit 1
}

# Provenance must name the exact immutable commit, or it is not provenance.
[[ "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ ]] ||
  fail "GITHUB_SHA must be a full 40-character commit SHA (got '${GITHUB_SHA:-}'). A short, blank or ref-only value cannot be recorded as immutable build provenance."
for provenance_field in GITHUB_REF GITHUB_SERVER_URL GITHUB_REPOSITORY GITHUB_RUN_ID; do
  [ -n "${!provenance_field:-}" ] ||
    fail "$provenance_field is empty — refusing to record provenance that cannot identify its ref and workflow run."
done

# Normalise `eas build --json` (array today, object form possible in future CLIs).
NORMALISED="$(mktemp)"
jq 'if type == "array" then .[0] else . end' "$RAW" > "$NORMALISED"

BUILD_ID="$(jq -r '.id // empty' "$NORMALISED")"
[ -n "$BUILD_ID" ] || fail "eas build --json reported no build id — cannot tie this record to a real EAS build. Check the eas build --json schema."

APP_VERSION="$(jq -r '.appVersion // empty' "$NORMALISED" || true)"
VERSION_CODE="$(jq -r '.appBuildVersion // empty' "$NORMALISED" || true)"
ARTIFACT_URL="$(jq -r '.artifacts.applicationArchiveUrl // .artifacts.buildUrl // empty' "$NORMALISED" || true)"
EAS_COMMIT="$(jq -r '.gitCommitHash // empty' "$NORMALISED" || true)"

jq -n \
  --arg profile "$PROFILE" \
  --arg ref "$GITHUB_REF" \
  --arg commit "$GITHUB_SHA" \
  --arg gitCommitHash "${EAS_COMMIT:-$GITHUB_SHA}" \
  --arg buildId "$BUILD_ID" \
  --arg appVersion "$APP_VERSION" \
  --arg versionCode "$VERSION_CODE" \
  --arg artifactUrl "$ARTIFACT_URL" \
  --arg workflowRun "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" \
  '$ARGS.named' > build-provenance.json
cat build-provenance.json

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### HoloHunter EAS \`$PROFILE\` build provenance (DIC-1401)"
    echo ""
    echo "| field | value |"
    echo "| --- | --- |"
    echo "| immutable source commit | \`$GITHUB_SHA\` |"
    echo "| ref | \`$GITHUB_REF\` |"
    echo "| EAS build id | \`$BUILD_ID\` |"
    echo "| workflow run | \`$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID\` |"
    [ -n "$APP_VERSION" ] && echo "| version | \`$APP_VERSION\` |"
    [ -n "$VERSION_CODE" ] && echo "| versionCode/buildNumber | \`$VERSION_CODE\` |"
    echo ""
    echo "Pass the \`commit\` field to the release-parity-check workflow to compare this mobile build against Web Production's \`/version.json\` SHA."
  } >> "$GITHUB_STEP_SUMMARY"
fi