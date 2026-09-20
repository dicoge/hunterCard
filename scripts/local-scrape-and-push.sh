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
    OFFICIAL_ONLY_FALLBACK=0
    if ! node scripts/build-database.js >> "$LOG_FILE" 2>&1; then
      echo "[$(date)] ❌ build-database FAILED" >> "$LOG_FILE"
      if ! officialCatalogFallback "$dir"; then
        echo "[$(date)] ❌ build-database failure could not be recovered by official-only fallback, exiting before downstream mutation/commit" >> "$LOG_FILE"
        return 1
      fi
      OFFICIAL_ONLY_FALLBACK=1
    fi

    if [ "$OFFICIAL_ONLY_FALLBACK" != "1" ]; then
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
        git push origin HEAD:main >> "$LOG_FILE" 2>&1 || git push origin HEAD >> "$LOG_FILE" 2>&1
        echo "[$(date)] ✅ Pushed to GitHub" >> "$LOG_FILE"
      fi
    else
      echo "[$(date)] No data changes, skipping push" >> "$LOG_FILE"
    fi
  )
}

# ─── Main dispatch ─────────────────────────────────────────────────────────
# DIC-1461: verify AND refresh origin before mutating anything. Both the
# dirty-worktree route and the forced-isolated bootstrap create their isolated
# worktree from REMOTE_HEAD; resolving it from a stale local origin/main cache
# reproduces yesterday's catalog even when GitHub main has already advanced
# (the 2026-09-17 run built detached at the previous day's merge). A failed
# fetch must fail closed BEFORE any official mutation, never fall through to
# the stale ref.
if ! git fetch origin main >> "$LOG_FILE" 2>&1; then
  echo "[$(date)] ❌ git fetch origin main failed before scheduler mutation; abandoning (cron fails)" >> "$LOG_FILE"
  echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
  exit 1
fi
REMOTE_HEAD=$(git rev-parse --verify "${HUNTERCARD_REMOTE_REF:-origin/main}" 2>/dev/null || true)
if [ -z "$REMOTE_HEAD" ]; then
  echo "[$(date)] ❌ could not resolve ${HUNTERCARD_REMOTE_REF:-origin/main} after fetch; abandoning (cron fails)" >> "$LOG_FILE"
  echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
  exit 1
fi

# ─── DIC-1461 forced-isolated scheduler bootstrap ──────────────────────────
# A long-lived scheduler shell keeps executing the function definitions it
# parsed from the RESIDENT script at startup — fetching or creating a new
# worktree never reloads them. HUNTERCARD_FORCE_ISOLATED=1 gives a scheduler a
# supported two-stage path whose only trusted resident code is this small
# bootstrap block:
#   Stage 1 (resident code, HUNTERCARD_FORCE_ISOLATED=1): fetch origin/main
#   (fail-closed, above), create a clean ephemeral worktree at the CURRENT
#   origin SHA, then re-execute THAT worktree's copy of this script — the
#   current origin version, not resident function definitions — as a child
#   process with HUNTERCARD_FORCE_ISOLATED_STAGE2=1.
#   Stage 2 (origin code, HUNTERCARD_FORCE_ISOLATED_STAGE2=1): run the
#   pipeline in the worktree in ISOLATED push mode — it never pushes
#   HEAD:main and never stages/touches resident files — then perform the
#   explicit auditable bot/scrape/<date> handoff push, failing closed on
#   no-op or push failure exactly like the dirty-worktree route.
# Any fetch/worktree/dependency/pipeline/handoff failure exits non-zero and
# stage 1 removes the ephemeral worktree on exit.
if [ "${HUNTERCARD_FORCE_ISOLATED_STAGE2:-}" = "1" ]; then
  # Stage 2: this process IS the clean ephemeral worktree at the current
  # origin SHA (the stage-1 bootstrap re-executed this script from it).
  STAGE2_START_SHA=$(git rev-parse HEAD 2>/dev/null || true)
  if [ -z "$STAGE2_START_SHA" ]; then
    echo "[$(date)] ❌ forced-isolated stage 2: cannot resolve worktree HEAD; cron fails" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
  # DIC-1472: final dependency verification at the point of use — stage 1
  # provisioned this worktree, but THIS (origin) process is the one that will
  # import puppeteer/cheerio; absent anchors here must fail before mutation.
  if ! depAnchorsOk "$(pwd)/node_modules"; then
    echo "[$(date)] ❌ forced-isolated stage 2: node_modules anchors (${DEP_ANCHORS[*]}) absent in worktree; failing before pipeline mutation" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
  if ! runPipeline "$(pwd)" "chore: update database $(date +%Y-%m-%d) (forced-isolated)" isolated; then
    echo "[$(date)] ❌ forced-isolated pipeline failed — cron reports failure" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
  ISOLATED_BRANCH="${ISOLATED_BRANCH_PREFIX}/$(date +%Y-%m-%d)"
  STAGE2_END_SHA=$(git rev-parse HEAD 2>/dev/null || true)
  if [ -z "$STAGE2_END_SHA" ]; then
    echo "[$(date)] ❌ forced-isolated handoff: no commit at all in worktree HEAD; cron fails" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
  if [ "$STAGE2_START_SHA" = "$STAGE2_END_SHA" ]; then
    echo "[$(date)] ❌ forced-isolated handoff: pipeline was a no-op (HEAD unchanged at $STAGE2_END_SHA); cron fails — must never push unchanged baseline" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
  # Fully-qualified dst ref: the worktree HEAD is detached, and git refuses
  # to guess an unqualified destination for a commit-object <src> when the
  # remote branch does not exist yet (proven by the DIC-1461 real-git
  # forced-isolated dry-run).
  if ! git push origin "HEAD:refs/heads/$ISOLATED_BRANCH" >> "$LOG_FILE" 2>&1; then
    echo "[$(date)] ❌ forced-isolated artifact handoff push to $ISOLATED_BRANCH FAILED; cron fails (never success on failed handoff)" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
  echo "[$(date)] ✅ Forced-isolated artifact pushed to $ISOLATED_BRANCH (resident checkout untouched)" >> "$LOG_FILE"
  echo "[$(date)] ✅ Done (forced-isolated handoff)" >> "$LOG_FILE"
  exit 0
