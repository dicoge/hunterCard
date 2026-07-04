/**
 * scrape-news-sentiment.js
 *
 * 每日爬取 hololive 卡牌相關新聞，進行情緒分類
 * 儲存到 data/news-sentiment/{date}.json
 *
 * 新聞來源：
 *   - Google News RSS (hololive card game, hololive 卡牌)
 *   - 遊々亭新卡情報
 *   - hololive 官方網站
 *
 * 情緒分類：基於關鍵字配對（無需 LLM）
 *
 * 用法：
 *   node scripts/scrape-news-sentiment.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_DIR, 'data');
const NEWS_DIR = path.join(DATA_DIR, 'news-sentiment');

// ── 情緒關鍵字詞典 ──

const POSITIVE_WORDS = [
  '新卡', '人氣', '上漲', '熱銷', '完售', '再販', '大好評',
  '新系列', '合作', '限定', '升值', '高騰', '増加', '上昇',
  'record', 'surge', 'popular', 'sold out', 'reprint',
  '新高', '突破', '好調', '盛況', '注目', '期待',
  'release', 'launch', 'announce', '新発売',
];

const NEGATIVE_WORDS = [
  '暴跌', '滯銷', '跌價', '供過於求', '炒賣', '爭議', '退坑',
  '停產', '瑕疵', '災情', '下落', '減少', '暴落', '低迷',
  '下降', '懸念', '批判', '問題', '訴訟', '不正',
  'crash', 'drop', 'decline', 'controversy', 'scam',
  '偽物', '転売', '値下がり', '不作',
];

const NEUTRAL_WORDS = [
  '発売', '販売', '予約', '開始', '更新', '情報',
  '発表', '展示', 'イベント', 'キャンペーン',
  'stream', 'update', 'schedule', 'maintenance',
];

// ── 情緒分類 ──

function classifySentiment(title, description) {
  const text = `${title} ${description}`.toLowerCase();

  let positiveScore = 0;
  let negativeScore = 0;
  const matchedKeywords = [];

  for (const word of POSITIVE_WORDS) {
    if (text.includes(word.toLowerCase())) {
      positiveScore += 1;
      matchedKeywords.push(word);
    }
  }

  for (const word of NEGATIVE_WORDS) {
    if (text.includes(word.toLowerCase())) {
      negativeScore += 1;
      matchedKeywords.push(word);
    }
  }

  const total = positiveScore + negativeScore;
  if (total === 0) {
    return { sentiment: 'neutral', score: 0, keywords: matchedKeywords };
  }

  const ratio = positiveScore / total;
  if (ratio > 0.6) {
    return { sentiment: 'positive', score: ratio, keywords: matchedKeywords };
  } else if (ratio < 0.4) {
    return { sentiment: 'negative', score: 1 - ratio, keywords: matchedKeywords };
  } else {
    return { sentiment: 'neutral', score: 0.5, keywords: matchedKeywords };
  }
}

// ── 新聞來源爬取 ──

/**
 * 爬取 Google News RSS
 */
async function scrapeGoogleNews(query, lang = 'ja') {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${lang}&gl=JP`;
  console.log(`  [news] Fetching Google News: "${query}"`);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    if (!response.ok) {
      console.warn(`  [news] Google News returned HTTP ${response.status}`);
      return [];
    }

    const xml = await response.text();

    // Simple XML parsing for RSS items
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
    let match;

    while ((match = itemRegex.exec(xml)) !== null) {
      const itemXml = match[1];

      const titleMatch = itemXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/i) || itemXml.match(/<title>(.*?)<\/title>/i);
      const linkMatch = itemXml.match(/<link>(.*?)<\/link>/i);
      const pubDateMatch = itemXml.match(/<pubDate>(.*?)<\/pubDate>/i);
      const descMatch = itemXml.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/i) || itemXml.match(/<description>(.*?)<\/description>/i);
      const sourceMatch = itemXml.match(/<source[^>]*>(.*?)<\/source>/i) || itemXml.match(/<news:name>(.*?)<\/news:name>/i);

      if (titleMatch) {
        items.push({
          title: titleMatch[1].replace(/<[^>]+>/g, '').trim(),
          url: linkMatch ? linkMatch[1].trim() : '',
          description: descMatch ? descMatch[1].replace(/<[^>]+>/g, '').trim().slice(0, 300) : '',
          source: sourceMatch ? sourceMatch[1].trim() : 'Google News',
          publishedAt: pubDateMatch ? new Date(pubDateMatch[1]).toISOString() : new Date().toISOString(),
        });
      }
    }

    console.log(`  [news] Found ${items.length} articles for "${query}"`);
    return items;
  } catch (err) {
    console.warn(`  [news] Error fetching Google News "${query}": ${err.message}`);
    return [];
  }
}

/**
 * 爬取 yuyu-tei 新卡情報
 */
async function scrapeYuyuTeiNews() {
  console.log('  [news] Fetching yuyu-tei news...');
  try {
    const response = await fetch('https://yuyu-tei.jp/top/hocg/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'ja-JP,ja;q=0.9',
      },
    });

    if (!response.ok) return [];

    const html = await response.text();

    // Look for news/info items on the page
    const items = [];
    const newsRegex = /<a[^>]*class="[^"]*news[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;

    while ((match = newsRegex.exec(html)) !== null) {
      const title = match[2].replace(/<[^>]+>/g, '').trim();
      if (title && title.length > 5) {
        items.push({
          title,
          url: match[1].startsWith('http') ? match[1] : `https://yuyu-tei.jp${match[1]}`,
          description: '',
          source: '遊々亭',
          publishedAt: new Date().toISOString(),
        });
      }
    }

    // Fallback: look for any title-like text
    if (items.length === 0) {
      const titleRegex = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi;
      while ((match = titleRegex.exec(html)) !== null) {
        const title = match[1].replace(/<[^>]+>/g, '').trim();
        if (title && title.length > 5 && (title.includes('hOCG') || title.includes('ホロライブ') || title.includes('カード'))) {
          items.push({
            title,
            url: 'https://yuyu-tei.jp/top/hocg/',
            description: '',
            source: '遊々亭',
            publishedAt: new Date().toISOString(),
          });
        }
      }
    }

    console.log(`  [news] Found ${items.length} items from yuyu-tei`);
    return items;
  } catch (err) {
    console.warn(`  [news] Error fetching yuyu-tei: ${err.message}`);
    return [];
  }
}

