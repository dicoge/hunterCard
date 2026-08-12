#!/usr/bin/env node
/**
 * DIC-979 monthly tournament-report collector.
 *
 * Reads human-verified source records under data/tournaments/sources/*.json
 * (each tagged with the month it covers) and produces per-month normalized
 * reports plus an index, written to both data/tournaments/ and
 * public/data/tournaments/ (the app fetches from /data/... i.e. public/).
 *
 * Design goals from the issue:
 *   • Incremental & idempotent: re-runs merge with last-known-good, never
 *     duplicate events/decks (dedupe by eventId / deckId in the shared core).
 *   • Change detection: only rewrites a month when its stable content changed,
 *     so a scheduled run that finds nothing new is a no-op (no churn commit).
 *   • Silent preservation + explicit alert: a source that fails to read/parse
 *     does NOT clobber the existing good report for its month; the failure is
 *     collected into an alert report printed at the end (and to
 *     data/tournaments/collector-alerts.json).
 *   • Honest by construction: all normalization goes through the shared pure
 *     core (src/utils/tournamentReport.ts) which preserves unknowns.
 *
 * Live network fetching is intentionally NOT enabled: the official column DOM
 * contract and its ToS/robots posture are not verified in this slice, so the
 * collector runs OFFLINE from committed source files. `--live` is a guarded
 * stub that refuses to run until that evidence passes (issue requirement 8).
 *
 * Run:
 *   node --experimental-strip-types --import ./scripts/register-ts.mjs \
 *     scripts/collect-tournament-reports.mjs [--dry-run] [--now <iso>] [--live]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeEvent,
  buildMonthlyReport,
  mergeMonthlyReport,
  reportContentKey,
} from '../src/utils/tournamentReport.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIVE = args.includes('--live');
const nowFlagIdx = args.indexOf('--now');
const NOW = nowFlagIdx >= 0 ? args[nowFlagIdx + 1] : new Date().toISOString();

const SOURCES_DIR = path.join(ROOT, 'data', 'tournaments', 'sources');
const OUT_DIRS = [
  path.join(ROOT, 'data', 'tournaments'),
  path.join(ROOT, 'public', 'data', 'tournaments'),
];

const alerts = [];
function alert(level, message, extra = {}) {
  alerts.push({ level, message, ...extra });
  const tag = level === 'error' ? '❌' : level === 'warn' ? '⚠️ ' : 'ℹ️ ';
  console.error(`${tag} ${message}`);
}

// Bounded-retry helper reserved for the future live path. Kept here so the
// retry/backoff policy lives with the collector, not scattered per-source.
export async function fetchWithRetry(url, { retries = 3, backoffMs = 800 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, backoffMs * attempt));
      }
    }
  }
  throw lastErr;
}

function readJsonSafe(file) {
  try {
    return { ok: true, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function loadExistingReport(month) {
  const file = path.join(ROOT, 'data', 'tournaments', `${month}.json`);
  if (!fs.existsSync(file)) return null;
  const r = readJsonSafe(file);
  return r.ok ? r.data : null;
}

function writeJson(fileName, obj) {
  const json = JSON.stringify(obj, null, 2) + '\n';
  for (const dir of OUT_DIRS) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fileName), json);
  }
}

// Write only when the stable portion changed, preserving the prior generatedAt
// so an unchanged scheduled run produces no diff (no churn commit).
function writeStable(fileName, obj, stableFn) {
  const canonical = path.join(ROOT, 'data', 'tournaments', fileName);
  let toWrite = obj;
  let changed = true;
  if (fs.existsSync(canonical)) {
    const prev = readJsonSafe(canonical);
    if (prev.ok && stableFn(prev.data) === stableFn(obj)) {
      changed = false;
      toWrite = { ...obj, generatedAt: prev.data.generatedAt };
    }
  }
  if (changed && !DRY_RUN) writeJson(fileName, toWrite);
  return changed;
}

function main() {
  if (LIVE) {
    alert(
      'error',
      'Live fetch is disabled: official-column DOM contract and ToS/robots ' +
        'evidence are not verified yet (issue #8). Run offline from committed ' +
        'source files instead. Aborting.',
    );
    finish(1);
    return;
  }

  if (!fs.existsSync(SOURCES_DIR)) {
    alert('error', `No sources directory at ${path.relative(ROOT, SOURCES_DIR)}`);
    finish(1);
    return;
  }

  const sourceFiles = fs
    .readdirSync(SOURCES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();

  if (sourceFiles.length === 0) {
    alert('warn', 'No source files found; nothing to collect.');
  }

  // Group verified source events by their declared month. A per-file failure is
  // recorded as an alert and skipped — it must not drop other files' data.
  const byMonth = new Map(); // month -> { events: TournamentEvent[], source }
  for (const file of sourceFiles) {
    const full = path.join(SOURCES_DIR, file);
    const r = readJsonSafe(full);
    if (!r.ok) {
      alert('error', `Failed to parse source ${file}: ${r.error.message}`, {
        file,
      });
      continue;
    }
    const src = r.data;
    if (!src.month || !Array.isArray(src.events)) {
      alert('error', `Source ${file} missing "month" or "events[]"; skipped.`, {
        file,
      });
      continue;
    }
    const bucket = byMonth.get(src.month) ?? { events: [], source: src.source };
    for (const rawEvent of src.events) {
      try {
        bucket.events.push(normalizeEvent(rawEvent, NOW));
      } catch (err) {
        alert('error', `Bad event in ${file}: ${err.message}`, { file });
      }
    }
    if (src.source) bucket.source = src.source;
    byMonth.set(src.month, bucket);
  }

  const summary = [];
  const months = [...byMonth.keys()].sort();

  for (const month of months) {
    const { events, source } = byMonth.get(month);
    const existing = loadExistingReport(month);

    // Merge with last-known-good so a partial re-run never drops prior events.
    const merged = mergeMonthlyReport(existing, events, {
      month,
      generatedAt: NOW,
      source,
    });

    const changed =
      !existing || reportContentKey(existing) !== reportContentKey(merged);

    // Preserve the prior generatedAt when nothing changed → stable, no churn.
    const report =
      changed || !existing
        ? merged
        : { ...merged, generatedAt: existing.generatedAt };

    summary.push({
      month,
      events: report.events.length,
      observedDecks: report.observedSampleSize,
      changed,
    });

    if (changed && !DRY_RUN) {
      writeJson(`${month}.json`, report);
    }
  }

  // Rebuild the month index from the (post-merge) reports on disk / in memory.
  const indexMonths = summary
    .map((s) => ({
      month: s.month,
      events: s.events,
      observedDecks: s.observedDecks,
    }))
    .sort((a, b) => b.month.localeCompare(a.month));
  const index = {
    schemaVersion: 1,
    generatedAt: NOW,
    months: indexMonths,
  };
  writeStable('index.json', index, (o) => JSON.stringify(o.months));

  // ── Report ────────────────────────────────────────────────────────────────
  console.log('\n=== Tournament report collection ===');
  console.log(`mode: ${DRY_RUN ? 'DRY-RUN (no files written)' : 'WRITE'}`);
  console.log(`sources: ${sourceFiles.length} file(s)`);
  for (const s of summary) {
    console.log(
      `  ${s.month}: ${s.events} event(s), ${s.observedDecks} observed deck(s)` +
        `${s.changed ? '  [changed]' : '  [unchanged]'}`,
    );
  }
  console.log(`alerts: ${alerts.length}`);

  writeStable(
    'collector-alerts.json',
    { generatedAt: NOW, alerts },
    (o) => JSON.stringify(o.alerts),
  );

  // A source failure preserves last-known-good (above) but still surfaces as a
  // non-zero exit so a scheduler treats it as an incident, not a clean run.
  const hasError = alerts.some((a) => a.level === 'error');
  finish(hasError ? 1 : 0);
}

function finish(code) {
  if (alerts.length > 0) {
    console.log('\n--- alert detail ---');
    console.log(JSON.stringify(alerts, null, 2));
  }
  process.exit(code);
}

main();
