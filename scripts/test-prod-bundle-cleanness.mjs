#!/usr/bin/env node
/**
 * DIC-1189 rework-blocker #4c: prove that a production build immediately
 * following a staging build produces HTML free of every staging marker
 * (TEST banner meta, robots noindex, app-env=staging).
 *
 * How it works:
 *   1. Snapshot dist/index.html so we can restore it after the test.
 *   2. Reset dist/index.html to a clean Expo-shaped skeleton (with </head>).
 *   3. Run scripts/fix-html.js with APP_ENV=staging + a fake staging SHA —
 *      simulates a staging deployment build.
 *   4. Assert the resulting HTML contains the staging markers.
 *   5. Reset dist/index.html AGAIN (Vercel cleans dist between builds; this
 *      test simulates that clean).
 *   6. Run fix-html.js again with APP_ENV=production (unset APP_ENV).
 *   7. Assert the resulting HTML contains NONE of the staging markers —
 *      the "prior staging build" left no residue in the production output.
 *   8. Restore the original dist/index.html.
 *
 * If Vercel's build cache ever failed to clean dist between staging and
 * production deployments (a Metro/Expo cache regression), a stale staging
 * meta could survive into a production bundle. This test catches that at
 * regression time, not from a customer bug report.
 *
 * Run: node scripts/test-prod-bundle-cleanness.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const HTML = path.join(DIST, 'index.html');
const FIX_HTML = path.join(ROOT, 'scripts', 'fix-html.js');

// Skeleton index.html shaped like what Expo emits — enough for fix-html.js
// to inject meta tags into. Never touch the real dist/index.html without a
// backup/restore step.
const SKELETON = `<!DOCTYPE html>
<html lang="zh-TW">
  <head>
    <meta charset="utf-8" />
    <title>HoloHunter</title>
    <link rel="manifest" href="/manifest.json" />
  </head>
  <body><div id="root"></div></body>
</html>
`;

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function runFixHtml(env) {
  execFileSync(process.execPath, [FIX_HTML], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: 'pipe',
  });
}

// Snapshot the real dist/index.html so we can restore it.
const snapshot = fs.existsSync(HTML) ? fs.readFileSync(HTML, 'utf8') : null;

try {
  // ── Step 1: staging build ────────────────────────────────────────────────
  fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(HTML, SKELETON, 'utf8');
  runFixHtml({
    APP_ENV: 'staging',
    EXPO_PUBLIC_STAGING_SHA: 'testsha01234',
  });
  const stagingHtml = fs.readFileSync(HTML, 'utf8');

  test('staging build injects robots noindex meta', () => {
    assert.ok(stagingHtml.includes('name="robots" content="noindex,nofollow"'));
  });
  test('staging build injects app-env=staging meta', () => {
    assert.ok(stagingHtml.includes('name="app-env" content="staging"'));
  });
  test('staging build injects the exact SHA', () => {
    assert.ok(stagingHtml.includes('name="staging-sha" content="testsha01234"'));
  });

  // ── Step 2: production build following the staging build ────────────────
  // Vercel cleans dist between builds. Simulate that clean.
  fs.writeFileSync(HTML, SKELETON, 'utf8');
  runFixHtml({
    // Explicitly UNSET the staging env vars so fix-html.js sees production.
    APP_ENV: undefined,
    EXPO_PUBLIC_APP_ENV: undefined,
    EXPO_PUBLIC_STAGING_SHA: undefined,
    VERCEL_GIT_COMMIT_SHA: undefined,
  });
  const prodHtml = fs.readFileSync(HTML, 'utf8');

  test('production HTML has NO robots noindex meta', () => {
    assert.ok(!prodHtml.includes('robots'), `robots found in production HTML: ${prodHtml.slice(0, 500)}`);
  });
  test('production HTML has NO app-env meta', () => {
    assert.ok(!prodHtml.includes('app-env'), `app-env found in production HTML: ${prodHtml.slice(0, 500)}`);
  });
  test('production HTML has NO staging-sha meta', () => {
    assert.ok(!prodHtml.includes('staging-sha'), `staging-sha found in production HTML: ${prodHtml.slice(0, 500)}`);
  });
  test('production HTML has NO TEST/測試 marker', () => {
    assert.ok(!prodHtml.includes('TEST'), `TEST marker found in production HTML`);
    assert.ok(!prodHtml.includes('測試'), `測試 marker found in production HTML`);
  });

  // ── Step 3: bonus — staging build with UNSET SHA must FAIL the build ────
  fs.writeFileSync(HTML, SKELETON, 'utf8');
  test('staging build with no SHA throws (rework-blocker #5)', () => {
    let threw = false;
    try {
      runFixHtml({
        APP_ENV: 'staging',
        EXPO_PUBLIC_STAGING_SHA: undefined,
        VERCEL_GIT_COMMIT_SHA: undefined,
      });
    } catch (err) {
      threw = true;
      const stderr = err.stderr ? err.stderr.toString() : '';
      assert.ok(
        stderr.includes('EXPO_PUBLIC_STAGING_SHA') || stderr.includes('VERCEL_GIT_COMMIT_SHA'),
        `expected error to mention SHA env vars, got: ${stderr.slice(0, 300)}`,
      );
    }
    assert.ok(threw, 'staging build without SHA should have thrown');
  });
} finally {
  // Restore the original dist/index.html (or remove if it never existed).
  if (snapshot !== null) fs.writeFileSync(HTML, snapshot, 'utf8');
  else if (fs.existsSync(HTML)) fs.unlinkSync(HTML);
}

console.log(`\nprod-bundle-cleanness: ${passed} tests passed`);
