#!/usr/bin/env bash
#
# Verify the permissions a built release artifact actually requests (DIC-1248).
#
# scripts/test-play-release-manifest.mjs asserts the *configuration* that should
# produce a minimal manifest. It cannot assert the merged result: Gradle merges
# Maven AARs that never appear in node_modules. This script closes that gap by
# reading the merged manifest out of the artifact Play will receive and diffing
# it against docs/play/expected-release-permissions.txt.
#
# Run it on every release artifact before uploading to Play. An unexplained
# addition means the manifest widened; an unexplained removal means a feature
# lost its permission.
#
# Usage:
#   scripts/ci/play-artifact-permissions-verify.sh path/to/app.aab
#   scripts/ci/play-artifact-permissions-verify.sh path/to/app.apk
#
# Requirements:
#   .apk  -> aapt2 from the Android SDK build-tools
#   .aab  -> bundletool (the AAB manifest is protobuf-encoded, aapt2 cannot read it)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASELINE="${ROOT}/docs/play/expected-release-permissions.txt"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

ARTIFACT="${1:-}"
[ -n "${ARTIFACT}" ] || fail "usage: $(basename "$0") <path-to-artifact.aab|.apk>"
[ -f "${ARTIFACT}" ] || fail "artifact not found: ${ARTIFACT}"
[ -f "${BASELINE}" ] || fail "baseline not found: ${BASELINE}"

# Resolve aapt2: explicit override, PATH, then the newest installed build-tools.
resolve_aapt2() {
  if [ -n "${AAPT2:-}" ]; then
    echo "${AAPT2}"
    return
  fi
  if command -v aapt2 >/dev/null 2>&1; then
    command -v aapt2
    return
  fi
  local sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-${HOME}/Library/Android/sdk}}"
  local newest
  newest="$(ls -d "${sdk}"/build-tools/*/aapt2 2>/dev/null | sort -V | tail -1)"
  [ -n "${newest}" ] || fail "aapt2 not found. Set AAPT2=/path/to/aapt2 or install Android SDK build-tools."
  echo "${newest}"
}

actual_permissions() {
  case "${ARTIFACT}" in
    *.apk)
      local aapt2
      aapt2="$(resolve_aapt2)"
      "${aapt2}" dump permissions "${ARTIFACT}" \
        | sed -n "s/^uses-permission: name='\(.*\)'$/\1/p"
      ;;
    *.aab)
      command -v bundletool >/dev/null 2>&1 \
        || fail "bundletool not found; it is required to read an .aab manifest (brew install bundletool)."
      bundletool dump manifest --bundle="${ARTIFACT}" \
        | sed -n 's/.*<uses-permission[^>]*android:name="\([^"]*\)".*/\1/p'
      ;;
    *)
      fail "unsupported artifact type: ${ARTIFACT} (expected .aab or .apk)"
      ;;
  esac
}

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "${BASELINE}" | sort -u > "${WORK}/expected.txt"
actual_permissions | sort -u > "${WORK}/actual.txt"

# A silently empty dump would otherwise read as "no unexpected permissions".
[ -s "${WORK}/actual.txt" ] \
  || fail "no permissions read from ${ARTIFACT}; the dump produced nothing, so this check proved nothing."

UNEXPECTED="$(comm -13 "${WORK}/expected.txt" "${WORK}/actual.txt")"
MISSING="$(comm -23 "${WORK}/expected.txt" "${WORK}/actual.txt")"

if [ -n "${UNEXPECTED}" ]; then
  echo "Permissions present in the artifact but not in the baseline:" >&2
  echo "${UNEXPECTED}" | sed 's/^/  + /' >&2
fi
if [ -n "${MISSING}" ]; then
  echo "Permissions expected by the baseline but absent from the artifact:" >&2
  echo "${MISSING}" | sed 's/^/  - /' >&2
fi

if [ -n "${UNEXPECTED}" ] || [ -n "${MISSING}" ]; then
  fail "merged manifest does not match docs/play/expected-release-permissions.txt. Re-audit the change, then update the baseline in the same commit that explains it."
fi

echo "OK: $(wc -l < "${WORK}/actual.txt" | tr -d ' ') permissions match docs/play/expected-release-permissions.txt"
