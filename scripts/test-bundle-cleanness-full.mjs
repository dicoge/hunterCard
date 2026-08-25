#!/usr/bin/env node
/**
 * DIC-1189 rework 3rd pass — blocker #4b: real end-to-end bundle cleanness
 * test.
 *
 * Runs the actual build pipeline TWICE:
 *   1. `EXPO_PUBLIC_APP_ENV=staging expo export --platform web --clear`
 *      (with buildCommand's cache-cleaning prefix) → dist/ carries the
 *      staging bundle. Snapshots dist/, asserts staging markers ARE present
 *      in the emitted JS bundles.
 *   2. Snapshots + cleans dist/ and every Metro/Expo cache the buildCommand
 *      is expected to purge, then re-runs with
 *      `EXPO_PUBLIC_APP_ENV=production expo export --platform web --clear`.
 *      Asserts the production dist/ contains NONE of:
 *        - the "TEST · 測試環境" banner label,
 *        - `name="app-env" content="staging"`,
 *        - `name="staging-sha"`,
 *        - `noindex,nofollow`,
 *        - the string `staging` in any emitted JS bundle for the reasons
 *          this test cares about (path/URL substring is fine; the banner
 *          text and env-marker meta names are not).
 *
 * This test IS EXPENSIVE (each `expo export` takes minutes). It is NOT
 * part of `npm run test:dic1189-staging-isolation` — run it in CI or before
 * a release with `npm run test:bundle-cleanness-full`. The lightweight
 * HTML-only variant (`scripts/test-prod-bundle-cleanness.mjs`) covers the
 * fix-html.js meta injection path without running the bundler.
 *
 * Preconditions: node_modules installed, `expo` CLI resolvable, working
 * network for a first-time Metro cache warmup.
 *
 * Run: node scripts/test-bundle-cleanness-full.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function purgeCaches() {
  // Mirror the vercel.json buildCommand's clean step so this test exercises
  // the exact same cache-clearing surface.
  const tmp = process.env.TMPDIR || '/tmp';
  const targets = [
    path.join(ROOT, '.expo'),
    path.join(ROOT, 'dist'),
    path.join(ROOT, 'node_modules', '.cache'),
    path.join(os.homedir(), '.expo'),
  ];
  for (const t of targets) {
    fs.rmSync(t, { recursive: true, force: true });
  }
  for (const entry of fs.readdirSync(tmp, { withFileTypes: true })) {
    if (
      entry.name.startsWith('metro-') ||
      entry.name.startsWith('haste-map-') ||
      entry.name.startsWith('react-native-packager-cache-')
    ) {
      fs.rmSync(path.join(tmp, entry.name), { recursive: true, force: true });
    }
  }
}

function runExport(appEnv, extraEnv = {}) {
  console.log(`\n── expo export APP_ENV=${appEnv} ──`);
  execSync('npx --yes expo export --platform web --clear', {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      APP_ENV: appEnv,
      EXPO_PUBLIC_APP_ENV: appEnv,
      VERCEL_GIT_COMMIT_SHA: extraEnv.VERCEL_GIT_COMMIT_SHA || 'testsha01234',
      ...extraEnv,
    },
  });
  execSync('node scripts/fix-html.js', {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      APP_ENV: appEnv,
      EXPO_PUBLIC_APP_ENV: appEnv,
      VERCEL_GIT_COMMIT_SHA: extraEnv.VERCEL_GIT_COMMIT_SHA || 'testsha01234',
    },
  });
}

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

function bundleJsFiles() {
  const jsDir = path.join(DIST, '_expo', 'static', 'js');
  if (!fs.existsSync(jsDir)) return [];
  return walkFiles(jsDir).filter((p) => p.endsWith('.js'));
}

function bundleContains(needle) {
  for (const f of bundleJsFiles()) {
    const body = fs.readFileSync(f, 'utf8');
    if (body.includes(needle)) return { file: path.relative(ROOT, f), snippet: body.slice(Math.max(0, body.indexOf(needle) - 40), body.indexOf(needle) + needle.length + 40) };
  }
  return null;
}

// Snapshot original dist so we can restore.
const beforeDist = fs.existsSync(DIST);
if (beforeDist) fs.renameSync(DIST, DIST + '.before-dic1189-bundle-test');

try {
  // ── Step 1: staging build ────────────────────────────────────────────────
  purgeCaches();
  runExport('staging');
  const htmlStaging = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');

  test('staging HTML has robots noindex', () => {
    assert.ok(htmlStaging.includes('name="robots" content="noindex,nofollow"'));
  });
  test('staging HTML has app-env=staging', () => {
    assert.ok(htmlStaging.includes('name="app-env" content="staging"'));
  });
  test('staging bundle contains the banner text (build-time-inlined require picked up)', () => {
    const hit = bundleContains('TEST · 測試環境');
    assert.ok(hit, 'expected staging bundle to include "TEST · 測試環境" (banner text)');
  });

  // ── Step 2: production build following the staging build ────────────────
  purgeCaches();
  runExport('production');
  const htmlProd = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');

  test('production HTML has NO robots noindex', () => {
    assert.ok(!htmlProd.includes('noindex'), `robots noindex leaked into prod HTML: ${htmlProd.slice(0, 200)}`);
  });
  test('production HTML has NO app-env meta', () => {
    assert.ok(!htmlProd.includes('app-env'));
  });
  test('production HTML has NO staging-sha meta', () => {
    assert.ok(!htmlProd.includes('staging-sha'));
  });
  test('production JS bundle DOES NOT contain "TEST · 測試環境" (Metro DCE working)', () => {
    const hit = bundleContains('TEST · 測試環境');
    assert.ok(!hit, `staging banner text found in production bundle: ${JSON.stringify(hit)}`);
  });
  test('production JS bundle DOES NOT contain "app-env"/staging-sha marker names', () => {
    for (const marker of ['name="app-env"', 'name="staging-sha"']) {
      const hit = bundleContains(marker);
      assert.ok(!hit, `production bundle contains staging marker ${marker}: ${JSON.stringify(hit)}`);
    }
  });
} finally {
  // Restore original dist.
  fs.rmSync(DIST, { recursive: true, force: true });
  if (beforeDist) fs.renameSync(DIST + '.before-dic1189-bundle-test', DIST);
}

console.log(`\nbundle-cleanness-full: ${passed} tests passed`);
