#!/usr/bin/env node
/**
 * DIC-1085 i18n and Tournament Monthly Summary regression test.
 *
 * Covers:
 * 1. Key parity between zh and ja locale dictionaries.
 * 2. Translation interpolation and fallback behavior.
 * 3. Tournament Monthly Summary model construction from live verified data.
 * 4. Summary localization in both Traditional Chinese (zh) and Japanese (ja).
 *
 * Run: node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *   --import ./scripts/register-ts.mjs scripts/test-i18n.mjs
 */

import assert from 'node:assert/strict';
import { t, zh, ja } from '../src/i18n/index.ts';
import { buildTournamentMonthlySummary } from '../src/utils/tournamentSummary.ts';
import { verifiedDecks, ALL_SCOPE } from '../src/utils/tournamentDonut.ts';
import fs from 'node:fs';
import path from 'node:path';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ── 1. Locale Key Parity & Completeness ─────────────────────────────────────
test('zh and ja locale dictionaries have exact key parity', () => {
  const zhKeys = Object.keys(zh).sort();
  const jaKeys = Object.keys(ja).sort();
  assert.deepEqual(zhKeys, jaKeys, 'Locale dictionary keys must match exactly');
  assert.ok(zhKeys.length > 50, 'Dictionary should contain complete UI key set');
});

test('no translation key resolves to empty or undefined value', () => {
  for (const [key, val] of Object.entries(zh)) {
    assert.ok(val && val.trim().length > 0, `zh key ${key} must not be empty`);
  }
  for (const [key, val] of Object.entries(ja)) {
    assert.ok(val && val.trim().length > 0, `ja key ${key} must not be empty`);
  }
});

// ── 2. Interpolation and Translation Function ───────────────────────────────
test('t() interpolates template parameters correctly', () => {
  const zhRes = t('search_results_count', 'zh', { count: 42 });
  assert.equal(zhRes, '共 42 張卡牌');

  const jaRes = t('search_results_count', 'ja', { count: 42 });
  assert.equal(jaRes, '全 42 件');
});

test('t() returns default fallback string when given an invalid language', () => {
  const fallback = t('nav_home', 'invalid');
  assert.equal(fallback, '首頁');
});

// ── 3. Live Tournament Data Fixtures & Summary Derivation ───────────────────
const julyPath = path.resolve('public/data/tournaments/2026-07.json');
const augustPath = path.resolve('public/data/tournaments/2026-08.json');
const indexPath = path.resolve('public/data/tournaments/index.json');

assert.ok(fs.existsSync(julyPath), '2026-07.json must exist');
assert.ok(fs.existsSync(augustPath), '2026-08.json must exist');
assert.ok(fs.existsSync(indexPath), 'index.json must exist');

const julyReport = JSON.parse(fs.readFileSync(julyPath, 'utf8'));
const augustReport = JSON.parse(fs.readFileSync(augustPath, 'utf8'));

test('buildTournamentMonthlySummary generates real accurate stats for 2026-08', () => {
  const summaryZh = buildTournamentMonthlySummary([augustReport], '2026-08', 'zh');
  assert.equal(summaryZh.eventCount, 1);
  assert.equal(summaryZh.observedDeckCount, 2);
  assert.equal(summaryZh.verifiedDeckCount, 2);
  assert.equal(summaryZh.smallSample, true, 'n=2 is below SMALL_SAMPLE_MIN (3)');
  assert.ok(summaryZh.topArchetypes.length > 0);
  assert.ok(summaryZh.notablePlacements.length > 0);
  assert.equal(summaryZh.notablePlacements[0].rankLabel, 'champion');
});

test('buildTournamentMonthlySummary aggregates all-months scope correctly', () => {
  const summaryZh = buildTournamentMonthlySummary([augustReport, julyReport], ALL_SCOPE, 'zh');
  assert.equal(summaryZh.eventCount, 4);
  assert.equal(summaryZh.observedDeckCount, 5);
  assert.equal(summaryZh.verifiedDeckCount, 5);
  assert.equal(summaryZh.smallSample, false, 'n=5 is >= 3');
  assert.ok(summaryZh.scopeLabel.includes('2026-07 ~ 2026-08'));
});

test('buildTournamentMonthlySummary translates scope labels into Japanese when requested', () => {
  const summaryJa = buildTournamentMonthlySummary([augustReport, julyReport], ALL_SCOPE, 'ja');
  assert.ok(summaryJa.scopeLabel.includes('全期間'));
  assert.ok(summaryJa.scopeLabel.includes('2026-07 ~ 2026-08'));
});

// ── 4. Fail-closed gates & unknown handling in summary ─────────────────────
test('summary ignores unverified decks for top archetype counts', () => {
  const unverifiedReport = {
    ...augustReport,
    events: [
      {
        ...augustReport.events[0],
        decks: augustReport.events[0].decks.map((d) => ({ ...d, cardsVerified: false })),
      },
    ],
  };
  const summary = buildTournamentMonthlySummary([unverifiedReport], '2026-08', 'zh');
  assert.equal(summary.verifiedDeckCount, 0);
  assert.equal(summary.topArchetypes.length, 0);
});

console.log(`test-i18n: PASS (${passed} checks)`);
