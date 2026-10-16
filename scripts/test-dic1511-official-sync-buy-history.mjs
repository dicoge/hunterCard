#!/usr/bin/env node
/**
 * DIC-1511 regression: the scheduled Official Catalog Sync must keep each exact
 * printing's cumulative `buyPriceHistory`, not just the daily from-scratch
 * build-database.js rebuild that #239 fixed (DIC-1167 CR 2660774f).
 *
 * On PR #212 b2f7a0d the sync rebuilt every official row from `toDatabaseCard`
 * (no buyPriceHistory) and regen-buy-alignment then re-seeded only the snapshot
 * date: 1,279 observations on 651 printings were lost vs main (e.g.
 * hBP01-024_hBP07_HR kept only 2026-10-03; hBP09-105_hBP09_U lost 2026-09-27).
 * The same rebuild also blanked `localImage` on 3,105 rows that
 * build-database.js Step 2 derives from data/images/<cardNumber>.jpg.
 *
 * Layers:
 *   1. Fixture: syncOfficialCatalogToDatabase carries every dated observation
 *      per exact printing id, never leaks it onto a sibling printing of the
 *      same cardNumber, never restores the stale scalar buyPrice claim, keeps a
 *      delisted printing's history, refreshes official-catalog freshness, and
 *      derives localImage with build-database.js's file-existence rule.
 *   2. Mutation sensitivity: the pre-fix sync (no carry-over / hardcoded
 *      localImage) is run from a sandbox copy and must fail layer 1.
 *   3. E2E: the real sync CLI + regen-buy-alignment.mjs over a sandbox copy of
 *      the committed data keep an older date AND add the snapshot date, lose
 *      zero observations for any surviving printing, and drift zero localImage.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { printingId } from './lib/printing-identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SYNC_REL = 'scripts/sync-official-catalog-to-database.mjs';

// ─── 1. Fixture ──────────────────────────────────────────────────────────
const official = (cardNumber, sourceProduct, rarity, suffix, name) => ({
  cardNumber,
  name,
  cardType: 'ホロメン',
  color: 'white',
  rarity,
  expansion: sourceProduct,
  sourceProduct,
  sourceProductName: sourceProduct,
  imageUrl: `https://hololive-official-cardgame.com/wp-content/images/cardlist/${sourceProduct}/${suffix}.png`,
});
const HR = official('hBP01-024', 'hBP07', 'HR', 'hBP01-024_HR', 'ベスティア・ゼータ');
const C = official('hBP01-024', 'hBP07', 'C', 'hBP01-024_02_C', 'ベスティア・ゼータ');
const U = official('hBP09-105', 'hBP09', 'U', 'hBP09-105_U', 'かなたそ');
const HR_ID = printingId(HR);
const C_ID = printingId(C);
const U_ID = printingId(U);
const PREVIOUS_LAST_UPDATED = '2026-10-03T12:08:30.745Z';

function writeFixture(dir) {
  const officialDir = path.join(dir, 'official');
  const imagesDir = path.join(dir, 'images');
  fs.mkdirSync(officialDir, { recursive: true });
  fs.mkdirSync(imagesDir, { recursive: true });
  fs.writeFileSync(path.join(imagesDir, 'hBP01-024.jpg'), '');
  const json = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  json(path.join(dir, 'character-names-zh.json'), { 'ベスティア・ゼータ': '貝絲緹亞·澤塔', 'かなたそ': '天音彼方' });
  json(path.join(dir, 'effects-jp.json'), {});
  json(path.join(dir, 'effects-zh.json'), {});
  json(path.join(officialDir, '_meta.json'), {
    seriesStats: [
      { code: 'hBP07', expectedCount: 2, ingestedCount: 2 },
      { code: 'hBP09', expectedCount: 1, ingestedCount: 1 },
    ],
  });
  json(path.join(officialDir, 'hBP07.json'), [HR, C]);
  json(path.join(officialDir, 'hBP09.json'), [U]);
  const row = (card, extra) => ({
    id: printingId(card),
    cardNumber: card.cardNumber,
    name: card.name,
    rarity: card.rarity,
    series: card.sourceProduct,
    sourceProduct: card.sourceProduct,
    sellPrice: null,
    prices: [],
    officialImage: card.imageUrl,
    localImage: '',
    nameZh: 'x',
    ...extra,
  });
  json(path.join(dir, 'database.json'), {
    lastUpdated: PREVIOUS_LAST_UPDATED,
    totalCards: 3,
    cards: {
      [HR_ID]: row(HR, {
        buyPrice: 1600,
        buyPriceHistory: { '2026-09-27': 1600, '2026-10-02': 1600, '2026-10-03': 1600 },
      }),
      [C_ID]: row(C, {}),
      [U_ID]: row(U, { buyPriceHistory: { '2026-09-27': 5 } }),
    },
  });
}

async function runFixture(modulePath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dic1511-sync-fixture-'));
  try {
    writeFixture(dir);
    const { syncOfficialCatalogToDatabase } = await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);
    const result = syncOfficialCatalogToDatabase({
      databasePath: path.join(dir, 'database.json'),
      officialDirectory: path.join(dir, 'official'),
      translationPath: path.join(dir, 'character-names-zh.json'),
      effectsJpPath: path.join(dir, 'effects-jp.json'),
      effectsZhPath: path.join(dir, 'effects-zh.json'),
    });
    const db = JSON.parse(fs.readFileSync(path.join(dir, 'database.json'), 'utf8'));
    const cards = db.cards;
    assert.equal(result.upserted, 3, 'every official printing is upserted');
    assert.ok(db.lastUpdated > PREVIOUS_LAST_UPDATED, 'official catalog freshness: lastUpdated advances');
    assert.deepEqual(
      cards[HR_ID].buyPriceHistory,
      { '2026-09-27': 1600, '2026-10-02': 1600, '2026-10-03': 1600 },
      `${HR_ID}: every dated observation survives the sync`,
    );
    assert.equal(cards[HR_ID].buyPrice, undefined, `${HR_ID}: stale scalar buyPrice claim is not restored (regen re-derives it)`);
    assert.equal(cards[C_ID].buyPriceHistory, undefined, `${C_ID}: sibling printing never inherits another printing's history`);
    assert.deepEqual(cards[U_ID].buyPriceHistory, { '2026-09-27': 5 }, `${U_ID}: unlisted printing keeps its history`);
    assert.deepEqual(result.buyPriceHistory, { cards: 2, observations: 4, skippedIdentityMismatch: 0 });
    assert.equal(cards[HR_ID].localImage, '/images/hBP01-024.jpg', 'localImage follows build-database.js file-existence rule');
    assert.equal(cards[C_ID].localImage, '/images/hBP01-024.jpg', 'localImage is keyed by cardNumber like build-database.js');
    assert.equal(cards[U_ID].localImage, '', 'no image file → empty localImage');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

await runFixture(path.join(REPO_ROOT, SYNC_REL));
console.log('  ✓ fixture: exact-printing history carried, no sibling leak, claims not restored, freshness advances, localImage rule');

// ─── 2. Mutation sensitivity ─────────────────────────────────────────────
{
  const source = fs.readFileSync(path.join(REPO_ROOT, SYNC_REL), 'utf8');
  const mutate = (from, to) => {
    assert.ok(source.includes(from), `mutation anchor missing: ${from}`);
    return source.replace(from, to);
  };
  const mutations = {
    'no buyPriceHistory carry-over (the b2f7a0d regression)': mutate(
      'restoreBuyPriceHistory(db.cards, previousCards)',
      '({ cards: 0, observations: 0, skippedIdentityMismatch: 0 })',
    ),
    'hardcoded empty localImage (pre-fix churn)': mutate(
      'localImage: localImageFor(card.cardNumber, imagesDirectory),',
      "localImage: '',",
    ),
  };
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dic1511-sync-mutation-'));
  try {
    fs.cpSync(path.join(REPO_ROOT, 'scripts'), path.join(sandbox, 'scripts'), { recursive: true });
    fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(sandbox, 'node_modules'));
    fs.symlinkSync(path.join(REPO_ROOT, 'package.json'), path.join(sandbox, 'package.json'));
    let i = 0;
    for (const [name, mutated] of Object.entries(mutations)) {
      const file = path.join(sandbox, 'scripts', `sync-mutant-${i++}.mjs`);
      fs.writeFileSync(file, mutated);
      await assert.rejects(runFixture(file), assert.AssertionError, `mutation "${name}" must be caught`);
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
  console.log(`  ✓ mutation sensitivity: ${Object.keys(mutations).length}/${Object.keys(mutations).length} mutations killed`);
}

// ─── 3. E2E: real sync CLI → regen-buy-alignment.mjs on committed data ───
{
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dic1511-sync-e2e-'));
  try {
    fs.cpSync(path.join(REPO_ROOT, 'scripts'), path.join(sandbox, 'scripts'), { recursive: true });
    fs.cpSync(path.join(REPO_ROOT, 'data'), path.join(sandbox, 'data'), { recursive: true });
    fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(sandbox, 'node_modules'));
    fs.symlinkSync(path.join(REPO_ROOT, 'package.json'), path.join(sandbox, 'package.json'));

    const dbPath = path.join(sandbox, 'data/database.json');
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const meta = JSON.parse(fs.readFileSync(path.join(sandbox, 'data/official/_meta.json'), 'utf8'));
    const products = new Set((meta.seriesStats || meta.series || []).map((e) => (typeof e === 'string' ? e : e?.code)));
    const isOfficial = (c) => products.has(c.sourceProduct || c.series || '');
    const OLD = '2000-01-01';
    const listedId = Object.keys(db.cards).find((id) => isOfficial(db.cards[id]) && db.cards[id].buyPrice != null);
    const delistedId = Object.keys(db.cards).find((id) => isOfficial(db.cards[id]) && db.cards[id].buyPrice == null && db.cards[id].rarity);
    assert.ok(listedId && delistedId, 'committed data must contain a listed and an unlisted official printing');
    db.cards[listedId].buyPriceHistory = { [OLD]: 111, ...(db.cards[listedId].buyPriceHistory || {}) };
    db.cards[delistedId].buyPriceHistory = { [OLD]: 222 };
    fs.writeFileSync(dbPath, `${JSON.stringify(db, null, 2)}\n`);
    const before = db.cards;

    const sync = spawnSync(process.execPath, [SYNC_REL], { cwd: sandbox, encoding: 'utf8', timeout: 240000 });
    assert.equal(sync.status, 0, `sync failed:\n${(sync.stderr || '').slice(-1500)}`);
    assert.match(sync.stdout, /\[buyPriceHistory\] Carried [1-9]\d* observations/, 'sync must log the carry-over');

    const synced = JSON.parse(fs.readFileSync(dbPath, 'utf8')).cards;
    let observations = 0;
    let lost = 0;
    let localImageDrift = 0;
    for (const [id, prev] of Object.entries(before)) {
      const next = synced[id];
      if (!next) continue;
      for (const [date, value] of Object.entries(prev.buyPriceHistory || {})) {
        observations += 1;
        if (next.buyPriceHistory?.[date] !== value) lost += 1;
      }
      if ((prev.localImage || '') !== (next.localImage || '')) localImageDrift += 1;
    }
    assert.ok(observations > 2, 'committed data carries buyPriceHistory observations');
    assert.equal(lost, 0, `sync must not lose any of ${observations} dated observations`);
    assert.equal(localImageDrift, 0, 'sync must not drift localImage away from build-database.js output');

    const regen = spawnSync(process.execPath, ['scripts/regen-buy-alignment.mjs'], { cwd: sandbox, encoding: 'utf8', timeout: 120000 });
    assert.equal(regen.status, 0, `regen-buy-alignment.mjs failed:\n${(regen.stderr || '').slice(-1500)}`);
    const snapshot = regen.stdout.match(/快照日期 (\d{4}-\d{2}-\d{2})/)?.[1];
    assert.ok(snapshot, 'regen must report its snapshot date');
    const merged = JSON.parse(fs.readFileSync(dbPath, 'utf8')).cards;
    assert.equal(merged[listedId].buyPriceHistory?.[OLD], 111, `${listedId}: older date survives sync + buy merge`);
    assert.ok(merged[listedId].buyPrice != null, `${listedId}: current buyPrice re-attached by the merge`);
    assert.equal(merged[listedId].buyPriceHistory?.[snapshot], merged[listedId].buyPrice, `${listedId}: snapshot date present`);
    assert.equal(merged[delistedId].buyPrice ?? null, null, `${delistedId}: unlisted printing has null buyPrice`);
    assert.equal(merged[delistedId].buyPriceHistory?.[OLD], 222, `${delistedId}: unlisted printing keeps history`);
    console.log(`  ✓ e2e: sync kept all ${observations} observations, 0 localImage drift; buy merge keeps ${OLD} + ${snapshot} (${listedId}); unlisted ${delistedId} keeps history`);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

console.log('DIC-1511 official-sync buyPriceHistory preservation OK');
