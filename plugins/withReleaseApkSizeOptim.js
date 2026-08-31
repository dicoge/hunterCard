// Release-APK size optimisation for the sideload delivery channel (DIC-1266).
//
// The 151 MB `production-apk` from DIC-1264 exceeded the Multica attachment
// upload path (Telegram media delivery capped by Bot API at 50 MB), so the
// verified artifact could not be delivered — only a URL. This plugin removes
// the two dominant, safe-to-drop contributors to that size WITHOUT changing
// product content:
//
//   1. `ndk.abiFilters = ["arm64-v8a"]` — the current APK ships four native
//      ABI directories (x86 24 MB + x86_64 23 MB + armeabi-v7a 22 MB +
//      arm64-v8a 22 MB stored). Google Play has required arm64-v8a since
//      August 2019, every device Google Play distributes to today is 64-bit
//      ARM, and the DIC-1265 QA device (Apple Silicon emulator) is arm64-v8a.
//      Dropping the other three ABIs removes ~68 MB of duplicate native code
//      the sideload delivery is never going to run.
//
//   2. `packagingOptions.jniLibs.useLegacyPackaging = true` — RN 0.71+ /
//      AGP 3.6+ default to storing native libs UNCOMPRESSED so the OS can
//      mmap them directly from the APK. That saves disk after install at the
//      cost of the delivered APK carrying every .so byte-for-byte. Flipping
//      useLegacyPackaging back to `true` compresses the .so entries inside
//      the APK (~50% ratio on arm64-v8a libs) at the cost of one extraction
//      pass at install time. For a sideload / QA delivery this is the correct
//      side of the tradeoff.
//
// Applied together, a locally repackaged arm64-v8a-only, compressed-lib
// version of the DIC-1264 APK measures ~33 MB (from 151 MB) — well under
// the 50 MB Telegram Bot API media cap AND under any smaller comment
// attachment ceiling the Multica server may enforce.
//
// Scope gate: the modifications ONLY take effect for
// `EAS_BUILD_PROFILE in ("production", "production-apk")` (or when the
// explicit `HUNTER_APK_SIZE_OPTIM=1` override is set — used by the guard
// test). Locally-run `npx expo prebuild` and preview/development EAS builds
// are unchanged, so the CI emulator on any host and the dev workflow keep
// working. `production` and `production-apk` are treated identically because
// `scripts/test-release-apk-pipeline.mjs`
// (testReleaseApkDiffersFromStoreOnlyInContainer) requires the two resolved
// EAS profiles to be the same app modulo container; branching here between
// them would silently break that invariant.
//
// Idempotency: each injected block carries a tag comment; a re-run of the
// plugin (Expo rewrites gradle on every prebuild) checks for its own tag and
// skips insertion if already present. That keeps the plugin safe against
// double-application and against future manual edits to
// `android/app/build.gradle` that leave the tag intact.

// @expo/config-plugins is loaded lazily inside the exported plugin function so
// static analysis (`scripts/test-release-apk-size-optim.mjs`) can require this
// module in a minimal checkout that has not yet run `npm install`.
const ABI_TAG = '// DIC-1266:abiFilter=arm64-v8a';
const JNI_TAG = '// DIC-1266:jniLibs.useLegacyPackaging=true';

const REQUIRED_ABI = 'arm64-v8a';

function shouldApply() {
  if (process.env.HUNTER_APK_SIZE_OPTIM === '1') return true;
  const profile = process.env.EAS_BUILD_PROFILE;
  return profile === 'production' || profile === 'production-apk';
}

function insertIntoDefaultConfig(gradle) {
  if (gradle.includes(ABI_TAG)) return gradle;
  const insertion =
    `\n        ndk {\n` +
    `            abiFilters "${REQUIRED_ABI}"  ${ABI_TAG}\n` +
    `        }\n`;
  // The RN 0.81 template writes `defaultConfig {` on its own line inside the
  // `android { ... }` block. We insert the ndk block as the FIRST child of
  // defaultConfig; the existing children (applicationId, min/target/etc.)
  // still parse.
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

function insertPackagingOptions(gradle) {
  if (gradle.includes(JNI_TAG)) return gradle;
  const insertion =
    `\n    packagingOptions {\n` +
    `        jniLibs {\n` +
    `            useLegacyPackaging = true  ${JNI_TAG}\n` +
    `        }\n` +
    `    }\n`;
  // Append inside the top-level `android { ... }` block. We anchor on the
  // FIRST line after `android {` so re-running Expo prebuild (which may
  // regenerate the file) still finds the anchor.
  const marker = /android\s*\{\s*\n/;
  if (!marker.test(gradle)) {
    throw new Error(
      'withReleaseApkSizeOptim: could not locate `android {` in android/app/build.gradle. ' +
        'Refusing to skip the jniLibs compression that keeps the APK under the Multica ' +
        'attachment cap.',
    );
  }
  return gradle.replace(marker, (m) => m + insertion);
}

function transformGradle(gradle) {
  let out = gradle;
  out = insertIntoDefaultConfig(out);
  out = insertPackagingOptions(out);
  return out;
}

function withReleaseApkSizeOptim(config) {
  const { withAppBuildGradle } = require('@expo/config-plugins');
  return withAppBuildGradle(config, (mod) => {
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
}

module.exports = withReleaseApkSizeOptim;
// The guard test (scripts/test-release-apk-size-optim.mjs) imports these to
// verify the plugin's behavior without spinning up a full Expo prebuild.
module.exports.__internal = {
  ABI_TAG,
  JNI_TAG,
  REQUIRED_ABI,
  shouldApply,
  transformGradle,
  insertIntoDefaultConfig,
  insertPackagingOptions,
};
