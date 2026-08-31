#!/usr/bin/env node
/**
 * DIC-1266 release-APK effective-configuration guard.
 *
 * The static suite `scripts/test-release-apk-size-optim.mjs` validates the
 * plugin's inputs and its isolated string transform. That is necessary but
 * not sufficient: the DIC-1269 CR round-1 ran a real `npx expo prebuild`
 * and found that the plugin's `packagingOptions.jniLibs.useLegacyPackaging
 * = true` insertion in `build.gradle` was silently reverted by the Expo
 * template's later `useLegacyPackaging enableLegacyPackaging.toBoolean()`
 * block (reading `expo.useLegacyPackaging` from gradle.properties, default
 * `false`).
 *
 * This suite runs a real `npx expo prebuild --platform android --no-install
 * --clean` against the checkout with `EAS_BUILD_PROFILE=production-apk`
 * (and again with `production`) and then asserts the EFFECTIVE generated
 * configuration:
 *
 *   1. `android/gradle.properties` sets `expo.useLegacyPackaging=true`
 *      exactly once for `production-apk`; `production` keeps the default
 *      `false`.
 *
 *   2. `android/app/build.gradle` for `production-apk` carries exactly one
 *      EXECUTABLE `abiFilters` occurrence (comment-stripped) referencing
 *      only `arm64-v8a`. No `splits { abi { include "x86" } }` construct
 *      reintroduces other ABIs. The abiFilters call lives inside the REAL
 *      `defaultConfig` block, not inside a hidden `/* … *​/` comment
 *      (DIC-1269 CR round-2 blocker 2 — the assertion runs against the
 *      comment-stripped Gradle so a doc-comment cannot fake it).
 *
 *   3. `applicationId` on the generated Gradle matches
 *      `com.dicoge.holohunter`.
 *
 *   4. Running the plugin with `EAS_BUILD_PROFILE=production` (the Play
 *      AAB profile) MUST NOT emit either change — the AAB keeps all four
 *      ABIs and the stored-JNI Play default.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadPlugin() {
  // The plugin exports `stripGroovyComments` on its __internal surface —
  // reuse it here so the assertion runs on the exact same comment-strip
  // semantics as the plugin's own DSL selection.
  const cjs = await import(pathToFileURL(path.join(ROOT, 'plugins', 'withReleaseApkSizeOptim.js')).href);
  return cjs.default?.__internal ?? cjs.__internal ?? cjs.default;
}

function runPrebuild(env) {
  const result = spawnSync(
    'npx',
    ['expo', 'prebuild', '--platform', 'android', '--no-install', '--clean'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID:
          process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? 'dic1266-effective-guard-placeholder',
        EAS_BUILD_PLATFORM: 'android',
        ...env,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `expo prebuild exited with status ${result.status}\n` +
        `stdout:\n${result.stdout}\n` +
        `stderr:\n${result.stderr}`,
    );
  }
}

function readIfExists(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

function cleanAndroid() {
  const p = path.join(ROOT, 'android');
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

check('production-apk prebuild sets expo.useLegacyPackaging=true exactly once', async () => {
  cleanAndroid();
  runPrebuild({ EAS_BUILD_PROFILE: 'production-apk' });
  const gradleProps = readIfExists('android/gradle.properties');
  assert.ok(gradleProps, 'expo prebuild must produce android/gradle.properties');
  const matches = gradleProps.match(/^\s*expo\.useLegacyPackaging\s*=\s*(\S+)\s*$/gm) ?? [];
  assert.equal(
    matches.length,
    1,
    `android/gradle.properties must define expo.useLegacyPackaging exactly once. Found ${matches.length}:\n${matches.join('\n')}`,
  );
  const value = matches[0].split('=')[1].trim();
  assert.equal(value, 'true', `expo.useLegacyPackaging must be "true". Got "${value}".`);
});

check('production-apk build.gradle carries exactly one EXECUTABLE arm64-v8a abiFilters, inside the REAL defaultConfig (comment-aware)', async () => {
  const plugin = await loadPlugin();
  const { stripGroovyComments, locateRealDefaultConfigBounds } = plugin;
  const buildGradle = readIfExists('android/app/build.gradle');
  assert.ok(buildGradle, 'expo prebuild must produce android/app/build.gradle');
  const { code: stripped } = stripGroovyComments(buildGradle);
  const abiFilterOccurrences = stripped.match(/\babiFilters\b[^\n]*/g) ?? [];
  assert.equal(
    abiFilterOccurrences.length,
    1,
    `comment-stripped build.gradle must carry exactly one executable abiFilters statement. Found ${abiFilterOccurrences.length}:\n${abiFilterOccurrences.join('\n')}`,
  );
  assert.match(abiFilterOccurrences[0], /"arm64-v8a"/, `the sole abiFilters must include "arm64-v8a". Got: ${abiFilterOccurrences[0].trim()}`);
  assert.ok(
    !/\b(x86|x86_64|armeabi|armeabi-v7a|mips|mips64)\b/.test(abiFilterOccurrences[0]),
    `abiFilters must not reintroduce non-arm64 ABIs. Got: ${abiFilterOccurrences[0].trim()}`,
  );
  const splitsBlock = stripped.match(/\bsplits\s*\{[\s\S]*?\babi\s*\{[\s\S]*?\}[\s\S]*?\}/);
  if (splitsBlock) {
    assert.ok(
      !/\b(x86|x86_64|armeabi|armeabi-v7a|mips|mips64)\b/.test(splitsBlock[0]),
      `splits.abi block references a non-arm64 ABI:\n${splitsBlock[0]}`,
    );
  }
  // The abiFilters call must live inside the REAL defaultConfig — proven
  // by locating the block on the comment-stripped source and checking the
  // abiFilters offset falls inside its brace-balanced bounds.
  const bounds = locateRealDefaultConfigBounds(buildGradle);
  assert.ok(bounds, 'the real defaultConfig block must be locatable');
  const abiMatch = stripped.search(/\babiFilters\s+["']arm64-v8a["']/);
  assert.ok(
    abiMatch > bounds.openStripped && abiMatch < bounds.closeStripped,
    `arm64-v8a abiFilters must sit inside the real defaultConfig block ` +
      `(bounds stripped=${bounds.openStripped}..${bounds.closeStripped}, abi=${abiMatch})`,
  );
});

