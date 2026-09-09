#!/usr/bin/env node
/**
 * Fail-closed deployment data gate for DIC-1167.
 *
 * Vercel must not publish a web build when canonical data has regressed to the
 * catalog-only payload (hEB01 present, but sellPrice/priceHistory wiped). This
 * script runs inside vercel.json before `expo export` and also in local CI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

const canonicalPath = process.env.HUNTERCARD_DATABASE_PATH || path.join(repoRoot, 'data', 'database.json');
const publicPath = process.env.HUNTERCARD_PUBLIC_DATABASE_PATH || path.join(repoRoot, 'public', 'data', 'database.json');

const MIN_TOTAL_CARDS = 3622;
const REQUIRED_HEB01_COUNT = 214;
const MIN_SELL_PRICE_COVERAGE = 1000;
const MIN_PRICE_HISTORY_COVERAGE = 500;
const MIN_BUY_PRICE_COVERAGE = 500;
const MIN_YT_STATS_COVERAGE = 1000;

function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read JSON ${file}: ${err.message}`);
  }
}

function cardList(db) {
  if (db?.cards && !Array.isArray(db.cards) && typeof db.cards === 'object') return Object.values(db.cards);
  if (Array.isArray(db?.cards)) return db.cards;
  throw new Error('database.cards must be an object or array');
}

function coverage(db) {
  const cards = cardList(db);
  return {
    lastUpdated: db.lastUpdated || null,
    total: cards.length,
    hEB01: cards.filter((c) => c?.sourceProduct === 'hEB01').length,
    sellPrice: cards.filter((c) => typeof c?.sellPrice === 'number').length,
    priceHistory: cards.filter((c) => c?.priceHistory && Object.keys(c.priceHistory).length > 0).length,
    buyPrice: cards.filter((c) => typeof c?.buyPrice === 'number').length,
    ytStats: cards.filter((c) => c?.ytStats && Object.keys(c.ytStats).length > 0).length,
  };
}

function assertAtLeast(failures, metric, actual, min) {
  if (actual < min) failures.push(`${metric} ${actual} < required ${min}`);
}

function assertEquals(failures, metric, actual, expected) {
  if (actual !== expected) failures.push(`${metric} ${actual} != required ${expected}`);
}

function audit(label, db, { fullMarketData }) {
  const c = coverage(db);
  const failures = [];
  assertAtLeast(failures, `${label} total cards`, c.total, MIN_TOTAL_CARDS);
  assertEquals(failures, `${label} hEB01 count`, c.hEB01, REQUIRED_HEB01_COUNT);
  assertAtLeast(failures, `${label} sellPrice coverage`, c.sellPrice, MIN_SELL_PRICE_COVERAGE);
  if (fullMarketData) {
    assertAtLeast(failures, `${label} nonempty priceHistory coverage`, c.priceHistory, MIN_PRICE_HISTORY_COVERAGE);
    assertAtLeast(failures, `${label} buyPrice coverage`, c.buyPrice, MIN_BUY_PRICE_COVERAGE);
    assertAtLeast(failures, `${label} ytStats coverage`, c.ytStats, MIN_YT_STATS_COVERAGE);
  }
  return { coverage: c, failures };
}

const canonical = loadJson(canonicalPath);
const publicDb = loadJson(publicPath);
const canonicalAudit = audit('canonical data/database.json', canonical, { fullMarketData: true });
// public/data/database.json is the native/Store-safe asset; it intentionally strips
// subscriber/buy/history fields, but must still keep catalog count and retail sellPrice.
const publicAudit = audit('native public/data/database.json', publicDb, { fullMarketData: false });

const failures = [...canonicalAudit.failures, ...publicAudit.failures];
if (canonicalAudit.coverage.lastUpdated !== publicAudit.coverage.lastUpdated) {
  failures.push(`native lastUpdated ${publicAudit.coverage.lastUpdated} != canonical ${canonicalAudit.coverage.lastUpdated}`);
}
if (canonicalAudit.coverage.total !== publicAudit.coverage.total) {
  failures.push(`native total ${publicAudit.coverage.total} != canonical ${canonicalAudit.coverage.total}`);
}

console.log(JSON.stringify({
  canonicalPath,
  publicPath,
  canonical: canonicalAudit.coverage,
  public: publicAudit.coverage,
}, null, 2));

if (failures.length > 0) {
  console.error('❌ deployment data gate failed:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('✅ deployment data gate passed.');
