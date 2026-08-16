#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyticsIndex,
  analyzeReports,
  loadMonthlyReports,
  monthAnalytics,
  stableStringify,
} from './tournament-analytics-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);

function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

const tournamentsDir = path.resolve(flagValue('--tournaments-dir') ?? path.join(ROOT, 'data', 'tournaments'));
const outDirs = flagValue('--out-dir')
  ? [path.resolve(flagValue('--out-dir'))]
  : [path.join(ROOT, 'data', 'tournaments', 'analytics'), path.join(ROOT, 'public', 'data', 'tournaments', 'analytics')];
const generatedAt = flagValue('--generated-at') ?? null;
const clusterThreshold = flagValue('--cluster-threshold');
const minSupport = flagValue('--min-support-count');
const config = {};
if (clusterThreshold != null) config.cluster = { threshold: Number(clusterThreshold) };
if (minSupport != null) config.association = { minSupportCount: Number(minSupport) };

const reports = loadMonthlyReports(tournamentsDir);
const full = analyzeReports(reports, { generatedAt: generatedAt ?? undefined, config });
const months = [...new Set(reports.map((entry) => entry.report.month ?? entry.fileName.slice(0, -5)))].sort();
const monthArtifacts = months.map((month) => monthAnalytics(full, month));
const index = analyticsIndex(monthArtifacts, full.generatedAt);

for (const outDir of outDirs) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.json'), stableStringify(index));
  for (const artifact of monthArtifacts) {
    const month = artifact.inputReports[0]?.month;
    if (month) fs.writeFileSync(path.join(outDir, `${month}.json`), stableStringify(artifact));
  }
}

console.log(
  JSON.stringify(
    {
      generatedAt: full.generatedAt,
      reports: reports.length,
      months,
      sampleSize: full.sampleSize,
      excludedIncompleteDecks: full.excludedIncompleteDecks.length,
      warnings: full.warnings,
      outputDirs: outDirs,
    },
    null,
    2,
  ),
);
