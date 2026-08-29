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
import { hasCurrentPriceProvenance } from './lib/preserve-market-fields.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const dbPath = path.join(repoRoot, 'data', 'database.json');
const historyDir = path.join(repoRoot, 'data', 'price-history');
const indexPath = path.join(historyDir, 'index.json');

function historyFilenameFor(cardId) {
  return `${String(cardId ?? '').replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
}

function main() {
  const raw = fs.readFileSync(dbPath, 'utf-8');
  const hadTrailingNewline = raw.endsWith('\n');
  const db = JSON.parse(raw);
  if (!db.cards || typeof db.cards !== 'object') {
    throw new Error('data/database.json missing cards map');
  }

  let cardsCleared = 0;
  let filesPurged = 0;
  let filesKept = 0;
  const purgedSamples = [];
  const keptSamples = [];

  for (const [cardId, card] of Object.entries(db.cards)) {
    if (hasCurrentPriceProvenance(card)) continue;
    // Card-level: always clear (fail-closed display for unproven printing).
    if (card.priceHistory && Object.keys(card.priceHistory).length > 0) {
      card.priceHistory = {};
      cardsCleared++;
    }
    if (card.priceHistoryMeta) delete card.priceHistoryMeta;

    // Durable-file: purge only if ≤ 1 record (single-record files are the
    // pre-fix daily-scrape residue; multi-record files carry legitimate
    // historical scrape data that survives for when provenance returns).
    const histFile = path.join(historyDir, historyFilenameFor(cardId));
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
  for (const file of fs.readdirSync(historyDir)) {
    if (!file.endsWith('.json') || file === 'index.json') continue;
    remainingIds.push(file.replace(/\.json$/, ''));
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(historyDir, file), 'utf-8'));
      totalRecords += Array.isArray(doc.records) ? doc.records.length : 0;
    } catch {}
  }
  const nowIso = new Date().toISOString();
  fs.writeFileSync(indexPath, `${JSON.stringify({
    lastUpdated: nowIso,
    totalCards: remainingIds.length,
    totalRecords,
    cardIds: remainingIds,
  }, null, 2)}\n`, 'utf-8');

  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2) + (hadTrailingNewline ? '\n' : ''), 'utf-8');

  console.log(`DIC-1229 purge:`);
  console.log(`  card.priceHistory cleared on ${cardsCleared} unproven rows`);
  console.log(`  durable files purged: ${filesPurged} (single-record poisoned)`);
  console.log(`  durable files kept:   ${filesKept} (multi-record legit history)`);
  if (purgedSamples.length) console.log(`  purged samples: ${purgedSamples.join(', ')}`);
  if (keptSamples.length) console.log(`  kept samples:  ${JSON.stringify(keptSamples)}`);
}

main();
