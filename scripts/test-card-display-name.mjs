#!/usr/bin/env node
// DIC-1380 naming consistency regression.
//
// Before this change, every card-name renderer open-coded
// `preferredLanguage === 'zh' && card.nameZh ? card.nameZh : card.name` and
// paired it with its own subtitle rule:
//   • CardDetail    : subtitle = nameZh under nameJP for both ja + en (never zh)
//   • SearchResults : subtitle = name under nameZh only when zh preference
//   • ScanResult    : hid the subtitle for ja preference altogether
// Three subtly different rules, three chances to drift. `resolveCardDisplayName`
// is the single choke point every surface now calls; this suite pins the
// primary + subtitle matrix so a future edit to any one surface cannot re-open
// the divergence.

import assert from 'node:assert/strict';
import { resolveCardDisplayName } from '../src/utils/cardDisplayName.ts';

let passed = 0;
function test(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    console.error(`  ✓ ${label} — FAILED: ${err?.message ?? err}`);
    process.exitCode = 1;
  }
}

const bothNames = { name: '博衣こより', nameZh: '博衣可佑理' };
const jpOnly = { name: '沙花叉クロヱ', nameZh: '' };
const zhOnly = { name: '', nameZh: '沙花叉黑' };
const identical = { name: '共通名', nameZh: '共通名' };
const paddedIdentical = { name: '  共通名  ', nameZh: '共通名' };
const missing = { name: null, nameZh: undefined };

// ── zh preference: prefers nameZh as primary, keeps name as subtitle ──
test('zh preference: both names present → primary=zh, secondary=jp', () => {
  assert.deepEqual(resolveCardDisplayName(bothNames, 'zh'), {
    primary: '博衣可佑理', secondary: '博衣こより',
  });
});
test('zh preference: only jp present → falls back to jp, no subtitle', () => {
  assert.deepEqual(resolveCardDisplayName(jpOnly, 'zh'), { primary: '沙花叉クロヱ', secondary: '' });
});
test('zh preference: only zh present → primary=zh, no jp subtitle', () => {
  assert.deepEqual(resolveCardDisplayName(zhOnly, 'zh'), { primary: '沙花叉黑', secondary: '' });
});
test('zh preference: whitespace-only nameZh treated as missing', () => {
  assert.deepEqual(resolveCardDisplayName({ name: '主名', nameZh: '   ' }, 'zh'), {
    primary: '主名', secondary: '',
  });
});
test('zh preference: identical strings do not duplicate subtitle line', () => {
  assert.deepEqual(resolveCardDisplayName(identical, 'zh'), { primary: '共通名', secondary: '' });
});
test('zh preference: primary/secondary trimmed and de-duplicated across padding', () => {
  assert.deepEqual(resolveCardDisplayName(paddedIdentical, 'zh'), { primary: '共通名', secondary: '' });
});

// ── ja preference: keeps jp as primary; DIC-1380 unifies subtitle across ja/en ──
test('ja preference: both names present → primary=jp, secondary=zh (unified with en)', () => {
  assert.deepEqual(resolveCardDisplayName(bothNames, 'ja'), {
    primary: '博衣こより', secondary: '博衣可佑理',
  });
});
test('ja preference: only jp present → no subtitle', () => {
  assert.deepEqual(resolveCardDisplayName(jpOnly, 'ja'), { primary: '沙花叉クロヱ', secondary: '' });
});
test('ja preference: only zh present → primary=zh (last resort), no subtitle', () => {
  assert.deepEqual(resolveCardDisplayName(zhOnly, 'ja'), { primary: '', secondary: '沙花叉黑' });
});

// ── en (and every other non-zh) preference behaves identically to ja ──
test('en preference: both names present → primary=jp, secondary=zh', () => {
  assert.deepEqual(resolveCardDisplayName(bothNames, 'en'), {
    primary: '博衣こより', secondary: '博衣可佑理',
  });
});
test('unknown language code defaults to jp-primary rule', () => {
  assert.deepEqual(resolveCardDisplayName(bothNames, 'ko'), {
    primary: '博衣こより', secondary: '博衣可佑理',
  });
});

// ── Missing card / blank card → empty resolution, callers substitute number ──
test('all fields missing → primary="" and secondary="" so callers fall back', () => {
  assert.deepEqual(resolveCardDisplayName(missing, 'zh'), { primary: '', secondary: '' });
  assert.deepEqual(resolveCardDisplayName(missing, 'ja'), { primary: '', secondary: '' });
});
test('undefined card object → empty resolution, does not throw', () => {
  assert.deepEqual(resolveCardDisplayName(undefined, 'zh'), { primary: '', secondary: '' });
});

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ card display name resolver: ${passed} checks passed`);
} else {
  console.error(`\n❌ card display name resolver failed`);
}
