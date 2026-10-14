#!/usr/bin/env node
/**
 * test-yuyu-series-pages.mjs — DIC-1167 (2026-09-26) regression.
 *
 * generateSeriesPages() derives the yuyu-tei scrape page list from the
 * committed catalog's `series` codes and silently skipped (warn-only) any
 * code without a URL rule. hEB01 had none, so the whole product (214 official
 * rows, 34 cardNumbers) was never scraped and every row shipped unpriced; the
 * only hEB01 listings the builder saw came from OTHER products' pages and
 * (correctly) failed exact-print proof. A silently unscraped product is
 * indistinguishable from "no market", so this pins the invariant: every
 * committed series is either mapped to a yuyu page or explicitly listed in
 * NO_PAGE_SERIES.
 *
 * Run: node scripts/test-yuyu-series-pages.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSeriesPages, NO_PAGE_SERIES } from './build-database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'database.json'), 'utf8'));

const pages = generateSeriesPages();
const byName = new Map(pages.map((p) => [p.name, p.url]));
const committedSeries = [...new Set(Object.values(db.cards).map((c) => c.series))].sort();

const unmapped = committedSeries.filter((s) => !NO_PAGE_SERIES.has(s) && !byName.has(s));
assert.deepEqual(unmapped, [], `committed series without a yuyu page and not in NO_PAGE_SERIES: ${unmapped.join(', ')}`);
console.log(`  ✓ all ${committedSeries.length} committed series mapped or explicitly page-less (${[...NO_PAGE_SERIES].join(', ')})`);

assert.ok(committedSeries.includes('hEB01'), 'fixture precondition: committed catalog carries hEB01');
assert.equal(byName.get('hEB01'), '/sell/hocg/s/search?search_word=&vers[]=heb01');
console.log('  ✓ hEB01 scrapes its own product page (vers[]=heb01)');

// The page `name` becomes each listing's sourceSeries, which
// yuyuEntryMatchesOfficial ties to official.sourceProduct — it must be the
// exact product code, never a normalized/prefix form.
for (const p of pages) {
  assert.ok(committedSeries.includes(p.name), `page ${p.name} is not a committed series code`);
}
assert.equal(new Set(pages.map((p) => p.name)).size, pages.length, 'duplicate series page');
console.log(`  ✓ ${pages.length} pages, each named by an exact committed series code`);

// hCO02 / hCO03 (エクストリーマーカップ25-26 Final コレクションA / B) have no yuyu
// product (read-only evidence 2026-10-14, see the NO_PAGE_SERIES comment). Page-less
// is only safe if (1) every scraper agrees, (2) no page is generated for them, and
// (3) no sibling printing's listing (hBP/hEB01/promo of the same cardNumber) was
// ingested as their price.
const readNoPage = (rel) => {
  const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
  const m = src.match(/const NO_PAGE_SERIES = new Set\(\[([^\]]*)\]\);/);
  assert.ok(m, `${rel} declares NO_PAGE_SERIES`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
};
const canonicalNoPage = [...NO_PAGE_SERIES].sort();
for (const rel of ['scrape-yuyu-prices.js', 'fix-prices-scraper.mjs']) {
  assert.deepEqual(readNoPage(rel), canonicalNoPage, `${rel} NO_PAGE_SERIES drifted from build-database.js`);
}
console.log('  ✓ build-database / scrape-yuyu-prices / fix-prices-scraper agree on NO_PAGE_SERIES');

for (const code of ['hCO02', 'hCO03']) {
  assert.ok(NO_PAGE_SERIES.has(code), `${code} is page-less on yuyu (documented evidence)`);
  assert.ok(!byName.has(code), `${code} must not get a guessed page`);
  const rows = Object.values(db.cards).filter((c) => c.series === code);
  assert.equal(rows.length, 6, `fixture precondition: committed catalog carries 6 ${code} printings`);
  for (const c of rows) {
    assert.ok(!String(c.cardNumber).startsWith(code), `${c.id} is a reprint of another product's cardNumber`);
    assert.equal(c.sellPrice ?? null, null, `${c.id} carries no sibling yuyu sell price`);
    assert.equal(c.buyPrice ?? null, null, `${c.id} carries no sibling yuyu buy price`);
    assert.deepEqual(c.prices ?? [], [], `${c.id} carries no sibling yuyu price rows`);
    assert.equal(c.yuyuName || '', '', `${c.id} carries no sibling yuyu listing name`);
  }
}
console.log('  ✓ hCO02 / hCO03: page-less, no guessed page, no sibling-reprint price ingested');

console.log('\n✅ yuyu series pages OK');
