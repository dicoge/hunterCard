#!/usr/bin/env node
// One-shot patcher: reads data/bloom-levels.json and writes bloomLevel onto
// every matching card in data/database.json. Used to publish the field
// immediately without waiting for the next scheduled build (DIC-1141). The
// scheduled build applies the same merge via loadBloomLevelOverlay() in
// scripts/build-database.js, so re-running this on a fresh build is a no-op.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const DB_FILE = path.join(REPO, 'data', 'database.json');
const OVERLAY_FILE = path.join(REPO, 'data', 'bloom-levels.json');

const overlay = JSON.parse(fs.readFileSync(OVERLAY_FILE, 'utf8'))?.byCardNumber || {};
const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

let touched = 0;
let already = 0;
let overrode = 0;
for (const info of Object.values(db.cards)) {
  const canonical = overlay[info.cardNumber];
  if (!canonical) continue;
  if (info.bloomLevel === canonical) {
    already++;
    continue;
  }
  if (info.bloomLevel && info.bloomLevel !== canonical) {
    overrode++;
  } else {
    touched++;
  }
  info.bloomLevel = canonical;
}

fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
console.log(`[patch] wrote ${DB_FILE}`);
console.log(`[patch] added=${touched}, already=${already}, overrode=${overrode}, overlay=${Object.keys(overlay).length}`);
