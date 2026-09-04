#!/usr/bin/env node
/**
 * test-dic1349-fallback-provenance.mjs — DIC-1349 regression.
 *
 * Guards the HTTP fetch fallback in `scripts/build-database.js` against the
 * production failure surfaced by the DIC-1348 post-merge validation: a fresh
 * root install has no `puppeteer-extra`, so the yuyu scrape drops to the
 * fetch fallback. Before this fix the fallback stripped every HTML tag
 * BEFORE parsing and then tried to look up `<img>` URLs from raw HTML using
 * text-position offsets that do not correspond to HTML positions — so
 * `yuyuImage` was almost always absent or wrong. Every fallback listing then
 * failed `pricesEntryExactPrintMatchesSource` on the DIC-1334 gate and no
 * priced cardNumber could be admitted to the final artifact (fresh-scrape
 * 1,196 unique priced cardNumbers, binding rate 0 / 1,196).
 *
 * The tests below cover:
 *   1. Successful fallback → exact-printing binding. A synthetic yuyu-tei
 *      HTML page with three real card-product blocks produces three
 *      entries, each with a canonical `card.yuyu-tei.jp/hocg/{size}/
 *      {product}/{filename}.{ext}` `yuyuImage`, and each entry passes
 *      `pricesEntryExactPrintMatchesSource` against its sourceProduct.
 *   2. Same-cardNumber / different-rarity isolation. Two `hBP04-001` blocks
 *      at different rarities (SEC + OSR) become two separate listings on
 *      the same cardNumber. Neither one's yuyuImage bleeds onto the other,
 *      the DIC-1349 fix does not silently pick "the first image in the
 *      whole page" for either row (the DIC-1229 CR failure mode).
 *   3. Missing / mismatched provenance rejection. A card-product block
 *      whose product image URL is off-host (`evil.example.com`), whose
 *      path shape does not match `/hocg/{size}/{product}/…`, whose scheme
 *      is `javascript:`, or whose block has neither an `<img>` tag nor a
 *      `cart_ver` / `cart_cid` pair is DROPPED rather than admitted with
 *      an empty `yuyuImage` — otherwise the row would fail closed on the
 *      exact-print matcher downstream and just recreate the collapse this
 *      fix repairs.
 *   4. End-to-end binding through build-database.js — a real
 *      `HUNTERCARD_YUYU_FIXTURE_PATH` build that feeds the parseCardHtml
 *      output of a synthetic HTML page into scrapeYuyuPrices' shape lands
 *      the fallback listing onto the correct official printing row.
 *
 * Run: node scripts/test-dic1349-fallback-provenance.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseCardHtml } from './build-database.js';
import { pricesEntryExactPrintMatchesSource, yuyuImageProductPath } from './lib/preserve-market-fields.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..');

/**
 * Build a yuyu-tei-shaped card-product block matching the real page
 * markup (starbtn <img alt="Star" …>, product image with alt "hXXX-nnn
 * RARITY name", span with cardNumber, h4 with name, price in "円",
 * hidden cart_ver / cart_cid inputs). The overrides drop / mangle
 * individual fields so the fail-closed cases can drive a single mutation
 * against a known-good baseline.
 */
