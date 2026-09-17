#!/usr/bin/env node
/**
 * test-dic1461-exact-matcher.mjs — DIC-1461 exact-printing acceptance /
 * fail-closed fixtures over the REAL build-database.js pipeline.
 *
 * Context: the 2026-09-17 live collapse (1216 scraped → 424 final priced
 * cardNumbers) was caused by yuyu-tei's markup redesign removing the inline
 * rarity token — every listing parsed with rarity '' and only
 * single-candidate printings could prove. The fix restores per-listing
 * rarity from the listing's own product-image alt (see
 * test-dic1461-yuyu-parser-rarity.mjs). The MATCHER is intentionally
 * unchanged; these fixtures pin its exact-printing contract around the
 * restored input shape:
 *
 *   1. Unique product + exact printing proof ACCEPTED: with per-listing
 *      rarity tokens restored, each listing prices exactly its own
 *      compound printing (OSR listing → OSR row, OUR listing → OUR row).
 *   2. Same-cardNumber multi-printing ambiguity REJECTED: an empty-rarity
 *      listing over multiple same-product candidates attaches to nothing.
 *   3. Cross-product / reprint ambiguity REJECTED: a listing whose image
 *      URL proves a product with no official printing of that cardNumber
 *      attaches to nothing.
 *   4. Missing / invalid source metadata REJECTED: no sourceSeries, or an
 *      unverifiable image URL, attaches to nothing.
 *   5. Production-sequence gate: the real multi-listing live shape WITH
 *      restored rarity tokens keeps priced coverage ≥ the DIC-1334 floor
 *      (build succeeds), while the SAME shape with rarity stripped — the
 *      exact 2026-09-17 red state — still fail-closes at the intact
 *      DIC-1334 coverage gate. The gate itself is untouched.
 *
 * Run: node scripts/test-dic1461-exact-matcher.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..');
const dbPath = path.join(repo, 'data/database.json');
const publicDbPath = path.join(repo, 'public/data/database.json');
const originalDb = fs.readFileSync(dbPath, 'utf8');
const originalPublicDb = fs.readFileSync(publicDbPath, 'utf8');

const historyDir = path.join(repo, 'data/price-history');
const scrapeLogPath = path.join(repo, 'data/scrape-log.txt');
const preRunBytes = new Map();
for (const f of fs.readdirSync(historyDir)) {
  const p = path.join(historyDir, f);
  if (fs.statSync(p).isFile()) preRunBytes.set(p, fs.readFileSync(p));
}
if (fs.existsSync(scrapeLogPath)) preRunBytes.set(scrapeLogPath, fs.readFileSync(scrapeLogPath));

const IMG = (product, cid) => `https://card.yuyu-tei.jp/hocg/100_140/${product}/${cid}.jpg`;
const NOW = new Date().toISOString();
const listing = (over) => ({
  sellPrice: 100, rarity: '', name: '', yuyuImage: '', imageVersion: '', imageCid: '',
  sourceSeries: '', timestamp: NOW, ...over,
});

function runBuild(fixture, tmp, tag) {
  const p = path.join(tmp, `yuyu-${tag}.json`);
  fs.writeFileSync(p, JSON.stringify(fixture));
  return spawnSync(process.execPath, ['scripts/build-database.js'], {
    cwd: repo,
    env: { ...process.env, HUNTERCARD_YUYU_FIXTURE_PATH: p, HUNTERCARD_SKIP_IMAGE_DOWNLOADS: '1' },
    encoding: 'utf8',
  });
}
const cardsOf = () => JSON.parse(fs.readFileSync(dbPath, 'utf8')).cards;
const pricedCardNumbers = () => {
  const s = new Set();
  for (const c of Object.values(cardsOf())) {
    if (Number.isFinite(c.sellPrice) && c.sellPrice > 0) s.add(c.cardNumber);
  }
  return s;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dic1461-matcher-'));
let passed = false;
try {
  // Baseline sanity for the printings the fixtures target (committed catalog):
  // hBP01-001 → hBP01/OSR + hBP01/OUR; hBP01-006 → hBP01/OSR + OUR + SEC.
  const baseline = JSON.parse(originalDb).cards;
  const rowsFor = (num) => Object.entries(baseline).filter(([, c]) => c.cardNumber === num && c.sourceProduct === 'hBP01');
  assert.ok(rowsFor('hBP01-001').length >= 2, 'fixture premise: hBP01-001 has multiple hBP01 printings');
  assert.ok(rowsFor('hBP01-006').length >= 3, 'fixture premise: hBP01-006 has ≥3 hBP01 printings');

  // ── 1 + 2 + 3 + 4 in one deterministic build ──
  const fixture = {
    prices: {
      // 1. Exact proof per printing: the shape the FIXED parser now emits
      // (rarity restored from each listing's own image alt).
      'hBP01-001': [
        listing({ sellPrice: 780, rarity: 'OSR', name: '天音かなた', yuyuImage: IMG('hbp01', '10001'), imageVersion: 'hbp01', imageCid: '10001', sourceSeries: 'hBP01' }),
        listing({ sellPrice: 24800, rarity: 'OUR', name: '天音かなた(パラレル)', yuyuImage: IMG('hbp01', '10002'), imageVersion: 'hbp01', imageCid: '10002', sourceSeries: 'hBP01' }),
      ],
      // 2. Same-cardNumber multi-printing ambiguity (the 2026-09-17 red
      // shape): empty rarity over OSR/OUR/SEC candidates must attach to
      // NOTHING — no lowest/highest, no sibling, no guess.
      'hBP01-006': [
        listing({ sellPrice: 280, rarity: '', name: '小鳥遊キアラ', yuyuImage: IMG('hbp01', '10011'), imageVersion: 'hbp01', imageCid: '10011', sourceSeries: 'hBP01' }),
        listing({ sellPrice: 6980, rarity: '', name: '小鳥遊キアラ(パラレル)', yuyuImage: IMG('hbp01', '10012'), imageVersion: 'hbp01', imageCid: '10012', sourceSeries: 'hBP01' }),
        listing({ sellPrice: 24800, rarity: '', name: '小鳥遊キアラ(パラレル/サイン)', yuyuImage: IMG('hbp01', '10013'), imageVersion: 'hbp01', imageCid: '10013', sourceSeries: 'hBP01' }),
      ],
      // 3. Cross-product / reprint ambiguity: image URL proves hBP07, but
      // hBP01-002 has no official hBP07 printing — reject.
      'hBP01-002': [
        listing({ sellPrice: 1, rarity: '', name: 'アキ・ローゼンタール', yuyuImage: IMG('hbp07', '70001'), imageVersion: 'hbp07', imageCid: '70001', sourceSeries: 'hBP07' }),
      ],
      // 4a. Missing source metadata: no sourceSeries at all — reject.
      'hBP01-009': [
        listing({ sellPrice: 500, rarity: 'RR', name: 'AZKi', yuyuImage: IMG('hbp01', '10020'), imageVersion: 'hbp01', imageCid: '10020', sourceSeries: '' }),
      ],
      // 4b. Invalid image evidence: lookalike host + placeholder — reject.
      'hBP01-010': [
        listing({ sellPrice: 500, rarity: '', name: 'ロボ子さん', yuyuImage: 'https://evil-yuyu-tei.jp/hocg/100_140/hbp01/10022.jpg', sourceSeries: 'hBP01' }),
        listing({ sellPrice: 500, rarity: '', name: 'ロボ子さん', yuyuImage: 'https://card.yuyu-tei.jp/noimage_100_140.jpg', sourceSeries: 'hBP01' }),
      ],
    },
    totalCards: 100,
    seriesWithPrices: 1,
    pricingUnavailable: false,
  };
  const build = runBuild(fixture, tmp, 'contract');
  assert.equal(build.status, 0, `fixture build must complete\n${build.stdout}\n${build.stderr}`);
  const cards = cardsOf();

  // 1. accepted: each listing priced exactly its own compound printing.
  const osr = Object.values(cards).find((c) => c.cardNumber === 'hBP01-001' && c.rarity === 'OSR' && c.sourceProduct === 'hBP01');
  const our = Object.values(cards).find((c) => c.cardNumber === 'hBP01-001' && c.rarity === 'OUR' && c.sourceProduct === 'hBP01');
  assert.ok(osr && our, 'hBP01-001 OSR/OUR compound rows must exist');
  assert.equal(osr.sellPrice, 780, 'OSR listing must price the OSR printing only');
  assert.equal(our.sellPrice, 24800, 'OUR listing must price the OUR printing only');
  console.log('  ✓ unique product + exact printing proof accepted (OSR→OSR ¥780, OUR→OUR ¥24800, no cross-fill)');

  // 2. rejected: multi-printing ambiguity keeps every sibling null.
  for (const c of Object.values(cards).filter((c) => c.cardNumber === 'hBP01-006')) {
    assert.equal(c.sellPrice, null, `ambiguous empty-rarity listings must never price ${c.id}`);
  }
  assert.equal(cards['hBP01-006'], undefined, 'no bare identity-less hBP01-006 row may be emitted');
  console.log('  ✓ same-cardNumber multi-printing (OSR/OUR/SEC) ambiguity rejected — all siblings stay null');

  // 3. rejected: cross-product evidence attaches nowhere.
  for (const c of Object.values(cards).filter((c) => c.cardNumber === 'hBP01-002')) {
    assert.notEqual(c.sellPrice, 1, `cross-product listing must never price ${c.id}`);
  }
  console.log('  ✓ cross-product/reprint listing rejected (¥1 hBP07 evidence never lands on hBP01-002)');

  // 4. rejected: missing/invalid metadata attaches nowhere.
  for (const c of Object.values(cards).filter((c) => ['hBP01-009', 'hBP01-010'].includes(c.cardNumber))) {
    assert.notEqual(c.sellPrice, 500, `missing/invalid-metadata listing must never price ${c.id}`);
  }
  console.log('  ✓ missing sourceSeries / invalid image evidence rejected');

  // ── 5. Production-sequence gate over the real live shape ──
  // Emulate the fixed parser's live output at scale: for every cardNumber
  // the committed artifact prices, emit ONE listing PER official printing of
  // its origin product, each with that printing's own rarity token (that is
  // what the alt now provides). Coverage must stay ≥ the DIC-1334 floor and
  // the build must ship.
  const byNumber = new Map();
  for (const c of Object.values(baseline)) {
    if (!(Number.isFinite(c.sellPrice) && c.sellPrice > 0)) continue;
    if (!byNumber.has(c.cardNumber)) byNumber.set(c.cardNumber, true);
  }
  const rowsByNumber = new Map();
  for (const c of Object.values(baseline)) {
    if (!byNumber.has(c.cardNumber)) continue;
    if (!rowsByNumber.has(c.cardNumber)) rowsByNumber.set(c.cardNumber, []);
    rowsByNumber.get(c.cardNumber).push(c);
  }
  const liveShape = { prices: {}, totalCards: 0, seriesWithPrices: 1, pricingUnavailable: false };
  for (const [num, rows] of rowsByNumber) {
    const prefix = String(num).match(/^([A-Za-z]+[0-9A-Za-z]*)-\d+/);
    const originRows = rows.filter((r) => prefix && String(r.sourceProduct || r.series || '').toLowerCase() === prefix[1].toLowerCase());
    const emit = (originRows.length ? originRows : rows.slice(0, 1));
    const product = String((emit[0].sourceProduct || emit[0].series || '')).toLowerCase();
    liveShape.prices[num] = emit.map((r, i) => listing({
      sellPrice: 100 + i,
      rarity: r.rarity || '',
      name: r.name || num,
      yuyuImage: IMG(product, `dic1461-${i}`),
      imageVersion: product,
      imageCid: `dic1461-${i}`,
      sourceSeries: product,
    }));
    liveShape.totalCards += emit.length;
  }
  const scraped = Object.keys(liveShape.prices).length;
  assert.ok(scraped > 500, `live-shape fixture must be meaningful; got ${scraped}`);

  const greenBuild = runBuild(liveShape, tmp, 'live-shape-green');
  assert.equal(greenBuild.status, 0, `live shape with restored rarity tokens must ship\n${greenBuild.stdout.slice(-2000)}\n${greenBuild.stderr.slice(-2000)}`);
  const greenPriced = pricedCardNumbers();
  assert.ok(
    greenPriced.size >= Math.floor(scraped / 2),
    `restored-rarity live shape collapsed: ${greenPriced.size}/${scraped} priced cardNumbers`,
  );
  console.log(`  ✓ live multi-listing shape with restored rarity keeps coverage (${greenPriced.size}/${scraped} ≥ floor ${Math.floor(scraped / 2)})`);

  // Same shape, rarity stripped — the exact 2026-09-17 red state. The
  // DIC-1334 gate must remain intact and fail the build.
  const redShape = { ...liveShape, prices: {} };
  for (const [num, entries] of Object.entries(liveShape.prices)) {
    redShape.prices[num] = entries.map((e) => ({ ...e, rarity: '' }));
  }
  const redBuild = runBuild(redShape, tmp, 'live-shape-red');
  assert.notEqual(redBuild.status, 0, 'the rarity-less 2026-09-17 shape must still fail closed at the DIC-1334 gate');
  assert.match(
    `${redBuild.stdout}\n${redBuild.stderr}`,
    /\[DIC-1334\] final canonical artifact collapsed priced-cardNumber coverage/,
    'the DIC-1334 coverage gate must remain intact and fire on the collapse shape',
  );
  console.log('  ✓ DIC-1334 gate intact: rarity-less live shape still refuses to ship (1216→424 class collapse blocked)');

  console.log('✓ DIC-1461 exact-matcher contract passed');
  passed = true;
} finally {
  fs.writeFileSync(dbPath, originalDb);
  fs.writeFileSync(publicDbPath, originalPublicDb);
  for (const f of fs.readdirSync(historyDir)) {
    const p = path.join(historyDir, f);
    if (!preRunBytes.has(p)) fs.rmSync(p, { recursive: true, force: true });
  }
  for (const [p, bytes] of preRunBytes) fs.writeFileSync(p, bytes);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (passed) {
    const dirty = [];
    if (fs.readFileSync(dbPath, 'utf8') !== originalDb) dirty.push(dbPath);
    if (fs.readFileSync(publicDbPath, 'utf8') !== originalPublicDb) dirty.push(publicDbPath);
    for (const f of fs.readdirSync(historyDir)) {
      const p = path.join(historyDir, f);
      if (!preRunBytes.has(p)) dirty.push(`${p} (new)`);
    }
    for (const [p, bytes] of preRunBytes) {
      if (!fs.existsSync(p) || !fs.readFileSync(p).equals(bytes)) dirty.push(p);
    }
    assert.deepEqual(dirty, [], `test must be worktree-hermetic; still differing: ${dirty.join(', ')}`);
    console.log('  ✓ worktree-hermetic: every touched tracked file restored byte-for-byte');
  }
}
