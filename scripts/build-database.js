/**
 * build-database.js — 統合爬蟲 + 圖片下載 + 資料庫產出
 *
 * 流程：
 * 1. 用 Puppeteer 爬 yuyu-tei 價格 + 圖片 URL（含反偵測頭部）
 * 2. 若 Puppeteer 失敗，自動降級到 HTTP fetch（Node 內建，不需瀏覽器）
 * 3. 下載新卡片圖片到 data/images/
 * 4. 讀取 data/official/*.json 合併基本資料
 * 5. 產出 data/database.json
 * 6. 安全檢查：totalCards < 50 就拋錯
 */

// ─── Output Tee: 所有 console 輸出也寫入 data/scrape-log.txt ───
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';
import { addZhNames } from './add-zh-names.js';
import { computeGrowthDeltas } from './lib/yt-growth.js';
import { canonicalVariantKey } from './lib/variant-key.js';
import { isCanonicalCardNumber, CANONICAL_CARD_NUMBER_RE } from './lib/card-number.js';
import { canonicalizePrices, canonicalYuyuName, canonicalYuyuImage } from './lib/canonical-printings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_DIR, 'data');
const LOG_PATH = path.join(DATA_DIR, 'scrape-log.txt');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Write initial log
fs.writeFileSync(LOG_PATH, `=== Scrape Log ${new Date().toISOString()} ===\n`, 'utf-8');

// Tee: capture console.log AND console.error to log file
const origLog = console.log;
const origError = console.error;
console.log = function(...args) {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  fs.appendFileSync(LOG_PATH, msg + '\n', 'utf-8');
  origLog.apply(console, args);
};
console.error = function(...args) {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  fs.appendFileSync(LOG_PATH, '[ERROR] ' + msg + '\n', 'utf-8');
  origError.apply(console, args);
};
// ─── End Tee ───

// Catch unhandled promise rejections for better diagnostics
process.on('unhandledRejection', (reason) => {
  console.error('\n❌ Unhandled Rejection:', reason);
  process.exit(1);
});

const BASE_URL = 'https://yuyu-tei.jp';
const SCRIPT_DIR = __dirname;
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const OFFICIAL_DIR = path.join(DATA_DIR, 'official');
const OUTPUT_PATH = path.join(DATA_DIR, 'database.json');
const YUYU_IMAGE_BASE = 'https://card.yuyu-tei.jp/hocg/100_140';

// Extra HTTP headers to mimic a real browser
const EXTRA_HEADERS = {
  'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
};

// User-Agent for fetch-based requests
const UA_STRING = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Series URLs - same as scrape-yuyu-prices.js
//
// Known special series → yuyu-tei URL mapping
const SPECIAL_URLS = {
  'hPR': '/sell/hocg/s/special/1',
  'hY': '/sell/hocg/s/special/2',
  'ent07': '/sell/hocg/s/special/4',
  'hCS01': '/sell/hocg/s/special/5',
  'hPC01': '/sell/hocg/s/special/7',
  'hSD2025summer': '/sell/hocg/s/special/8',
};

// Series without a yuyu-tei page (skip with warning)
const NO_PAGE_SERIES = new Set(['hCO01', 'hWF01']);

/**
 * Generate series page list from database.json, replacing hardcoded SERIES_PAGES.
 * Falls back gracefully if database.json is missing or unreadable.
 */
function generateSeriesPages() {
  let db;
  try {
    db = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'database.json'), 'utf-8'));
  } catch (err) {
    console.warn(`[warn] 無法讀取 data/database.json (${err.message}) — 使用空 series 清單`);
    return [];
  }

  if (!db.cards || typeof db.cards !== 'object') {
    console.warn('[warn] database.json 格式錯誤：缺少 cards 欄位');
    return [];
  }

  const seriesCodes = new Set(Object.values(db.cards).map(c => c.series));
  const hbpSeries = [];
  const hsdSeries = [];
  const hysSeries = [];
  const specialSeries = [];

  for (const series of seriesCodes) {
    if (NO_PAGE_SERIES.has(series)) {
      console.warn(`[warn] 系列 "${series}" — 無對應 yuyu-tei URL，跳過`);
      continue;
    }

    if (SPECIAL_URLS[series]) {
      specialSeries.push({ name: series, url: SPECIAL_URLS[series] });
    } else if (series.startsWith('hBP')) {
      const code = series.toLowerCase();
      if (series === 'hBP04') {
        hbpSeries.push({ name: series, url: `/sell/hocg/s/${code}` });
      } else {
        hbpSeries.push({ name: series, url: `/sell/hocg/s/search?search_word=&vers[]=${code}` });
      }
    } else if (series.startsWith('hSD')) {
      hsdSeries.push({ name: series, url: `/sell/hocg/s/search?search_word=&vers[]=${series.toLowerCase()}` });
    } else if (series.startsWith('hYS')) {
      hysSeries.push({ name: series, url: `/sell/hocg/s/${series.toLowerCase()}` });
    } else {
      console.warn(`[warn] 系列 "${series}" — 無對應 yuyu-tei URL，跳過`);
    }
  }

  const sortByName = (a, b) => a.name.localeCompare(b.name);
  hbpSeries.sort(sortByName);
  hsdSeries.sort(sortByName);
  hysSeries.sort(sortByName);
  specialSeries.sort(sortByName);

  return [...hbpSeries, ...hsdSeries, ...hysSeries, ...specialSeries];
}

const SERIES_PAGES = generateSeriesPages();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizePriceHistory(priceHistory) {
  if (!priceHistory || typeof priceHistory !== 'object') return priceHistory;

  const entries = Object.entries(priceHistory).sort(([a],[b]) => a.localeCompare(b));
  if (entries.length < 3) return priceHistory;

  const laterHalf = entries.slice(Math.floor(entries.length / 2));
  const laterPrices = laterHalf.map(([,p]) => p).filter(Boolean).sort((a,b) => a-b);
  const median = laterPrices[Math.floor(laterPrices.length/2)];
  if (!median) return priceHistory;

  const cleaned = {};
  let removedCount = 0;
  entries.forEach(([date, price]) => {
    if (price > 0 && price <= median * 5) {
      cleaned[date] = price;
    } else {
      console.warn(`[sanitize] 移除疑似髒資料：${date} ¥${price}（中位數 ¥${median}）`);
      removedCount++;
    }
  });
  if (removedCount > 0) {
    console.warn(`[sanitize] 共移除 ${removedCount} 筆疑似髒資料，保留 ${Object.keys(cleaned).length} 筆`);
  }
  return cleaned;
}

/** 從 HTML 字串中解出卡片資料（使用純文字分析，與 page.evaluate 相同邏輯） */
function parseCardHtml(html) {
  const results = [];

  // Strip HTML tags to get text content
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
                   .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                   .replace(/<[^>]+>/g, ' ')
                   .replace(/&nbsp;/g, ' ')
                   .replace(/&amp;/g, '&')
                   .replace(/\s+/g, ' ')
                   .trim();

  // Find all card-product sections by looking for card number patterns
  const cardNumRegex = /(h[A-Z]{1,3}\d+-\d{2,3})/gi;
  let match;
  while ((match = cardNumRegex.exec(text)) !== null) {
    const cardNum = match[1];
    const matchStart = match.index;
    const contextStart = Math.max(0, matchStart - 100);
    const contextEnd = Math.min(text.length, matchStart + 300);
    const context = text.slice(contextStart, contextEnd);

    // Find price within this card's context
    const priceMatch = context.match(/([\d,]+)\s*円/);
    if (!priceMatch) continue;
    const price = parseInt(priceMatch[1].replace(/,/g, ''));
    if (isNaN(price) || price <= 0) continue;

    // Try to find card name between card number and price
    let name = '';
    const afterNum = text.slice(matchStart + cardNum.length, matchStart + 200);
    // Name is usually the text line right after the card number
    const lines = afterNum.split(/\s+/).filter(s => s.length > 0);
    for (let i = 0; i < Math.min(lines.length, 10); i++) {
      if (!lines[i].match(/[\d,]+\s*円/) && !lines[i].includes('在庫') && !lines[i].includes('カート') && !lines[i].match(/^\d+$/) && lines[i].length > 1) {
        name = lines[i];
        break;
      }
    }

    // Find image URL near this card number
    const imgMatch = html.slice(contextStart, contextEnd + 100).match(/<img[^>]*src="([^"]*card\.yuyu-tei\.jp[^"]*)"[^>]*>/i);
    const imageUrl = imgMatch ? imgMatch[1] : '';

    results.push({
      cardNum,
      sellPrice: price,
      name,
      yuyuImage: imageUrl,
      imageVersion: '',
      imageCid: '',
    });
  }

  return results;
}

