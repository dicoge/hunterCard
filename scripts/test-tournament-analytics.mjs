#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
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
assert(analysis.vectors.featureDictionary.some((f) => f.key === 'main|A-core|C'));
assert(analysis.vectors.featureDictionary.some((f) => f.key === 'yell|Y-A|SY'));
assert(!analysis.vectors.featureDictionary.some((f) => f.key.includes('NO_VERSION') && f.cardNumber === 'A-core'));

const isolated = analyzeReports([
  report([
    deck('decklog:V1', 'v', [card('main', 'hBP01-001', 'C', 1)]),
    deck('decklog:V2', 'v', [card('main', 'hBP01-001', 'R', 1)]),
    deck('decklog:Z1', 'z', [card('oshi', 'hBP01-001', 'C', 1)]),
  ]),
]);
assert.equal(isolated.vectors.featureDictionary.length, 3, 'version and zone isolation');

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

const rel = analysis.associations.relations.find((r) => r.a === 'oshi|O-A|OSR' && r.b === 'main|A-core|C');
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

const noBadNumbers = stableStringify(analysis);
assert(!noBadNumbers.includes('NaN'));
assert(!noBadNumbers.includes('Infinity'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hocg-analytics-'));
const tournamentsDir = path.join(tmp, 'tournaments');
const outDir = path.join(tmp, 'analytics');
fs.mkdirSync(tournamentsDir, { recursive: true });
fs.writeFileSync(path.join(tournamentsDir, '2026-08.json'), JSON.stringify(report(decks6).report, null, 2));
const script = path.join(process.cwd(), 'scripts', 'analyze-tournaments.mjs');
execFileSync(process.execPath, [script, '--tournaments-dir', tournamentsDir, '--out-dir', outDir], { cwd: process.cwd(), stdio: 'pipe' });
const first = fs.readFileSync(path.join(outDir, '2026-08.json'), 'utf8');
execFileSync(process.execPath, [script, '--tournaments-dir', tournamentsDir, '--out-dir', outDir], { cwd: process.cwd(), stdio: 'pipe' });
const second = fs.readFileSync(path.join(outDir, '2026-08.json'), 'utf8');
assert.equal(first, second, 'idempotent artifact generation');

console.log('test-tournament-analytics: PASS');
