import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scrapeFullaheadBuy } from './scrape-fullahead-buy.js';

const outputFile = path.resolve('data/buy-prices/fullahead-prices.json');
const before = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : null;

await assert.rejects(
  () => scrapeFullaheadBuy(),
  /Fullahead page 0 failed: 503 Service Unavailable/,
  'non-2xx pagination response should throw with page/status details'
);

const after = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : null;
assert.equal(after, before, 'non-2xx pagination failure must not write partial output');

console.log('✅ fullahead-buy non-2xx pagination response throws and preserves existing output');
