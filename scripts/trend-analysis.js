/**
 * trend-analysis.js
 *
 * hololive 卡牌價格趨勢預測引擎
 *
 * 讀取三種資料來源進行分析：
 * 1. 歷史價格資料 (data/price-history/)
 * 2. YT 訂閱數歷史 (data/yt-subscribers/)
 * 3. 新聞情緒歷史 (data/news-sentiment/)
 *
 * 權重：
 *   - 價格趨勢: 60%
 *   - YT 訂閱趨勢: 20%
 *   - 新聞情緒: 20%
 *
 * 用法：
 *   node scripts/trend-analysis.js             # 完整分析
 *   node scripts/trend-analysis.js --card hBD24-007  # 分析指定卡片
 *   node scripts/trend-analysis.js --summary    # 只輸出摘要
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_DIR, 'data');
const TRENDS_DIR = path.join(DATA_DIR, 'trends');

// ═══════════════════════════════════════════
//  分析模組
// ═══════════════════════════════════════════

/**
 * 計算價格趨勢分數
 * 使用最近 7 天 vs 前 7 天的價格變化
 * 回傳 -1.0 (暴跌) 到 1.0 (暴漲)
 */
function calculatePriceTrend(records) {
  if (!records || records.length < 2) return 0;

  const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date));
  const today = new Date();
  const cutoffRecent = new Date(today);
  cutoffRecent.setDate(cutoffRecent.getDate() - 7);
  const cutoffPrior = new Date(today);
  cutoffPrior.setDate(cutoffPrior.getDate() - 14);

  // 最近 7 天
  const recent = sorted.filter(r => {
    const d = new Date(r.date);
    return d >= cutoffPrior && d < cutoffRecent;
  });

  // 前 7 天 (更早的 7 天)
  const prior = sorted.filter(r => {
    const d = new Date(r.date);
    return d >= cutoffPrior && d < cutoffRecent;
  });

  // 如果資料不夠，退而使用最近 2 筆 vs 倒數 3-4 筆
  if (recent.length < 1 || prior.length < 1) {
    if (sorted.length >= 2) {
      const latest = sorted[sorted.length - 1].price;
      const previous = sorted[0].price;
      const change = (latest - previous) / Math.max(previous, 1);
      return Math.max(-1, Math.min(1, change));
    }
    return 0;
  }

  const avgRecent = recent.reduce((s, r) => s + r.price, 0) / recent.length;
  const avgPrior = prior.reduce((s, r) => s + r.price, 0) / prior.length;

  const change = (avgRecent - avgPrior) / Math.max(avgPrior, 1);

  // 限制在 -1 ~ 1 範圍
  return Math.max(-1, Math.min(1, change));
}

/**
 * 計算價格波動率（用於信心度評估）
 * 高波動 = 低信心
 */
function calculateVolatility(records) {
  if (!records || records.length < 3) return 1;

  const prices = records.map(r => r.price);
  const mean = prices.reduce((s, p) => s + p, 0) / prices.length;
  const variance = prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length;
  const stdDev = Math.sqrt(variance);

  return stdDev / Math.max(mean, 1);
}

/**
 * 計算 YT 訂閱趨勢分數
 * 檢查最近 7 天 vs 前 7 天的訂閱增長率
 */
function calculateYTSubscriberTrend(ytHistory, memberName) {
  if (!ytHistory || ytHistory.length < 2) return 0;

  const sorted = [...ytHistory].sort((a, b) => a.date.localeCompare(b.date));

  const today = new Date();
  const cutoffRecent = new Date(today);
  cutoffRecent.setDate(cutoffRecent.getDate() - 7);
  const cutoffPrior = new Date(today);
  cutoffPrior.setDate(cutoffPrior.getDate() - 14);

  // 對每個日期紀錄，找到該成員的訂閱數
  let recentGrowth = 0;
  let priorGrowth = 0;
  let recentCount = 0;
  let priorCount = 0;

  for (const entry of sorted) {
    const d = new Date(entry.date);
    const subs = entry.members?.[memberName]?.subscribers;
    if (subs == null) continue;

    if (d >= cutoffPrior && d < cutoffRecent) {
      recentGrowth = subs;
      recentCount++;
    } else if (d >= cutoffPrior && d < cutoffRecent) {
      priorGrowth = subs;
      priorCount++;
    }
  }

  if (recentCount < 1 || priorCount < 1) return 0;

  const growthRate = (recentGrowth - priorGrowth) / Math.max(priorGrowth, 1);
  return Math.max(-0.5, Math.min(0.5, growthRate));
}

/**
 * 計算新聞情緒分數
 * 近 7 天新聞平均情緒
 */
function calculateNewsSentiment(newsHistory) {
  if (!newsHistory || newsHistory.length < 1) return 0;

  const today = new Date();
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - 7);

  const recent = newsHistory.filter(n => {
    const d = new Date(n.date);
    return d >= cutoff;
  });

  if (recent.length === 0) return 0;

  let totalScore = 0;
  let totalWeight = 0;

  for (const day of recent) {
    const summary = day.summary;
    if (!summary) continue;

    // 正向比例減去負向比例
    const score = summary.positiveRatio - (summary.negative / Math.max(summary.totalArticles, 1));
    const weight = Math.min(summary.totalArticles, 10) / 10; // 文章越多權重越高

    totalScore += score * weight;
    totalWeight += weight;
  }

  return totalWeight > 0 ? totalScore / totalWeight : 0;
}

