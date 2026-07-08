/**
 * Scraper for yuyu-tei.jp hOCG card sell prices
 * Runs daily at 5:00 AM to fetch current sell prices
 * 
 * Page structure: .card-product elements with price in "XX,XXX 円" format
 */
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = 'https://yuyu-tei.jp';
const OUTPUT_DIR = path.join(__dirname, '../data/yuyu-prices');

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
    db = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/database.json'), 'utf-8'));
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
      // hBP04 has a dedicated page; others use search
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

  // Sort each group by name
  const sortByName = (a, b) => a.name.localeCompare(b.name);
  hbpSeries.sort(sortByName);
  hsdSeries.sort(sortByName);
  hysSeries.sort(sortByName);
  specialSeries.sort(sortByName);

  return [...hbpSeries, ...hsdSeries, ...hysSeries, ...specialSeries];
}

const SERIES_PAGES = generateSeriesPages();

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function launchBrowser() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();

  page.on('console', msg => {
    const text = msg.text();
    console.log(`[browser] ${text}`);
  });
  page.on('pageerror', err => {
    console.error(`[browser-error] ${err.message}`);
  });

  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  return { browser, page };
}

async function scrapeYuyuPrices() {
  console.log('[yuyu-scraper] Starting price scrape...');
  const startTime = Date.now();

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  let { browser, page } = await launchBrowser();

  const allPrices = {};
  let totalCards = 0;
  let seriesWithPrices = 0;
  let savePath;

  try {
    for (const seriesInfo of SERIES_PAGES) {
      console.log(`[yuyu-scraper] Scraping ${seriesInfo.name}: ${seriesInfo.url}`);

      const url = BASE_URL + seriesInfo.url;
      const MAX_RETRIES = 2;

      for (let retries = 0; retries <= MAX_RETRIES; retries++) {
        try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        await sleep(1500);

        // [Diagnostic] Check HTML structure — helps debug 0-card issues in CI
        const htmlDiag = await page.evaluate(() => {
          return {
            title: document.title || '',
            bodyLen: document.body?.innerHTML?.length || 0,
            bodyTextLen: document.body?.innerText?.length || 0,
            cardProductCount: document.querySelectorAll('.card-product').length,
            otherSelectors: {
              itemList: document.querySelectorAll('.item-list').length,
              productList: document.querySelectorAll('.product-list').length,
              cardItem: document.querySelectorAll('.card-item').length,
              product: document.querySelectorAll('.product').length,
            },
          };
        });
        console.log(`  [diag] Page title: "${htmlDiag.title}"`);
        console.log(`  [diag] Body HTML length: ${htmlDiag.bodyLen}, text length: ${htmlDiag.bodyTextLen}`);
        console.log(`  [diag] .card-product element count on page: ${htmlDiag.cardProductCount}`);
        console.log(`  [diag] Other selector counts: ${JSON.stringify(htmlDiag.otherSelectors)}`);
        if (htmlDiag.cardProductCount === 0) {
          const bodyPreview = await page.evaluate(() => {
            const txt = document.body?.innerText || '';
            return txt.substring(0, 500);
          });
          console.log(`  [diag-warn] ZERO .card-product — body text preview (500 chars):`);
          console.log(`  [diag-warn] ${bodyPreview.replace(/\n/g, '\\n')}`);
        }

        console.log(`  [diag] Entering page.evaluate for ${seriesInfo.name}...`);

        // Extract prices using the correct selectors
        const seriesPrices = await page.evaluate(() => {
          const results = {};
          
          // yuyu-tei uses .card-product for individual card listings
          const productCards = document.querySelectorAll('.card-product');

          productCards.forEach(card => {
            const text = card.textContent?.trim() || '';
            
            // Extract card number (e.g., hBP04-001)
            const numMatch = text.match(/(h[A-Z]{1,3}\d+-\d{2,3})/i);
            if (!numMatch) return;
            
            const cardNum = numMatch[1];  // Keep original case
            
            // Extract price (e.g., 99,800 円)
            const priceMatch = text.match(/([\d,]+)\s*円/);
            if (!priceMatch) return;
            
            const price = parseInt(priceMatch[1].replace(/,/g, ''));
            if (isNaN(price) || price <= 0) return;

            // Extract card name (line after card number)
            const lines = text.split('\n').map(l => l.trim()).filter(l => l);
            let name = '';
            const numIdx = lines.findIndex(l => l.match(/h[A-Z]{1,3}\d+-\d{2,3}/i));
            if (numIdx >= 0 && numIdx + 1 < lines.length) {
              // Skip lines that are prices or stock info
              for (let i = numIdx + 1; i < lines.length; i++) {
                if (!lines[i].match(/[\d,]+\s*円/) && !lines[i].includes('在庫') && !lines[i].includes('カート')) {
                  name = lines[i];
                  break;
                }
              }
            }

            results[cardNum] = {
              sellPrice: price,
              name: name,
              timestamp: new Date().toISOString(),
            };
          });

          return results;
        });

        const count = Object.keys(seriesPrices).length;
        console.log(`  → Found ${count} cards with prices`);
        
        if (count > 0) {
          seriesWithPrices++;
        }
        totalCards += count;

        // Merge prices
        Object.assign(allPrices, seriesPrices);

        // Rate limiting
        await sleep(2000 + Math.random() * 1000);

        break;
      } catch (err) {
        const crashPatterns = ['Protocol error', 'Target closed', 'Session closed', 'Connection closed'];
        const isCrash = crashPatterns.some(p => err.message.includes(p));

        if (isCrash && retries < MAX_RETRIES) {
          console.log(`[yuyu-scraper] Browser crashed, restarting... (retry ${retries + 1}/${MAX_RETRIES} for ${seriesInfo.name})`);
          try { await browser.close(); } catch {}
          ({ browser, page } = await launchBrowser());
        } else {
          console.error(`  → Error: ${err.message}`);
          break;
        }
      }
    }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    // Save results - outputFile already declared in outer scope
    savePath = path.join(OUTPUT_DIR, 'yuyu-prices.json');
    const metadata = {
      lastUpdated: new Date().toISOString(),
      totalCards,
      seriesWithPrices,
      durationSeconds: parseFloat(duration),
      source: 'yuyu-tei.jp',
    };

    fs.writeFileSync(savePath, JSON.stringify({ ...metadata, prices: allPrices }, null, 2, 'utf-8'));
    console.log(`\n[yuyu-scraper] ✅ Complete! Saved ${totalCards} prices from ${seriesWithPrices} series in ${duration}s`);
    console.log(`[yuyu-scraper] Output: ${savePath}`);

  } catch (error) {
    console.error('[yuyu-scraper] Fatal error:', error);
  } finally {
    try { await browser.close(); } catch {}
  }

  return { totalCards, seriesWithPrices, outputFile: savePath };
}

// Run if called directly
const isMainModule = process.argv[1] && process.argv[1].includes('scrape-yuyu-prices');

if (isMainModule) {
  scrapeYuyuPrices()
    .then(result => {
      console.log('\nScrape completed:', result);
      process.exit(0);
    })
    .catch(err => {
      console.error('Scrape failed:', err);
      process.exit(1);
    });
}

export { scrapeYuyuPrices };
