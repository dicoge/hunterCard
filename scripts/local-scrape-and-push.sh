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

# 2. Run the scraper
cd scripts
node build-database.js >> "$LOG_FILE" 2>&1
SCRAPE_EXIT=$?
cd ..

if [ $SCRAPE_EXIT -ne 0 ]; then
  echo "[$(date)] ❌ Scrape failed (exit $SCRAPE_EXIT)" >> "$LOG_FILE"
  exit 1
fi

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

# 2e. (removed, DIC-187) scrape-buy-prices.js used to scrape fullahead + torecolo
#     into data/buy-price-history.json. It scraped the SAME two sites as step 2f
#     in the same cron pass — double traffic and a risk of inconsistent results
#     if one pass succeeded and the other failed. Its output was consumed by
#     nothing, so the duplicate scrape was dropped and 2f is the single source.

# 2f. Scrape buy prices (torecolo + fullahead) into data/buy-prices/ and merge
#     into database.json (buyPrice + buyPriceHistory). Non-blocking (DIC-155).
echo "[$(date)] Scraping buy prices into database.json (torecolo + fullahead + merge)..." >> "$LOG_FILE"
cd scripts
node scrape-torecolo-buy.js >> "$LOG_FILE" 2>&1 || echo "[$(date)] ⚠️ Torecolo buy scrape failed (non-fatal)" >> "$LOG_FILE"
node scrape-fullahead-buy.js >> "$LOG_FILE" 2>&1 || echo "[$(date)] ⚠️ Fullahead buy scrape failed (non-fatal)" >> "$LOG_FILE"
node merge-buy-prices.js >> "$LOG_FILE" 2>&1 || echo "[$(date)] ⚠️ Buy price merge failed (non-fatal)" >> "$LOG_FILE"
cd ..

# 3. Check if data changed
if git diff --stat -- 'data/database.json' 'data/images/' 'data/official/' 'data/series-names.json' 'data/price-history/' 'data/yt-subscribers/' 'data/news-sentiment/' 'data/trends/' 'data/buy-prices/' | grep -q .; then
  echo "[$(date)] Data changed, committing and pushing..." >> "$LOG_FILE"
  # Only add directories that exist (some are optional and may not be created yet)
  EXISTING_DATA="data/database.json data/images/ data/official/cardList_*.json data/series-names.json data/price-history/*.json"
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