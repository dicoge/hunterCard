#!/usr/bin/env bash
# Signature verification + build provenance for the production-content APK
# (DIC-1193).
#
# This is the release gate: an APK reaches a tester only if it verifies, is NOT
# signed by the Android debug certificate, and can be described completely
# (commit, version, versionCode, EAS build id, SHA-256, signer). Every failure
# path exits non-zero BEFORE writing build-provenance.json or the job summary,
# so a rejected build never leaves behind something that looks like a delivery
# record.
#
# Usage: release-apk-verify.sh <normalised-eas-json> <apk-output-path>
# Env:   GITHUB_REF, GITHUB_SHA, GITHUB_SERVER_URL, GITHUB_REPOSITORY,
#        GITHUB_RUN_ID, GITHUB_STEP_SUMMARY
set -euo pipefail

BUILD_JSON="${1:?usage: release-apk-verify.sh <eas-json> <apk-path>}"
APK="${2:?usage: release-apk-verify.sh <eas-json> <apk-path>}"
VERIFY_LOG="${VERIFY_LOG:-apksigner-verify.txt}"
PROVENANCE="${PROVENANCE:-build-provenance.json}"

fail() {
  echo "::error::$1"
  exit 1
}

# sha256sum is coreutils (CI); shasum is the macOS fallback so the same script
# runs under the local test harness.
sha256_of() {
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

ARTIFACT_URL="$(jq -r '.artifacts.applicationArchiveUrl // .artifacts.buildUrl // empty' "$BUILD_JSON")"
[ -n "$ARTIFACT_URL" ] || fail "EAS build finished but reported no application archive URL."

BUILD_ID="$(jq -r '.id // empty' "$BUILD_JSON")"
APP_VERSION="$(jq -r '.appVersion // empty' "$BUILD_JSON")"
VERSION_CODE="$(jq -r '.appBuildVersion // empty' "$BUILD_JSON")"

# An APK nobody can trace back to a version is not deliverable, so a missing
# provenance field fails the run rather than shipping blanks.
for field in BUILD_ID APP_VERSION VERSION_CODE; do
  [ -n "${!field}" ] ||
    fail "EAS build JSON carried no $field — refusing to publish an APK without complete provenance. Check the eas build --json schema."
done

curl -fsSL "$ARTIFACT_URL" -o "$APK"
APK_SHA256="$(sha256_of "$APK")"

apksigner verify --verbose --print-certs "$APK" | tee "$VERIFY_LOG"

if grep -qi 'CN=Android Debug' "$VERIFY_LOG"; then
  fail "APK is signed with the Android DEBUG certificate — refusing to publish it as a production-content build."
fi

SIGNER_DN="$(grep -m1 'certificate DN:' "$VERIFY_LOG" | sed 's/.*certificate DN: //' || true)"
SIGNER_SHA256="$(grep -m1 'certificate SHA-256 digest:' "$VERIFY_LOG" | sed 's/.*digest: //' || true)"
if [ -z "$SIGNER_DN" ] || [ -z "$SIGNER_SHA256" ]; then
  fail "Could not read the signer certificate out of apksigner output (format drift?). Refusing to publish an APK whose signer was not positively identified — see the ${VERIFY_LOG} artifact."
fi

jq -n \
  --arg profile "production-apk" \
  --arg ref "${GITHUB_REF:-}" \
  --arg commit "${GITHUB_SHA:-}" \
  --arg buildId "$BUILD_ID" \
  --arg appVersion "$APP_VERSION" \
  --arg versionCode "$VERSION_CODE" \
  --arg apkSha256 "$APK_SHA256" \
  --arg signerDn "$SIGNER_DN" \
  --arg signerCertSha256 "$SIGNER_SHA256" \
  --arg artifactUrl "$ARTIFACT_URL" \
  --arg workflowRun "${GITHUB_SERVER_URL:-}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}" \
  '$ARGS.named' > "$PROVENANCE"
cat "$PROVENANCE"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### HoloHunter production-content APK (DIC-1193)"
    echo ""
    echo "| field | value |"
    echo "| --- | --- |"
    echo "| commit | \`${GITHUB_SHA:-}\` |"
    echo "| ref | \`${GITHUB_REF:-}\` |"
    echo "| version | \`$APP_VERSION\` (versionCode \`$VERSION_CODE\`) |"
    echo "| EAS build | \`$BUILD_ID\` |"
    echo "| APK SHA-256 | \`$APK_SHA256\` |"
    echo "| signer DN | \`$SIGNER_DN\` |"
    echo ""
    echo "Signature verified by apksigner and confirmed NOT the Android debug certificate."
  } >> "$GITHUB_STEP_SUMMARY"
fi
