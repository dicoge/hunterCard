#!/usr/bin/env node
// DIC-1141 regression: search + card detail must render the Holomen Bloom
// Level (Debut / 1st / 2nd / Buzz / Spot) as the primary badge, and never
// impersonate a missing Bloom Level with the category label "Holomen" — that
// is exactly what production shipped for hBP04-026~029, where every card
// showed "Holomen" and Debut/1st/2nd were invisible.
//
// The checks lean on canonical shapes rather than mocks:
//   1. normalizeCardIdentity() collapses fake fallbacks into null so
//      downstream UI can pick the right hint.
//   2. data/bloom-levels.json + data/database.json carry the field the UI
//      relies on for hBP04-026~029 (Debut, 1st, 2nd all present).
//   3. The SearchResults / CardDetail sources render Bloom Level with the
//      dedicated Bloom palette instead of the printing-rarity palette.
//
// Any mutation that reintroduces the "Holomen" fallback, mixes the rarity
// palette back in, or drops the canonical Bloom Level flips the assertion.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeCardIdentity,
  bloomLevelBadgeColor,
  categoryBadgeColor,
  BLOOM_LEVEL_COLORS,
  CATEGORY_COLORS,
} from '../src/utils/cardNormalization.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// ── 1. Normalization fixtures for every acceptance-criteria Bloom Level ──

const holomenFixtures = [
  {
    label: 'hBP04-028 Debut (issue AC: 至少一張 Debut)',
    card: {
      cardNumber: 'hBP04-028',
      type: 'ホロメン',
      bloomLevel: 'Debut',
      skillsJp: { cardType: 'ホロメン' },
    },
    expected: { category: 'holomen', stage: 'debut', stageLabel: 'Debut' },
  },
  {
    label: 'hBP04-027 1st (issue AC: 至少一張 1st)',
    card: {
      cardNumber: 'hBP04-027',
      type: 'ホロメン',
      bloomLevel: '1st',
      skillsJp: { cardType: 'ホロメン' },
    },
    expected: { category: 'holomen', stage: '1st', stageLabel: '1st' },
  },
  {
    label: 'hBP04-029 1st (issue AC: 至少一張 1st, 二次驗證)',
    card: {
      cardNumber: 'hBP04-029',
      type: 'ホロメン',
      bloomLevel: '1st',
      skillsJp: { cardType: 'ホロメン' },
    },
    expected: { category: 'holomen', stage: '1st', stageLabel: '1st' },
  },
  {
    label: 'hBP04-026 2nd (issue AC: 至少一張 2nd)',
    card: {
      cardNumber: 'hBP04-026',
      type: 'ホロメン',
      bloomLevel: '2nd',
      skillsJp: { cardType: 'ホロメン' },
    },
    expected: { category: 'holomen', stage: '2nd', stageLabel: '2nd' },
  },
  {
    label: 'Buzz Holomen keeps stage from cardType keyword',
    card: {
      cardNumber: 'hBP03-100',
      type: 'Buzzホロメン',
      skillsJp: { cardType: 'Buzzホロメン' },
    },
    expected: { category: 'holomen', stage: 'buzz', stageLabel: 'Buzz' },
  },
  {
    label: 'Spot Holomen keeps stage',
    card: {
      cardNumber: 'hBP03-050',
      type: 'ホロメン',
      bloomLevel: 'Spot',
      skillsJp: { cardType: 'ホロメン' },
    },
    expected: { category: 'holomen', stage: 'spot', stageLabel: 'Spot' },
  },
];

for (const { label, card, expected } of holomenFixtures) {
  const norm = normalizeCardIdentity(card);
  assert.equal(norm.category, expected.category, `${label}: category`);
  assert.equal(norm.stage, expected.stage, `${label}: stage`);
  assert.equal(norm.stageLabel, expected.stageLabel, `${label}: stageLabel`);
  assert.equal(norm.categoryLabel, 'Holomen', `${label}: categoryLabel Holomen kept as secondary chip`);
  // The primary badge on the compact card must be the Bloom Level, never the
  // category label — that was the DIC-1141 bug.
  assert.equal(norm.displayBadge, expected.stageLabel, `${label}: displayBadge is the Bloom Level`);
  assert.notEqual(norm.displayBadge, 'Holomen', `${label}: displayBadge is not the "Holomen" fallback`);
  assert.equal(norm.bloomLevelMissing, false, `${label}: bloomLevelMissing false`);
}

