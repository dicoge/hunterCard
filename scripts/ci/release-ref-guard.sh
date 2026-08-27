#!/usr/bin/env bash
# Release-ref guard (DIC-1193).
#
# A release artifact must be traceable to reviewed code. `main` is allowed only
# when GITHUB_SHA is EXACTLY the current origin/main tip (freshly fetched,
# never the checked-out cached value); a `v*` tag is allowed only when its
# commit is an ancestor of origin/main, so a tag cut from a side branch cannot
# become a release.
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
    # A manual dispatch on `refs/heads/main` pins whatever SHA the workflow
    # was queued at. That may be an ancestor of what `origin/main` looks like
    # now — a stale commit from before a hot-fix merged. Refusing anything
    # other than the freshly resolved tip is what makes a "latest main" build
    # actually mean latest main (CR DIC-1210). The fetch itself must fail the
    # gate: silently accepting the checked-out SHA when origin is unreachable
    # is the same class of bypass we are closing.
    git fetch --no-tags --quiet origin main:refs/remotes/origin/main ||
      fail "Unable to fetch origin/main to verify the release SHA — refusing to accept '$SHA' without a fresh comparison. A '$PROFILE' build must be pinned to a verifiable latest-main tip."
    LATEST_MAIN="$(git rev-parse --verify --quiet refs/remotes/origin/main || true)"
    [[ "$LATEST_MAIN" =~ ^[0-9a-f]{40}$ ]] ||
      fail "origin/main did not resolve to a 40-character commit SHA (got '$LATEST_MAIN'). Refusing to build a '$PROFILE' release without verifiable latest-main provenance."
    if [ "$SHA" != "$LATEST_MAIN" ]; then
      fail "GITHUB_SHA ($SHA) does not match the current origin/main tip ($LATEST_MAIN). Refusing to cut a '$PROFILE' release from stale main content — rebase or re-dispatch on the latest main, then re-run."
    fi
    echo "ref OK: main @ $SHA (matches origin/main tip)"
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
