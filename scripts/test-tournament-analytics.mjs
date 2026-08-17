#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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

// ── Core cards are a definition, not a top-N preview (DIC-1045) ─────────────
// `coreCards` means "present in every member deck". A silent slice(0, 20)
// published that definition while omitting valid members of the set, so a
// cluster with more than 20 core features must report all of them.
const wideCards = Array.from({ length: 25 }, (_, i) => card('main', `CORE-${String(i + 1).padStart(2, '0')}`, 'C', 1));
const wide = analyzeReports([
  report([
    deck('decklog:W1', 'wide', [...wideCards, card('main', 'W1-ONLY', 'R', 1)]),
    deck('decklog:W2', 'wide', [...wideCards, card('main', 'W2-ONLY', 'R', 1)]),
  ]),
]);
assert.equal(wide.clusters.length, 1, 'fixture must form a single cluster');
assert.equal(wide.clusters[0].sampleCount, 2);
const wideCore = wide.clusters[0].coreCards;
assert.equal(wideCore.length, 25, 'every feature shared by all members is reported, not the first 20');
assert.equal(wide.clusters[0].coreCardCount, 25);
assert(wideCore.every((c) => c.presence === 2), 'core cards are present in every member deck');
assert(
  wideCore.some((c) => c.cardNumber === 'CORE-25'),
  'core cards past the old 20-item cut are not dropped',
);
assert(
  !wideCore.some((c) => c.cardNumber === 'W1-ONLY' || c.cardNumber === 'W2-ONLY'),
  'features missing from a member deck are not core',
);
// The differentiating list stays a ranked preview, but says so explicitly.
assert.equal(wide.clusters[0].differentiatingCardsPreviewLimit, 12);
assert.equal(wide.clusters[0].differentiatingCardsTotal, 27);
assert.equal(wide.clusters[0].differentiatingCards.length, 12);

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

// ── Committed-artifact consistency (DIC-1065 / CR fix) ──────────────────────
// The analytics file must record the live content SHA-256 of every report it
// consumed.  If someone re-runs the collector (changing the report) but forgets
// to re-run analytics, the embedded hash diverges and downstream consumers see
// stale data.  This block catches that class of drift on committed files.
const ROOT = path.resolve(import.meta.dirname, '..');
const REPORTS_DIR = path.join(ROOT, 'data', 'tournaments');
const ANALYTICS_DIR = path.join(ROOT, 'data', 'tournaments', 'analytics');
const PUBLIC_ANALYTICS_DIR = path.join(ROOT, 'public', 'data', 'tournaments', 'analytics');
const PUBLIC_REPORTS_DIR = path.join(ROOT, 'public', 'data', 'tournaments');

function committedSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath, 'utf8')).digest('hex');
}

const committedMonths = fs
  .readdirSync(REPORTS_DIR)
  .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
  .map((f) => f.replace('.json', ''));

