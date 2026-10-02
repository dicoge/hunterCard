#!/bin/bash
# Local scraper: optional local full scrape for WAF-sensitive price sources.
# Official catalog sync runs in GitHub Actions on a schedule and must not depend on yuyu availability.
#
# DIC-1321: this scheduler must never deadlock on a dirty personal worktree and
# must never report success while its price coverage collapsed (the 0↔1547
# oscillation / 1,885→1,547 shrinking-count class). Two behaviours were added:
#   1. A dirty in-place worktree no longer permanently aborts. If the resident
#      checkout has residue in scraper-managed paths, the pipeline re-runs the
#      SAME build in an isolated throwaway git worktree pinned to origin/main
#      and pushes the artifact to a dedicated `bot/scrape/<YYYY-MM-DD>` branch
#      — it never touches, deletes or overwrites the user's dirty local files.
#   2. After the build, hard coverage / change-budget floors are enforced. If
#      the priced-cardNumber coverage collapses below a floor relative to the
#      previous build, or the priced coverage drops by more than the change
#      budget, the script exits non-zero so the cron never reports success on a
#      skip/failed scrape (DIC-1167 regression 2026-08-30: sellPrice=0 pushed and
#      printed "Done").

set -e
# DIC-1167 (2026-09-30 P0): the cron invokes this script by the RESIDENT path,
# and bash keeps executing the function definitions it parsed from that file
# for the whole run — a fetch, fast-forward or fresh isolated worktree never
# reloads them. On 09-30 the resident copy was 225 commits stale, so the
# dirty-isolated route built origin/main's DATA with the resident's
# ORCHESTRATION (no run budget, no fail-closed push). Record the identity of
# the bytes this process is running so every route can prove it runs the
# committed origin version before it mutates anything (see
# selfScriptIsCommittedAt).
SELF_SCRIPT="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
SELF_SCRIPT_BLOB=$(git hash-object --no-filters "$SELF_SCRIPT" 2>/dev/null || true)
cd "$(dirname "$0")/.."
# Overridable so the pipeline regression can run hermetically without contending
# with (or clearing) the real cron lock.
LOCK_FILE="${HUNTERCARD_LOCK_FILE:-/tmp/huntercard-scrape.lock}"
LOG_FILE="$HOME/.hermes/logs/huntercard-scrape-$(date +%Y%m%d).log"
mkdir -p "$(dirname "$LOG_FILE")"

# DIC-1167 (CR cb2b3b13): a delegated child (forced/dirty stage 2, or the
# in-place re-exec) runs under its own lock while its parent still holds the
# primary one. Its parent waits on it and reports Done on its result, so a
# child that "skips" on a lock collision would turn a run that never scraped
# or pushed into a success — the stale-lock state a killed stage 2 leaves
# behind (no EXIT trap on SIGKILL/OOM). A child therefore never skips: a
# collision fails closed. Its parent clears orphaned child locks before
# spawning (clearOrphanChildLock) and also requires the child's completion
# receipt (childReceiptDetail), never a bare exit 0.
LOCK_CHILD_ROLE=""
if [ "${HUNTERCARD_FORCE_ISOLATED_STAGE2:-}" = "1" ]; then
  LOCK_CHILD_ROLE="stage 2"
elif [ "${HUNTERCARD_SELF_REEXEC:-}" = "1" ]; then
  LOCK_CHILD_ROLE="re-executed run"
fi
# The parent's receipt request is for THIS process only; never let it leak
# into the pipeline or into a grandchild (which gets its own).
PARENT_RECEIPT="${HUNTERCARD_CHILD_RECEIPT:-}"
PARENT_RECEIPT_NONCE="${HUNTERCARD_CHILD_RECEIPT_NONCE:-}"
unset HUNTERCARD_CHILD_RECEIPT HUNTERCARD_CHILD_RECEIPT_NONCE

# Prevent concurrent execution
if ! mkdir "$LOCK_FILE" 2>/dev/null; then
  if [ -n "$LOCK_CHILD_ROLE" ]; then
    echo "[$(date)] ❌ $LOCK_CHILD_ROLE lock $LOCK_FILE already exists (owner pid $(cat "$LOCK_FILE/pid" 2>/dev/null || echo unrecorded)); a delegated child never skips — cron fails" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
  echo "[$(date)] ⚠️ Scrape already running, skipping this instance" >> "$LOG_FILE"
  exit 0
fi
trap 'rm -rf "$LOCK_FILE"' EXIT
# procStartTime <pid>: the process's start time (normalized `ps -o lstart`),
# empty if it is not running or unreadable. pid + start time identify ONE
# process; a pid alone does not survive pid reuse.
procStartTime() {
  LC_ALL=C ps -o lstart= -p "$1" 2>/dev/null | tr -s ' \t' ' ' | sed 's/^ //; s/ $//'
}
# Record the owner so a later parent can tell an orphaned lock from a live one
# (DIC-1167 pid reuse: the start time too, so a recycled pid is not mistaken
# for the owner).
LOCK_OWNER_START=$(procStartTime "$$")
if ! printf '%s\n' "$$" > "$LOCK_FILE/pid" 2>/dev/null \
  || { [ -n "$LOCK_OWNER_START" ] && ! printf '%s\n' "$LOCK_OWNER_START" > "$LOCK_FILE/start" 2>/dev/null; }; then
  echo "[$(date)] ❌ could not record the lock owner in $LOCK_FILE; cron fails" >> "$LOG_FILE"
  echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
  exit 1
fi

echo "[$(date)] Starting hunterCard local scrape..." >> "$LOG_FILE"

# DIC-1167 (2026-09-29 P0): the daily cron invokes this script through an
# agent terminal whose foreground cap is 600s. The 09-29 run was killed (exit
# 124) inside the yuyu price build with a complete official catalog on disk:
# ~417s went to the official scrape plus the YT stats / news steps before any
# price work, leaving ~180s for a ~410s price build, and a kill emits no
# signature the official-only fallback can act on. The run now carries its
# own wall-clock budget, measured from the FIRST stage (stage 1 exports the
# start so the re-executed stage 2 keeps the same clock), and sizes the yuyu
# stage budget from what is left, so the price stage ends on its own with
# partial prices (DIC-1321 exact-print preservation, unknown prices null)
# instead of the whole run being killed. Raise HUNTERCARD_RUN_BUDGET_SECONDS
# when invoking without that cap (e.g. a background terminal).
nonNegIntOr() { if echo "$1" | grep -qE '^[0-9]+$'; then echo "$1"; else echo "$2"; fi; }
NOW_EPOCH=$(date +%s)
HUNTERCARD_RUN_STARTED_AT=$(nonNegIntOr "${HUNTERCARD_RUN_STARTED_AT:-}" "$NOW_EPOCH")
# A start in the future or more than a day old is a leaked env, not this run.
if [ "$HUNTERCARD_RUN_STARTED_AT" -gt "$NOW_EPOCH" ] || [ $((NOW_EPOCH - HUNTERCARD_RUN_STARTED_AT)) -gt 86400 ]; then
  HUNTERCARD_RUN_STARTED_AT="$NOW_EPOCH"
fi
export HUNTERCARD_RUN_STARTED_AT
RUN_BUDGET_SECONDS=$(nonNegIntOr "${HUNTERCARD_RUN_BUDGET_SECONDS:-}" 540)
# Headroom kept after the price stage for the rest of build-database, the
# signals join, buy-price merge, native generation, gates, commit and push
# (the 09-28 run spent ~55s there).
POST_PRICE_RESERVE_SECONDS=$(nonNegIntOr "${HUNTERCARD_POST_PRICE_RESERVE_SECONDS:-}" 90)
# The YT stats / news signals may run until this many seconds remain.
POST_SIGNALS_RESERVE_SECONDS=$(nonNegIntOr "${HUNTERCARD_POST_SIGNALS_RESERVE_SECONDS:-}" 60)
# After TERM, the signals writers get this long to exit before KILL.
SIGNALS_KILL_GRACE_SECONDS=$(nonNegIntOr "${HUNTERCARD_SIGNALS_KILL_GRACE_SECONDS:-}" 5)

# secondsLeftInRun: seconds until the run budget expires (may be negative).
secondsLeftInRun() {
  echo $(( RUN_BUDGET_SECONDS - ($(date +%s) - HUNTERCARD_RUN_STARTED_AT) ))
}

# Every path this run will mutate (kept in one place so the dirty check, the
# change check and the staging glob all agree).
SCRAPER_MANAGED_PATHS=(
  'data/database.json' 'data/images/' 'data/official/' 'data/series-names.json'
  'data/price-history/' 'data/yt-subscribers/' 'data/yt-stats-history.json'
  'data/news-sentiment/' 'data/trends/' 'data/buy-prices/' 'public/data/database.json'
  'data/price-rejections.json'
  'docs/audits/official-catalog-audit.json' 'docs/audits/official-production-lag-state.json'
)

