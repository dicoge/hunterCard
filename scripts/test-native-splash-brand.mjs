#!/usr/bin/env node
/**
 * v44 P0 (user: the opening logo is still the old one): the NATIVE splash image Expo
 * prebuild turns into `drawable-*\/splashscreen_logo.png` must be the approved new H brand
 * (the same file the launcher icon is generated from), not the old blue/gold "HH".
 *
 * The shipped v43 AAB had the new launcher (from `expo.icon`) but the old splash
 * (`expo.splash.image` → assets/splash-icon.png). This reads the RESOLVED app config
 * (app.config.js over app.base.json, store build env) and compares decoded image content.
 * It is a source/config guard only: the final candidate AAB's resources must still be
 * extracted and compared (offline-fixtures verify-aab-splash.py), and the launch screen
 * observed — never call this a runtime PASS.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { decodePng } from './lib/png-decode.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
// The approved new H mark (PR #244 "selected logo"), and the old HH splash it replaces.
const APPROVED_NEW_H_SHA256 = '2b91b33dadbcbede5908ad7b95c87c41710101e7b82e4551444dab64fbb72a35';
const OLD_HH_SPLASH_SHA256 = 'd01a96f6b021b19cb394684cbe421a6b899ed17d355c01e4c7bcf3cb7bc0d16e';

let passed = 0;
function test(label, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (err) { process.exitCode = 1; console.error(`  ✗ ${label} — ${err.message}`); }
}
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

for (const storeMvp of ['1', '']) {
  process.env.EXPO_PUBLIC_STORE_MVP = storeMvp;
  delete require.cache[require.resolve('../app.config.js')];
  delete require.cache[require.resolve('../app.base.json')];
  const exported = require('../app.config.js');
  const config = typeof exported === 'function' ? exported({ config: {} }) : exported;
  const expo = config.expo ?? config;
  const label = storeMvp ? 'store build' : 'full build';
  const splash = expo.android?.splash ?? expo.splash;
  const splashFile = path.resolve(ROOT, splash.image);
  const iconFile = path.resolve(ROOT, expo.icon);

  test(`${label}: native splash image is the approved new H (same file as the launcher icon), not the old HH`, () => {
    assert.equal(sha(iconFile), APPROVED_NEW_H_SHA256, 'launcher icon is the approved new H');
    assert.equal(sha(splashFile), APPROVED_NEW_H_SHA256, `splash ${splash.image} is the new H`);
    assert.notEqual(sha(splashFile), OLD_HH_SPLASH_SHA256);
  });
  test(`${label}: splash background is the new H's own dark field (no white frame around a full-bleed mark)`, () => {
    const { width, rgba } = decodePng(splashFile);
    const corner = [rgba[0], rgba[1], rgba[2]];
    const hex = splash.backgroundColor.replace('#', '');
    const bg = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    assert.ok(bg.every((v, i) => Math.abs(v - corner[i]) <= 3), `background ${splash.backgroundColor} vs image corner ${corner}`);
    assert.ok(width >= 512, 'large enough for every density');
    assert.equal(splash.resizeMode, 'contain');
  });
}
test('the new H content really differs from the old HH (decoded pixels, not just bytes)', () => {
  const a = decodePng(path.join(ROOT, 'assets/icon.png'));
  const b = decodePng(path.join(ROOT, 'assets/splash-icon.png'));
  const mean = (img) => { let s = 0; for (let i = 0; i < img.rgba.length; i += 4) s += img.rgba[i + 2]; return s / (img.rgba.length / 4); };
  assert.ok(Math.abs(mean(a) - mean(b)) > 20, 'blue-channel mean differs');
});

if ((process.exitCode ?? 0) === 0) console.log(`\n✅ native-splash-brand: ${passed} checks passed`);
else console.error('\n❌ native-splash-brand failed');
