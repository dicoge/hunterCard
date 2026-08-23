#!/usr/bin/env node
/**
 * canonicalize-database.mjs — one-shot rewrite of data/database.json that
 * folds `エラッタ前` / `エラッタ後` history out of user-facing card printings
 * (DIC-1139).
 *
 * A full `build-database.js` run re-scrapes yuyu-tei's ~2 hours of images and
 * prices, which is unnecessary just to apply the new canonicalisation rules
 * to an existing dataset. This script:
 *   1. Loads the current database.json.
 *   2. For each card, folds prices[] through `canonicalizePrices` and
 *      normalises `yuyuName` via `canonicalYuyuName`.
 *   3. Preserves the untouched raw prices on `_rawPricesArchive` for audit.
 *
 * Idempotent — a second run detects that no card carries errata history and
 * writes an unchanged file. Buy-price provenance on the survivors is
 * unchanged (this pass does not merge new buy prices; run merge-buy-prices
 * afterward if a re-alignment is needed).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { canonicalizePrices, canonicalYuyuName, hasErrataLabel } from './lib/canonical-printings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.resolve(__dirname, '../data/database.json');

function main() {
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  const cards = db.cards || {};
  let touched = 0;
  let stillDirty = 0;

  for (const [id, card] of Object.entries(cards)) {
    // Prefer the raw archive (untouched source rows) when it exists: an
    // earlier canonicalisation may have already collapsed rows that should
    // now be preserved (e.g. two same-name-diff-price DIC-1013 listings the
    // first pass folded because the algorithm hadn't yet distinguished
    // errata history from ordinary source ambiguity).
    const sourceRows = Array.isArray(card._rawPricesArchive)
      ? card._rawPricesArchive
      : (Array.isArray(card.prices) ? card.prices : []);
    const originalYuyuName = card.yuyuName || '';
    const { canonical, archive } = canonicalizePrices(sourceRows);
    const nextYuyuName = canonicalYuyuName(originalYuyuName);

    const priorPrices = Array.isArray(card.prices) ? card.prices : [];
    const pricesChanged =
      canonical.length !== priorPrices.length ||
      canonical.some((p, i) => (priorPrices[i]?.name || '') !== (p.name || ''));
    const yuyuChanged = nextYuyuName !== originalYuyuName;
    if (!pricesChanged && !yuyuChanged && Array.isArray(card._rawPricesArchive)) continue;

    card.prices = canonical;
    card.yuyuName = nextYuyuName;
    card._rawPricesArchive = archive;
    touched += 1;

    if (canonical.some((p) => hasErrataLabel(p.name)) || hasErrataLabel(nextYuyuName)) {
      stillDirty += 1;
    }
  }

  fs.writeFileSync(DB_PATH, `${JSON.stringify(db, null, 2)}\n`, 'utf-8');
  console.log(
    `[canonicalize-database] Rewrote ${touched} cards (${stillDirty} still carry errata after collapse — should be 0).`
  );
  if (stillDirty > 0) process.exit(1);
}

main();