# DIC-1321 coverage / change-budget floors. A healthy build must keep essentially
# all previously-priced cardNumbers; a draconian drop (yuyu WAF total-collapse,
# or a bug that nulls prices) must FAIL the scheduler so the cron reports
# failure instead of pushing a 0-priced snapshot and printing Done.
#   COVERAGE_FLOOR_RATIO — current priced cardNumbers must be >= this fraction
#     of the previous build's priced cardNumbers, else fail.
#   CHANGE_BUDGET_RATIO — the allowed one-cycle proportional drop in priced
#     cardNumbers. Deliberately generous (>=20%) so genuine market/listing
#     churn never trips it, while a full 0-priced collapse always does.
COVERAGE_FLOOR_RATIO="${HUNTERCARD_COVERAGE_FLOOR_RATIO:-0.50}"
CHANGE_BUDGET_RATIO="${HUNTERCARD_CHANGE_BUDGET_RATIO:-0.20}"
ISOLATED_BRANCH_PREFIX="bot/scrape"

# pricedCardNumberCount <db-file>: count unique priced cardNumbers.
pricedCardNumberCount() {
  node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));const s=new Set();for(const c of Object.values(d.cards||{}))if(Number.isFinite(c.sellPrice)&&c.sellPrice>0)s.add(c.cardNumber);console.log(s.size);" "$1"
}

# DIC-1334: canonical/public/native fixed-point parity. The native asset is
# derived from the canonical by stripping forbidden fields; it must keep the
# SAME set of priced cardNumbers. When a stale or collapsed native artifact
# diverges from canonical, fail closed instead of shipping a divergent pair.
parityOk() {
  local dir="$1"
  local canonical_native_public
  canonical_native_public=$(node -e "
    const fs=require('fs');
    function load(p){return JSON.parse(fs.readFileSync(p,'utf8'));}
    function priced(d){const s=new Set();for(const c of Object.values(d.cards||{}))if(Number.isFinite(c.sellPrice)&&c.sellPrice>0)s.add(c.cardNumber);return s;}
    const canon=load(process.argv[1]); const pub=load(process.argv[2]);
    const a=priced(canon), b=priced(pub);
    const missing=[...a].filter((n)=>!b.has(n));
    if(a.size!==b.size||missing.length>0){process.stdout.write('MISMATCH');process.exit(1);}
    process.stdout.write('OK');process.exit(0);
  " "$dir/data/database.json" "$dir/public/data/database.json" 2>/dev/null)
  if [ "$canonical_native_public" != "OK" ]; then
    echo "[$(date)] ❌ canonical/native parity gate FAILED: priced-cardNumber set diverged between data/database.json and public/data/database.json. Not pushing; cron must fail." >> "$LOG_FILE"
    return 1
  fi
  return 0
}

SELF_SCRIPT_REL='scripts/local-scrape-and-push.sh'

# selfScriptIsCommittedAt <rev>: 0 iff the bytes THIS process started from are
# exactly <rev>'s committed copy of this script. An unresolvable identity on
# either side counts as a mismatch (fail closed).
selfScriptIsCommittedAt() {
  local committed
  committed=$(git rev-parse --verify --quiet "$1:$SELF_SCRIPT_REL" 2>/dev/null || true)
  [ -n "$SELF_SCRIPT_BLOB" ] && [ -n "$committed" ] && [ "$SELF_SCRIPT_BLOB" = "$committed" ]
}

# DIC-1167 (CR bced44d5): matching its own HEAD's committed script does not
# prove a stage-2 process is the ephemeral worktree stage 1 just created — a
# clean but stale resident with a leaked HUNTERCARD_FORCE_ISOLATED_STAGE2=1
# passes that check and would scrape/commit/push from the resident. Stage 1
# therefore attests the worktree it created: a one-time nonce written into
# THAT worktree's private git dir (removed with the worktree), handed to the
# child via HUNTERCARD_STAGE2_NONCE. Stage 2 consumes it before any mutation.
STAGE2_ATTESTATION_NAME='huntercard-stage2-attestation'

# newStage2Nonce: 32 hex chars from /dev/urandom (empty on failure).
newStage2Nonce() {
  od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n'
}

# physDir <dir>: physical (symlink-resolved) path of <dir>, empty if absent.
physDir() {
  [ -n "$1" ] && (cd "$1" 2>/dev/null && pwd -P) || true
}

# clearOrphanChildLock <lock>: run by a parent that holds its own lock, before
# any work (CR 4d3610a7) and again just before it spawns the child that will
# take <lock>. A child lock that still
# exists then is residue of a killed run — unless its recorded owner is still
# alive, in which case another delegated run is in flight: fail closed, never
# steal it. Returns 0 iff <lock> is absent afterwards.
# DIC-1167 (pid reuse): "alive" means the SAME process, not merely a live
# pid — the killed owner's pid may since have been recycled by an unrelated
# long-lived process, which would otherwise keep the orphan (and fail every
# cron) forever. The owner is that process iff its current start time equals
# the one recorded in the lock; a lock without a recorded start time (written
# by an older script) is honoured only while the pid still runs this script.
# An unreadable start time of a live pid cannot be disproved: fail closed.
clearOrphanChildLock() {
  local lock="$1" owner recorded_start live_start live_args reason
  [ -e "$lock" ] || [ -L "$lock" ] || return 0
  owner=$(cat "$lock/pid" 2>/dev/null || true)
  reason="owner pid ${owner:-unrecorded} not running"
  if echo "$owner" | grep -qE '^[0-9]+$' && ps -p "$owner" >/dev/null 2>&1; then
    recorded_start=$(head -n 1 "$lock/start" 2>/dev/null || true)
    live_start=$(procStartTime "$owner")
    if [ -n "$recorded_start" ]; then
      if [ -z "$live_start" ] || [ "$live_start" = "$recorded_start" ]; then
        echo "[$(date)] ❌ child lock $lock is held by live pid $owner (started ${live_start:-unreadable}); refusing to start a second delegated run (cron fails)" >> "$LOG_FILE"
        return 1
      fi
      reason="owner pid $owner was reused: recorded start '$recorded_start', live process started '$live_start'"
    else
      live_args=$(ps -o args= -p "$owner" 2>/dev/null || true)
      if [ -z "$live_args" ] || echo "$live_args" | grep -q 'local-scrape-and-push'; then
        echo "[$(date)] ❌ child lock $lock is held by live pid $owner (no recorded start time; running ${live_args:-unreadable}); refusing to start a second delegated run (cron fails)" >> "$LOG_FILE"
        return 1
      fi
      reason="owner pid $owner was reused: no recorded start time and the live process is not this scraper"
    fi
  fi
  echo "[$(date)] ⚠️ removing orphaned child lock $lock ($reason) left by a killed run" >> "$LOG_FILE"
  rm -rf "$lock" 2>/dev/null || true
  if [ -e "$lock" ] || [ -L "$lock" ]; then
    echo "[$(date)] ❌ could not remove orphaned child lock $lock (cron fails)" >> "$LOG_FILE"
    return 1
  fi
  return 0
}

# Completion receipt (CR cb2b3b13): a parent hands its child a one-time nonce
# and a receipt path inside the parent's OWN lock dir; the child writes
# "<nonce> <detail>" there only on its success path. The parent reports Done
# only when the receipt carries this run's nonce — an exit 0 from a child
# that skipped, or from any premature exit, is a failure.
CHILD_RECEIPT_NAME='child-receipt'

# writeParentReceipt [detail]: on success, acknowledge the parent's request
# (no-op for a top-level run). Returns non-zero if the receipt was requested
# but could not be written.
writeParentReceipt() {
  [ -n "$PARENT_RECEIPT" ] || return 0
  [ -n "$PARENT_RECEIPT_NONCE" ] && printf '%s %s\n' "$PARENT_RECEIPT_NONCE" "${1:-}" > "$PARENT_RECEIPT" 2>/dev/null
}

# finishWithParentReceipt [detail]: write the receipt or fail the run.
finishWithParentReceipt() {
  if ! writeParentReceipt "${1:-}"; then
    echo "[$(date)] ❌ could not write the completion receipt $PARENT_RECEIPT for the parent run; cron fails" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
}

# childReceiptDetail <receipt> <nonce>: print the detail of a receipt that
# carries <nonce>; non-zero if absent or for another run.
childReceiptDetail() {
  local line
  [ -n "$2" ] && [ -f "$1" ] || return 1
  line=$(head -n 1 "$1" 2>/dev/null || true)
  [ "${line%% *}" = "$2" ] || return 1
  case "$line" in *" "*) echo "${line#* }" ;; *) echo "" ;; esac
}

# removeStaleIsolatedWorktree <path>: prune/remove a previously-registered
# throwaway worktree whose checkout directory or gitdir disappeared. A timed-out
# supervised run can leave exactly this state; plain `rm -rf <path>` is not
# enough because `git worktree add <path>` still fails while the stale registration
# remains in .git/worktrees.
removeStaleIsolatedWorktree() {
  local dir="$1"
  git worktree prune >> "$LOG_FILE" 2>&1 || true
  if git worktree list --porcelain | awk 'BEGIN{RS=""} $0 ~ "worktree " path "(\\n|$)" {found=1} END{exit found?0:1}' path="$dir"; then
    echo "[$(date)] ⚠️ removing stale isolated worktree registration at $dir" >> "$LOG_FILE"
    git worktree remove --force "$dir" >> "$LOG_FILE" 2>&1 || true
    git worktree prune >> "$LOG_FILE" 2>&1 || true
  fi
  rm -rf "$dir"
}