/**
 * 降級方案：用 Node.js 內建 fetch + regex 解析 HTML
 * 不需要 Puppeteer/Chrome，減少 CI 環境依賴
 */
async function scrapeSeriesPageWithFetch(url) {
  console.log(`  [fetch] GET ${url}`);

  const response = await fetch(url, {
    headers: {
      'User-Agent': UA_STRING,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
      'Referer': 'https://yuyu-tei.jp/',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  const html = await response.text();
  console.log(`  [fetch] Downloaded ${html.length} bytes`);

  const cards = parseCardHtml(html);
  console.log(`  [fetch] Parsed ${cards.length} cards from HTML`);

  if (cards.length === 0) {
    // Diagnostic: what does the HTML look like?
    console.log(`  [fetch] WARN: No cards found. HTML snippet: ${html.slice(0, 300).replace(/\n/g, ' ')}`);
  }

  return cards;
}

/**
 * 下載單張圖片到 data/images/{cardNumber}.jpg
 * 增量：已存在就跳過
 */
async function downloadImage(url, destPath) {
  if (fs.existsSync(destPath)) {
    return false; // 已存在，跳過
  }
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (response) => {
      // Handle redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.unlinkSync(destPath);
        resolve(downloadImage(response.headers.location, destPath));
        return;
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(destPath);
        reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(true); // 新下載
      });
    }).on('error', (err) => {
      file.close();
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      reject(err);
    });
  });
}

/**
 * 用 Puppeteer 開啟頁面、等待卡片元素載入、用 page.evaluate 抽取資料
 * 含反偵測：額外 header、navigator.webdriver 覆蓋、隨機 viewport
 */
async function scrapeSeriesPage(browser, url) {
  const page = await browser.newPage();

  // Give navigation more headroom so a slow-but-alive page isn't mistaken for a
  // crash and forced into a browser relaunch (DIC-442).
  page.setDefaultNavigationTimeout(45000);
  page.setDefaultTimeout(30000);

  // 1. Set extra HTTP headers
  await page.setExtraHTTPHeaders(EXTRA_HEADERS);

  // Additional anti-detection: override navigator properties
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    // Override plugins array to match real browser
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
    // Override languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['ja-JP', 'ja', 'en-US', 'en'],
    });
    // Remove chrome.runtime (headless Chrome has this, real Chrome doesn't in some cases)
    // Override chrome object
    window.chrome = {
      runtime: {},
      loadTimes: function() {},
      csi: function() {},
      app: {},
    };
  });

  // 3. Random viewport size (1280-1366 width, 768-900 height)
  const width = Math.floor(Math.random() * (1366 - 1280 + 1)) + 1280;
  const height = Math.floor(Math.random() * (900 - 768 + 1)) + 768;
  await page.setViewport({ width, height });

  // 4. Set realistic User-Agent to avoid Cloudflare headless detection
  await page.setUserAgent(UA_STRING);

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });

    // 4. Diagnostic: check page structure (helps debug CI failures)
    const diag = await page.evaluate(() => ({
      title: (document.title || '').slice(0, 80),
      cardProduct: document.querySelectorAll('.card-product').length,
    }));
    if (diag.cardProduct === 0) {
      console.log(`  [diag] Page title: "${diag.title}"`);
      console.log(`  [diag] No .card-product found — will retry with short wait`);
      // Give it one more chance with a short wait
      try {
        await page.waitForSelector('.card-product', { timeout: 5000 });
      } catch {
        console.log(`  [diag] Still no .card-product — proceeding with fallback`);
      }
    }

    // Scroll to bottom to trigger lazy loading of all content
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 300;
        const timer = setInterval(() => {
          const scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= scrollHeight) {
            clearInterval(timer);
            resolve(true);
          }
        }, 50);
      });
    });
    // Small wait for any remaining lazy-loaded content
    await sleep(1000);

    // Extract card data directly from the DOM using page.evaluate
    const cards = await page.evaluate(() => {
      const results = [];
      const products = document.querySelectorAll('.card-product');
      products.forEach(el => {
        const text = el.textContent.trim();

        // Extract card number
        const numMatch = text.match(/(h[A-Z]{1,3}\d+-\d{2,3})/i);
        if (!numMatch) return;
        const cardNum = numMatch[1];

        // Extract price
        const priceMatch = text.match(/([\d,]+)\s*円/);
        if (!priceMatch) return;
        const price = parseInt(priceMatch[1].replace(/,/g, ''));
        if (isNaN(price) || price <= 0) return;

        // Extract card name
        const lines = text.split('\n').map(l => l.trim()).filter(l => l);
        let name = '';
        let rarity = '';
        const numIdx = lines.findIndex(l => l.match(/h[A-Z]{1,3}\d+-\d{2,3}/i));
        if (numIdx >= 0 && numIdx + 1 < lines.length) {
          // Extract rarity code (e.g. "OUR", "OSR") from the line containing cardNum
          const cardLine = lines[numIdx];
          const rarityMatch = cardLine.match(/h[A-Z]{1,3}\d+-\d{2,3}\s+([A-Z]{2,4})\b/i);
          if (rarityMatch) rarity = rarityMatch[1];
          for (let i = numIdx + 1; i < lines.length; i++) {
            if (!lines[i].match(/[\d,]+\s*円/) && !lines[i].includes('在庫') && !lines[i].includes('カート')) {
              name = lines[i];
              break;
            }
          }
        }

        // If name is still empty, try parsing differently
        if (!name && lines.length > 0) {
          // Try extracting from the line with cardNum
          const cardLine = lines[numIdx >= 0 ? numIdx : 0];
          // Format: "hBP01-001 OSR 天音かなた" → remove cardNum and rarity
          const namePart = cardLine.replace(/h[A-Z]{1,3}\d+-\d{2,3}\s*[A-Z]{2,4}\s*/i, '').trim();
          if (namePart && namePart.length > 1) name = namePart;
        }

        // Extract image URL
        let imageUrl = '';
        const imgs = el.querySelectorAll('img');
        imgs.forEach(img => {
          const src = img.getAttribute('src') || '';
          if (src.includes('card.yuyu-tei.jp')) {
            imageUrl = src;
          }
        });

        // Extract version/cid for backup URL
        const versionInput = el.querySelector('.cart_ver');
        const cidInput = el.querySelector('.cart_cid');
        const version = versionInput ? versionInput.value : '';
        const cardId = cidInput ? cidInput.value : '';

        results.push({
          cardNum,
          sellPrice: price,
          rarity,
          name,
          yuyuImage: imageUrl || (version && cardId ? `https://card.yuyu-tei.jp/hocg/100_140/${version}/${cardId}.jpg` : ''),
          imageVersion: version,
          imageCid: cardId,
        });
      });
      return results;
    });

    return cards;
  } finally {
    await page.close();
  }
}

