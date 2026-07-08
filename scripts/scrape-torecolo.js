/**
 * Scraper for torecolo.jp (CBトレコロ) hololive TCG buy (買取) prices.
 *
 * Target: https://www.torecolo.jp/shop/e/eHLpSEC/ (hololive 買取表)
 * Output: data/raw-buy-torecolo.json — array of
 *   { source: "torecolo", name, cardNumber, rarity, versionCardNumber, buyPrice }
 * where rarity is the card version (e.g. "SEC") and versionCardNumber puts the
 * version before the number ("SEC-hBP08-003") so different versions of the same
 * card number stay distinct.
 *
 * Notes on the page structure (verified 2026-07-06):
 * - Each listing is a `.block-thumbnail-t--goods` block.
 * - Name lives in `a.js-enhanced-ecommerce-goods-name` (title attr / text).
 * - The card number + version are embedded in the goods link
 *   `/shop/g/gHL-HBP08-003SEC-S/` and the cart link `...goods=HL-HBP08-003SEC-S...`
 *   → cardNumber hBP08-003, rarity SEC.
 * - Buy price is `.block-thumbnail-t--price` text, e.g. "強化買取価格130,000円".
 * - Server returns full HTML to a normal UA (no JS render needed), so a plain
 *   fetch + cheerio is enough. A User-Agent header is sent to avoid being
 *   treated as a bot. Pagination is auto-detected and followed if present.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE = 'https://www.torecolo.jp';
const START_URL = 'https://www.torecolo.jp/shop/e/eHLpSEC/';
const OUTPUT_FILE = path.join(__dirname, '../data/raw-buy-torecolo.json');
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'ja,en;q=0.8',
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.text();
}

/**
 * Decompose a goods code such as "HL-HBP08-003SEC-S" into its parts:
 *   cardNumber "hBP08-003"  (series + number, no rarity)
 *   rarity     "SEC"        (the version/rarity token before the trailing -S)
 * The same physical card number can appear in several rarities (a higher-tier
 * card may have up to three versions), so rarity is what distinguishes them.
 * Returns { cardNumber: "", rarity: "" } when no recognizable code is present.
 */
function parseGoodsCode(goodsCode) {
  if (!goodsCode) return { cardNumber: '', rarity: '' };

  // Match: <series letters><series digits>-<number><rarity letters?>, e.g.
  //   HBP08-003SEC   → series HBP08, number 003, rarity SEC
  //   HBP01-006      → series HBP01, number 006, rarity "" (base)
  const m = goodsCode.match(/(h[A-Za-z]+\d{2,3})-(\d{2,3})([A-Za-z]+)?/i);
  if (!m) return { cardNumber: '', rarity: '' };

  const series = m[1];
  const num = m[2];
  const rarity = (m[3] || '').toUpperCase();

  // Normalize series casing to the "hBP08" convention: leading 'h' lowercase,
  // remaining series letters uppercase, digits as-is.
  const sp = series.match(/^h([A-Za-z]+)(\d.*)$/i);
  const cardNumber = sp ? 'h' + sp[1].toUpperCase() + sp[2] : series;

  return { cardNumber: `${cardNumber}-${num}`, rarity };
}

function parsePrice(text) {
  if (!text) return null;
  const m = text.match(/([\d,]+)\s*円/);
  if (!m) return null;
  const n = parseInt(m[1].replace(/,/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseGoodsFromHtml(html) {
  const $ = cheerio.load(html);
  const items = [];

  $('.block-thumbnail-t--goods').each((_, el) => {
    const $el = $(el);

    const $name = $el.find('a.js-enhanced-ecommerce-goods-name').first();
    const name = ($name.attr('title') || $name.text() || '').trim();

    // Prefer the goods detail link, fall back to the cart link, for the code.
    let goodsCode = '';
    const detailHref = $el.find('a[href*="/shop/g/"]').first().attr('href') || '';
    const detailMatch = detailHref.match(/\/shop\/g\/g([A-Za-z0-9-]+?)(?:-S)?\/?$/);
    if (detailMatch) {
      goodsCode = detailMatch[1];
    } else {
      const cartHref = $el.find('a[href*="goods="]').first().attr('href') || '';
      const cartMatch = cartHref.match(/goods=([A-Za-z0-9-]+)/);
      if (cartMatch) goodsCode = cartMatch[1];
    }
    const { cardNumber, rarity } = parseGoodsCode(goodsCode);

    const priceText = $el.find('.block-thumbnail-t--price').first().text();
    const buyPrice = parsePrice(priceText);

    if (!name || buyPrice == null) return;

    // "版本在卡號前": the unique key puts the version (rarity) before the
    // card number so different versions of the same number stay distinct,
    // e.g. "SEC-hBP08-003". Falls back to the bare number when no rarity.
    const versionCardNumber = rarity && cardNumber
      ? `${rarity}-${cardNumber}`
      : cardNumber;

    items.push({
      source: 'torecolo',
      name,
      cardNumber,
      rarity,
      versionCardNumber,
      buyPrice,
    });
  });

  return items;
}

/**
 * Find a "next page" URL if the listing is paginated. Torecolo (EC-CUBE style)
 * paginators use rel="next" or a page link; return an absolute URL or null.
 */
function findNextPageUrl(html, currentUrl) {
  const $ = cheerio.load(html);

  const relNext = $('a[rel="next"], link[rel="next"]').first().attr('href');
  if (relNext) return new URL(relNext, currentUrl).href;

  // Common EC-CUBE pager: look for a "次へ"/">" link inside a pagination block.
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
  console.log('[torecolo] Starting scrape...');
  const startTime = Date.now();

  const all = [];
  const seen = new Set(); // dedupe on version+number+name (keeps versions distinct)
  const visited = new Set();
  let url = START_URL;
  let pageNo = 0;

  while (url && !visited.has(url) && pageNo < 50) {
    visited.add(url);
    pageNo += 1;
    console.log(`[torecolo] Page ${pageNo}: ${url}`);

    let html;
    try {
      html = await fetchHtml(url);
    } catch (err) {
      console.error(`[torecolo] Fetch failed: ${err.message}`);
      break;
    }

    const items = parseGoodsFromHtml(html);
    console.log(`  → parsed ${items.length} listings`);

    for (const it of items) {
      const key = `${it.versionCardNumber}|${it.name}|${it.buyPrice}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(it);
    }

    const next = findNextPageUrl(html, url);
    if (!next || next === url) {
      url = null;
    } else {
      url = next;
      await sleep(1500 + Math.random() * 1000);
    }
  }

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(all, null, 2), 'utf-8');

  const withNumber = all.filter((x) => x.cardNumber).length;
  const withRarity = all.filter((x) => x.rarity).length;
  const rarityCounts = {};
  for (const x of all) {
    const r = x.rarity || '(none)';
    rarityCounts[r] = (rarityCounts[r] || 0) + 1;
  }
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `\n[torecolo] ✅ Done in ${duration}s — 抓到 ${all.length} 筆 ` +
      `(${withNumber} 筆有卡號, ${withRarity} 筆有版本) ` +
      `across ${pageNo} page(s)`
  );
  console.log(`[torecolo] 版本分佈: ${JSON.stringify(rarityCounts)}`);
  console.log(`[torecolo] Output: ${OUTPUT_FILE}`);

  return { total: all.length, withNumber, withRarity, rarityCounts, pages: pageNo };
}

const isMain =
  process.argv[1] && process.argv[1].includes('scrape-torecolo');

if (isMain) {
  scrape()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[torecolo] Fatal:', err);
      process.exit(1);
    });
}

export { scrape };
