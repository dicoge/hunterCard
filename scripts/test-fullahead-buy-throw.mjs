import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scrapeFullaheadBuy, scrapeOnce } from './scrape-fullahead-buy.js';

function makeDatabase(dir) {
  const dbPath = path.join(dir, 'database.json');
  fs.writeFileSync(
    dbPath,
    JSON.stringify({ cards: { card1: { cardNumber: 'hBP01-001' }, card2: { cardNumber: 'hBP01-002' } } }),
    'utf-8',
  );
  return dbPath;
}

function createPage({ responses }) {
  const requestHandlers = [];
  return {
    on(event, handler) {
      if (event === 'request') requestHandlers.push(handler);
    },
    async goto() {
      for (const handler of requestHandlers) {
        handler({
          url: () => 'https://fullahead-buy.com/fetchRecords.php?app=38&apiToken=test-token',
        });
      }
    },
    async evaluate(fn, base, token) {
      let fetchCount = 0;
      const previousFetch = globalThis.fetch;
      try {
        globalThis.fetch = async (url) => {
          assert.match(url, new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\?`));
          assert.equal(token, 'test-token');
          const response = responses[fetchCount++];
          if (!response) throw new Error(`unexpected fetch ${fetchCount}`);
          return response;
        };
        return await fn(base, token);
      } finally {
        globalThis.fetch = previousFetch;
      }
    },
  };
}

async function testNon2xxPaginationThrows() {
  const page = createPage({
    responses: [
      { ok: false, status: 503, statusText: 'Service Unavailable', json: async () => ({}) },
    ],
  });

  await assert.rejects(
    () => scrapeOnce(page, { sleepFn: async () => {} }),
    /Fullahead page 0 failed: 503 Service Unavailable/,
  );
}

async function testFailureDoesNotOverwritePreviousFile() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fullahead-buy-fail-'));
  const dbPath = makeDatabase(tmpDir);
  const outputDir = path.join(tmpDir, 'buy-prices');
  const outputFile = path.join(outputDir, 'fullahead-prices.json');
  fs.mkdirSync(outputDir, { recursive: true });
  const previous = { 'hBP01-001': { buyPrice: 111, timestamp: 'previous' } };
  fs.writeFileSync(outputFile, `${JSON.stringify(previous, null, 2)}\n`, 'utf-8');

  await assert.rejects(
    () => scrapeFullaheadBuy({
      dbPath,
      outputDir,
      outputFile,
      launchBrowserFn: async () => ({
        browser: { close: async () => {} },
        page: {},
      }),
      scrapeOnceFn: async () => {
        throw new Error('Fullahead page 0 failed: 500 Internal Server Error');
      },
    }),
    /Fullahead page 0 failed: 500 Internal Server Error/,
  );

  assert.deepEqual(JSON.parse(fs.readFileSync(outputFile, 'utf-8')), previous);
}

async function testSuccessfulCrawlStillWritesBestPrices() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fullahead-buy-ok-'));
  const dbPath = makeDatabase(tmpDir);
  const outputDir = path.join(tmpDir, 'buy-prices');
  const outputFile = path.join(outputDir, 'fullahead-prices.json');

  const result = await scrapeFullaheadBuy({
    dbPath,
    outputDir,
    outputFile,
    launchBrowserFn: async () => ({
      browser: { close: async () => {} },
      page: {},
    }),
    scrapeOnceFn: async () => [
      { productName: '【C】hBP01-001 Test Low', price: '100' },
      { productName: '【UR】hBP01-001 Test High', price: '1,500' },
      { productName: '【R】hBP01-002 Other', price: '300' },
      { productName: 'not a hololive card', price: '999' },
    ],
  });

  assert.equal(result['hBP01-001'].buyPrice, 1500);
  assert.equal(result['hBP01-002'].buyPrice, 300);
  assert.deepEqual(JSON.parse(fs.readFileSync(outputFile, 'utf-8')), result);
}

await testNon2xxPaginationThrows();
await testFailureDoesNotOverwritePreviousFile();
await testSuccessfulCrawlStillWritesBestPrices();
console.log('✅ fullahead-buy throw/failure-path tests passed');
