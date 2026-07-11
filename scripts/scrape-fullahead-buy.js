/**
 * scrape-fullahead-buy.js — hololive OCG 回收（買取）價格爬蟲 (Fullahead)
 *
 * DIC-155: 輸出 data/buy-prices/fullahead-prices.json
 *   格式: { "hBP01-001": { "buyPrice": 500, "timestamp": "..." }, ... }
 *
 * Fullahead 頁面結構（已查證）：買取站是 https://fullahead-buy.com/，hololive OCG
 * 的價格不在靜態 HTML，而是由頁面 JS 打內部 API `fetchRecords.php?app=38` 取得。
 * 因此用 Puppeteer 載入 landing page，攔截該請求拿到 apiToken，再在頁面內用
 * fetch 直接分頁抓完所有 records。商品名例如「【UR】hBP01-091 ムーナ・ホシノヴァ」，
 * 卡號用 regex 從商品名抽出；同卡號多版本取最高買取價。
 *
 * 參考 scrape-yuyu-prices.js 的 browser crash 重啟邏輯（launchBrowser + 重試）。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { extractCardNumber } from './lib/card-number.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, '../data/database.json');
const OUTPUT_DIR = path.join(__dirname, '../data/buy-prices');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'fullahead-prices.json');

const FULLAHEAD_URL = 'https://fullahead-buy.com/?shopbrand=hocg';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CRASH_PATTERNS = ['Protocol error', 'Target closed', 'Session closed', 'Connection closed'];
const MAX_RETRIES = 2;

// 新一輪爬取至少要保留舊檔卡數的這個比例，否則視為可疑縮水，保留舊檔不覆蓋。
const SHRINK_THRESHOLD = 0.5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 舊輸出檔的卡數，檔案不存在或讀不到時回傳 0。輸出是 { 卡號: {...} } 物件。
function readPreviousCount(file) {
  try {
    const prev = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return prev && typeof prev === 'object' ? Object.keys(prev).length : 0;
  } catch {
    return 0;
  }
}

function loadCardNumbers(file = DB_PATH) {
  const db = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const map = new Map();
  for (const card of Object.values(db.cards || {})) {
    if (card.cardNumber) map.set(card.cardNumber.toUpperCase(), card.cardNumber);
  }
  return map;
}

async function launchBrowser() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ja-JP,ja;q=0.9,en;q=0.7' });
  return { browser, page };
}

// 一次載入頁面、攔 apiToken、分頁抓完所有 records。可能因瀏覽器 crash 丟錯。
async function scrapeOnce(page, { sleepFn = sleep } = {}) {
  let apiBase = null;
  let apiToken = null;
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('fetchRecords.php') && u.includes('app=38') && !apiToken) {
      apiBase = u.split('?')[0];
      const m = u.match(/apiToken=([^&]+)/);
      if (m) apiToken = m[1];
    }
  });

  console.log(`[fullahead-buy] Loading ${FULLAHEAD_URL} ...`);
  await page.goto(FULLAHEAD_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleepFn(2500);

  if (!apiBase || !apiToken) {
    throw new Error('could not capture Fullahead API token from page requests');
  }
  console.log('[fullahead-buy] captured API token, paginating records...');

  return page.evaluate(
    async (base, token) => {
      const query =
        '(CATEGORY_PATH_1 = "hololive OFFICIAL CARD GAME") and PURCHASE_PRICE > 0 and VALID_INVALID in ("有効")';
      const fields = ['ORGIN_CODE', 'PRODUCT_NAME', 'PURCHASE_PRICE', '$id'];
      const fp = fields.map((f) => 'fields%5B%5D=' + encodeURIComponent(f)).join('&');
      const out = [];
      let lastRecId = -1;
      for (let pageNo = 0; pageNo < 100; pageNo += 1) {
        const url = `${base}?app=38&query=${encodeURIComponent(query)}&apiToken=${token}&lastRecId=${lastRecId}&${fp}`;
        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) throw new Error(`Fullahead page ${pageNo} failed: ${resp.status} ${resp.statusText}`);
        const j = await resp.json();
        const recs = (j.json && j.json.records) || [];
        if (!recs.length) break;
        for (const r of recs) {
          out.push({
            productName: r.PRODUCT_NAME && r.PRODUCT_NAME.value,
            price: r.PURCHASE_PRICE && r.PURCHASE_PRICE.value,
          });
        }
        const next = recs[recs.length - 1]['$id'] && recs[recs.length - 1]['$id'].value;
        if (next == null || next === lastRecId) break;
        lastRecId = next;
      }
      return out;
    },
    apiBase,
    apiToken
  );
}

// 含 browser crash 重啟邏輯：crash 就重開瀏覽器重試（最多 MAX_RETRIES 次）
async function scrapeWithRestart({ launchBrowserFn = launchBrowser, sleepFn = sleep, scrapeOnceFn = scrapeOnce } = {}) {
  let { browser, page } = await launchBrowserFn();
  try {
    for (let retries = 0; retries <= MAX_RETRIES; retries += 1) {
      try {
        return await scrapeOnceFn(page, { sleepFn });
      } catch (err) {
        const isCrash = CRASH_PATTERNS.some((p) => err.message.includes(p));
        if (isCrash && retries < MAX_RETRIES) {
          console.log(`[fullahead-buy] Browser crashed, restarting... (retry ${retries + 1}/${MAX_RETRIES})`);
          try { await browser.close(); } catch { /* ignore */ }
          ({ browser, page } = await launchBrowserFn());
          continue;
        }
        throw err;
      }
    }
    return [];
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
  }
}

