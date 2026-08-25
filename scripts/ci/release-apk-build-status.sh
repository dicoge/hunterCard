#!/usr/bin/env bash
# Normalise + status-check the `eas build --json --wait` result (DIC-1193).
#
# `eas build --json` returns an array today; normalising means a single-object
# response from a future CLI cannot silently break `.[0]` lookups downstream.
# Anything that is not a FINISHED build stops the run here, before the SDK
# install and before anything is downloaded.
#
# Usage: release-apk-build-status.sh <raw-eas-json> <normalised-out-json>
set -euo pipefail

RAW="${1:?usage: release-apk-build-status.sh <raw-eas-json> <out-json>}"
OUT="${2:?usage: release-apk-build-status.sh <raw-eas-json> <out-json>}"

fail() {
  echo "::error::$1"
  exit 1
}

jq 'if type == "array" then .[0] else . end' "$RAW" > "$OUT"

STATUS="$(jq -r '.status // empty' "$OUT")"
[ "$STATUS" = "FINISHED" ] ||
  fail "EAS build did not finish (status=${STATUS:-<none>}). See https://expo.dev/accounts/dicoge/projects/holohunter/builds"

echo "EAS build FINISHED: $(jq -r '.id // "<no id>"' "$OUT")"
