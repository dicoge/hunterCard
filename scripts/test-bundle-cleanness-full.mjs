#!/usr/bin/env node
/**
 * DIC-1189 real end-to-end bundle cleanness test.
 *
 * Runs the actual build pipeline TWICE against the exact Vercel command
 * path — no out-of-band `rm -rf` on caches, only `expo export --clear`
 * between builds (rework 5th pass — blocker #3a):
 *   1. `EXPO_PUBLIC_APP_ENV=staging expo export --platform web --clear`
 *      → dist/ carries the staging bundle. Asserts staging markers ARE
 *      present in the emitted JS bundles.
 *   2. Renames dist/ so the production build starts from a fresh
 *      Vercel-container-shaped tree (dist/ absent, which mirrors what
 *      Vercel provides on a fresh build), then runs
 *      `EXPO_PUBLIC_APP_ENV=production expo export --platform web --clear`.
 *      `--clear` purges Metro's in-memory transformer state so the
 *      staging run's inlined `process.env.EXPO_PUBLIC_APP_ENV` cannot
 *      be reused. Asserts the production dist/ contains NONE of the
 *      staging markers, in ANY of the plausible bundle encodings
 *      (rework 5th pass — blocker #3b covers raw UTF-8 + \x hex + \u
 *      unicode + String.fromCharCode).
 *
 * This test is EXPENSIVE (each `expo export` takes minutes) but wired
 * into Validate on PR #150 (rework 5th pass — blocker #3c) so a Metro
 * DCE regression is caught at PR time, not only when a reviewer runs
 * the opt-in script by hand.
 *
 * Preconditions: node_modules installed, `expo` CLI resolvable.
 *
 * Run: node scripts/test-bundle-cleanness-full.mjs
 */

import fs from 'node:fs';
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

function runExport(appEnv, extraEnv = {}) {
  console.log(`\n── expo export APP_ENV=${appEnv} ──`);
  // Match vercel.json buildCommand exactly: `expo export --platform web
  // --clear` is the ONLY Metro-cache-clear mechanism; no out-of-band
  // rm -rf between builds (that was blocker #3a).
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

// Match every form Metro / babel-plugin-minify might have emitted for a
// non-ASCII banner string (rework 5th pass — blocker #3b):
//   - raw UTF-8 ("TEST · 測試環境")
//   - \uXXXX ES-string escape (Unicode escape, per char above 0x7f)
//   - \xNN ES-string hex escape (per byte of the UTF-8 encoding)
//   - String.fromCharCode(...) form (Metro's fallback on some minifier
//     plugins)
// Any hit in the production bundle is a DCE regression.
function needleVariants(needle) {
  const raw = needle;
  const unicodeEsc = Array.from(needle)
    .map((ch) => {
      const code = ch.codePointAt(0);
      if (code < 0x80) return ch;
      return '\\u' + code.toString(16).padStart(4, '0');
    })
    .join('');
  // \x hex escape uses the UTF-8 BYTE sequence, not code points, since
  // \xNN only spans 0x00..0xff.
  const utf8 = Buffer.from(needle, 'utf8');
  const hexEsc = Array.from(utf8)
    .map((b) => {
      // ASCII printable: leave as raw char so a minifier that
      // rewrites only high bytes as \x still trips this pattern.
      if (b >= 0x20 && b < 0x80) return String.fromCharCode(b);
      return '\\x' + b.toString(16).padStart(2, '0');
    })
    .join('');
  const fromCharCode = 'String.fromCharCode(' +
    Array.from(needle).map((ch) => ch.codePointAt(0)).join(',') +
    ')';
  const seen = new Set([raw, unicodeEsc, hexEsc, fromCharCode]);
  return [...seen];
}

function bundleContains(needle) {
  const variants = needleVariants(needle);
  for (const f of bundleJsFiles()) {
    const body = fs.readFileSync(f, 'utf8');
    for (const v of variants) {
      const idx = body.indexOf(v);
      if (idx !== -1) {
        return {
          file: path.relative(ROOT, f),
          variant:
            v === needle ? 'raw' :
            v.startsWith('String.fromCharCode') ? 'fromCharCode' :
            v.includes('\\u') ? 'unicode-escape' :
            'hex-escape',
          snippet: body.slice(Math.max(0, idx - 40), idx + v.length + 40),
        };
      }
    }
  }
  return null;
}

// Snapshot original dist so we can restore.
const beforeDist = fs.existsSync(DIST);
if (beforeDist) fs.renameSync(DIST, DIST + '.before-dic1189-bundle-test');

try {
  // ── Step 1: staging build ────────────────────────────────────────────────
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

  // ── Step 2: production build immediately following staging ──────────────
  // Vercel gives each build a fresh dist/ but reuses the workspace; we
  // simulate that by renaming dist/ aside (no rm-rf on Metro caches). The
  // `--clear` flag on `expo export` is the ONLY Metro state purge.
  fs.renameSync(DIST, DIST + '.staging-run');
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
  test('production JS bundle DOES NOT contain "TEST · 測試環境" (Metro DCE working; covers raw + \\u + \\x + fromCharCode)', () => {
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
  fs.rmSync(DIST + '.staging-run', { recursive: true, force: true });
  if (beforeDist) fs.renameSync(DIST + '.before-dic1189-bundle-test', DIST);
}

console.log(`\nbundle-cleanness-full: ${passed} tests passed`);
