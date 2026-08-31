// Release-APK size optimisation for the sideload delivery channel (DIC-1266).
//
// The 151 MB `production-apk` from DIC-1264 exceeded the Multica attachment
// upload path (Telegram media delivery capped by Bot API at 50 MB), so the
// verified artifact could not be delivered — only a URL. This plugin removes
// the two dominant, safe-to-drop contributors to that size WITHOUT changing
// product content:
//
//   1. `defaultConfig.ndk.abiFilters "arm64-v8a"` — the DIC-1264 APK ships
//      four native ABI directories (x86 24 MB + x86_64 23 MB + armeabi-v7a
//      22 MB + arm64-v8a 22 MB stored). Every Android device Google Play
//      distributes to today ships arm64-v8a, and the DIC-1265 QA device (an
//      Apple Silicon emulator) is arm64-v8a. Dropping the other three ABIs
//      removes ~68 MB of duplicate native code the sideload delivery is
//      never going to run.
//
//   2. `expo.useLegacyPackaging=true` — RN 0.71+ / AGP 3.6+ default this to
//      `false` so native libs are stored uncompressed for OS mmap. That
//      saves disk after install at the cost of the delivered APK carrying
//      every .so byte-for-byte. Flipping it back to `true` compresses the
//      `.so` entries inside the APK (~50% ratio on arm64-v8a libs) at the
//      cost of one extraction pass at install time. For a sideload / QA
//      delivery this is the correct side of the tradeoff.
//
//      The property MUST be set via `android/gradle.properties`, not by
//      inserting a `packagingOptions.jniLibs.useLegacyPackaging = true`
//      block into `android/app/build.gradle`. The Expo template already
//      emits a later `packagingOptions { jniLibs { def enableLegacyPackaging
//      = findProperty('expo.useLegacyPackaging') ?: 'false';
//      useLegacyPackaging enableLegacyPackaging.toBoolean() } }` block which
//      overrides any earlier assignment on the same DSL — so a raw
//      build.gradle insertion is silently reverted at build time (the CR
//      blocker in DIC-1269 that this file exists to fix). Writing to
//      `expo.useLegacyPackaging` is the Expo-supported path that the
//      existing template block reads.
//
// Applied together, a locally repackaged arm64-v8a-only + compressed-lib
// version of the DIC-1264 APK measures ~33 MB (from 151 MB) — well under
// the 50 MB Telegram Bot API media cap AND under any smaller comment
// attachment ceiling the Multica server may enforce.
//
// Scope gate: `production-apk` ONLY (with `HUNTER_APK_SIZE_OPTIM=1` as the
// explicit override the guard test uses). `production` (AAB → Play Store)
// is deliberately NOT modified — DIC-1269 CR blocker 2 requires the store
// bundle to keep all four native ABIs. `preview`, `development`, and local
// `npx expo prebuild` invocations without the env var are unchanged, so
// the CI emulator on any host and the dev workflow keep working.
//
// Bypass resistance (DIC-1269 CR blocker 3):
//   - Idempotency for the ABI insertion checks that the tag comment lives
//     INSIDE `defaultConfig` (not merely present somewhere in the file), so
//     relocating the marker cannot make the insertion no-op.
//   - After ABI insertion, the transform greps the output for any OTHER
//     `abiFilters` occurrence and throws — a later `ndk { abiFilters "x86",
//     ... }` block that would restore non-arm64 targets stops the build
//     instead of silently shipping a bigger APK.
//   - The gradle-property write via `withGradleProperties` sets a value the
//     downstream Expo template consumes, so the effective outcome is
//     provable against the real `expo prebuild` output (see
//     `scripts/test-release-apk-prebuild-effective.mjs`), not just against
//     an isolated string transform.

const ABI_TAG = '// DIC-1266:abiFilter=arm64-v8a';
const LEGACY_PACKAGING_PROPERTY_KEY = 'expo.useLegacyPackaging';
const LEGACY_PACKAGING_PROPERTY_VALUE = 'true';
const REQUIRED_ABI = 'arm64-v8a';
const SCOPED_PROFILES = new Set(['production-apk']);

function shouldApply() {
  if (process.env.HUNTER_APK_SIZE_OPTIM === '1') return true;
  const profile = process.env.EAS_BUILD_PROFILE;
  return typeof profile === 'string' && SCOPED_PROFILES.has(profile);
}

// True if AT LEAST ONE occurrence of `marker` sits inside the
// `defaultConfig { ... }` block of a Groovy `android { }` DSL. Uses a
// bracket-balanced scan so a preceding mention of `defaultConfig` in a
// comment or another block does not shift the match, and iterates every
// occurrence of `marker` so a stray copy relocated elsewhere in the file
// does not fool the check into thinking the real insertion already
// happened (DIC-1269 CR blocker 3).
function markerLivesInsideDefaultConfig(gradle, marker) {
  const anchor = gradle.search(/defaultConfig\s*\{/);
  if (anchor < 0) return false;
  const openBrace = gradle.indexOf('{', anchor);
  if (openBrace < 0) return false;
  let depth = 0;
  let closeBrace = -1;
  for (let i = openBrace; i < gradle.length; i += 1) {
    const ch = gradle[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        closeBrace = i;
        break;
      }
    }
  }
  if (closeBrace < 0) return false;
  let searchFrom = 0;
  while (searchFrom < gradle.length) {
    const idx = gradle.indexOf(marker, searchFrom);
    if (idx < 0) return false;
    if (idx > openBrace && idx < closeBrace) return true;
    searchFrom = idx + marker.length;
  }
  return false;
}

