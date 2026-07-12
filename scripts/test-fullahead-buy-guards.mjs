import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scrapeFullaheadBuy, scrapeOnce } from './scrape-fullahead-buy.js';

function createDb(dir) {
  const dbPath = path.join(dir, 'database.json');
  fs.writeFileSync(
    dbPath,
    JSON.stringify({ cards: { card1: { cardNumber: 'hBP01-001' }, card2: { cardNumber: 'hBP01-002' } } }),
    'utf-8'
  );
  return dbPath;
}

async function assertRejectsWithoutWriting({ records, messagePattern }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fullahead-buy-guard-'));
  const dbPath = createDb(tmpDir);
  const outputDir = path.join(tmpDir, 'buy-prices');
  const outputFile = path.join(outputDir, 'fullahead-prices.json');
  const previous = { 'hBP01-001': { buyPrice: 999, timestamp: 'old' } };
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputFile, `${JSON.stringify(previous, null, 2)}\n`, 'utf-8');

  await assert.rejects(
    scrapeFullaheadBuy({
      scrapeWithRestartFn: async () => records,
      dbPath,
      outputDir,
      outputFile,
    }),
    messagePattern
  );

  assert.deepEqual(JSON.parse(fs.readFileSync(outputFile, 'utf-8')), previous);
}

async function testApiPaginationFailureThrowsInsidePageEvaluate() {
  const requests = [];
  const page = {
    on: (_event, handler) => {
      handler({
        url: () => 'https://fullahead-buy.com/api/fetchRecords.php?app=38&apiToken=test-token',
      });
    },
    goto: async () => {},
    evaluate: async (fn, base, token) => {
      const previousFetch = globalThis.fetch;
      globalThis.fetch = async (url) => {
        requests.push(url);
        return { ok: false, status: 503, statusText: 'Service Unavailable' };
      };
      try {
        return fn(base, token);
      } finally {
        globalThis.fetch = previousFetch;
      }
    },
  };

  await assert.rejects(
    scrapeOnce(page),
    /Fullahead page 0 failed: 503 Service Unavailable/
  );
  assert.equal(requests.length, 1);
  assert.match(requests[0], /lastRecId=-1/);
}

async function testZeroMatchedRecordsPreservesPreviousOutput() {
  await assertRejectsWithoutWriting({
    records: [{ productName: 'not a hololive card', price: '100' }],
    messagePattern: /Refusing to write: crawl produced 0 prices/,
  });
}

async function testShrinkGuardPreservesPreviousOutput() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fullahead-buy-shrink-'));
  const dbPath = createDb(tmpDir);
  const outputDir = path.join(tmpDir, 'buy-prices');
  const outputFile = path.join(outputDir, 'fullahead-prices.json');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    outputFile,
    JSON.stringify(
      {
        'hBP01-001': { buyPrice: 999, timestamp: 'old' },
        'hBP01-002': { buyPrice: 888, timestamp: 'old' },
        'hBP01-003': { buyPrice: 777, timestamp: 'old' },
      },
      null,
      2
    ) + '\n',
    'utf-8'
  );

  await assert.rejects(
    scrapeFullaheadBuy({
      scrapeWithRestartFn: async () => [{ productName: '【UR】hBP01-001 テスト', price: '100' }],
      dbPath,
      outputDir,
      outputFile,
    }),
    /Refusing to write: new crawl has 1 prices but previous file had 3/
  );

  const after = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
  assert.equal(after['hBP01-001'].buyPrice, 999);
  assert.equal(Object.keys(after).length, 3);
}

async function testSuccessfulRunWritesHighestMatchedPrices() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fullahead-buy-success-'));
  const dbPath = createDb(tmpDir);
  const outputDir = path.join(tmpDir, 'buy-prices');
  const outputFile = path.join(outputDir, 'fullahead-prices.json');

  const out = await scrapeFullaheadBuy({
    scrapeWithRestartFn: async () => [
      { productName: '【C】hBP01-001 テスト', price: '100' },
      { productName: '【UR】hBP01-001 テスト', price: '1,200' },
      { productName: '【C】hBP01-999 未登録', price: '500' },
      { productName: '【C】hBP01-002 テスト2', price: '300' },
    ],
    dbPath,
    outputDir,
    outputFile,
  });

  assert.equal(out['hBP01-001'].buyPrice, 1200);
  assert.equal(out['hBP01-002'].buyPrice, 300);
  assert.deepEqual(Object.keys(out).sort(), ['hBP01-001', 'hBP01-002']);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(outputFile, 'utf-8'))).sort(), ['hBP01-001', 'hBP01-002']);
}

await testApiPaginationFailureThrowsInsidePageEvaluate();
await testZeroMatchedRecordsPreservesPreviousOutput();
await testShrinkGuardPreservesPreviousOutput();
await testSuccessfulRunWritesHighestMatchedPrices();
console.log('✅ fullahead buy guard tests passed');
