#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  analyzeMonth,
  analyzeReports,
  buildAssociations,
  buildClusters,
  buildSimilarity,
  buildVectors,
  extractDecks,
  stableStringify,
} from './tournament-analytics-core.mjs';

function card(zone, cardNumber, version, count = 1) {
  return { zone, cardNumber, version, count };
}

// A printing the source explicitly proved. Deck Log never produces these — it
// publishes a rarity label, which is deliberately NOT accepted as identity.
function provenCard(zone, cardNumber, version, count = 1) {
  return { zone, cardNumber, version, count, versionProven: true };
}

function deck(id, archetypeId, cards, extra = {}) {
  return {
    deckId: id,
    decklogCode: id.replace('decklog:', ''),
    sourceUrl: `https://example.test/${id}`,
    playerName: null,
    rank: null,
    rankLabel: null,
    archetypeId,
    archetypeLabel: archetypeId,
    oshi: archetypeId,
    colors: [],
    cards,
    cardsVerified: true,
    coverage: 'ranked',
    fetchedAt: '2026-08-17T00:00:00.000Z',
    ...extra,
  };
}

function report(decks, month = '2026-08') {
  return {
    fileName: `${month}.json`,
    hash: `hash-${month}`,
    report: {
      schemaVersion: 1,
      month,
      generatedAt: '2026-08-17T00:00:00.000Z',
      events: [{ eventId: `event-${month}`, name: 'event', date: null, sourceUrl: 'https://example.test', decks }],
    },
  };
}

const decks6 = [
  deck('decklog:A1', 'alpha', [card('oshi', 'O-A', 'OSR'), card('main', 'A-core', 'C', 4), card('main', 'A-tech', 'R', 2), card('yell', 'Y-A', 'SY', 20)]),
  deck('decklog:A2', 'alpha', [card('oshi', 'O-A', 'OSR'), card('main', 'A-core', 'C', 4), card('main', 'A-tech2', 'R', 2), card('yell', 'Y-A', 'SY', 20)]),
  deck('decklog:B1', 'beta', [card('oshi', 'O-B', 'OSR'), card('main', 'B-core', 'C', 4), card('main', 'B-tech', 'R', 2), card('yell', 'Y-B', 'SY', 20)]),
  deck('decklog:B2', 'beta', [card('oshi', 'O-B', 'OSR'), card('main', 'B-core', 'C', 4), card('main', 'B-tech2', 'R', 2), card('yell', 'Y-B', 'SY', 20)]),
  deck('decklog:C1', 'gamma', [card('oshi', 'O-C', 'OSR'), card('main', 'C-core', 'C', 4), card('main', 'C-tech', 'R', 2), card('yell', 'Y-C', 'SY', 20)]),
  deck('decklog:C2', 'gamma', [card('oshi', 'O-C', 'OSR'), card('main', 'C-core', 'C', 4), card('main', 'C-tech2', 'R', 2), card('yell', 'Y-C', 'SY', 20)]),
];
const incomplete = deck('decklog:BAD', 'bad', [], { cardsVerified: false });
const analysis = analyzeReports([report([...decks6, incomplete])], { generatedAt: '2026-08-17T00:00:00.000Z' });

assert.equal(analysis.sampleSize, 6, 'incomplete deck excluded');
assert.equal(analysis.excludedIncompleteDecks.length, 1);
assert(analysis.vectors.featureDictionary.some((f) => f.key === 'main|A-core|NO_VERSION'));
assert(analysis.vectors.featureDictionary.some((f) => f.key === 'yell|Y-A|NO_VERSION'));
assert(
  analysis.vectors.featureDictionary.every((f) => f.versionProven === false),
  'unproven rarity labels never enter feature identity',
);

const isolated = analyzeReports([
  report([
    deck('decklog:V1', 'v', [provenCard('main', 'hBP01-001', 'alt-art', 1)]),
    deck('decklog:V2', 'v', [provenCard('main', 'hBP01-001', 'base', 1)]),
    deck('decklog:Z1', 'z', [provenCard('oshi', 'hBP01-001', 'base', 1)]),
  ]),
]);
assert.equal(isolated.vectors.featureDictionary.length, 3, 'proven version and zone isolation');

