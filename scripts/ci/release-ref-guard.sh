#!/usr/bin/env bash
# Release-ref guard (DIC-1193).
#
# A release artifact must be traceable to reviewed code. `main` is allowed
# directly; a `v*` tag is allowed only when its commit is an ancestor of
# origin/main, so a tag cut from a side branch cannot become a release.
#
# Lives in a script rather than inline in the workflow so its exit-status
# behaviour is testable (scripts/test-release-apk-pipeline.mjs) instead of
# merely greppable — inline shell can be neutered with `&& false` while every
# text assertion still passes (CR DIC-1193).
#
# Env: GITHUB_REF, GITHUB_SHA, PROFILE
set -euo pipefail

REF="${GITHUB_REF:-}"
SHA="${GITHUB_SHA:-}"
PROFILE="${PROFILE:-}"

fail() {
  echo "::error::$1"
  exit 1
}

# Provenance has to name an immutable commit. A branch ref alone, a short SHA or
# an empty value would all produce a build nobody can pin down later, so they are
# refused before any ref matching happens (CR DIC-1193 round 3).
[ -n "$REF" ] || fail "GITHUB_REF is empty — refusing to cut a release build from an unidentified ref."
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] ||
  fail "GITHUB_SHA must be a full 40-character commit SHA (got '${SHA}'). A short, blank or ref-only value cannot be recorded as immutable build provenance."

case "$REF" in
  refs/heads/main)
    echo "ref OK: main @ $SHA"
    ;;
  refs/tags/v*)
    git fetch --no-tags --quiet origin main:refs/remotes/origin/main
    git merge-base --is-ancestor "$SHA" refs/remotes/origin/main ||
      fail "Release tag ${REF#refs/tags/} ($SHA) is not contained in main. A '$PROFILE' build may only be cut from reviewed, merged code."
    echo "ref OK: tag ${REF#refs/tags/} @ $SHA (contained in main)"
    ;;
  *)
    fail "Profile '$PROFILE' may only be built from 'main' or a 'v*' release tag contained in main — got '$REF'. Merge to main first, then re-run."
    ;;
esac
