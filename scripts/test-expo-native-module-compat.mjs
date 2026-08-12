#!/usr/bin/env node
/**
 * DIC-969 regression: an Expo native module must never resolve to a version that
 * is incompatible with the installed Expo SDK.
 *
 * The shipped Android APK (EAS build 502c2164, source SHA 2a8df872) crashed on
 * launch before any UI with:
 *   java.lang.NoClassDefFoundError: expo.modules.kotlin.types.AnyTypeCache
 *   at expo.modules.crypto.CryptoModule.definition(CryptoModule.kt:76)
 * Root cause: package.json pinned expo-crypto ^57.0.1 / expo-auth-session ^57.0.5 /
 * expo-web-browser ^57.0.2. Those resolved to native modules built against a much
 * newer expo-modules-core, while SDK 54 bundles expo-modules-core 3.0.30 — which has
 * no AnyTypeCache class. The mismatch is invisible to typecheck and to a web export;
 * it only surfaces as a runtime NoClassDefFoundError inside the Android artifact.
 *
 * Expo's authoritative source of truth for which native-module version pairs with
 * the installed SDK is `node_modules/expo/bundledNativeModules.json` (the same data
 * `expo install --check` uses). This test asserts that every dependency we declare
 * which Expo bundles resolves — in the committed lockfile — to a version satisfying
 * Expo's pinned range for the installed SDK. It is deterministic (no network) and
 * would have failed on the shipped 57.x versions.
 *
 * Run: node scripts/test-expo-native-module-compat.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

const pkg = readJson(path.join(repoRoot, 'package.json'));
const lock = readJson(path.join(repoRoot, 'package-lock.json'));

// Expo's compatibility manifest for the *installed* SDK. Ships inside the expo
// package, so it always matches whatever expo version the lockfile resolved.
const bundledPath = path.join(repoRoot, 'node_modules', 'expo', 'bundledNativeModules.json');
assert.ok(
  fs.existsSync(bundledPath),
  'node_modules/expo/bundledNativeModules.json missing — run `npm install` before this test',
);
const bundled = readJson(bundledPath);

const declared = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
const lockPkgs = lock.packages ?? {};

function resolvedVersion(name) {
  const entry = lockPkgs[`node_modules/${name}`];
  return entry ? entry.version : null;
}

// Every dependency we declare that Expo also bundles must satisfy Expo's pinned
// range for this SDK. This is the exact invariant the crash violated.
const checked = [];
const failures = [];
for (const name of Object.keys(declared)) {
  const range = bundled[name];
  if (!range) continue; // not an Expo-managed native/JS module — skip
  const resolved = resolvedVersion(name);
  assert.ok(resolved, `${name} is declared but not resolved in package-lock.json`);
  const ok = semver.satisfies(resolved, range, { includePrerelease: true });
  checked.push({ name, resolved, range, ok });
  if (!ok) {
    failures.push(`  ${name}: resolved ${resolved} does NOT satisfy Expo SDK range ${range}`);
  }
}

assert.ok(checked.length > 0, 'expected at least one Expo-bundled module to be checked');

// The three modules the crash implicated must be present in the audit, so this
// regression can never silently stop covering them.
for (const guard of ['expo-crypto', 'expo-auth-session', 'expo-web-browser']) {
  assert.ok(
    checked.some((c) => c.name === guard),
    `${guard} must be declared and covered by this compatibility check`,
  );
}

if (failures.length > 0) {
  console.error('Expo native-module compatibility check FAILED:');
  console.error(failures.join('\n'));
  console.error(
    '\nAn Expo module resolved to a version outside the installed SDK range. This is the\n' +
      'class of defect that shipped a launch-time NoClassDefFoundError (DIC-969). Align the\n' +
      'offending dependency with `npx expo install <pkg>` and regenerate the lockfile.',
  );
  process.exit(1);
}

for (const c of checked) {
  console.log(`OK  ${c.name} ${c.resolved} satisfies SDK range ${c.range}`);
}
console.log(`\nExpo native-module compatibility: ${checked.length} bundled modules verified against the installed SDK.`);