async function main({
  launchBrowserFn = launchBrowser,
  sleepFn = sleep,
  scrapeOnceFn = scrapeOnce,
  dbPath = DB_PATH,
  outputDir = OUTPUT_DIR,
  outputFile = path.join(outputDir, 'fullahead-prices.json'),
} = {}) {
  console.log('[fullahead-buy] Starting...');
  const startTime = Date.now();

  const cardNumbers = loadCardNumbers(dbPath);
  console.log(`[fullahead-buy] database 卡號: ${cardNumbers.size}`);

  // scrape 失敗必須中斷整個 run，絕不寫出空檔或 partial 資料，
  // 避免臨時錯誤（API/token/page 失敗）用 {} 空檔污染 merge。
  const records = await scrapeWithRestart({ launchBrowserFn, sleepFn, scrapeOnceFn });

  const best = new Map(); // 正規化卡號 -> 最高買取價
  for (const rec of records) {
    const price = parseInt(String(rec.price || '').replace(/,/g, ''), 10);
    if (!Number.isFinite(price) || price <= 0) continue;
    const cardNumber = extractCardNumber(rec.productName);
    if (!cardNumber) continue;
    const key = cardNumber.toUpperCase();
    if (!cardNumbers.has(key)) continue; // database 沒有這張卡就跳過
    if (!best.has(key) || price > best.get(key)) best.set(key, price);
  }

  // 只有 scrape 成功才會走到這（失敗會在上面 throw 中斷），所以 best 是一次完整爬取的結果。
  if (best.size === 0) {
    throw new Error(
      '[fullahead-buy] Refusing to write: crawl produced 0 prices ' +
        '(likely API/token/page failure or structure change); keeping previous data.'
    );
  }

  // 防止用大幅縮水的結果悄悄覆蓋好資料：若舊檔卡數明顯較多，視為可疑縮水，保留舊檔不覆蓋。
  const prevCount = readPreviousCount(outputFile);
  if (prevCount > 0 && best.size < prevCount * SHRINK_THRESHOLD) {
    throw new Error(
      `[fullahead-buy] Refusing to write: new crawl has ${best.size} prices but ` +
        `previous file had ${prevCount} (< ${Math.round(SHRINK_THRESHOLD * 100)}% ` +
        'of prior); keeping previous data. Re-run to confirm if this drop is real.'
    );
  }

  const timestamp = new Date().toISOString();
  const out = {};
  for (const [key, buyPrice] of best.entries()) {
    const original = cardNumbers.get(key) || key;
    out[original] = { buyPrice, timestamp };
  }

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputFile, `${JSON.stringify(out, null, 2)}\n`, 'utf-8');

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `[fullahead-buy] ✅ Done in ${duration}s — 收到 ${records.length} 筆，寫入 ${Object.keys(out).length} 張卡`
  );
  console.log(`[fullahead-buy] Output: ${outputFile}`);
  return out;
}

const isMain = process.argv[1] && process.argv[1].includes('scrape-fullahead-buy');
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      // 失敗必須以非 0 退出，讓 cron 明確報錯，而不是假裝成功。
      console.error('[fullahead-buy] fatal:', err);
      process.exit(1);
    });
}

export { main as scrapeFullaheadBuy, scrapeOnce, scrapeWithRestart };
