#!/usr/bin/env node
/**
 * QA DIC-916 regression: a REAL `expo export --platform android` artifact must
 * fail closed.
 *
 * The in-app mapping filter and the web post-build sanitizer (fix-html.js) both
 * live on paths that a native export NEVER runs: `expo export --platform android`
 * copies `public/` verbatim into the bundle with no post-hook. So the fail-closed
 * guarantee has to live in the committed asset itself — `public/data/database.json`
 * is shipped sanitized at rest. QA flagged that the earlier field-strip test only
 * exercised the web copy path and so falsely passed while the native bundle still
 * leaked buyPrice / buyPriceHistory / priceHistory / ytStats.
 *
 * This test runs the actual Expo exporter and audits the produced data asset. It
 * also asserts the at-rest committed public asset is sanitized, because that single
 * file is what EVERY native build ships regardless of EXPO_PUBLIC_STORE_MVP —
 * unset, unknown, malformed, or explicit — so native is fail-closed by construction.
 *
 * Run: node scripts/test-store-mvp-native-export.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORBIDDEN_CARD_FIELDS, sanitizeDatabase } from './lib/store-mvp-sanitize.mjs';
import { buildNativeDatabaseString } from './generate-native-database.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

/** Count forbidden card fields (and nested prices[].buyPrice) across a DB. */
function auditDatabase(db) {
  const counts = Object.fromEntries(FORBIDDEN_CARD_FIELDS.map((f) => [f, 0]));
  let nestedBuyPrice = 0;
  let sellPriceKept = 0;
  let total = 0;
  for (const entry of Object.values(db.cards ?? {})) {
    total++;
    for (const field of FORBIDDEN_CARD_FIELDS) if (field in entry) counts[field]++;
    if (Array.isArray(entry.prices) && entry.prices.some((p) => p && typeof p === 'object' && 'buyPrice' in p)) {
      nestedBuyPrice++;
    }
    if ('sellPrice' in entry) sellPriceKept++;
  }
  return { counts, nestedBuyPrice, sellPriceKept, total };
}

// ── 1. The at-rest committed native asset is what every native build ships ──
// (expo copies public/ verbatim). It must be sanitized regardless of env, so a
// Store MVP native build with EXPO_PUBLIC_STORE_MVP unset/unknown/malformed/explicit
// is fail-closed by construction — no env branch can reopen it.
const publicAsset = path.join(repoRoot, 'public', 'data', 'database.json');
assert.ok(fs.existsSync(publicAsset), 'public/data/database.json (native bundled asset) must exist');
const committedBytes = fs.readFileSync(publicAsset, 'utf-8');
const restDb = JSON.parse(committedBytes);
const rest = auditDatabase(restDb);
assert.ok(rest.total > 0, 'committed native asset contains cards');
for (const field of FORBIDDEN_CARD_FIELDS) {
  assert.equal(rest.counts[field], 0, `committed public/data/database.json must not retain ${field}`);
}
assert.equal(rest.nestedBuyPrice, 0, 'committed native asset must not retain prices[].buyPrice');
assert.equal(rest.sellPriceKept, rest.total, 'committed native asset preserves retail sellPrice on every card');
console.log(`At-rest native asset: ${rest.total} cards, 0 forbidden fields, ${rest.sellPriceKept} retain sellPrice.`);

// ── 1b. Native asset must be EXACTLY sanitizeDatabase(data/database.json) ──
// The stale-snapshot failure (CR DIC-913): a drifted public copy stripped forbidden
// fields yet silently lost 831 prices[] variants and turned 387 real sellPrice into
// null. Pin the committed bytes to the deterministic generator output, then prove
// per-card that every retail sellPrice value and the COMPLETE prices[] array survive
// canonical → native minus only the forbidden fields.
assert.equal(
  committedBytes,
  buildNativeDatabaseString(),
  'public/data/database.json must byte-equal sanitizeDatabase(data/database.json) — regenerate via scripts/generate-native-database.mjs',
);

const canonical = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'database.json'), 'utf-8'));
const expectedNative = sanitizeDatabase(canonical);
const canonicalKeys = Object.keys(canonical.cards ?? {});
const nativeKeys = Object.keys(restDb.cards ?? {});
assert.deepEqual(nativeKeys, canonicalKeys, 'native asset must carry the exact canonical card set (no dropped/added cards)');
for (const key of canonicalKeys) {
  const expected = expectedNative.cards[key];
  const actual = restDb.cards[key];
  // Whole-entry deep equality already covers everything, but assert the retail
  // fields explicitly so a regression names the exact lost data.
  assert.deepEqual(actual, expected, `native card ${key} must equal canonical-minus-forbidden`);
  assert.equal(actual.sellPrice, canonical.cards[key].sellPrice, `native card ${key} keeps canonical top-level sellPrice`);
  const canonPrices = canonical.cards[key].prices;
  if (Array.isArray(canonPrices)) {
    assert.ok(Array.isArray(actual.prices), `native card ${key} keeps prices[] array`);
    assert.equal(actual.prices.length, canonPrices.length, `native card ${key} keeps every canonical prices[] variant`);
    for (let i = 0; i < canonPrices.length; i++) {
      assert.equal(actual.prices[i].name, canonPrices[i].name, `native card ${key} prices[${i}] keeps variant name`);
      assert.equal(actual.prices[i].sellPrice, canonPrices[i].sellPrice, `native card ${key} prices[${i}] keeps variant sellPrice`);
    }
  }
}
console.log(`Native asset deep-equals sanitizeDatabase(data/database.json) across ${canonicalKeys.length} cards (full prices[] + sellPrice preserved).`);

// ── 2. A REAL expo export --platform android artifact must be fail-closed ──
// Reproduces the exact QA command: env unset → native resolves Store MVP ON, and
// the exported data asset must contain zero forbidden fields while keeping sellPrice.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-mvp-android-'));
try {
  const env = { ...process.env };
  delete env.EXPO_PUBLIC_STORE_MVP; // native unset → fail-closed Store MVP
  console.log('Running real: expo export --platform android (EXPO_PUBLIC_STORE_MVP unset) …');
  execFileSync(
    'npx',
    ['expo', 'export', '--platform', 'android', '--output-dir', tmpDir],
    { cwd: repoRoot, env, stdio: 'pipe' },
  );

  const exportedDb = path.join(tmpDir, 'data', 'database.json');
  assert.ok(fs.existsSync(exportedDb), 'android export must produce data/database.json');
  const audited = auditDatabase(JSON.parse(fs.readFileSync(exportedDb, 'utf-8')));
  assert.ok(audited.total > 0, 'android export artifact contains cards to inspect');
  for (const field of FORBIDDEN_CARD_FIELDS) {
    assert.equal(audited.counts[field], 0, `android export artifact must not retain ${field}`);
  }
  assert.equal(audited.nestedBuyPrice, 0, 'android export artifact must not retain prices[].buyPrice');
  assert.equal(
    audited.sellPriceKept,
    audited.total,
    'android export artifact preserves retail sellPrice on every card',
  );
  console.log(
    `Real android export: ${audited.total} cards, 0 forbidden fields, ${audited.sellPriceKept} retain sellPrice.`,
  );
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('Store MVP native-export regression checks passed');
