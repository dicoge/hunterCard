#!/usr/bin/env node
// DIC-1380 W5 CR — real scheduled refresh workflows for YT + tournament data.
//
// The W5 handback flagged that the deployment freshness gate + the daily
// runtime `hasDisplayableSubscriberStats` check are insufficient on their
// own — the release train also owes an actual, wired scheduled path that
// KEEPS those data assets fresh. A gate that fails closed against a stale
// snapshot is not the same as a refresh chain that produces new snapshots.
//
// This suite pins the two workflows the release train relies on:
//
//   * `.github/workflows/refresh-yt-stats.yml`         (DIC-1380 W5, daily)
//       — must exist, must carry a real `schedule.cron`, must run
//         `refresh:yt-stats` (which the runtime freshness gate reads
//         from), must PR into `main` via a bot-owned sync branch, must
//         invoke `generate-native-database.mjs` so the native / Store
//         MVP mirror stays in lock-step.
//
//   * `.github/workflows/collect-tournament-reports.yml`  (DIC-979 → W5)
//       — must exist, must carry a real `schedule.cron`, must run the
//         offline `collect:tournaments` collector. The DIC-979 #8 comment
//         (schedule intentionally not enabled) must be gone — the whole
//         point of this W5 correction is that the schedule IS enabled.
//
// A dropped or gutted schedule flips one of the assertions below, so the
// "real, wired" contract cannot regress silently.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const wfDir = path.join(repoRoot, '.github', 'workflows');

let passed = 0;
function check(label, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

function loadWorkflow(file) {
  const abs = path.join(wfDir, file);
  const raw = fs.readFileSync(abs, 'utf8');
  return { raw, parsed: parseYaml(raw) };
}

function firstSchedule(parsed) {
  // GitHub Actions accepts `on: { schedule: [...] }` or `on: schedule: [...]`.
  const on = parsed?.on;
  if (!on) return null;
  const schedule = Array.isArray(on?.schedule) ? on.schedule : null;
  if (!schedule) return null;
  return schedule.find((entry) => entry && typeof entry.cron === 'string') || null;
}

function isValidCron(expr) {
  if (typeof expr !== 'string') return false;
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((f) => f.length > 0);
}

// ── YT stats refresh ─────────────────────────────────────────────────────
{
  const file = 'refresh-yt-stats.yml';
  const wf = loadWorkflow(file);
  const schedule = firstSchedule(wf.parsed);
  check(`${file} exists on disk`, fs.existsSync(path.join(wfDir, file)));
  check(`${file} declares a real cron schedule`, isValidCron(schedule?.cron), `got ${JSON.stringify(schedule)}`);
  check(`${file} runs the refresh:yt-stats npm script`, wf.raw.includes('npm run refresh:yt-stats'));
  check(`${file} regenerates the native / Store MVP mirror after refresh`, wf.raw.includes('generate-native-database.mjs'));
  check(`${file} PRs into main via a bot-owned sync branch (never direct-push)`, wf.raw.includes('bot/refresh-yt-stats'));
  // DIC-1380 W6: the workflow must ACTUALLY fetch fresh upstream YT data;
  // reprocessing already-committed inputs is not a refresh. The scheduled
  // path invokes scrape-yt-subscribers.js (live YouTube fetch) before the
  // recompute step. A `skip_live_fetch` manual escape hatch is fine (it
  // requires an explicit `true` input); the DEFAULT scheduled fire is
  // live.
  check(
    `${file} performs a live upstream fetch before recompute (DIC-1380 W6)`,
    wf.raw.includes('scrape-yt-subscribers.js'),
    'schedule must fetch from YouTube, not just reprocess committed history',
  );
  check(
    `${file} stages data/yt-stats-history.json in SYNC_PATHS so the live snapshot survives`,
    /SYNC_PATHS:[\s\S]*yt-stats-history\.json/.test(wf.raw),
    'the fresh snapshot the scraper wrote must be in the sync whitelist',
  );
  // Ignore comment lines when scanning for a bare `git add -A` — comments
  // legitimately reference the anti-pattern to explain why we avoid it.
  const activeAddAllLines = wf.raw
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) return false;
      return /^git\s+add\s+-A\b/.test(trimmed) || /\bgit\s+add\s+-A\b/.test(trimmed) && !trimmed.includes('#');
    });
  check(
    `${file} declares its SYNC_PATHS whitelist (no bare git add -A in an executable line)`,
    wf.raw.includes('SYNC_PATHS:') && activeAddAllLines.length === 0,
  );
}

// ── Tournament refresh ───────────────────────────────────────────────────
{
  const file = 'collect-tournament-reports.yml';
  const wf = loadWorkflow(file);
  const schedule = firstSchedule(wf.parsed);
  check(`${file} exists on disk`, fs.existsSync(path.join(wfDir, file)));
  check(`${file} declares a real cron schedule`, isValidCron(schedule?.cron), `got ${JSON.stringify(schedule)}`);
  check(`${file} runs the collect:tournaments npm script`, wf.raw.includes('npm run collect:tournaments'));
  check(
    `${file} no longer carries the "SCHEDULE INTENTIONALLY NOT ENABLED" warning`,
    !/SCHEDULE IS INTENTIONALLY NOT ENABLED/i.test(wf.raw),
    'the DIC-979 #8 gate comment must be gone once W5 enables the schedule',
  );
  // DIC-1380 W6: the scheduled fire must invoke the LIVE collector
  // (`--live`) so fresh Deck Log source data is actually fetched. Manual
  // dispatches can still opt out via `skip_live` or `dry_run`, but the
  // default schedule flow lands on `-- --live`.
  check(
    `${file} scheduled path invokes the live collector (--live) — real upstream fetch (DIC-1380 W6)`,
    /npm run collect:tournaments -- --live/.test(wf.raw),
    'the scheduled fire must exercise the DIC-1024 live Deck Log fetch, not just the offline reprocess',
  );
}

// ── The npm scripts the workflows depend on actually exist ───────────────
{
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  check(
    'package.json declares refresh:yt-stats',
    typeof pkg.scripts?.['refresh:yt-stats'] === 'string' && pkg.scripts['refresh:yt-stats'].includes('refresh-yt-stats.mjs'),
  );
  check(
    'package.json declares collect:tournaments',
    typeof pkg.scripts?.['collect:tournaments'] === 'string' && pkg.scripts['collect:tournaments'].includes('collect-tournament-reports.mjs'),
  );
}

// ── The refresh scripts themselves exist on disk ─────────────────────────
check('scripts/refresh-yt-stats.mjs exists on disk', fs.existsSync(path.join(repoRoot, 'scripts', 'refresh-yt-stats.mjs')));
check('scripts/collect-tournament-reports.mjs exists on disk', fs.existsSync(path.join(repoRoot, 'scripts', 'collect-tournament-reports.mjs')));
check('scripts/generate-native-database.mjs exists on disk', fs.existsSync(path.join(repoRoot, 'scripts', 'generate-native-database.mjs')));

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ DIC-1380 scheduled-refresh workflows regression: ${passed} checks passed`);
} else {
  console.error(`\n❌ DIC-1380 scheduled-refresh workflows regression failed`);
}
