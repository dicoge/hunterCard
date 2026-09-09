#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const dbPath = path.join(repo, 'data/database.json');
const publicDbPath = path.join(repo, 'public/data/database.json');
const scrapeLogPath = path.join(repo, 'data/scrape-log.txt');
const priceHistoryIndexPath = path.join(repo, 'data/price-history/index.json');
const fixtureHistoryPath = path.join(repo, 'data/price-history/hBP01-021_hEB01_C_hBP01-021_C_02.json');
const uFixtureHistoryPath = path.join(repo, 'data/price-history/hBP01-026_hEB01_U_hBP01-026_U_02.json');
const originalDb = fs.readFileSync(dbPath, 'utf8');
const originalPublicDb = fs.readFileSync(publicDbPath, 'utf8');
const originalScrapeLog = fs.existsSync(scrapeLogPath) ? fs.readFileSync(scrapeLogPath, 'utf8') : null;
const originalPriceHistoryIndex = fs.existsSync(priceHistoryIndexPath) ? fs.readFileSync(priceHistoryIndexPath, 'utf8') : null;
const originalFixtureHistory = fs.existsSync(fixtureHistoryPath) ? fs.readFileSync(fixtureHistoryPath, 'utf8') : null;
const originalUFixtureHistory = fs.existsSync(uFixtureHistoryPath) ? fs.readFileSync(uFixtureHistoryPath, 'utf8') : null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dic1176-yuyu-'));
const fixture = path.join(tmp, 'yuyu-fixture.json');

try {
  const baseline = JSON.parse(originalDb);
  const cards = baseline.cards || {};
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
    cwd: repo,
    encoding: 'utf8',
  });
  assert.equal(syncResult.status, 0, `official-sync fixture pre-step failed\nSTDOUT:\n${syncResult.stdout}\nSTDERR:\n${syncResult.stderr}`);

  const afterSync = JSON.parse(fs.readFileSync(dbPath, 'utf8')).cards;
  assert.equal(afterSync[cId].sellPrice, null, 'official-sync pre-step keeps unproven hEB01 C unknown before yuyu proof');
  assert.deepEqual(afterSync[hrId].prices, [], 'official-sync pre-step keeps unproven hEB01 HR prices empty');

  const result = spawnSync(process.execPath, ['scripts/build-database.js'], {
    cwd: repo,
    env: {
      ...process.env,
      HUNTERCARD_YUYU_FIXTURE_PATH: fixture,
      // keep the fixture small and deterministic; image download failures are non-fatal.
      HUNTERCARD_SKIP_IMAGE_DOWNLOADS: '1',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `build-database fixture run failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);

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
  fs.writeFileSync(dbPath, originalDb);
  fs.writeFileSync(publicDbPath, originalPublicDb);
  if (originalScrapeLog === null) fs.rmSync(scrapeLogPath, { force: true });
  else fs.writeFileSync(scrapeLogPath, originalScrapeLog);
  if (originalPriceHistoryIndex === null) fs.rmSync(priceHistoryIndexPath, { force: true });
  else fs.writeFileSync(priceHistoryIndexPath, originalPriceHistoryIndex);
  if (originalFixtureHistory === null) fs.rmSync(fixtureHistoryPath, { force: true });
  else fs.writeFileSync(fixtureHistoryPath, originalFixtureHistory);
  if (originalUFixtureHistory === null) fs.rmSync(uFixtureHistoryPath, { force: true });
  else fs.writeFileSync(uFixtureHistoryPath, originalUFixtureHistory);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('✓ yuyu exact-printing sell match regression passed');
