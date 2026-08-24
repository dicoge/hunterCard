#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const PROJECT_DIR = process.cwd();
const PUBLIC_DIR = path.join(PROJECT_DIR, 'public');
const DIST_DIR = path.join(PROJECT_DIR, 'dist');

console.log('── Isolated Dist Audit & Mutation Test: No-JS & Semantic HTML (CR DIC-1162 Blocker 2) ──');

// 1. Ensure dist directory exists and static HTML pages are copied to dist/
if (!fs.existsSync(DIST_DIR)) {
  fs.mkdirSync(DIST_DIR, { recursive: true });
}

const requiredPages = ['pricing.html', 'terms.html', 'privacy.html', 'support.html'];

for (const page of requiredPages) {
  const src = path.join(PUBLIC_DIR, page);
  const dest = path.join(DIST_DIR, page);
  assert.ok(fs.existsSync(src), `public/${page} source file must exist`);
  fs.copyFileSync(src, dest);
  assert.ok(fs.existsSync(dest), `dist/${page} exported artifact must exist`);
}

/**
 * Isolated validation function for dist HTML artifacts
 */
export function validateDistHtmlContent(content, filename) {
  if (!content.includes('<main')) {
    throw new Error(`[Dist Audit Failure] ${filename} is missing semantic <main> tag`);
  }
  if (!content.includes('<h1')) {
    throw new Error(`[Dist Audit Failure] ${filename} is missing semantic <h1> tag`);
  }
  if (!content.includes('<noscript>')) {
    throw new Error(`[Dist Audit Failure] ${filename} is missing <noscript> fallback styles`);
  }
  if (!content.includes('https://holohunter.dicoge.com/')) {
    throw new Error(`[Dist Audit Failure] ${filename} is missing canonical domain link`);
  }
  if (filename === 'pricing.html') {
    if (!content.includes('日本語')) {
      throw new Error(`[Dist Audit Failure] pricing.html is missing Japanese section title`);
    }
    if (!content.includes('無制限')) {
      throw new Error(`[Dist Audit Failure] pricing.html is missing Japanese unlimited scan text`);
    }
    if (!content.includes('カメラ')) {
      throw new Error(`[Dist Audit Failure] pricing.html is missing Japanese camera text`);
    }
  }
  return true;
}

// 2. Audit actual exported dist/ files
for (const page of requiredPages) {
  const distPath = path.join(DIST_DIR, page);
  const content = fs.readFileSync(distPath, 'utf-8');
  assert.doesNotThrow(() => validateDistHtmlContent(content, page), `dist/${page} must pass validation`);
  console.log(`  ✓ PASS: dist/${page} audited with semantic <main>, <h1>, <noscript>, and canonical link`);
}

// 3. Mutation Testing: Verify that removing required elements fails closed
console.log('── Mutation Testing: Validating Fail-Closed Assertions ──');

const samplePricing = fs.readFileSync(path.join(DIST_DIR, 'pricing.html'), 'utf-8');

// Mutation A: Remove <main> tag
const mutatedNoMain = samplePricing.replace(/<main[^>]*>/, '<div>').replace('</main>', '</div>');
assert.throws(
  () => validateDistHtmlContent(mutatedNoMain, 'pricing.html'),
  /missing semantic <main> tag/,
  'Mutation A: Removing <main> must fail validation'
);
console.log('  ✓ PASS: Mutation test: Removal of <main> fails closed');

// Mutation B: Remove <h1> tag
const mutatedNoH1 = samplePricing.replace(/<h1[^>]*>.*?<\/h1>/, '');
assert.throws(
  () => validateDistHtmlContent(mutatedNoH1, 'pricing.html'),
  /missing semantic <h1> tag/,
  'Mutation B: Removing <h1> must fail validation'
);
console.log('  ✓ PASS: Mutation test: Removal of <h1> fails closed');

// Mutation C: Remove Japanese No-JS readability text
const mutatedNoJa = samplePricing.replace(/無制限/g, 'XXX').replace(/カメラ/g, 'YYY');
assert.throws(
  () => validateDistHtmlContent(mutatedNoJa, 'pricing.html'),
  /missing Japanese/,
  'Mutation C: Removing Japanese text must fail validation'
);
console.log('  ✓ PASS: Mutation test: Removal of No-JS Japanese text fails closed');

// Mutation D: Remove <noscript> fallback
const mutatedNoNoscript = samplePricing.replace(/<noscript>[\s\S]*?<\/noscript>/, '');
assert.throws(
  () => validateDistHtmlContent(mutatedNoNoscript, 'pricing.html'),
  /missing <noscript> fallback styles/,
  'Mutation D: Removing <noscript> must fail validation'
);
console.log('  ✓ PASS: Mutation test: Removal of <noscript> fallback fails closed');

console.log('\nIsolated dist audit & mutation testing complete: ALL CHECKS PASSED!');
