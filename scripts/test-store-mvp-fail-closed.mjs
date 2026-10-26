#!/usr/bin/env node
// DIC-1380 user correction proof: EXPO_PUBLIC_STORE_MVP must fail closed on
// every Production surface, on every platform, whenever the define is missing,
// blank, or malformed.
//
// Before DIC-1380, `releaseFlags.ts` fell back to `Platform.OS !== 'web'` when
// the define was unresolved — Web Production would ship the full app whenever
// the deploy profile forgot to inject `EXPO_PUBLIC_STORE_MVP=1`. The Web
// Release Train's whole point is that Web Production ships the same allowlist
// as native Production, so the per-platform fallback is removed and every
// unresolved value now resolves to `STORE_MVP=true` (fail-closed).
//
// This test spawns the resolver in isolated subprocesses so the module cache
// does not carry a resolved STORE_MVP between env values, then asserts:
//
//   • `EXPO_PUBLIC_STORE_MVP=1|true`     → STORE_MVP=true, every FEATURES.* off
//   • `EXPO_PUBLIC_STORE_MVP=0|false`    → STORE_MVP=false, every FEATURES.* on
//   • unset / blank / whitespace / yes / off / 01 / on
//                                          → STORE_MVP=true, every FEATURES.* off
//
// If the fallback ever regresses to a per-platform default, one of the
// unresolved cases will flip and this test fails. Coordinator-only proof —
// no react-native-web render is needed because the resolution rule lives
// entirely inside `releaseFlags.ts`.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const probePath = path.join(__dirname, 'lib', 'store-mvp-resolve-probe.mjs');

function runProbe(envValue) {
  const env = { ...process.env };
  if (envValue === undefined) delete env.EXPO_PUBLIC_STORE_MVP;
  else env.EXPO_PUBLIC_STORE_MVP = envValue;

  const result = spawnSync('node', [
    '--experimental-strip-types',
    '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
    probePath,
  ], {
    cwd: repoRoot,
    env,
    encoding: 'utf-8',
  });

  if (result.status !== 0) {
    console.error(`\n── probe FAILED (EXPO_PUBLIC_STORE_MVP=${JSON.stringify(envValue)}) ──`);
    if (result.stderr) console.error(result.stderr);
    if (result.stdout) console.error('\n--- stdout ---\n' + result.stdout);
    throw new Error(`probe exit status ${result.status}`);
  }

  const lines = result.stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch { /* keep looking */ }
  }
  throw new Error(`probe stdout produced no JSON. stdout:\n${result.stdout}`);
}

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

const GATED_FLAGS = [
  'favorites',
  'marketData',
  'externalPriceLinks',
  'buyPrice',
  'priceSpread',
  'trendPrediction',
  'newsSentiment',
  'ytStats',
  'watchlist',
  'pushAlerts',
  'premium',
];

function assertClosed(label, envValue) {
  const res = runProbe(envValue);
  check(
    `${label}: STORE_MVP === true (fail-closed)`,
    res.storeMvp === true,
    `got STORE_MVP=${res.storeMvp} for EXPO_PUBLIC_STORE_MVP=${JSON.stringify(envValue)}`,
  );
  for (const flag of GATED_FLAGS) {
    check(
      `${label}: FEATURES.${flag} === false`,
      res.features[flag] === false,
      `got ${JSON.stringify(res.features[flag])}`,
    );
  }
}

function assertOpen(label, envValue) {
  const res = runProbe(envValue);
  check(
    `${label}: STORE_MVP === false (full app)`,
    res.storeMvp === false,
    `got STORE_MVP=${res.storeMvp} for EXPO_PUBLIC_STORE_MVP=${JSON.stringify(envValue)}`,
  );
  for (const flag of GATED_FLAGS) {
    check(
      `${label}: FEATURES.${flag} === true`,
      res.features[flag] === true,
      `got ${JSON.stringify(res.features[flag])}`,
    );
  }
}

console.log('── Explicit opt-in: EXPO_PUBLIC_STORE_MVP=1 / true ──');
assertClosed('EXPO_PUBLIC_STORE_MVP="1"', '1');
assertClosed('EXPO_PUBLIC_STORE_MVP="true"', 'true');
assertClosed('EXPO_PUBLIC_STORE_MVP="TRUE" (case-insensitive)', 'TRUE');
assertClosed('EXPO_PUBLIC_STORE_MVP=" 1 " (whitespace trimmed)', ' 1 ');

console.log('\n── Explicit opt-out: EXPO_PUBLIC_STORE_MVP=0 / false ──');
assertOpen('EXPO_PUBLIC_STORE_MVP="0"', '0');
assertOpen('EXPO_PUBLIC_STORE_MVP="false"', 'false');
assertOpen('EXPO_PUBLIC_STORE_MVP="FALSE" (case-insensitive)', 'FALSE');
assertOpen('EXPO_PUBLIC_STORE_MVP=" 0 " (whitespace trimmed)', ' 0 ');

console.log('\n── Unresolved values must fail closed on ALL platforms ──');
assertClosed('EXPO_PUBLIC_STORE_MVP unset', undefined);
assertClosed('EXPO_PUBLIC_STORE_MVP="" (blank string)', '');
assertClosed('EXPO_PUBLIC_STORE_MVP="   " (whitespace-only)', '   ');
assertClosed('EXPO_PUBLIC_STORE_MVP="yes" (malformed truthy)', 'yes');
assertClosed('EXPO_PUBLIC_STORE_MVP="on" (malformed truthy)', 'on');
assertClosed('EXPO_PUBLIC_STORE_MVP="off" (malformed falsy)', 'off');
assertClosed('EXPO_PUBLIC_STORE_MVP="01" (malformed truthy)', '01');
assertClosed('EXPO_PUBLIC_STORE_MVP="00" (malformed falsy)', '00');
assertClosed('EXPO_PUBLIC_STORE_MVP="null" (malformed)', 'null');
assertClosed('EXPO_PUBLIC_STORE_MVP="undefined" (malformed)', 'undefined');

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ Store MVP fail-closed regression: ${passed} checks passed across the full env-value matrix`);
} else {
  console.error(`\n❌ Store MVP fail-closed regression failed`);
}
