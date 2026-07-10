/**
 * scrape-torecolo-buy.js — hololive OCG 回收（買取）價格爬蟲 (Torecolo / CBトレコロ)
 *
 * DIC-155: 抓每張卡的買取價格（円），輸出 data/buy-prices/torecolo-prices.json
 *   格式: { "hBP01-001": { "buyPrice": 500, "timestamp": "..." }, ... }
 *
 * 卡號來源：data/database.json 的 cards（只保留 database 有的卡號，其餘跳過）。
 *
 * URL 策略：Torecolo 的每張卡商品碼是 `HL-HBP08-003SEC-S` 這種帶 `HL-` 前綴、
 * 版本與 `-S` 尾碼的組合，並不是乾淨的 `g[卡號]/`，逐卡直接猜 URL 會 404。
 * 官方 hololive 買取表 (/shop/e/eHLpSEC/) 一頁就把所有在收的卡列出來，用一般
 * fetch + cheerio 即可（伺服器回完整 HTML，不需 JS render），因此改用買取表列表頁
 * 一次抓完再依 database 卡號過濾，比逐卡請求更快也更不容易被封。
 * 同一卡號可能有多個版本（SEC/UR…），取「最高」買取價作代表值。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';
import { extractCardNumber } from './lib/card-number.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, '../data/database.json');
const OUTPUT_DIR = path.join(__dirname, '../data/buy-prices');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'torecolo-prices.json');

const BASE = 'https://www.torecolo.jp';
// hololive 買取表列表頁（可再往清單裡加其他系列的入口 URL）
const START_URLS = ['https://www.torecolo.jp/shop/e/eHLpSEC/'];
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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

// 讀 database.json，回傳「正規化卡號 -> 原始卡號」的對照，用來過濾與統一大小寫。
function loadCardNumbers() {
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  const map = new Map();
  for (const card of Object.values(db.cards || {})) {
    if (card.cardNumber) {
      map.set(card.cardNumber.toUpperCase(), card.cardNumber);
    }
  }
  return map;
}

function parsePrice(text) {
  if (!text) return null;
  const m = String(text).match(/([\d,]+)\s*円/);
  if (!m) return null;
  const n = parseInt(m[1].replace(/,/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ja,en;q=0.8' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// 從一頁 HTML 解析出 [{ cardNumber, buyPrice }]
function parsePage(html) {
  const $ = cheerio.load(html);
  const rows = [];
  $('.block-thumbnail-t--goods').each((_, el) => {
    const $el = $(el);
    const href =
      $el.find('a[href*="/shop/g/"]').first().attr('href') ||
      $el.find('a[href*="goods="]').first().attr('href') ||
      '';
    const cardNumber = extractCardNumber(href);
    if (!cardNumber) return;
    const buyPrice = parsePrice($el.find('.block-thumbnail-t--price').first().text());
    if (buyPrice == null) return;
    rows.push({ cardNumber, buyPrice });
  });
  return rows;
}

// EC-CUBE 風格分頁：找 rel=next 或「次へ / >」連結
function findNextPageUrl(html, currentUrl) {
  const $ = cheerio.load(html);
  const relNext = $('a[rel="next"], link[rel="next"]').first().attr('href');
  if (relNext) return new URL(relNext, currentUrl).href;
  let found = null;
  $('.pagination a, .block-pager a, nav a').each((_, a) => {
    if (found) return;
    const txt = ($(a).text() || '').trim();
    const href = $(a).attr('href') || '';
    if (/次|next|›|»|＞|>/i.test(txt) && href && !/#$/.test(href)) {
      found = new URL(href, currentUrl).href;
    }
  });
  return found;
}

async function scrape() {
  console.log('[torecolo-buy] Starting...');
  const startTime = Date.now();

  const cardNumbers = loadCardNumbers();
  console.log(`[torecolo-buy] database 卡號: ${cardNumbers.size}`);

  // 正規化卡號 -> 最高買取價
  const best = new Map();

  for (const startUrl of START_URLS) {
    const visited = new Set();
    let url = startUrl;
    let pageNo = 0;

    while (url && !visited.has(url) && pageNo < 50) {
      visited.add(url);
      pageNo += 1;
      console.log(`[torecolo-buy] Page ${pageNo}: ${url}`);

      // fetch 失敗必須中斷整個 run：已收集的資料留在記憶體但絕不寫出，
      // 避免臨時錯誤用 partial 資料覆蓋上一份好的 torecolo-prices.json。
      const html = await fetchHtml(url);

      const rows = parsePage(html);
      let matched = 0;
      for (const { cardNumber, buyPrice } of rows) {
        const key = cardNumber.toUpperCase();
        if (!cardNumbers.has(key)) continue; // database 沒有這張卡就跳過
        matched += 1;
        if (!best.has(key) || buyPrice > best.get(key)) best.set(key, buyPrice);
      }
      console.log(`  → 解析 ${rows.length} 筆，match database ${matched} 筆`);

      const next = findNextPageUrl(html, url);
      if (!next || next === url) {
        url = null;
      } else {
        url = next;
        await sleep(2000); // 2s delay 避免被封
      }
    }
  }

  // 只有每頁都成功抓完才會走到這（fetch 失敗會在上面 throw 中斷），
  // 所以 best 是一次完整爬取的結果。
  if (best.size === 0) {
    throw new Error(
      '[torecolo-buy] Refusing to write: crawl produced 0 prices ' +
        '(likely a page-structure change or block); keeping previous data.'
    );
  }

  // 防止用大幅縮水的結果悄悄覆蓋好資料：若舊檔卡數明顯較多，視為可疑縮水，
  // 保留舊檔不覆蓋。
  const prevCount = readPreviousCount(OUTPUT_FILE);
  if (prevCount > 0 && best.size < prevCount * SHRINK_THRESHOLD) {
    throw new Error(
      `[torecolo-buy] Refusing to write: new crawl has ${best.size} prices but ` +
        `previous file had ${prevCount} (< ${Math.round(SHRINK_THRESHOLD * 100)}% ` +
        'of prior); keeping previous data. Re-run to confirm if this drop is real.'
    );
  }

  // 組成輸出物件（key 用 database 的原始卡號大小寫）
  const timestamp = new Date().toISOString();
  const out = {};
  for (const [key, buyPrice] of best.entries()) {
    const original = cardNumbers.get(key) || key;
    out[original] = { buyPrice, timestamp };
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, `${JSON.stringify(out, null, 2)}\n`, 'utf-8');

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `[torecolo-buy] ✅ Done in ${duration}s — 寫入 ${Object.keys(out).length} 張卡`
  );
  console.log(`[torecolo-buy] Output: ${OUTPUT_FILE}`);
  return out;
}

const isMain = process.argv[1] && process.argv[1].includes('scrape-torecolo-buy');
if (isMain) {
  scrape()
    .then(() => process.exit(0))
    .catch((err) => {
      // 失敗必須以非 0 退出，讓 cron 明確報錯，而不是假裝成功。
      console.error('[torecolo-buy] fatal:', err);
      process.exit(1);
    });
}

export { scrape };
