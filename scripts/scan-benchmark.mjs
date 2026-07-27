#!/usr/bin/env node
/**
 * HoloHunter scan accuracy benchmark runner.
 *
 * Usage:
 *   node scripts/scan-benchmark.mjs --input docs/fixtures/scan-benchmark-sample.jsonl
 *   node scripts/scan-benchmark.mjs --input results.json --output reports/scan-benchmark.md
 *
 * Input formats:
 *   - JSON array
 *   - JSONL (one record per line)
 *   - CSV with headers
 *
 * Required fields per record:
 *   image_id, expected_cardNumber, expected_rarity, expected_series
 *
 * Prediction fields (any one top-1 source):
 *   matched_cardNumber OR model_output.cardNumber OR top_matches[0].cardNumber
 *
 * Optional fields:
 *   top_matches: [{ cardNumber, rarity, series, confidence }]
 *   model_output: object|string
 *   confidence: number 0..1
 *   duplicate_count: number of session records created for this one scan
 *   failure_reason: free text
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const TARGETS = Object.freeze({ top1: 0.90, top3: 0.98, duplicateRate: 0 });

function usage(exitCode = 0) {
  console.log(`HoloHunter scan benchmark\n\nUsage:\n  node scripts/scan-benchmark.mjs --input <records.json|jsonl|csv> [--output report.md] [--json]\n\nTargets:\n  top-1 >= ${pct(TARGETS.top1)}\n  top-3 >= ${pct(TARGETS.top3)}\n  duplicate record rate = ${pct(TARGETS.duplicateRate)}\n`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') usage(0);
    if (arg === '--json') { args.json = true; continue; }
    if (arg === '--input' || arg === '-i') { args.input = argv[++i]; continue; }
    if (arg === '--output' || arg === '-o') { args.output = argv[++i]; continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.input) usage(1);
  return args;
}

function pct(value) {
  return `${(value * 100).toFixed(value === 0 || value === 1 ? 0 : 1)}%`;
}

function normalizeCardNumber(value) {
  return String(value || '')
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/\s+/g, '')
    .replace(/[‐‑‒–—―−]/g, '-')
    .toLowerCase();
}

function normalizeToken(value) {
  return String(value || '').trim().toLowerCase();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' && inQuotes && next === '"') { cell += '"'; i += 1; continue; }
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { row.push(cell); cell = ''; continue; }
    if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = [];
      continue;
    }
    cell += ch;
  }
  row.push(cell);
  if (row.some(v => v.trim() !== '')) rows.push(row);
  if (rows.length === 0) return [];

  const headers = rows.shift().map(h => h.trim());
  return rows.map(values => Object.fromEntries(headers.map((h, idx) => [h, values[idx] ?? ''])));
}

function coerceRecord(record) {
  const topMatches = Array.isArray(record.top_matches)
    ? record.top_matches
    : Array.isArray(record.topMatches)
      ? record.topMatches
      : parseJsonMaybe(record.top_matches || record.topMatches, []);
  const modelOutput = typeof record.model_output === 'object'
    ? record.model_output
    : parseJsonMaybe(record.model_output || record.modelOutput, record.model_output || record.modelOutput || '');
  const rawDuplicateCount = record.duplicate_count ?? record.duplicateCount;

  return {
    ...record,
    image_id: record.image_id || record.imageId,
    expected_cardNumber: record.expected_cardNumber || record.expectedCardNumber,
    expected_rarity: record.expected_rarity || record.expectedRarity,
    expected_series: record.expected_series || record.expectedSeries,
    matched_cardNumber: record.matched_cardNumber || record.matchedCardNumber,
    duplicate_count: rawDuplicateCount === undefined || rawDuplicateCount === '' ? null : Number(rawDuplicateCount),
    confidence: numberOrNull(record.confidence),
    top_matches: topMatches,
    model_output: modelOutput,
  };
}

function parseJsonMaybe(value, fallback) {
  if (typeof value !== 'string') return value ?? fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  try { return JSON.parse(trimmed); } catch { return fallback; }
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function predictedTopMatches(record) {
  const matches = [];
  if (record.matched_cardNumber) {
    matches.push({ cardNumber: record.matched_cardNumber, rarity: record.matched_rarity, series: record.matched_series, confidence: record.confidence });
  }
  if (record.model_output && typeof record.model_output === 'object' && record.model_output.cardNumber) {
    matches.push({
      cardNumber: record.model_output.cardNumber,
      rarity: record.model_output.rarity,
      series: record.model_output.series,
      confidence: record.model_output.confidence ?? record.confidence,
    });
  }
  for (const m of record.top_matches || []) matches.push(m);

  const seen = new Set();
  return matches.filter(m => {
    const key = `${normalizeCardNumber(m?.cardNumber)}|${normalizeToken(m?.rarity)}|${normalizeToken(m?.series)}`;
    if (!normalizeCardNumber(m?.cardNumber) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function matchExpected(match, record) {
  const sameNumber = normalizeCardNumber(match?.cardNumber) === normalizeCardNumber(record.expected_cardNumber);
  const rarityExpected = normalizeToken(record.expected_rarity);
  const seriesExpected = normalizeToken(record.expected_series);
  const sameRarity = !rarityExpected || normalizeToken(match?.rarity) === rarityExpected;
  const sameSeries = !seriesExpected || normalizeToken(match?.series) === seriesExpected;
  return sameNumber && sameRarity && sameSeries;
}

function validate(records) {
  const errors = [];
  records.forEach((r, idx) => {
    for (const f of ['image_id', 'expected_cardNumber', 'expected_rarity', 'expected_series']) {
      if (!r[f]) errors.push(`record ${idx + 1}: missing ${f}`);
    }
    if (r.duplicate_count == null) {
      errors.push(`record ${idx + 1}: missing duplicate_count`);
    } else if (!Number.isFinite(r.duplicate_count) || r.duplicate_count < 0) {
      errors.push(`record ${idx + 1}: duplicate_count must be a non-negative number`);
    }
  });
  return errors;
}

function evaluate(records) {
  const rows = records.map(record => {
    const top = predictedTopMatches(record);
    const top1Pass = top.length > 0 && matchExpected(top[0], record);
    const top3Pass = top.slice(0, 3).some(m => matchExpected(m, record));
    const duplicatePass = record.duplicate_count === 1;
    const confidence = record.confidence ?? numberOrNull(top[0]?.confidence);
    const failureReasons = [];
    if (!top1Pass) failureReasons.push('top-1 mismatch');
    if (!top3Pass) failureReasons.push('top-3 miss');
    if (!duplicatePass) failureReasons.push(`duplicate_count=${record.duplicate_count}`);
    if (record.failure_reason) failureReasons.push(record.failure_reason);
    return { record, top, top1Pass, top3Pass, duplicatePass, confidence, failureReasons };
  });

  const total = rows.length;
  const top1 = rows.filter(r => r.top1Pass).length / total;
  const top3 = rows.filter(r => r.top3Pass).length / total;
  const duplicateFailures = rows.filter(r => !r.duplicatePass).length;
  const duplicateRate = duplicateFailures / total;
  const lowConfidenceWrong = rows.filter(r => !r.top1Pass && r.confidence != null && r.confidence < 0.75).length;
  const sameNumberDifferentVariantFailures = rows.filter(r => {
    const first = r.top[0];
    return first && normalizeCardNumber(first.cardNumber) === normalizeCardNumber(r.record.expected_cardNumber) && !r.top1Pass;
  }).length;

  return {
    targets: TARGETS,
    summary: {
      total,
      top1,
      top1_passed: top1 >= TARGETS.top1,
      top3,
      top3_passed: top3 >= TARGETS.top3,
      duplicateRate,
      duplicate_passed: duplicateRate === TARGETS.duplicateRate,
      duplicateFailures,
      lowConfidenceWrong,
      sameNumberDifferentVariantFailures,
      overall_passed: top1 >= TARGETS.top1 && top3 >= TARGETS.top3 && duplicateRate === TARGETS.duplicateRate,
    },
    failures: rows.filter(r => r.failureReasons.length > 0).map(r => ({
      image_id: r.record.image_id,
      expected: {
        cardNumber: r.record.expected_cardNumber,
        rarity: r.record.expected_rarity,
        series: r.record.expected_series,
      },
      top1: r.top[0] || null,
      confidence: r.confidence,
      duplicate_count: r.record.duplicate_count,
      reasons: r.failureReasons,
    })),
    rows,
  };
}

function renderMarkdown(result, sourcePath) {
  const s = result.summary;
  const lines = [
    '# HoloHunter Scan Benchmark Report',
    '',
    `Source: \`${sourcePath}\``,
    '',
    '## Summary',
    '',
    '| Metric | Result | Target | Status |',
    '|---|---:|---:|---|',
    `| Top-1 accuracy | ${pct(s.top1)} | ≥ ${pct(TARGETS.top1)} | ${s.top1_passed ? 'PASS' : 'FAIL'} |`,
    `| Top-3 accuracy | ${pct(s.top3)} | ≥ ${pct(TARGETS.top3)} | ${s.top3_passed ? 'PASS' : 'FAIL'} |`,
    `| Duplicate record rate | ${pct(s.duplicateRate)} | ${pct(TARGETS.duplicateRate)} | ${s.duplicate_passed ? 'PASS' : 'FAIL'} |`,
    '',
    `Overall: **${s.overall_passed ? 'PASS' : 'FAIL'}** (${s.total} images)`,
    '',
    '## Regression counters',
    '',
    `- Duplicate scan records: ${s.duplicateFailures}`,
    `- Low-confidence wrong matches (<0.75): ${s.lowConfidenceWrong}`,
    `- Same card number but wrong rarity/series: ${s.sameNumberDifferentVariantFailures}`,
    '',
  ];

  if (result.failures.length) {
    lines.push('## Failures', '', '| image_id | expected | top-1 | confidence | duplicate_count | reasons |', '|---|---|---|---:|---:|---|');
    for (const f of result.failures) {
      const expected = `${f.expected.cardNumber} / ${f.expected.rarity} / ${f.expected.series}`;
      const top1 = f.top1 ? `${f.top1.cardNumber || ''} / ${f.top1.rarity || ''} / ${f.top1.series || ''}` : 'NO MATCH';
      lines.push(`| ${f.image_id} | ${expected} | ${top1} | ${f.confidence ?? ''} | ${f.duplicate_count} | ${f.reasons.join('; ')} |`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

async function loadRecords(filePath) {
  const text = await readFile(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();
  let raw;
  if (ext === '.csv') raw = parseCsv(text);
  else {
    try { raw = JSON.parse(text); }
    catch {
      raw = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line));
    }
  }
  if (!Array.isArray(raw) && raw && typeof raw === 'object') raw = [raw];
  if (!Array.isArray(raw)) throw new Error('Input must be a JSON array, JSON object, JSONL, or CSV table');
  return raw.map(coerceRecord);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const records = await loadRecords(args.input);
  const errors = validate(records);
  if (records.length === 0) errors.push('input contains no benchmark records');
  if (errors.length) throw new Error(`Invalid benchmark input:\n- ${errors.join('\n- ')}`);

  const result = evaluate(records);
  if (args.json) {
    const printable = { targets: result.targets, summary: result.summary, failures: result.failures };
    const jsonText = `${JSON.stringify(printable, null, 2)}\n`;
    if (args.output) {
      await mkdir(path.dirname(args.output), { recursive: true });
      await writeFile(args.output, jsonText);
    } else process.stdout.write(jsonText);
  } else {
    const md = renderMarkdown(result, args.input);
    if (args.output) {
      await mkdir(path.dirname(args.output), { recursive: true });
      await writeFile(args.output, md);
    } else process.stdout.write(md);
  }

  process.exitCode = result.summary.overall_passed ? 0 : 2;
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
