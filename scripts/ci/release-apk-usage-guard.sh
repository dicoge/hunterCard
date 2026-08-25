#!/usr/bin/env bash
# production-apk usage guard (DIC-1193).
#
# The production-content APK is a sideload artifact: Android only, never routed
# at a store (Play takes the AAB from the `production` profile). Anything else
# fails closed — including an empty platform.
#
# Env: PLATFORM, SUBMIT
set -euo pipefail

PLATFORM="${PLATFORM:-}"
SUBMIT="${SUBMIT:-}"

fail() {
  echo "::error::$1"
  exit 1
}

[ "$PLATFORM" = "android" ] ||
  fail "profile=production-apk is Android-only (got platform='$PLATFORM'). Use profile=production for iOS."

[ "$SUBMIT" != "true" ] ||
  fail "profile=production-apk cannot be submitted — Play Internal Testing takes the AAB from profile=production. Re-run with submit=false, or use profile=production to submit."

echo "usage OK: platform=android submit=$SUBMIT"
