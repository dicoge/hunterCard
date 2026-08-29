#!/usr/bin/env node
// test-dic1229-history-provenance.mjs — mutation-sensitive regression for
// the DIC-1229 unproven-printing priceHistory contamination Mac-Codex CR
// flagged on main d5e49c73:
//   `hBP01-090_hPR_P_hBP01-090_P_02` shipped Production with
//   `sellPrice:null`, `prices:[]`, `yuyuImage:""` yet
//   `priceHistory={"2026-08-28":30}` from a poisoned durable record
//   whose stamp `sourceProduct:"hPR"` alone passed the DIC-1219 record
//   filter.
//
// Contract locked in below (matches
// `preserve-market-fields.js::hasCurrentPriceProvenance` plus the Step 6
// and hard-fail audit paths added to `scripts/build-database.js`):
//   1. `hasCurrentPriceProvenance(card)` returns true only when the row
//      carries a proven exact-print listing (positive sellPrice OR at
//      least one positive prices[] entry). Stamps alone do not qualify.
//   2. `scripts/build-database.js` Step 6 skips the priceHistory merge
//      for rows that fail (1) — durable records never surface as
//      user-visible history.
//   3. `scripts/build-database.js` post-Step-6 audit throws if any row
//      ships priceHistory without current provenance. The daily
//      scheduler thus exits non-zero on a violation.
//   4. Double-rebuild proof: running build-database twice against a DB
//      that starts with the exact contamination shape can never
//      re-materialise it.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hasCurrentPriceProvenance } from './lib/preserve-market-fields.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ---- unit: hasCurrentPriceProvenance ---------------------------------------
assert.equal(hasCurrentPriceProvenance(null), false);
assert.equal(hasCurrentPriceProvenance(undefined), false);
assert.equal(hasCurrentPriceProvenance({}), false, 'empty card is unproven');
assert.equal(hasCurrentPriceProvenance({ sellPrice: null, prices: [] }), false);
assert.equal(hasCurrentPriceProvenance({ sellPrice: 0, prices: [] }), false, 'sellPrice=0 is unproven');
assert.equal(hasCurrentPriceProvenance({ sellPrice: null, prices: [{ sellPrice: 0 }] }), false, 'prices entries with sellPrice=0 are unproven');
assert.equal(hasCurrentPriceProvenance({ sellPrice: 180, prices: [] }), true, 'positive sellPrice qualifies');
assert.equal(hasCurrentPriceProvenance({ sellPrice: null, prices: [{ sellPrice: 980 }] }), true, 'positive prices[] entry qualifies');
assert.equal(hasCurrentPriceProvenance({ sellPrice: null, prices: [{ sellPrice: null }, { sellPrice: 500 }] }), true, 'any positive entry qualifies');
// The exact Mac-Codex-flagged shape must be unproven.
assert.equal(
  hasCurrentPriceProvenance({ sellPrice: null, prices: [], yuyuImage: '', priceHistory: { '2026-08-28': 30 } }),
  false,
  'the hBP01-090_02 shape (null sell, empty prices) is unproven even when priceHistory carries a value',
);

