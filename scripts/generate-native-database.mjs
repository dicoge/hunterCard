#!/usr/bin/env node
/**
 * generate-native-database.mjs — regenerate the native-bundled data asset
 * (DIC-916 / CR DIC-913).
 *
 * `public/data/database.json` is the ONLY database a native export ships: expo
 * copies public/ verbatim into the Android/iOS bundle with no post-hook, so this
 * committed file must already be fail-closed AND carry the full canonical retail
 * data. It is produced deterministically here as exactly
 * `sanitizeDatabase(data/database.json)` — the canonical DB with only the
 * forbidden advanced fields removed. Any hand-edited or stale public copy loses
 * retail sellPrice / prices[] variants (CR flagged 831 missing variants + 387
 * spurious null sellPrice from a drifted snapshot), so this generator is the
 * single source of truth and the regression pins the committed file to its output.
 *
 * Run: node scripts/generate-native-database.mjs   (writes public/data/database.json)
 * Verify only (no write): pass --check to diff without touching the file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeDatabase } from './lib/store-mvp-sanitize.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const CANONICAL = path.join(repoRoot, 'data', 'database.json');
const NATIVE = path.join(repoRoot, 'public', 'data', 'database.json');

/** The exact bytes the committed native asset must contain. */
export function buildNativeDatabaseString() {
  const canonical = JSON.parse(fs.readFileSync(CANONICAL, 'utf-8'));
  return JSON.stringify(sanitizeDatabase(canonical));
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const expected = buildNativeDatabaseString();
  if (checkOnly) {
    const actual = fs.existsSync(NATIVE) ? fs.readFileSync(NATIVE, 'utf-8') : '';
    if (actual !== expected) {
      console.error('✗ public/data/database.json is stale — run: node scripts/generate-native-database.mjs');
      process.exit(1);
    }
    console.log('✓ public/data/database.json matches sanitizeDatabase(data/database.json)');
    return;
  }
  fs.mkdirSync(path.dirname(NATIVE), { recursive: true });
  fs.writeFileSync(NATIVE, expected, 'utf-8');
  console.log(`✓ wrote public/data/database.json (${expected.length} bytes) from sanitizeDatabase(data/database.json)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