/**
 * 從 yuyu-tei 爬價格和圖片
 * 先試 Puppeteer，若失敗或結果不足則降級到 HTTP fetch
 */
async function scrapeYuyuPrices() {
  if (process.env.HUNTERCARD_SKIP_YUYU === '1') {
    console.log('[database] HUNTERCARD_SKIP_YUYU=1 — skipping yuyu price scrape');
    return { prices: {}, totalCards: 0, seriesWithPrices: 0, pricingUnavailable: true };
  }

  let usePuppeteer = true;
  let puppeteer;

  // Try to load puppeteer-extra; if unavailable, skip to fetch
  try {
    puppeteer = (await import('puppeteer-extra')).default;
    const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
    puppeteer.use(StealthPlugin());
  } catch (e) {
    console.log(`[database] Puppeteer-extra not available (${e.message}), will use HTTP fetch fallback`);
    usePuppeteer = false;
  }

  const allPrices = {};
  let totalCards = 0;
  let seriesWithPrices = 0;

  const LAUNCH_OPTS = {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  };

  if (usePuppeteer) {
    console.log('[database] Starting yuyu-tei scrape (Puppeteer)...');
    let browser;
    try {
      browser = await puppeteer.launch(LAUNCH_OPTS);
    } catch (e) {
      console.log(`[database] Puppeteer launch failed: ${e.message}. Falling back to HTTP fetch.`);
      usePuppeteer = false;
    }

    if (browser) {
      // Turn a series' scraped cards into allPrices entries. Returns the unique
      // card count for that series.
      const accumulateCards = (cards) => {
        const seriesPrices = {};
        for (const card of cards) {
          const key = card.cardNum;
          if (!seriesPrices[key]) {
            seriesPrices[key] = [];
          }
          seriesPrices[key].push({
            sellPrice: card.sellPrice,
            rarity: card.rarity || '',
            name: card.name,
            yuyuImage: card.yuyuImage,
            imageVersion: card.imageVersion,
            imageCid: card.imageCid,
            timestamp: new Date().toISOString(),
          });
        }
        const count = Object.keys(seriesPrices).length;
        for (const [key, entries] of Object.entries(seriesPrices)) {
          if (!allPrices[key]) allPrices[key] = [];
          allPrices[key].push(...entries);
        }
        return count;
      };

      try {
        for (const seriesInfo of SERIES_PAGES) {
          console.log(`[database] Scraping ${seriesInfo.name}: ${seriesInfo.url}`);

          const url = BASE_URL + seriesInfo.url;

          try {
            // Random delay between series requests (3-5s)
            await sleep(3000 + Math.random() * 2000);

            const cards = await scrapeSeriesPage(browser, url);
            const count = accumulateCards(cards);
            console.log(`  → Found ${count} cards with prices`);
            if (count > 0) seriesWithPrices++;
            totalCards += count;

          } catch (err) {
            // A browser-level crash kills every subsequent series if we keep
            // using the same dead browser object. Detect it, relaunch a fresh
            // browser, and retry the current series once (DIC-442).
            const isCrash = /Protocol error|Connection closed|Target closed|Session closed/i.test(err.message || '');
            if (isCrash) {
              console.log(`  → Browser crashed on ${seriesInfo.name}, relaunching...`);
              try { await browser.close(); } catch (_) { /* already dead */ }
              try {
                browser = await puppeteer.launch(LAUNCH_OPTS);
                const cards = await scrapeSeriesPage(browser, url);
                const count = accumulateCards(cards);
                console.log(`  → Retry OK: found ${count} cards with prices`);
                if (count > 0) seriesWithPrices++;
                totalCards += count;
              } catch (retryErr) {
                console.error(`  → Retry failed: ${retryErr.message}`);
              }
            } else {
              console.error(`  → Error: ${err.message}`);
            }
          }
        }
      } finally {
        if (browser) {
          try { await browser.close(); } catch (_) { /* already closed */ }
        }
      }
    }
  }

  // If puppeteer got too few cards, fall back to HTTP fetch
  if (totalCards < 50) {
    // Reset and try with fetch
    console.log(`\n[database] Puppeteer scrape only got ${totalCards} cards (< 50). Switching to HTTP fetch...`);
    const fetchResult = await scrapeAllWithFetch();
    for (const [key, entries] of Object.entries(fetchResult.prices)) {
            if (!allPrices[key]) allPrices[key] = [];
            allPrices[key].push(...entries);
          }
    totalCards += fetchResult.fetchedCards;
  }

  return { prices: allPrices, totalCards, seriesWithPrices };
}

/**
 * 使用 HTTP fetch + HTML regex 爬取所有系列價格
 */
async function scrapeAllWithFetch() {
  console.log('[fetch] Starting HTTP fetch-based scrape...');
  const allPrices = {};
  let fetchedCards = 0;
  let seriesFetched = 0;

  for (const seriesInfo of SERIES_PAGES) {
    console.log(`[fetch] Fetching ${seriesInfo.name}: ${seriesInfo.url}`);

    const url = BASE_URL + seriesInfo.url;

    try {
      await sleep(3000 + Math.random() * 2000);

      const cards = await scrapeSeriesPageWithFetch(url);

      for (const card of cards) {
        const key = card.cardNum;
        if (!allPrices[key]) {
          allPrices[key] = [];
        }
        allPrices[key].push({
          sellPrice: card.sellPrice,
          rarity: card.rarity || '',
          name: card.name,
          yuyuImage: card.yuyuImage,
          imageVersion: card.imageVersion,
          imageCid: card.imageCid,
          timestamp: new Date().toISOString(),
        });
      }

      const count = Object.keys(allPrices).length;
      console.log(`  → Found ${count} total unique cards (${cards.length} total listings)`);
      if (count > 0) seriesFetched++;
      fetchedCards = Object.keys(allPrices).length;

    } catch (err) {
      console.error(`  → Error: ${err.message}`);
    }
  }

  console.log(`\n[fetch] Done. Total: ${fetchedCards} cards from ${seriesFetched} series`);
  return { prices: allPrices, fetchedCards };
}

/**
 * 下載所有新卡片的圖片
 * 回傳 { downloaded: 新下載數量, skipped: 已存在數量 }
 */
async function downloadAllImages(prices) {
  console.log('\n[database] Downloading images...');
  if (!fs.existsSync(IMAGES_DIR)) {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
  }

  let downloaded = 0;
  let skipped = 0;
  let errors = 0;

  for (const [cardNum, data] of Object.entries(prices)) {
    // data is an array of price variants — find the first one with an image URL
    const entries = Array.isArray(data) ? data : [data];
    let imageUrl = '';
    for (const entry of entries) {
      if (entry.yuyuImage) {
        imageUrl = entry.yuyuImage;
        break;
      }
    }
    if (!imageUrl) {
      errors++;
      continue;
    }

    const destPath = path.join(IMAGES_DIR, `${cardNum}.jpg`);

    try {
      if (fs.existsSync(destPath)) {
        skipped++;
        continue;
      }
      const result = await downloadImage(imageUrl, destPath);
      if (result) {
        downloaded++;
        if (downloaded % 50 === 0) {
          console.log(`  [images] Downloaded ${downloaded} so far...`);
        }
      }
    } catch (err) {
      errors++;
      if (errors <= 5) {
        console.error(`  [images] Failed ${cardNum}: ${err.message}`);
      }
    }
  }

  console.log(`  [images] Downloaded: ${downloaded}, Skipped: ${skipped}, Errors: ${errors}`);
  return { downloaded, skipped, errors };
}

/**
 * 讀取官方資料統合
 * 用 cardNumber_series 複合 key 避免復刻本被覆蓋
 * 每個官方入口都保留，有 yuyu 價格的合併，沒有的顯示「暫無資料」
 */