function insertIntoDefaultConfig(gradle) {
  if (markerLivesInsideDefaultConfig(gradle, ABI_TAG)) return gradle;
  const insertion =
    `\n        ndk {\n` +
    `            abiFilters "${REQUIRED_ABI}"  ${ABI_TAG}\n` +
    `        }\n`;
  const marker = /defaultConfig\s*\{\s*\n/;
  if (!marker.test(gradle)) {
    throw new Error(
      'withReleaseApkSizeOptim: could not locate `defaultConfig {` in android/app/build.gradle. ' +
        'The RN template layout changed and the size-optim plugin needs a matching update — refusing ' +
        'to silently ship the un-restricted 151 MB APK.',
    );
  }
  return gradle.replace(marker, (m) => m + insertion);
}

// After the ABI insertion runs we scan the whole file for `abiFilters`
// occurrences that could restore non-arm64 targets. Exactly ONE occurrence
// is allowed — ours — and it must reference only `arm64-v8a`. Anything
// else (an existing later `ndk { abiFilters "x86", ... }`, a second call
// site, a `splits { abi { include ... } }` block a future author adds) is
// treated as a failure the release cannot silently absorb.
function assertNoAbiRestoration(gradle) {
  const abiFilterOccurrences = gradle.match(/abiFilters\b[^\n]*/g) ?? [];
  if (abiFilterOccurrences.length !== 1) {
    throw new Error(
      `withReleaseApkSizeOptim: expected exactly one \`abiFilters\` statement in android/app/build.gradle, found ${abiFilterOccurrences.length}:\n` +
        `${abiFilterOccurrences.map((s) => `  ${s.trim()}`).join('\n')}\n` +
        'A second `abiFilters` (later in the file, in a splits block, or in a variant) restores the ABIs the size-optim plugin dropped — refusing to ship the resulting oversized APK.',
    );
  }
  const nonArm64 = /\b(x86|x86_64|armeabi|armeabi-v7a|mips|mips64)\b/;
  if (nonArm64.test(abiFilterOccurrences[0])) {
    throw new Error(
      `withReleaseApkSizeOptim: the sole \`abiFilters\` statement references a non-arm64 ABI: ${abiFilterOccurrences[0].trim()}\n` +
        'Refusing to reintroduce the ABIs the size-optim plugin exists to drop.',
    );
  }
  // Also refuse any `splits { abi { ... include "x86" } }` construct that
  // would output additional per-ABI APK slices — those bypass abiFilters.
  const splitsBlock = gradle.match(/splits\s*\{[\s\S]*?abi\s*\{[\s\S]*?\}[\s\S]*?\}/);
  if (splitsBlock && /\b(x86|x86_64|armeabi|armeabi-v7a|mips|mips64)\b/.test(splitsBlock[0])) {
    throw new Error(
      'withReleaseApkSizeOptim: an android { splits { abi { ... } } } block references a non-arm64 ABI. ' +
        'Split APKs would carry the ABIs the size-optim plugin dropped — refusing to build.',
    );
  }
}

function transformGradle(gradle) {
  const out = insertIntoDefaultConfig(gradle);
  assertNoAbiRestoration(out);
  return out;
}

function setUseLegacyPackagingProperty(properties) {
  const existing = properties.find(
    (item) => item?.type === 'property' && item.key === LEGACY_PACKAGING_PROPERTY_KEY,
  );
  if (existing) {
    existing.value = LEGACY_PACKAGING_PROPERTY_VALUE;
  } else {
    properties.push({
      type: 'property',
      key: LEGACY_PACKAGING_PROPERTY_KEY,
      value: LEGACY_PACKAGING_PROPERTY_VALUE,
    });
  }
  return properties;
}

function withReleaseApkSizeOptim(config) {
  const { withAppBuildGradle, withGradleProperties } = require('@expo/config-plugins');
  let out = withAppBuildGradle(config, (mod) => {
    if (!shouldApply()) return mod;
    if (mod.modResults.language !== 'groovy') {
      throw new Error(
        `withReleaseApkSizeOptim: expected groovy build.gradle, got ${mod.modResults.language}. ` +
          `Refusing to guess syntax; fix the plugin instead of shipping an unbounded APK.`,
      );
    }
    mod.modResults.contents = transformGradle(mod.modResults.contents);
    return mod;
  });
  out = withGradleProperties(out, (mod) => {
    if (!shouldApply()) return mod;
    mod.modResults = setUseLegacyPackagingProperty(mod.modResults);
    return mod;
  });
  return out;
}

module.exports = withReleaseApkSizeOptim;
// The guard test (scripts/test-release-apk-size-optim.mjs) imports these to
// verify the plugin's behavior without spinning up a full Expo prebuild.
module.exports.__internal = {
  ABI_TAG,
  LEGACY_PACKAGING_PROPERTY_KEY,
  LEGACY_PACKAGING_PROPERTY_VALUE,
  REQUIRED_ABI,
  SCOPED_PROFILES,
  shouldApply,
  transformGradle,
  insertIntoDefaultConfig,
  assertNoAbiRestoration,
  setUseLegacyPackagingProperty,
  markerLivesInsideDefaultConfig,
};