check('production-apk generated Gradle keeps applicationId com.dicoge.holohunter', () => {
  const buildGradle = readIfExists('android/app/build.gradle');
  assert.ok(
    /applicationId\s+['"]com\.dicoge\.holohunter['"]/.test(buildGradle),
    'the generated build.gradle must keep applicationId com.dicoge.holohunter',
  );
});

check('production (AAB) prebuild must NOT set expo.useLegacyPackaging=true and must keep all four ABIs (DIC-1269 CR round-1 blocker 2)', async () => {
  const plugin = await loadPlugin();
  const { stripGroovyComments } = plugin;
  cleanAndroid();
  runPrebuild({ EAS_BUILD_PROFILE: 'production' });
  const gradleProps = readIfExists('android/gradle.properties');
  assert.ok(gradleProps, 'expo prebuild must produce android/gradle.properties');
  const legacy = gradleProps.match(/^\s*expo\.useLegacyPackaging\s*=\s*(\S+)\s*$/m);
  assert.ok(legacy, 'gradle.properties must define expo.useLegacyPackaging');
  assert.equal(
    legacy[1].trim(),
    'false',
    'the production AAB must keep the Expo default expo.useLegacyPackaging=false — DIC-1269 CR round-1 blocker 2 forbids narrowing the store bundle',
  );
  const buildGradle = readIfExists('android/app/build.gradle');
  const { code: stripped } = stripGroovyComments(buildGradle);
  const abi = stripped.match(/\babiFilters\b[^\n]*/g) ?? [];
  assert.equal(
    abi.length,
    0,
    `the production AAB must have zero executable abiFilters statements. Found: ${abi.join('\n')}`,
  );
});

// ---------- run ----------------------------------------------------------------

let failed = 0;
try {
  for (const { name, fn } of checks) {
    try {
      await fn();
      process.stdout.write(`ok  ${name}\n`);
    } catch (err) {
      failed += 1;
      process.stdout.write(`FAIL ${name}\n`);
      process.stderr.write(`     ${err?.message ?? err}\n`);
    }
  }
} finally {
  cleanAndroid();
}
process.stdout.write(`\n${checks.length - failed}/${checks.length} checks passed\n`);
if (failed) process.exit(1);
