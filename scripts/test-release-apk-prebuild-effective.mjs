#!/usr/bin/env node
/**
 * DIC-1266 release-APK effective-configuration guard.
 *
 * The static suite `scripts/test-release-apk-size-optim.mjs` validates the
 * plugin's inputs and its isolated string transform. That is necessary but
 * not sufficient: the DIC-1269 CR ran a real `npx expo prebuild` and found
 * that the previous plugin's `packagingOptions.jniLibs.useLegacyPackaging
 * = true` insertion in `build.gradle` was silently reverted by the Expo
 * template's later `useLegacyPackaging enableLegacyPackaging.toBoolean()`
 * block (reading `expo.useLegacyPackaging` from gradle.properties, default
 * `false`). A test whose skeleton omits the overwriting block cannot see
 * that failure.
 *
 * This suite runs a real `npx expo prebuild --platform android --no-install
 * --clean` against the checkout with `EAS_BUILD_PROFILE=production-apk` and
 * then asserts the EFFECTIVE generated configuration:
 *
 *   1. `android/gradle.properties` sets `expo.useLegacyPackaging=true`
 *      exactly once — so the Expo template block downstream reads `true`
 *      and calls `useLegacyPackaging true`.
 *
 *   2. `android/app/build.gradle` carries exactly one `abiFilters`
 *      occurrence and it references only `arm64-v8a`. No `splits { abi {
 *      include "x86" } }` construct reintroduces other ABIs.
 *
 *   3. The DIC-1266 injection marker lives inside `defaultConfig`.
 *
 *   4. `applicationId` on the generated Gradle matches
 *      `com.dicoge.holohunter` — package identity survives prebuild.
 *
 *   5. Running the plugin with `EAS_BUILD_PROFILE=production` (the Play
 *      AAB profile) MUST NOT emit either change — the AAB keeps all four
 *      ABIs and the stored-JNI Play default.
 *
 * The prebuild artefacts end up in `./android/`. Both `android/` and
 * `ios/` are not tracked by the repo — CI is ephemeral so the leftovers
 * do not matter, and the local run cleans them up on exit so a developer
 * `git status` after invoking the test stays clean.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runPrebuild(env) {
  // --no-install skips a pointless re-yarn/npm install after the
  // template is written; --clean deletes any leftover `android/` from a
  // previous invocation so nothing from an older profile bleeds through.
  const result = spawnSync(
    'npx',
    ['expo', 'prebuild', '--platform', 'android', '--no-install', '--clean'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        // A missing Google web client id makes app.config.js throw when
        // EAS_BUILD_PLATFORM=android; the size-optim guard has nothing to
        // do with that runtime credential, so a review placeholder is
        // enough to get through the config guard.
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

check('production-apk prebuild sets expo.useLegacyPackaging=true exactly once', () => {
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
  assert.equal(
    value,
    'true',
    `expo.useLegacyPackaging must be "true" in the production-apk build so the Expo template's packagingOptions block compresses native libs. Got "${value}".`,
  );
});

check('production-apk prebuild produces exactly one abiFilters (arm64-v8a) — and the DIC-1266 marker sits inside defaultConfig', () => {
  const buildGradle = readIfExists('android/app/build.gradle');
  assert.ok(buildGradle, 'expo prebuild must produce android/app/build.gradle');
  const abiFilterOccurrences = buildGradle.match(/abiFilters\b[^\n]*/g) ?? [];
  assert.equal(
    abiFilterOccurrences.length,
    1,
    `production-apk build.gradle must carry exactly one abiFilters statement. Found ${abiFilterOccurrences.length}:\n${abiFilterOccurrences.join('\n')}`,
  );
  assert.match(
    abiFilterOccurrences[0],
    /"arm64-v8a"/,
    `the sole abiFilters statement must include "arm64-v8a". Got: ${abiFilterOccurrences[0].trim()}`,
  );
  assert.ok(
    !/\b(x86|x86_64|armeabi|armeabi-v7a|mips|mips64)\b/.test(abiFilterOccurrences[0]),
    `abiFilters must not reintroduce non-arm64 ABIs. Got: ${abiFilterOccurrences[0].trim()}`,
  );
  const splitsBlock = buildGradle.match(/splits\s*\{[\s\S]*?abi\s*\{[\s\S]*?\}[\s\S]*?\}/);
  if (splitsBlock) {
    assert.ok(
      !/\b(x86|x86_64|armeabi|armeabi-v7a|mips|mips64)\b/.test(splitsBlock[0]),
      `splits.abi block in build.gradle references a non-arm64 ABI:\n${splitsBlock[0]}`,
    );
  }
  const abiTagIdx = buildGradle.indexOf('// DIC-1266:abiFilter=arm64-v8a');
  assert.ok(abiTagIdx > 0, 'the DIC-1266 abiFilter marker must appear in the generated build.gradle');
  const defaultConfigOpen = buildGradle.search(/defaultConfig\s*\{/);
  const openBrace = buildGradle.indexOf('{', defaultConfigOpen);
  let depth = 0;
  let closeBrace = -1;
  for (let i = openBrace; i < buildGradle.length; i += 1) {
    const ch = buildGradle[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        closeBrace = i;
        break;
      }
    }
  }
  assert.ok(
    abiTagIdx > openBrace && abiTagIdx < closeBrace,
    `the DIC-1266 marker must live inside defaultConfig (open=${openBrace}, close=${closeBrace}, marker=${abiTagIdx}) — a relocated marker would let the plugin no-op on the next prebuild`,
  );
});

