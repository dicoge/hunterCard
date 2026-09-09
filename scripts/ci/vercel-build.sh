#!/usr/bin/env bash
# Cross-branch Vercel build entrypoint (DIC-1401).
#
# vercel.json's buildCommand must be <= 256 characters (Vercel schema
# validation rejects anything longer: "buildCommand should NOT be longer than
# 256 characters"). The full pipeline (branch guard, deployment-data gate,
# expo web export, build-version writer, html fixer, asset copier, assetlinks
# generator) overflows that limit, so the literal command is here instead and
# vercel.json points at `bash scripts/ci/vercel-build.sh`.
#
# Lane-specific values are declared in each branch's vercel.json `build.env`
# (Vercel injects them into the install+build step), so this file stays
# identical across branches and never carries a lane literal:
#   EXPECTED_VERCEL_BRANCH  — branch this project/lane must serve as Production
#                             (holocard-hunter=main, holohunter-staging=staging)
#   EXPO_PUBLIC_STORE_MVP   — store/MVP switch inlined into the web bundle
#   EXPO_EXPORT_CLEAR       — "1" clears the expo export cache (staging lane)
set -euo pipefail

[ -n "${EXPECTED_VERCEL_BRANCH:-}" ] || {
  echo "::error::EXPECTED_VERCEL_BRANCH is not set for this build lane. vercel.json must pin it via build.env." >&2
  exit 1
}
[ -n "${EXPO_PUBLIC_STORE_MVP:-}" ] || {
  echo "::error::EXPO_PUBLIC_STORE_MVP is not set for this build lane." >&2
  exit 1
}

bash scripts/ci/vercel-branch-guard.sh
npm run test:deployment-data

EXPO_ARGS=(--platform web)
if [ "${EXPO_EXPORT_CLEAR:-0}" = "1" ]; then
  EXPO_ARGS+=(--clear)
fi
EXPO_PUBLIC_STORE_MVP="$EXPO_PUBLIC_STORE_MVP" expo export "${EXPO_ARGS[@]}"

node scripts/ci/write-build-version.mjs
node scripts/fix-html.js
node scripts/copy-assets.js
node scripts/generate-assetlinks.mjs