for (const month of committedMonths) {
  const reportPath = path.join(REPORTS_DIR, `${month}.json`);
  const analyticsPath = path.join(ANALYTICS_DIR, `${month}.json`);
  if (!fs.existsSync(analyticsPath)) continue;

  const reportHash = committedSha256(reportPath);
  const analytics = JSON.parse(fs.readFileSync(analyticsPath, 'utf8'));

  // inputReports must be a non-empty array for months that produced decks
  assert.ok(Array.isArray(analytics.inputReports), `${month} analytics must have inputReports array`);
  assert.ok(analytics.inputReports.length > 0, `${month} analytics inputReports must not be empty`);

  // The expected month entry must exist in inputReports
  const matchingInputReport = analytics.inputReports.find((ir) => ir.month === month);
  assert.ok(matchingInputReport, `${month} analytics must contain an inputReport for month ${month}`);

  for (const ir of analytics.inputReports) {
    assert.equal(
      ir.contentSha256,
      reportHash,
      `analytics ${month}.json inputReport contentSha256 must match live report hash`,
    );
    assert.equal(ir.file, `${month}.json`, 'inputReport file field must reference the report');
    assert.ok(ir.generatedAt, 'inputReport must have a generatedAt timestamp');
    assert.ok(ir.month, 'inputReport must have a month field');
  }

  // Every deck in the analytics must carry the correct sourceReportHash —
  // this is the mutation-sensitive check that prevents a bogus hash from
  // slipping through when only inputReports is fixed but decks are not.
  for (const dk of analytics.decks ?? []) {
    assert.equal(
      dk.sourceReportHash,
      reportHash,
      `analytics ${month}.json deck ${dk.deckId} sourceReportHash must equal the live report hash`,
    );
  }

  // data/ and public/ mirrors must be byte-identical
  const publicAnalyticsPath = path.join(PUBLIC_ANALYTICS_DIR, `${month}.json`);
  assert.ok(fs.existsSync(publicAnalyticsPath), `public mirror of analytics ${month}.json must exist`);
  assert.equal(
    fs.readFileSync(analyticsPath, 'utf8'),
    fs.readFileSync(publicAnalyticsPath, 'utf8'),
    `data/ and public/ analytics ${month}.json must be byte-identical`,
  );

  const publicReportPath = path.join(PUBLIC_REPORTS_DIR, `${month}.json`);
  assert.ok(fs.existsSync(publicReportPath), `public mirror of report ${month}.json must exist`);
  assert.equal(
    fs.readFileSync(reportPath, 'utf8'),
    fs.readFileSync(publicReportPath, 'utf8'),
    `data/ and public/ report ${month}.json must be byte-identical`,
  );
}

// ── Deterministic regeneration comparison (preferred CR proof) ───────────────
// Re-run analytics CLI against the committed reports and byte-compare the
// output.  This proves the committed artifacts are exactly what the code
// produces, not hand-patched hashes.
const tmpArtifact = fs.mkdtempSync(path.join(os.tmpdir(), 'hocg-artifact-'));
const tmpTournaments = path.join(tmpArtifact, 'tournaments');
const tmpAnalytics = path.join(tmpArtifact, 'analytics');
fs.mkdirSync(tmpTournaments, { recursive: true });
// Copy committed reports into the temp dir
for (const month of committedMonths) {
  const src = path.join(REPORTS_DIR, `${month}.json`);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(tmpTournaments, `${month}.json`));
  }
}
const analyzeScript = path.join(ROOT, 'scripts', 'analyze-tournaments.mjs');
execFileSync(process.execPath, [analyzeScript, '--tournaments-dir', tmpTournaments, '--out-dir', tmpAnalytics], {
  cwd: ROOT,
  stdio: 'pipe',
});
for (const month of committedMonths) {
  const generated = path.join(tmpAnalytics, `${month}.json`);
  if (!fs.existsSync(generated)) continue;
  const committed = path.join(ANALYTICS_DIR, `${month}.json`);
  assert.equal(
    fs.readFileSync(generated, 'utf8'),
    fs.readFileSync(committed, 'utf8'),
    `analytics ${month}.json must be byte-identical to deterministic regeneration`,
  );
}
// Also verify the regenerated analytics pass the same deck sourceReportHash checks
for (const month of committedMonths) {
  const generated = path.join(tmpAnalytics, `${month}.json`);
  if (!fs.existsSync(generated)) continue;
  const reportHash = committedSha256(path.join(tmpTournaments, `${month}.json`));
  const gen = JSON.parse(fs.readFileSync(generated, 'utf8'));
  for (const dk of gen.decks ?? []) {
    assert.equal(
      dk.sourceReportHash,
      reportHash,
      `regenerated ${month}.json deck ${dk.deckId} sourceReportHash must equal report hash`,
    );
  }
  assert.ok(gen.inputReports?.length > 0, `regenerated ${month}.json inputReports must not be empty`);
  for (const ir of gen.inputReports) {
    assert.equal(ir.contentSha256, reportHash, `regenerated ${month}.json inputReport hash must match`);
  }
}

console.log('test-tournament-analytics: PASS');