/**
 * 計算信心度
 * 根據：
 * - 歷史資料長度（越多越有信心）
 * - 波動率（越低越有信心）
 * - 資料新鮮度（越近期越有信心）
 */
function calculateConfidence(priceRecords, volatility) {
  let score = 0;

  // 資料點越多越有信心
  const recordCount = priceRecords?.length || 0;
  if (recordCount >= 30) score += 0.4;
  else if (recordCount >= 14) score += 0.3;
  else if (recordCount >= 7) score += 0.2;
  else if (recordCount >= 3) score += 0.1;

  // 波動率越低越有信心
  if (volatility < 0.05) score += 0.3;
  else if (volatility < 0.1) score += 0.2;
  else if (volatility < 0.2) score += 0.1;

  // 有新資料（最近 3 天內）
  if (recordCount > 0) {
    const lastDate = new Date(priceRecords[priceRecords.length - 1].date);
    const daysSinceUpdate = (new Date() - lastDate) / (1000 * 60 * 60 * 24);
    if (daysSinceUpdate <= 1) score += 0.3;
    else if (daysSinceUpdate <= 3) score += 0.2;
    else if (daysSinceUpdate <= 7) score += 0.1;
  }

  return Math.min(1, Math.max(0, score));
}

/**
 * 對單張卡片進行完整趨勢分析
 */
function analyzeCardTrend(cardId, cardData, ytHistory, newsHistory) {
  // 1. 價格趨勢 (60% 權重)
  const priceRecords = cardData?.records || [];
  const priceTrend = calculatePriceTrend(priceRecords);
  const volatility = calculateVolatility(priceRecords);

  // 2. YT 訂閱趨勢 (20% 權重)
  // 從卡片名稱匹配 YT 成員
  const memberName = cardData?.nameZh || cardData?.name || '';
  const ytTrend = calculateYTSubscriberTrend(ytHistory, memberName);

  // 3. 新聞情緒 (20% 權重)
  const newsSentiment = calculateNewsSentiment(newsHistory);

  // 4. 綜合預測
  const compositeScore = priceTrend * 0.6 + ytTrend * 0.2 + newsSentiment * 0.2;

  // 5. 分類
  let trend;
  if (compositeScore > 0.15) trend = 'up';
  else if (compositeScore < -0.15) trend = 'down';
  else trend = 'stable';

  // 6. 信心度
  const confidence = calculateConfidence(priceRecords, volatility);

  return {
    cardId: cardData?.cardNumber || cardId,
    name: cardData?.name || '',
    nameZh: cardData?.nameZh || '',
    trend,
    score: Math.round(compositeScore * 100) / 100,
    confidence: Math.round(confidence * 100) / 100,
    components: {
      priceTrend: Math.round(priceTrend * 100) / 100,
      ytTrend: Math.round(ytTrend * 100) / 100,
      newsSentiment: Math.round(newsSentiment * 100) / 100,
    },
    lastUpdated: new Date().toISOString(),
    dataPoints: priceRecords.length,
  };
}

// ═══════════════════════════════════════════
//  資料載入
// ═══════════════════════════════════════════

function loadPriceHistories() {
  const dir = path.join(DATA_DIR, 'price-history');
  const results = {};

  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'index.json');
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
        const cardId = file.replace('.json', '');
        results[cardId] = data;
      } catch {
        // skip corrupted files
      }
    }
    console.log(`[trends] Loaded ${Object.keys(results).length} card price histories`);
  } catch (err) {
    console.warn(`[trends] No price history data: ${err.message}`);
  }

  return results;
}

function loadYTHistory() {
  const dir = path.join(DATA_DIR, 'yt-subscribers');
  const results = [];

  try {
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf-8'));
    const dates = index.dates || [];

    for (const date of dates) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, `${date}.json`), 'utf-8'));
        results.push(data);
      } catch {
        // skip
      }
    }

    // Sort by date
    results.sort((a, b) => a.date.localeCompare(b.date));
    console.log(`[trends] Loaded ${results.length} YT subscriber snapshots`);
  } catch (err) {
    console.warn(`[trends] No YT subscriber data: ${err.message}`);
  }

  return results;
}

function loadNewsHistory() {
  const dir = path.join(DATA_DIR, 'news-sentiment');
  const results = [];

  try {
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf-8'));
    const dates = index.dates || [];

    for (const date of dates) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, `${date}.json`), 'utf-8'));
        results.push(data);
      } catch {
        // skip
      }
    }

    results.sort((a, b) => a.date.localeCompare(b.date));
    console.log(`[trends] Loaded ${results.length} news sentiment snapshots`);
  } catch (err) {
    console.warn(`[trends] No news sentiment data: ${err.message}`);
  }

  return results;
}

