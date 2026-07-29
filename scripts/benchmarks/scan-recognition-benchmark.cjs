#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const ts = require('typescript');

const datasetPath = path.resolve(__dirname, '../../data/benchmarks/scan-recognition-v1.json');
const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
const strictAcceptance = process.argv.includes('--acceptance');

function loadApiRanking() {
  const src = path.resolve(__dirname, '../../api/recognize-card.ts');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-recognition-api-'));
  const out = path.join(outDir, 'recognize-card.cjs');
  let code = fs.readFileSync(src, 'utf8');
  code = code.replace(/^export const config = .*$/m, '');
  code = code.replace(/export default async function handler/, 'async function handler');
  fs.writeFileSync(out, ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
  }).outputText);
  const mod = require(out);
  return { rankCandidates: mod.rankCandidates, cleanup: () => fs.rmSync(outDir, { recursive: true, force: true }) };
}

function loadCards() {
  const dbPath = path.resolve(__dirname, '../../data/database.json');
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  return db.cards || {};
}

function flattenGroups() {
  if (Array.isArray(dataset.groups)) return dataset.groups;
  return [{ id: 'legacy', purpose: 'unit-smoke', acceptanceEvidence: false, samples: dataset.samples || [] }];
}

function wilson(successes, total, z = 1.96) {
  if (total === 0) return null;
  const phat = successes / total;
  const denom = 1 + z * z / total;
  const center = (phat + z * z / (2 * total)) / denom;
  const margin = z * Math.sqrt((phat * (1 - phat) + z * z / (4 * total)) / total) / denom;
  return {
    low: Number(Math.max(0, center - margin).toFixed(4)),
    high: Number(Math.min(1, center + margin).toFixed(4)),
  };
}

function scoreGroup(group, cards, rankCandidates) {
  let top1 = 0;
  let top3 = 0;
  const samples = group.samples || [];
  const results = samples.map(sample => {
    const ranked = rankCandidates(cards, sample.extracted || {});
    const top = ranked.candidates.slice(0, 3).map(r => r.cardNumber);
    const ok1 = top[0] === sample.expectedCardNumber;
    const ok3 = top.includes(sample.expectedCardNumber);
    if (ok1) top1++;
    if (ok3) top3++;
    return {
      id: sample.id,
      expected: sample.expectedCardNumber,
      top,
      confidence: ranked.confidence,
      reason: ranked.reason,
      conditions: sample.conditions || [],
      ok1,
      ok3,
    };
  });
  const total = samples.length;
  return {
    id: group.id,
    purpose: group.purpose,
    acceptanceEvidence: !!group.acceptanceEvidence,
    samples: total,
    top1: total ? top1 / total : null,
    top3: total ? top3 / total : null,
    top1Wilson95: wilson(top1, total),
    top3Wilson95: wilson(top3, total),
    targets: dataset.targets,
    requiredCoverage: group.requiredCoverage || [],
    results,
  };
}

const { rankCandidates, cleanup } = loadApiRanking();
try {
  const cards = loadCards();
  const groups = flattenGroups();
  const summaries = groups.map(group => scoreGroup(group, cards, rankCandidates));
  const acceptance = summaries.filter(s => s.acceptanceEvidence);
  const smoke = summaries.filter(s => !s.acceptanceEvidence);
  const output = {
    version: dataset.version,
    databaseCards: Object.keys(cards).length,
    confidenceInterval: dataset.confidenceInterval || { method: 'wilson', level: 0.95 },
    summaries,
    acceptanceStatus: acceptance.some(s => s.samples > 0) ? 'measured' : 'missing-consented-real-camera-corpus',
  };
  console.log(JSON.stringify(output, null, 2));

  const smokeFailed = smoke.some(s => s.samples > 0 && (s.top1 < dataset.targets.top1 || s.top3 < dataset.targets.top3));
  const acceptanceFailed = acceptance.some(s => s.samples > 0 && (s.top1 < dataset.targets.top1 || s.top3 < dataset.targets.top3));
  const acceptanceMissing = acceptance.some(s => s.samples === 0);
  if (smokeFailed || acceptanceFailed || (strictAcceptance && acceptanceMissing)) process.exit(1);
} finally {
  cleanup();
}
