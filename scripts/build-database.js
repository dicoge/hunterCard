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
import * as cheerio from 'cheerio';
import { addZhNames } from './add-zh-names.js';
import { computeGrowthDeltas } from './lib/yt-growth.js';
import { canonicalVariantKey, normalizeRarityCode } from './lib/variant-key.js';
import { isCanonicalCardNumber, canonicalizeCardNumber, CANONICAL_CARD_NUMBER_RE } from './lib/card-number.js';
import { canonicalizePrices, canonicalYuyuName, canonicalYuyuImage } from './lib/canonical-printings.js';
import {
  buildPreservationIndex,
  findPreservedMatch,
  applyPreservedMarketFields,
  seedCanonicalHistoryFiles,
  stampHistoryRecord,
  filterProvenanceMatchedRecords,
  findAmbiguousPromoRowIds,
  hasCurrentPriceProvenance,
  findUnprovenPriceHistoryViolations,
  pricesEntryExactPrintMatchesSource,
  yuyuImageProductPath,
} from './lib/preserve-market-fields.js';
import { orderCardsForDetailAlignment } from './lib/order-cards-for-detail-alignment.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_DIR, 'data');
const LOG_PATH = path.join(DATA_DIR, 'scrape-log.txt');

// DIC-1349 (CR round 3, hermeticity fix): only initialise data/scrape-log.txt
// and rewire console.log/console.error to tee into it when this module is
// invoked as the main script. Importing `parseCardHtml` from a test file
// otherwise overwrites the tracked log at ES-module-import time — earlier
// than any snapshot the test can take — which was the CR-flagged "test
// leaves data/scrape-log.txt dirty" hermeticity blocker.
const IS_MAIN_MODULE = process.argv[1]?.includes('build-database');
if (IS_MAIN_MODULE) {
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
}
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

/**
 * DIC-1349 (CR round 3): parse the yuyu-tei HTTP-fallback HTML into
 * per-listing rows using a real HTML parser (cheerio / parse5) instead
 * of hand-rolled regex + depth counting.
 *
 * History. The pre-DIC-1349 implementation stripped every HTML tag
 * before parsing and looked up `<img>` URLs from raw HTML using
 * text-position offsets that did not correspond to HTML positions —
 * every fallback listing landed with an empty / wrong `yuyuImage` and
 * the DIC-1334 exact-print gate rejected all of them (0 / 1,196 in
 * DIC-1348 QA). Two rounds of regex hardening (dc987ef09 → 1871f8c55)
 * closed several bypasses but the CR flagged three more that a regex-
 * based parser cannot address soundly:
 *
 *   1. A genuinely-unclosed `<div class="card-product">` whose own
 *      `</div>` was missing was still admitted, because a div-depth
 *      counter cannot tell an ancestor `</div>` apart from the card's
 *      own — both bring depth back to zero.
 *   2. `getTagAttr` used `\b${name}`, so `data-class="card-product"` and
 *      `data-class="cart_ver"` matched the same regex as real `class`
 *      attributes (word boundary between `data-` and the attribute
 *      name).
 *   3. The container regex only accepted `class="…"` / `class='…'`, so
 *      the valid bare `<div class=card-product>` shape produced zero
 *      rows.
 *
 * A real HTML5 parser fixes each of these by construction: parse5
 * auto-closes unclosed elements at their natural parent boundary,
 * attribute names are token-scoped (never prefixed), and bareword /
 * quoted / single-quoted / entity-encoded attributes all round-trip
 * identically. Cheerio is already a `dependencies` entry (used by other
 * scripts) so no new package is added.
 *
 * Contract (per parsed card-product element, all reads via cheerio DOM):
 *   - product image: any descendant `<img>` whose `src` is NOT the
 *     starbtn asset on the `cdn.yuyu-tei.jp` CDN is a product-image
 *     candidate. Every product-image candidate's `src` MUST parse via
 *     `yuyuImageProductPath` — a present-but-invalid image drops the
 *     card. Only an absent product image (no non-CDN `<img>` at all)
 *     falls back to synthesising the canonical
 *     `/hocg/100_140/{cart_ver}/{cart_cid}.jpg` URL from the block's
 *     own `<input class="cart_ver">` / `<input class="cart_cid">`, and
 *     that synthesised URL is itself validated via
 *     `yuyuImageProductPath` before admission.
 *   - card number + rarity: product image `alt` (`hXXX-nnn RARITY name`),
 *     falling back to the standalone `<span>hXXX-nnn</span>`.
 *   - card name: `<h4>` inner text (entity-decoded).
 *   - price: first `[\d,]+ 円` in the element's own text.
 *   - `imageVersion` / `imageCid`: `<input class="cart_ver">` /
 *     `<input class="cart_cid">` within the card. Class tokens are
 *     matched by cheerio's class-selector, so no prefix ambiguity.
 */
function decodeHtmlEntities(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    // '&amp;' MUST be last so `&amp;quot;` does not double-decode into `"`.
    .replace(/&amp;/g, '&');
}