for (let i = 0; i < analysis.similarity.matrix.length; i++) {
  assert.equal(analysis.similarity.matrix[i][i], 1, 'diagonal=1');
  for (let j = 0; j < analysis.similarity.matrix.length; j++) {
    assert.equal(analysis.similarity.matrix[i][j], analysis.similarity.matrix[j][i], 'symmetric');
    assert(Number.isFinite(analysis.similarity.matrix[i][j]), 'finite similarity');
  }
}
assert(analysis.similarity.matrix[0][1] > analysis.similarity.matrix[0][2], 'known similarity ordering');
assert.deepEqual(
  analysis.clusters.map((c) => c.members),
  [['decklog:A1', 'decklog:A2'], ['decklog:B1', 'decklog:B2'], ['decklog:C1', 'decklog:C2']],
  'three obvious clusters',
);

const permuted = analyzeReports([report([decks6[5], decks6[3], decks6[1], decks6[4], decks6[2], decks6[0]])]);
assert.deepEqual(permuted.clusters.map((c) => c.members), analysis.clusters.map((c) => c.members), 'stable under input permutation');

const rel = analysis.associations.relations.find(
  (r) => r.a === 'oshi|O-A|NO_VERSION' && r.b === 'main|A-core|NO_VERSION',
);
assert(rel, 'association exists');
assert.equal(rel.count, 2);
assert.equal(rel.support, 0.333333);
assert.equal(rel.confidenceAB, 1);
assert.equal(rel.confidenceBA, 1);
assert.equal(rel.lift, 3);
assert.equal(rel.denominators.decks, 6);

const empty = analyzeReports([report([])]);
assert.equal(empty.sampleSize, 0);
assert.equal(empty.similarity.matrix.length, 0);
assert(empty.warnings.some((w) => w.includes('N=0')));
const singleton = analyzeReports([report([decks6[0]])]);
assert.equal(singleton.similarity.matrix[0][0], 1);
assert(singleton.warnings.some((w) => w.includes('N=1')));
const currentN2 = analyzeReports([report([decks6[0], decks6[2]])]);
assert(currentN2.warnings.some((w) => w.includes('N=2')));

// ── Version provenance (DIC-1042 P0) ────────────────────────────────────────
// The real regression: Deck Log publishes hBP01-108 as rarity `U` in one deck
// and `P` in another. Treating those as versions split one card into two
// features and dropped the decks' true overlap to zero.
const rarity = analyzeReports([
  report([
    deck('decklog:R1', 'r', [card('main', 'hBP01-108', 'U', 1)]),
    deck('decklog:R2', 'r', [card('main', 'hBP01-108', 'P', 1)]),
  ]),
]);
assert.deepEqual(
  rarity.vectors.featureDictionary.map((f) => f.key),
  ['main|hBP01-108|NO_VERSION'],
  'rarity labels collapse to one NO_VERSION feature',
);
assert.equal(rarity.vectors.featureDictionary[0].versionProven, false);
assert.deepEqual(rarity.vectors.featureDictionary[0].unprovenVersionLabels, ['P', 'U'], 'discarded labels stay visible');
assert.equal(rarity.similarity.matrix[0][1], 1, 'the same card must not split on rarity');
assert(rarity.warnings.some((w) => w.includes('NO_VERSION')), 'artifact warns that labels were discarded');

// A rarity token can collide with a genuine printing name. `U` as an unproven
// Deck Log rarity and `U` as a source-proven printing are different identities;
// the unproven one must never inherit the proven one's feature.
const collision = analyzeReports([
  report([
    deck('decklog:T1', 't', [card('main', 'hBP01-108', 'U', 1)]),
    deck('decklog:T2', 't', [provenCard('main', 'hBP01-108', 'U', 1)]),
  ]),
]);
assert.deepEqual(
  collision.vectors.featureDictionary.map((f) => f.key),
  ['main|hBP01-108|NO_VERSION', 'main|hBP01-108|U'],
  'an unproven token never merges into the identically named proven printing',
);
assert.equal(collision.similarity.matrix[0][1], 0);

// The provenance gate is strict: only `versionProven === true` or an
// allowlisted `versionSource` promotes a version into identity.
const gate = analyzeReports([
  report([
    deck('decklog:G1', 'g', [
      { zone: 'main', cardNumber: 'C-1', version: 'X', count: 1, versionProven: 'true' },
      { zone: 'main', cardNumber: 'C-2', version: 'X', count: 1, versionSource: 'decklogRarity' },
      { zone: 'main', cardNumber: 'C-3', version: 'X', count: 1, versionSource: 'printingId' },
      { zone: 'main', cardNumber: 'C-4', version: 'X', count: 1, versionProven: true },
    ]),
  ]),
]);
assert.deepEqual(
  gate.vectors.featureDictionary.map((f) => f.key),
  ['main|C-1|NO_VERSION', 'main|C-2|NO_VERSION', 'main|C-3|X', 'main|C-4|X'],
  'truthy-but-unproven markers and unknown sources stay NO_VERSION',
);

