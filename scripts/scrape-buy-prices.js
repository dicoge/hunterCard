/**
 * Scraper for store BUY prices (買取価格 / 回收價格) of hololive TCG cards.
 *
 * Sources:
 *   - fullahead : https://fullahead-buy.com  (prices served from an internal
 *                 fetchRecords.php JSON API; we capture the apiToken from the
 *                 rendered page and paginate the API directly)
 *   - torecolo  : https://www.torecolo.jp/shop/e/eHLpSEC/ (prices in static HTML)
 *
 * Buy prices are NOT written to database.json — they are stored only in
 * data/buy-price-history.json for internal price-trend analysis.
 *
 * Output file format (keyed by cardId from database.json):
 *   {
 *     "hBP01-001_hBP01": {
 *       "2026-07-06": { "fullahead": 500, "torecolo": 480, "avg": 490 }
 *     }
 *   }
 */
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CARD_NUMBER_RE, extractCardNumber } from './lib/card-number.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, '../data/database.json');
const HISTORY_PATH = path.join(__dirname, '../data/buy-price-history.json');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// fullahead landing page whose scripts talk to the buy-price JSON API
const FULLAHEAD_URL = 'https://fullahead-buy.com/?shopbrand=hocg';
// torecolo hololive buy-price list (SEC 買取表). Extra URLs can be appended here.
const TORECOLO_URLS = ['https://www.torecolo.jp/shop/e/eHLpSEC/'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function localDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Normalise a card name for fuzzy matching: lower-case, drop whitespace and
// common punctuation so "白銀ノエル" / "白銀 ノエル" collapse together.
function normName(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[【】\[\]（）()「」『』\s・,、。.\-_/]/g, '')
    .trim();
}

// Extract card number + a cleaned display name from a fullahead PRODUCT_NAME
// e.g. "【UR】hBP01-091 ムーナ・ホシノヴァ" -> { cardNumber: 'hBP01-091', name: 'ムーナ・ホシノヴァ' }
function parseProductName(raw) {
  const cardNumber = extractCardNumber(raw);
  let name = (raw || '')
    .replace(/【[^】]*】/g, ' ') // rarity / promo tags
    .replace(CARD_NUMBER_RE, ' ') // the card number itself
    .replace(/\s+/g, ' ')
    .trim();
  return { cardNumber, name };
}

/**
 * Build lookup indexes from database.json.
 * Returns { byNumber: Map(UPPER cardNumber -> [cardId]), byName: Map(normName -> [cardId]) }
 */
function buildIndexes() {
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  const byNumber = new Map();
  const byName = new Map();
  for (const [cardId, card] of Object.entries(db.cards || {})) {
    if (card.cardNumber) {
      const key = card.cardNumber.toUpperCase();
      if (!byNumber.has(key)) byNumber.set(key, []);
      byNumber.get(key).push(cardId);
    }
    for (const nm of [card.name, card.yuyuName, card.nameZh]) {
      const nk = normName(nm);
      if (!nk) continue;
      if (!byName.has(nk)) byName.set(nk, []);
      if (!byName.get(nk).includes(cardId)) byName.get(nk).push(cardId);
    }
  }
  return { byNumber, byName };
}

/**
 * Resolve a scraped record to database cardId(s).
 * A single scraped card number can map to multiple catalog variants that share
 * the same cardNumber (e.g. hBD24-008_ent07 and hBD24-008_hPR). Those variants
 * are the same physical card printed in different products, so the buy price
 * applies to all of them — we fan out and record it against EVERY match rather
 * than silently keeping only the first candidate.
 * 1) exact card-number match (case-insensitive) -> all candidates.
 * 2) fuzzy card-name match (normalised equality), only when unambiguous.
 * 3) otherwise [] (caller logs + skips).
 */
function matchCardIds({ cardNumber, name }, { byNumber, byName }) {
  if (cardNumber) {
    const candidates = byNumber.get(cardNumber.toUpperCase());
    if (candidates && candidates.length) return candidates.slice();
  }
  const nk = normName(name);
  if (nk && byName.has(nk)) {
    const candidates = byName.get(nk);
    if (candidates.length === 1) return candidates.slice();
  }
  return [];
}

/**
 * Scrape fullahead buy prices via its internal JSON API.
 * Returns [{ name, cardNumber, buyPrice }].
 */
