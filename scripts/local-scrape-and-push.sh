#!/bin/bash
# Local scraper: runs build-database.js on this Mac, then pushes data to GitHub
# Runs via local cron since CI can't bypass yuyu-tei's Cloudflare

set -e
cd "$(dirname "$0")/.."
LOCK_FILE="/tmp/huntercard-scrape.lock"
LOG_FILE="$HOME/.hermes/logs/huntercard-scrape-$(date +%Y%m%d).log"
mkdir -p "$(dirname "$LOG_FILE")"

# Prevent concurrent execution
if ! mkdir "$LOCK_FILE" 2>/dev/null; then
  echo "[$(date)] ⚠️ Scrape already running, skipping this instance" >> "$LOG_FILE"
  exit 0
fi
trap 'rm -rf "$LOCK_FILE"' EXIT

echo "[$(date)] Starting hunterCard local scrape..." >> "$LOG_FILE"

# 0. Check for new official series (fast, ~30s)
echo "[$(date)] Running official site scraper..." >> "$LOG_FILE"
cd scripts
node scrape-official-cards.js >> "$LOG_FILE" 2>&1
cd ..

# 1. Pull latest from main
git pull origin main >> "$LOG_FILE" 2>&1

# 1b. Snapshot YT channel stats (subscribers + total views) into
#     data/yt-stats-history.json. MUST run before build-database.js so the
#     latter can compute growth_1d/7d/15d/30d and view deltas from the fresh
#     snapshot. Non-blocking (DIC-273).
echo "[$(date)] Running YT stats snapshot..." >> "$LOG_FILE"
cd scripts
node scrape-yt-stats.js >> "$LOG_FILE" 2>&1 || echo "[$(date)] ⚠️ YT stats snapshot failed (non-fatal)" >> "$LOG_FILE"
cd ..

# 2. Run the scraper, split into two steps so each fits a single cron
#    timeout window (DIC-508): the "scrape" step alone (~35 yuyu-tei series
#    pages, each throttled 3-5s, plus image downloads) can exceed 300s. If it
#    gets interrupted mid-run, data/scrape-checkpoint.json lets the NEXT run
#    resume from the first unfinished series instead of rescraping everything.
#    The "merge" step only reads the finished scrape output
#    (data/scrape-cache.json) and writes database.json, so it is fast and
#    always safe to run right after. (non-fatal: buy crawlers must run even
#    if build-database fails)
cd scripts
node build-database.js --stage=scrape >> "$LOG_FILE" 2>&1 || {
  status=$?
  echo "[$(date)] ⚠️ build-database scrape stage failed (exit $status)" >> "$LOG_FILE"
  if [ -f ../data/scrape-checkpoint.json ]; then
    echo "[$(date)]    → checkpoint saved, tomorrow's run will resume the remaining series" >> "$LOG_FILE"
  fi
}
if [ -f ../data/scrape-cache.json ]; then
  node build-database.js --stage=merge >> "$LOG_FILE" 2>&1 || { status=$?; echo "[$(date)] ⚠️ build-database merge stage failed (exit $status), continuing..." >> "$LOG_FILE"; }
else
  echo "[$(date)] ⚠️ No scrape cache produced, skipping merge stage (continuing)..." >> "$LOG_FILE"
fi
cd ..

# 2b. Optional: Run YT subscriber tracker (non-blocking, won't fail pipeline)
echo "[$(date)] Running YT subscriber tracker..." >> "$LOG_FILE"
cd scripts
node scrape-yt-subscribers.js >> "$LOG_FILE" 2>&1 || echo "[$(date)] ⚠️ YT subscriber tracker failed (non-fatal)" >> "$LOG_FILE"
cd ..

