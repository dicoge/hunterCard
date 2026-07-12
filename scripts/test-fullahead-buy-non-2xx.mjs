import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scrapeFullaheadBuy, scrapeOnce } from './scrape-fullahead-buy.js';

function makeTempProject(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dataDir = path.join(root, 'data');
  const outputDir = path.join(dataDir, 'buy-prices');
  fs.mkdirSync(outputDir, { recursive: true });
  const dbPath = path.join(dataDir, 'database.json');
  const outputFile = path.join(outputDir, 'fullahead-prices.json');
  fs.writeFileSync(
    dbPath,
    `${JSON.stringify({ cards: { card1: { cardNumber: 'hBP01-001' } } }, null, 2)}\n`,
    'utf-8',
  );
  return { root, dbPath, outputDir, outputFile };
}

async function testScrapeOnceThrowsOnNon2xx() {
  const requests = [];
  const page = {
    on: (event, cb) => {
      assert.equal(event, 'request');
      cb({
        url: () => 'https://fullahead-buy.com/api/fetchRecords.php?app=38&apiToken=test-token',
      });
    },
    goto: async () => {},
    evaluate: async (fn, base, token) => {
      const oldFetch = globalThis.fetch;
      try {
        globalThis.fetch = async (url) => {
          requests.push(url);
          return { ok: false, status: 503, statusText: 'Service Unavailable' };
        };
        return await fn(base, token);
      } finally {
        globalThis.fetch = oldFetch;
      }
    },
  };

  await assert.rejects(
    () => scrapeOnce(page),
    /Fullahead page 0 failed: 503 Service Unavailable/,
    'scrapeOnce should throw immediately when a pagination API response is non-2xx',
  );
  assert.equal(requests.length, 1, 'scrapeOnce should stop at the first non-2xx page');
}

async function testFailedScrapeKeepsPreviousOutput() {
  const { dbPath, outputDir, outputFile } = makeTempProject('fullahead-keep-prev-');
  const previous = {
    'hBP01-001': { buyPrice: 777, timestamp: '2026-01-01T00:00:00.000Z' },
  };
  fs.writeFileSync(outputFile, `${JSON.stringify(previous, null, 2)}\n`, 'utf-8');

  await assert.rejects(
    () => scrapeFullaheadBuy({
      dbPath,
      outputDir,
      outputFile,
      scrapeWithRestartFn: async () => {
        throw new Error('Fullahead page 0 failed: 503 Service Unavailable');
      },
    }),
    /Fullahead page 0 failed: 503 Service Unavailable/,
  );

  assert.deepEqual(JSON.parse(fs.readFileSync(outputFile, 'utf-8')), previous);
}

async function testSuccessfulScrapeStillWritesHighestPrices() {
  const { dbPath, outputDir, outputFile } = makeTempProject('fullahead-success-');

  const out = await scrapeFullaheadBuy({
    dbPath,
    outputDir,
    outputFile,
    nowFn: () => new Date('2026-02-03T04:05:06.000Z'),
    scrapeWithRestartFn: async () => [
      { productName: '【C】hBP01-001 テストカード', price: '100' },
      { productName: '【UR】hBP01-001 テストカード', price: '1,500' },
      { productName: 'not a card', price: '9999' },
    ],
  });

  assert.deepEqual(out, {
    'hBP01-001': { buyPrice: 1500, timestamp: '2026-02-03T04:05:06.000Z' },
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(outputFile, 'utf-8')), out);
}

function testCliExits1AndKeepsPreviousOutput() {
  const { dbPath, outputFile } = makeTempProject('fullahead-cli-');
  const previous = {
    'hBP01-001': { buyPrice: 888, timestamp: '2026-01-01T00:00:00.000Z' },
  };
  fs.writeFileSync(outputFile, `${JSON.stringify(previous, null, 2)}\n`, 'utf-8');

  const script = `
    import { scrapeFullaheadBuy } from ${JSON.stringify(new URL('./scrape-fullahead-buy.js', import.meta.url).href)};
    await scrapeFullaheadBuy({
      dbPath: ${JSON.stringify(dbPath)},
      outputDir: ${JSON.stringify(path.dirname(outputFile))},
      outputFile: ${JSON.stringify(outputFile)},
      scrapeWithRestartFn: async () => { throw new Error('Fullahead page 0 failed: 500 Internal Server Error'); },
    }).then(() => process.exit(0)).catch((err) => {
      console.error('[test-cli] fatal:', err.message);
      process.exit(1);
    });
  `;

  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf-8',
  });

  assert.equal(result.status, 1, `expected exit 1, stdout=${result.stdout}, stderr=${result.stderr}`);
  assert.match(result.stderr, /Fullahead page 0 failed: 500 Internal Server Error/);
  assert.deepEqual(JSON.parse(fs.readFileSync(outputFile, 'utf-8')), previous);
}

await testScrapeOnceThrowsOnNon2xx();
await testFailedScrapeKeepsPreviousOutput();
await testSuccessfulScrapeStillWritesHighestPrices();
testCliExits1AndKeepsPreviousOutput();
console.log('✅ fullahead buy non-2xx tests passed');
