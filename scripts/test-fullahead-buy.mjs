import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  scrapeFullaheadBuy,
  scrapeOnce,
} from './scrape-fullahead-buy.js';

function makeCardNumbers() {
  return new Map([
    ['HBP01-001', 'hBP01-001'],
    ['HBP01-002', 'hBP01-002'],
  ]);
}

function makePageWithApi({ status = 200, statusText = 'OK', recordsByPage = [] }) {
  const requestHandlers = [];
  const fetchCalls = [];
  const page = {
    on(event, handler) {
      if (event === 'request') requestHandlers.push(handler);
    },
    async goto() {
      for (const handler of requestHandlers) {
        handler({
          url: () => 'https://fullahead-buy.com/fetchRecords.php?app=38&apiToken=test-token&lastRecId=-1',
        });
      }
    },
    async evaluate(fn, base, token) {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url) => {
        fetchCalls.push(String(url));
        const pageIndex = fetchCalls.length - 1;
        if (status < 200 || status >= 300) {
          return { ok: false, status, statusText };
        }
        return {
          ok: true,
          status,
          statusText,
          async json() {
            return { json: { records: recordsByPage[pageIndex] || [] } };
          },
        };
      };
      try {
        return await fn(base, token);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  };
  return { page, fetchCalls };
}

function record({ id, productName, price }) {
  return {
    '$id': { value: id },
    PRODUCT_NAME: { value: productName },
    PURCHASE_PRICE: { value: price },
  };
}

async function assertRejectsWithoutWriting({ name, scrapeFn, existingContent, previousCount = 2 }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `fullahead-${name}-`));
  const outputFile = path.join(tmpDir, 'fullahead-prices.json');
  if (existingContent !== undefined) fs.writeFileSync(outputFile, existingContent, 'utf-8');

  await assert.rejects(
    () => scrapeFullaheadBuy({
      outputDir: tmpDir,
      outputFile,
      loadCardNumbersFn: makeCardNumbers,
      scrapeFn,
      readPreviousCountFn: () => previousCount,
      nowFn: () => new Date('2026-01-01T00:00:00.000Z'),
    }),
    /failed|Refusing to write|crawl produced 0 prices|previous file had/i,
  );

  if (existingContent === undefined) {
    assert.equal(fs.existsSync(outputFile), false, `${name}: should not create output file`);
  } else {
    assert.equal(fs.readFileSync(outputFile, 'utf-8'), existingContent, `${name}: should keep previous file unchanged`);
  }
}

async function testNon2xxPaginationThrowsBeforePartialWrite() {
  const { page, fetchCalls } = makePageWithApi({ status: 503, statusText: 'Service Unavailable' });

  await assert.rejects(
    () => scrapeOnce(page),
    /Fullahead page 0 failed: 503 Service Unavailable/,
  );
  assert.equal(fetchCalls.length, 1, 'should stop immediately on non-2xx pagination response');

  await assertRejectsWithoutWriting({
    name: 'non2xx-no-file',
    scrapeFn: async () => { throw new Error('Fullahead page 0 failed: 503 Service Unavailable'); },
  });
}

async function testNormalCrawlWritesPrices() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fullahead-success-'));
  const outputFile = path.join(tmpDir, 'fullahead-prices.json');

  const result = await scrapeFullaheadBuy({
    outputDir: tmpDir,
    outputFile,
    loadCardNumbersFn: makeCardNumbers,
    scrapeFn: async () => [
      { productName: '【R】hBP01-001 テストカード', price: '100' },
      { productName: '【UR】hBP01-001 テストカード', price: '1,500' },
      { productName: '【R】hBP01-002 テストカード2', price: '200' },
      { productName: 'not in database hBP99-999', price: '999' },
    ],
    readPreviousCountFn: () => 0,
    nowFn: () => new Date('2026-01-01T00:00:00.000Z'),
  });

  assert.deepEqual(result, {
    'hBP01-001': { buyPrice: 1500, timestamp: '2026-01-01T00:00:00.000Z' },
    'hBP01-002': { buyPrice: 200, timestamp: '2026-01-01T00:00:00.000Z' },
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(outputFile, 'utf-8')), result);
}

async function testZeroPricesDoNotWriteEmptyFile() {
  await assertRejectsWithoutWriting({
    name: 'zero-prices',
    scrapeFn: async () => [],
  });
}

async function testSuspiciousShrinkKeepsPreviousFile() {
  const previous = '{"hBP01-001":{"buyPrice":999,"timestamp":"old"},"hBP01-002":{"buyPrice":888,"timestamp":"old"}}\n';
  await assertRejectsWithoutWriting({
    name: 'shrink',
    existingContent: previous,
    previousCount: 3,
    scrapeFn: async () => [
      { productName: '【R】hBP01-001 テストカード', price: '100' },
    ],
  });
}

await testNon2xxPaginationThrowsBeforePartialWrite();
await testNormalCrawlWritesPrices();
await testZeroPricesDoNotWriteEmptyFile();
await testSuspiciousShrinkKeepsPreviousFile();
console.log('✅ fullahead buy scraper tests passed');