function parseCardProductElement($, el) {
  const $el = $(el);

  // 0a) Source-element boundary (CR round-3 fix): a well-formed
  //    card-product NEVER contains another card-product as a descendant
  //    — they are siblings, not nested. If cheerio sees one nested,
  //    it means an outer card-product's own `</div>` was missing and
  //    HTML5 parsing folded what would be its sibling INTO it (there is
  //    no implicit-close rule for `<div>`). Dropping the outer prevents
  //    the classic "unclosed outer with empty product-img borrows the
  //    later sibling's trusted image / cart provenance and emits its own
  //    laundered price" bypass the CR round-3 mutation flagged. The
  //    nested card-product is still enumerated separately by parseCardHtml
  //    and processed independently.
  if ($el.find('div.card-product').length > 0) return null;

  // 0b) Structural invariant: a real yuyu-tei card-product always contains
  //    a `<div class="… product-img …">` container (which wraps the
  //    product image). A card-product with no such container is either a
  //    UI shell or the CR round-2 "genuinely unclosed with no product-img"
  //    bypass shape — HTML5 parsing keeps footer inputs as children of an
  //    unclosed `<div>`, so parse5 cannot on its own tell an unclosed card
  //    apart from a well-formed one whose image tag happens to be absent.
  //    Requiring the yuyu-tei structural signature is the guard: the
  //    malformed shape the CR flagged ("only span, h4, strong, and footer
  //    cart inputs") has no product-img container, so it fails closed
  //    here. Every real yuyu-tei card-product ships with this container,
  //    and the regression fixture ships it even when the inner `<img>` is
  //    intentionally omitted.
  if ($el.find('div.product-img').length < 1) return null;

  // 1) Product image candidates — every descendant <img> that is NOT the
  //    starbtn asset on the CDN. A present-but-invalid one drops the card.
  const productImgs = $el.find('img').toArray().filter((img) => {
    const src = String($(img).attr('src') || '').toLowerCase();
    if (src.startsWith('https://cdn.yuyu-tei.jp/')) return false;
    if (src.startsWith('http://cdn.yuyu-tei.jp/')) return false;
    return true;
  });
  let productImg = null;
  let rawImageUrl = '';
  if (productImgs.length > 0) {
    for (const img of productImgs) {
      const src = String($(img).attr('src') || '');
      if (!yuyuImageProductPath(src)) return null;
    }
    productImg = productImgs[0];
    rawImageUrl = String($(productImg).attr('src') || '');
  }

  // 2) Card number + rarity — product image alt, with <span>hXXX-nnn</span> fallback.
  const alt = productImg ? String($(productImg).attr('alt') || '') : '';
  const altNumMatch = alt.match(/(h[A-Z]{1,3}\d+-\d{2,3})/i);
  let cardNum = altNumMatch ? altNumMatch[1] : '';
  if (!cardNum) {
    // First <span> whose text is exactly a canonical card number.
    $el.find('span').each((_, span) => {
      if (cardNum) return;
      const txt = ($(span).text() || '').trim();
      const m = txt.match(/^(h[A-Z]{1,3}\d+-\d{2,3})$/i);
      if (m) cardNum = m[1];
    });
  }
  if (!cardNum) return null;

  const altRarityMatch = alt.match(/h[A-Z]{1,3}\d+-\d{2,3}\s+([A-Z]{1,4})\b/i);
  const rarity = altRarityMatch ? altRarityMatch[1] : '';

  // 3) Price — first `[\d,]+ 円` in the element's own text. Cheerio's
  //    .text() returns the concatenated descendant text, which is exactly
  //    what the original regex-based parser walked.
  const cardText = $el.text() || '';
  const priceMatch = cardText.match(/([\d,]+)\s*円/);
  if (!priceMatch) return null;
  const price = parseInt(priceMatch[1].replace(/,/g, ''), 10);
  if (!Number.isFinite(price) || price <= 0) return null;

  // 4) Card name — <h4> inner text, entity-decoded. Fall back to the alt
  //    with the cardNum + rarity tokens stripped when no <h4> is present.
  const $h4 = $el.find('h4').first();
  let name = $h4.length ? decodeHtmlEntities(($h4.text() || '')).replace(/\s+/g, ' ').trim() : '';
  if (!name && alt) {
    const nameFromAlt = alt.replace(/^h[A-Z]{1,3}\d+-\d{2,3}\s*[A-Z]{1,4}?\s*/i, '').trim();
    if (nameFromAlt) name = nameFromAlt;
  }

  // 5) cart_ver / cart_cid inputs — cheerio's class-selector matches whole
  //    tokens by DOM contract, so `cart_verify` cannot masquerade as
  //    `cart_ver` and `data-class="cart_ver"` is not a `class` attribute
  //    at all.
  const imageVersion = String($el.find('input.cart_ver').first().attr('value') || '');
  const imageCid = String($el.find('input.cart_cid').first().attr('value') || '');

  // 6) Final `yuyuImage`:
  //      (i) the product `<img src>` verified in step (1), or
  //     (ii) the canonical `/hocg/100_140/{ver}/{cid}.jpg` synth when the
  //          block has NO product image and BOTH cart_ver + cart_cid.
  //    Either way, the resulting URL is re-run through
  //    `yuyuImageProductPath` before admission.
  let yuyuImage = rawImageUrl;
  if (!yuyuImage && imageVersion && imageCid) {
    const safeVer = /^[A-Za-z0-9-]+$/.test(imageVersion) ? imageVersion : '';
    const safeCid = /^[A-Za-z0-9-]+$/.test(imageCid) ? imageCid : '';
    if (safeVer && safeCid) {
      yuyuImage = `https://card.yuyu-tei.jp/hocg/100_140/${safeVer}/${safeCid}.jpg`;
    }
  }
  if (!yuyuImage) return null;
  if (!yuyuImageProductPath(yuyuImage)) return null;

  return {
    cardNum,
    sellPrice: price,
    rarity,
    name,
    yuyuImage,
    imageVersion,
    imageCid,
  };
}