// Merge scraped skill data (data/effects-jp.json + effects-zh.json) into the
// card map, keyed by cardNumber. Adds `skillsJp` / `skillsZh` to each card that
// has scraped skills. Safe to call when the effects files are absent.
function mergeSkills(cards, prevSkills = new Map()) {
  const readJson = (p) => {
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
    catch (err) { if (err.code !== 'ENOENT') console.warn(`  [skills] ${path.basename(p)}: ${err.message}`); return {}; }
  };
  const effectsJp = readJson(path.join(DATA_DIR, 'effects-jp.json'));
  const effectsZh = readJson(path.join(DATA_DIR, 'effects-zh.json'));
  if (!Object.keys(effectsJp).length) {
    console.log('  [skills] No effects-jp.json found — preserving skills from previous build only');
  }

  let merged = 0, preserved = 0;
  for (const [cardId, card] of Object.entries(cards)) {
    const cn = card.cardNumber;
    const prev = prevSkills.get(cardId);

    // Prefer freshly scraped effects, but fall back to the previous build for
    // either language so a missing/partial effects file never wipes existing
    // skills — the skillsZh regression in DIC-454.
    const jp = (cn && effectsJp[cn]) || prev?.skillsJp;
    const zh = (cn && effectsZh[cn]) || prev?.skillsZh;

    if (jp) card.skillsJp = jp;
    if (zh) card.skillsZh = zh;

    if (cn && effectsJp[cn]) merged++;
    else if (jp || zh) preserved++;
  }
  console.log(`  [skills] Merged skills into ${merged} cards` +
    (preserved ? `, preserved ${preserved} from previous build` : ''));
}

// Canonical Bloom Level overlay: cardNumber → 'Debut' | '1st' | '2nd' | 'Buzz' | 'Spot'.
// Written by scripts/scrape-bloom-levels.mjs from the official card pages'
// <dt>Bloomレベル</dt> field. This is checked in so the field survives even if a
// re-scrape hasn't populated card.bloomLevel yet (DIC-1141).
//
// DIC-1141 CR follow-up — this loader is fail-CLOSED. A missing / malformed /
// empty overlay used to silently degrade back to "every Holomen is called
// Holomen"; now the build refuses to run. The overlay ships in the repo, so
// missing or truncated is a bug, not a graceful case.
export const VALID_BLOOM_LEVELS = Object.freeze(['Debut', '1st', '2nd', 'Buzz', 'Spot']);
const VALID_BLOOM_LEVEL_SET = new Set(VALID_BLOOM_LEVELS);
// Coverage floor. Prior scrapes returned 316 canonical Holomen; new sets can
// only grow. A regression below this floor almost always means the overlay
// was wiped by a broken scrape run, so we fail closed rather than publish a
// database that silently loses badges. Override via BLOOM_MIN_COVERAGE for a
// legitimate shrink (e.g. official removed cards).
const DEFAULT_BLOOM_MIN_COVERAGE = 300;

/**
 * Coerce BLOOM_MIN_COVERAGE from env (or an injected map for tests) to a
 * finite, non-negative integer. Fail closed on NaN, negative, or non-integer —
 * a legitimate operator can still set BLOOM_MIN_COVERAGE=0 to bypass, but a
 * typo like `BLOOM_MIN_COVERAGE=-1` or `BLOOM_MIN_COVERAGE=abc` must never
 * let an empty overlay slip past `validateBloomOverlay` (Codex CR blocker
 * supplement).
 *
 * CR#3: whitespace-only (e.g. `' '`, `'\t\n'`) MUST be treated as unset — a
 * typo like `BLOOM_MIN_COVERAGE=' '` used to coerce to 0 (because `Number(' ')`
 * is 0) and silently disabled the guard.
 */
export function coerceBloomMinCoverage(env = process.env, fallback = DEFAULT_BLOOM_MIN_COVERAGE) {
  const raw = env.BLOOM_MIN_COVERAGE;
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new Error(`[bloom] BLOOM_MIN_COVERAGE must be a non-negative integer, got ${JSON.stringify(raw)}. (DIC-1141)`);
  }
  const trimmed = typeof raw === 'string' ? raw.trim() : String(raw);
  if (trimmed === '') return fallback;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`[bloom] BLOOM_MIN_COVERAGE must be a non-negative integer, got ${JSON.stringify(raw)}. (DIC-1141)`);
  }
  return n;
}

export function validateBloomOverlay(payload, { minCoverage = DEFAULT_BLOOM_MIN_COVERAGE } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'payload is not an object' };
  }
  const by = payload.byCardNumber;
  if (!by || typeof by !== 'object' || Array.isArray(by)) {
    return { ok: false, reason: 'byCardNumber is missing or not an object' };
  }
  const invalid = [];
  for (const [k, v] of Object.entries(by)) {
    // CR#3: reuse the shared canonical card-number validator — a payload of
    // 300 `bogus-0`..`bogus-299` entries used to satisfy the coverage floor
    // because non-empty strings passed. Now every key must match the same
    // ^h[A-Za-z0-9]+-\d{3}$ schema the scraper enforces.
    if (!isCanonicalCardNumber(k)) {
      invalid.push({ key: k, value: v, reason: `card-number does not match ${CANONICAL_CARD_NUMBER_RE}` });
      continue;
    }
    if (typeof v !== 'string' || !VALID_BLOOM_LEVEL_SET.has(v)) {
      invalid.push({ key: k, value: v, reason: 'invalid level' });
    }
  }
  if (invalid.length) {
    return { ok: false, reason: `${invalid.length} invalid entries (first: ${JSON.stringify(invalid[0])})` };
  }
  const count = Object.keys(by).length;
  if (count < minCoverage) {
    return { ok: false, reason: `only ${count} canonical entries — below minimum coverage ${minCoverage}. A wiped overlay indicates a broken scrape run; refusing to publish a database that would silently regress DIC-1141.` };
  }
  return { ok: true, count };
}

function loadBloomLevelOverlay() {
  const p = path.join(DATA_DIR, 'bloom-levels.json');
  if (!fs.existsSync(p)) {
    throw new Error(`[bloom] canonical overlay missing: ${p} — restore data/bloom-levels.json (run scripts/scrape-bloom-levels.mjs) before rebuilding the database. (DIC-1141)`);
  }
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (err) {
    throw new Error(`[bloom] canonical overlay is malformed JSON: ${p}: ${err.message}. (DIC-1141)`);
  }
  // coerceBloomMinCoverage throws on NaN / negative / non-integer overrides so
  // a typo can't downgrade the guard to trivially-passable.
  const minCoverage = coerceBloomMinCoverage();
  const check = validateBloomOverlay(payload, { minCoverage });
  if (!check.ok) {
    throw new Error(`[bloom] canonical overlay validation failed: ${check.reason}. Fix data/bloom-levels.json or set BLOOM_MIN_COVERAGE=<lower> for an intentional shrink. (DIC-1141)`);
  }
  console.log(`  [bloom] Loaded ${check.count} canonical bloom levels (min coverage ${minCoverage})`);
  return payload.byCardNumber;
}

