#!/usr/bin/env node
/**
 * purge-unproven-price-history-DIC-1229.mjs — one-shot data cleanup for the
 * shipped DIC-1229 regression Mac-Codex flagged on main d5e49c73:
 * `hBP01-090_hPR_P_hBP01-090_P_02` had `sellPrice:null`, `prices:[]`,
 * `yuyuImage:""` but Production shipped `priceHistory={"2026-08-28":30}`
 * from a poisoned durable record whose stamp `sourceProduct:"hPR"` alone
 * passed the DIC-1219 record filter.
 *
 * The runtime fix (`hasCurrentPriceProvenance`-gated Step 6 + post-Step-6
 * hard-fail audit) prevents `card.priceHistory` from ever shipping on an
 * unproven row. This one-shot migration cleans the DURABLE side so
 * future builds don't have to re-skip and (more importantly) so a
 * subsequent scrape that briefly restores provenance on a poisoned row
 * cannot re-materialise the stale record.
 *
 * Policy — targeted, not global:
 *   - Card-level: for every row where `hasCurrentPriceProvenance(card) ===
 *     false`, clear `card.priceHistory` / `priceHistoryMeta`.
 *   - Durable-file: for the same set of rows, delete the on-disk
 *     `data/price-history/<id>.json` ONLY when its records[] length ≤ 1
 *     (single-record files were almost certainly written by the pre-fix
 *     08-28 daily scrape when the row briefly carried cross-product
 *     provenance). Multi-record files stay on disk: they contain a
 *     genuine history from an era when the row's own listing was
 *     scraped (SEC signed printings that yuyu has since delisted are
 *     the concrete case, 27 files at build-time), and the Step 6 skip
 *     already prevents them from surfacing while provenance is absent.
 *
 * `data/price-history/index.json` is rebuilt so its `cardIds` /
 * `totalRecords` reflect the surviving files. `public/data/database.json`
 * must be regenerated separately via `scripts/generate-native-database.mjs`.
 *
 * Idempotent — a second run finds no unproven-with-history rows.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findAmbiguousPromoRowIds,
  hasCurrentPriceProvenance,
} from './lib/preserve-market-fields.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const dbPath = path.join(repoRoot, 'data', 'database.json');
const historyDir = path.join(repoRoot, 'data', 'price-history');
const indexPath = path.join(historyDir, 'index.json');

export function historyFilenameFor(cardId) {
  return `${String(cardId ?? '').replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
}

/**
 * DIC-1229 rev.2: pure purge implementation the CLI and the regression
 * tests both call. Idempotent across runs: card-level clears touch only
 * rows where `hasCurrentPriceProvenance(card, gateOptions) === false`,
 * durable-file deletions only fire on ≤1-record files (multi-record
 * files carry legitimate scrape history that survives while provenance
 * is absent), and `data/price-history/index.json` is only rewritten
 * when its computed content diverges from the on-disk copy — a second
 * run with no upstream changes leaves every byte, including the
 * `lastUpdated` stamp, unchanged.
 *
 * @param {{ dbPath?: string, historyDir?: string, indexPath?: string,
 *           gateOptions?: object, now?: Date }} [options]
 */