# ─── DIC-1472 isolated dependency readiness ────────────────────────────────
# The repository TRACKS a small node_modules shell (four expo-camera build
# files), so a fresh `git worktree add` materialises a node_modules DIRECTORY
# in every throwaway worktree. `-d node_modules` is therefore NOT evidence the
# pipeline's dependencies exist: the directory check passed while Puppeteer /
# cheerio were absent, and the run died mid-pipeline with a misleading
# module-not-found instead of failing closed up front. Readiness is defined by
# REAL anchors the pipeline's fatal path imports (build-database.js requires
# both puppeteer and cheerio); each anchor's package.json must resolve
# (through symlinks) inside the worktree's node_modules.
DEP_ANCHORS=('puppeteer/package.json' 'cheerio/package.json')

# depAnchorsOk <node_modules-dir>: 0 iff every DEP_ANCHORS file exists there.
depAnchorsOk() {
  local nm="$1" anchor
  for anchor in "${DEP_ANCHORS[@]}"; do
    [ -f "$nm/$anchor" ] || return 1
  done
  return 0
}

# ensureIsolatedDeps <isolated-worktree-dir>: make the DISPOSABLE worktree's
# node_modules genuinely satisfy DEP_ANCHORS before any pipeline mutation.
#   - a worktree whose node_modules already satisfies every anchor is kept
#     exactly as checked out (no removal, no symlink);
#   - otherwise the resident $(pwd)/node_modules must satisfy every anchor,
#     the worktree's incomplete shell (tracked stub / dangling link / partial
#     install) is removed — ONLY the disposable worktree's own path, never
#     the resident install — and replaced with an ABSOLUTE symlink to the
#     resident node_modules, then the link target and the final anchors are
#     re-verified.
# Any failure returns non-zero so the caller fails closed BEFORE scraping,
# building, committing or pushing anything. Resident files are never modified.
ensureIsolatedDeps() {
  local iso_dir="$1"
  local resident_nm="$(pwd)/node_modules"
  local iso_nm="$iso_dir/node_modules"
  local anchor resident_phys resolved_phys

  if depAnchorsOk "$iso_nm"; then
    echo "[$(date)] deps: isolated node_modules already satisfies required anchors (${DEP_ANCHORS[*]})" >> "$LOG_FILE"
    return 0
  fi

  for anchor in "${DEP_ANCHORS[@]}"; do
    if [ ! -f "$resident_nm/$anchor" ]; then
      echo "[$(date)] ❌ deps: resident node_modules ($resident_nm) is missing required anchor $anchor; cannot provision isolated worktree" >> "$LOG_FILE"
      return 1
    fi
  done

  resident_phys=$(cd "$resident_nm" 2>/dev/null && pwd -P)
  if [ -z "$resident_phys" ]; then
    echo "[$(date)] ❌ deps: could not resolve resident node_modules physical path" >> "$LOG_FILE"
    return 1
  fi
  # Guard: only ever delete the disposable worktree's own node_modules. If the
  # worktree path aliases the resident install, removing it would destroy
  # resident files — refuse.
  if [ -e "$iso_nm" ] && [ "$iso_nm" -ef "$resident_nm" ]; then
    echo "[$(date)] ❌ deps: isolated node_modules aliases the resident install; refusing to remove it" >> "$LOG_FILE"
    return 1
  fi

  echo "[$(date)] deps: isolated node_modules is an incomplete shell (tracked stub); replacing with absolute symlink to resident install" >> "$LOG_FILE"
  # No trailing slash: if the shell is itself a symlink this removes the link
  # object, never the link target's contents.
  if ! rm -rf "$iso_nm" || [ -e "$iso_nm" ] || [ -L "$iso_nm" ]; then
    echo "[$(date)] ❌ deps: could not remove incomplete node_modules shell at $iso_nm" >> "$LOG_FILE"
    return 1
  fi
  if ! ln -s "$resident_phys" "$iso_nm"; then
    echo "[$(date)] ❌ deps: could not create node_modules symlink in isolated worktree" >> "$LOG_FILE"
    return 1
  fi
  resolved_phys=$(cd "$iso_nm" 2>/dev/null && pwd -P)
  if [ "$resolved_phys" != "$resident_phys" ]; then
    echo "[$(date)] ❌ deps: node_modules symlink resolves to '$resolved_phys' instead of resident install '$resident_phys'; unsafe target, failing closed" >> "$LOG_FILE"
    return 1
  fi
  if ! depAnchorsOk "$iso_nm"; then
    echo "[$(date)] ❌ deps: required anchors still absent after symlinking resident node_modules; failing closed" >> "$LOG_FILE"
    return 1
  fi
  echo "[$(date)] ✅ deps: isolated node_modules -> $resident_phys (read-only reuse, all anchors verified)" >> "$LOG_FILE"
  return 0
}

# priceCoverageOk <repo-dir>: count priced cardNumbers in the freshly built
# data/database.json and compare against the previous build's priced count
# (recorded by runPipeline into <dir>/data/database.json.prev-priced.txt).
# Returns 0 when the build did not clearly collapse coverage, non-zero otherwise.
priceCoverageOk() {
  local dir="$1"
  local db="$dir/data/database.json"
  # The pipeline only reaches the gate after build-database.js "succeeded", so a
  # missing output here means the build produced nothing (a no-op / wrote
  # elsewhere / exited 0 without emitting the db). Treating that as success would
  # let the cron report "Done" on a skipped/empty scrape — DIC-1321 forbids it.
  # Missing output MUST fail, never skip.
  [ -f "$db" ] || { echo "[$(date)] ❌ coverage gate FAILED: build succeeded but produced no data/database.json — missing output must not be treated as success. Not pushing; cron must fail." >> "$LOG_FILE"; return 1; }
  local current prev
  current=$(pricedCardNumberCount "$db")
  prev=$(cat "$dir/data/database.json.prev-priced.txt" 2>/dev/null)
  # If the previous count is unavailable (first run / no prior snapshot) assume ok.
  if ! echo "$prev" | grep -qE '^[0-9]+$'; then
    echo "[$(date)] coverage gate: no previous priced snapshot, skipping (current=$current)" >> "$LOG_FILE"
    return 0
  fi
  if ! echo "$current" | grep -qE '^[0-9]+$'; then
    echo "[$(date)] ❌ coverage gate: could not read current priced count" >> "$LOG_FILE"
    return 1
  fi
  local floor budget floor_bound budget_bound
  floor=$(echo "$prev $COVERAGE_FLOOR_RATIO" | awk '{printf "%.0f", $1*$2}')
  budget=$(echo "$prev $CHANGE_BUDGET_RATIO" | awk '{printf "%.0f", $1*$2}')
  floor_bound=$((prev - budget))
  echo "[$(date)] coverage gate: priced cardNumbers current=$current prev=$prev (floor=$floor, budget-fold=$floor_bound)" >> "$LOG_FILE"
  if [ "$current" -lt "$floor" ]; then
    echo "[$(date)] ❌ coverage gate FAILED: priced cardNumbers dropped to $current (< floor $floor from prev $prev). Not pushing; cron must fail." >> "$LOG_FILE"
    return 1
  fi
  if [ "$current" -lt "$floor_bound" ]; then
    echo "[$(date)] ❌ change-budget gate FAILED: priced cardNumbers dropped $((prev-current)) (> budget $budget). Not pushing; cron must fail." >> "$LOG_FILE"
    return 1
  fi
  return 0
}

# officialCatalogFallback <repo-dir>: when the full yuyu sell-price rebuild fails
# specifically because the DIC-1334 exact-printing anti-collapse audit fired, still
# publish the already-scraped official catalog by preserving known exact-version
# market fields and leaving newly unknown prices null. Other build failures remain
# fail-closed.
officialCatalogFallback() {
  local dir="$1"
  if ! grep -q '\[DIC-1334\] final canonical artifact collapsed priced-cardNumber coverage' "$LOG_FILE"; then
    echo "[$(date)] ❌ build-database failure was not the DIC-1334 price-transform collapse; refusing official-only fallback" >> "$LOG_FILE"
    return 1
  fi

  echo "[$(date)] ⚠️ DIC-1334 price-transform collapse detected; publishing official catalog via exact-preservation/null-price fallback" >> "$LOG_FILE"
  ( cd "$dir"
    if ! node scripts/sync-official-catalog-to-database.mjs >> "$LOG_FILE" 2>&1; then
      echo "[$(date)] ❌ official-only fallback sync FAILED" >> "$LOG_FILE"
      return 1
    fi
    if ! node scripts/regen-buy-alignment.mjs >> "$LOG_FILE" 2>&1; then
      echo "[$(date)] ❌ official-only fallback buy alignment FAILED" >> "$LOG_FILE"
      return 1
    fi
    if ! node scripts/generate-native-database.mjs >> "$LOG_FILE" 2>&1; then
      echo "[$(date)] ❌ official-only fallback native generation FAILED" >> "$LOG_FILE"
      return 1
    fi
    if ! node scripts/test-official-catalog-sync.mjs >> "$LOG_FILE" 2>&1; then
      echo "[$(date)] ❌ official-only fallback catalog sync invariant FAILED" >> "$LOG_FILE"
      return 1
    fi
    if ! node scripts/verify-official-catalog-completeness.mjs >> "$LOG_FILE" 2>&1; then
      echo "[$(date)] ❌ official-only fallback completeness gate FAILED" >> "$LOG_FILE"
      return 1
    fi
  )
}

