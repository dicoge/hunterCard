#!/usr/bin/env node
// Hermetic: the sync and build steps run inside a disposable workspace, never
// against the repo's own data. The workspace gets a copy of scripts/ and the
// data inputs they read, the repo's existing node_modules (symlinked, nothing
// installed), and a controlled baseline. Every printing of the fixture
// cardNumbers is reset to the unpriced shape, and price-history starts empty,
// so neither the committed live prices nor durable history can restore a price
// the synthetic listings below did not prove. data/images holds placeholder
// files for exactly the fixture cardNumbers, so the builder's image step skips
// them instead of making a network request. The repo's data files are hashed
// before and after and must be byte-identical.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dic1176-yuyu-'));
const fixture = path.join(tmp, 'yuyu-fixture.json');
const work = path.join(tmp, 'work');
const dbPath = path.join(work, 'data/database.json');

const FIXTURE_CARD_NUMBERS = ['hBP01-021', 'hBP01-026', 'hEB01-031', 'hEB01-032'];
// Not read by the sync/build steps; large, so not copied.
const SKIPPED_DATA_DIRS = new Set(['images', 'price-history', 'price-history-quarantined-DIC-1219', 'trends', 'news-sentiment']);

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Everything the old in-place version of this test wrote to, plus the whole
// durable price-history and image directories.
function sourceSnapshot() {
  const snap = {};
  for (const rel of ['data/database.json', 'public/data/database.json', 'data/scrape-log.txt', 'data/price-rejections.json']) {
    const file = path.join(repo, rel);
    snap[rel] = fs.existsSync(file) ? sha256(file) : null;
  }
  for (const rel of ['data/price-history', 'data/images']) {
    const dir = path.join(repo, rel);
    const h = crypto.createHash('sha256');
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir).sort()) h.update(`${name}\0${sha256(path.join(dir, name))}\0`);
    }
    snap[rel] = h.digest('hex');
  }
  return snap;
}

function buildWorkspace() {
  fs.mkdirSync(work);
  fs.cpSync(path.join(repo, 'scripts'), path.join(work, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'package.json'), path.join(work, 'package.json'));
  fs.mkdirSync(path.join(work, 'data'));
  for (const entry of fs.readdirSync(path.join(repo, 'data'))) {
    if (SKIPPED_DATA_DIRS.has(entry)) continue;
    fs.cpSync(path.join(repo, 'data', entry), path.join(work, 'data', entry), { recursive: true });
  }
  fs.mkdirSync(path.join(work, 'data/price-history'));
  fs.mkdirSync(path.join(work, 'data/images'));
  for (const cardNumber of FIXTURE_CARD_NUMBERS) {
    fs.writeFileSync(path.join(work, 'data/images', `${cardNumber}.jpg`), 'dic1176 placeholder\n');
  }
  fs.mkdirSync(path.join(work, 'public/data'), { recursive: true });
  const modules = path.join(repo, 'node_modules');
  if (fs.existsSync(modules)) fs.symlinkSync(fs.realpathSync(modules), path.join(work, 'node_modules'), 'dir');
}

// Unpriced shape, as on a printing yuyu has never proven (e.g. hBP01-021_hPR_P).
function seedUnproven(card) {
  card.sellPrice = null;
  card.prices = [];
  card._rawPricesArchive = [];
  card.timestamp = '';
  card.yuyuName = '';
  card.yuyuImage = '';
  delete card.priceHistory;
  delete card.buyPrice;
  delete card.buyPriceHistory;
}

const sourceBefore = sourceSnapshot();

