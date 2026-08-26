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
} from './lib/preserve-market-fields.js';

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

function broadcastYtStats(cards, prevCards = {}) {
  // Two-pass, name-based fan-out. The daily rebuild's mergeYtStats() early-
  // returned after the first cardNumber match, so a rebuild that renamed IDs
  // left later variants of the same holomen without ytStats. Rehydrate the
  // (name -> ytStats) map from whatever ytStats survives in current cards
  // OR — as a fallback — the previous DB. Current wins over previous so a
  // freshly stamped ytStats (post-scrape) is never displaced by a stale one.
  // Only proven ytStats objects are copied; nothing is invented.
  const byNameJp = new Map();
  const byNameZh = new Map();
  const seedFrom = (source) => {
    for (const card of Object.values(source || {})) {
      if (!card?.ytStats) continue;
      const nameJp = String(card.name || '').trim();
      const nameZh = String(card.nameZh || '').trim();
      if (nameJp && !byNameJp.has(nameJp)) byNameJp.set(nameJp, card.ytStats);
      if (nameZh && !byNameZh.has(nameZh)) byNameZh.set(nameZh, card.ytStats);
    }
  };
  seedFrom(cards);
  seedFrom(prevCards);
  let broadcast = 0;
  for (const card of Object.values(cards)) {
    if (card?.ytStats) continue;
    const nameJp = String(card?.name || '').trim();
    const nameZh = String(card?.nameZh || '').trim();
    const stats = (nameJp && byNameJp.get(nameJp)) || (nameZh && byNameZh.get(nameZh));
    if (stats) {
      card.ytStats = stats;
      broadcast++;
    }
  }
  return broadcast;
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
  console.log(
    `✓ restored market fields onto ${restored} rows in ${path.relative(repoRoot, args.target)} `
    + `(sellPrice=${counts.sellPrice}, prices=${counts.prices}, priceHistory=${counts.priceHistory}, ytStats=${counts.ytStats}); `
    + `broadcast ytStats onto ${broadcastCount} additional printings`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export { broadcastYtStats };