# 2c. Optional: Run news sentiment analysis (non-blocking, won't fail pipeline)
echo "[$(date)] Running news sentiment analysis..." >> "$LOG_FILE"
cd scripts
node scrape-news-sentiment.js >> "$LOG_FILE" 2>&1 || echo "[$(date)] ⚠️ News sentiment analysis failed (non-fatal)" >> "$LOG_FILE"
cd ..

# 2d. Run trend analysis (requires price history data)
echo "[$(date)] Running trend analysis..." >> "$LOG_FILE"
cd scripts
node trend-analysis.js >> "$LOG_FILE" 2>&1 || echo "[$(date)] ⚠️ Trend analysis failed (non-fatal)" >> "$LOG_FILE"
cd ..

# 2e. Send Expo push alerts for watched cards with strong upward signals.
echo "[$(date)] 📣 Sending push alerts..." >> "$LOG_FILE"
node scripts/send-push-alerts.js >> "$LOG_FILE" 2>&1 || echo "[$(date)] ⚠️ Push alerts failed (non-fatal)" >> "$LOG_FILE"

# 2f. (removed, DIC-187) scrape-buy-prices.js used to scrape fullahead + torecolo
#     into data/buy-price-history.json. It scraped the SAME two sites as step 2f
#     in the same cron pass — double traffic and a risk of inconsistent results
#     if one pass succeeded and the other failed. Its output was consumed by
#     nothing, so the duplicate scrape was dropped and 2f is the single source.

# 2g. Scrape buy prices (torecolo + fullahead) into data/buy-prices/ and merge
#     into database.json (buyPrice + buyPriceHistory). Non-blocking (DIC-155).
echo "[$(date)] Scraping buy prices into database.json (torecolo + fullahead + merge)..." >> "$LOG_FILE"
cd scripts
node scrape-torecolo-buy.js >> "$LOG_FILE" 2>&1 || echo "[$(date)] ⚠️ Torecolo buy scrape failed (non-fatal)" >> "$LOG_FILE"
node scrape-fullahead-buy.js >> "$LOG_FILE" 2>&1 || echo "[$(date)] ⚠️ Fullahead buy scrape failed (non-fatal)" >> "$LOG_FILE"
node merge-buy-prices.js >> "$LOG_FILE" 2>&1 || echo "[$(date)] ⚠️ Buy price merge failed (non-fatal)" >> "$LOG_FILE"
cd ..

# 3. Check if data changed
if git diff --stat -- 'data/database.json' 'data/images/' 'data/official/' 'data/series-names.json' 'data/price-history/' 'data/yt-subscribers/' 'data/yt-stats-history.json' 'data/news-sentiment/' 'data/trends/' 'data/buy-prices/' | grep -q .; then
  echo "[$(date)] Data changed, committing and pushing..." >> "$LOG_FILE"
  # Only add directories that exist (some are optional and may not be created yet)
  EXISTING_DATA="data/database.json data/images/ data/official/cardList_*.json data/series-names.json data/price-history/*.json"
  [ -f data/yt-stats-history.json ] && EXISTING_DATA="$EXISTING_DATA data/yt-stats-history.json"
  for dir in data/yt-subscribers data/news-sentiment data/trends; do
    [ -d "$dir" ] && EXISTING_DATA="$EXISTING_DATA $dir/*.json"
  done
  # shellcheck disable=SC2086
  git add $EXISTING_DATA
  git add data/buy-prices/*.json 2>/dev/null || true
  git -c user.name="hunterCard Scraper" -c user.email="bot@huntercard.app" \
    commit -m "chore: update database $(date +%Y-%m-%d)" >> "$LOG_FILE" 2>&1
  git push origin main >> "$LOG_FILE" 2>&1
  echo "[$(date)] ✅ Pushed to GitHub" >> "$LOG_FILE"

  # 4. Auto-deploy via GitHub push (holocard-hunter linked to main branch)
else
  echo "[$(date)] No data changes, skipping push" >> "$LOG_FILE"
fi

echo "[$(date)] ✅ Done" >> "$LOG_FILE"