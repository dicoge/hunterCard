#!/usr/bin/env node
// DIC-1380 W4 CR — Production-branch exercise for the deployment freshness gate.
//
// The PM handback called out two contract points:
//   (a) The deployment gate MUST use the same fail-closed resolver as
//       `releaseFlags.ts` and the web-export sanitizer, so unset / blank /
//       whitespace / malformed EXPO_PUBLIC_STORE_MVP all resolve to
//       Production ON — the single-resolver rule that keeps runtime and
//       deploy in lock-step.
//   (b) The Production branch of the gate MUST be EXERCISED in CI, not left
//       as a code path only Vercel Production ever runs.
//
// This suite spawns `scripts/verify-deployment-data.mjs` under each relevant
// env value with the same canonical / public database fixtures the checked-in
// data ships, then asserts:
//
//   • unset / '' / '   ' / 'yes' / 'on' / 'off' / '01' resolve to the
//     Production profile — the age check runs and reports a Production-profile
//     failure when NOW is far ahead of `lastUpdated` (mutation: stale data
//     fails closed) and passes when NOW is right after `lastUpdated`.
//   • Explicit '0' / 'false' skips the age check — a NOW 10 years past
//     `lastUpdated` still passes.
//   • Explicit '1' / 'true' runs the age check.
//   • The failure message points at the daily-refresh chain the ops team
//     needs to inspect.
//
// If any part of the gate regresses to a per-flag or per-platform default,
// one of the unset / blank / malformed cases here will flip and CI blocks.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const script = path.join(__dirname, 'verify-deployment-data.mjs');

// Read the canonical `lastUpdated` so the test computes NOW relative to what
// the checked-in data actually says — hard-coding a date would silently
// desync with the data-refresh workflow.
const canonical = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'database.json'), 'utf8'));
const lastUpdatedIso = canonical.lastUpdated;
assert.ok(lastUpdatedIso, 'canonical database must have a lastUpdated for this suite to pin the age check');
const lastUpdatedMs = Date.parse(lastUpdatedIso);
assert.ok(Number.isFinite(lastUpdatedMs), 'lastUpdated must parse as an ISO date');

function run(env) {
  const merged = { ...process.env, ...env };
  const result = spawnSync('node', [script], { cwd: repoRoot, env: merged, encoding: 'utf-8' });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function isoDaysFromLast(days) {
  return new Date(lastUpdatedMs + days * 24 * 60 * 60 * 1000).toISOString();
}

const FAILURE_HINT = 'daily catalog/scrape/official-sync chain';

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

// ── Production-resolved (fail-closed) values: the age gate runs ──────────
// A NOW 1 day past `lastUpdated` (well within the 7-day window) → pass.
// A NOW 60 days past `lastUpdated` → the Production failure message trips.
const PRODUCTION_LIKE = [
  ['unset (missing env)', undefined],
  ['"" (blank)', ''],
  ['"   " (whitespace)', '   '],
  ['"yes" (malformed truthy)', 'yes'],
  ['"on" (malformed truthy)', 'on'],
  ['"off" (malformed — not the same as false)', 'off'],
  ['"01" (malformed truthy)', '01'],
  ['"1" (explicit opt-in)', '1'],
  ['"true" (explicit opt-in)', 'true'],
  ['" 1 " (whitespace-trimmed opt-in)', ' 1 '],
];

for (const [label, value] of PRODUCTION_LIKE) {
  const envFresh = { DATABASE_NOW_ISO: isoDaysFromLast(1) };
  if (value === undefined) delete envFresh.EXPO_PUBLIC_STORE_MVP;
  else envFresh.EXPO_PUBLIC_STORE_MVP = value;
  // Spawn ignores parent env keys only when explicitly deleted from the merged
  // object; do that when the case wants the env unset.
  if (value === undefined) {
    const scrubbed = { ...process.env, ...envFresh };
    delete scrubbed.EXPO_PUBLIC_STORE_MVP;
    const result = spawnSync('node', [script], { cwd: repoRoot, env: scrubbed, encoding: 'utf-8' });
    check(`${label}: fresh data (NOW = lastUpdated + 1d) passes`, result.status === 0, result.stderr);
    const scrubbedStale = { ...scrubbed, DATABASE_NOW_ISO: isoDaysFromLast(60) };
    const stale = spawnSync('node', [script], { cwd: repoRoot, env: scrubbedStale, encoding: 'utf-8' });
    check(`${label}: stale data (NOW = lastUpdated + 60d) fails closed`, stale.status !== 0);
    check(`${label}: stale failure names the refresh chain`, (stale.stderr + stale.stdout).includes(FAILURE_HINT));
  } else {
    const fresh = run(envFresh);
    check(`${label}: fresh data passes`, fresh.code === 0, fresh.stderr);
    const stale = run({ ...envFresh, DATABASE_NOW_ISO: isoDaysFromLast(60) });
    check(`${label}: stale data fails closed`, stale.code !== 0);
    check(`${label}: stale failure names the refresh chain`, (stale.stderr + stale.stdout).includes(FAILURE_HINT));
  }
}

// ── Explicit opt-out: the age gate is skipped even 10 years stale ────────
const OPT_OUT = [
  ['"0" (explicit opt-out — Web Develop / Staging)', '0'],
  ['"false" (explicit opt-out)', 'false'],
  ['"FALSE" (case-insensitive opt-out)', 'FALSE'],
  ['" 0 " (whitespace-trimmed opt-out)', ' 0 '],
];

for (const [label, value] of OPT_OUT) {
  const env = { EXPO_PUBLIC_STORE_MVP: value, DATABASE_NOW_ISO: isoDaysFromLast(365 * 10) };
  const res = run(env);
  check(`${label}: 10-year-stale data still passes (age gate skipped)`, res.code === 0, res.stderr);
}

// ── DATABASE_MAX_AGE_DAYS override widens the window ─────────────────────
{
  const wideOverride = run({
    EXPO_PUBLIC_STORE_MVP: '1',
    DATABASE_NOW_ISO: isoDaysFromLast(60),
    DATABASE_MAX_AGE_DAYS: '365',
  });
  check('DATABASE_MAX_AGE_DAYS=365 widens the window so 60d-stale passes', wideOverride.code === 0, wideOverride.stderr);
}

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ deployment freshness gate: ${passed} checks passed`);
} else {
  console.error(`\n❌ deployment freshness gate failed`);
}