fi

if [ "${HUNTERCARD_FORCE_ISOLATED:-}" = "1" ]; then
  echo "[$(date)] ⚙️ HUNTERCARD_FORCE_ISOLATED=1 — bootstrapping clean ephemeral worktree at current origin/main ($REMOTE_HEAD)" >> "$LOG_FILE"
  ISOLATED_DIR="${HUNTERCARD_ISOLATED_DIR:-/tmp/huntercard-scrape-worktree}"
  removeStaleIsolatedWorktree "$ISOLATED_DIR"
  if ! git worktree add --detach "$ISOLATED_DIR" "$REMOTE_HEAD" >> "$LOG_FILE" 2>&1; then
    echo "[$(date)] ⚠️ isolated worktree add failed once; pruning stale registrations and retrying" >> "$LOG_FILE"
    removeStaleIsolatedWorktree "$ISOLATED_DIR"
    if ! git worktree add --detach "$ISOLATED_DIR" "$REMOTE_HEAD" >> "$LOG_FILE" 2>&1; then
      echo "[$(date)] ❌ could not create forced-isolated worktree; abandoning (cron fails)" >> "$LOG_FILE"
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
    echo "[$(date)] ❌ forced-isolated worktree dependencies could not be provisioned; abandoning (cron fails)" >> "$LOG_FILE"
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
  # Re-execute the ORIGIN version of this script inside the clean worktree.
  # A distinct stage-2 lock: this stage-1 process still holds the primary
  # cron lock, so the child must not collide with it (a same-lock collision
  # would exit 0 as "already running" and silently mask a skipped run).
  if HUNTERCARD_FORCE_ISOLATED_STAGE2=1 HUNTERCARD_LOCK_FILE="${LOCK_FILE}.stage2" \
    bash "$ISOLATED_DIR/scripts/local-scrape-and-push.sh"; then
    echo "[$(date)] ✅ Done (forced-isolated bootstrap)" >> "$LOG_FILE"
    exit 0
  else
    echo "[$(date)] ❌ forced-isolated stage 2 failed — cron reports failure" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi
fi

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
  removeStaleIsolatedWorktree "$ISOLATED_DIR"
  # A throwaway worktree pinned to the current remote HEAD gives a clean,
  # committed baseline the scheduler is allowed to mutate. Never touches the
  # resident checkout.
  if ! git worktree add --detach "$ISOLATED_DIR" "$REMOTE_HEAD" >> "$LOG_FILE" 2>&1; then
    echo "[$(date)] ⚠️ isolated worktree add failed once; pruning stale registrations and retrying" >> "$LOG_FILE"
    removeStaleIsolatedWorktree "$ISOLATED_DIR"
    if ! git worktree add --detach "$ISOLATED_DIR" "$REMOTE_HEAD" >> "$LOG_FILE" 2>&1; then
      echo "[$(date)] ❌ could not create isolated worktree; abandoning (cron fails)" >> "$LOG_FILE"
      exit 1
    fi
  fi
  trap 'git worktree remove --force "$ISOLATED_DIR" >> "$LOG_FILE" 2>&1 || true; rm -rf "$LOCK_FILE"' EXIT
  # DIC-1472: same dependency contract as the forced-isolated bootstrap — the
  # tracked node_modules shell means directory existence is not readiness.
  # Verify real anchors, replace only the disposable worktree's shell with an
  # absolute symlink to the resident install, and fail closed BEFORE any
  # pipeline mutation if provisioning cannot be proven.
  if ! ensureIsolatedDeps "$ISOLATED_DIR"; then
    echo "[$(date)] ❌ isolated worktree dependencies could not be provisioned; abandoning (cron fails)" >> "$LOG_FILE"
    echo "HUNTERCARD_SCRAPE_STATUS=FAILED" >> "$LOG_FILE"
    exit 1
  fi

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
  # Fully-qualified dst ref — same detached-HEAD push rule as the
  # forced-isolated handoff above (DIC-1461): an unqualified dst fails when
  # bot/scrape/<date> does not exist on the remote yet.
  if ! git -C "$ISOLATED_DIR" push origin "HEAD:refs/heads/$ISOLATED_BRANCH" >> "$LOG_FILE" 2>&1; then
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
