#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const PROJECT_DIR = process.cwd();
const COPY_ASSETS_PATH = path.join(PROJECT_DIR, 'scripts', 'copy-assets.js');
const requiredPages = ['pricing.html', 'terms.html', 'privacy.html', 'support.html'];

console.log('── Isolated Dist Audit & Real Copier Mutation Test (CR DIC-1162) ──');

/**
 * Helper to run a copier script into a fresh isolated output directory with no pre-existing HTML
 */
function runCopyAssetsInTempDir(scriptPath = COPY_ASSETS_PATH) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-dist-nojs-'));
  fs.mkdirSync(path.join(tempDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'data', 'database.json'), JSON.stringify({ cards: [] }));

  execSync(`node "${scriptPath}"`, {
    env: {
      ...process.env,
      PROJECT_DIR: PROJECT_DIR,
      DIST_DIR: tempDir,
    },
    stdio: 'pipe',
  });

  return tempDir;
}

/**
 * Validates shipped HTML pages in an isolated output directory
 */
function auditDistDirectory(distDir) {
  for (const page of requiredPages) {
    const pagePath = path.join(distDir, page);
    if (!fs.existsSync(pagePath)) {
      throw new Error(`[Audit Error] Required static page missing from output directory: ${page}`);
    }

    const content = fs.readFileSync(pagePath, 'utf-8');
    assert.ok(content.includes('<main'), `${page} missing semantic <main> tag`);
    assert.ok(content.includes('<h1'), `${page} missing semantic <h1> tag`);
    assert.ok(content.includes('<noscript>'), `${page} missing <noscript> fallback styles`);
    assert.ok(content.includes('https://holohunter.dicoge.com/'), `${page} missing canonical domain`);

    if (page === 'pricing.html') {
      assert.ok(content.includes('日本語'), 'pricing.html missing Japanese section');
      assert.ok(content.includes('無制限'), 'pricing.html missing Japanese unlimited scan copy');
      assert.ok(content.includes('カメラ'), 'pricing.html missing Japanese camera copy');
    }
  }
}

// 1. Control Test: Audit real unmodified production export/copy into a fresh isolated temp directory
console.log('Control Test: Executing unmodified copy-assets.js in fresh temp directory...');
const controlTempDir = runCopyAssetsInTempDir();
try {
  auditDistDirectory(controlTempDir);
  console.log('  ✓ CONTROL PASS: Unmodified copier produces all required pages with semantic <main>, <h1>, <noscript>, and No-JS Japanese readability');
} finally {
  fs.rmSync(controlTempDir, { recursive: true, force: true });
}

// 2. Real Copier Destination Mis-Mapping Mutation Test
console.log('── Mutation Testing: Executing Mutated Real Copier in Isolated Output ──');

const copyAssetsSrc = fs.readFileSync(COPY_ASSETS_PATH, 'utf-8');
const mutatedScriptPath = path.join(PROJECT_DIR, 'scripts', '.test-mutated-copy-assets.js');

// Mutate only the destination expression. The source remains public/pricing.html;
// a regression that writes it to the wrong shipped path must fail the fresh dist audit.
const destinationExpression = `const dest = path.join(DIST_DIR, file);`;
const mutatedDestinationExpression =
  `const dest = path.join(DIST_DIR, file === 'pricing.html' ? 'pricing-mismapped.html' : file);`;
assert.ok(
  copyAssetsSrc.includes(destinationExpression),
  'Mutation Test setup: expected copy-assets.js destination expression not found',
);
const mutatedScriptContent = copyAssetsSrc.replace(destinationExpression, mutatedDestinationExpression);
fs.writeFileSync(mutatedScriptPath, mutatedScriptContent);

try {
  const mutatedTempDir = runCopyAssetsInTempDir(mutatedScriptPath);
  try {
    assert.ok(
      fs.existsSync(path.join(mutatedTempDir, 'pricing-mismapped.html')),
      'Mutation Test setup: destination-only mutation must emit pricing-mismapped.html from real public/pricing.html source',
    );
    assert.ok(
      !fs.existsSync(path.join(mutatedTempDir, 'pricing.html')),
      'Mutation Test setup: destination-only mutation must not emit pricing.html',
    );
    assert.throws(
      () => auditDistDirectory(mutatedTempDir),
      /Required static page missing from output directory: pricing.html/,
      'Mutation Test: Real copier emitting pricing-mismapped.html instead of pricing.html MUST cause dist audit to fail'
    );
    console.log('  ✓ PASS: Real copier mutation test: Changing pricing destination in copy-assets.js causes fresh dist audit to fail closed');
  } finally {
    fs.rmSync(mutatedTempDir, { recursive: true, force: true });
  }
} finally {
  if (fs.existsSync(mutatedScriptPath)) {
    fs.unlinkSync(mutatedScriptPath);
  }
}

// 3. Content Mutation Testing (Missing <main>, <h1>, or Japanese text in output HTML)
const mutatedContentTempDir = runCopyAssetsInTempDir();
try {
  const pricingDistPath = path.join(mutatedContentTempDir, 'pricing.html');
  const rawPricingHtml = fs.readFileSync(pricingDistPath, 'utf-8');

  // Test missing <main>
  fs.writeFileSync(pricingDistPath, rawPricingHtml.replace(/<main[^>]*>/, '<div>').replace('</main>', '</div>'));
  assert.throws(
    () => auditDistDirectory(mutatedContentTempDir),
    /pricing.html missing semantic <main> tag/
  );
  console.log('  ✓ PASS: Content mutation test: Missing <main> tag in fresh dist output fails closed');

  // Test missing Japanese text
  fs.writeFileSync(pricingDistPath, rawPricingHtml.replace(/無制限/g, 'XXX'));
  assert.throws(
    () => auditDistDirectory(mutatedContentTempDir),
    /pricing.html missing Japanese unlimited scan copy/
  );
  console.log('  ✓ PASS: Content mutation test: Missing No-JS Japanese text in fresh dist output fails closed');
} finally {
  fs.rmSync(mutatedContentTempDir, { recursive: true, force: true });
}

console.log('\nIsolated dist audit & real copier mutation testing complete: ALL CHECKS PASSED!');