function makeCardBlock(overrides = {}) {
  const cardNum = overrides.cardNum ?? 'hBP04-001';
  const rarity = overrides.rarity ?? 'SEC';
  const name = overrides.name ?? '博衣こより(パラレル/サイン)';
  const price = overrides.price ?? '99,800';
  const imgSrc = overrides.imgSrc ?? 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10003.jpg';
  const cartVer = overrides.cartVer ?? 'hbp04';
  const cartCid = overrides.cartCid ?? '10003';
  const includeImg = overrides.includeImg ?? true;
  const includeCartInputs = overrides.includeCartInputs ?? true;
  const alt = `${cardNum} ${rarity} ${name}`;

  const productImg = includeImg
    ? `<img src="${imgSrc}" alt="${alt}" class="card img-fluid">`
    : '';
  const cartInputs = includeCartInputs
    ? `<input type="hidden" value="${cartVer}" class="cart_ver">\n<input type="hidden" value="${cartCid}" class="cart_cid">`
    : '';

  return `
<div class="card-product position-relative mt-4  "><div class="starbtn" onclick="location.href='https://yuyu-tei.jp/member/login'">
<em class="d-block position-absolute z-index top-0 start-0"></em>
<img src="https://cdn.yuyu-tei.jp/images/common/btn-icon/star.svg" alt="Star" class="star star1 position-absolute z-index"></div>
<a href="https://yuyu-tei.jp/sell/hocg/card/${cartVer}/${cartCid}"><div class="position-relative product-img">
${productImg}</div>
</a>
<span class="d-block border border-dark p-1 w-100 text-center my-2">${cardNum}</span>
<a href="https://yuyu-tei.jp/sell/hocg/card/${cartVer}/${cartCid}"><h4 class="text-primary fw-bold">${name}</h4>
</a>
<strong class="d-block text-end ">
${price} 円
</strong>
${cartInputs}
</div>`;
}

function wrapPage(blocks) {
  return `<!DOCTYPE html><html><body><div class="row row-cols-md-4">${blocks.join('\n')}</div></body></html>`;
}

