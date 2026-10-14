import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

puppeteer.use(StealthPlugin());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
// hCO02 / hCO03 (エクストリーマーカップ25-26 Final オフィシャルホロカコレクションA / B,
// first synced 2026-10-13): yuyu-tei listed no such product when checked read-only
// 2026-10-14T16:14–16:17Z — the hocg product navigation (38 vers[] entries) had no
// コレクションA/B / Final entry, and the card-number searches for all 12 printings
// returned only their hBP/hSD/hEB01/promo siblings — yuyu labels collection-set
// printings explicitly (e.g. ohc02 "(パラレル/2025ライブセット)"), and none says
// コレクションA/B. Re-check and map to the real page once yuyu adds the product.
// Sibling listings cannot leak in: yuyuEntryMatchesOfficial requires the listing's
// sourceSeries to equal the printing's own product.
const NO_PAGE_SERIES = new Set(['hCO01', 'hCO02', 'hCO03', 'hWF01']);

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
      console.warn(`[warn] 未知系列 "${series}" — 無對應 yuyu-tei URL，跳過`);
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

async function run() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  // allPrices[cardNum] = [{ sellPrice, rarity, name }]
  const allPrices = {};
  let totalListings = 0;

  for (const s of SERIES_PAGES) {
    console.log('Scraping', s.name);
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(30000);
      await page.goto('https://yuyu-tei.jp' + s.url, { waitUntil: 'networkidle0' });
      await new Promise(r => setTimeout(r, 2000));

      // Aggressive scroll to trigger ALL lazy loads
      await page.evaluate(async () => {
        let prevHeight = 0;
        for (let i = 0; i < 30; i++) {
          window.scrollBy(0, 1000);
          await new Promise(r => setTimeout(r, 400));
          const newHeight = document.body.scrollHeight;
          if (newHeight === prevHeight && i > 5) break;
          prevHeight = newHeight;
        }
      });
      await new Promise(r => setTimeout(r, 500));

      const results = await page.evaluate(() => {
        const r = [];
        const items = document.querySelectorAll('.card-product');
        items.forEach(el => {
          const text = el.textContent.trim();
          const numMatch = text.match(/(h[A-Z]{1,3}\d+-\d{2,3})/i);
          if (!numMatch) return;
          const cardNum = numMatch[1];

          const priceMatch = text.match(/([\d,]+)\s*円/);
          if (!priceMatch) return;
          const price = parseInt(priceMatch[1].replace(/,/g, ''));
          if (isNaN(price) || price <= 0) return;

          // Try to find rarity code
          const lines = text.split('\n').map(l => l.trim()).filter(l => l);
          let name = '';
          let rarity = '';
          const numIdx = lines.findIndex(l => l.match(/h[A-Z]{1,3}\d+-\d{2,3}/i));
          if (numIdx >= 0) {
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
          if (!name && lines.length > 0) {
            const cardLine = lines[numIdx >= 0 ? numIdx : 0];
            const namePart = cardLine.replace(/h[A-Z]{1,3}\d+-\d{2,3}\s*[A-Z]{2,4}\s*/i, '').trim();
            if (namePart && namePart.length > 1) name = namePart;
          }

          r.push({ cardNum, price, rarity, name });
        });
        return r;
      });

      console.log('  → Found', results.length, 'listings');
      totalListings += results.length;

      for (const r of results) {
        if (!allPrices[r.cardNum]) allPrices[r.cardNum] = [];
        // Only add if this price+rarity combo is new
        const exists = allPrices[r.cardNum].some(p => p.sellPrice === r.price && p.rarity === r.rarity);
        if (!exists) {
          allPrices[r.cardNum].push({
            sellPrice: r.price,
            rarity: r.rarity || '',
            name: r.name || '',
            timestamp: new Date().toISOString(),
          });
        }
      }

      await page.close();
    } catch (e) {
      console.log('  Error:', e.message);
    }
  }

  await browser.close();

  // Stats
  let multiCount = 0;
  let totalUnique = Object.keys(allPrices).length;
  for (const [k, v] of Object.entries(allPrices)) {
    if (v.length > 1) multiCount++;
  }
  console.log('\n=== RESULTS ===');
  console.log('Total unique cards:', totalUnique);
  console.log('Total listings:', totalListings);
  console.log('Multi-price cards:', multiCount);

  // Show hBP04-005
  const h04_5 = allPrices['hBP04-005'] || [];
  console.log('hBP04-005 prices:', h04_5.length, 'variants');
  h04_5.forEach(p => console.log('  ¥' + p.sellPrice.toLocaleString(), p.rarity ? '[' + p.rarity + ']' : '', p.name));

  // Save for debugging
  fs.writeFileSync('prices_fix.json', JSON.stringify(allPrices, null, 2));
  console.log('\nSaved to prices_fix.json');
}

run().catch(e => { console.error(e); process.exit(1); });
