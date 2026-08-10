#!/usr/bin/env node
/**
 * DIC-945 deck editor rules-engine regression. Exercises the pure engine in
 * src/utils/deckRules.ts against the acceptance cases: legal 71-card deck, main
 * shortfall, yell shortfall, missing oshi, same-number over-limit, gap missing
 * count, and no-exact-version price (no fallback).
 *
 * Run: node --experimental-strip-types scripts/test-deck-rules.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateDeck, isDeckLegal, deckStats, computeGap, resolveExactPrice,
  eligibleZone, RULES,
} from '../src/utils/deckRules.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ── Fixtures ────────────────────────────────────────────────────────────────
const oshi = (n) => ({ id: `oshi-${n}`, cardNumber: n, name: `oshi ${n}`, rarity: 'OSR', series: 's', cardTypeJp: '推しホロメン' });
const holomen = (n, r = 'R') => ({ id: `${n}-${r}`, cardNumber: n, name: `holomen ${n}`, rarity: r, series: 's', cardTypeJp: 'ホロメン' });
const support = (n) => ({ id: `sup-${n}`, cardNumber: n, name: `support ${n}`, rarity: 'C', series: 's', cardTypeJp: 'サポート・アイテム' });
const yell = (n) => ({ id: `yell-${n}`, cardNumber: n, name: `yell ${n}`, rarity: 'C', series: 's', cardTypeJp: 'エール' });

function slot(card, qty) { return { card, qty }; }

// A legal deck: 1 oshi + 50 main (unique numbers to avoid copy limits) + 20 yell.
function mainSlots(count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(slot(holomen(`hMN-${String(i).padStart(3, '0')}`), 1));
  return out;
}
function legalDeck() {
  return {
    id: 'd1', name: 'legal', updatedAt: '',
    oshi: [slot(oshi('hOSHI-001'), 1)],
    main: mainSlots(50),
    yell: [slot(yell('hYELL-001'), 20)],
  };
}

// ── Source of truth: runtime RULES is loaded from data/deck-rules.json ───────
// Proves the drift is gone — the engine consumes the JSON file, it is not a dead
// spec artifact shadowed by hardcoded TS values (DIC-952). If someone edits the
// JSON, RULES must change with it; if someone re-hardcodes values in TS, this
// deepEqual against the freshly-read file fails.
function stripComments(value) {
  if (Array.isArray(value)) return value.map(stripComments);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === '_comment') continue;
      out[k] = stripComments(v);
    }
    return out;
  }
  return value;
}

test('runtime RULES is loaded from data/deck-rules.json (no drift)', () => {
  const jsonPath = path.join(__dirname, '..', 'data', 'deck-rules.json');
  const fromFile = stripComments(JSON.parse(fs.readFileSync(jsonPath, 'utf8')));
  assert.deepEqual(RULES, fromFile, 'RULES must equal the JSON file, not a TS copy');
  // Spot-check the values the validation matrix depends on come from the file.
  assert.equal(RULES.zones.oshi.exactCount, fromFile.zones.oshi.exactCount);
  assert.equal(RULES.zones.main.exactCount, fromFile.zones.main.exactCount);
  assert.equal(RULES.zones.yell.exactCount, fromFile.zones.yell.exactCount);
  assert.equal(RULES.copyLimits.mainDefault, fromFile.copyLimits.mainDefault);
  assert.deepEqual(RULES.restrictedCards, fromFile.restrictedCards);
});

// ── Zone classification sanity ──────────────────────────────────────────────
test('eligibleZone classifies oshi / main / yell', () => {
  assert.equal(eligibleZone(oshi('x')), 'oshi');
  assert.equal(eligibleZone(holomen('x')), 'main');
  assert.equal(eligibleZone(support('x')), 'main');
  assert.equal(eligibleZone(yell('x')), 'yell');
});

// ── Case: legal 71-card deck ────────────────────────────────────────────────
test('legal 71-card deck passes with no errors', () => {
  const d = legalDeck();
  const s = deckStats(d);
  assert.equal(s.oshi, 1); assert.equal(s.main, 50); assert.equal(s.yell, 20);
  assert.equal(s.total, 71);
  assert.deepEqual(validateDeck(d).filter((i) => i.level === 'error'), []);
  assert.equal(isDeckLegal(d), true);
});

// ── Case: main deck insufficient (49) ───────────────────────────────────────
test('main deck shortfall triggers ERR_MAIN_QTY', () => {
  const d = legalDeck();
  d.main = mainSlots(49);
  const codes = validateDeck(d).map((i) => i.code);
  assert.ok(codes.includes('ERR_MAIN_QTY'));
  assert.equal(isDeckLegal(d), false);
});

// ── Case: yell deck insufficient (19) ───────────────────────────────────────
test('yell deck shortfall triggers ERR_CHEER_QTY', () => {
  const d = legalDeck();
  d.yell = [slot(yell('hYELL-001'), 19)];
  const codes = validateDeck(d).map((i) => i.code);
  assert.ok(codes.includes('ERR_CHEER_QTY'));
});

// ── Case: missing oshi (0) ──────────────────────────────────────────────────
test('missing oshi triggers ERR_OSHI_QTY', () => {
  const d = legalDeck();
  d.oshi = [];
  const codes = validateDeck(d).map((i) => i.code);
  assert.ok(codes.includes('ERR_OSHI_QTY'));
});

// ── Case: same card-number over the 4-copy limit ────────────────────────────
test('same cardNumber over 4 copies triggers ERR_CARD_LIMIT', () => {
  const d = legalDeck();
  // 46 unique + 5 copies of one number = 51; trim to keep count at 50 while
  // still exceeding the per-number limit.
  d.main = [...mainSlots(45), slot(holomen('hDUP-001', 'R'), 5)];
  const issues = validateDeck(d);
  const limit = issues.find((i) => i.code === 'ERR_CARD_LIMIT');
  assert.ok(limit, 'expected ERR_CARD_LIMIT');
  assert.equal(limit.cardNumber, 'hDUP-001');
});

test('different versions of same cardNumber combine toward the limit', () => {
  const d = legalDeck();
  // 3 of the base printing + 2 of a "SEC" printing, same number → 5 → over limit.
  d.main = [
    ...mainSlots(45),
    slot(holomen('hMIX-001', 'R'), 3),
    slot(holomen('hMIX-001', 'SEC'), 2),
  ];
  const codes = validateDeck(d).map((i) => i.code);
  assert.ok(codes.includes('ERR_CARD_LIMIT'));
});

test('restricted card over its 1-copy cap triggers ERR_RESTRICTED', () => {
  const d = legalDeck();
  d.main = [...mainSlots(48), slot(holomen('hBP07-101', 'R'), 2)];
  const codes = validateDeck(d).map((i) => i.code);
  assert.ok(codes.includes('ERR_RESTRICTED'));
});

// ── Case: gap missing count ─────────────────────────────────────────────────
test('gap computes required/owned/missing per (cardNumber, version)', () => {
  const d = {
    id: 'g', name: 'gap', updatedAt: '',
    oshi: [slot(oshi('hOSHI-001'), 1)],
    main: [slot(holomen('hMN-001', 'R'), 4)],
    yell: [slot(yell('hYELL-001'), 20)],
  };
  const owned = { 'hMN-001|R': 1 }; // own 1 of the 4 needed
  const gap = computeGap(d, owned, []);
  const row = gap.rows.find((r) => r.cardNumber === 'hMN-001');
  assert.equal(row.required, 4);
  assert.equal(row.owned, 1);
  assert.equal(row.missing, 3);
});

// ── Case: no exact-version price → no fallback, excluded from total ──────────
test('price resolves only on exact cardNumber+version, never fallback', () => {
  const records = [
    { cardNumber: 'hMN-001', version: 'SR', price: 500, currency: 'JPY', source: 'yuyu', timestamp: '2026-08-01' },
  ];
  // exact version match → ok
  const ok = resolveExactPrice('hMN-001', 'SR', records);
  assert.equal(ok.status, 'ok');
  assert.equal(ok.price, 500);
  // same number, different version → NO_EXACT_PRICE (no cross-version fallback)
  assert.equal(resolveExactPrice('hMN-001', 'R', records).status, 'NO_EXACT_PRICE');
  // empty version never matches
  assert.equal(resolveExactPrice('hMN-001', '', [{ cardNumber: 'hMN-001', version: '', price: 9, currency: 'JPY', source: 's', timestamp: 't' }]).status, 'NO_EXACT_PRICE');
});

test('gap total uses only exact-version prices; others land in unpriced', () => {
  const d = {
    id: 'g2', name: 'gap2', updatedAt: '',
    oshi: [],
    main: [slot(holomen('hMN-001', 'R'), 2), slot(holomen('hMN-002', 'C'), 2)],
    yell: [],
  };
  const owned = {}; // own nothing → all missing
  const records = [
    { cardNumber: 'hMN-001', version: 'R', price: 300, currency: 'JPY', source: 'yuyu', timestamp: '2026-07-15' },
    // hMN-002 has only a different-version price → must NOT be used
    { cardNumber: 'hMN-002', version: 'SR', price: 9999, currency: 'JPY', source: 'yuyu', timestamp: '2026-07-01' },
  ];
  const gap = computeGap(d, owned, records);
  assert.equal(gap.total, 300 * 2); // only hMN-001 priced
  assert.equal(gap.currency, 'JPY');
  assert.equal(gap.unpriced.length, 1);
  assert.equal(gap.unpriced[0].cardNumber, 'hMN-002');
  assert.equal(gap.dataAsOf, '2026-07-15');
});

console.log(`\nDIC-945 deck-rules: ${passed} tests passed`);