// ── 主流程 ──

async function main() {
  const startTime = Date.now();
  console.log('═══════════════════════════════════════');
  console.log('  News Sentiment Analyzer');
  console.log('═══════════════════════════════════════\n');

  // ── 爬取所有來源 ──
  const sources = [
    { name: 'Google News (JP)', fetcher: () => scrapeGoogleNews('ホロライブ カードゲーム', 'ja') },
    { name: 'Google News (EN)', fetcher: () => scrapeGoogleNews('hololive official card game', 'en') },
    { name: 'Google News (ZH)', fetcher: () => scrapeGoogleNews('hololive 卡牌', 'zh-TW') },
    { name: 'yuyu-tei', fetcher: scrapeYuyuTeiNews },
  ];

  const allArticles = [];
  const seenUrls = new Set();

  for (const source of sources) {
    try {
      const articles = await source.fetcher();
      for (const article of articles) {
        // Deduplicate by URL
        const urlKey = article.url || article.title;
        if (!seenUrls.has(urlKey)) {
          seenUrls.add(urlKey);
          allArticles.push(article);
        }
      }
    } catch (err) {
      console.error(`  [news] Source "${source.name}" failed: ${err.message}`);
    }

    // Rate limiting between sources
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log(`\n[news] Total unique articles: ${allArticles.length}`);

  // ── 情緒分類 ──
  const classifiedArticles = allArticles.map(article => {
    const { sentiment, score, keywords } = classifySentiment(article.title, article.description);
    return {
      ...article,
      sentiment,
      score,
      keywords,
    };
  });

  // ── 統計摘要 ──
  const positive = classifiedArticles.filter(a => a.sentiment === 'positive').length;
  const negative = classifiedArticles.filter(a => a.sentiment === 'negative').length;
  const neutral = classifiedArticles.filter(a => a.sentiment === 'neutral').length;

  const totalPositiveScore = classifiedArticles
    .filter(a => a.sentiment === 'positive')
    .reduce((sum, a) => sum + a.score, 0);

  const totalNegativeScore = classifiedArticles
    .filter(a => a.sentiment === 'negative')
    .reduce((sum, a) => sum + a.score, 0);

  const summary = {
    totalArticles: classifiedArticles.length,
    positive,
    negative,
    neutral,
    positiveScore: classifiedArticles.length > 0 ? totalPositiveScore / Math.max(positive, 1) : 0,
    negativeScore: classifiedArticles.length > 0 ? totalNegativeScore / Math.max(negative, 1) : 0,
    positiveRatio: classifiedArticles.length > 0 ? positive / classifiedArticles.length : 0,
  };

  // ── 儲存 ──
  fs.mkdirSync(NEWS_DIR, { recursive: true });

  const today = new Date().toISOString().split('T')[0];
  const filePath = path.join(NEWS_DIR, `${today}.json`);

  const output = {
    date: today,
    lastUpdated: new Date().toISOString(),
    summary,
    sources: sources.map(s => s.name),
    articles: classifiedArticles,
  };

  fs.writeFileSync(filePath, JSON.stringify(output, null, 2));

  // Update index
  const indexFile = path.join(NEWS_DIR, 'index.json');
  let index = { dates: [], totalRecords: 0 };
  try {
    index = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
  } catch {
    // new file
  }

  if (!index.dates.includes(today)) {
    index.dates.push(today);
    index.dates.sort();
  }
  index.totalRecords = index.dates.length;
  index.lastUpdated = new Date().toISOString();
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n📊 Sentiment Summary:`);
  console.log(`  👍 Positive: ${summary.positive} (${(summary.positiveRatio * 100).toFixed(0)}%)`);
  console.log(`  👎 Negative: ${summary.negative}`);
  console.log(`  ➡️ Neutral:  ${summary.neutral}`);
  console.log(`\n✅ Done in ${duration}s — saved to ${filePath}`);
}

// Run
main().catch(err => {
  console.error('\n❌ Failed:', err.message);
  process.exit(1);
});