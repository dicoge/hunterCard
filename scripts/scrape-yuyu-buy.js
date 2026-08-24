/**
 * scrape-yuyu-buy.js — hololive OCG 買取（回收）價格爬蟲 (yuyu-tei) — DIC-1139
 *
 * Adds Yuyu-tei buy pages (`https://yuyu-tei.jp/buy/hocg/s/{series}`) as a
 * third canonical buy-price source alongside fullahead / torecolo. Yuyu-tei
 * publishes ONE listing per physical printing per errata revision and prints
 * the exact daily buy price on that listing, so the source proves buy prices
 * per canonical tier with no cross-tier fallback.
 *
 * Alignment rules (issue owner's spec):
 *   - Tier is derived from the LISTING NAME (`classifyVariant`) — the same
 *     model the sell-side prices[] uses — so a source-proven buy price never
 *     leaks across tiers.
 *   - `(パラレル/サイン)` → source rarity 'SEC' (signed). Aligns only to the
 *     `PARALLEL/SIGN` printing in prices[].
 *   - `(パラレル/HR)` etc → source rarity = that explicit rarity token.
 *   - `(パラレル)` alone (純平行) → source rarity taken from Yuyu's own
 *     ALT-text rarity code (OUR/OSR/UR/SR/HR/RR) so the merge's parallel-
 *     pool alignment can pick it up. When the ALT-text rarity isn't in the
 *     standard-parallel allowlist the entry is dropped (fail-closed rather
 *     than silently keying a bare/base match).
 *   - No parenthetical (base tier) → source rarity null; keys to the bare
 *     card number and aligns only to the base printing.
 *   - `エラッタ前` / `エラッタ後` in the same tier collapse to the same
 *     source key. When both prices agree, that's the canonical proven price.
 *     When they diverge, the source contradicts itself for that tier → the
 *     entry is dropped (fail-closed).
 *
 * Output: data/buy-prices/yuyu-prices.json in the shared source-file format
 *   { "hBP02-003-SEC": { buyPrice, rarity: "SEC", timestamp }, "hBP02-003": {...} }
 * so merge-buy-prices.js reads it without change once `yuyu-prices.json` is
 * added to SOURCE_FILES.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  classifyVariant,
  classifySourceRarity,
  normalizeCardNumber,
  UNKNOWN_TOKEN,
  PARALLEL_RARITIES,
} from './lib/variant-key.js';
import { stripErrataLabel } from './lib/canonical-printings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, '../data/database.json');
const OUTPUT_DIR = path.join(__dirname, '../data/buy-prices');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'yuyu-prices.json');

const BASE = 'https://yuyu-tei.jp';
const BUY_PATH = '/buy/hocg/s';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const REQUEST_SPACING_MS = 2500;
const SHRINK_THRESHOLD = 0.5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadSeriesList() {
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  const series = new Set();
  for (const card of Object.values(db.cards || {})) {
    if (typeof card.series === 'string' && /^h[A-Za-z]{1,4}\d{0,3}$/.test(card.series)) {
      series.add(card.series);
    }
  }
  return [...series].sort();
}

function readPreviousCount(file) {
  try {
    const prev = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return prev && typeof prev === 'object' ? Object.keys(prev).length : 0;
  } catch {
    return 0;
  }
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'ja,en;q=0.8',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      Referer: 'https://yuyu-tei.jp/',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/**
 * Parse ONE Yuyu buy-page HTML string into raw per-listing rows. Pure so it
 * is trivially testable against fixtures without live network access.
 *
 * The page renders each listing inside a `.card-product` div containing:
 *   <img alt="hBP02-003 SEC 宝鐘マリン(パラレル/サイン)(エラッタ後)">
 *   <h4 class="text-primary fw-bold">宝鐘マリン(パラレル/サイン)(エラッタ後)</h4>
 *   <strong class="... text-purple ...">62,000 円</strong>
 *
 * We prefer the `<h4>` name over the ALT text so the tier classification
 * matches how the sell-side prices[] is keyed; the ALT-text rarity is kept
 * only as a fallback for `(パラレル)` alone (純平行), where the listing name
 * cannot state which standard-parallel rarity applies.
 */