# joinSignals <signals-pid> <signals-log>: wait for the background YT stats /
# news job started beside build-database, but never past the run budget minus
# POST_SIGNALS_RESERVE_SECONDS. Both steps are non-fatal: an overrun is killed
# and its possibly half-written outputs restored to HEAD so a torn file can
# never be committed. Run from inside the pipeline directory.
#
# The job runs in its own process group (pgid = <signals-pid>), so the kill
# reaches the subshell AND whichever writer it is running (or forking) in one
# signal, and the outputs are restored only once no member of the group is left
# alive — a writer still flushing yt-stats-history.json / news-sentiment after
# the restore would otherwise leave a torn file for the commit (CR 9e78edfc).
# Returns non-zero (fail closed) if the writers cannot be proven stopped.
joinSignals() {
  local pid="$1" log="$2" killed=0 ticks=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$(secondsLeftInRun)" -le "$POST_SIGNALS_RESERVE_SECONDS" ]; then
      if kill -TERM -- "-$pid" 2>/dev/null; then
        killed=1
      elif kill -0 "$pid" 2>/dev/null; then
        # The job is alive but has no process group of its own: its writers
        # cannot be signalled or awaited as a unit, so their outputs cannot
        # be restored safely.
        echo "[$(date)] ❌ YT stats / news sentiment job has no own process group; cannot prove its writers stopped. Not pushing; cron must fail." >> "$LOG_FILE"
        kill -TERM "$pid" 2>/dev/null || true
        cat "$log" >> "$LOG_FILE" 2>/dev/null || true
        rm -f "$log"
        return 1
      fi
      break
    fi
    sleep 1
  done
  if [ "$killed" = "1" ]; then
    # 5 ticks per second: TERM grace, then KILL, then the same again for the
    # KILLed processes (plus 2s) to be gone before giving up.
    while kill -0 -- "-$pid" 2>/dev/null; do
      if [ "$ticks" -ge $(( SIGNALS_KILL_GRACE_SECONDS * 10 + 10 )) ]; then
        echo "[$(date)] ❌ YT stats / news sentiment writers still alive after TERM+KILL; cannot restore their outputs safely. Not pushing; cron must fail." >> "$LOG_FILE"
        return 1
      fi
      if [ "$ticks" -ge $(( SIGNALS_KILL_GRACE_SECONDS * 5 )) ]; then
        kill -KILL -- "-$pid" 2>/dev/null || true
      fi
      sleep 0.2
      ticks=$((ticks + 1))
    done
  fi
  wait "$pid" 2>/dev/null || true
  cat "$log" >> "$LOG_FILE" 2>/dev/null || true
  rm -f "$log"
  if [ "$killed" = "1" ]; then
    echo "[$(date)] ⚠️ YT stats / news sentiment exceeded the run budget; killed, all writers exited, restoring their outputs" >> "$LOG_FILE"
    # Separate pathspecs: one unmatched path would abort the whole checkout.
    # A failing step is only logged here: the postcondition below is the
    # contract, so a path simply absent from HEAD stays harmless while any
    # restore that did not take fails closed (CR 367fad3a).
    git checkout -- data/yt-stats-history.json >> "$LOG_FILE" 2>&1 || echo "[$(date)] ⚠️ restore: git checkout -- data/yt-stats-history.json failed" >> "$LOG_FILE"
    git checkout -- data/news-sentiment >> "$LOG_FILE" 2>&1 || echo "[$(date)] ⚠️ restore: git checkout -- data/news-sentiment failed" >> "$LOG_FILE"
    git clean -fq -- data/yt-stats-history.json data/news-sentiment >> "$LOG_FILE" 2>&1 || echo "[$(date)] ⚠️ restore: git clean -- data/yt-stats-history.json data/news-sentiment failed" >> "$LOG_FILE"
    # The killed job's outputs are staged by the commit step (git add), so they
    # must match HEAD exactly — no modification, no untracked leftover.
    local residue
    if ! residue=$(git status --porcelain --untracked-files=all -- data/yt-stats-history.json data/news-sentiment 2>>"$LOG_FILE"); then
      echo "[$(date)] ❌ could not verify the killed signals outputs were restored (git status failed). Not pushing; cron must fail." >> "$LOG_FILE"
      return 1
    fi
    if [ -n "$residue" ]; then
      echo "[$(date)] ❌ killed signals outputs still differ from HEAD after restore; refusing to commit a possibly torn file. Not pushing; cron must fail:" >> "$LOG_FILE"
      echo "$residue" >> "$LOG_FILE"
      return 1
    fi
    echo "[$(date)] ⚠️ YT stats / news sentiment outputs restored to HEAD (non-fatal)" >> "$LOG_FILE"
  fi
}

