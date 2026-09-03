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
cd "$(dirname "$0")/.."
# Overridable so the pipeline regression can run hermetically without contending
# with (or clearing) the real cron lock.
LOCK_FILE="${HUNTERCARD_LOCK_FILE:-/tmp/huntercard-scrape.lock}"
LOG_FILE="$HOME/.hermes/logs/huntercard-scrape-$(date +%Y%m%d).log"
mkdir -p "$(dirname "$LOG_FILE")"

# Prevent concurrent execution
if ! mkdir "$LOCK_FILE" 2>/dev/null; then
  echo "[$(date)] ⚠️ Scrape already running, skipping this instance" >> "$LOG_FILE"
  exit 0
fi
trap 'rm -rf "$LOCK_FILE"' EXIT

echo "[$(date)] Starting hunterCard local scrape..." >> "$LOG_FILE"

# Every path this run will mutate (kept in one place so the dirty check, the
# change check and the staging glob all agree).
SCRAPER_MANAGED_PATHS=(
  'data/database.json' 'data/images/' 'data/official/' 'data/series-names.json'
  'data/price-history/' 'data/yt-subscribers/' 'data/yt-stats-history.json'
  'data/news-sentiment/' 'data/trends/' 'data/buy-prices/' 'public/data/database.json'
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

    echo "[$(date)] Running YT stats snapshot..." >> "$LOG_FILE"
    node scripts/scrape-yt-stats.js >> "$LOG_FILE" 2>&1 || echo "[$(date)] ⚠️ YT stats snapshot failed (non-fatal)" >> "$LOG_FILE"

    echo "[$(date)] Running news sentiment analysis..." >> "$LOG_FILE"
    node scripts/scrape-news-sentiment.js >> "$LOG_FILE" 2>&1 || echo "[$(date)] ⚠️ News sentiment analysis failed (non-fatal)" >> "$LOG_FILE"

    echo "[$(date)] Running build-database..." >> "$LOG_FILE"
    if ! node scripts/build-database.js >> "$LOG_FILE" 2>&1; then
      echo "[$(date)] ❌ build-database FAILED, exiting before downstream mutation/commit" >> "$LOG_FILE"
      return 1
    fi

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

    # DIC-1321 hard coverage / change-budget floors. Fail (do not push) if the
    # build collapsed priced coverage below the floors — never ship a 0-priced
    # snapshot or a >budget one-cycle drop.
    if ! priceCoverageOk "$dir"; then
      return 1
    fi

    # 3. Check if data changed
    GIT_DIFF_FILES=("${SCRAPER_MANAGED_PATHS[@]}")
    if git diff --stat -- "${GIT_DIFF_FILES[@]}" | grep -q .; then
      echo "[$(date)] Data changed, committing and pushing..." >> "$LOG_FILE"
      EXISTING_DATA="data/database.json data/images/ data/official/ data/series-names.json data/price-history/*.json public/data/database.json docs/audits/official-catalog-audit.json docs/audits/official-production-lag-state.json"
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
        git push origin HEAD:main >> "$LOG_FILE" 2>&1 || git push origin HEAD >> "$LOG_FILE" 2>&1
        echo "[$(date)] ✅ Pushed to GitHub" >> "$LOG_FILE"
      fi
    else
      echo "[$(date)] No data changes, skipping push" >> "$LOG_FILE"
    fi
  )
}

# ─── Main dispatch ─────────────────────────────────────────────────────────
# Verify we can reach origin before mutating anything.
REMOTE_HEAD=$(git rev-parse --verify "${HUNTERCARD_REMOTE_REF:-origin/main}" 2>/dev/null || true)

