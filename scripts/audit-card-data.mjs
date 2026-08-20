import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSourcePrintings } from '../src/utils/printingIdentity.ts';
import {
  hasDisplayableSubscriberStats,
  isValidatedTrendPrediction,
  normalizeCardIdentity,
} from '../src/utils/cardNormalization.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const database = JSON.parse(fs.readFileSync(path.join(root, 'data/database.json'), 'utf8'));
const publicDatabase = JSON.parse(fs.readFileSync(path.join(root, 'public/data/database.json'), 'utf8'));
const cards = Object.values(database.cards || {});
const violations = [];
const warnings = [];

function add(list, code, card, detail) {
  list.push({ code, id: card?.id ?? null, cardNumber: card?.cardNumber ?? null, detail });
}

const beforeBadges = {};
const afterBadges = {};
const categoryCounts = {};
let priceHistoryRows = 0;
let trendEligibleRows = 0;
let subscriberRows = 0;
let subscriberDisplayableRows = 0;
let ambiguousPrintingRows = 0;

function legacyBadge(card) {
  const rarity = String(card.rarity || '').toUpperCase();
  if (rarity.includes('OSR') || rarity.includes('OUR')) return 'Buzz';
  if (rarity === 'UR') return '2nd';
  if (rarity === 'SR') return '1st';
  if (['RR', 'R', 'U', 'C'].includes(rarity)) return 'Debut';
  if (rarity === 'N') return 'Spot';
  return null;
}

for (const card of cards) {
  const normalized = normalizeCardIdentity(card);
  const before = legacyBadge(card) ?? '(hidden)';
  const after = normalized.displayBadge ?? '(hidden)';
  beforeBadges[before] = (beforeBadges[before] || 0) + 1;
  afterBadges[after] = (afterBadges[after] || 0) + 1;
  const category = normalized.category ?? '(unknown)';
  categoryCounts[category] = (categoryCounts[category] || 0) + 1;

  if (/^hY\d/i.test(card.cardNumber || '') && normalized.category !== 'yell') {
    add(violations, 'HY_NOT_YELL', card, normalized);
  }
  if (card.skillsJp?.cardNumber && card.skillsJp.cardNumber !== card.cardNumber) {
    add(violations, 'JP_CARD_NUMBER_MISMATCH', card, card.skillsJp.cardNumber);
  }
  if (card.skillsZh?.cardNumber && card.skillsZh.cardNumber !== card.cardNumber) {
    add(violations, 'ZH_CARD_NUMBER_MISMATCH', card, card.skillsZh.cardNumber);
  }
  if (card.skillsJp?.color && card.skillsZh?.color && card.skillsJp.color !== card.skillsZh.color) {
    add(warnings, 'SOURCE_COLOR_MISMATCH', card, { jp: card.skillsJp.color, zh: card.skillsZh.color });
  }
  if (!normalized.category) add(warnings, 'UNKNOWN_CATEGORY', card, normalized.source);
  if (!/^h[A-Za-z0-9]+-\d{3}$/i.test(card.cardNumber || '')) add(warnings, 'MALFORMED_CARD_NUMBER', card, null);

  const printings = buildSourcePrintings(card.prices || []);
  if (printings.some((printing) => printing.ambiguous)) ambiguousPrintingRows++;

  if (card.priceHistory && Object.keys(card.priceHistory).length > 0) {
    priceHistoryRows++;
    if (card.priceHistoryMeta?.cardNumber === card.cardNumber
      && card.priceHistoryMeta?.printing
      && card.priceHistoryMeta?.currency) trendEligibleRows++;
  }
  if (card.ytStats) {
    subscriberRows++;
    if (hasDisplayableSubscriberStats(card.ytStats, Date.parse('2026-08-18T23:59:59Z'))) subscriberDisplayableRows++;
    if (card.ytStats.subscriberCount === 0 && !hasDisplayableSubscriberStats(card.ytStats)) {
      add(violations, 'UNPROVEN_ZERO_SUBSCRIBERS', card, card.ytStats);
    }
  }
}

for (const cardNumber of ['hY04-001', 'hY04-002', 'hY05-001', 'hY05-002']) {
  const matches = cards.filter((card) => card.cardNumber === cardNumber);
  assert.ok(matches.length > 0, `${cardNumber} must exist`);
  assert.ok(matches.every((card) => normalizeCardIdentity(card).displayBadge === 'Yell'), `${cardNumber} must display Yell`);
}

assert.equal(normalizeCardIdentity({ cardNumber: 'hXX-001', rarity: 'C', skillsJp: { cardType: 'ホロメン' } }).stage, null);
assert.equal(hasDisplayableSubscriberStats({ subscriberCount: 0 }), false);
assert.equal(isValidatedTrendPrediction({ trend: 'up', score: 0.1, confidence: 0.5, dataPoints: 3 }, {}), false);
assert.deepEqual(Object.keys(database.cards), Object.keys(publicDatabase.cards), 'canonical/public databases must contain identical rows');

const report = {
  issue: 'DIC-1084',
  generatedAt: new Date().toISOString(),
  dataset: { rows: cards.length, canonicalTotalCards: database.totalCards, publicRows: Object.keys(publicDatabase.cards || {}).length },
  before: { badgeCounts: beforeBadges },
  after: { badgeCounts: afterBadges, categoryCounts },
  subscribers: { rowsWithStats: subscriberRows, displayableWithRequiredProvenance: subscriberDisplayableRows },
  trends: { rowsWithPriceHistory: priceHistoryRows, rowsWithExactCardPrintingCurrencyProvenance: trendEligibleRows },
  printings: { rowsWithAmbiguousSourcePrinting: ambiguousPrintingRows },
  summary: { criticalViolations: violations.length, warnings: warnings.length },
  violations,
  warnings,
};

if (process.argv.includes('--write')) {
  const auditDir = path.join(root, 'docs/audits');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(path.join(auditDir, 'DIC-1084-card-data-audit.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(auditDir, 'DIC-1084-card-data-audit.md'), [
    '## DIC-1084 full dataset audit',
    '',
    `- Rows audited: ${cards.length}`,
    `- Critical violations: ${violations.length}`,
    `- Warnings: ${warnings.length}`,
    `- hY regression cards: all normalize to Yell`,
    `- Subscriber rows displayable with complete provenance: ${subscriberDisplayableRows}/${subscriberRows}`,
    `- Price-history rows eligible for exact-printing trend: ${trendEligibleRows}/${priceHistoryRows}`,
    `- Ambiguous source-printing rows: ${ambiguousPrintingRows}`,
    '',
    'Machine-readable details are in `DIC-1084-card-data-audit.json`.',
    '',
  ].join('\n'));
}

console.log(JSON.stringify(report, null, 2));
if (violations.length > 0) process.exit(1);
