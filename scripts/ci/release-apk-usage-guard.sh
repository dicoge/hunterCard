#!/usr/bin/env bash
# production-apk usage guard (DIC-1193).
#
# The production-content APK is a sideload artifact: Android only, never routed
# at a store (Play takes the AAB from the `production` profile).
#
# Allowlist, not denylist (CR DIC-1193 round 3). The previous version rejected
# only the literal `submit=true`, so ``, `yes` and `1` all passed — while the
# later submit step's `if: ${{ inputs.submit }}` treats every non-empty string as
# TRUE. A run could clear this guard and still be submitted. Only the explicit
# approved values pass now; anything else, including empty, fails closed.
#
# Env: PLATFORM, SUBMIT
set -euo pipefail

PLATFORM="${PLATFORM:-}"
SUBMIT="${SUBMIT:-}"

APPROVED_PLATFORM='android'
APPROVED_SUBMIT='false'

fail() {
  echo "::error::$1"
  exit 1
}

[ "$PLATFORM" = "$APPROVED_PLATFORM" ] ||
  fail "profile=production-apk is Android-only (got platform='$PLATFORM'). Use profile=production for iOS."

[ "$SUBMIT" = "$APPROVED_SUBMIT" ] ||
  fail "profile=production-apk requires submit=${APPROVED_SUBMIT} exactly (got submit='$SUBMIT'). An empty or unrecognised value is refused rather than assumed safe: the submit step treats any non-empty string as true, and Play Internal Testing takes the AAB from profile=production, never this APK."

echo "usage OK: platform=$PLATFORM submit=$SUBMIT"
