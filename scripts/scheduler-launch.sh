#!/bin/bash
# Deployed entry point of the daily hunterCard scheduler (DIC-1167, QA 7f47b457).
#
# The cron used to run `bash <resident>/scripts/local-scrape-and-push.sh`, so
# the bytes that orchestrated every run were whatever sat in the resident
# checkout. That checkout is a personal, dirty worktree (local edits, a revert
# in progress, 231 commits behind origin/main on 2026-10-02) which the
# scheduler must never pull, reset or overwrite — so it never got PR #233's
# fixes, and every "fixed on main" scheduler change stayed undeployed: bash
# runs the stage-1 bootstrap it parsed from the resident file, and only
# origin's stage 2 is fresh. No code inside local-scrape-and-push.sh can repair
# the copy that is executing it.
#
# This launcher is location-independent and only reads the resident's git
# objects and node_modules. Every run it:
#   1. fetches origin/main into the resident repo (refs only — the resident
#      working tree, index and HEAD are never touched) and fails closed if the
#      fetch or the ref fails;
#   2. proves its OWN bytes are origin/main's committed scripts/scheduler-launch.sh;
#      a drifted installed copy re-executes origin's copy once instead, so the
#      launcher itself cannot go stale either;
#   3. materialises a fresh, private bootstrap worktree detached at that exact
#      origin SHA, proves its scheduler script is the committed blob, and links
#      its tracked node_modules shell to the resident install (DIC-1472
#      anchors);
#   4. runs THAT copy of local-scrape-and-push.sh with HUNTERCARD_FORCE_ISOLATED=1,
#      so stage 1 and stage 2 are both origin/main's code and the artifact is
#      still the auditable bot/scrape/<date> handoff (resident untouched);
#   5. propagates the scheduler's exit status and removes the bootstrap.
# Install (or reinstall) with:
#   git -C ~/hunterCard show origin/main:scripts/scheduler-launch.sh > ~/.hermes/bin/huntercard-scheduler-launch.sh
# and point the cron at `bash ~/.hermes/bin/huntercard-scheduler-launch.sh`.
set -u

# A launcher is never a delegated child: strip any child/stage-2 flags leaked
# from the caller's environment so they cannot reach the scheduler.
unset HUNTERCARD_FORCE_ISOLATED_STAGE2 HUNTERCARD_SELF_REEXEC HUNTERCARD_ISOLATION_ROUTE \
  HUNTERCARD_STAGE2_WORKTREE HUNTERCARD_STAGE2_EXPECTED_HEAD HUNTERCARD_STAGE2_NONCE \
  HUNTERCARD_CHILD_RECEIPT HUNTERCARD_CHILD_RECEIPT_NONCE

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
SELF_BLOB=$(git hash-object --no-filters "$SELF" 2>/dev/null || true)
RESIDENT_DIR="${HUNTERCARD_RESIDENT_DIR:-$HOME/hunterCard}"
REMOTE_REF="${HUNTERCARD_REMOTE_REF:-origin/main}"
BOOTSTRAP_PARENT="${HUNTERCARD_BOOTSTRAP_PARENT:-$HOME/.hermes/scheduler}"
LAUNCHER_REL='scripts/scheduler-launch.sh'
SCHEDULER_REL='scripts/local-scrape-and-push.sh'
DEP_ANCHORS=('puppeteer/package.json' 'cheerio/package.json')
LOG_FILE="$HOME/.hermes/logs/huntercard-scrape-$(date +%Y%m%d).log"
mkdir -p "$(dirname "$LOG_FILE")"

log() { echo "[$(date)] launcher: $*" >> "$LOG_FILE"; }
fail() {
  log "❌ $*; nothing was run (cron fails)"
  echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
  echo "scheduler-launch: $*" >&2
  exit 1
}
rgit() { git -C "$RESIDENT_DIR" "$@"; }

[ -n "$SELF_BLOB" ] || fail "cannot hash the running launcher $SELF"
rgit rev-parse --git-dir >/dev/null 2>&1 || fail "resident $RESIDENT_DIR is not a git checkout"

if ! rgit fetch origin main >> "$LOG_FILE" 2>&1; then
  fail "git fetch origin main failed in $RESIDENT_DIR"
fi
REMOTE_HEAD=$(rgit rev-parse --verify --quiet "${REMOTE_REF}^{commit}" 2>/dev/null || true)
[ -n "$REMOTE_HEAD" ] || fail "could not resolve $REMOTE_REF after fetch"

ORIGIN_LAUNCHER_BLOB=$(rgit rev-parse --verify --quiet "$REMOTE_HEAD:$LAUNCHER_REL" 2>/dev/null || true)
[ -n "$ORIGIN_LAUNCHER_BLOB" ] || fail "$REMOTE_REF ($REMOTE_HEAD) has no committed $LAUNCHER_REL to prove this launcher against"
if [ "$SELF_BLOB" != "$ORIGIN_LAUNCHER_BLOB" ]; then
  if [ "${HUNTERCARD_LAUNCHER_REEXEC:-}" = "1" ]; then
    fail "re-executed launcher (blob $SELF_BLOB) is still not $REMOTE_HEAD's committed $LAUNCHER_REL (blob $ORIGIN_LAUNCHER_BLOB)"
  fi
  ORIGIN_LAUNCHER=$(mktemp "${TMPDIR:-/tmp}/huntercard-scheduler-launch.XXXXXX") || fail "cannot stage origin's launcher"
  if ! rgit cat-file blob "$ORIGIN_LAUNCHER_BLOB" > "$ORIGIN_LAUNCHER" 2>/dev/null \
    || [ "$(git hash-object --no-filters "$ORIGIN_LAUNCHER" 2>/dev/null)" != "$ORIGIN_LAUNCHER_BLOB" ]; then
    rm -f "$ORIGIN_LAUNCHER"
    fail "could not materialise $REMOTE_HEAD's committed $LAUNCHER_REL"
  fi
  log "⚙️ installed launcher $SELF (blob $SELF_BLOB) drifted from $REMOTE_HEAD's committed copy (blob $ORIGIN_LAUNCHER_BLOB); re-executing origin's launcher — reinstall it to silence this"
  HUNTERCARD_LAUNCHER_REEXEC=1 bash "$ORIGIN_LAUNCHER" "$@"
  RC=$?
  rm -f "$ORIGIN_LAUNCHER"
  exit "$RC"