function parseBuyPageHtml(html) {
  const rows = [];
  // Split by card-product openings; slice(1) drops the pre-first-block chunk.
  const blocks = html.split(/<div\s+class="card-product[^"]*"/i).slice(1);
  for (const block of blocks) {
    // Bound the block to the next .card-product so cross-block matches can't leak.
    const chunk = block.slice(0, 4000);

    const altMatch = chunk.match(/alt="((?:h[A-Za-z]{1,4}\d+-\d+)[^"]*)"/);
    const nameMatch = chunk.match(
      /<h4[^>]*class="[^"]*text-primary[^"]*fw-bold[^"]*"[^>]*>([^<]+)</
    );
    const priceMatch = chunk.match(
      /<strong[^>]*class="[^"]*text-purple[^"]*"[^>]*>\s*([\d,]+)\s*円/
    );
    if (!altMatch || !nameMatch || !priceMatch) continue;

    const alt = altMatch[1];
    const cardNumber = normalizeCardNumber(alt);
    if (!cardNumber) continue;

    // ALT text carries "<card> <rarity> <name>" — the middle token is Yuyu's
    // own rarity classification of that listing (SEC/OUR/OSR/…), used only
    // as the 純平行 fallback below.
    const altRarityMatch = alt.slice(cardNumber.length).trim().match(/^([A-Z]{1,4}\d*)/);
    const altRarity = altRarityMatch ? altRarityMatch[1] : '';

    const listingName = nameMatch[1].trim();
    const buyPrice = parseInt(priceMatch[1].replace(/,/g, ''), 10);
    if (!Number.isFinite(buyPrice) || buyPrice <= 0) continue;

    rows.push({ cardNumber, listingName, altRarity, buyPrice });
  }
  return rows;
}

/**
 * Choose the exact source rarity token for one listing:
 *   - Prefer classifyVariant on the listing name (matches sell-side prices[]).
 *   - For `(パラレル)` alone (純平行), fall back to the ALT-text rarity but
 *     require it to be a standard-parallel code — otherwise fail closed.
 *   - `#…` sentinel from classifyVariant (unknown parenthetical) → fail closed.
 *   - Base (no parenthetical) → rarity null (bare key).
 */
function resolveSourceRarity(listingName, altRarity) {
  const { versionClass, token } = classifyVariant(listingName);
  if (versionClass === 'signed') return token; // 'SEC'
  if (versionClass === 'parallel') {
    if (token && token.startsWith('#')) return UNKNOWN_TOKEN;
    if (token != null) return token; // explicit rarity from listing name
    // (パラレル) alone → look at ALT-text rarity
    const cls = classifySourceRarity(altRarity);
    if (cls.kind === 'known' && PARALLEL_RARITIES.has(cls.token)) return cls.token;
    return UNKNOWN_TOKEN; // can't prove which standard-parallel rarity this is
  }
  return null; // base
}

/**
 * Fold raw rows into per-key entries. Errata revisions in the same tier
 * collapse onto ONE key; when their prices disagree the entry is dropped
 * (fail-closed — a source that contradicts itself does not "prove" a price).
 */