function loadOfficialData() {
  console.log('\n[database] Loading official card data...');
  const officialCards = {};  // { cardNumber_series: cardData }

  if (!fs.existsSync(OFFICIAL_DIR)) {
    console.log('  [official] No official data directory found');
    return officialCards;
  }

  const files = fs.readdirSync(OFFICIAL_DIR).filter(f => f.endsWith('.json'));

  for (const file of files) {
    const filePath = path.join(OFFICIAL_DIR, file);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const cards = JSON.parse(content);
      if (Array.isArray(cards)) {
        for (const card of cards) {
          const imageCardNumber = String(card.imageUrl || '').match(/\/(h[A-Za-z0-9]+-\d{3})(?:_[^/]*)?\.png$/i)?.[1] || '';
          const cardNum = card.cardNumber || imageCardNumber;
          if (!cardNum) continue;
          const series = card.expansion || card.series || '';
          const imageSuffix = String(card.imageUrl || '').match(/\/([^/]+)\.png$/i)?.[1] || '';
          // Use compound keys to preserve all series and all official printings.
          // hEB01 contains many same-card-number variants inside one expansion;
          // those must not overwrite one another or inherit a single old price.
          const baseKey = series ? `${cardNum}_${series}` : cardNum;
          const mustUsePrintingKey = !!card.sourceProduct;
          const printingKey = [baseKey, card.rarity || '', imageSuffix || card.id || ''].filter(Boolean).join('_');
          const makeInfo = () => ({
            name: card.name || '',
            type: card.cardType || card.type || '',
            color: card.color || '',
            rarity: card.rarity || '',
            series: series,
            sourceProduct: card.sourceProduct || series,
            sourceProductName: card.sourceProductName || '',
            sourceProductText: card.sourceProductText || '',
            officialImage: card.imageUrl || '',
            hp: card.hp || '',
            life: card.life || '',
            arts: card.arts || '',
            // Bloom Level (Debut / 1st / 2nd / Buzz / Spot). Only Holomen cards
            // carry this; Oshi/Support/Yell/Mascot leave it empty. Reprinted
            // Holomen may miss the field if the reprint scrape ran before the
            // official page had a Bloomレベル tag — loadBloomLevelOverlay()
            // backfills those from data/bloom-levels.json (DIC-1141).
            bloomLevel: card.bloomLevel || '',
            cardNumber: cardNum,
          });
          if (mustUsePrintingKey) {
            officialCards[printingKey] = makeInfo();
          } else {
            if (officialCards[baseKey] && officialCards[baseKey].officialImage !== (card.imageUrl || '')) {
              const prior = officialCards[baseKey];
              const priorSuffix = String(prior.officialImage || '').match(/\/([^/]+)\.png$/i)?.[1] || '';
              const priorKey = [baseKey, prior.rarity || '', priorSuffix].filter(Boolean).join('_');
              officialCards[priorKey] = prior;
              delete officialCards[baseKey];
            }
            officialCards[officialCards[baseKey] ? printingKey : (officialCards[printingKey] ? printingKey : baseKey)] = makeInfo();
          }
        }
      }
    } catch (err) {
      console.error(`  [official] Error reading ${file}: ${err.message}`);
    }
  }

  // Merge canonical Bloom Level overlay: fill missing bloomLevel and normalize
  // any Holomen entry that lost the field on reprint. Bloom Level is a property
  // of the character card, not a printing, so the same value applies to every
  // (cardNumber, series) copy (DIC-1141).
  const bloomOverlay = loadBloomLevelOverlay();
  let bloomFilled = 0;
  let bloomOverridden = 0;
  for (const info of Object.values(officialCards)) {
    const canonical = bloomOverlay[info.cardNumber];
    if (!canonical) continue;
    if (!info.bloomLevel) {
      info.bloomLevel = canonical;
      bloomFilled++;
    } else if (info.bloomLevel !== canonical) {
      info.bloomLevel = canonical;
      bloomOverridden++;
    }
  }
  if (bloomFilled || bloomOverridden) {
    console.log(`  [bloom] Backfilled ${bloomFilled} cards, overrode ${bloomOverridden} mismatched entries`);
  }

  console.log(`  [official] Loaded ${Object.keys(officialCards).length} cards from ${files.length} files`);
  return officialCards;
}

// ─── VTuber YouTube stats merge (DIC-249) ───

// Turn a channel's raw daily history into the full ytStats object merged onto
// each card. Subscriber/view growth deltas are computed via the shared
// lib/yt-growth.js (same algorithm scrape-yt-stats.js stamps into each
// snapshot). News sentiment counts are read straight from the latest snapshot
// (written there by scrape-news-sentiment.js). Legacy aliases (growth_1d/7d,
// viewCount_daily/weekly/monthly) are kept because src/screens/CardDetailScreen
// reads them — do not drop without updating the UI.
function computeYtGrowth(history) {
  if (!Array.isArray(history) || history.length === 0) return null;
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));

  // The newest snapshot may be a news-only "blank" snapshot (both counts null)
  // that scrape-news-sentiment.js writes on a day scrape-yt-stats didn't run, so
  // read from snapshots that actually carry YT stats (DIC-391). A snapshot is a
  // real YT snapshot if it has EITHER count: scrape-yt-stats.js stamps view-only
  // snapshots (subscriberCount null, totalViewCount set) when YouTube hides the
  // sub count, and those must not be filtered out or their views/view-growth are
  // lost (DIC-398). Subscriber and view figures are resolved independently so a
  // trailing snapshot carrying only one of them can't wipe the other's last
  // known value.
  const withStats = sorted.filter(
    (s) => s.subscriberCount != null || s.totalViewCount != null,
  );
  const latestStats = withStats.length ? withStats[withStats.length - 1] : null;
  const latestSubs = [...withStats].reverse().find((s) => s.subscriberCount != null) ?? null;
  const latestViews = [...withStats].reverse().find((s) => s.totalViewCount != null) ?? null;
  // DIC-1140 blocker #2: compute deltas from the FULL sorted history so
  // computeGrowthDeltas' "latest snapshot" is the true trailing scrape.
  // Feeding it the pre-filtered `withStats` used to hide today's parser
  // failure — if scrape-yt-stats.js produced no counts today, the trailing
  // row got dropped and yesterday's success became the "latest", yielding
  // a numeric delta stamped against today's build date. computeGrowthDeltas
  // now fails closed on that missing current-day evidence (both a null
  // count and any provenance discontinuity).
  const d = computeGrowthDeltas(sorted);

  // News counts come from whichever snapshot the news scraper last stamped,
  // which may be the trailing blank one.
  const withNews = sorted.filter((s) => s.newsCount != null);
  const latestNews = withNews.length ? withNews[withNews.length - 1] : null;

  return {
    subscriberCount: latestSubs?.subscriberCount ?? null,
    totalViewCount: latestViews?.totalViewCount ?? null,
    date: (latestStats ?? sorted[sorted.length - 1]).date,
    channelId: latestSubs?.channelId ?? null,
    source: latestSubs?.source ?? null,
    parser: latestSubs?.parser ?? null,
    fetchedAt: latestSubs?.fetchedAt ?? null,
    subscriberDate: latestSubs?.date ?? null,
    viewChannelId: latestViews?.channelId ?? null,
    viewSource: latestViews?.source ?? null,
    viewParser: latestViews?.parser ?? null,
    viewFetchedAt: latestViews?.fetchedAt ?? null,

    subscriberGrowth_1d: d.subscriberGrowth_1d,
    subscriberGrowth_7d: d.subscriberGrowth_7d,
    subscriberGrowth_15d: d.subscriberGrowth_15d,
    subscriberGrowth_30d: d.subscriberGrowth_30d,
    viewCount_1d: d.viewCount_1d,
    viewCount_7d: d.viewCount_7d,
    viewCount_15d: d.viewCount_15d,
    viewCount_30d: d.viewCount_30d,

    newsCount: latestNews?.newsCount ?? null,
    newsPositive: latestNews?.newsPositive ?? null,
    newsNegative: latestNews?.newsNegative ?? null,

    // Legacy aliases for the existing CardDetailScreen UI.
    growth_1d: d.subscriberGrowth_1d,
    growth_7d: d.subscriberGrowth_7d,
    growth_15d: d.subscriberGrowth_15d,
    growth_30d: d.subscriberGrowth_30d,
    viewCount_daily: d.viewCount_1d,
    viewCount_weekly: d.viewCount_7d,
    viewCount_monthly: d.viewCount_30d,
  };
}

