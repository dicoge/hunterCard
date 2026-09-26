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

console.log('\n✅ yuyu series pages OK');
