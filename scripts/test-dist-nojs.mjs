#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const PROJECT_DIR = process.cwd();
const DIST_DIR = path.join(PROJECT_DIR, 'dist');
const COPY_ASSETS_PATH = path.join(PROJECT_DIR, 'scripts', 'copy-assets.js');

console.log('── Isolated Dist Audit & Manifest Mutation Test (CR DIC-1162) ──');

// Step 1: Ensure dist/data/database.json exists so copy-assets.js does not refuse to run
fs.mkdirSync(path.join(DIST_DIR, 'data'), { recursive: true });
const dbFile = path.join(DIST_DIR, 'data', 'database.json');
if (!fs.existsSync(dbFile)) {
  fs.writeFileSync(dbFile, JSON.stringify({ cards: [] }));
}

// Step 2: Execute real scripts/copy-assets.js pipeline (DO NOT manually copy from public/)
console.log('Executing real scripts/copy-assets.js pipeline...');
execSync('node scripts/copy-assets.js', { stdio: 'inherit' });

// Step 3: Audit required HTML pages in dist/
const requiredPages = ['pricing.html', 'terms.html', 'privacy.html', 'support.html'];

for (const page of requiredPages) {
  const distPath = path.join(DIST_DIR, page);
  assert.ok(fs.existsSync(distPath), `dist/${page} MUST be produced by copy-assets.js manifest`);
}

/**
 * Validation function for shipped HTML contents in dist/
 */
export function validateDistHtml(content, filename) {
  assert.ok(content.includes('<main'), `${filename} missing semantic <main> tag`);
  assert.ok(content.includes('<h1'), `${filename} missing semantic <h1> tag`);
  assert.ok(content.includes('<noscript>'), `${filename} missing <noscript> fallback styles`);
  assert.ok(content.includes('https://holohunter.dicoge.com/'), `${filename} missing canonical domain`);

  if (filename === 'pricing.html') {
    assert.ok(content.includes('日本語'), 'pricing.html missing Japanese section');
    assert.ok(content.includes('無制限'), 'pricing.html missing Japanese unlimited scan copy');
    assert.ok(content.includes('カメラ'), 'pricing.html missing Japanese camera copy');
  }
}

// Validate shipped files in dist/
for (const page of requiredPages) {
  const content = fs.readFileSync(path.join(DIST_DIR, page), 'utf-8');
  validateDistHtml(content, page);
  console.log(`  ✓ PASS: Shipped dist/${page} has semantic <main>, <h1>, <noscript>, and No-JS Japanese readability`);
}

// Step 4: Mutation testing (Manifest & Content)
console.log('── Mutation Testing: Manifest & Content Fail-Closed Checks ──');

// Manifest Mutation 1: Verify copy-assets.js manifest HTML_PAGES contains all required pages
const copyAssetsSrc = fs.readFileSync(COPY_ASSETS_PATH, 'utf-8');
for (const page of requiredPages) {
  assert.ok(
    copyAssetsSrc.includes(`'${page}'`) || copyAssetsSrc.includes(`"${page}"`),
    `scripts/copy-assets.js HTML_PAGES manifest MUST include ${page}`
  );
}

// Manifest Mutation 2: Simulate removal of pricing.html from HTML_PAGES in copy-assets.js
const testManifestAuditor = (scriptSource) => {
  for (const page of requiredPages) {
    if (!scriptSource.includes(`'${page}'`) && !scriptSource.includes(`"${page}"`)) {
      throw new Error(`[Manifest Error] Page ${page} missing from copy-assets.js HTML_PAGES manifest`);
    }
  }
};

assert.doesNotThrow(() => testManifestAuditor(copyAssetsSrc));

const mutatedManifestSrc = copyAssetsSrc.replace(`'pricing.html'`, `'non_existent.html'`);
assert.throws(
  () => testManifestAuditor(mutatedManifestSrc),
  /Page pricing.html missing from copy-assets.js/,
  'Mutation Test: Removal of pricing.html from copy-assets.js manifest MUST fail closed'
);
console.log('  ✓ PASS: Manifest mutation test: Removal of pricing.html from HTML_PAGES manifest fails closed');

// Content Mutations
const pricingHtml = fs.readFileSync(path.join(DIST_DIR, 'pricing.html'), 'utf-8');

assert.throws(
  () => validateDistHtml(pricingHtml.replace(/<main[^>]*>/, '<div>').replace('</main>', '</div>'), 'pricing.html'),
  /missing semantic <main> tag/
);
console.log('  ✓ PASS: Content mutation test: Removal of <main> fails closed');

assert.throws(
  () => validateDistHtml(pricingHtml.replace(/<h1[^>]*>.*?<\/h1>/, ''), 'pricing.html'),
  /missing semantic <h1> tag/
);
console.log('  ✓ PASS: Content mutation test: Removal of <h1> fails closed');

assert.throws(
  () => validateDistHtml(pricingHtml.replace(/無制限/g, 'XXX'), 'pricing.html'),
  /missing Japanese/
);
console.log('  ✓ PASS: Content mutation test: Removal of No-JS Japanese text fails closed');

console.log('\nAll dist audit & manifest/content mutation tests PASSED!');