// ── Case 1: successful fallback → exact-printing binding ──
{
  const html = wrapPage([
    makeCardBlock({ cardNum: 'hBP04-001', rarity: 'SEC', imgSrc: 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10003.jpg', cartVer: 'hbp04', cartCid: '10003' }),
    makeCardBlock({ cardNum: 'hBP04-004', rarity: 'OUR', name: '雪花ラミィ(パラレル)', price: '14,800', imgSrc: 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10009.jpg', cartVer: 'hbp04', cartCid: '10009' }),
    makeCardBlock({ cardNum: 'hSD10-001', rarity: 'C', name: 'ときのそら', price: '30', imgSrc: 'https://card.yuyu-tei.jp/hocg/100_140/promo-hsd10/12345.jpg', cartVer: 'promo-hsd10', cartCid: '12345' }),
  ]);

  const cards = parseCardHtml(html);
  assert.equal(cards.length, 3, `case 1: expected 3 parsed listings, got ${cards.length}`);
  assert.deepEqual(
    cards.map((c) => c.cardNum),
    ['hBP04-001', 'hBP04-004', 'hSD10-001'],
    'case 1: card numbers must be preserved in page order',
  );
  assert.deepEqual(
    cards.map((c) => c.rarity),
    ['SEC', 'OUR', 'C'],
    'case 1: rarity codes must be extracted from the product image alt attribute',
  );
  assert.deepEqual(
    cards.map((c) => c.imageVersion),
    ['hbp04', 'hbp04', 'promo-hsd10'],
    'case 1: imageVersion must be populated from the cart_ver hidden input',
  );
  assert.deepEqual(
    cards.map((c) => c.imageCid),
    ['10003', '10009', '12345'],
    'case 1: imageCid must be populated from the cart_cid hidden input',
  );
  for (const c of cards) {
    assert.ok(
      /^https:\/\/card\.yuyu-tei\.jp\/hocg\/100_140\/[a-z0-9-]+\/[a-z0-9-]+\.jpg$/i.test(c.yuyuImage),
      `case 1: yuyuImage must be a canonical yuyu-tei product URL, got ${JSON.stringify(c.yuyuImage)}`,
    );
  }
  assert.ok(
    pricesEntryExactPrintMatchesSource({ sellPrice: cards[0].sellPrice, imageUrl: cards[0].yuyuImage }, 'hBP04'),
    'case 1: hBP04-001 SEC must pass pricesEntryExactPrintMatchesSource for sourceProduct hBP04',
  );
  assert.ok(
    pricesEntryExactPrintMatchesSource({ sellPrice: cards[1].sellPrice, imageUrl: cards[1].yuyuImage }, 'hBP04'),
    'case 1: hBP04-004 OUR must pass pricesEntryExactPrintMatchesSource for sourceProduct hBP04',
  );
  assert.ok(
    pricesEntryExactPrintMatchesSource({ sellPrice: cards[2].sellPrice, imageUrl: cards[2].yuyuImage }, 'hPR'),
    'case 1: hSD10-001 promo-hsd10 must pass pricesEntryExactPrintMatchesSource for sourceProduct hPR (known promo carve-out)',
  );
}

// ── Case 2: same-cardNumber / different-rarity isolation ──
{
  const html = wrapPage([
    makeCardBlock({ cardNum: 'hBP04-001', rarity: 'SEC', imgSrc: 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10003.jpg', cartVer: 'hbp04', cartCid: '10003', price: '99,800' }),
    makeCardBlock({ cardNum: 'hBP04-001', rarity: 'OSR', name: '博衣こより', imgSrc: 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10001.jpg', cartVer: 'hbp04', cartCid: '10001', price: '580' }),
    // A third block that would have collided in the old text-position
    // fallback: same product but different card, its image URL sits close to
    // the second hBP04-001 block in the raw HTML. The block-scoped parser
    // must keep the URLs on their own rows.
    makeCardBlock({ cardNum: 'hBP04-002', rarity: 'C', name: '別カード', imgSrc: 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/20001.jpg', cartVer: 'hbp04', cartCid: '20001', price: '30' }),
  ]);

  const cards = parseCardHtml(html);
  const bp001 = cards.filter((c) => c.cardNum === 'hBP04-001');
  const bp002 = cards.filter((c) => c.cardNum === 'hBP04-002');
  assert.equal(bp001.length, 2, 'case 2: both hBP04-001 rarities must survive as separate listings');
  assert.equal(bp002.length, 1, 'case 2: the sibling hBP04-002 listing must not be swallowed');

  const sec = bp001.find((c) => c.rarity === 'SEC');
  const osr = bp001.find((c) => c.rarity === 'OSR');
  assert.ok(sec, 'case 2: SEC listing must be present');
  assert.ok(osr, 'case 2: OSR listing must be present');
  assert.equal(sec.sellPrice, 99800, 'case 2: SEC keeps its own price');
  assert.equal(osr.sellPrice, 580, 'case 2: OSR keeps its own price');
  assert.equal(sec.yuyuImage, 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10003.jpg', 'case 2: SEC yuyuImage must be its own /10003.jpg');
  assert.equal(osr.yuyuImage, 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10001.jpg', 'case 2: OSR yuyuImage must be its own /10001.jpg');
  assert.notEqual(sec.yuyuImage, osr.yuyuImage, 'case 2: same-cardNumber rarities must not share yuyuImage — that would fail canonicalYuyuImageIdentity ambiguity detection later');
  assert.equal(bp002[0].yuyuImage, 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/20001.jpg', 'case 2: sibling hBP04-002 must carry its own image');
}

// ── Case 3: fail-closed on missing / mismatched / off-host provenance ──
{
  const html = wrapPage([
    // (a) Baseline good block — must still parse alongside the bad ones so
    // the drops below are proven independent from a global parse failure.
    makeCardBlock({ cardNum: 'hBP04-001', rarity: 'SEC', imgSrc: 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10003.jpg', cartVer: 'hbp04', cartCid: '10003', price: '99,800' }),
    // (b) Off-host image, no cart_ver/cid — must be dropped.
    makeCardBlock({ cardNum: 'hBP04-100', rarity: 'C', imgSrc: 'https://evil.example.com/hocg/100_140/hbp04/10003.jpg', includeCartInputs: false, price: '100' }),
    // (c) Wrong path shape (no /hocg/), no cart_ver/cid — must be dropped.
    makeCardBlock({ cardNum: 'hBP04-101', rarity: 'C', imgSrc: 'https://card.yuyu-tei.jp/wrong-path/hbp04/1.jpg', includeCartInputs: false, price: '200' }),
    // (d) No product img at all AND no cart_ver/cid — must be dropped.
    makeCardBlock({ cardNum: 'hBP04-102', rarity: 'C', includeImg: false, includeCartInputs: false, price: '300' }),
    // (e) No product img, but cart_ver + cart_cid present — must be
    //     ADMITTED via the canonical /hocg/100_140/{ver}/{cid}.jpg
    //     fallback URL (yuyu-tei's real shape when the img tag is absent
    //     in a rendered variant).
    makeCardBlock({ cardNum: 'hBP04-103', rarity: 'C', includeImg: false, cartVer: 'hbp04', cartCid: '30001', price: '400' }),
    // (f) Non-http scheme (javascript:) with no cart_ver/cid — must be dropped.
    makeCardBlock({ cardNum: 'hBP04-104', rarity: 'C', imgSrc: 'javascript:alert(1)', includeCartInputs: false, price: '500' }),
  ]);

  const cards = parseCardHtml(html);
  const seen = new Set(cards.map((c) => c.cardNum));
  assert.ok(seen.has('hBP04-001'), 'case 3: the good baseline block must still parse');
  assert.ok(seen.has('hBP04-103'), 'case 3: the cart_ver+cart_cid-only block must be admitted via synthesised URL');
  for (const dropped of ['hBP04-100', 'hBP04-101', 'hBP04-102', 'hBP04-104']) {
    assert.ok(!seen.has(dropped), `case 3: block with unprovable provenance (${dropped}) must be DROPPED, not admitted with empty yuyuImage`);
  }
  // Every admitted row must carry a URL the exact-print matcher can bind.
  for (const c of cards) {
    assert.equal(yuyuImageProductPath(c.yuyuImage), 'hbp04', `case 3: every admitted row's yuyuImage must parse via yuyuImageProductPath (row ${c.cardNum})`);
  }
  // And the cart_ver+cart_cid fallback must produce the canonical URL.
  const bp103 = cards.find((c) => c.cardNum === 'hBP04-103');
  assert.equal(
    bp103.yuyuImage,
    'https://card.yuyu-tei.jp/hocg/100_140/hbp04/30001.jpg',
    'case 3: cart_ver+cart_cid fallback must synthesise the canonical yuyu-tei URL shape',
  );
}

// ── Case 4: end-to-end binding through build-database.js ──
// The parseCardHtml fix is worthless if the downstream binding logic still
// discards the listing. Feed a synthetic yuyu fixture whose entries have
// the exact shape parseCardHtml now emits (yuyuImage, imageVersion,
// imageCid, rarity, sourceSeries) and prove the fixture lands on the
// correct official printing row.
const dbPath = path.join(repo, 'data/database.json');
const publicDbPath = path.join(repo, 'public/data/database.json');
const scrapeLogPath = path.join(repo, 'data/scrape-log.txt');
const priceHistoryIndexPath = path.join(repo, 'data/price-history/index.json');
const originalDb = fs.readFileSync(dbPath, 'utf8');
const originalPublicDb = fs.readFileSync(publicDbPath, 'utf8');
const originalScrapeLog = fs.existsSync(scrapeLogPath) ? fs.readFileSync(scrapeLogPath, 'utf8') : null;
const originalPriceHistoryIndex = fs.existsSync(priceHistoryIndexPath) ? fs.readFileSync(priceHistoryIndexPath, 'utf8') : null;

const historyDir = path.join(repo, 'data/price-history');
const preRunBytes = new Map();
for (const f of fs.readdirSync(historyDir)) {
  const p = path.join(historyDir, f);
  if (fs.statSync(p).isFile()) preRunBytes.set(p, fs.readFileSync(p));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dic1349-fallback-'));
const fixturePath = path.join(tmp, 'yuyu-dic1349.json');

let passed = false;
try {
  const baseline = JSON.parse(originalDb);
  const cards = baseline.cards || {};

  // Pick an official printing whose sourceProduct we can drive an exact-
  // print listing for. Any hBP04 C printing works — the fixture below
  // synthesises a listing whose yuyuImage matches the row's sourceProduct.
  const targetKey = Object.keys(cards).find((k) => {
    const c = cards[k];
    return c && c.cardNumber && String(c.sourceProduct || c.series || '').toLowerCase() === 'hbp04';
  });
  assert.ok(targetKey, 'case 4: expected at least one hBP04 official printing in the shipped database');
  const target = cards[targetKey];

  // Build the fixture from parseCardHtml's OWN output shape (rarity,
  // yuyuImage, imageVersion, imageCid). This is what
  // scrapeAllWithFetch would produce on the fresh-root-install path.
  const parsed = parseCardHtml(wrapPage([
    makeCardBlock({
      cardNum: target.cardNumber,
      rarity: target.rarity || 'C',
      name: target.name || 'カード',
      price: '777',
      imgSrc: 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/dic1349.jpg',
      cartVer: 'hbp04',
      cartCid: 'dic1349',
    }),
  ]));
  assert.equal(parsed.length, 1, 'case 4: exactly one listing must parse');
  const listing = parsed[0];

  const fixture = {
    prices: {
      [listing.cardNum]: [
        {
          sellPrice: listing.sellPrice,
          rarity: listing.rarity,
          name: listing.name,
          yuyuImage: listing.yuyuImage,
          imageVersion: listing.imageVersion,
          imageCid: listing.imageCid,
          sourceSeries: 'hBP04',
          timestamp: new Date().toISOString(),
        },
      ],
    },
    totalCards: 100,
    seriesWithPrices: 1,
  };
  fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));

  const build = spawnSync(process.execPath, ['scripts/build-database.js'], {
    cwd: repo,
    env: {
      ...process.env,
      HUNTERCARD_YUYU_FIXTURE_PATH: fixturePath,
      HUNTERCARD_SKIP_IMAGE_DOWNLOADS: '1',
    },
    encoding: 'utf8',
  });
  assert.equal(
    build.status,
    0,
    `case 4: build-database.js fixture run must succeed on the parseCardHtml-shaped fixture\nSTDOUT:\n${build.stdout}\nSTDERR:\n${build.stderr}`,
  );

  const rebuilt = JSON.parse(fs.readFileSync(dbPath, 'utf8')).cards;
  const boundRow = rebuilt[targetKey];
  assert.ok(boundRow, `case 4: target row ${targetKey} must survive the build`);
  assert.equal(
    boundRow.sellPrice,
    777,
    `case 4: fallback-shaped listing must bind onto the target official printing (got sellPrice=${boundRow.sellPrice})`,
  );
  assert.equal(
    yuyuImageProductPath(boundRow.yuyuImage),
    'hbp04',
    `case 4: bound yuyuImage must retain its hBP04 product path (got ${boundRow.yuyuImage})`,
  );
  passed = true;
} finally {
  fs.writeFileSync(dbPath, originalDb);
  fs.writeFileSync(publicDbPath, originalPublicDb);
  if (originalScrapeLog === null) {
    fs.rmSync(scrapeLogPath, { force: true });
  } else {
    fs.writeFileSync(scrapeLogPath, originalScrapeLog);
  }
  if (originalPriceHistoryIndex === null) {
    fs.rmSync(priceHistoryIndexPath, { force: true });
  } else {
    fs.writeFileSync(priceHistoryIndexPath, originalPriceHistoryIndex);
  }
  // Restore every pre-existing price-history file byte-for-byte, and delete
  // any file the build produced fresh. Matches the pattern used by
  // scripts/test-dic1334-final-artifact-collapse.mjs.
  const postFiles = new Set(fs.readdirSync(historyDir).map((f) => path.join(historyDir, f)));
  for (const [p, bytes] of preRunBytes) fs.writeFileSync(p, bytes);
  for (const p of postFiles) {
    if (!preRunBytes.has(p) && fs.statSync(p).isFile()) fs.rmSync(p, { force: true });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

assert.ok(passed, 'case 4: end-to-end binding must complete without an early throw');

console.log('✓ DIC-1349 HTTP fallback exact-printing provenance regression passed');
