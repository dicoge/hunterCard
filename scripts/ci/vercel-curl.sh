#!/usr/bin/env bash
# Authenticated Vercel API curl without the token in any process argv
# (PR #216 security CR d90a82ad).
#
# `curl --oauth2-bearer "${VERCEL_TOKEN}"` expands the credential into curl's
# argv, where any process on the runner can read it (`ps`, /proc/<pid>/cmdline)
# for as long as the request runs. This wrapper instead hands curl its
# Authorization header on STDIN as a curl config file (`--config -`), written
# by bash's BUILTIN printf — a builtin runs in-process, so no exec ever carries
# the token as an argument. The token is also moved into a non-exported shell
# variable before curl starts, so it is not in curl's environment either.
#
# Fail closed: an absent/empty token, or one containing a character that could
# break out of the quoted config value (`"`, `\`, whitespace, control bytes),
# exits 1 with a fixed message BEFORE curl runs. The token is never printed.
#
# Usage: VERCEL_TOKEN=... bash scripts/ci/vercel-curl.sh <curl args...>
# Every argument is passed to curl verbatim; curl's own exit status and stdout
# (e.g. `-w '%{http_code}'`) are preserved.
#
# Behaviour is executed, not grepped, by scripts/test-vercel-curl.mjs.
set +x
set -euo pipefail
LC_ALL=C  # byte-wise ranges in the shape check below

token="${VERCEL_TOKEN:-}"
unset VERCEL_TOKEN

if [ -z "$token" ]; then
  echo "::error::VERCEL_TOKEN is missing or empty; refusing to call the Vercel API." >&2
  exit 1
fi
case "$token" in
  *[!\!-~]* | *'"'* | *'\'*)
    echo "::error::VERCEL_TOKEN has an unexpected shape; refusing to call the Vercel API." >&2
    exit 1
    ;;
esac

printf 'header = "Authorization: Bearer %s"\n' "$token" | curl --config - "$@"