// ---- source-inspection: scripts/build-database.js production wire ----------
{
  const builderPath = path.join(REPO_ROOT, 'scripts/build-database.js');
  const src = fs.readFileSync(builderPath, 'utf8');

  // 1. The helper must be imported.
  assert.match(
    src,
    /import\s*{[^}]*\bhasCurrentPriceProvenance\b[^}]*}\s*from\s*['"]\.\/lib\/preserve-market-fields\.js['"]/,
    'scripts/build-database.js must import hasCurrentPriceProvenance',
  );

  // 2. Step 6 loop must gate the merge on hasCurrentPriceProvenance and
  //    skip (`continue`) unproven rows.
  const step6Idx = src.indexOf('── Step 6: Merge priceHistory');
  assert.ok(step6Idx > -1, 'Step 6 header must still exist');
  // Locate the Step 6 for-loop body up to the next section header. We look
  // for the guard pattern within that slice.
  const step6Slice = src.slice(step6Idx);
  assert.match(
    step6Slice,
    /if\s*\(\s*!\s*hasCurrentPriceProvenance\s*\(\s*card\s*\)\s*\)/,
    'Step 6 must contain `if (!hasCurrentPriceProvenance(card))` gate before merging records',
  );
  assert.match(
    step6Slice,
    /!\s*hasCurrentPriceProvenance\s*\(\s*card\s*\)[^}]*continue/,
    'the gate must `continue` (skip merge) for unproven rows',
  );

  // 3. Post-Step-6 hard-fail audit must exist. It throws if any row has
  //    priceHistory without provenance.
  const auditRe = /\[DIC-1229\][^`]*unproven printing/;
  assert.match(
    src,
    auditRe,
    'scripts/build-database.js must contain the DIC-1229 hard-fail audit that throws on unproven-with-history',
  );
  // The throw must fire when `hasCurrentPriceProvenance` is false and
  // priceHistory has entries — bind the audit's guard, not just the
  // string, so a refactor that removes the check fails here.
  const auditSliceStart = src.indexOf('DIC-1229 hard-fail audit');
  assert.ok(auditSliceStart > -1, 'audit comment must be present');
  const auditSlice = src.slice(auditSliceStart, auditSliceStart + 2000);
  assert.match(auditSlice, /!\s*hasCurrentPriceProvenance\s*\(\s*card\s*\)/, 'audit must call hasCurrentPriceProvenance(card)');
  assert.match(auditSlice, /throw\s+new\s+Error/, 'audit must throw on violation');
}

// ---- end-to-end: real subprocess build under HUNTERCARD_YUYU_FIXTURE_PATH --
// Reproduce the exact Mac-Codex-flagged shape end-to-end: seed the durable
// file with the poisoned single-record stamp, hand the builder a yuyu
// fixture that provides no listings, and assert the post-Step-6 audit runs
// (either the row ships clean OR the build hard-fails). Then run the
// builder a SECOND time to prove the contamination cannot reappear on a
// subsequent rebuild.
{
  const CANONICAL_ID = 'hBP01-090_hPR_P_hBP01-090_P_02';
  const dbPath = path.join(REPO_ROOT, 'data/database.json');
  const nativePath = path.join(REPO_ROOT, 'public/data/database.json');
  const historyDir = path.join(REPO_ROOT, 'data/price-history');
  const scrapeLogPath = path.join(REPO_ROOT, 'data/scrape-log.txt');
  const canonicalHistoryFile = path.join(historyDir, `${CANONICAL_ID.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);

  // Preflight: the row must exist in the shipped DB and it must currently
  // fail the provenance gate — that's the exact shape the CR flagged.
  const currentDb = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const preRow = currentDb.cards?.[CANONICAL_ID];
  assert.ok(preRow, `E2E preflight: ${CANONICAL_ID} must exist in shipped data/database.json`);
  assert.equal(hasCurrentPriceProvenance(preRow), false, 'E2E preflight: the flagged row must be unproven going in');

  // Snapshot everything we touch so the test leaves no trace.
  const originalDb = fs.readFileSync(dbPath, 'utf8');
  const originalNative = fs.readFileSync(nativePath, 'utf8');
  const originalScrapeLog = fs.existsSync(scrapeLogPath) ? fs.readFileSync(scrapeLogPath, 'utf8') : null;
  const historySnapshot = new Map();
  for (const file of fs.readdirSync(historyDir)) {
    if (!file.endsWith('.json')) continue;
    historySnapshot.set(file, fs.readFileSync(path.join(historyDir, file), 'utf8'));
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dic1229-e2e-'));
  try {
    // Yuyu fixture returns no cards → build path exercises the DIC-1229
    // Step 6 gate + audit under the exact "no current provenance" shape.
    const fixtureFile = path.join(tmp, 'yuyu-fixture.json');
    fs.writeFileSync(
      fixtureFile,
      JSON.stringify({ prices: {}, totalCards: 0, seriesWithPrices: 0, pricingUnavailable: true }),
    );

    // Seed the durable file with the exact poisoned single-record shape
    // Mac-Codex flagged. The runtime Step 6 must NOT surface this record.
    fs.writeFileSync(canonicalHistoryFile, JSON.stringify({
      cardId: CANONICAL_ID,
      cardNumber: 'hBP01-090',
      name: 'ムーナ・ホシノヴァ',
      records: [{
        date: '2026-08-28',
        price: 30,
        source: 'yuyu-tei',
        currency: 'JPY',
        cardId: CANONICAL_ID,
        sourceProduct: 'hPR',
      }],
      lastUpdated: '2026-08-28T13:10:25.361Z',
      nameZh: '姆娜·霍希諾瓦',
    }, null, 2));

    // ─── Rebuild 1 ────────────────────────────────────────────────────────
    let result = spawnSync(process.execPath, ['scripts/build-database.js'], {
      cwd: REPO_ROOT,
      env: { ...process.env, HUNTERCARD_YUYU_FIXTURE_PATH: fixtureFile },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 240000,
    });
    // Two acceptable outcomes: (a) build succeeds and the row is clean, or
    // (b) build fails-closed with the DIC-1229 audit message. Both prove
    // the runtime enforcement is wired.
    let written = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    let row = written.cards?.[CANONICAL_ID];
    if (result.status !== 0) {
      const stderr = result.stderr?.toString() || '';
      assert.match(stderr, /DIC-1229/, `build failed but not on DIC-1229 audit — stderr:\n${stderr.slice(-2000)}`);
    } else {
      assert.ok(row, `${CANONICAL_ID} must survive the rebuild`);
      const phSize1 = row.priceHistory ? Object.keys(row.priceHistory).length : 0;
      assert.equal(
        phSize1,
        0,
        `Rebuild 1: ${CANONICAL_ID} must NOT ship priceHistory (row is unproven; got ${JSON.stringify(row.priceHistory)})`,
      );
      assert.ok(
        row.sellPrice == null || row.sellPrice === 0,
        `Rebuild 1: ${CANONICAL_ID} sellPrice must stay unset (unproven; got ${row.sellPrice})`,
      );
      const pricesLen1 = Array.isArray(row.prices) ? row.prices.length : 0;
      assert.equal(pricesLen1, 0, `Rebuild 1: ${CANONICAL_ID} prices[] must stay empty (unproven; got ${JSON.stringify(row.prices)})`);
    }

    // ─── Rebuild 2 (contamination-cannot-reappear proof) ─────────────────
    // Seed the poisoned record AGAIN — this is the exact adversarial
    // scenario Mac-Codex specified: "run a second rebuild to prove
    // contamination cannot reappear".
    fs.writeFileSync(canonicalHistoryFile, JSON.stringify({
      cardId: CANONICAL_ID,
      cardNumber: 'hBP01-090',
      name: 'ムーナ・ホシノヴァ',
      records: [{
        date: '2026-08-28',
        price: 30,
        source: 'yuyu-tei',
        currency: 'JPY',
        cardId: CANONICAL_ID,
        sourceProduct: 'hPR',
      }],
      lastUpdated: '2026-08-28T13:10:25.361Z',
      nameZh: '姆娜·霍希諾瓦',
    }, null, 2));

    result = spawnSync(process.execPath, ['scripts/build-database.js'], {
      cwd: REPO_ROOT,
      env: { ...process.env, HUNTERCARD_YUYU_FIXTURE_PATH: fixtureFile },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 240000,
    });
    written = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    row = written.cards?.[CANONICAL_ID];
    if (result.status !== 0) {
      const stderr = result.stderr?.toString() || '';
      assert.match(stderr, /DIC-1229/, `Rebuild 2 failed but not on DIC-1229 audit — stderr:\n${stderr.slice(-2000)}`);
    } else {
      assert.ok(row, `${CANONICAL_ID} must survive Rebuild 2`);
      const phSize2 = row.priceHistory ? Object.keys(row.priceHistory).length : 0;
      assert.equal(
        phSize2,
        0,
        `Rebuild 2: ${CANONICAL_ID} must STILL not ship priceHistory after a re-poisoning attempt (got ${JSON.stringify(row.priceHistory)})`,
      );
    }
  } finally {
    // Restore every file we touched.
    fs.writeFileSync(dbPath, originalDb);
    fs.writeFileSync(nativePath, originalNative);
    if (originalScrapeLog === null) {
      if (fs.existsSync(scrapeLogPath)) fs.unlinkSync(scrapeLogPath);
    } else {
      fs.writeFileSync(scrapeLogPath, originalScrapeLog);
    }
    const currentFiles = new Set(fs.readdirSync(historyDir).filter((f) => f.endsWith('.json')));
    for (const file of currentFiles) {
      if (!historySnapshot.has(file)) {
        fs.unlinkSync(path.join(historyDir, file));
      }
    }
    for (const [file, contents] of historySnapshot.entries()) {
      fs.writeFileSync(path.join(historyDir, file), contents);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('DIC-1229 history-provenance regression checks passed');
