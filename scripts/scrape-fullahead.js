import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FULLAHEAD_URL = 'https://fullahead-buy.com/shopbrand/hocg/';
const OUTPUT_PATH = path.join(__dirname, '../data/raw-buy-fullahead.json');
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CARD_NUMBER_RE = /h[A-Za-z]{1,4}\d{2,3}-\d{2,3}/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseProductName(raw) {
  const text = String(raw || '');
  const numMatch = text.match(CARD_NUMBER_RE);
  const cardNumber = numMatch ? numMatch[0] : '';
  const name = text
    .replace(/【[^】]*】/g, ' ')
    .replace(CARD_NUMBER_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { name, cardNumber };
}

async function scrapeFullahead() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
    });

    let apiBase = null;
    let apiToken = null;
    page.on('request', (req) => {
      const url = req.url();
      if (url.includes('fetchRecords.php') && url.includes('app=38') && !apiToken) {
        apiBase = url.split('?')[0];
        const m = url.match(/apiToken=([^&]+)/);
        if (m) apiToken = m[1];
      }
    });

    await page.goto(FULLAHEAD_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(2500);

    if (!apiBase || !apiToken) {
      throw new Error('could not capture Fullahead API token from page requests');
    }

    const records = await page.evaluate(
      async (base, token) => {
        const query =
          '(CATEGORY_PATH_1 = "hololive OFFICIAL CARD GAME") and PURCHASE_PRICE > 0 and VALID_INVALID in ("有効")';
        const fields = ['ORGIN_CODE', 'PRODUCT_NAME', 'PURCHASE_PRICE', '$id'];
        const fieldParams = fields
          .map((field) => 'fields%5B%5D=' + encodeURIComponent(field))
          .join('&');
        const out = [];
        let lastRecId = -1;

        for (let pageNo = 0; pageNo < 100; pageNo += 1) {
          const url = `${base}?app=38&query=${encodeURIComponent(query)}&apiToken=${token}&lastRecId=${lastRecId}&${fieldParams}`;
          const resp = await fetch(url, { credentials: 'include' });
          if (!resp.ok) throw new Error(`Fullahead API returned HTTP ${resp.status}`);
          const json = await resp.json();
          const recs = (json.json && json.json.records) || [];
          if (!recs.length) break;

          for (const rec of recs) {
            out.push({
              productName: rec.PRODUCT_NAME && rec.PRODUCT_NAME.value,
              price: rec.PURCHASE_PRICE && rec.PURCHASE_PRICE.value,
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

    return records
      .map((rec) => {
        const buyPrice = parseInt(String(rec.price || '').replace(/,/g, ''), 10);
        const { name, cardNumber } = parseProductName(rec.productName);
        return { source: 'fullahead', name, cardNumber, buyPrice };
      })
      .filter((item) => item.name && Number.isFinite(item.buyPrice) && item.buyPrice > 0);
  } finally {
    await browser.close();
  }
}

async function main() {
  const data = await scrapeFullahead();
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(data, null, 2)}\n`);

  const withCardNumber = data.filter((item) => item.cardNumber).length;
  console.log(`Fullahead total: ${data.length}`);
  console.log(`With cardNumber: ${withCardNumber}`);
  console.log(`Wrote: ${path.relative(process.cwd(), OUTPUT_PATH)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