/**
 * Merge the latest VTuber YouTube stats (subscriber/view counts + growth) onto
 * each card whose character matches a tracked hololive member. Matching is by
 * Japanese name (card.name === member.nameJp) with Chinese name as fallback.
 * yt-stats-history.json is keyed by channelId; yt-members.json maps channelId →
 * member names. No-op (with a warning) if either file is missing/empty — the
 * scraper (scrape-yt-stats.js) may not have run yet on a fresh checkout.
 */
function mergeYtStats(database) {
  let members;
  let statsHistory;
  try {
    members = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'yt-members.json'), 'utf-8')).members || [];
  } catch (err) {
    console.warn(`  [yt-stats] Skipping merge — cannot read yt-members.json (${err.message})`);
    return;
  }
  try {
    statsHistory = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'yt-stats-history.json'), 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.warn('  [yt-stats] Skipping merge — yt-stats-history.json not found (run scrape-yt-stats.js first)');
    } else {
      console.warn(`  [yt-stats] Skipping merge — cannot read yt-stats-history.json (${err.message})`);
    }
    return;
  }

  // channelId → computed stats
  const statsByChannel = {};
  for (const [channelId, entry] of Object.entries(statsHistory)) {
    const stats = computeYtGrowth(entry.history);
    if (stats) statsByChannel[channelId] = stats;
  }

  // name (jp/zh) → stats, via the members channelId mapping
  const statsByNameJp = {};
  const statsByNameZh = {};
  for (const m of members) {
    const stats = m.channelId && statsByChannel[m.channelId];
    if (!stats) continue;
    if (m.nameJp && !statsByNameJp[m.nameJp]) statsByNameJp[m.nameJp] = stats;
    if (m.nameZh && !statsByNameZh[m.nameZh]) statsByNameZh[m.nameZh] = stats;
    // Cards sometimes use a name variant that differs from the canonical
    // nameJp/nameZh (e.g. 儒烏風亭らでん vs 火威青). altNames let a member
    // claim those variants so ytStats still merge.
    for (const alt of m.altNamesJp || []) {
      if (alt && !statsByNameJp[alt]) statsByNameJp[alt] = stats;
    }
    for (const alt of m.altNamesZh || []) {
      if (alt && !statsByNameZh[alt]) statsByNameZh[alt] = stats;
    }
  }

  let merged = 0;
  for (const card of Object.values(database.cards)) {
    const stats =
      (card.name && statsByNameJp[card.name.trim()]) ||
      (card.nameZh && statsByNameZh[card.nameZh.trim()]) ||
      null;
    if (stats) {
      card.ytStats = stats;
      merged++;
    }
  }
  console.log(
    `  [yt-stats] Merged stats onto ${merged} cards ` +
      `(${Object.keys(statsByChannel).length} channels tracked)`
  );
}

/**
 * 主流程
 */