// A Holomen whose canonical Bloom Level is not yet loaded must NOT fall back
// to "Holomen" — the UI is expected to show the pending hint instead.
const holomenNoStage = normalizeCardIdentity({
  cardNumber: 'hBP99-999',
  type: 'ホロメン',
  skillsJp: { cardType: 'ホロメン' },
});
assert.equal(holomenNoStage.category, 'holomen');
assert.equal(holomenNoStage.stage, null);
assert.equal(holomenNoStage.displayBadge, null, 'missing Bloom Level must not fall back to "Holomen"');
assert.equal(holomenNoStage.bloomLevelMissing, true, 'bloomLevelMissing flag must be true');

// ── 2. Oshi / Support / Yell / Mascot categories are preserved ──

const oshi = normalizeCardIdentity({
  cardNumber: 'hBP04-001',
  type: '推しホロメン',
  skillsJp: { cardType: '推しホロメン' },
});
assert.equal(oshi.category, 'oshi', 'Oshi category preserved');
assert.equal(oshi.stage, null, 'Oshi has no Bloom Level');
assert.equal(oshi.displayBadge, 'Oshi', 'Oshi displayBadge stays Oshi');

const support = normalizeCardIdentity({
  cardNumber: 'hBP04-090',
  type: 'サポート・ツール',
  skillsJp: { cardType: 'サポート・ツール' },
});
assert.equal(support.category, 'support', 'Support category preserved');
assert.equal(support.displayBadge, 'Support', 'Support displayBadge stays Support');

const mascot = normalizeCardIdentity({
  cardNumber: 'hBP04-070',
  type: 'マスコット',
  skillsJp: { cardType: 'マスコット' },
});
assert.equal(mascot.category, 'mascot', 'Mascot category preserved');
assert.equal(mascot.displayBadge, 'Mascot', 'Mascot displayBadge stays Mascot');

const yell = normalizeCardIdentity({
  cardNumber: 'hY01-001',
  type: 'エール',
  skillsJp: { cardType: 'エール' },
});
assert.equal(yell.category, 'yell', 'Yell category preserved');
assert.equal(yell.displayBadge, 'Yell', 'Yell displayBadge stays Yell');

// ── 3. Palettes must not collide with the printing-rarity palette ──

const printingRarityPalette = ['#8B4513', '#6b7280', '#10b981', '#3b82f6', '#f59e0b'];
for (const stage of Object.keys(BLOOM_LEVEL_COLORS)) {
  const color = BLOOM_LEVEL_COLORS[stage];
  assert.ok(color, `Bloom color present for ${stage}`);
  assert.equal(bloomLevelBadgeColor(stage), color, `bloomLevelBadgeColor(${stage})`);
  assert.ok(
    !printingRarityPalette.includes(color) || stage === '1st',
    `Bloom color ${color} for ${stage} does not collide with printing rarity palette`,
  );
}
assert.equal(bloomLevelBadgeColor(null), null, 'null stage yields no color');
assert.equal(categoryBadgeColor('holomen'), CATEGORY_COLORS.holomen);

// ── 4. Canonical Bloom Level overlay is present with the acceptance rows ──

const overlay = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'bloom-levels.json'), 'utf8'));
const by = overlay.byCardNumber || {};
const canonicalExpectations = {
  'hBP04-026': '2nd',
  'hBP04-027': '1st',
  'hBP04-028': 'Debut',
  'hBP04-029': '1st',
};
for (const [cn, expected] of Object.entries(canonicalExpectations)) {
  assert.equal(by[cn], expected, `bloom-levels.json ${cn} must be ${expected}, got ${by[cn]}`);
}
// The overlay must cover at least one Debut, 1st, and 2nd across hBP04 (issue AC).
const hbp04 = Object.entries(by).filter(([cn]) => cn.startsWith('hBP04-')).map(([, v]) => v);
assert.ok(hbp04.includes('Debut'), 'overlay covers ≥1 Debut in hBP04');
assert.ok(hbp04.includes('1st'), 'overlay covers ≥1 1st in hBP04');
assert.ok(hbp04.includes('2nd'), 'overlay covers ≥1 2nd in hBP04');

