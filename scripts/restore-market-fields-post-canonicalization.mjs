#!/usr/bin/env node
/**
 * restore-market-fields-post-canonicalization.mjs — one-shot repair for the
 * shipped DIC-1204 regression (market fields wiped by daily rebuild after
 * DIC-1084 canonicalization renamed printing IDs).
 *
 * This is the manual counterpart of `scripts/build-database.js`'s new
 * signature-based preservation: it reads a fresh (already-rebuilt) DB and
 * carries proven market fields forward from a prior good DB using
 * `preserve-market-fields.js`. Same fail-closed contract: exact id first,
 * then strict cardNumber|sourceProduct|rarity signature, ambiguous signatures
 * refused. Idempotent — running twice does not double-apply, because
 * `applyPreservedMarketFields` never overwrites a non-empty value.
 *
 * Usage:
 *   node scripts/restore-market-fields-post-canonicalization.mjs \
 *     --prev <path/to/prev/database.json> \
 *     [--target data/database.json]
 *
 * Also broadcasts ytStats onto every printing that carries the matched
 * holomen's name/nameZh (DIC-1153 pinned row count), because the daily
 * rebuild's early-return regression left ytStats attached only to the first
 * variant per cardNumber. Broadcasting uses ONLY the ytStats already in the
 * current or previous DB rows — no external channel/name mapping — so the
 * repair is deterministic and network-free.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPreservationIndex,
  findPreservedMatch,
  applyPreservedMarketFields,
  seedCanonicalHistoryFiles,
} from './lib/preserve-market-fields.js';
import { broadcastYtStats } from './lib/yt-stats-fanout.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = { target: path.join(repoRoot, 'data', 'database.json'), prev: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--prev') args.prev = argv[++i];
    else if (argv[i] === '--target') args.target = argv[++i];
  }
  if (!args.prev) throw new Error('--prev <path> is required');
  return args;
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function reorderPricedRowsFirst(cards) {
  // Fix the version-alignment regression the daily rebuild reintroduced.
  // The DETAIL pipeline in `buildPriceVersions` reads the first-seen row per
  // cardNumber; if an empty-price hEB01/hBP08 canonical reprint lands
  // before the yuyu-priced hBP01/ent07 row, detail defaults to a BASE row
  // that never carried a proven sellPrice while the deck builder falls onto
  // the priced reprint. Reorder so, for each cardNumber, rows with a proven
  // sell payload precede empty-price reprints. Relative order within each
  // bucket is preserved. This is the same manual reshuffle PR #154 shipped.
  const priced = [];
  const unpriced = [];
  for (const [id, card] of Object.entries(cards)) {
    const hasSell = Number.isFinite(card?.sellPrice) && card.sellPrice > 0;
    const hasPrices = Array.isArray(card?.prices) && card.prices.length > 0;
    (hasSell || hasPrices ? priced : unpriced).push([id, card]);
  }
  const reordered = {};
  for (const [id, card] of priced) reordered[id] = card;
  for (const [id, card] of unpriced) reordered[id] = card;
  return reordered;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const prevDb = loadJson(args.prev);
  const targetDb = loadJson(args.target);
  if (!targetDb?.cards || typeof targetDb.cards !== 'object') {
    throw new Error(`${args.target} is missing a cards map`);
  }
  const index = buildPreservationIndex(prevDb.cards || {});
  let restored = 0;
  const counts = { sellPrice: 0, prices: 0, priceHistory: 0, ytStats: 0 };
  for (const [id, card] of Object.entries(targetDb.cards)) {
    const match = findPreservedMatch(index, id, card);
    if (!match) continue;
    const summary = applyPreservedMarketFields(card, match.card, { matchKind: match.matchKind });
    let any = false;
    for (const key of Object.keys(counts)) {
      if (summary[key]) { counts[key] += 1; any = true; }
    }
    if (any) restored += 1;
  }
  const broadcastCount = broadcastYtStats(targetDb.cards, prevDb.cards || {});
  targetDb.cards = reorderPricedRowsFirst(targetDb.cards);
  fs.writeFileSync(args.target, `${JSON.stringify(targetDb, null, 2)}\n`, 'utf8');
  // Persist preserved multi-day priceHistory to disk under the canonical-ID
  // filename so the next daily rebuild's Step 5 append + Step 6 re-read
  // cannot collapse the restored history back to today's single record.
  const historyDir = path.join(path.dirname(args.target), 'price-history');
  const seedResult = seedCanonicalHistoryFiles({
    cards: targetDb.cards,
    historyDir,
    fsAdapter: { fs, path },
  });
  // Rebuild data/price-history/index.json against the current file set so
  // the shipped index reflects the seeded canonical-ID files.
  rebuildHistoryIndex(historyDir);
  console.log(
    `✓ restored market fields onto ${restored} rows in ${path.relative(repoRoot, args.target)} `
    + `(sellPrice=${counts.sellPrice}, prices=${counts.prices}, priceHistory=${counts.priceHistory}, ytStats=${counts.ytStats}); `
    + `broadcast ytStats onto ${broadcastCount} additional printings; `
    + `seeded ${seedResult.seededFiles} canonical-ID history files (+${seedResult.addedRecords} records)`
  );
}

function rebuildHistoryIndex(historyDir) {
  const cardIds = [];
  let totalRecords = 0;
  for (const file of fs.readdirSync(historyDir)) {
    if (!file.endsWith('.json') || file === 'index.json') continue;
    cardIds.push(file.replace('.json', ''));
    try {
      const hist = JSON.parse(fs.readFileSync(path.join(historyDir, file), 'utf8'));
      totalRecords += hist.records?.length || 0;
    } catch {
      // skip corrupted file
    }
  }
  const index = {
    lastUpdated: new Date().toISOString(),
    totalCards: cardIds.length,
    totalRecords,
    cardIds,
  };
  fs.writeFileSync(path.join(historyDir, 'index.json'), JSON.stringify(index, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export { broadcastYtStats };