async function buildDatabase() {
  const startTime = Date.now();
  console.log('═══════════════════════════════════════');
  console.log('  hunterCard Database Builder');
  console.log('═══════════════════════════════════════\n');

  // Ensure directories
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

  // Capture the previous build's buyPrice / buyPriceHistory before we overwrite
  // database.json. Unlike priceHistory (persisted to per-card files in
  // data/price-history/), buy prices live ONLY inside database.json. A fresh
  // rebuild wipes them, and merge-buy-prices.js (run afterward) only re-adds
  // TODAY's value — so without this preservation buyPriceHistory could never
  // accumulate past one day, and any day merge-buy-prices fails to run would
  // drop buyPrice from the committed database entirely (DIC-236).
  const prevBuyByCardId = new Map();
  try {
    const prevDb = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8'));
    for (const [cardId, card] of Object.entries(prevDb.cards || {})) {
      const saved = {};
      if (Number.isFinite(card.buyPrice) && card.buyPrice > 0) saved.buyPrice = card.buyPrice;
      if (card.buyPriceHistory && typeof card.buyPriceHistory === 'object' &&
          Object.keys(card.buyPriceHistory).length > 0) {
        saved.buyPriceHistory = card.buyPriceHistory;
      }
      // Per-version buy prices (DIC-856) also live only in database.json → preserve them
      // by EXACT canonical variant key (cardNumber|class|token) so a build-only pass (no merge
      // afterward) keeps version alignment. Keys that collide within a card (e.g. two identical
      // (パラレル) variants — hBP02-017) are ambiguous, so we drop them rather than let one
      // variant's price leak onto its twin; merge-buy-prices.js re-derives those from source.
      // Since DIC-856 follow-up each variant's buy price also carries its provenance
      // (buyPriceVersion / buyPriceSource / buyPriceTimestamp) so the reading layer never has
      // to re-guess which version a price belongs to — preserve those fields too.
      if (Array.isArray(card.prices)) {
        const variantBuy = {};
        const seenKey = new Set();
        const dupKey = new Set();
        for (const v of card.prices) {
          if (!v || !Number.isFinite(v.buyPrice) || v.buyPrice <= 0) continue;
          const key = canonicalVariantKey(card.cardNumber, v.name);
          if (seenKey.has(key)) { dupKey.add(key); continue; }
          seenKey.add(key);
          variantBuy[key] = {
            price: v.buyPrice,
            version: v.buyPriceVersion,
            source: v.buyPriceSource,
            timestamp: v.buyPriceTimestamp,
          };
        }
        for (const k of dupKey) delete variantBuy[k];
        if (Object.keys(variantBuy).length > 0) saved.variantBuy = variantBuy;
      }
      if (Object.keys(saved).length > 0) prevBuyByCardId.set(cardId, saved);
    }
    if (prevBuyByCardId.size > 0) {
      console.log(`  [buyPrice] Preserving buy prices for ${prevBuyByCardId.size} cards from previous build`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`  [buyPrice] Could not read previous database for buyPrice preservation: ${err.message}`);
    }
  }

  // Capture the previous build's skillsJp / skillsZh so a rebuild can fall back
  // to them when the scraped effects files lack an entry. A fresh rebuild
  // re-derives skills only from data/effects-jp.json + effects-zh.json; if a
  // build ever runs with effects-zh.json empty/partial while effects-jp.json is
  // present, affected cards keep skillsJp but lose skillsZh and the app falls
  // back to Japanese in zh mode (DIC-454). Preserving prior skills stops that
  // regression from silently wiping translations.
  const prevSkillsByCardId = new Map();
  try {
    const prevDb = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8'));
    for (const [cardId, card] of Object.entries(prevDb.cards || {})) {
      const saved = {};
      if (card.skillsJp && typeof card.skillsJp === 'object') saved.skillsJp = card.skillsJp;
      if (card.skillsZh && typeof card.skillsZh === 'object') saved.skillsZh = card.skillsZh;
      if (Object.keys(saved).length > 0) prevSkillsByCardId.set(cardId, saved);
    }
    if (prevSkillsByCardId.size > 0) {
      console.log(`  [skills] Preserving skills for ${prevSkillsByCardId.size} cards from previous build`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`  [skills] Could not read previous database for skill preservation: ${err.message}`);
    }
  }

  // Step 1: Scrape yuyu-tei with Puppeteer + anti-detection (fallback to HTTP fetch).
  // Official catalog ingestion is intentionally decoupled from yuyu pricing: if
  // yuyu is WAF-blocked/403 and returns 0 cards, new official printings still
  // build and ship with null/unknown prices instead of blocking the catalog.
  console.log('── Step 1: Scrape yuyu-tei ──');
  let yuyuResult;
  try {
    yuyuResult = await scrapeYuyuPrices();
  } catch (err) {
    console.warn(`[database] yuyu scrape failed (${err.message}); continuing official catalog build with null prices`);
    yuyuResult = { prices: {}, totalCards: 0, seriesWithPrices: 0, pricingUnavailable: true };
  }

  const { prices, totalCards, seriesWithPrices } = yuyuResult;
  console.log(`\n  Total cards from yuyu-tei: ${totalCards}`);
  if (totalCards < 50) {
    console.warn(`[database] yuyu pricing unavailable or incomplete (totalCards=${totalCards}); official cards will retain null sellPrice/prices`);
  }

  // Step 2: Download images
  console.log('\n── Step 2: Download images ──');
  const dlResult = await downloadAllImages(prices);

  // Step 3: Load official data
  console.log('\n── Step 3: Merge official data ──');
  const officialCards = loadOfficialData();

  // Step 4: Build unified database
  console.log('\n── Step 4: Build unified database ──');
  const database = {
    lastUpdated: new Date().toISOString(),
    totalCards: totalCards,
    source: 'hunterCard unified database',
    cards: {},
  };

  // Build a reverse lookup: cardNum → array of official entries (for merging)
  const officialByCardNum = {};
  for (const [key, info] of Object.entries(officialCards)) {
    const base = info.cardNumber || '';
    if (base) {
      if (!officialByCardNum[base]) officialByCardNum[base] = [];
      officialByCardNum[base].push(info);
    }
  }

  // Deduplicate price entries: same (name, sellPrice) = same version, keep first occurrence only
  function deduplicatePrices(entries) {
    const seen = new Set();
    return entries.filter(e => {
      const key = `${e.name || ''}|${e.sellPrice || 0}|${e.rarity || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Helper: resolve yuyu price data for a card number
  function getYuyuForCard(cardNum) {
    const priceData = prices[cardNum];
    if (!priceData) return null;
    const rawEntries = Array.isArray(priceData) ? priceData : [priceData];
    const priceEntries = deduplicatePrices(rawEntries);
    let lowestPrice = null;
    let lowestName = '';
    let firstImage = '';
    let firstTimestamp = new Date().toISOString();
    for (const entry of priceEntries) {
      if (!firstImage && entry.yuyuImage) firstImage = entry.yuyuImage;
      if (entry.timestamp) firstTimestamp = entry.timestamp;
      if (entry.sellPrice && (lowestPrice === null || entry.sellPrice < lowestPrice)) {
        lowestPrice = entry.sellPrice;
        lowestName = entry.name || '';
      }
    }
    return {
      lowestPrice,
      lowestName,
      firstImage,
      firstTimestamp,
      priceEntries,
    };
  }

  // Process ALL official entries (compound keys preserve reprints across series)
  for (const [key, official] of Object.entries(officialCards)) {
    const baseCardNum = official.cardNumber || '';
    const yuyu = getYuyuForCard(baseCardNum);

    const rawEntries = yuyu ? yuyu.priceEntries.map(e => ({
      name: e.name || '',
      sellPrice: e.sellPrice || null,
      rarity: e.rarity || '',
      imageUrl: e.yuyuImage || undefined,
    })) : [];
    // DIC-1139: user-facing prices[] never carries source-maintenance errata
    // history. When both `エラッタ前` and `エラッタ後` exist in the same tier,
    // keep only the corrected row; raw rows survive internally on
    // `_rawPricesArchive` for audit but are not rendered.
    const { canonical, archive } = canonicalizePrices(rawEntries);
    const cleanYuyuName = canonicalYuyuName(yuyu ? yuyu.lowestName : '');
    // DIC-1140 blocker #1: the top-level image must come from a CANONICAL row
    // — never from the raw first-seen listing which is often the pre-errata
    // signed image on a card the top-level name calls "base" (hBP02-003 was
    // shipping 10008.jpg / signed / pre-errata while yuyuName said 宝鐘マリン).
    const cleanYuyuImage = canonicalYuyuImage(canonical, cleanYuyuName, yuyu ? yuyu.firstImage : '');

    database.cards[key] = {
      id: key,
      cardNumber: baseCardNum,
      name: official.name || (yuyu ? yuyu.lowestName : '') || '',
      type: official.type || '',
      color: official.color || '',
      rarity: official.rarity || '',
      series: official.series || '',
      sourceProduct: official.sourceProduct || official.series || '',
      sourceProductName: official.sourceProductName || '',
      sourceProductText: official.sourceProductText || '',
      sellPrice: yuyu ? yuyu.lowestPrice : null,
      yuyuName: cleanYuyuName,
      yuyuImage: cleanYuyuImage,
      prices: canonical,
      officialImage: official.officialImage || '',
      localImage: fs.existsSync(path.join(IMAGES_DIR, `${baseCardNum}.jpg`)) ? `/images/${baseCardNum}.jpg` : '',
      hp: official.hp || '',
      life: official.life || '',
      arts: official.arts || '',
      // Canonical Bloom Level for Holomen (Debut / 1st / 2nd / Buzz / Spot).
      // Non-holomen cards leave this empty; the UI never renders empty as
      // "Holomen" (see cardNormalization.ts + DIC-1141).
      bloomLevel: official.bloomLevel || '',
      timestamp: yuyu ? yuyu.firstTimestamp : '',
      _rawPricesArchive: archive,
    };
  }

  // Also add yuyu-only cards (prices without matching official entry)
  for (const [cardNum, priceData] of Object.entries(prices)) {
    const alreadyExists = Object.keys(database.cards).some(k => {
      const info = database.cards[k];
      return info.cardNumber === cardNum;
    });
    if (alreadyExists) continue;

    const priceEntries = deduplicatePrices(Array.isArray(priceData) ? priceData : [priceData]);
    let lowestPrice = null;
    let lowestName = '';
    let firstImage = '';
    let firstTimestamp = new Date().toISOString();
    for (const entry of priceEntries) {
      if (!firstImage && entry.yuyuImage) firstImage = entry.yuyuImage;
      if (entry.timestamp) firstTimestamp = entry.timestamp;
      if (entry.sellPrice && (lowestPrice === null || entry.sellPrice < lowestPrice)) {
        lowestPrice = entry.sellPrice;
        lowestName = entry.name || '';
      }
    }

    const rawEntries = priceEntries.map(e => ({
      name: e.name || '',
      sellPrice: e.sellPrice || null,
      rarity: e.rarity || '',
      imageUrl: e.yuyuImage || undefined,
    }));
    // Same canonicalisation as the official-cards branch (DIC-1139): the
    // yuyu-only fallback must also hide errata history and archive the raw
    // rows for internal audit.
    const { canonical, archive } = canonicalizePrices(rawEntries);
    const cleanYuyuName = canonicalYuyuName(lowestName);
    const cleanYuyuImage = canonicalYuyuImage(canonical, cleanYuyuName, firstImage);

    database.cards[cardNum] = {
      id: cardNum,
      cardNumber: cardNum,
      name: lowestName || '',
      type: '',
      color: '',
      rarity: '',
      series: '',
      sellPrice: lowestPrice,
      yuyuName: cleanYuyuName,
      yuyuImage: cleanYuyuImage,
      prices: canonical,
      officialImage: '',
      localImage: fs.existsSync(path.join(IMAGES_DIR, `${cardNum}.jpg`)) ? `/images/${cardNum}.jpg` : '',
      hp: '',
      life: '',
      arts: '',
      timestamp: firstTimestamp,
      _rawPricesArchive: archive,
    };
  }

  // Step 4b: Merge scraped card skills (Japanese + Chinese) by cardNumber,
  // preserving any skills from the previous build the effects files no longer supply.
  mergeSkills(database.cards, prevSkillsByCardId);

  // Fix totalCards to reflect actual unique cards
  database.totalCards = Object.keys(database.cards).length;

  // Write database.json
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(database, null, 2)}\n`, 'utf-8');

  // Add Chinese names to cards
  await addZhNames(OUTPUT_PATH);

  // addZhNames only writes nameZh to the file, not the in-memory `database`
  // object. Sync it back so Step 5 (history) and Step 6 (re-write) preserve nameZh.
  try {
    const withZh = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8'));
    for (const [cardId, card] of Object.entries(database.cards)) {
      if (withZh.cards?.[cardId]?.nameZh !== undefined) {
        card.nameZh = withZh.cards[cardId].nameZh;
      }
    }
  } catch (err) {
    console.warn(`  [nameZh] Failed to sync nameZh from file: ${err.message}`);
  }

  // Step 5: Save daily price history
  console.log('\n── Step 5: Save price history ──');
  const today = new Date().toISOString().split('T')[0];
  const historyDir = path.join(DATA_DIR, 'price-history');
  fs.mkdirSync(historyDir, { recursive: true });

  // Collect price records from all cards
  const priceRecords = [];
  for (const [cardId, card] of Object.entries(database.cards)) {
    if (card.sellPrice != null && card.sellPrice > 0) {
      priceRecords.push({
        date: today,
        price: card.sellPrice,
        source: 'yuyu-tei',
        currency: 'JPY',
        cardId,
      });
    }
  }

  // Group by cardId and write history files
  const groupedRecords = {};
  for (const r of priceRecords) {
    if (!groupedRecords[r.cardId]) groupedRecords[r.cardId] = [];
    groupedRecords[r.cardId].push(r);
  }

  let totalSaved = 0;
  for (const [cardId, newRecords] of Object.entries(groupedRecords)) {
    const filePath = path.join(historyDir, `${cardId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
    let existing = { cardId, cardNumber: '', name: '', records: [], lastUpdated: '' };
    try {
      existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      // new file
    }

    const existingDates = new Set(existing.records.map(r => r.date));
    const existingPrices = existing.records.map(r => r.price).filter(p => p && p > 0).sort((a, b) => a - b);
    const existingMedian = existingPrices.length >= 3
      ? existingPrices[Math.floor(existingPrices.length / 2)]
      : null;

    for (const nr of newRecords) {
      if (!existingDates.has(nr.date)) {
        if (existingMedian && nr.price > existingMedian * 5) {
          console.warn(`[sanitize] 跳過異常價格記錄：${nr.cardId} ${nr.date} ¥${nr.price}（現有中位數 ¥${existingMedian}）`);
          continue;
        }
        existing.records.push(nr);
        totalSaved++;
      }
    }

    existing.records.sort((a, b) => a.date.localeCompare(b.date));
    existing.lastUpdated = new Date().toISOString();

    // Fill in card details from database
    const cardInfo = database.cards[cardId];
    if (cardInfo) {
      existing.cardNumber = cardInfo.cardNumber || '';
      existing.name = cardInfo.name || '';
      existing.nameZh = cardInfo.nameZh || '';
    }

    fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
  }

  // Build/update index by scanning ALL history files, not just this run's cards,
  // so totalCards/totalRecords reflect the full accumulated history. cardIds use
  // the sanitized filename to match src/services/priceHistory.ts (rebuildIndex).
  const indexCardIds = [];
  let indexTotalRecords = 0;
  for (const file of fs.readdirSync(historyDir)) {
    if (!file.endsWith('.json') || file === 'index.json') continue;
    indexCardIds.push(file.replace('.json', ''));
    try {
      const hist = JSON.parse(fs.readFileSync(path.join(historyDir, file), 'utf-8'));
      indexTotalRecords += hist.records?.length || 0;
    } catch {
      // skip corrupted file
    }
  }
  const index = {
    lastUpdated: new Date().toISOString(),
    totalCards: indexCardIds.length,
    totalRecords: indexTotalRecords,
    cardIds: indexCardIds,
  };
  fs.writeFileSync(path.join(historyDir, 'index.json'), JSON.stringify(index, null, 2));

  console.log(`  [price-history] Saved ${totalSaved} new records; index totals: ${indexCardIds.length} cards / ${indexTotalRecords} records`);

  // Step 6: Merge priceHistory back into database cards
  console.log('\n── Step 6: Merge priceHistory into database ──');
  let mergedCount = 0;
  for (const [cardId, card] of Object.entries(database.cards)) {
    const histFile = path.join(historyDir, `${cardId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
    try {
      const hist = JSON.parse(fs.readFileSync(histFile, 'utf-8'));
      if (hist.records && hist.records.length > 0) {
        const ph = {};
        for (const r of hist.records) {
          ph[r.date] = r.price;
        }
        card.priceHistory = sanitizePriceHistory(ph);
        mergedCount++;
      }
    } catch {
      // no history file for this card, skip
    }
  }
  console.log(`  [priceHistory] Merged into ${mergedCount} cards`);

  // Step 6b: Restore preserved buyPrice / buyPriceHistory onto the rebuilt cards
  // so they survive the from-scratch rebuild. merge-buy-prices.js runs after this
  // in the pipeline and layers today's fresh buy prices on top (DIC-236).
  let buyRestored = 0;
  for (const [cardId, saved] of prevBuyByCardId.entries()) {
    const card = database.cards[cardId];
    if (!card) continue; // card no longer exists in the rebuilt database
    if (saved.buyPrice != null) card.buyPrice = saved.buyPrice;
    if (saved.buyPriceHistory != null) card.buyPriceHistory = saved.buyPriceHistory;
    if (saved.variantBuy && Array.isArray(card.prices)) {
      // Only restore onto variants whose canonical key is unique in the rebuilt card, so an
      // ambiguous (duplicate-key) variant never inherits another version's preserved price.
      const keyCount = new Map();
      for (const v of card.prices) {
        const k = canonicalVariantKey(card.cardNumber, v.name);
        keyCount.set(k, (keyCount.get(k) || 0) + 1);
      }
      for (const v of card.prices) {
        const k = canonicalVariantKey(card.cardNumber, v.name);
        if (keyCount.get(k) !== 1) continue;
        const bp = saved.variantBuy[k];
        if (bp != null) {
          v.buyPrice = bp.price;
          if (bp.version != null) v.buyPriceVersion = bp.version;
          else delete v.buyPriceVersion;
          if (bp.source != null) v.buyPriceSource = bp.source;
          else delete v.buyPriceSource;
          if (bp.timestamp != null) v.buyPriceTimestamp = bp.timestamp;
          else delete v.buyPriceTimestamp;
        }
      }
    }
    buyRestored++;
  }
  console.log(`  [buyPrice] Restored buy prices onto ${buyRestored} cards`);

  // Step 7: Merge VTuber YouTube stats (subscriber/view counts + growth) (DIC-249)
  console.log('\n── Step 7: Merge VTuber YouTube stats ──');
  mergeYtStats(database);

  // Re-write database.json with priceHistory + preserved buyPrice included
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(database, null, 2)}\n`);

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n═══════════════════════════════════════`);
  console.log(`  ✅ Build complete!`);
  console.log(`  Total cards: ${database.totalCards}`);
  console.log(`  Cards with prices: ${Object.keys(prices).length}`);
  console.log(`  Images downloaded: ${dlResult.downloaded}`);
  console.log(`  Duration: ${duration}s`);
  console.log(`  Output: ${OUTPUT_PATH}`);
  console.log(`═══════════════════════════════════════`);

  return {
    totalCards: database.totalCards,
    yuyuCount: Object.keys(prices).length,
    officialCount: Object.keys(officialCards).length,
    imagesDownloaded: dlResult.downloaded,
    duration: parseFloat(duration),
  };
}

// Run if called directly
if (process.argv[1]?.includes('build-database')) {
  buildDatabase()
    .then(result => {
      console.log('\nBuild result:', JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch(err => {
      console.error('\n❌ Build failed:', err.message);
      console.error(err.stack);
      process.exit(1);
    });
}

export { buildDatabase, mergeYtStats, computeYtGrowth, mergeSkills };
