#!/usr/bin/env node
// DIC-1192 regression: the client must never hand i18n.t() a colour token it
// cannot translate — production shipped a `Missing translation key: color_◇`
// crash that fail-closed the entire SearchResultsScreen at 1440×900 / hBP04.
// The scraper is free to keep writing legacy tokens ('◇' means colourless,
// composite 'blue_red' means multi-cost); the CLIENT normaliser is the layer
// that has to shield the render.
//
// This file locks the contract in two directions:
//   1. Every KNOWN_COLOR_KEYS token has a matching `color_<token>` key in
//      the zh and ja locales. If a locale key is ever renamed or a new
//      whitelist entry is added without its i18n key, this assertion fails.
//   2. normalizeColorTokens maps ◇ → colorless, splits composite tokens on
//      _ / , / /, is case-insensitive, drops truly unknown tokens (never
//      handing them to the render), and surfaces those drops via
//      console.warn so a real data drift is not silently swallowed.
//
// A mutation that removes the ◇ branch, drops the unknown warning, or lets
// an unknown token through the returned array flips one of these assertions.

import assert from 'node:assert/strict';
import {
  KNOWN_COLOR_KEYS,
  normalizeColorTokens,
} from '../src/utils/cardNormalization.ts';
import { zh } from '../src/i18n/locales/zh.ts';
import { ja } from '../src/i18n/locales/ja.ts';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ── 1. Whitelist ↔ i18n coverage ─────────────────────────────────────────

test('every KNOWN_COLOR_KEYS token has a color_<token> key in zh and ja', () => {
  for (const token of KNOWN_COLOR_KEYS) {
    const key = `color_${token}`;
    assert.ok(
      typeof zh[key] === 'string' && zh[key].length > 0,
      `zh locale missing ${key} — normaliser would hand t() a key it cannot translate`,
    );
    assert.ok(
      typeof ja[key] === 'string' && ja[key].length > 0,
      `ja locale missing ${key} — normaliser would hand t() a key it cannot translate`,
    );
  }
});

// ── 2. Normalisation cases the render depends on ─────────────────────────

test('empty / null / non-string inputs return []', () => {
  assert.deepEqual(normalizeColorTokens(''), []);
  assert.deepEqual(normalizeColorTokens('   '), []);
  assert.deepEqual(normalizeColorTokens(null), []);
  assert.deepEqual(normalizeColorTokens(undefined), []);
  assert.deepEqual(normalizeColorTokens(42), []);
  assert.deepEqual(normalizeColorTokens({}), []);
});

test('legacy JP diamond marker ◇ normalises to colorless (the DIC-1192 crash token)', () => {
  assert.deepEqual(normalizeColorTokens('◇'), ['colorless']);
});

test('known English tokens pass through case-insensitively', () => {
  assert.deepEqual(normalizeColorTokens('white'), ['white']);
  assert.deepEqual(normalizeColorTokens('BLUE'), ['blue']);
  assert.deepEqual(normalizeColorTokens('Purple'), ['purple']);
  assert.deepEqual(normalizeColorTokens('  green  '), ['green']);
});

test('composite tokens split on _ , / and whitespace, dedup preserved', () => {
  assert.deepEqual(normalizeColorTokens('blue_red'), ['blue', 'red']);
  assert.deepEqual(normalizeColorTokens('white/green'), ['white', 'green']);
  assert.deepEqual(normalizeColorTokens('purple, yellow'), ['purple', 'yellow']);
  assert.deepEqual(normalizeColorTokens('red red red'), ['red']);
});

test('composite with diamond still yields colorless (no crash risk)', () => {
  assert.deepEqual(normalizeColorTokens('◇_white'), ['colorless', 'white']);
});

test('truly unknown tokens are dropped from the returned array (never reach t())', () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    // 'mint' has no color_mint locale key; the render must not receive it.
    const result = normalizeColorTokens('mint');
    assert.deepEqual(result, [], 'unknown tokens must be dropped from the render pipeline');
    assert.equal(warnings.length, 1, 'unknown tokens must emit exactly one console.warn');
    assert.match(warnings[0], /DIC-1192/, 'warning must be tagged with the ticket for grep-ability');
    assert.match(warnings[0], /mint/, 'warning must include the unknown token so data-shape drift is visible');
    assert.match(warnings[0], /raw=/, 'warning must include the raw source string for provenance');
  } finally {
    console.warn = originalWarn;
  }
});

test('composite with one known + one unknown keeps the known part and warns on the unknown', () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    const result = normalizeColorTokens('blue_ultraviolet');
    assert.deepEqual(result, ['blue']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /ultraviolet/);
  } finally {
    console.warn = originalWarn;
  }
});

// ── 3. Failure mode the ticket documents ─────────────────────────────────

test('DIC-1192 root cause fixture: hBP04-087 color field cannot crash the render pipeline', () => {
  // hBP04-087_hBP04 in data/database.json carries { color: '◇' }. Before the
  // fix, this value reached t(`color_◇`) which throws `Missing translation
  // key: color_◇ (zh)`, whiteouting the entire 1440×900 hBP04 render.
  const colors = normalizeColorTokens('◇');
  // Every returned token must be a whitelisted key the render can translate.
  for (const token of colors) {
    assert.ok(
      KNOWN_COLOR_KEYS.has(token),
      `normaliser must only return whitelisted tokens, got ${token}`,
    );
  }
});

console.log(`\nDIC-1192 colour token normalisation: ${passed} tests passed`);
