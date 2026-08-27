#!/usr/bin/env node
/**
 * migrate-price-history-provenance-DIC-1219.mjs — one-shot repair for the
 * cross-product price-history contamination Mac-Codex flagged in DIC-1219
 * CR of PR #157 (`hBP04-028_hBP08_C_hBP04-028_C_02` had 64 days of hBP04
 * base priceHistory attached to an hBP08 reprint row despite the fresh
 * hBP08 listing).
 *
 * Root cause. DIC-1204's seed script wrote origin-product records (from
 * pre-canonicalization snapshots) into reprint rows' canonical-ID history
 * files. Every subsequent build cycle carried those unstamped records
 * forward — Step 6 rebuilt `card.priceHistory` from them, DIC-1204
 * preservation carried the map forward, `seedCanonicalHistoryFiles` wrote
 * it back into the durable file. Legacy records carry no per-record
 * provenance stamp so the contamination is invisible to the merge step
 * until we add one.
 *
 * Fail-closed contract this migration enforces (matches the runtime filter
 * in `preserve-market-fields.js::filterProvenanceMatchedRecords`):
 *   - Origin-product rows (sourceProduct === cardNumber origin prefix)
 *     retain their durable history file. Their records are unstamped legacy
 *     but structurally clean — the file always described the origin
 *     printing's own listing.
 *   - Reprint rows (sourceProduct !== cardNumber origin prefix) have their
 *     durable history file moved to `data/price-history-quarantined-DIC-1219/`
 *     for audit and their in-memory `priceHistory` / `priceHistoryMeta`
 *     cleared on `data/database.json`. Their history rebuilds legitimately
 *     from the next Step 5 write (which stamps records with sourceProduct).
 *
 * Idempotent. Running twice does not double-quarantine because the second
 * run finds no reprint-row files under `data/price-history/`. Files already
 * in the quarantine dir are left alone.
 *
 * Usage:
 *   node scripts/migrate-price-history-provenance-DIC-1219.mjs [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isReprintRow, historyFilenameFor } from './lib/preserve-market-fields.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const dbPath = path.join(repoRoot, 'data', 'database.json');
const historyDir = path.join(repoRoot, 'data', 'price-history');
const quarantineDir = path.join(repoRoot, 'data', 'price-history-quarantined-DIC-1219');

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const dbRaw = fs.readFileSync(dbPath, 'utf-8');
  const hadTrailingNewline = dbRaw.endsWith('\n');
  const db = JSON.parse(dbRaw);
  if (!db.cards || typeof db.cards !== 'object') {
    throw new Error('data/database.json missing cards map');
  }

  fs.mkdirSync(quarantineDir, { recursive: true });

  let quarantinedFiles = 0;
  let clearedRowHistories = 0;
  const seenReprintIds = [];

  for (const [cardId, card] of Object.entries(db.cards)) {
    if (!isReprintRow(card)) continue;
    seenReprintIds.push(cardId);

    // Quarantine durable history file (if any).
    const fname = historyFilenameFor(cardId);
    const srcFile = path.join(historyDir, fname);
    if (fs.existsSync(srcFile)) {
      const destFile = path.join(quarantineDir, fname);
      if (!dryRun) fs.renameSync(srcFile, destFile);
      quarantinedFiles++;
    }

    // Clear in-memory priceHistory / priceHistoryMeta on the reprint row —
    // Step 6 rebuilds it fail-closed from stamped records only.
    let cleared = false;
    if (card.priceHistory && Object.keys(card.priceHistory).length > 0) {
      if (!dryRun) card.priceHistory = {};
      cleared = true;
    }
    if (card.priceHistoryMeta) {
      if (!dryRun) delete card.priceHistoryMeta;
      cleared = true;
    }
    if (cleared) clearedRowHistories++;
  }

  // Rebuild the durable index so it no longer lists quarantined files.
  const indexPath = path.join(historyDir, 'index.json');
  let rebuiltIndex = false;
  if (fs.existsSync(indexPath) && !dryRun) {
    const remainingIds = [];
    let totalRecords = 0;
    for (const file of fs.readdirSync(historyDir)) {
      if (!file.endsWith('.json') || file === 'index.json') continue;
      remainingIds.push(file.replace('.json', ''));
      try {
        const doc = JSON.parse(fs.readFileSync(path.join(historyDir, file), 'utf-8'));
        totalRecords += doc.records?.length || 0;
      } catch {
        // skip corrupt file
      }
    }
    const newIndex = {
      lastUpdated: new Date().toISOString(),
      totalCards: remainingIds.length,
      totalRecords,
      cardIds: remainingIds,
    };
    fs.writeFileSync(indexPath, `${JSON.stringify(newIndex, null, 2)}\n`, 'utf-8');
    rebuiltIndex = true;
  }

  if (!dryRun) {
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2) + (hadTrailingNewline ? '\n' : ''), 'utf-8');
  }

  console.log(`DIC-1219 migration${dryRun ? ' (dry-run)' : ''}:`);
  console.log(`  reprint rows scanned: ${seenReprintIds.length}`);
  console.log(`  history files quarantined: ${quarantinedFiles} → ${path.relative(repoRoot, quarantineDir)}/`);
  console.log(`  reprint rows with priceHistory cleared: ${clearedRowHistories}`);
  console.log(`  data/database.json ${dryRun ? 'would be' : 'was'} updated`);
  console.log(`  data/price-history/index.json ${rebuiltIndex ? 'rebuilt' : dryRun ? 'would be rebuilt' : 'not touched'}`);
}

main();