// ── Month scoping (DIC-1042 P1) ─────────────────────────────────────────────
// Two similar decks in different months merge into one global cluster. A month
// artifact built by filtering that global cluster reported the other month's
// representative archetype, its core cards and a presence count of 2.
const shared = () => [card('oshi', 'O-S', 'OSR'), card('main', 'SHARED', 'C', 4), card('yell', 'Y-S', 'SY', 20)];
const augReport = report([deck('decklog:A1', 'alpha', [...shared(), card('main', 'AONLY', 'R', 2)])], '2026-08');
const sepReport = report([deck('decklog:B1', 'beta', [...shared(), card('main', 'BONLY', 'R', 2)])], '2026-09');
const twoMonths = [augReport, sepReport];

const globalTwoMonths = analyzeReports(twoMonths, { generatedAt: '2026-09-01T00:00:00.000Z' });
assert.equal(globalTwoMonths.clusters.length, 1, 'fixture must actually merge across months');
assert.deepEqual(globalTwoMonths.clusters[0].members, ['decklog:A1', 'decklog:B1']);

const sep = analyzeMonth(twoMonths, '2026-09', { generatedAt: '2026-09-01T00:00:00.000Z' });
assert.equal(sep.month, '2026-09');
assert.equal(sep.sampleSize, 1);
assert.deepEqual(sep.inputDeckIds, ['decklog:B1']);
assert.deepEqual(sep.inputReports.map((r) => r.month), ['2026-09']);
assert.equal(sep.clusters.length, 1);
assert.deepEqual(sep.clusters[0].members, ['decklog:B1']);
assert.equal(sep.clusters[0].sampleCount, 1);
assert.equal(sep.clusters[0].representativeArchetype, 'beta', 'representative recomputed from the month subset');
assert.equal(sep.clusters[0].representativeOshi, 'beta');
assert(sep.clusters[0].coreCards.every((c) => c.presence === 1), 'presence recomputed against the month sample');
assert.equal(sep.associations.relations[0].denominators.decks, 1, 'association denominator is the month sample');
const sepText = stableStringify(sep);
assert(!sepText.includes('AONLY'), 'no feature leaks in from another month');
assert(!sepText.includes('decklog:A1'), 'no deck leaks in from another month');
assert.deepEqual(sep.similarity.deckIds, ['decklog:B1']);
assert.deepEqual(sep.similarity.matrix, [[1]]);

const aug = analyzeMonth(twoMonths, '2026-08', { generatedAt: '2026-09-01T00:00:00.000Z' });
assert.equal(aug.clusters[0].representativeArchetype, 'alpha');
assert(!stableStringify(aug).includes('BONLY'));

const noBadNumbers = stableStringify(analysis);
assert(!noBadNumbers.includes('NaN'));
assert(!noBadNumbers.includes('Infinity'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hocg-analytics-'));
const tournamentsDir = path.join(tmp, 'tournaments');
const outDir = path.join(tmp, 'analytics');
fs.mkdirSync(tournamentsDir, { recursive: true });
fs.writeFileSync(path.join(tournamentsDir, '2026-08.json'), JSON.stringify(report(decks6).report, null, 2));
fs.writeFileSync(path.join(tournamentsDir, '2026-09.json'), JSON.stringify(sepReport.report, null, 2));
const script = path.join(process.cwd(), 'scripts', 'analyze-tournaments.mjs');
execFileSync(process.execPath, [script, '--tournaments-dir', tournamentsDir, '--out-dir', outDir], { cwd: process.cwd(), stdio: 'pipe' });
const first = ['index.json', '2026-08.json', '2026-09.json'].map((f) => fs.readFileSync(path.join(outDir, f), 'utf8'));
execFileSync(process.execPath, [script, '--tournaments-dir', tournamentsDir, '--out-dir', outDir], { cwd: process.cwd(), stdio: 'pipe' });
const second = ['index.json', '2026-08.json', '2026-09.json'].map((f) => fs.readFileSync(path.join(outDir, f), 'utf8'));
assert.deepEqual(first, second, 'idempotent artifact generation');
assert.deepEqual(
  JSON.parse(first[0]).months.map((m) => m.month),
  ['2026-09', '2026-08'],
  'index lists every generated month',
);

console.log('test-tournament-analytics: PASS');
