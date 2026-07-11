import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scrapeFullaheadBuy, scrapeOnce } from './scrape-fullahead-buy.js';

function makeTmpProject(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, 'database.json');
  const outputFile = path.join(dir, 'buy-prices', 'fullahead-prices.json');
  fs.writeFileSync(
    dbPath,
    JSON.stringify({ cards: { one: { cardNumber: 'hBP01-001' }, two: { cardNumber: 'hBP01-002' } } }),
    'utf-8',
  );
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  return { dir, dbPath, outputFile };
}

async function testScrapeOnceThrowsOnNon2xxPage() {
  const requests = [];
  const page = {
    on(event, handler) {
      assert.equal(event, 'request');
      requests.push(handler);
    },
    async goto() {
      for (const handler of requests) {
        handler({ url: () => 'https://fullahead-buy.com/fetchRecords.php?app=38&apiToken=test-token' });
      }
    },
    async evaluate(fn, base, token) {
      return fn.call(
        null,
        base,
        token,
      );
    },
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503, statusText: 'Service Unavailable' });
  try {
    await assert.rejects(
      () => scrapeOnce(page),
      /Fullahead page 0 failed: 503 Service Unavailable/,
      'pagination HTTP failures must throw instead of returning partial data',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testFailedScrapeKeepsPreviousFile() {
  const { dbPath, outputFile } = makeTmpProject('fullahead-fail-keeps-old-');
  const oldData = {
    'hBP01-001': { buyPrice: 100, timestamp: 'old' },
  };
  fs.writeFileSync(outputFile, `${JSON.stringify(oldData, null, 2)}\n`, 'utf-8');

  await assert.rejects(
    () => scrapeFullaheadBuy({
      dbPath,
      outputFile,
      scrapeWithRestartFn: async () => {
        throw new Error('Fullahead page 2 failed: 500 Internal Server Error');
      },
    }),
    /Fullahead page 2 failed/,
  );

  assert.deepEqual(
    JSON.parse(fs.readFileSync(outputFile, 'utf-8')),
    oldData,
    'failed scrape should preserve the old output file',
  );
}

async function testSuccessfulScrapeWritesPrices() {
  const { dbPath, outputFile } = makeTmpProject('fullahead-success-');

  const result = await scrapeFullaheadBuy({
    dbPath,
    outputFile,
    nowFn: () => new Date('2026-01-02T03:04:05.000Z'),
    scrapeWithRestartFn: async () => [
      { productName: '【UR】hBP01-001 ムーナ・ホシノヴァ', price: '500' },
      { productName: '【C】hBP01-001 duplicate lower', price: '300' },
      { productName: '【R】hBP01-002 other card', price: '1,200' },
      { productName: 'not in database hBP01-999', price: '9999' },
    ],
  });

  const expected = {
    'hBP01-001': { buyPrice: 500, timestamp: '2026-01-02T03:04:05.000Z' },
    'hBP01-002': { buyPrice: 1200, timestamp: '2026-01-02T03:04:05.000Z' },
  };

  assert.deepEqual(result, expected);
  assert.deepEqual(JSON.parse(fs.readFileSync(outputFile, 'utf-8')), expected);
}

await testScrapeOnceThrowsOnNon2xxPage();
await testFailedScrapeKeepsPreviousFile();
await testSuccessfulScrapeWritesPrices();
console.log('✅ fullahead buy throw/partial-write tests passed');