# 0. Dirty-worktree check (in-place). When the resident checkout is dirty in a
#    scraper-managed path we NO LONGER permanently deadlock: we route to an
#    isolated throwaway worktree pinned to origin/main and keep the user's
#    dirty files untouched. DIC-1219's fail-closed intent is preserved for the
#    in-place path (we never pull/mutate/stage over residue).
DIRTY_STATUS=$(git status --porcelain --ignore-submodules -- "${SCRAPER_MANAGED_PATHS[@]}" 2>/dev/null || true)
if [ -n "$DIRTY_STATUS" ]; then
  echo "[$(date)] ⚠️ Worktree has residue in scraper-managed paths; switching to isolated clean-worktree handoff (DIC-1321)." >> "$LOG_FILE"
  echo "$DIRTY_STATUS" >> "$LOG_FILE"

  ISOLATED_DIR="${HUNTERCARD_ISOLATED_DIR:-/tmp/huntercard-scrape-worktree}"
  rm -rf "$ISOLATED_DIR"
  # A throwaway worktree pinned to the current remote HEAD gives a clean,
  # committed baseline the scheduler is allowed to mutate. Never touches the
  # resident checkout.
  if ! git worktree add --detach "$ISOLATED_DIR" "$REMOTE_HEAD" >> "$LOG_FILE" 2>&1; then
    echo "[$(date)] ❌ could not create isolated worktree; abandoning (cron fails)" >> "$LOG_FILE"
    exit 1
  fi
  # Ensure node_modules available in the isolated tree (scripts need deps).
  if [ ! -d "$ISOLATED_DIR/node_modules" ] && [ -d "$(pwd)/node_modules" ]; then
    ln -s "$(pwd)/node_modules" "$ISOLATED_DIR/node_modules" 2>/dev/null || true
  fi
  trap 'git worktree remove --force "$ISOLATED_DIR" >> "$LOG_FILE" 2>&1 || true; rm -rf "$LOCK_FILE"' EXIT

  # DIC-1321 (Mac-Codex CR DIC-1328): record the starting SHA so we can detect
  # a no-op pipeline that created no new artifact commit. Pushing the unchanged
  # origin/main baseline to bot/scrape/<date> is NOT a valid handoff.
  ISOLATED_START_SHA=$(git -C "$ISOLATED_DIR" rev-parse HEAD)

  if ! runPipeline "$ISOLATED_DIR" "chore: update database $(date +%Y-%m-%d) (isolated)" isolated; then
    echo "[$(date)] ❌ isolated pipeline failed — sending alert, cron reports failure" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi

  # Push the isolated artifact to a dedicated auditable branch (never main) as
  # the handoff; the user keeps their dirty files. A separate reviewer/PR path
  # merges it after checks. The isolated worktree commits on a detached HEAD.
  # DIC-1321 (Mac-Codex CR DIC-1326): this handoff must FAIL CLOSED — a push or
  # a missing artifact commit must never end in "Done"/exit 0.
  ISOLATED_BRANCH="${ISOLATED_BRANCH_PREFIX}/$(date +%Y-%m-%d)"
  ISOLATED_END_SHA=$(git -C "$ISOLATED_DIR" rev-parse HEAD 2>/dev/null || true)
  if [ -z "$ISOLATED_END_SHA" ]; then
    echo "[$(date)] ❌ isolated handoff: no commit at all in worktree HEAD; cron fails" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
  if [ "$ISOLATED_START_SHA" = "$ISOLATED_END_SHA" ]; then
    echo "[$(date)] ❌ isolated handoff: pipeline was a no-op (HEAD unchanged at $ISOLATED_END_SHA); cron fails — must never push unchanged baseline" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
  if ! git -C "$ISOLATED_DIR" push origin "HEAD:$ISOLATED_BRANCH" >> "$LOG_FILE" 2>&1; then
    echo "[$(date)] ❌ isolated artifact handoff push to $ISOLATED_BRANCH FAILED; cron fails (never success on failed handoff)" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
  echo "[$(date)] ✅ Isolated artifact pushed to $ISOLATED_BRANCH (dirty worktree preserved)" >> "$LOG_FILE"
  echo "[$(date)] ✅ Done (isolated handoff)" >> "$LOG_FILE"
  exit 0
fi

# In-place clean path.
git pull --ff-only origin main >> "$LOG_FILE" 2>&1 || echo "[$(date)] ⚠️ git pull failed (non-fatal); continuing with current HEAD" >> "$LOG_FILE"
if ! runPipeline "$(pwd)" "chore: update database $(date +%Y-%m-%d)"; then
  echo "[$(date)] ❌ pipeline failed — cron reports failure" >> "$LOG_FILE"
  echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
  exit 1
fi

echo "[$(date)] ✅ Done" >> "$LOG_FILE"