export function purgeUnprovenPriceHistory(options = {}) {
  const resolvedDbPath = options.dbPath ?? dbPath;
  const resolvedHistoryDir = options.historyDir ?? historyDir;
  const resolvedIndexPath = options.indexPath ?? indexPath;
  const gateOptions = options.gateOptions ?? {};

  const raw = fs.readFileSync(resolvedDbPath, 'utf-8');
  const hadTrailingNewline = raw.endsWith('\n');
  const db = JSON.parse(raw);
  if (!db.cards || typeof db.cards !== 'object') {
    throw new Error('data/database.json missing cards map');
  }

  // Inherit the DIC-1227 non-ambiguity rule into the purge decision so a
  // duplicate-yuyu-URL hPR pair the runtime treats as unproven is also
  // treated as unproven here (no need for the caller to pass ambiguousIds
  // separately — deriving it here keeps the CLI usage simple and matches
  // the runtime gate in build-database.js).
  const gateWithAmbig = {
    ...gateOptions,
    ambiguousIds: gateOptions.ambiguousIds ?? findAmbiguousPromoRowIds(db.cards),
  };

  let cardsCleared = 0;
  let filesPurged = 0;
  let filesKept = 0;
  const purgedSamples = [];
  const keptSamples = [];

  for (const [cardId, card] of Object.entries(db.cards)) {
    if (hasCurrentPriceProvenance(card, gateWithAmbig)) continue;
    // Card-level: always clear (fail-closed display for unproven printing).
    if (card.priceHistory && Object.keys(card.priceHistory).length > 0) {
      card.priceHistory = {};
      cardsCleared++;
    }
    if (card.priceHistoryMeta) delete card.priceHistoryMeta;

    // Durable-file: purge only if ≤ 1 record (single-record files are the
    // pre-fix daily-scrape residue; multi-record files carry legitimate
    // historical scrape data that survives for when provenance returns).
    const histFile = path.join(resolvedHistoryDir, historyFilenameFor(cardId));
    if (!fs.existsSync(histFile)) continue;
    try {
      const doc = JSON.parse(fs.readFileSync(histFile, 'utf-8'));
      const recCount = Array.isArray(doc.records) ? doc.records.length : 0;
      if (recCount <= 1) {
        fs.unlinkSync(histFile);
        filesPurged++;
        if (purgedSamples.length < 3) purgedSamples.push(cardId);
      } else {
        filesKept++;
        if (keptSamples.length < 3) keptSamples.push({ cardId, records: recCount });
      }
    } catch (err) {
      console.warn(`  failed to inspect ${histFile}: ${err.message}`);
    }
  }

  // Rebuild index so totalCards / totalRecords / cardIds reflect the
  // surviving files (drops the purged entries from the shipped index).
  const remainingIds = [];
  let totalRecords = 0;
  for (const file of fs.readdirSync(resolvedHistoryDir).sort()) {
    if (!file.endsWith('.json') || file === 'index.json') continue;
    remainingIds.push(file.replace(/\.json$/, ''));
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(resolvedHistoryDir, file), 'utf-8'));
      totalRecords += Array.isArray(doc.records) ? doc.records.length : 0;
    } catch {}
  }

  // DIC-1229 rev.2 idempotence: only rewrite index.json when its computed
  // content (cardIds + totalRecords + totalCards) diverges from what's
  // already on disk. A second run with no upstream changes leaves the
  // shipped `lastUpdated` stamp intact, which is what the CR contract
  // "true repeated-run idempotence" pins.
  const priorIndex = fs.existsSync(resolvedIndexPath)
    ? JSON.parse(fs.readFileSync(resolvedIndexPath, 'utf-8'))
    : null;
  const priorCardIds = Array.isArray(priorIndex?.cardIds) ? priorIndex.cardIds : [];
  const priorTotalCards = Number(priorIndex?.totalCards) === remainingIds.length ? priorIndex.totalCards : null;
  const priorTotalRecords = Number(priorIndex?.totalRecords) === totalRecords ? priorIndex.totalRecords : null;
  const contentUnchanged =
    priorIndex
    && priorCardIds.length === remainingIds.length
    && priorTotalCards === remainingIds.length
    && priorTotalRecords === totalRecords
    && priorCardIds.every((id, i) => id === remainingIds[i]);

  let indexWritten = false;
  if (!contentUnchanged) {
    const nowIso = (options.now instanceof Date ? options.now : new Date()).toISOString();
    fs.writeFileSync(resolvedIndexPath, `${JSON.stringify({
      lastUpdated: nowIso,
      totalCards: remainingIds.length,
      totalRecords,
      cardIds: remainingIds,
    }, null, 2)}\n`, 'utf-8');
    indexWritten = true;
  }

  // DIC-1229 rev.2 idempotence: only rewrite database.json when card state
  // actually diverged (any card-level clear = at least one row mutated).
  // A second run with no changes leaves the on-disk file untouched.
  let dbWritten = false;
  if (cardsCleared > 0) {
    fs.writeFileSync(
      resolvedDbPath,
      JSON.stringify(db, null, 2) + (hadTrailingNewline ? '\n' : ''),
      'utf-8',
    );
    dbWritten = true;
  }

  return {
    cardsCleared,
    filesPurged,
    filesKept,
    purgedSamples,
    keptSamples,
    remainingIds,
    totalRecords,
    indexWritten,
    dbWritten,
  };
}

function main() {
  const result = purgeUnprovenPriceHistory();
  console.log(`DIC-1229 purge:`);
  console.log(`  card.priceHistory cleared on ${result.cardsCleared} unproven rows`);
  console.log(`  durable files purged: ${result.filesPurged} (single-record poisoned)`);
  console.log(`  durable files kept:   ${result.filesKept} (multi-record legit history)`);
  if (result.purgedSamples.length) console.log(`  purged samples: ${result.purgedSamples.join(', ')}`);
  if (result.keptSamples.length) console.log(`  kept samples:  ${JSON.stringify(result.keptSamples)}`);
  console.log(`  data/database.json:       ${result.dbWritten ? 'rewritten' : 'unchanged (idempotent)'}`);
  console.log(`  price-history index.json: ${result.indexWritten ? 'rewritten' : 'unchanged (idempotent)'}`);
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) main();