check('production-apk generated Gradle keeps applicationId com.dicoge.holohunter', () => {
  const buildGradle = readIfExists('android/app/build.gradle');
  assert.ok(
    /applicationId\s+['"]com\.dicoge\.holohunter['"]/.test(buildGradle),
    'the generated build.gradle must keep applicationId com.dicoge.holohunter — package identity is the DIC-1265 QA baseline',
  );
});

check('production (AAB) prebuild must NOT set expo.useLegacyPackaging=true and must keep all four ABIs (DIC-1269 CR blocker 2)', () => {
  cleanAndroid();
  runPrebuild({ EAS_BUILD_PROFILE: 'production' });
  const gradleProps = readIfExists('android/gradle.properties');
  assert.ok(gradleProps, 'expo prebuild must produce android/gradle.properties');
  const legacy = gradleProps.match(/^\s*expo\.useLegacyPackaging\s*=\s*(\S+)\s*$/m);
  assert.ok(legacy, 'gradle.properties must define expo.useLegacyPackaging (Expo template default)');
  assert.equal(
    legacy[1].trim(),
    'false',
    'the production AAB must keep the Expo default expo.useLegacyPackaging=false — DIC-1269 CR blocker 2 forbids narrowing the store bundle without an explicit accepted contract',
  );
  const buildGradle = readIfExists('android/app/build.gradle');
  const abi = buildGradle.match(/abiFilters\b[^\n]*/g) ?? [];
  assert.equal(
    abi.length,
    0,
    `the production AAB must have zero abiFilters statements — the Play Store per-device split covers ABI targeting. Found: ${abi.join('\n')}`,
  );
  assert.ok(
    !buildGradle.includes('// DIC-1266:abiFilter=arm64-v8a'),
    'the DIC-1266 marker must NOT appear in the production AAB build.gradle — the plugin must be scoped to production-apk only',
  );
});

// ---------- run ----------------------------------------------------------------

let failed = 0;
try {
  for (const { name, fn } of checks) {
    try {
      fn();
      process.stdout.write(`ok  ${name}\n`);
    } catch (err) {
      failed += 1;
      process.stdout.write(`FAIL ${name}\n`);
      process.stderr.write(`     ${err?.message ?? err}\n`);
    }
  }
} finally {
  // Leave a clean tree behind so a developer running the suite locally
  // does not see an untracked android/ directory on their next `git
  // status`. CI is ephemeral, but this makes local invocation safe too.
  cleanAndroid();
}
process.stdout.write(`\n${checks.length - failed}/${checks.length} checks passed\n`);
if (failed) process.exit(1);