async function scrapeFullahead(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);

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

  console.log(`[fullahead] Loading ${FULLAHEAD_URL} ...`);
  await page.goto(FULLAHEAD_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2500);

  if (!apiBase || !apiToken) {
    throw new Error('could not capture fullahead API token from page requests');
  }
  console.log('[fullahead] captured API token, paginating records...');

  const records = await page.evaluate(
    async (base, token) => {
      const query =
        '(CATEGORY_PATH_1 = "hololive OFFICIAL CARD GAME") and PURCHASE_PRICE > 0 and VALID_INVALID in ("有効")';
      const fields = ['ORGIN_CODE', 'PRODUCT_NAME', 'PURCHASE_PRICE', '$id'];
      const fp = fields
        .map((f) => 'fields%5B%5D=' + encodeURIComponent(f))
        .join('&');
      const out = [];
      let lastRecId = -1;
      for (let pageNo = 0; pageNo < 100; pageNo++) {
        const url = `${base}?app=38&query=${encodeURIComponent(query)}&apiToken=${token}&lastRecId=${lastRecId}&${fp}`;
        const resp = await fetch(url);
        // A mid-pagination HTTP failure means we only have part of the list.
        // Throw so the caller treats the whole source as failed instead of
        // committing a truncated snapshot.
        if (!resp.ok) {
          throw new Error(
            `fullahead API page ${pageNo} failed: HTTP ${resp.status}`
          );
        }
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
        if (next == null) break;
        lastRecId = next;
      }
      return out;
    },
    apiBase,
    apiToken
  );

  await page.close();

  const results = [];
  for (const rec of records) {
    const price = parseInt(String(rec.price).replace(/,/g, ''), 10);
    if (!Number.isFinite(price) || price <= 0) continue;
    const { cardNumber, name } = parseProductName(rec.productName);
    results.push({ source: 'fullahead', name, cardNumber, buyPrice: price });
  }
  console.log(`[fullahead] parsed ${results.length} priced items`);
  return results;
}

/**
 * Scrape torecolo buy prices from static-rendered listing pages.
 * Returns [{ name, cardNumber, buyPrice }].
 */
async function scrapeTorecolo(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  const results = [];

  for (const baseUrl of TORECOLO_URLS) {
    const seenHrefs = new Set();
    for (let pageNo = 1; pageNo <= 30; pageNo++) {
      const url = pageNo === 1 ? baseUrl : `${baseUrl}?pageno=${pageNo}`;
      console.log(`[torecolo] Loading ${url} ...`);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(1200);
      } catch (err) {
        // A page-load failure mid-pagination leaves the buy-price list
        // incomplete. Fail the whole source rather than committing partial
        // data (the caller catches this and marks torecolo as failed).
        throw new Error(
          `torecolo page ${pageNo} load failed: ${err.message}`
        );
      }

      const items = await page.evaluate(() => {
        const goods = document.querySelectorAll('.block-thumbnail-t--goods');
        const rows = [];
        goods.forEach((el) => {
          const link =
            el.querySelector('.block-thumbnail-t--goods-name a') ||
            el.querySelector('a[href*="/shop/g/"]');
          const name = link
            ? (link.getAttribute('title') || link.textContent || '').trim()
            : '';
          const href = link ? link.getAttribute('href') || '' : '';
          const category = link ? link.getAttribute('data-category') || '' : '';
          const priceEl = el.querySelector('.block-thumbnail-t--price');
          const priceText = priceEl ? priceEl.textContent || '' : '';
          rows.push({ name, href, category, priceText });
        });
        return rows;
      });

      if (!items.length) break;

      // torecolo ignores out-of-range ?pageno and re-serves the first page,
      // so stop once a page introduces no product we haven't already seen.
      let newOnPage = 0;
      for (const it of items) {
        if (it.href && seenHrefs.has(it.href)) continue;
        if (it.href) seenHrefs.add(it.href);
        newOnPage++;

        const priceMatch = it.priceText.match(/([\d,]+)\s*円/);
        if (!priceMatch) continue;
        const price = parseInt(priceMatch[1].replace(/,/g, ''), 10);
        if (!Number.isFinite(price) || price <= 0) continue;
        // card number lives in the product URL (e.g. gHL-HBP08-003SEC-S)
        const cardNumber = extractCardNumber(it.href);
        results.push({
          source: 'torecolo',
          name: it.name,
          cardNumber,
          buyPrice: price,
        });
      }

      if (newOnPage === 0) break;
    }
  }

  await page.close();
  console.log(`[torecolo] parsed ${results.length} priced items`);
  return results;
}

/**
 * Fold scraped records into per-cardId, per-source best (max) buy prices.
 * Returns { pricesByCard: Map(cardId -> {fullahead?, torecolo?}), stats }.
 */
