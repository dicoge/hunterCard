import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const PROJECT_DIR = process.cwd();

console.log('── Unit Test: DIC-1157 Commercialization & Store Readiness Verification ──');

// 1. Check HTML files existence & canonical URL
const requiredPages = ['pricing.html', 'terms.html', 'privacy.html', 'support.html'];
const canonicalDomain = 'https://holohunter.dicoge.com/';

for (const page of requiredPages) {
  const filePath = path.join(PROJECT_DIR, 'public', page);
  assert.ok(fs.existsSync(filePath), `public/${page} must exist`);

  const content = fs.readFileSync(filePath, 'utf-8');
  assert.ok(content.includes('canonical'), `public/${page} must contain a canonical link tag`);
  assert.ok(content.includes(canonicalDomain), `public/${page} must reference canonical domain ${canonicalDomain}`);
  assert.ok(!content.includes('holocard-hunter.vercel.app'), `public/${page} must NOT use old vercel.app URL`);
  console.log(`✓ PASS: public/${page} verified with canonical domain and clean URL`);
}

// 2. Check Dynamic Price Loading & No Hardcoded Production Prices
const pricingContent = fs.readFileSync(path.join(PROJECT_DIR, 'public/pricing.html'), 'utf-8');
assert.ok(pricingContent.includes('Sandbox'), 'pricing.html must contain Sandbox / test mode notice');
assert.ok(pricingContent.includes('動態載入') || pricingContent.includes('TBD'), 'pricing.html must specify dynamic Store API price loading');
assert.ok(!pricingContent.includes('NT$ 120'), 'pricing.html must NOT publish hardcoded NT$120 price fact');
assert.ok(!pricingContent.includes('NT$ 1,200'), 'pricing.html must NOT publish hardcoded NT$1,200 price fact');
console.log('✓ PASS: pricing.html uses dynamic Store API loading without hardcoded prices');

// 3. Check vercel.json rewrites
const vercelConfig = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'vercel.json'), 'utf-8'));
const rewrites = vercelConfig.rewrites.map((r) => r.source);
assert.ok(rewrites.includes('/pricing'), 'vercel.json rewrites must contain /pricing');
assert.ok(rewrites.includes('/terms'), 'vercel.json rewrites must contain /terms');
assert.ok(rewrites.includes('/privacy'), 'vercel.json rewrites must contain /privacy');
assert.ok(rewrites.includes('/support'), 'vercel.json rewrites must contain /support');
console.log('✓ PASS: vercel.json contains rewrites for /pricing, /terms, /privacy, /support');

// 4. Check AuthScreen.tsx privacy URL
const authScreenContent = fs.readFileSync(path.join(PROJECT_DIR, 'src/screens/AuthScreen.tsx'), 'utf-8');
assert.ok(authScreenContent.includes('https://holohunter.dicoge.com/privacy.html'), 'AuthScreen.tsx must use canonical domain for privacy policy');
assert.ok(!authScreenContent.includes('vercel.app'), 'AuthScreen.tsx must NOT contain vercel.app domain');
console.log('✓ PASS: AuthScreen.tsx uses canonical domain https://holohunter.dicoge.com/privacy.html');

// 5. Check AdSlot.tsx existence & importability
const adSlotPath = path.join(PROJECT_DIR, 'src/components/AdSlot.tsx');
assert.ok(fs.existsSync(adSlotPath), 'src/components/AdSlot.tsx must exist');
const adSlotContent = fs.readFileSync(adSlotPath, 'utf-8');
assert.ok(adSlotContent.includes("role === 'subscriber'"), 'AdSlot must check subscriber role to hide ads');
assert.ok(adSlotContent.includes('testProvider'), 'AdSlot must support testProvider mode');
console.log('✓ PASS: AdSlot.tsx exists and contains subscriber hide logic & testProvider mode');

console.log('\nAll DIC-1157 commercialization verification checks passed!');
