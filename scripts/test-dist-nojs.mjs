import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const PROJECT_DIR = process.cwd();
const PUBLIC_DIR = path.join(PROJECT_DIR, 'public');

console.log('── Unit & Static Test: No-JS & Semantic HTML Structure Verification ──');

const requiredPages = ['pricing.html', 'terms.html', 'privacy.html', 'support.html'];

for (const page of requiredPages) {
  const filePath = path.join(PUBLIC_DIR, page);
  assert.ok(fs.existsSync(filePath), `public/${page} must exist`);

  const content = fs.readFileSync(filePath, 'utf-8');
  assert.ok(content.includes('<main'), `public/${page} must contain semantic <main> tag`);
  assert.ok(content.includes('<h1'), `public/${page} must contain semantic <h1> tag`);
  assert.ok(content.includes('<noscript>'), `public/${page} must contain <noscript> fallback styles for No-JS accessibility`);
  assert.ok(content.includes('https://holohunter.dicoge.com/'), `public/${page} must enforce canonical domain`);
  console.log(`✓ PASS: public/${page} has semantic <main>, <h1>, <noscript> fallback, and canonical link`);
}

// Check Japanese pricing readability without JavaScript
const pricingContent = fs.readFileSync(path.join(PUBLIC_DIR, 'pricing.html'), 'utf-8');
assert.ok(pricingContent.includes('日本語'), 'pricing.html must include Japanese section');
assert.ok(pricingContent.includes('無制限'), 'pricing.html Japanese section must include unlimited scan text');
assert.ok(pricingContent.includes('カメラ'), 'pricing.html Japanese section must include camera text');
assert.ok(pricingContent.includes('Pro'), 'pricing.html Japanese section must include Pro plan text');
console.log('✓ PASS: pricing.html Japanese pricing content is fully readable without JS execution');

console.log('\nAll No-JS & Semantic HTML verification checks passed!');
