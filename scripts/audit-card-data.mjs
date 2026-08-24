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
import { isCanonicalCardNumber } from './lib/card-number.js';
import { auditRecentSnapshots, computeGrowthDeltas } from './lib/yt-growth.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const database = JSON.parse(fs.readFileSync(path.join(root, 'data/database.json'), 'utf8'));
const publicDatabase = JSON.parse(fs.readFileSync(path.join(root, 'public/data/database.json'), 'utf8'));
const ytHistory = JSON.parse(fs.readFileSync(path.join(root, 'data/yt-stats-history.json'), 'utf8'));
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
let holomenMissingBloomRows = 0;

function legacyBadge(card) {
  const rarity = String(card.rarity || '').toUpperCase();
  if (rarity.includes('OSR') || rarity.includes('OUR')) return 'Buzz';
  if (rarity === 'UR') return '2nd';
  if (rarity === 'SR') return '1st';
  if (['RR', 'R', 'U', 'C'].includes(rarity)) return 'Debut';
  if (rarity === 'N') return 'Spot';
  return null;
}

function isUserVisibleUnknownCategory(card, normalized) {
  if (normalized.category) return false;
  // Empty source data is explicitly hidden/unavailable. A non-empty, unknown
  // source type could become a misleading user-visible label and must fail.
  return Boolean(normalized.source.cardType || card.type || card.skillsJp?.cardType || card.skillsZh?.cardType);
}