try {
  buildWorkspace();
  const baseline = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const cards = baseline.cards || {};
  for (const card of Object.values(cards)) {
    if (FIXTURE_CARD_NUMBERS.includes(card.cardNumber)) seedUnproven(card);
  }
  fs.writeFileSync(dbPath, `${JSON.stringify(baseline, null, 2)}\n`);
  const cId = 'hBP01-021_hEB01_C_hBP01-021_C_02';
  const hrId = 'hBP01-021_hEB01_HR_hBP01-021_HR';
  const uId = 'hBP01-026_hEB01_U_hBP01-026_U_02';
  const srId = 'hBP01-026_hEB01_SR_hBP01-026_SR_02';
  const emptyRarityUniqueId = 'hEB01-031_hEB01_C_hEB01-031_C';
  const emptyRarityWrongUrlId = 'hEB01-032_hEB01_U_hEB01-032_U';
  assert.ok(cards[cId], `${cId} fixture row must exist`);
  assert.ok(cards[hrId], `${hrId} fixture row must exist`);
  assert.ok(cards[uId], `${uId} fixture row must exist`);
  assert.ok(cards[srId], `${srId} fixture row must exist`);
  assert.ok(cards[emptyRarityUniqueId], `${emptyRarityUniqueId} fixture row must exist`);
  assert.ok(cards[emptyRarityWrongUrlId], `${emptyRarityWrongUrlId} fixture row must exist`);
  assert.equal(cards[cId].cardNumber, 'hBP01-021');
  assert.equal(cards[hrId].cardNumber, 'hBP01-021');
  assert.equal(cards[uId].cardNumber, 'hBP01-026');
  assert.equal(cards[srId].cardNumber, 'hBP01-026');
  assert.equal(cards[emptyRarityUniqueId].cardNumber, 'hEB01-031');
  assert.equal(cards[emptyRarityWrongUrlId].cardNumber, 'hEB01-032');
  assert.equal(cards[cId].sourceProduct, 'hEB01');
  assert.equal(cards[hrId].sourceProduct, 'hEB01');
  assert.equal(cards[uId].sourceProduct, 'hEB01');
  assert.equal(cards[srId].sourceProduct, 'hEB01');
  assert.equal(cards[emptyRarityUniqueId].sourceProduct, 'hEB01');
  assert.equal(cards[emptyRarityWrongUrlId].sourceProduct, 'hEB01');
  assert.equal(cards[cId].rarity, 'C');
  assert.equal(cards[hrId].rarity, 'HR');
  assert.equal(cards[uId].rarity, 'U');
  assert.equal(cards[srId].rarity, 'SR');
  assert.equal(cards[emptyRarityUniqueId].rarity, 'C');
  assert.equal(cards[emptyRarityWrongUrlId].rarity, 'U');

  fs.writeFileSync(fixture, JSON.stringify({
    prices: {
      'hBP01-021': [
        {
          sellPrice: 123,
          rarity: 'C',
          name: 'ときのそら(hEB01)',
          yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/heb01/dic1176-c.jpg',
          imageVersion: 'heb01',
          imageCid: 'dic1176-c',
          sourceSeries: 'hEB01',
          timestamp: '2026-08-24T12:00:00.000Z',
        },
      ],
      'hBP01-026': [
        {
          sellPrice: 124,
          rarity: 'U',
          name: 'ベスティア・ゼータ(hEB01)',
          yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/heb01/dic1176-u.jpg',
          imageVersion: 'heb01',
          imageCid: 'dic1176-u',
          sourceSeries: 'hEB01',
          timestamp: '2026-08-24T12:00:00.000Z',
        },
      ],
      'hEB01-031': [
        {
          sellPrice: 125,
          rarity: '',
          name: '白エール(hEB01)',
          yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/heb01/dic1176-empty-rarity.jpg',
          imageVersion: 'heb01',
          imageCid: 'dic1176-empty-rarity',
          sourceSeries: 'hEB01',
          timestamp: '2026-08-24T12:00:00.000Z',
        },
      ],
      'hEB01-032': [
        {
          sellPrice: 126,
          rarity: '',
          name: '黒エール(hEB01)',
          yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/hbp01/dic1176-wrong-product.jpg',
          imageVersion: 'hbp01',
          imageCid: 'dic1176-wrong-product',
          sourceSeries: 'hEB01',
          timestamp: '2026-08-24T12:00:00.000Z',
        },
      ],
    },
    totalCards: 120,
    seriesWithPrices: 1,
  }, null, 2));

  const syncResult = spawnSync(process.execPath, ['scripts/sync-official-catalog-to-database.mjs'], {
    cwd: work,
    encoding: 'utf8',
  });
  assert.equal(syncResult.status, 0, `official-sync fixture pre-step failed\nSTDOUT:\n${syncResult.stdout}\nSTDERR:\n${syncResult.stderr}`);

  const afterSync = JSON.parse(fs.readFileSync(dbPath, 'utf8')).cards;
  assert.equal(afterSync[cId].sellPrice, null, 'official-sync pre-step keeps unproven hEB01 C unknown before yuyu proof');
  assert.deepEqual(afterSync[hrId].prices, [], 'official-sync pre-step keeps unproven hEB01 HR prices empty');

  const result = spawnSync(process.execPath, ['scripts/build-database.js'], {
    cwd: work,
    env: {
      ...process.env,
      HUNTERCARD_YUYU_FIXTURE_PATH: fixture,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `build-database fixture run failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  assert.match(result.stdout, /\[images\] Downloaded: 0, Skipped: 4, Errors: 0/, 'image step must skip every fixture cardNumber without a request');

  const rebuilt = JSON.parse(fs.readFileSync(dbPath, 'utf8')).cards;
  const c = rebuilt[cId];
  const hr = rebuilt[hrId];
  const u = rebuilt[uId];
  const sr = rebuilt[srId];
  const emptyRarityUnique = rebuilt[emptyRarityUniqueId];
  const emptyRarityWrongUrl = rebuilt[emptyRarityWrongUrlId];
  assert.equal(c.sellPrice, 123, 'exact hEB01 C listing should populate the C official printing');
  assert.equal(c.yuyuName, 'ときのそら(hEB01)', 'C printing should carry the exact yuyu row name');
  assert.equal(c.prices.length, 1, 'C printing should carry the exact listing only');
  assert.equal(c.prices[0].sellPrice, 123);
  assert.equal(c.prices[0].name, 'ときのそら(hEB01)');

  assert.equal(u.sellPrice, 124, 'exact hEB01 U listing should populate the U official printing');
  assert.equal(u.yuyuName, 'ベスティア・ゼータ(hEB01)', 'U printing should carry the exact yuyu row name');
  assert.equal(u.prices.length, 1, 'U printing should carry the exact listing only');
  assert.equal(u.prices[0].sellPrice, 124);
  assert.equal(u.prices[0].name, 'ベスティア・ゼータ(hEB01)');

  assert.equal(hr.sellPrice, null, 'HR printing must not inherit the C listing by card number');
  assert.equal(hr.yuyuName, '', 'HR printing must remain unnamed by yuyu when no exact listing exists');
  assert.deepEqual(hr.prices, [], 'HR printing must keep empty prices[] when no exact listing exists');

  assert.equal(sr.sellPrice, null, 'SR printing must not inherit the U listing by card number');
  assert.equal(sr.yuyuName, '', 'SR printing must remain unnamed by yuyu when no exact listing exists');
  assert.deepEqual(sr.prices, [], 'SR printing must keep empty prices[] when no exact listing exists');

  assert.equal(emptyRarityUnique.sellPrice, 125, 'unique hEB01 printing should accept empty-rarity yuyu rows with exact URL provenance');
  assert.equal(emptyRarityUnique.yuyuName, '白エール(hEB01)');
  assert.equal(emptyRarityUnique.prices.length, 1);
  assert.equal(emptyRarityWrongUrl.sellPrice, null, 'empty-rarity yuyu rows with a cross-product image URL must fail closed');
  assert.deepEqual(emptyRarityWrongUrl.prices, []);

  const offenders = Object.entries(rebuilt)
    .filter(([id, card]) =>
      (id !== cId && card.cardNumber === 'hBP01-021' && card.sellPrice === 123) ||
      (id !== uId && card.cardNumber === 'hBP01-026' && card.sellPrice === 124))
    .map(([id]) => id);
  assert.deepEqual(offenders, [], 'synthetic base-rarity listings must not populate any other same-number printing');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.deepEqual(sourceSnapshot(), sourceBefore, 'repo data, public DB, price-history and images must be byte-identical after the run');
}

console.log('✓ yuyu exact-printing sell match regression passed');