# runPipeline <workdir> [ <commit-message> ] [ <push-mode> ]: executes steps 1–3
# (scrape → build → gates → commit → push) inside the given repository working
# directory. Returns non-zero on any failure up to and including the coverage
# gates.
#
#   <push-mode> = inplace (default) | isolated.
#   - inplace  — the resident checkout IS the working main cron path: commit then
#     push HEAD:main, exactly as before.
#   - isolated — the caller runs a throwaway worktree for a dirty-tree handoff.
#     This mode NEVER pushes HEAD:main under any circumstance (mutating main
#     from isolation is forbidden — a dirty resident tree's artifact must go
#     only to an explicit auditable handoff ref). It only COMMITS the artifact;
#     the caller performs the explicit bot/scrape/<date> push and is
#     responsible for failing closed on handoff failure.
runPipeline() {
  local dir="$1"
  local commit_msg="$2"
  local push_mode="${3:-inplace}"
  local prev_priced
  prev_priced=$(node -e "
    const d = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const s = new Set();
    for (const c of Object.values(d.cards || {})) if (Number.isFinite(c.sellPrice) && c.sellPrice > 0) s.add(c.cardNumber);
    console.log(s.size);
  " "$dir/data/database.json" 2>/dev/null || echo "none")
  echo "$prev_priced" > "$dir/data/database.json.prev-priced.txt"

  ( cd "$dir"
    # 1. Check for new official series (fast, ~30s)
    echo "[$(date)] Running official site scraper..." >> "$LOG_FILE"
    node scripts/scrape-official-cards.js >> "$LOG_FILE" 2>&1

    # DIC-1167 (2026-09-29): YT stats + news (~300s of network waits) no longer
    # sit in front of the price build. They run in the background, in their
    # original order (both write data/yt-stats-history.json), beside
    # build-database; joinSignals bounds them, and refresh-yt-stats.mjs then
    # re-merges ytStats from the final history (build-database's own merge may
    # have read the history before today's snapshot landed).
    SIGNALS_LOG=$(mktemp "${TMPDIR:-/tmp}/huntercard-signals.XXXXXX")
    # Job control only for this spawn: the job gets its own process group so
    # joinSignals can kill and await every writer in it (CR 9e78edfc).
    set -m
    (
      echo "[$(date)] Running YT stats snapshot (concurrent with build-database)..."
      node scripts/scrape-yt-stats.js 2>&1 || echo "[$(date)] ⚠️ YT stats snapshot failed (non-fatal)"
      echo "[$(date)] Running news sentiment analysis (concurrent with build-database)..."
      node scripts/scrape-news-sentiment.js 2>&1 || echo "[$(date)] ⚠️ News sentiment analysis failed (non-fatal)"
    ) > "$SIGNALS_LOG" 2>&1 < /dev/null &
    SIGNALS_PID=$!
    set +m

    RUN_LEFT=$(secondsLeftInRun)
    YUYU_STAGE_MS=$(( (RUN_LEFT - POST_PRICE_RESERVE_SECONDS) * 1000 ))
    if [ "$YUYU_STAGE_MS" -lt 1000 ]; then YUYU_STAGE_MS=1000; fi
    YUYU_STAGE_CAP_MS=$(nonNegIntOr "${HUNTERCARD_YUYU_STAGE_BUDGET_MS:-}" 480000)
    if [ "$YUYU_STAGE_CAP_MS" -gt 0 ] && [ "$YUYU_STAGE_CAP_MS" -lt "$YUYU_STAGE_MS" ]; then YUYU_STAGE_MS="$YUYU_STAGE_CAP_MS"; fi
    YUYU_LAUNCH_MS=$(nonNegIntOr "${HUNTERCARD_YUYU_LAUNCH_BUDGET_MS:-}" 45000)
    if [ "$YUYU_LAUNCH_MS" -eq 0 ] || [ "$YUYU_LAUNCH_MS" -gt "$YUYU_STAGE_MS" ]; then YUYU_LAUNCH_MS="$YUYU_STAGE_MS"; fi
    YUYU_ROTATION_SEED=$(nonNegIntOr "${HUNTERCARD_YUYU_ROTATION_SEED:-}" $(( $(date +%s) / 86400 )))
    echo "[$(date)] Running build-database... (DIC-1167 run budget: ${RUN_LEFT}s of ${RUN_BUDGET_SECONDS}s left; yuyu stage ${YUYU_STAGE_MS}ms, launch ${YUYU_LAUNCH_MS}ms, reserve ${POST_PRICE_RESERVE_SECONDS}s, rotation seed ${YUYU_ROTATION_SEED})" >> "$LOG_FILE"
    OFFICIAL_ONLY_FALLBACK=0
    BUILD_OK=1
    if ! HUNTERCARD_YUYU_STAGE_BUDGET_MS="$YUYU_STAGE_MS" \
         HUNTERCARD_YUYU_LAUNCH_BUDGET_MS="$YUYU_LAUNCH_MS" \
         HUNTERCARD_YUYU_ROTATION_SEED="$YUYU_ROTATION_SEED" \
         node scripts/build-database.js >> "$LOG_FILE" 2>&1; then
      BUILD_OK=0
    fi

    if ! joinSignals "$SIGNALS_PID" "$SIGNALS_LOG"; then
      echo "[$(date)] ❌ signals join failed closed, exiting before downstream mutation/commit" >> "$LOG_FILE"
      return 1
    fi

    if [ "$BUILD_OK" != "1" ]; then
      echo "[$(date)] ❌ build-database FAILED" >> "$LOG_FILE"
      if ! officialCatalogFallback "$dir"; then
        echo "[$(date)] ❌ build-database failure could not be recovered by official-only fallback, exiting before downstream mutation/commit" >> "$LOG_FILE"
        return 1
      fi
      OFFICIAL_ONLY_FALLBACK=1
    fi

    if [ "$OFFICIAL_ONLY_FALLBACK" != "1" ]; then
      echo "[$(date)] Re-merging ytStats from the final yt-stats-history.json..." >> "$LOG_FILE"
      node scripts/refresh-yt-stats.mjs >> "$LOG_FILE" 2>&1 || echo "[$(date)] ⚠️ ytStats refresh failed (non-fatal)" >> "$LOG_FILE"

      echo "[$(date)] Running YT subscriber tracker..." >> "$LOG_FILE"
      node scripts/scrape-yt-subscribers.js >> "$LOG_FILE" 2>&1 || echo "[$(date)] ⚠️ YT subscriber tracker failed (non-fatal)" >> "$LOG_FILE"

      echo "[$(date)] Running trend analysis..." >> "$LOG_FILE"
      node scripts/trend-analysis.js >> "$LOG_FILE" 2>&1 || echo "[$(date)] ⚠️ Trend analysis failed (non-fatal)" >> "$LOG_FILE"

      echo "[$(date)] 📣 Sending push alerts..." >> "$LOG_FILE"
      node scripts/send-push-alerts.js >> "$LOG_FILE" 2>&1 || echo "[$(date)] ⚠️ Push alerts failed (non-fatal)" >> "$LOG_FILE"

      echo "[$(date)] 🎯 Evaluating desired-price alerts..." >> "$LOG_FILE"
      npm run --silent send:price-alerts >> "$LOG_FILE" 2>&1 || echo "[$(date)] ⚠️ Price alerts failed (non-fatal)" >> "$LOG_FILE"

      echo "[$(date)] Scraping buy prices into database.json (torecolo + fullahead + merge)..." >> "$LOG_FILE"
      node scripts/scrape-torecolo-buy.js >> "$LOG_FILE" 2>&1 || echo "[$(date)] ⚠️ Torecolo buy scrape failed (non-fatal)" >> "$LOG_FILE"
      node scripts/scrape-fullahead-buy.js >> "$LOG_FILE" 2>&1 || echo "[$(date)] ⚠️ Fullahead buy scrape failed (non-fatal)" >> "$LOG_FILE"
      if ! node scripts/merge-buy-prices.js >> "$LOG_FILE" 2>&1; then
        echo "[$(date)] ❌ merge-buy-prices FAILED, exiting before native generation/commit" >> "$LOG_FILE"
        return 1
      fi

      echo "[$(date)] Running native database generator..." >> "$LOG_FILE"
      if ! node scripts/generate-native-database.mjs >> "$LOG_FILE" 2>&1; then
        echo "[$(date)] ❌ generate-native-database FAILED, exiting" >> "$LOG_FILE"
        return 1
      fi

      # 2i. Required pre-push gate — see original script for DIC-1167 / DIC-1249 context.
      echo "[$(date)] Running required pre-push data gate..." >> "$LOG_FILE"
      if ! node scripts/verify-official-catalog-completeness.mjs >> "$LOG_FILE" 2>&1; then
        echo "[$(date)] ❌ official catalog completeness gate FAILED, exiting before price/browser enrichment and commit/push" >> "$LOG_FILE"
        return 1
      fi

      if ! npm run test:market-fields >> "$LOG_FILE" 2>&1; then
        echo "[$(date)] ❌ test:market-fields FAILED, exiting before commit/push" >> "$LOG_FILE"
        return 1
      fi
      if ! npm run test:buy-price >> "$LOG_FILE" 2>&1; then
        echo "[$(date)] ❌ test:buy-price FAILED, exiting before commit/push" >> "$LOG_FILE"
        return 1
      fi
      if ! npm run test:buy-price-regen >> "$LOG_FILE" 2>&1; then
        echo "[$(date)] ❌ test:buy-price-regen FAILED, exiting before commit/push" >> "$LOG_FILE"
        return 1
      fi
      if ! node scripts/generate-native-database.mjs --check >> "$LOG_FILE" 2>&1; then
        echo "[$(date)] ❌ native database --check FAILED, exiting before commit/push" >> "$LOG_FILE"
        return 1
      fi
    else
      echo "[$(date)] Official-only fallback complete; skipping yuyu/buy-price enrichment and preserving unknown exact-version prices as null" >> "$LOG_FILE"
    fi

    # DIC-1321 hard coverage / change-budget floors. Fail (do not push) if the
    # build collapsed priced coverage below the floors — never ship a 0-priced
    # snapshot or a >budget one-cycle drop.
    if ! priceCoverageOk "$dir"; then
      return 1
    fi

    # DIC-1334: canonical/public/native fixed-point parity. The native asset
    # must carry the EXACT same priced-cardNumber set as the canonical — a
    # collapse or divergence in either must fail closed.
    if ! parityOk "$dir"; then
      return 1
    fi

    # 3. Check if data changed
    GIT_DIFF_FILES=("${SCRAPER_MANAGED_PATHS[@]}")
    if git diff --stat -- "${GIT_DIFF_FILES[@]}" | grep -q .; then
      echo "[$(date)] Data changed, committing and pushing..." >> "$LOG_FILE"
      EXISTING_DATA="data/database.json data/images/ data/official/ data/series-names.json data/price-history/*.json public/data/database.json docs/audits/official-catalog-audit.json docs/audits/official-production-lag-state.json"
      # DIC-1482: the per-print rejection manifest ships with every snapshot so
      # any allowed priced-payload decrease stays auditable in the artifact.
      [ -f data/price-rejections.json ] && EXISTING_DATA="$EXISTING_DATA data/price-rejections.json"
      [ -f data/yt-stats-history.json ] && EXISTING_DATA="$EXISTING_DATA data/yt-stats-history.json"
      for dd in data/yt-subscribers data/news-sentiment data/trends; do
        [ -d "$dd" ] && EXISTING_DATA="$EXISTING_DATA $dd/*.json"
      done
      # shellcheck disable=SC2086
      git add $EXISTING_DATA
      git add data/buy-prices/*.json 2>/dev/null || true
      git -c user.name="hunterCard Scraper" -c user.email="bot@huntercard.app" \
        commit -m "$commit_msg" >> "$LOG_FILE" 2>&1
      # DIC-1321 (Mac-Codex CR DIC-1326): on the ISOLATED path the gathered
      # commit must never be pushed to main from the throwaway worktree. Only an
      # inplace (clean resident) run pushes HEAD:main. The isolated caller
      # performs the explicit auditable bot/scrape/<date> handoff push AFTER this
      # function returns and fails closed if that handoff push fails.
      if [ "$push_mode" = "isolated" ]; then
        echo "[$(date)] (isolated) artifact committed in worktree; push deferred to explicit $ISOLATED_BRANCH_PREFIX/<date> handoff (never HEAD:main)" >> "$LOG_FILE"
      else
        # DIC-1167 (CR 028f6a19): the in-place push is the ONLY publication of
        # this run's artifact, so a rejected push (non-fast-forward, auth,
        # network) must fail the run — never fall back to pushing some other
        # ref and never report "Pushed"/"Done" for an artifact main never got.
        if ! git push origin HEAD:main >> "$LOG_FILE" 2>&1; then
          echo "[$(date)] ❌ git push origin HEAD:main FAILED; artifact not published, cron must fail" >> "$LOG_FILE"
          return 1
        fi
        echo "[$(date)] ✅ Pushed to GitHub" >> "$LOG_FILE"
      fi
    else
      echo "[$(date)] No data changes, skipping push" >> "$LOG_FILE"
    fi
  )
}

# ─── Main dispatch ─────────────────────────────────────────────────────────
# DIC-1167 (CR 4d3610a7): a delegated child (stage 2 / in-place re-exec)
# outlives a parent that was killed (EXIT trap ran, primary lock released)
# and keeps working in its checkout — stage 2 inside the isolated worktree,
# the re-exec in the resident one. A new run must find that out BEFORE it
# touches anything the child may be using: removeStaleIsolatedWorktree used
# to force-remove a live stage 2's worktree, and the in-place fast-forward
# would move the resident under a live re-exec, before the child lock was
# checked just ahead of the spawn. So every child lock is resolved here,
# first: an orphan is cleared, a live owner fails the run with no work done.
for CHILD_LOCK_SUFFIX in stage2 reexec; do
  if ! clearOrphanChildLock "${LOCK_FILE}.${CHILD_LOCK_SUFFIX}"; then
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
done

# DIC-1461: verify AND refresh origin before mutating anything. Both the
# dirty-worktree route and the forced-isolated bootstrap create their isolated
# worktree from REMOTE_HEAD; resolving it from a stale local origin/main cache
# reproduces yesterday's catalog even when GitHub main has already advanced
# (the 2026-09-17 run built detached at the previous day's merge). A failed
# fetch must fail closed BEFORE any official mutation, never fall through to
# the stale ref.
# DIC-1167 (CR 504e8fb5): a plain `git fetch origin main` only moves the
# tracking ref through remote.origin.fetch. With that config missing it writes
# FETCH_HEAD alone, the tracking ref keeps the launcher's (or stage 1's)
# earlier commit, and stage 2's freshness check compares the pinned snapshot
# against that same stale value — a remote advance went undetected. Fetch with
# an explicit force refspec into the fully qualified tracking ref (a local
# tag/branch named origin/main cannot shadow it), then require it to BE the
# commit this fetch returned. Only origin/main is ever accepted.
case "${HUNTERCARD_REMOTE_REF:-origin/main}" in
  origin/main|refs/remotes/origin/main) SCHED_REMOTE_REF='refs/remotes/origin/main' ;;
  *)
    echo "[$(date)] ❌ HUNTERCARD_REMOTE_REF=${HUNTERCARD_REMOTE_REF} is refused: the scheduler only runs the freshly fetched origin/main (cron fails)" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
    ;;
esac
if ! git fetch --write-fetch-head origin "+refs/heads/main:$SCHED_REMOTE_REF" >> "$LOG_FILE" 2>&1; then
  echo "[$(date)] ❌ git fetch origin main failed before scheduler mutation; abandoning (cron fails)" >> "$LOG_FILE"
  echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
  exit 1
fi
FETCHED_HEAD=$(git rev-parse --verify --quiet 'FETCH_HEAD^{commit}' 2>/dev/null || true)
REMOTE_HEAD=$(git rev-parse --verify --quiet "${SCHED_REMOTE_REF}^{commit}" 2>/dev/null || true)
if [ -z "$REMOTE_HEAD" ]; then
  echo "[$(date)] ❌ could not resolve $SCHED_REMOTE_REF after fetch; abandoning (cron fails)" >> "$LOG_FILE"
  echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
  exit 1
fi
if [ "$REMOTE_HEAD" != "$FETCHED_HEAD" ]; then
  echo "[$(date)] ❌ $SCHED_REMOTE_REF ($REMOTE_HEAD) is not the commit this fetch returned (FETCH_HEAD ${FETCHED_HEAD:-unresolved}); abandoning (cron fails)" >> "$LOG_FILE"
  echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
  exit 1
fi

# ─── DIC-1461 / DIC-1167 isolated two-stage bootstrap ──────────────────────
# A long-lived scheduler shell keeps executing the function definitions it
# parsed from the RESIDENT script at startup — fetching or creating a new
# worktree never reloads them. Every isolated run therefore goes through a
# two-stage path whose only trusted resident code is this small bootstrap:
#   Stage 1 (resident code): fetch origin/main (fail-closed, above), create a
#   clean ephemeral worktree at the CURRENT origin SHA, then re-execute THAT
#   worktree's copy of this script — the current origin version, not resident
#   function definitions — as a child process with
#   HUNTERCARD_FORCE_ISOLATED_STAGE2=1.
#   Stage 2 (origin code): prove it is the worktree's committed script,
#   running in stage 1's attested ephemeral worktree at the freshly fetched
#   origin/main (CR bced44d5), run the pipeline in the worktree in ISOLATED
#   push mode — it never pushes HEAD:main and never stages/touches resident
#   files — then perform the explicit auditable bot/scrape/<date> handoff
#   push, failing closed on no-op or push failure.
# Two triggers take this path:
#   - HUNTERCARD_FORCE_ISOLATED=1 (DIC-1461, route "forced");
#   - residue in scraper-managed paths of the resident checkout (DIC-1321,
#     route "dirty"). DIC-1167 (2026-09-30): the dirty route used to run the
#     pipeline IN-PROCESS with the resident's function definitions — the
#     09-30 run built origin/main's data with 225-commit-stale orchestration
#     (no run budget, no fail-closed push). It now re-executes origin's copy
#     exactly like the forced route; the user's dirty files stay untouched.
# Any fetch/worktree/dependency/pipeline/handoff failure exits non-zero and
# stage 1 removes the ephemeral worktree on exit.
if [ "${HUNTERCARD_FORCE_ISOLATED_STAGE2:-}" = "1" ]; then
  # Stage 2: this process IS the clean ephemeral worktree at the current
  # origin SHA (the stage-1 bootstrap re-executed this script from it).
  if [ "${HUNTERCARD_ISOLATION_ROUTE:-}" = "dirty" ]; then
    ROUTE_LABEL="isolated"
    ROUTE_KEEPS="dirty worktree preserved"
  else
    ROUTE_LABEL="forced-isolated"
    ROUTE_KEEPS="resident checkout untouched"
  fi
  STAGE2_START_SHA=$(git rev-parse HEAD 2>/dev/null || true)
  if [ -z "$STAGE2_START_SHA" ]; then
    echo "[$(date)] ❌ $ROUTE_LABEL stage 2: cannot resolve worktree HEAD; cron fails" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
  # DIC-1167: stage 2 exists so that the orchestration is origin's. A stage-2
  # process whose bytes are not its worktree HEAD's committed script (e.g. the
  # flag leaked into a resident invocation) must not run the pipeline.
  if ! selfScriptIsCommittedAt HEAD; then
    echo "[$(date)] ❌ $ROUTE_LABEL stage 2: running script ${SELF_SCRIPT} (blob ${SELF_SCRIPT_BLOB:-unresolved}) is not the committed $SELF_SCRIPT_REL at worktree HEAD $STAGE2_START_SHA; refusing stale orchestration (cron fails)" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
  # DIC-1167 (CR bced44d5): prove this checkout IS stage 1's ephemeral
  # worktree — the attested path, a linked (never a main) working tree, a
  # detached HEAD, and the one-time stage-1 nonce in its private git dir —
  # before anything here can scrape, commit or push.
  STAGE2_TOP=$(physDir "$(git rev-parse --show-toplevel 2>/dev/null || true)")
  STAGE2_EXPECTED_TOP=$(physDir "${HUNTERCARD_STAGE2_WORKTREE:-}")
  STAGE2_GIT_DIR=$(physDir "$(git rev-parse --absolute-git-dir 2>/dev/null || true)")
  STAGE2_COMMON_DIR=$(physDir "$(git rev-parse --git-common-dir 2>/dev/null || true)")
  STAGE2_PROOF_FAIL=""
  if [ -z "$STAGE2_TOP" ] || [ -z "$STAGE2_EXPECTED_TOP" ] || [ "$STAGE2_TOP" != "$STAGE2_EXPECTED_TOP" ]; then
    STAGE2_PROOF_FAIL="checkout ${STAGE2_TOP:-unresolved} is not the stage-1 ephemeral worktree (${HUNTERCARD_STAGE2_WORKTREE:-unset})"
  elif [ -z "$STAGE2_GIT_DIR" ] || [ -z "$STAGE2_COMMON_DIR" ] || [ "$STAGE2_GIT_DIR" = "$STAGE2_COMMON_DIR" ]; then
    STAGE2_PROOF_FAIL="checkout $STAGE2_TOP is a main working tree, not a linked ephemeral worktree"
  elif git symbolic-ref -q HEAD >/dev/null 2>&1; then
    STAGE2_PROOF_FAIL="checkout $STAGE2_TOP has HEAD attached to a branch, not stage 1's detached origin snapshot"
  elif [ -z "${HUNTERCARD_STAGE2_NONCE:-}" ] || [ ! -f "$STAGE2_GIT_DIR/$STAGE2_ATTESTATION_NAME" ] \
    || [ "$(cat "$STAGE2_GIT_DIR/$STAGE2_ATTESTATION_NAME" 2>/dev/null || true)" != "$HUNTERCARD_STAGE2_NONCE" ]; then
    STAGE2_PROOF_FAIL="no matching stage-1 attestation in $STAGE2_GIT_DIR (leaked flag, replayed nonce, or a resident bootstrap that predates attestation — refresh the resident)"
  elif ! rm -f "$STAGE2_GIT_DIR/$STAGE2_ATTESTATION_NAME" || [ -e "$STAGE2_GIT_DIR/$STAGE2_ATTESTATION_NAME" ]; then
    STAGE2_PROOF_FAIL="could not consume the one-time stage-1 attestation in $STAGE2_GIT_DIR"
  fi
  if [ -n "$STAGE2_PROOF_FAIL" ]; then
    echo "[$(date)] ❌ $ROUTE_LABEL stage 2: $STAGE2_PROOF_FAIL; refusing to run the pipeline outside stage 1's isolated worktree (cron fails)" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
  # DIC-1167 (CR bced44d5): the worktree must still be the origin/main this
  # process just fetched (REMOTE_HEAD, above) AND the SHA stage 1 pinned. If
  # origin advanced between the stage-1 and stage-2 fetches, this snapshot's
  # orchestration/data are already stale — fail closed; the next run builds
  # the new head.
  if [ "$STAGE2_START_SHA" != "$REMOTE_HEAD" ] || [ "$STAGE2_START_SHA" != "${HUNTERCARD_STAGE2_EXPECTED_HEAD:-}" ]; then
    echo "[$(date)] ❌ $ROUTE_LABEL stage 2: worktree HEAD $STAGE2_START_SHA is not the freshly fetched origin/main $REMOTE_HEAD (stage 1 pinned ${HUNTERCARD_STAGE2_EXPECTED_HEAD:-unset}); refusing stale orchestration (cron fails)" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
  # DIC-1472: final dependency verification at the point of use — stage 1
  # provisioned this worktree, but THIS (origin) process is the one that will
  # import puppeteer/cheerio; absent anchors here must fail before mutation.
  if ! depAnchorsOk "$(pwd)/node_modules"; then
    echo "[$(date)] ❌ $ROUTE_LABEL stage 2: node_modules anchors (${DEP_ANCHORS[*]}) absent in worktree; failing before pipeline mutation" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
  if ! runPipeline "$(pwd)" "chore: update database $(date +%Y-%m-%d) ($ROUTE_LABEL)" isolated; then
    echo "[$(date)] ❌ $ROUTE_LABEL pipeline failed — cron reports failure" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
  ISOLATED_BRANCH="${ISOLATED_BRANCH_PREFIX}/$(date +%Y-%m-%d)"
  STAGE2_END_SHA=$(git rev-parse HEAD 2>/dev/null || true)
  if [ -z "$STAGE2_END_SHA" ]; then
    echo "[$(date)] ❌ $ROUTE_LABEL handoff: no commit at all in worktree HEAD; cron fails" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
  # DIC-1321 (Mac-Codex CR DIC-1328): pushing the unchanged origin/main
  # baseline to bot/scrape/<date> is NOT a valid handoff.
  if [ "$STAGE2_START_SHA" = "$STAGE2_END_SHA" ]; then
    echo "[$(date)] ❌ $ROUTE_LABEL handoff: pipeline was a no-op (HEAD unchanged at $STAGE2_END_SHA); cron fails — must never push unchanged baseline" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
  # Fully-qualified dst ref: the worktree HEAD is detached, and git refuses
  # to guess an unqualified destination for a commit-object <src> when the
  # remote branch does not exist yet (proven by the DIC-1461 real-git
  # forced-isolated dry-run). DIC-1321 (Mac-Codex CR DIC-1326): a failed
  # handoff push must never end in "Done"/exit 0.
  if ! git push origin "HEAD:refs/heads/$ISOLATED_BRANCH" >> "$LOG_FILE" 2>&1; then
    echo "[$(date)] ❌ $ROUTE_LABEL artifact handoff push to $ISOLATED_BRANCH FAILED; cron fails (never success on failed handoff)" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
  echo "[$(date)] ✅ ${ROUTE_LABEL} artifact pushed to $ISOLATED_BRANCH ($ROUTE_KEEPS)" >> "$LOG_FILE"
  finishWithParentReceipt "$STAGE2_END_SHA"
  echo "[$(date)] ✅ Done ($ROUTE_LABEL handoff)" >> "$LOG_FILE"
  exit 0
fi

# Dirty-worktree check. When the resident checkout is dirty in a
# scraper-managed path we never pull/mutate/stage over the residue (DIC-1219)
# and never deadlock (DIC-1321): the run takes the isolated bootstrap below.
DIRTY_STATUS=$(git status --porcelain --ignore-submodules -- "${SCRAPER_MANAGED_PATHS[@]}" 2>/dev/null || true)
ISOLATION_ROUTE=""
if [ "${HUNTERCARD_FORCE_ISOLATED:-}" = "1" ]; then
  ISOLATION_ROUTE="forced"
  echo "[$(date)] ⚙️ HUNTERCARD_FORCE_ISOLATED=1 — bootstrapping clean ephemeral worktree at current origin/main ($REMOTE_HEAD)" >> "$LOG_FILE"
elif [ -n "$DIRTY_STATUS" ]; then
  ISOLATION_ROUTE="dirty"
  echo "[$(date)] ⚠️ Worktree has residue in scraper-managed paths; switching to isolated clean-worktree handoff (DIC-1321) — bootstrapping origin/main ($REMOTE_HEAD)'s script in a clean ephemeral worktree." >> "$LOG_FILE"
  echo "$DIRTY_STATUS" >> "$LOG_FILE"
fi

if [ -n "$ISOLATION_ROUTE" ]; then
  if [ "$ISOLATION_ROUTE" = "dirty" ]; then STAGE1_LABEL="isolated"; else STAGE1_LABEL="forced-isolated"; fi
  ISOLATED_DIR="${HUNTERCARD_ISOLATED_DIR:-/tmp/huntercard-scrape-worktree}"
  removeStaleIsolatedWorktree "$ISOLATED_DIR"
  # A throwaway worktree pinned to the current remote HEAD gives a clean,
  # committed baseline the scheduler is allowed to mutate. Never touches the
  # resident checkout.
  if ! git worktree add --detach "$ISOLATED_DIR" "$REMOTE_HEAD" >> "$LOG_FILE" 2>&1; then
    echo "[$(date)] ⚠️ isolated worktree add failed once; pruning stale registrations and retrying" >> "$LOG_FILE"
    removeStaleIsolatedWorktree "$ISOLATED_DIR"
    if ! git worktree add --detach "$ISOLATED_DIR" "$REMOTE_HEAD" >> "$LOG_FILE" 2>&1; then
      echo "[$(date)] ❌ could not create $STAGE1_LABEL worktree; abandoning (cron fails)" >> "$LOG_FILE"
      echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
      exit 1
    fi
  fi
  trap 'git worktree remove --force "$ISOLATED_DIR" >> "$LOG_FILE" 2>&1 || true; rm -rf "$LOCK_FILE"' EXIT
  # DIC-1472: dependencies. The tracked node_modules shell makes a bare `-d`
  # check pass while every real dependency is absent; provision via the
  # anchor contract (verify → replace shell with absolute resident symlink →
  # re-verify), failing closed BEFORE any pipeline mutation.
  if ! ensureIsolatedDeps "$ISOLATED_DIR"; then
    echo "[$(date)] ❌ $STAGE1_LABEL worktree dependencies could not be provisioned; abandoning (cron fails)" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
  # The origin version we are about to execute must actually support the
  # stage-2 contract; an older origin script would fall through to its
  # in-place path and push HEAD:main from the worktree. Refuse instead.
  if ! grep -q "HUNTERCARD_FORCE_ISOLATED_STAGE2" "$ISOLATED_DIR/scripts/local-scrape-and-push.sh" 2>/dev/null; then
    echo "[$(date)] ❌ origin script at $REMOTE_HEAD does not support forced-isolated stage 2; refusing to bootstrap (cron fails)" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
  if ! selfScriptIsCommittedAt "$REMOTE_HEAD"; then
    echo "[$(date)] ⚠️ resident script ${SELF_SCRIPT} (blob ${SELF_SCRIPT_BLOB:-unresolved}) differs from origin/main ($REMOTE_HEAD); only this bootstrap runs from it — the pipeline runs origin's copy" >> "$LOG_FILE"
  fi
  # DIC-1167 (CR bced44d5): attest the worktree just created — a one-time
  # nonce in ITS private git dir — so stage 2 can prove where it runs.
  ISOLATED_GIT_DIR=$(cd "$ISOLATED_DIR" && git rev-parse --absolute-git-dir 2>/dev/null || true)
  STAGE2_NONCE=$(newStage2Nonce || true)
  if [ -z "$ISOLATED_GIT_DIR" ] || [ "${#STAGE2_NONCE}" -ne 32 ] \
    || ! (umask 077 && printf '%s\n' "$STAGE2_NONCE" > "$ISOLATED_GIT_DIR/$STAGE2_ATTESTATION_NAME") 2>/dev/null; then
    echo "[$(date)] ❌ could not attest the $STAGE1_LABEL worktree for stage 2 (git dir ${ISOLATED_GIT_DIR:-unresolved}); abandoning (cron fails)" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
  # Re-execute the ORIGIN version of this script inside the clean worktree.
  # A distinct stage-2 lock: this stage-1 process still holds the primary
  # cron lock, so the child must not collide with it. CR cb2b3b13: clear a
  # killed run's orphaned stage-2 lock first, and require the child's
  # completion receipt — stage 2's exit status alone never proves a handoff.
  if ! clearOrphanChildLock "${LOCK_FILE}.stage2"; then
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
  STAGE2_RECEIPT="$LOCK_FILE/$CHILD_RECEIPT_NAME"
  STAGE2_RECEIPT_NONCE=$(newStage2Nonce || true)
  rm -f "$STAGE2_RECEIPT"
  if [ "${#STAGE2_RECEIPT_NONCE}" -ne 32 ] || [ -e "$STAGE2_RECEIPT" ]; then
    echo "[$(date)] ❌ could not prepare the $STAGE1_LABEL stage-2 completion receipt; abandoning (cron fails)" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
  if ! HUNTERCARD_FORCE_ISOLATED_STAGE2=1 HUNTERCARD_ISOLATION_ROUTE="$ISOLATION_ROUTE" \
    HUNTERCARD_STAGE2_WORKTREE="$ISOLATED_DIR" HUNTERCARD_STAGE2_EXPECTED_HEAD="$REMOTE_HEAD" \
    HUNTERCARD_STAGE2_NONCE="$STAGE2_NONCE" \
    HUNTERCARD_LOCK_FILE="${LOCK_FILE}.stage2" \
    HUNTERCARD_CHILD_RECEIPT="$STAGE2_RECEIPT" HUNTERCARD_CHILD_RECEIPT_NONCE="$STAGE2_RECEIPT_NONCE" \
    bash "$ISOLATED_DIR/scripts/local-scrape-and-push.sh"; then
    echo "[$(date)] ❌ $STAGE1_LABEL stage 2 failed — cron reports failure" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
  # The receipt must name the handoff commit stage 2 left in THIS worktree,
  # and that commit must be new on top of the pinned origin/main.
  STAGE2_HANDOFF_SHA=$(childReceiptDetail "$STAGE2_RECEIPT" "$STAGE2_RECEIPT_NONCE" || true)
  STAGE2_WORKTREE_SHA=$(cd "$ISOLATED_DIR" 2>/dev/null && git rev-parse --verify HEAD 2>/dev/null || true)
  if [ -z "$STAGE2_HANDOFF_SHA" ] || [ "$STAGE2_HANDOFF_SHA" != "$STAGE2_WORKTREE_SHA" ] || [ "$STAGE2_HANDOFF_SHA" = "$REMOTE_HEAD" ]; then
    echo "[$(date)] ❌ $STAGE1_LABEL stage 2 exited 0 without this run's completion receipt (receipt ${STAGE2_HANDOFF_SHA:-absent}, worktree HEAD ${STAGE2_WORKTREE_SHA:-unresolved}, origin $REMOTE_HEAD); never Done on a bare exit status (cron fails)" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
  echo "[$(date)] ✅ $STAGE1_LABEL stage 2 receipt verified (handoff $STAGE2_HANDOFF_SHA)" >> "$LOG_FILE"
  finishWithParentReceipt "$STAGE2_HANDOFF_SHA"
  echo "[$(date)] ✅ Done ($STAGE1_LABEL bootstrap)" >> "$LOG_FILE"
  exit 0
fi

# In-place clean path.
# DIC-1167 (CR 028f6a19): the in-place run builds from, commits on and pushes
# HEAD:main from the resident HEAD, so that HEAD must BE the freshly fetched
# origin/main. A failed --ff-only (diverged history, remote unreachable) used
# to be logged as "non-fatal" and the stale/diverged HEAD was scraped, built,
# pushed and reported "Done". Both a failed fast-forward and a resident HEAD
# that still differs from origin/main afterwards (e.g. unpushed local commits,
# which --ff-only reports as "Already up to date") must fail closed BEFORE any
# official mutation.
if ! git pull --ff-only origin main >> "$LOG_FILE" 2>&1; then
  echo "[$(date)] ❌ git pull --ff-only origin main failed on the clean resident checkout; refusing to build/push from a stale or diverged HEAD (cron fails)" >> "$LOG_FILE"
  echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
  exit 1
fi
INPLACE_HEAD=$(git rev-parse --verify HEAD 2>/dev/null || true)
INPLACE_ORIGIN=$(git rev-parse --verify origin/main 2>/dev/null || true)
if [ -z "$INPLACE_HEAD" ] || [ -z "$INPLACE_ORIGIN" ] || [ "$INPLACE_HEAD" != "$INPLACE_ORIGIN" ]; then
  echo "[$(date)] ❌ resident HEAD (${INPLACE_HEAD:-unresolved}) is not the fetched origin/main (${INPLACE_ORIGIN:-unresolved}) after fast-forward; refusing in-place build/push (cron fails)" >> "$LOG_FILE"
  echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
  exit 1
fi
# DIC-1167 (2026-09-30): the fast-forward above may have just replaced this
# script on disk, but this process keeps running the function definitions it
# parsed before the pull. The in-place pipeline must run origin/main's
# committed orchestration:
#   - running bytes == committed copy at HEAD → proceed;
#   - otherwise, if the on-disk copy IS the committed one (the pull updated
#     it), re-execute it once as a child (own lock; this process still holds
#     the primary cron lock) and propagate its result;
#   - otherwise (a locally modified copy, or a re-executed child that still
#     differs) fail closed before any official mutation.
if ! selfScriptIsCommittedAt HEAD; then
  DISK_SCRIPT_BLOB=$(git hash-object --no-filters "$SELF_SCRIPT_REL" 2>/dev/null || true)
  COMMITTED_SCRIPT_BLOB=$(git rev-parse --verify --quiet "HEAD:$SELF_SCRIPT_REL" 2>/dev/null || true)
  if [ "${HUNTERCARD_SELF_REEXEC:-}" = "1" ] || [ -z "$COMMITTED_SCRIPT_BLOB" ] || [ "$DISK_SCRIPT_BLOB" != "$COMMITTED_SCRIPT_BLOB" ]; then
    echo "[$(date)] ❌ running script ${SELF_SCRIPT} (blob ${SELF_SCRIPT_BLOB:-unresolved}) is not origin/main's committed $SELF_SCRIPT_REL (blob ${COMMITTED_SCRIPT_BLOB:-unresolved}, on-disk ${DISK_SCRIPT_BLOB:-unresolved}); refusing in-place build/push with stale or locally modified orchestration (cron fails)" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
  echo "[$(date)] ⚙️ fast-forward updated $SELF_SCRIPT_REL (running blob ${SELF_SCRIPT_BLOB:-unresolved} → committed $COMMITTED_SCRIPT_BLOB); re-executing origin/main's copy" >> "$LOG_FILE"
  # CR cb2b3b13: same child contract as stage 2 — orphaned lock cleared,
  # success only on this run's completion receipt.
  if ! clearOrphanChildLock "${LOCK_FILE}.reexec"; then
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
  REEXEC_RECEIPT="$LOCK_FILE/$CHILD_RECEIPT_NAME"
  REEXEC_RECEIPT_NONCE=$(newStage2Nonce || true)
  rm -f "$REEXEC_RECEIPT"
  if [ "${#REEXEC_RECEIPT_NONCE}" -ne 32 ] || [ -e "$REEXEC_RECEIPT" ]; then
    echo "[$(date)] ❌ could not prepare the re-exec completion receipt; refusing in-place build/push (cron fails)" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
  if ! HUNTERCARD_SELF_REEXEC=1 HUNTERCARD_LOCK_FILE="${LOCK_FILE}.reexec" \
    HUNTERCARD_CHILD_RECEIPT="$REEXEC_RECEIPT" HUNTERCARD_CHILD_RECEIPT_NONCE="$REEXEC_RECEIPT_NONCE" \
    bash "$(pwd)/$SELF_SCRIPT_REL"; then
    echo "[$(date)] ❌ re-executed origin/main script failed — cron reports failure" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
  if ! REEXEC_DETAIL=$(childReceiptDetail "$REEXEC_RECEIPT" "$REEXEC_RECEIPT_NONCE"); then
    echo "[$(date)] ❌ re-executed origin/main script exited 0 without this run's completion receipt; never Done on a bare exit status (cron fails)" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
  finishWithParentReceipt "$REEXEC_DETAIL"
  exit 0
fi
if ! runPipeline "$(pwd)" "chore: update database $(date +%Y-%m-%d)"; then
  echo "[$(date)] ❌ pipeline failed — cron reports failure" >> "$LOG_FILE"
  echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
  exit 1
fi

finishWithParentReceipt "$(git rev-parse --verify HEAD 2>/dev/null || true)"
echo "[$(date)] ✅ Done" >> "$LOG_FILE"