function foldRows(rows, timestamp) {
  const grouped = new Map(); // key -> { prices:Set<number>, rarity, cardNumber }
  let dropped = 0;
  for (const { cardNumber, listingName, altRarity, buyPrice } of rows) {
    const rarity = resolveSourceRarity(listingName, altRarity);
    if (rarity === UNKNOWN_TOKEN) {
      dropped += 1;
      continue;
    }
    const key = rarity ? `${cardNumber}-${rarity}` : cardNumber;
    if (!grouped.has(key)) {
      grouped.set(key, {
        prices: new Set(),
        rarity: rarity || null,
        cardNumber,
        canonicalName: stripErrataLabel(listingName),
      });
    }
    grouped.get(key).prices.add(buyPrice);
  }

  const out = {};
  let contradictions = 0;
  for (const [key, { prices, rarity }] of grouped) {
    if (prices.size === 0) continue;
    if (prices.size > 1) {
      // The source disagrees with itself for this tier — errata pre/post
      // rows publish different buy prices. We refuse to guess which is the
      // canonical amount and drop the entry.
      contradictions += 1;
      continue;
    }
    const [only] = prices;
    out[key] = { buyPrice: only, rarity, timestamp };
  }
  return { out, dropped, contradictions };
}

async function scrape() {
  console.log('[yuyu-buy] Starting...');
  const startTime = Date.now();

  const seriesList = loadSeriesList();
  if (seriesList.length === 0) {
    throw new Error('[yuyu-buy] No series discovered from database.json — refusing to write.');
  }
  console.log(`[yuyu-buy] Series to fetch: ${seriesList.length}`);

  const collected = new Map(); // key -> { buyPrice, rarity, timestamp }
  let allDropped = 0;
  let allContradictions = 0;

  for (const series of seriesList) {
    const url = `${BASE}${BUY_PATH}/${series}`;
    console.log(`[yuyu-buy] GET ${url}`);
    try {
      const html = await fetchHtml(url);
      const raw = parseBuyPageHtml(html);
      const timestamp = new Date().toISOString();
      const { out, dropped, contradictions } = foldRows(raw, timestamp);
      const keys = Object.keys(out);
      console.log(
        `  → parsed ${raw.length} listings, kept ${keys.length}, dropped ${dropped}, contradictions ${contradictions}`
      );
      allDropped += dropped;
      allContradictions += contradictions;
      for (const [k, v] of Object.entries(out)) {
        const prev = collected.get(k);
        // Same (card,tier) may appear on multiple series pages via reprints.
        // Keep the higher proven price — that matches fullahead/torecolo's
        // same-tier-two-listings merge convention (see merge-buy-prices.js).
        if (!prev || v.buyPrice > prev.buyPrice) collected.set(k, v);
      }
    } catch (err) {
      // A single series failure must not corrupt the whole write, but neither
      // may it silently produce a partial file. Warn and continue; abort at
      // the aggregate level if we ended up with too little.
      console.warn(`  → ${err.message}`);
    }
    await sleep(REQUEST_SPACING_MS);
  }

  if (collected.size === 0) {
    throw new Error(
      '[yuyu-buy] Refusing to write: crawl produced 0 prices (network block or page-structure change).'
    );
  }
  const prevCount = readPreviousCount(OUTPUT_FILE);
  if (prevCount > 0 && collected.size < prevCount * SHRINK_THRESHOLD) {
    throw new Error(
      `[yuyu-buy] Refusing to write: new crawl has ${collected.size} entries but previous file had ${prevCount} (< ${Math.round(SHRINK_THRESHOLD * 100)}%).`
    );
  }

  const out = {};
  for (const [key, val] of collected.entries()) out[key] = val;

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, `${JSON.stringify(out, null, 2)}\n`, 'utf-8');

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `[yuyu-buy] ✅ Done in ${duration}s — wrote ${Object.keys(out).length} entries (dropped ${allDropped}, contradictions ${allContradictions})`
  );
  console.log(`[yuyu-buy] Output: ${OUTPUT_FILE}`);
  return out;
}

const isMain = process.argv[1] && process.argv[1].includes('scrape-yuyu-buy');
if (isMain) {
  scrape()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[yuyu-buy] fatal:', err);
      process.exit(1);
    });
}

export { scrape, parseBuyPageHtml, resolveSourceRarity, foldRows };