fi
unset HUNTERCARD_LAUNCHER_REEXEC

RESIDENT_HEAD=$(rgit rev-parse --verify --quiet HEAD 2>/dev/null || echo unresolved)
RESIDENT_SCRIPT_BLOB=$(git hash-object --no-filters "$RESIDENT_DIR/$SCHEDULER_REL" 2>/dev/null || echo unresolved)
ORIGIN_SCHEDULER_BLOB=$(rgit rev-parse --verify --quiet "$REMOTE_HEAD:$SCHEDULER_REL" 2>/dev/null || true)
[ -n "$ORIGIN_SCHEDULER_BLOB" ] || fail "$REMOTE_HEAD has no committed $SCHEDULER_REL"
log "resident $RESIDENT_DIR HEAD $RESIDENT_HEAD (on-disk scheduler blob $RESIDENT_SCRIPT_BLOB, not executed); $REMOTE_REF $REMOTE_HEAD; launcher blob $SELF_BLOB; scheduler blob $ORIGIN_SCHEDULER_BLOB"

# Bootstraps leaked by a SIGKILLed launcher. A run is capped well under an
# hour, so one older than a day cannot belong to a live run.
mkdir -p "$BOOTSTRAP_PARENT" || fail "cannot create $BOOTSTRAP_PARENT"
find "$BOOTSTRAP_PARENT" -mindepth 1 -maxdepth 1 -type d -name 'huntercard-bootstrap.*' -mtime +0 2>/dev/null \
  | while IFS= read -r leaked; do
      log "removing leaked bootstrap $leaked"
      rgit worktree remove --force "$leaked" >> "$LOG_FILE" 2>&1 || rm -rf "$leaked"
    done
rgit worktree prune >> "$LOG_FILE" 2>&1 || true

BOOTSTRAP=$(mktemp -d "$BOOTSTRAP_PARENT/huntercard-bootstrap.XXXXXX") || fail "cannot allocate a bootstrap directory"
cleanup() {
  rgit worktree remove --force "$BOOTSTRAP" >> "$LOG_FILE" 2>&1 || true
  rm -rf "$BOOTSTRAP"
  rgit worktree prune >> "$LOG_FILE" 2>&1 || true
}
trap cleanup EXIT
if ! rgit worktree add --detach "$BOOTSTRAP" "$REMOTE_HEAD" >> "$LOG_FILE" 2>&1; then
  fail "could not create the bootstrap worktree at $REMOTE_HEAD"
fi
BOOTSTRAP_HEAD=$(git -C "$BOOTSTRAP" rev-parse --verify --quiet HEAD 2>/dev/null || true)
BOOTSTRAP_SCRIPT_BLOB=$(git hash-object --no-filters "$BOOTSTRAP/$SCHEDULER_REL" 2>/dev/null || true)
if [ "$BOOTSTRAP_HEAD" != "$REMOTE_HEAD" ] || [ "$BOOTSTRAP_SCRIPT_BLOB" != "$ORIGIN_SCHEDULER_BLOB" ]; then
  fail "bootstrap $BOOTSTRAP is not $REMOTE_HEAD's committed scheduler (HEAD ${BOOTSTRAP_HEAD:-unresolved}, blob ${BOOTSTRAP_SCRIPT_BLOB:-unresolved})"
fi

# DIC-1472: the scheduler provisions its isolated worktree from ITS checkout's
# node_modules, which in a fresh worktree is only the tracked shell. Link the
# bootstrap's shell to the resident install (read-only reuse) and prove the
# anchors through the link.
RESIDENT_NM=$(cd "$RESIDENT_DIR/node_modules" 2>/dev/null && pwd -P || true)
for anchor in "${DEP_ANCHORS[@]}"; do
  [ -n "$RESIDENT_NM" ] && [ -f "$RESIDENT_NM/$anchor" ] || fail "resident node_modules is missing dependency anchor $anchor"
done
if ! rm -rf "$BOOTSTRAP/node_modules" || [ -e "$BOOTSTRAP/node_modules" ] \
  || ! ln -s "$RESIDENT_NM" "$BOOTSTRAP/node_modules" \
  || [ "$(cd "$BOOTSTRAP/node_modules" 2>/dev/null && pwd -P)" != "$RESIDENT_NM" ]; then
  fail "could not link the bootstrap node_modules to $RESIDENT_NM"
fi

log "running $REMOTE_HEAD's $SCHEDULER_REL from bootstrap $BOOTSTRAP (HUNTERCARD_FORCE_ISOLATED=1)"
HUNTERCARD_FORCE_ISOLATED=1 HUNTERCARD_REMOTE_REF="$REMOTE_REF" bash "$BOOTSTRAP/$SCHEDULER_REL" "$@"
RC=$?
log "scheduler exited $RC"
exit "$RC"
