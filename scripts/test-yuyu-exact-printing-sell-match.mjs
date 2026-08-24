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
const originalDb = fs.readFileSync(dbPath, 'utf8');
const originalPublicDb = fs.readFileSync(publicDbPath, 'utf8');
const originalScrapeLog = fs.existsSync(scrapeLogPath) ? fs.readFileSync(scrapeLogPath, 'utf8') : null;
const originalPriceHistoryIndex = fs.existsSync(priceHistoryIndexPath) ? fs.readFileSync(priceHistoryIndexPath, 'utf8') : null;
const originalFixtureHistory = fs.existsSync(fixtureHistoryPath) ? fs.readFileSync(fixtureHistoryPath, 'utf8') : null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dic1176-yuyu-'));
const fixture = path.join(tmp, 'yuyu-fixture.json');

try {
  const baseline = JSON.parse(originalDb);
  const cards = baseline.cards || {};
  const cId = 'hBP01-021_hEB01_C_hBP01-021_C_02';
  const hrId = 'hBP01-021_hEB01_HR_hBP01-021_HR';
  assert.ok(cards[cId], `${cId} fixture row must exist`);
  assert.ok(cards[hrId], `${hrId} fixture row must exist`);
  assert.equal(cards[cId].cardNumber, 'hBP01-021');
  assert.equal(cards[hrId].cardNumber, 'hBP01-021');
  assert.equal(cards[cId].sourceProduct, 'hEB01');
  assert.equal(cards[hrId].sourceProduct, 'hEB01');
  assert.equal(cards[cId].rarity, 'C');
  assert.equal(cards[hrId].rarity, 'HR');

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
    },
    totalCards: 120,
    seriesWithPrices: 1,
  }, null, 2));

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
  assert.equal(c.sellPrice, 123, 'exact hEB01 C listing should populate the C official printing');
  assert.equal(c.yuyuName, 'ときのそら(hEB01)', 'C printing should carry the exact yuyu row name');
  assert.equal(c.prices.length, 1, 'C printing should carry the exact listing only');
  assert.equal(c.prices[0].sellPrice, 123);
  assert.equal(c.prices[0].name, 'ときのそら(hEB01)');

  assert.equal(hr.sellPrice, null, 'HR printing must not inherit the C listing by card number');
  assert.equal(hr.yuyuName, '', 'HR printing must remain unnamed by yuyu when no exact listing exists');
  assert.deepEqual(hr.prices, [], 'HR printing must keep empty prices[] when no exact listing exists');

  const offenders = Object.entries(rebuilt)
    .filter(([id, card]) => id !== cId && card.cardNumber === 'hBP01-021' && card.sellPrice === 123)
    .map(([id]) => id);
  assert.deepEqual(offenders, [], 'synthetic C listing must not populate any other same-number printing');
} finally {
  fs.writeFileSync(dbPath, originalDb);
  fs.writeFileSync(publicDbPath, originalPublicDb);
  if (originalScrapeLog === null) fs.rmSync(scrapeLogPath, { force: true });
  else fs.writeFileSync(scrapeLogPath, originalScrapeLog);
  if (originalPriceHistoryIndex === null) fs.rmSync(priceHistoryIndexPath, { force: true });
  else fs.writeFileSync(priceHistoryIndexPath, originalPriceHistoryIndex);
  if (originalFixtureHistory === null) fs.rmSync(fixtureHistoryPath, { force: true });
  else fs.writeFileSync(fixtureHistoryPath, originalFixtureHistory);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('✓ yuyu exact-printing sell match regression passed');