function addAmbiguousPrintingFindings(card, printings) {
  const ambiguous = printings.filter((printing) => printing.ambiguous);
  if (!ambiguous.length) return;
  ambiguousPrintingRows++;
  add(warnings, 'AMBIGUOUS_SOURCE_PRINTING_HIDDEN', card, ambiguous.map((printing) => ({
    printing: printing.printing,
    label: printing.label,
    reason: 'same source printing has conflicting prices; exact sellPrice is hidden/unavailable and is not user-visible',
  })));
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
  if (isUserVisibleUnknownCategory(card, normalized)) add(violations, 'UNKNOWN_USER_VISIBLE_CATEGORY', card, normalized.source);
  else if (!normalized.category) add(warnings, 'UNKNOWN_CATEGORY_HIDDEN', card, normalized.source);
  if (!isCanonicalCardNumber(card.cardNumber || '')) add(violations, 'MALFORMED_CARD_NUMBER', card, null);
  if (normalized.category !== 'holomen' && normalized.stage) add(violations, 'NON_HOLOMEN_BLOOM_LEVEL', card, normalized);
  if (normalized.bloomLevelMissing) {
    holomenMissingBloomRows++;
    add(warnings, 'HOLOMEN_BLOOM_LEVEL_UNAVAILABLE', card, {
      ...normalized.source,
      reason: 'missing source Bloom remains an explicit unavailable badge, never guessed as Holomen',
    });
  }

  const printings = buildSourcePrintings(card.prices || []);
  addAmbiguousPrintingFindings(card, printings);

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

const ytRecent7ByChannel = {};
let ytChannelsAudited = 0;
let ytRecentSnapshotsAudited = 0;
let ytStampedDeltaMismatches = 0;
for (const [channelId, entry] of Object.entries(ytHistory || {})) {
  if (!entry || !Array.isArray(entry.history)) continue;
  const recent = auditRecentSnapshots(entry.history, { limit: 7 });
  ytRecent7ByChannel[channelId] = recent;
  ytChannelsAudited++;
  ytRecentSnapshotsAudited += recent.length;
  ytStampedDeltaMismatches += recent.filter((snapshot) => !snapshot.stampedDeltaMatchesCurrentAlgorithm).length;
}
if (ytStampedDeltaMismatches > 0) {
  add(violations, 'YT_RECENT7_DELTA_STAMP_MISMATCH', null, { ytStampedDeltaMismatches });
}

for (const cardNumber of ['hY04-001', 'hY04-002', 'hY05-001', 'hY05-002', 'hY01-014', 'hY02-012']) {
  const matches = cards.filter((card) => card.cardNumber === cardNumber);
  assert.ok(matches.length > 0, `${cardNumber} must exist`);
  assert.ok(matches.every((card) => normalizeCardIdentity(card).displayBadge === 'Yell'), `${cardNumber} must display Yell`);
}

assert.equal(isCanonicalCardNumber('hY01-014'), true);
assert.equal(isCanonicalCardNumber('hY01-14'), false);
assert.equal(
  normalizeCardIdentity({ cardNumber: 'hXX-001', rarity: 'C', skillsJp: { cardType: 'ホロメン' } }).bloomLevelMissing,
  true,
  'Holomen with missing Bloom must remain unavailable instead of falling back to category label',
);
assert.equal(normalizeCardIdentity({ cardNumber: 'hXX-001', rarity: 'C', skillsJp: { cardType: 'サポート' }, bloomLevel: '1st' }).stage, null);
assert.equal(computeGrowthDeltas([
  { date: '2026-08-21', subscriberCount: 1000, totalViewCount: 1000, channelId: 'UCTEST', source: 'youtube_about_ssr', parser: 'ytInitialData.aboutChannelViewModel/v1' },
  { date: '2026-08-22', subscriberCount: 1000, totalViewCount: 1000, channelId: 'UCTEST', source: 'youtube_about_ssr', parser: 'ytInitialData.aboutChannelViewModel/v1' },
]).viewCount_1d, null, 'stale same-provenance view baseline must hide daily views, never render 0');
assert.equal(hasDisplayableSubscriberStats({ subscriberCount: 0 }), false);
assert.equal(isValidatedTrendPrediction({ trend: 'up', score: 0.1, confidence: 0.5, dataPoints: 3 }, {}), false);
assert.deepEqual(Object.keys(database.cards), Object.keys(publicDatabase.cards), 'canonical/public databases must contain identical rows');

const report = {
  issue: 'DIC-1084',
  audit: 'DIC-1153-strict-card-and-recent7-youtube-audit',
  generatedAt: new Date().toISOString(),
  dataset: { rows: cards.length, canonicalTotalCards: database.totalCards, publicRows: Object.keys(publicDatabase.cards || {}).length },
  before: { badgeCounts: beforeBadges },
  after: { badgeCounts: afterBadges, categoryCounts },
  subscribers: { rowsWithStats: subscriberRows, displayableWithRequiredProvenance: subscriberDisplayableRows },
  trends: { rowsWithPriceHistory: priceHistoryRows, rowsWithExactCardPrintingCurrencyProvenance: trendEligibleRows },
  printings: {
    rowsWithAmbiguousSourcePrinting: ambiguousPrintingRows,
    warning: 'Ambiguous source printings remain non-user-visible because exact sellPrice is hidden/unavailable and never guessed.',
  },
  bloom: { holomenRowsMissingBloomLevel: holomenMissingBloomRows },
  youtubeRecent7: {
    channelsAudited: ytChannelsAudited,
    snapshotsAudited: ytRecentSnapshotsAudited,
    stampedDeltaMismatches: ytStampedDeltaMismatches,
    byChannel: ytRecent7ByChannel,
  },
  summary: { criticalViolations: violations.length, warnings: warnings.length },
  violations,
  warnings,
};

if (process.argv.includes('--write')) {
  const auditDir = path.join(root, 'docs/audits');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(path.join(auditDir, 'DIC-1084-card-data-audit.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(auditDir, 'DIC-1153-strict-card-youtube-audit.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(auditDir, 'DIC-1161-strict-card-youtube-audit.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(auditDir, 'DIC-1084-card-data-audit.md'), [
    '## DIC-1153 strict card + recent-7 YouTube audit',
    '',
    `- Rows audited: ${cards.length}`,
    `- Critical violations: ${violations.length}`,
    `- Warnings: ${warnings.length}`,
    `- hY regression cards: all normalize to Yell`,
    `- Subscriber rows displayable with complete provenance: ${subscriberDisplayableRows}/${subscriberRows}`,
    `- YouTube recent-7 snapshots audited: ${ytRecentSnapshotsAudited} across ${ytChannelsAudited} channels`,
    `- YouTube stamped delta mismatches: ${ytStampedDeltaMismatches}`,
    `- Price-history rows eligible for exact-printing trend: ${trendEligibleRows}/${priceHistoryRows}`,
    `- Ambiguous source-printing rows: ${ambiguousPrintingRows}`,
    '',
    'Machine-readable details are in `DIC-1153-strict-card-youtube-audit.json` (also copied to `DIC-1161-strict-card-youtube-audit.json` for this implementation issue).',
    '',
  ].join('\n'));
}

console.log(JSON.stringify(report, null, 2));
if (violations.length > 0) process.exit(1);
