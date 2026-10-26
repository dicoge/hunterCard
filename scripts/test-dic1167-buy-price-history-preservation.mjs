#!/usr/bin/env node
/**
 * DIC-1167 CR 2660774f regression: `buyPriceHistory` is a cumulative series and
 * must survive the daily from-scratch rebuild. On ecb30bd59 build-database.js
 * dropped it (240416acb stopped restoring stale buy *claims* and took the
 * history with them), so merge-buy-prices.js started a fresh `{}` and every
 * printing's 2026-09-27 observation was replaced by 2026-10-03 (757 lost).
 *
 * Layers:
 *   1. Unit: restoreBuyPriceHistory carries history by exact id only, never
 *      restores the scalar / per-variant buy claims, lets current dates win,
 *      drops malformed records, and refuses identity mismatches.
 *   2. Mutation sensitivity: each inverted behaviour flips an assertion.
 *   3. E2E: the real build-database.js + regen-buy-alignment.mjs in a sandbox
 *      copy keep the older date AND add the snapshot date per exact printing;
 *      a printing with no current listing keeps its history with null buyPrice.
 *   4. Committed artifact: the CR's example printings carry both dates.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { restoreBuyPriceHistory, sanitizeBuyPriceHistory } from './lib/preserve-market-fields.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ─── 1. Unit ─────────────────────────────────────────────────────────────
function fixtures() {
  const prevCards = {
    'hBP01-024_hBP07_HR_hBP01-024_HR': {
      cardNumber: 'hBP01-024', rarity: 'HR', buyPrice: 1600,
      buyPriceHistory: { '2026-09-27': 1600 },
      prices: [{ name: 'x', buyPrice: 1600, buyPriceVersion: 'HR' }],
    },
    'hBP09-105_hBP09_U_hBP09-105_U': {
      cardNumber: 'hBP09-105', rarity: 'U', buyPrice: 5,
      buyPriceHistory: { '2026-09-27': 5, bogus: 7, '2026-09-28': -1, '2026-09-29': '9' },
    },
    'hBP02-001_hBP02_C_hBP02-001_C': {
      cardNumber: 'hBP02-001', rarity: 'C', buyPriceHistory: { '2026-09-27': 30 },
    },
    'gone_id': { cardNumber: 'hBP03-001', rarity: 'C', buyPriceHistory: { '2026-09-27': 1 } },
  };
  const cards = {
    'hBP01-024_hBP07_HR_hBP01-024_HR': {
      cardNumber: 'hBP01-024', rarity: 'HR', prices: [{ name: 'x' }],
      buyPriceHistory: { '2026-10-03': 1650 },
    },
    'hBP09-105_hBP09_U_hBP09-105_U': { cardNumber: 'hBP09-105', rarity: 'U' },
    // Same id, different printing identity → must refuse.
    'hBP02-001_hBP02_C_hBP02-001_C': { cardNumber: 'hBP02-001', rarity: 'SR' },
  };
  return { prevCards, cards };
}

function runUnit(restore = restoreBuyPriceHistory) {
  const { prevCards, cards } = fixtures();
  const summary = restore(cards, prevCards);
  const hr = cards['hBP01-024_hBP07_HR_hBP01-024_HR'];
  assert.deepEqual(hr.buyPriceHistory, { '2026-09-27': 1600, '2026-10-03': 1650 }, 'older date carried, current date wins');
  assert.deepEqual(Object.keys(hr.buyPriceHistory), ['2026-09-27', '2026-10-03'], 'dates sorted');
  assert.equal(hr.buyPrice, undefined, 'scalar buyPrice claim is never restored');
  assert.equal(hr.prices[0].buyPrice, undefined, 'per-variant buyPrice claim is never restored');
  const u = cards['hBP09-105_hBP09_U_hBP09-105_U'];
  assert.deepEqual(u.buyPriceHistory, { '2026-09-27': 5 }, 'delisted printing keeps only well-formed history');
  assert.equal(u.buyPrice, undefined, 'delisted printing has no current buyPrice');
  assert.equal(cards['hBP02-001_hBP02_C_hBP02-001_C'].buyPriceHistory, undefined, 'identity mismatch refuses carry-over');
  assert.equal(cards.gone_id, undefined, 'rows missing from the rebuild are not resurrected');
  assert.deepEqual(summary, { cards: 2, observations: 2, skippedIdentityMismatch: 1 });
}

runUnit();
assert.equal(sanitizeBuyPriceHistory({}), null);
assert.equal(sanitizeBuyPriceHistory([1]), null);
assert.equal(sanitizeBuyPriceHistory(null), null);
console.log('  ✓ unit: exact-id history carry-over, claims not restored, current wins, malformed dropped, mismatch refused');

// ─── 2. Mutation sensitivity ─────────────────────────────────────────────
const mutations = {
  'no-op (the 240416acb regression)': () => ({ cards: 0, observations: 0, skippedIdentityMismatch: 0 }),
  'previous overwrites current date': (cards, prev) => {
    for (const [id, p] of Object.entries(prev)) {
      if (cards[id] && p.buyPriceHistory) cards[id].buyPriceHistory = { ...cards[id].buyPriceHistory, ...p.buyPriceHistory };
    }
    return { cards: 0, observations: 0, skippedIdentityMismatch: 0 };
  },
  'restores scalar buyPrice too': (cards, prev) => {
    const s = restoreBuyPriceHistory(cards, prev);
    for (const [id, p] of Object.entries(prev)) if (cards[id] && p.buyPrice != null) cards[id].buyPrice = p.buyPrice;
    return s;
  },
  'ignores identity': (cards, prev) => {
    for (const c of Object.values(cards)) c.rarity = undefined;
    for (const p of Object.values(prev)) p.rarity = undefined;
    return restoreBuyPriceHistory(cards, prev);
  },
};
for (const [name, mutated] of Object.entries(mutations)) {
  assert.throws(() => runUnit(mutated), assert.AssertionError, `mutation "${name}" must be caught`);
}
console.log(`  ✓ mutation sensitivity: ${Object.keys(mutations).length}/${Object.keys(mutations).length} mutations killed`);

// ─── 3. E2E: real build-database.js → regen-buy-alignment.mjs ────────────
{
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dic1167-buyhist-'));
  try {
    // scripts/ must be a real copy (import.meta.url resolves symlinks back to
    // the repo); data/ is copied so the build cannot dirty the checkout.
    fs.cpSync(path.join(REPO_ROOT, 'scripts'), path.join(sandbox, 'scripts'), { recursive: true });
    fs.cpSync(path.join(REPO_ROOT, 'data'), path.join(sandbox, 'data'), { recursive: true });
    fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(sandbox, 'node_modules'));
    fs.symlinkSync(path.join(REPO_ROOT, 'package.json'), path.join(sandbox, 'package.json'));

    const dbPath = path.join(sandbox, 'data/database.json');
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const OLD = '2000-01-01';
    const listedId = Object.keys(db.cards).find((id) => db.cards[id].buyPrice != null);
    const delistedId = Object.keys(db.cards).find((id) => db.cards[id].buyPrice == null && db.cards[id].cardNumber && db.cards[id].rarity);
    assert.ok(listedId && delistedId, 'artifact must contain a listed and an unlisted printing');
    db.cards[listedId].buyPriceHistory = { [OLD]: 111, ...(db.cards[listedId].buyPriceHistory || {}) };
    db.cards[delistedId].buyPriceHistory = { [OLD]: 222 };
    fs.writeFileSync(dbPath, `${JSON.stringify(db, null, 2)}\n`);

    const fixture = path.join(sandbox, 'yuyu-fixture.json');
    fs.writeFileSync(fixture, JSON.stringify({ prices: {}, totalCards: 0, seriesWithPrices: 0, pricingUnavailable: true }));
    const build = spawnSync(process.execPath, ['scripts/build-database.js'], {
      cwd: sandbox,
      env: { ...process.env, HUNTERCARD_YUYU_FIXTURE_PATH: fixture },
      encoding: 'utf8',
      timeout: 240000,
    });
    assert.equal(build.status, 0, `build-database.js failed:\n${(build.stderr || '').slice(-1500)}`);
    assert.match(build.stdout, /\[buyPriceHistory\] Carried [1-9]\d* observations/, 'build must log the carry-over');

    const built = JSON.parse(fs.readFileSync(dbPath, 'utf8')).cards;
    assert.equal(built[listedId].buyPriceHistory?.[OLD], 111, 'rebuild keeps listed printing history');
    assert.equal(built[listedId].buyPrice, undefined, 'rebuild does not restore the stale buyPrice claim');
    assert.equal(built[delistedId].buyPriceHistory?.[OLD], 222, 'rebuild keeps unlisted printing history');

    const regen = spawnSync(process.execPath, ['scripts/regen-buy-alignment.mjs'], { cwd: sandbox, encoding: 'utf8', timeout: 120000 });
    assert.equal(regen.status, 0, `regen-buy-alignment.mjs failed:\n${(regen.stderr || '').slice(-1500)}`);
    const snapshot = regen.stdout.match(/快照日期 (\d{4}-\d{2}-\d{2})/)?.[1];
    assert.ok(snapshot, 'regen must report its snapshot date');

    const merged = JSON.parse(fs.readFileSync(dbPath, 'utf8')).cards;
    assert.equal(merged[listedId].buyPriceHistory?.[OLD], 111, `${listedId}: older date survives the buy merge`);
    assert.equal(merged[listedId].buyPriceHistory?.[snapshot], merged[listedId].buyPrice, `${listedId}: snapshot date appended`);
    assert.ok(merged[listedId].buyPrice != null, `${listedId}: current buyPrice re-attached by the merge`);
    assert.equal(merged[delistedId].buyPrice ?? null, null, `${delistedId}: unlisted printing has null buyPrice`);
    assert.equal(merged[delistedId].buyPriceHistory?.[OLD], 222, `${delistedId}: unlisted printing keeps history`);
    console.log(`  ✓ e2e: build + buy merge keep ${OLD} and add ${snapshot} (${listedId}); unlisted ${delistedId} keeps history`);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

// ─── 4. Committed artifact ───────────────────────────────────────────────
{
  const cards = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data/database.json'), 'utf8')).cards;
  const hr = cards['hBP01-024_hBP07_HR_hBP01-024_HR'];
  assert.equal(hr?.buyPriceHistory?.['2026-09-27'], 1600, 'hBP01-024 HR keeps 2026-09-27');
  assert.equal(hr?.buyPriceHistory?.['2026-10-03'], 1600, 'hBP01-024 HR keeps 2026-10-03');
  const u = cards['hBP09-105_hBP09_U_hBP09-105_U'];
  assert.equal(u?.buyPriceHistory?.['2026-09-27'], 5, 'hBP09-105 U keeps 2026-09-27');
  console.log('  ✓ artifact: CR example printings keep 2026-09-27 alongside later observations');
}

console.log('DIC-1167 buyPriceHistory preservation OK');