function loadDatabase() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'database.json'), 'utf-8'));
  } catch (err) {
    console.warn(`[trends] Cannot load database.json: ${err.message}`);
    return { cards: {} };
  }
}

// ═══════════════════════════════════════════
//  輸出與儲存
// ═══════════════════════════════════════════

function saveTrendResults(results) {
  fs.mkdirSync(TRENDS_DIR, { recursive: true });

  // per-card trend files
  for (const [cardId, trend] of Object.entries(results)) {
    const safeId = cardId.replace(/[^a-zA-Z0-9_-]/g, '_');
    fs.writeFileSync(
      path.join(TRENDS_DIR, `${safeId}.json`),
      JSON.stringify(trend, null, 2)
    );
  }

  // index/summary
  const up = Object.values(results).filter(r => r.trend === 'up').length;
  const down = Object.values(results).filter(r => r.trend === 'down').length;
  const stable = Object.values(results).filter(r => r.trend === 'stable').length;

  const index = {
    lastUpdated: new Date().toISOString(),
    totalCards: Object.keys(results).length,
    summary: { up, down, stable },
    // Top movers: sort by absolute score
    topGainers: Object.entries(results)
      .sort(([, a], [, b]) => b.score - a.score)
      .slice(0, 20)
      .map(([id, r]) => ({ cardId: r.cardId, name: r.name, nameZh: r.nameZh, score: r.score, trend: r.trend })),
    topLosers: Object.entries(results)
      .sort(([, a], [, b]) => a.score - b.score)
      .slice(0, 20)
      .map(([id, r]) => ({ cardId: r.cardId, name: r.name, nameZh: r.nameZh, score: r.score, trend: r.trend })),
  };

  fs.writeFileSync(path.join(TRENDS_DIR, 'index.json'), JSON.stringify(index, null, 2));

  return index;
}

// ═══════════════════════════════════════════
//  主流程
// ═══════════════════════════════════════════

async function main() {
  const startTime = Date.now();
  const args = process.argv.slice(2);
  const cardFilter = args.includes('--card') ? args[args.indexOf('--card') + 1] : null;
  const summaryOnly = args.includes('--summary');

  console.log('═══════════════════════════════════════');
  console.log('  hololive Card Price Trend Analyzer');
  console.log('═══════════════════════════════════════\n');

  // 1. Load all data
  console.log('── Loading data sources ──');
  const priceHistories = loadPriceHistories();
  const ytHistory = loadYTHistory();
  const newsHistory = loadNewsHistory();
  const db = loadDatabase();

  console.log(`\n  Price histories: ${Object.keys(priceHistories).length} cards`);
  console.log(`  YT snapshots:    ${ytHistory.length} days`);
  console.log(`  News snapshots:  ${newsHistory.length} days`);

  if (Object.keys(priceHistories).length === 0) {
    console.warn('\n⚠️ No price history data found. Run build-database.js first to collect data.');
    console.warn('   For now, creating empty trend analysis to establish the system.');
  }

  // 2. Run analysis
  console.log('\n── Running trend analysis ──');
  const results = {};

  const cardIdsToAnalyze = cardFilter
    ? [cardFilter]
    : Object.keys(priceHistories);

  console.log(`  Analyzing ${cardIdsToAnalyze.length} cards...`);

  for (const cardId of cardIdsToAnalyze) {
    const priceData = priceHistories[cardId];
    const dbCard = db.cards?.[cardId];

    const trend = analyzeCardTrend(cardId, priceData, ytHistory, newsHistory);
    results[cardId] = trend;
  }

  // 3. Save results
  console.log('\n── Saving results ──');
  const summary = saveTrendResults(results);

  // 4. Summary
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  if (!summaryOnly && !cardFilter) {
    console.log(`\n📈 Market Summary:`);
    console.log(`  📈 Up:     ${summary.summary.up} cards`);
    console.log(`  📉 Down:   ${summary.summary.down} cards`);
    console.log(`  ➡️ Stable: ${summary.summary.stable} cards`);

    if (summary.topGainers.length > 0) {
      console.log(`\n🔥 Top Gainers:`);
      for (const g of summary.topGainers.slice(0, 5)) {
        const emoji = g.trend === 'up' ? '📈' : g.trend === 'down' ? '📉' : '➡️';
        console.log(`  ${emoji} ${g.nameZh || g.name} (${g.cardId}): ${(g.score * 100).toFixed(0)}%`);
      }
    }

    if (summary.topLosers.length > 0) {
      console.log(`\n❄️ Top Losers:`);
      for (const l of summary.topLosers.slice(0, 5)) {
        const emoji = l.trend === 'up' ? '📈' : l.trend === 'down' ? '📉' : '➡️';
        console.log(`  ${emoji} ${l.nameZh || l.name} (${l.cardId}): ${(l.score * 100).toFixed(0)}%`);
      }
    }
  }

  console.log(`\n✅ Done in ${duration}s — ${Object.keys(results).length} cards analyzed`);
  console.log(`   Results saved to ${TRENDS_DIR}/`);
}

// Run
main().catch(err => {
  console.error('\n❌ Analysis failed:', err.message);
  process.exit(1);
});