// ── 5. database.json carries bloomLevel on every acceptance-target card ──

const db = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'database.json'), 'utf8'));
const targets = new Set(['hBP04-026', 'hBP04-027', 'hBP04-028', 'hBP04-029']);
const targetPrintings = Object.values(db.cards || {}).filter((c) => targets.has(c.cardNumber));
assert.ok(targetPrintings.length >= 4, 'database.json contains hBP04-026~029 printings');
for (const c of targetPrintings) {
  assert.equal(c.bloomLevel, canonicalExpectations[c.cardNumber],
    `database.json ${c.id} (cardNumber ${c.cardNumber}) must carry canonical Bloom Level`);
}
// And normalized identity on each printing must NOT display "Holomen" as the primary badge.
for (const c of targetPrintings) {
  const norm = normalizeCardIdentity(c);
  assert.equal(norm.category, 'holomen', `${c.id} still normalizes to holomen`);
  assert.equal(norm.displayBadge, canonicalExpectations[c.cardNumber],
    `${c.id} search list badge is Bloom Level, not "Holomen"`);
  assert.notEqual(norm.displayBadge, 'Holomen', `${c.id} never impersonates "Holomen"`);
}

// ── 6. UI source code no longer paints the primary badge with rarity color ──

const searchSrc = fs.readFileSync(path.join(REPO, 'src', 'screens', 'SearchResultsScreen.tsx'), 'utf8');
const detailSrc = fs.readFileSync(path.join(REPO, 'src', 'screens', 'CardDetailScreen.tsx'), 'utf8');

// The old buggy header used rarityColors[card.rarity] as the badge background —
// the whole point of DIC-1141 is that the badge palette is decoupled from
// rarity. Fail closed if the pattern comes back.
assert.doesNotMatch(searchSrc, /rarityBadge[^\n]*rarityColors\[card\.rarity\]/,
  'SearchResults header must not color the primary badge with the printing rarity palette');
assert.match(searchSrc, /CardIdentityBadges/, 'SearchResults must render the two-badge component');
assert.match(searchSrc, /search_bloom_level_pending/, 'SearchResults must handle the pending-level case with the dedicated string');
assert.match(searchSrc, /bloomLevelBadgeColor/, 'SearchResults must import the Bloom palette resolver');

assert.match(detailSrc, /DetailIdentityBadges/, 'CardDetail must render the two-badge component');
assert.match(detailSrc, /card_detail_bloom_level_label/,
  'CardDetail must show a distinct row for Bloom Level');
assert.doesNotMatch(detailSrc, /card\.normalized\?\.displayBadge \?[\s\S]{0,200}rarityColors\[rarityKey\]/,
  'CardDetail header must not paint the Bloom Level with the printing rarity palette anymore');

// ── 7. i18n has the shared "Bloom 等級未取得" string in both locales ──

const zhLocale = fs.readFileSync(path.join(REPO, 'src', 'i18n', 'locales', 'zh.ts'), 'utf8');
const jaLocale = fs.readFileSync(path.join(REPO, 'src', 'i18n', 'locales', 'ja.ts'), 'utf8');
assert.match(zhLocale, /search_bloom_level_pending:\s*'Bloom 等級未取得'/);
assert.match(jaLocale, /search_bloom_level_pending:\s*'Bloomレベル未取得'/);
assert.match(zhLocale, /card_detail_bloom_level_label:\s*'Bloom 等級'/);
assert.match(jaLocale, /card_detail_bloom_level_label:\s*'Bloomレベル'/);

console.log('DIC-1141 Bloom Level regression checks passed');