export function parseCardHtml(html) {
  const results = [];
  if (typeof html !== 'string' || html.length === 0) return results;
  // parse5 (via cheerio) auto-closes unclosed elements at their natural
  // parent boundary, so a `<div class="card-product">` whose own `</div>`
  // is missing gets closed at the enclosing `<div class="row">`'s close.
  // Descendant `<input>` tags physically located AFTER the missing card's
  // scope end up as siblings of the auto-closed card, not children — the
  // real fix for the CR-round-2 "unclosed card absorbs footer cart fields"
  // bypass.
  const $ = cheerio.load(html);
  $('div.card-product').each((_, el) => {
    const parsed = parseCardProductElement($, el);
    if (parsed) results.push(parsed);
  });
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
  if (process.env.HUNTERCARD_YUYU_FIXTURE_PATH) {
    const fixturePath = process.env.HUNTERCARD_YUYU_FIXTURE_PATH;
    console.log(`[database] Loading yuyu fixture: ${fixturePath}`);
    return JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
  }

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
      const accumulateCards = (cards, sourceSeries) => {
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
            sourceSeries,
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
            const count = accumulateCards(cards, seriesInfo.name);
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
                const count = accumulateCards(cards, seriesInfo.name);
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
          sourceSeries: seriesInfo.name,
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

  const files = fs.readdirSync(OFFICIAL_DIR).filter(f => (
    f.endsWith('.json') &&
    !f.startsWith('_') &&
    !f.startsWith('all-') &&
    !f.startsWith('cardList_')
  ));

  const imageSuffixFor = (url = '') => String(url).match(/\/([^/]+)\.png$/i)?.[1] || '';
  const officialBackfillByImage = new Map();
  for (const file of files) {
    const filePath = path.join(OFFICIAL_DIR, file);
    try {
      const cards = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (!Array.isArray(cards)) continue;
      for (const card of cards) {
        const suffix = imageSuffixFor(card.imageUrl);
        const type = card.cardType || card.type || '';
        const color = card.color || '';
        if (!suffix || (!type && !color)) continue;
        if (!officialBackfillByImage.has(suffix)) officialBackfillByImage.set(suffix, { type, color });
      }
    } catch (err) {
      console.error(`  [official] Error reading ${file} for metadata backfill: ${err.message}`);
    }
  }

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
          const imageSuffix = imageSuffixFor(card.imageUrl);
          const richerOfficial = officialBackfillByImage.get(imageSuffix) || {};
          // Use compound keys to preserve all series and all official printings.
          // hEB01 contains many same-card-number variants inside one expansion;
          // those must not overwrite one another or inherit a single old price.
          const baseKey = series ? `${cardNum}_${series}` : cardNum;
          const mustUsePrintingKey = !!card.sourceProduct;
          const printingKey = [baseKey, card.rarity || '', imageSuffix || card.id || ''].filter(Boolean).join('_');
          const makeInfo = () => ({
            name: card.name || '',
            type: card.cardType || card.type || richerOfficial.type || '',
            color: card.color || richerOfficial.color || '',
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

  // DIC-1204: broadcast ytStats onto every printing of the same holomen, not
  // only the first row a given cardNumber lands on. DIC-1084 canonicalization
  // creates multiple printings per cardNumber (each rarity / product printing
  // gets its own row), and the audit contract in scripts/audit-card-data.mjs
  // pins the full-dataset ytStats row count (DIC-1153) — an early-return that
  // skipped later variants of the same cardNumber silently regressed that
  // pinned count to the number of unique cardNumbers with a stats-carrying
  // holomen name.
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

  // Capture the previous build's market payload before we overwrite database.json.
  // A yuyu outage/403 is allowed to decouple from official catalog ingestion,
  // but it must not turn a failed/incomplete scrape into a successful write that
  // erases the last proven sell prices. DIC-1204: the previous exact-id-only
  // preservation missed rows whose printing IDs got renamed by DIC-1084
  // canonicalization, wiping their proven sellPrice / priceHistory / ytStats.
  // Use `preserve-market-fields.js` to (a) preserve by exact id when it still
  // matches and (b) fall back to a strict cardNumber|sourceProduct|rarity
  // signature so renamed printings still carry their proven payload; ambiguous
  // signatures refuse to guess (fail-closed, no cross-printing / cross-rarity
  // leakage).
  let prevCards = {};
  try {
    prevCards = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8')).cards || {};
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`  [sellPrice] Could not read previous database for market-field preservation: ${err.message}`);
    }
  }
  const preservationIndex = buildPreservationIndex(prevCards);
  if (preservationIndex.byId.size > 0) {
    console.log(`  [sellPrice] Indexed ${preservationIndex.byId.size} previous rows for market-field preservation`);
  }

  // Capture the previous build's skillsJp / skillsZh so a rebuild can fall back
  // to them when the scraped effects files lack an entry. A fresh rebuild
  // re-derives skills only from data/effects-jp.json + effects-zh.json; if a
  // build ever runs with effects-zh.json empty/partial while effects-jp.json is
  // present, affected cards keep skillsJp but lose skillsZh and the app falls
  // back to Japanese in zh mode (DIC-454). Preserving prior skills stops that
  // regression from silently wiping translations.
  const prevSkillsByCardId = new Map();
  for (const [cardId, card] of Object.entries(prevCards)) {
    const saved = {};
    if (card.skillsJp && typeof card.skillsJp === 'object') saved.skillsJp = card.skillsJp;
    if (card.skillsZh && typeof card.skillsZh === 'object') saved.skillsZh = card.skillsZh;
    if (Object.keys(saved).length > 0) prevSkillsByCardId.set(cardId, saved);
  }
  if (prevSkillsByCardId.size > 0) {
    console.log(`  [skills] Preserving skills for ${prevSkillsByCardId.size} cards from previous build`);
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
  const pricingUnavailable = Boolean(yuyuResult.pricingUnavailable || totalCards < 50);
  // DIC-1321: a "partial scrape" is a scrape that returned far fewer priced
  // cardNumbers than the previous build — the WAF-throttle shape. The old
  // binary (fully-available OR fully-unavailable) treated a partial scrape as
  // fully-available, so every cardNumber the partial scrape did not touch was
  // rebuilt as sellPrice:null AND NOT preserved (`hasCurrentYuyuPayload` was
  // false), permanently dropping the previously-proven price. That is the
  // degradation 1,885 → 1,547 and the local 0-priced snapshots. Detect it by
  // comparing the unique scraped cardNumbers against the previous build's
  // priced card-number coverage, and preserve the previous proven price for
  // rows that were NOT freshly scraped (still subject to the existing
  // `yuyuPayloadMatchesSource` printing-isolation gate in
  // applyPreservedMarketFields — no cross-product / cross-printing restore).
  const scrapedCardNumbers = new Set(Object.keys(prices || {}));
  const prevPricedCardNumbers = new Set(
    Object.values(prevCards)
      .filter((c) => Number.isFinite(c?.sellPrice) && c.sellPrice > 0)
      .map((c) => c.cardNumber),
  );
  const coverageFloorRatio = 0.9;
  const previousCoverage = prevPricedCardNumbers.size;
  const currentCoverage = scrapedCardNumbers.size;
  const partialScrape = !pricingUnavailable
    && previousCoverage > 0
    && currentCoverage < previousCoverage * coverageFloorRatio;
  console.log(`\n  Total cards from yuyu-tei: ${totalCards}`);
  console.log(`  [DIC-1321] scrape coverage: ${currentCoverage} priced cardNumbers vs previous ${previousCoverage}; partial=${partialScrape}`);
  if (pricingUnavailable) {
    console.warn(`[database] yuyu pricing unavailable or incomplete (totalCards=${totalCards}); preserving previous exact-card sell prices and leaving new/unknown printings null`);
  } else if (partialScrape) {
    console.warn(`[database] yuyu scrape is PARTIAL (${currentCoverage}/${previousCoverage} priced cardNumbers < ${coverageFloorRatio * 100}%); preserving previous proven prices for rows not freshly scraped (DIC-1321)`);
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
  // DIC-1343/CR rev.2: the compound key IS the official printing identity
  // (`cardNumber_series_rarity_imageSuffix`). It is the only value that keeps
  // genuinely distinct rows such as ent07 `C` and ent07 `02_C` apart — those
  // collapse onto one another under normalizeRarityCode. Keep a row → key map
  // so the yuyu-only fallback can count DISTINCT printings and bind a proven
  // price onto the official row itself instead of a bare cardNumber duplicate.
  const officialKeyByRow = new Map();
  for (const [key, info] of Object.entries(officialCards)) {
    const base = info.cardNumber || '';
    if (base) {
      if (!officialByCardNum[base]) officialByCardNum[base] = [];
      officialByCardNum[base].push(info);
      officialKeyByRow.set(info, key);
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

  function yuyuEntryMatchesOfficial(entry, official, candidateCount = 1) {
    if (!entry || !official) return false;
    const sourceSeries = String(entry.sourceSeries || '').toLowerCase();
    if (!sourceSeries) return false;
    const officialSeries = String(official.series || '').toLowerCase();
    const officialSource = String(official.sourceProduct || '').toLowerCase();
    const officialRarity = normalizeRarityCode(official.rarity);
    const entryRarity = normalizeRarityCode(entry.rarity);

    if (entryRarity !== '' && officialRarity !== '') {
      if (sourceSeries === officialSeries || sourceSeries === officialSource) {
        return entryRarity === officialRarity;
      }

      const taggedBySeries = String(entry.name || '').toLowerCase().includes(`/${sourceSeries}`);
      if (taggedBySeries && sourceSeries === officialSource) {
        return entryRarity === officialRarity;
      }
    }

    // Live yuyu pages usually do not expose an explicit rarity token; the
    // image URL and sourceSeries still prove the source product. Accept that
    // empty-rarity shape only when there is exactly one official printing for
    // this cardNumber+sourceProduct, otherwise fail closed instead of guessing
    // between C/SR/HR siblings.
    if (entryRarity === '' && sourceSeries === officialSource && candidateCount === 1) {
      return pricesEntryExactPrintMatchesSource(
        { sellPrice: entry.sellPrice, imageUrl: entry.yuyuImage },
        official.sourceProduct || official.series || '',
      );
    }

    return false;
  }

  // Helper: resolve yuyu price data for one exact official printing.  Healthy
  // scrapes may contain same-card-number rows from multiple official printings;
  // require an explicit sourceSeries/name-tag tie instead of card-number fallback.
  function getYuyuForCard(cardNum, official) {
    const priceData = prices[cardNum];
    if (!priceData) return null;
    const candidateCount = (officialByCardNum[cardNum] || [])
      .filter((candidate) => {
        const candidateSource = String(candidate.sourceProduct || candidate.series || '').toLowerCase();
        const officialSource = String(official.sourceProduct || official.series || '').toLowerCase();
        return candidateSource && candidateSource === officialSource;
      })
      .length;
    const rawEntries = (Array.isArray(priceData) ? priceData : [priceData]).filter((entry) => yuyuEntryMatchesOfficial(entry, official, candidateCount));
    if (rawEntries.length === 0) return null;
    const priceEntries = deduplicatePrices(rawEntries);
    let lowestPrice = null;
    let lowestName = '';
    let firstImage = '';
    let firstTimestamp = '';
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

  // DIC-1334: track which cardNumbers received a sellPrice from official+yuyu
  // matching. The yuyu-only fallback below must only create a yuyu-only entry
  // when NO official entry for that cardNumber got priced — otherwise the
  // existing official entry (sellPrice:null) blocks the fallback via
  // alreadyExists, permanently discarding the yuyu price data. This is the
  // root cause of the 1,214→424 collapse: yuyu data is irrecoverably lost
  // when the official catalog has entries but none match the yuyu listing's
  // exact series+rarity combination.
  const officialPricedCardNums = new Set();

  // Process ALL official entries (compound keys preserve reprints across series)
  for (const [key, official] of Object.entries(officialCards)) {
    const baseCardNum = official.cardNumber || '';
    const yuyu = pricingUnavailable ? null : getYuyuForCard(baseCardNum, official);

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
    // DIC-1334: record that this cardNumber received a sellPrice from
    // official+yuyu matching so the yuyu-only fallback below does not
    // discard the yuyu price data for OTHER unmatched printings of this
    // cardNumber.
    if (yuyu && yuyu.lowestPrice != null && yuyu.lowestPrice > 0) {
      officialPricedCardNums.add(baseCardNum);
    }
  }

  // Also add yuyu-only cards (prices without matching official entry)
  for (const [rawCardNum, priceData] of Object.entries(prices)) {
    // Canonicalize: yuyu-tei emits short suffixes (hY01-14) but the canonical
    // schema requires 3 digits (hY01-014).  DIC-1084.
    const cardNum = canonicalizeCardNumber(rawCardNum);
    // DIC-1334: replace the old `alreadyExists` gate (which dropped yuyu price
    // data whenever ANY official entry existed, even when every official entry
    // had sellPrice:null — the 1,214→424 collapse). Now we only block the
    // fallback when at least one official entry for this cardNumber actually
    // received a sellPrice from official+yuyu matching. When official entries
    // exist but ALL are unpriced, we ADD the yuyu listing as yuyu-only instead
    // of silently discarding it.
    const officialRows = officialByCardNum[cardNum] || [];
    const officialAlreadyPriced = officialPricedCardNums.has(cardNum);
    if (officialAlreadyPriced) continue;
    // DIC-1334 + DIC-1343/CR: strict exact-printing provenance for the
    // yuyu-only fallback. When official rows exist for this cardNumber, we
    // must resolve EACH accepted listing to exactly one distinct official
    // compound printing identity before any scalar selection or publication —
    // never a cardNumber-wide, sibling/reprint, rarity-guess, buyPrice, or
    // cross-product fallback. The old gate only checked the FIRST entry's
    // image product, then admitted the whole priceData array and picked the
    // lowest scalar across siblings — which could publish an unproven
    // sibling/reprint price (e.g. a hBP03 cardNumber resolving ¥1 from a
    // hBP07/C sibling listing). Truly yuyu-only cardNumbers (no official row
    // at all) have no official identity to conflict with and keep the
    // original behavior.
    let priceEntries;
    // Compound key of the single official printing this listing set proved to.
    // Non-null means the price must be bound onto that already-emitted official
    // row; null means this is a truly yuyu-only cardNumber.
    let boundPrintingKey = null;
    if (officialRows.length > 0) {
      // Proven printings: map each listing to EVERY exact official printing it
      // matches, identified by the official compound key. Two things this must
      // not do, both of which the previous revision did: (1) key by
      // `sourceProduct|normalizeRarityCode(rarity)`, which merges the distinct
      // ent07 `C` and `02_C` rows into one bucket and reports a collision as a
      // unique match; (2) stop at the first matching official row, which hides
      // the very ambiguity this gate exists to catch. Zero proven printings
      // (unprovable / rarity-guess) and more than one distinct proven printing
      // (ambiguous sibling / reprint / C-vs-02_C) both fail closed.
      const allEntries = Array.isArray(priceData) ? priceData : [priceData];
      const provenPrintings = new Map(); // official compound key → proven entries
      for (const entry of allEntries) {
        for (const official of officialRows) {
          const candidateCount = officialRows
            .filter((c) => String(c.sourceProduct || c.series || '').toLowerCase() === String(official.sourceProduct || official.series || '').toLowerCase())
            .length;
          if (!yuyuEntryMatchesOfficial(entry, official, candidateCount)) continue;
          const printKey = officialKeyByRow.get(official);
          if (!printKey) continue;
          if (!provenPrintings.has(printKey)) provenPrintings.set(printKey, []);
          provenPrintings.get(printKey).push(entry);
        }
      }
      if (provenPrintings.size !== 1) {
        console.log(`  [DIC-1334/CR] yuyu-only fallback skipped for officially-known cardNumber ${cardNum}: ${provenPrintings.size === 0 ? 'no listing proves to an exact official printing' : `${provenPrintings.size} distinct official printings proven (ambiguous sibling/reprint)`} — fail-closed, no cardNumber-wide fallback`);
        continue;
      }
      const [[printKey, proven]] = provenPrintings;
      // The proven printing must be an official row that already exists in the
      // artifact — binding is the only lawful outcome here. If it somehow does
      // not, fail closed rather than publish an identity-less duplicate.
      if (!database.cards[printKey]) {
        console.log(`  [DIC-1334/CR] yuyu-only fallback skipped for ${cardNum}: proven printing ${printKey} has no official row to bind (fail-closed)`);
        continue;
      }
      boundPrintingKey = printKey;
      priceEntries = deduplicatePrices(proven);
    } else {
      priceEntries = deduplicatePrices(Array.isArray(priceData) ? priceData : [priceData]);
    }
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

    // DIC-1343/CR rev.2: when the listing set proved to exactly one official
    // printing, write the price ONTO that printing's existing row. Emitting a
    // second, bare-cardNumber row instead published an identity-less duplicate
    // (no rarity / series / official image) while the printing it claimed to
    // have proven stayed unpriced — the artifact then carried both a null
    // official row and a rogue priced row for the same card.
    if (boundPrintingKey) {
      const bound = database.cards[boundPrintingKey];
      bound.sellPrice = lowestPrice;
      bound.yuyuName = cleanYuyuName;
      bound.yuyuImage = cleanYuyuImage;
      bound.prices = canonical;
      bound.timestamp = firstTimestamp;
      bound._rawPricesArchive = archive;
      if (!bound.name) bound.name = lowestName || '';
      console.log(`  [DIC-1334/CR] yuyu-only fallback bound ${cardNum} to official printing ${boundPrintingKey} (sellPrice=${lowestPrice})`);
      continue;
    }

    const canonicalCardNum = isCanonicalCardNumber(cardNum)
      ? cardNum
      : cardNum.replace(/-(\d{1,2})$/, (_, n) => `-${n.padStart(3, '0')}`);
    const outCardNum = isCanonicalCardNumber(canonicalCardNum) ? canonicalCardNum : cardNum;

    database.cards[outCardNum] = {
      id: outCardNum,
      cardNumber: outCardNum,
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
      localImage: fs.existsSync(path.join(IMAGES_DIR, `${outCardNum}.jpg`)) ? `/images/${outCardNum}.jpg` : '',
      hp: '',
      life: '',
      arts: '',
      timestamp: firstTimestamp,
      _rawPricesArchive: archive,
    };
  }

  // DIC-1204: preserve proven market payload onto every current row that maps
  // to a previous row by exact id or by strict signature. During a yuyu outage
  // this keeps previously proven exact-card sell prices. During a healthy /
  // partial scrape, do not resurrect yuyu sell payload onto a freshly rebuilt
  // official row that has no current exact yuyu match: that is an unproven
  // cross-product fallback, not provenance (DIC-1167).
  const hasCurrentYuyuPayload = (card) => (
    (Number.isFinite(card?.sellPrice) && card.sellPrice > 0)
    || (Array.isArray(card?.prices) && card.prices.length > 0)
    || Boolean(card?.yuyuName || card?.yuyuImage || card?.timestamp)
  );
  if (preservationIndex.byId.size > 0) {
    let restoredSell = 0;
    let restoredPriceHistory = 0;
    let restoredYt = 0;
    let restoredPrices = 0;
    for (const [cardId, card] of Object.entries(database.cards)) {
      const match = findPreservedMatch(preservationIndex, cardId, card);
      if (!match) continue;
      const summary = applyPreservedMarketFields(card, match.card, {
        matchKind: match.matchKind,
        // DIC-1321: preserve previous proven yuyu payload not only on a full
        // outage (pricingUnavailable) but also on a PARTIAL scrape for rows the
        // partial scrape did not touch. Without this a WAF-throttled partial
        // scrape permanently drops every row it missed (hasCurrentYuyuPayload
        // false → nothing preserved). The applyPreservedMarketFields gate still
        // enforces `yuyuPayloadMatchesSource`, so a partial restore never
        // crosses printings / products — only provably-matched rows keep their
        // price.
        preserveYuyuPayload: pricingUnavailable || partialScrape || hasCurrentYuyuPayload(card),
      });
      if (summary.sellPrice) restoredSell++;
      if (summary.prices) restoredPrices++;
      if (summary.priceHistory) restoredPriceHistory++;
      if (summary.ytStats) restoredYt++;
    }
    console.log(
      `  [preserve] restored sellPrice=${restoredSell} prices=${restoredPrices} `
      + `priceHistory=${restoredPriceHistory} ytStats=${restoredYt}`
    );
  }

  // DIC-1227 CR follow-up rev.4: fail-closed on ambiguous promo assignment.
  // If two hPR rows of the same cardNumber both claim the same yuyuImage URL,
  // a single yuyu listing cannot vouch for both distinct printings — null
  // every one of them so the daily build path cannot recreate the pairs
  // Mac-Codex CR flagged (hSD03-002 P/P_2, hBP01-108 P/P_01, hBP02-028 P/P_2).
  // Runs BEFORE detail-align so the ranker sees the corrected prices[].
  {
    const ambiguous = findAmbiguousPromoRowIds(database.cards);
    if (ambiguous.size > 0) {
      for (const id of ambiguous) {
        const card = database.cards[id];
        if (!card) continue;
        card.sellPrice = null;
        card.prices = [];
        card.yuyuName = '';
        card.yuyuImage = '';
        card.timestamp = '';
        if (card.priceHistory) card.priceHistory = {};
        if (card.priceHistoryMeta) delete card.priceHistoryMeta;
        if (Array.isArray(card._rawPricesArchive)) card._rawPricesArchive = [];
      }
      console.log(`  [promo-ambiguity] nulled ${ambiguous.size} hPR rows sharing a yuyuImage across distinct printings`);
    }
  }

  // DIC-1167: keep the CardDetail and deck pipelines resolving to the same
  // default printing per cardNumber. The daily official scrape iterates
  // expansion files in filesystem order, so reprint rows (hBP08, hEB01, hPR, …)
  // can land first and their sourceProduct-tight prices[] then drives
  // CardDetail to PARALLEL while deck aggregation still resolves to BASE. This
  // reorders every cardNumber group so the origin-product row is first
  // (verify-version-alignment.js is the shipped contract behind this).
  {
    const { cards: ordered, reorderedCardNumbers } = orderCardsForDetailAlignment(database.cards);
    database.cards = ordered;
    if (reorderedCardNumbers > 0) {
      console.log(`  [detail-align] reordered rows within ${reorderedCardNumbers} cardNumber groups`);
    }
  }

  // Step 4b: Merge scraped card skills (Japanese + Chinese) by cardNumber,
  // preserving any skills from the previous build the effects files no longer supply.
  mergeSkills(database.cards, prevSkillsByCardId);

  // DIC-1334: post-transformation coverage audit. After every destructive
  // transformation (official matching, yuyu-only fallback, ambiguous-promo
  // nullification, detail-align reorder, skills merge), verify the FINAL
  // canonical artifact's priced-cardNumber coverage against the fresh yuyu
  // scrape. Scenario r5 of the surgery spec: a healthy pre-stage coverage
  // followed by a final-artifact collapse must FAIL the build (exit non-zero,
  // HUNTERCARD_SCRAPE_STATUS=FAILED, no commit). We compare the final
  // priced-cardNumber set against the freshly scraped yuyu set: the gap must
  // stay small, otherwise a transformation discarded yuyu price data.
  if (!pricingUnavailable) {
    const finalPricedCardNums = new Set(
      Object.values(database.cards)
        .filter((c) => Number.isFinite(c?.sellPrice) && c.sellPrice > 0)
        .map((c) => c.cardNumber),
    );
    // DIC-1334: with the wrong alreadyExists gate a scrape of N priced
    // cardNumbers can collapse to a small fraction of N. Enforce a hard
    // floor: the final priced-cardNumber coverage must exceed 50% of the
    // freshly scraped yuyu coverage. A healthy run matches nearly all of
    // them (yuyu only lists pricing for cards that exist in the catalog),
    // so 50% is a deliberately generous fail-closed floor that still
    // catches a 1214→424 collapse (35%).
    const finalCoverage = finalPricedCardNums.size;
    const scrapedCoverage = scrapedCardNumbers.size;
    const gapFloor = Math.floor(scrapedCoverage / 2);
    if (scrapedCoverage > 0 && finalCoverage < gapFloor) {
      throw new Error(
        `[DIC-1334] final canonical artifact collapsed priced-cardNumber coverage: ` +
        `scraped ${scrapedCoverage} priced cardNumbers but final artifact only has ${finalCoverage} ` +
        `(< 50% floor ${gapFloor}). A transformation discarded yuyu price data; refusing to ship.`,
      );
    }
    const lostCardNums = [...scrapedCardNumbers].filter((n) => !finalPricedCardNums.has(n));
    if (lostCardNums.length > 0) {
      console.log(`  [DIC-1334] final artifact keeps ${finalCoverage}/${scrapedCoverage} priced cardNumbers; ${lostCardNums.length} not priced in final artifact (examined sample: ${lostCardNums.slice(0, 5).join(', ')})`);
    }
  }

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

  // DIC-1204 Step 4c: Before appending today's record, seed the canonical-ID
  // history file with the multi-day priceHistory the preservation step above
  // just carried onto renamed printings. Without this seed, Step 5 would
  // create a fresh file containing only today's record and Step 6 would
  // unconditionally overwrite `card.priceHistory` with that single-record
  // read, collapsing the 66-day history we just restored on a card like
  // hBP01-028_hBP08_HR_hBP01-028_HR (66 shipped days, no canonical-ID file
  // yet). Existing records[] entries survive verbatim; only preserved dates
  // that are not already recorded get appended — no cross-printing or
  // stale-price leakage.
  const seedResult = seedCanonicalHistoryFiles({
    cards: database.cards,
    historyDir,
    fsAdapter: { fs, path },
  });
  if (seedResult.seededFiles > 0) {
    console.log(
      `  [preserve-history] Seeded ${seedResult.seededFiles} canonical-ID history files with ${seedResult.addedRecords} preserved records`
    );
  }

  // Collect price records from all cards. DIC-1219: stamp each record with the
  // row's sourceProduct so Step 6 (merge) and future preservation cycles can
  // reject any cross-product record a seed / restore script may have written
  // onto this canonical-ID history file. New records emitted here are always
  // stamped; legacy records without a stamp are grandfathered in only on
  // origin-product rows (see filterProvenanceMatchedRecords).
  //
  // DIC-1229 CR rev.4: gate the durable write on `hasCurrentPriceProvenance`
  // BEFORE emitting a record. Without this, every row with a positive scalar
  // `sellPrice` (including ent07 aggregation rows whose sellPrice is derived
  // from cross-printing yuyu entries) writes a single-record durable file
  // every daily run. The scheduler's broad `git add data/price-history/*.json`
  // then republishes those files even after `purge-unproven-price-history-
  // DIC-1229.mjs` has cleaned them. Mac-Codex CR rev.4 flagged the exact
  // reproduction: 0 files after purge → normal build → 377 recreated. Under
  // the strict predicate ent07/reprint rows fail the gate, no record is
  // emitted, and the existing durable file (if any) is left untouched. The
  // gate options are identical to Step 6 / the audit (ambiguousIds derived
  // once from the final cards map below) so all three defence points share
  // the same non-ambiguity / freshness / exact-print contract.
  const step5GateOptions = {
    ambiguousIds: findAmbiguousPromoRowIds(database.cards),
  };
  const disableStep5Gate = process.env.HUNTERCARD_DIC1229_DISABLE_STEP5_GATE === '1';
  if (disableStep5Gate) {
    console.log('  [DIC-1229] ⚠️ HUNTERCARD_DIC1229_DISABLE_STEP5_GATE=1 — Step 5 provenance gate DISABLED (test-only fault injection)');
  }
  const priceRecords = [];
  let step5SkippedUnproven = 0;
  for (const [cardId, card] of Object.entries(database.cards)) {
    if (card.sellPrice != null && card.sellPrice > 0) {
      if (!disableStep5Gate && !hasCurrentPriceProvenance(card, step5GateOptions)) {
        step5SkippedUnproven++;
        continue;
      }
      priceRecords.push(stampHistoryRecord({
        date: today,
        price: card.sellPrice,
        source: 'yuyu-tei',
        currency: 'JPY',
        cardId,
      }, card));
    }
  }
  if (step5SkippedUnproven > 0) {
    console.log(`  [DIC-1229] Step 5 skipped ${step5SkippedUnproven} unproven printings — no durable record written (DIC-1229 fail-closed)`);
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

  // Step 6: Merge priceHistory back into database cards.
  // DIC-1219: filter out durable records whose provenance does not match the
  // current row before we build card.priceHistory. Stamped records survive
  // only when their sourceProduct equals the row's sourceProduct; unstamped
  // legacy records survive only on origin-product rows. This is what stops
  // the cross-product history the DIC-1204 seed script left on 813 reprint
  // rows from re-materialising onto card.priceHistory on every rebuild.
  //
  // DIC-1229 hardening: `filterProvenanceMatchedRecords` checks the stamp
  // ONLY against `card.sourceProduct`. That alone doesn't prove the record
  // reflects a current exact-print listing — a poisoned record whose stamp
  // is technically correct can still ship as a user-visible priceHistory
  // when the row itself has no current provenance. Fail closed: only merge
  // priceHistory when the row has a proven CURRENT listing
  // (`hasCurrentPriceProvenance`); otherwise skip the merge AND purge the
  // durable file so a follow-up rebuild cannot re-materialise the stale
  // record. Mac-Codex CR flagged `hBP01-090_hPR_P_hBP01-090_P_02` shipping
  // `priceHistory={"2026-08-28":30}` alongside `sellPrice:null`,
  // `prices:[]`, `yuyuImage:""` — the exact shape this gate rules out.
  console.log('\n── Step 6: Merge priceHistory into database ──');
  // DIC-1229 rev.2: compute the ambiguous-hPR set once so both the Step 6
  // gate and the post-Step-6 audit see the same non-ambiguity rule that
  // findAmbiguousPromoRowIds enforces elsewhere in the build. The set is
  // an input to hasCurrentPriceProvenance below — passing it here (not
  // deriving inside the predicate) keeps the pure helper testable without
  // holding the whole cards map.
  const provenanceGateOptions = {
    ambiguousIds: findAmbiguousPromoRowIds(database.cards),
  };
  // DIC-1229 CR rev.3 fault-injection hooks — test-only. The regression
  // suite spawns build-database.js with EXACTLY ONE of these set at a
  // time to prove each defence layer catches contamination in isolation:
  //   - HUNTERCARD_DIC1229_DISABLE_STEP6_SKIP=1 disables the Step 6
  //     `continue`, leaving only the audit to catch. When contamination
  //     is present the audit MUST throw — a mutation that removes the
  //     audit is what this scenario is sensitive to.
  //   - HUNTERCARD_DIC1229_DISABLE_AUDIT=1 disables the post-Step-6
  //     throw, leaving only Step 6 to catch. When contamination is
  //     present Step 6 skip MUST prevent the merge and the row MUST
  //     ship priceHistory=empty — a mutation that removes the Step 6
  //     skip is what this scenario is sensitive to.
  // Under normal daily runs BOTH env vars are unset; both defences run.
  // The one-time log lines make the fault injection observable in the
  // scheduler log and force the test suite to fail loudly if either
  // hook accidentally leaks into a real run.
  const disableStep6Skip = process.env.HUNTERCARD_DIC1229_DISABLE_STEP6_SKIP === '1';
  const disableAudit = process.env.HUNTERCARD_DIC1229_DISABLE_AUDIT === '1';
  if (disableStep6Skip) {
    console.log('  [DIC-1229] ⚠️ HUNTERCARD_DIC1229_DISABLE_STEP6_SKIP=1 — Step 6 skip DISABLED (test-only fault injection)');
  }
  if (disableAudit) {
    console.log('  [DIC-1229] ⚠️ HUNTERCARD_DIC1229_DISABLE_AUDIT=1 — post-Step-6 audit DISABLED (test-only fault injection)');
  }
  let mergedCount = 0;
  let droppedRecords = 0;
  let skippedUnproven = 0;
  for (const [cardId, card] of Object.entries(database.cards)) {
    const histFile = path.join(historyDir, `${cardId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
    // DIC-1229: unproven printings must never inherit a durable history.
    // Skip the merge (card.priceHistory stays empty) — the durable file is
    // left in place so a follow-up scrape that restores provenance can also
    // restore any LEGITIMATE historical records the file still carries. A
    // one-shot cleanup pass (migration) is responsible for purging clearly-
    // poisoned files (e.g. the single-record 08-28 stamps left on hPR
    // rows by the pre-DIC-1227 daily scrape). The DIC-1229 post-Step-6
    // hard-fail audit guarantees no unproven row ever ships priceHistory
    // regardless of what survives on disk.
    if (!hasCurrentPriceProvenance(card, provenanceGateOptions)) {
      skippedUnproven++;
      // DIC-1229 rev.5: `applyPreservedMarketFields` can copy priceHistory
      // forward when its structural checks pass; those checks don't include
      // the freshness dimension the rev.3 predicate added. Fail-closed the
      // same rule at Step 6 by also clearing any preserved priceHistory on
      // the unproven row so the audit invariant holds regardless of arrival
      // path. Audit stays live as the mutation-sensitive guard.
      if (card.priceHistory && typeof card.priceHistory === 'object'
          && Object.keys(card.priceHistory).length > 0) {
        card.priceHistory = {};
      }
      if (card.priceHistoryMeta) delete card.priceHistoryMeta;
      if (disableStep6Skip) {
        // Fault-injection path: fall through to the merge below so the
        // audit gets to catch the contamination. This is UNREACHABLE
        // under normal runs — HUNTERCARD_DIC1229_DISABLE_STEP6_SKIP is
        // test-only.
      } else {
        continue;
      }
    }
    try {
      const hist = JSON.parse(fs.readFileSync(histFile, 'utf-8'));
      if (hist.records && hist.records.length > 0) {
        const filtered = filterProvenanceMatchedRecords(hist.records, card);
        droppedRecords += (hist.records.length - filtered.length);
        if (filtered.length === 0) continue;
        const ph = {};
        for (const r of filtered) ph[r.date] = r.price;
        card.priceHistory = sanitizePriceHistory(ph);
        mergedCount++;
      }
    } catch {
      // no history file for this card, skip
    }
  }
  console.log(`  [priceHistory] Merged into ${mergedCount} cards${droppedRecords > 0 ? `; dropped ${droppedRecords} cross-provenance records` : ''}${skippedUnproven > 0 ? `; skipped ${skippedUnproven} unproven printings (DIC-1229 fail-closed)` : ''}`);

  // DIC-1229 hard-fail audit: after Step 6 no card may ship a non-empty
  // `priceHistory` unless it also has current price provenance. This gate
  // makes the "unproven printing must stay unknown across all price
  // surfaces" invariant a build-time failure rather than a warn-only
  // regression. If any row violates it, throw so the daily scheduler
  // exits non-zero (the pipeline's fail-fast contract, DIC-1219). The
  // predicate is a pure function (`findUnprovenPriceHistoryViolations`
  // in preserve-market-fields.js) so the mutation-sensitive test suite
  // can call it directly with poisoned fixtures — this call is the
  // production wire.
  if (!disableAudit) {
    const violations = findUnprovenPriceHistoryViolations(database.cards, provenanceGateOptions);
    if (violations.length > 0) {
      const rendered = violations.slice(0, 5).map((v) => `${v.id} (days=${v.dayCount})`);
      throw new Error(
        `[DIC-1229] ${violations.length} unproven printing(s) shipped priceHistory: ` +
        rendered.join(', ') +
        (violations.length > 5 ? `, +${violations.length - 5} more` : '') +
        `. hasCurrentPriceProvenance must be true for any row carrying priceHistory (no cross-version / cross-printing fallback).`
      );
    }
  }

  // Step 6b: Do not restore stale buy prices from the previous database. Buy prices
  // are source-listing claims, not history like sell prices; merge-buy-prices.js is
  // the only writer allowed to attach current exact-print provenance.

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