function reconcile(records, indexes) {
  const pricesByCard = new Map();
  const stats = {
    total: records.length,
    matched: 0,
    unmatched: 0,
    bySource: {},
  };

  for (const rec of records) {
    stats.bySource[rec.source] = (stats.bySource[rec.source] || 0) + 1;
    const cardIds = matchCardIds(rec, indexes);
    if (!cardIds.length) {
      stats.unmatched++;
      console.warn(
        `  [no-match] ${rec.source}: ${rec.cardNumber || '(no number)'} "${rec.name}" @${rec.buyPrice}`
      );
      continue;
    }
    stats.matched++;
    for (const cardId of cardIds) {
      if (!pricesByCard.has(cardId)) pricesByCard.set(cardId, {});
      const entry = pricesByCard.get(cardId);
      // Keep the strongest (highest) buy offer per source for this card.
      if (entry[rec.source] == null || rec.buyPrice > entry[rec.source]) {
        entry[rec.source] = rec.buyPrice;
      }
    }
  }
  return { pricesByCard, stats };
}

function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[warn] could not read existing history (${err.message}) — starting fresh`);
    }
    return {};
  }
}

async function main() {
  console.log('[buy-scraper] Starting buy-price scrape...');
  const startTime = Date.now();

  const indexes = buildIndexes();
  console.log(
    `[buy-scraper] loaded database index: ${indexes.byNumber.size} card numbers`
  );

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const allRecords = [];
  let fullaheadOk = false;
  let torecoloOk = false;

  try {
    const fh = await scrapeFullahead(browser).catch((err) => {
      console.error(`[fullahead] failed: ${err.message}`);
      return [];
    });
    if (fh.length) fullaheadOk = true;
    allRecords.push(...fh);

    const tc = await scrapeTorecolo(browser).catch((err) => {
      console.error(`[torecolo] failed: ${err.message}`);
      return [];
    });
    if (tc.length) torecoloOk = true;
    allRecords.push(...tc);
  } finally {
    await browser.close();
  }

  const { pricesByCard, stats } = reconcile(allRecords, indexes);

  // Merge into history under today's date.
  const date = localDateStr();
  const history = loadHistory();
  let cardsWritten = 0;
  for (const [cardId, sources] of pricesByCard.entries()) {
    const vals = Object.values(sources).filter((v) => Number.isFinite(v));
    if (!vals.length) continue;
    if (!history[cardId]) history[cardId] = {};
    // Merge into any data already recorded for this cardId+date so a second
    // run in the same day (e.g. after one source failed) augments rather than
    // clobbers the earlier successful sources. Newly scraped sources win.
    const existing = history[cardId][date] || {};
    const merged = { ...existing, ...sources };
    const priceVals = Object.entries(merged)
      .filter(([k]) => k !== 'avg')
      .map(([, v]) => v)
      .filter((v) => Number.isFinite(v));
    merged.avg = Math.round(
      priceVals.reduce((a, b) => a + b, 0) / priceVals.length
    );
    history[cardId][date] = merged;
    cardsWritten++;
  }

  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf-8');

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  const matchRate = stats.total
    ? ((stats.matched / stats.total) * 100).toFixed(1)
    : '0.0';

  console.log('\n[buy-scraper] ===== Summary =====');
  console.log(`  fullahead items : ${stats.bySource.fullahead || 0}`);
  console.log(`  torecolo items  : ${stats.bySource.torecolo || 0}`);
  console.log(`  total scraped   : ${stats.total}`);
  console.log(`  matched to db   : ${stats.matched} (${matchRate}%)`);
  console.log(`  unmatched       : ${stats.unmatched}`);
  console.log(`  cards written   : ${cardsWritten} (date ${date})`);
  console.log(`  history cards   : ${Object.keys(history).length}`);
  console.log(`  output          : ${HISTORY_PATH}`);
  console.log(`  duration        : ${duration}s`);

  // Never fail the daily cron pipeline: exit 0 as long as at least one source
  // produced data; treat total-failure as a soft error too (logged above).
  if (!fullaheadOk && !torecoloOk) {
    console.error('[buy-scraper] WARNING: both sources returned no data');
  }
  return { stats, cardsWritten };
}

const isMainModule =
  process.argv[1] && process.argv[1].includes('scrape-buy-prices');

if (isMainModule) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      // Guard the cron pipeline: log but do not propagate a non-zero exit.
      console.error('[buy-scraper] fatal error:', err);
      process.exit(0);
    });
}

export { main as scrapeBuyPrices };
