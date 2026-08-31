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
//      `.so` entries inside the APK (~50% ratio on arm64-v8a libs).
//
//      The property MUST be set via `android/gradle.properties`, not by
//      inserting a `packagingOptions.jniLibs.useLegacyPackaging = true`
//      block into `android/app/build.gradle`. Expo's template already
//      emits a later `packagingOptions { jniLibs { def enableLegacyPackaging
//      = findProperty('expo.useLegacyPackaging') ?: 'false';
//      useLegacyPackaging enableLegacyPackaging.toBoolean() } }` block
//      which overrides any earlier assignment on the same DSL — a raw
//      build.gradle insertion is silently reverted at build time (DIC-1269
//      CR round-1 blocker 1). Writing to `expo.useLegacyPackaging` is the
//      Expo-supported path that the existing template block reads.
//
// Applied together, a locally repackaged arm64-v8a-only + compressed-lib
// version of the DIC-1264 APK measures ~33 MB (from 151 MB) — well under
// the 50 MB Telegram Bot API media cap.
//
// Scope gate: `production-apk` ONLY (with `HUNTER_APK_SIZE_OPTIM=1` as the
// explicit override the guard test uses). `production` (AAB → Play Store)
// is deliberately NOT modified — DIC-1269 CR round-1 blocker 2 requires
// the store bundle to keep all four native ABIs. `preview`, `development`,
// and local `npx expo prebuild` invocations without the env var are
// unchanged.
//
// Comment-aware DSL selection (DIC-1269 CR round-2 blocker 2):
// `android/app/build.gradle` may contain Groovy `//` line comments or
// `/* … */` block comments before or around the real `android { }` DSL.
// A naive `gradle.search(/defaultConfig\s*\{/)` will match a
// `/* defaultConfig { } */` doc-comment first and cause the ABI insertion
// to land inside ignored text. Every DSL search / brace scan / prior-
// application check here runs against a comment-STRIPPED projection of
// the source that respects Groovy single-quoted, double-quoted, and
// triple-quoted strings; the position is mapped back to the ORIGINAL
// source only when we splice the insertion in. Prior-application uses the
// EXECUTABLE `abiFilters "arm64-v8a"` line (which survives comment
// stripping) as evidence of prior application — never the tag comment
// itself, which lives inside a `//` and would disappear from the
// stripped view.
//
// Bypass resistance (DIC-1269 CR blocker 3, round 1):
//   - After ABI insertion, `assertNoAbiRestoration` counts `abiFilters`
//     occurrences in the comment-STRIPPED source and refuses if any of
//     them references a non-arm64 ABI or if a `splits { abi { include
//     "x86" } }` block reintroduces per-ABI slices that bypass abiFilters.
//   - The gradle-property write via `withGradleProperties` sets a value
//     the downstream Expo template consumes, so the effective outcome is
//     provable against the real `expo prebuild` output (see
//     `scripts/test-release-apk-prebuild-effective.mjs`), not just against
//     an isolated string transform.

const ABI_TAG_LABEL = 'DIC-1266:abiFilter=arm64-v8a';
const ABI_INLINE_COMMENT = `// ${ABI_TAG_LABEL}`;
const REQUIRED_ABI = 'arm64-v8a';
const LEGACY_PACKAGING_PROPERTY_KEY = 'expo.useLegacyPackaging';
const LEGACY_PACKAGING_PROPERTY_VALUE = 'true';
const SCOPED_PROFILES = new Set(['production-apk']);

function shouldApply() {
  if (process.env.HUNTER_APK_SIZE_OPTIM === '1') return true;
  const profile = process.env.EAS_BUILD_PROFILE;
  return typeof profile === 'string' && SCOPED_PROFILES.has(profile);
}

// Strip Groovy `//` line comments and `/* ... */` block comments while
// preserving single-quoted, double-quoted, and triple-quoted strings.
// Returns `{ code, map }` where `code[i]` is a real (non-comment) source
// character and `map[i]` is its offset in the ORIGINAL source string. The
// map is used to splice modifications back into the original at the
// correct place (comments in the original are preserved verbatim).
function stripGroovyComments(src) {
  const out = [];
  const map = [];
  const n = src.length;
  let i = 0;
  let quote = null; // '"' | "'" | null
  let tripleQuote = null; // '"""' | "'''" | null
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    const third = src[i + 2];
    // Triple-quoted string body: everything is verbatim until the closing triple quote.
    if (tripleQuote) {
      out.push(ch);
      map.push(i);
      if (ch === tripleQuote[0] && next === tripleQuote[0] && third === tripleQuote[0]) {
        out.push(next, third);
        map.push(i + 1, i + 2);
        i += 3;
        tripleQuote = null;
        continue;
      }
      i += 1;
      continue;
    }
    // Single/double-quoted string body: preserve, respect backslash-escapes.
    if (quote) {
      out.push(ch);
      map.push(i);
      if (ch === '\\' && i + 1 < n) {
        out.push(src[i + 1]);
        map.push(i + 1);
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    // Enter a triple-quoted string.
    if ((ch === '"' || ch === "'") && next === ch && third === ch) {
      tripleQuote = ch + ch + ch;
      out.push(ch, next, third);
      map.push(i, i + 1, i + 2);
      i += 3;
      continue;
    }
    // Enter a normal string.
    if (ch === '"' || ch === "'") {
      quote = ch;
      out.push(ch);
      map.push(i);
      i += 1;
      continue;
    }
    // Line comment.
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    // Block comment.
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out.push(ch);
    map.push(i);
    i += 1;
  }
  return { code: out.join(''), map };
}

// Locate the REAL `defaultConfig { ... }` block in the comment-stripped
// projection and return the ORIGINAL-source offsets of its opening `{`
// and matched closing `}`. Returns null when no real `defaultConfig` DSL
// call exists — the caller is expected to fail closed rather than guess.
function locateRealDefaultConfigBounds(src) {
  const { code, map } = stripGroovyComments(src);
  const anchor = code.search(/\bdefaultConfig\s*\{/);
  if (anchor < 0) return null;
  const openBrace = code.indexOf('{', anchor);
  if (openBrace < 0) return null;
  let depth = 0;
  let closeBrace = -1;
  for (let i = openBrace; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        closeBrace = i;
        break;
      }
    }
  }
  if (closeBrace < 0) return null;
  return {
    openOriginal: map[openBrace],
    closeOriginal: map[closeBrace],
    openStripped: openBrace,
    closeStripped: closeBrace,
    strippedCode: code,
  };
}

// True if the real `defaultConfig` block ALREADY carries an
// `abiFilters "arm64-v8a"` statement (arm64-v8a required; other ABIs
// present in the same call are rejected downstream). Comment-aware so a
// `// abiFilters "arm64-v8a"` line does not falsely satisfy idempotency.
function abiFilterActiveInRealDefaultConfig(src) {
  const bounds = locateRealDefaultConfigBounds(src);
  if (!bounds) return false;
  const inside = bounds.strippedCode.slice(bounds.openStripped, bounds.closeStripped);
  return /\babiFilters\s+["']arm64-v8a["']/.test(inside);
}

function insertIntoDefaultConfig(gradle) {
  if (abiFilterActiveInRealDefaultConfig(gradle)) return gradle;
  const bounds = locateRealDefaultConfigBounds(gradle);
  if (!bounds) {
    throw new Error(
      'withReleaseApkSizeOptim: could not locate a real `defaultConfig { ... }` block in ' +
        'android/app/build.gradle (comment-aware search). The RN / Expo template layout changed ' +
        'and the size-optim plugin needs a matching update — refusing to silently ship the ' +
        'un-restricted 151 MB APK.',
    );
  }
  // Insert immediately AFTER the opening `{` and its following newline (if
  // any), so the ndk block is the first child of defaultConfig.
  let insertionPoint = bounds.openOriginal + 1;
  if (gradle[insertionPoint] === '\n') insertionPoint += 1;
  const block =
    `        ndk {\n` +
    `            abiFilters "${REQUIRED_ABI}"  ${ABI_INLINE_COMMENT}\n` +
    `        }\n`;
  return gradle.slice(0, insertionPoint) + block + gradle.slice(insertionPoint);
}

// After the ABI insertion runs we scan the comment-STRIPPED source for
// `abiFilters` occurrences that could restore non-arm64 targets. Exactly
// ONE occurrence is allowed — ours — and it must reference only
// `arm64-v8a`. Anything else (an existing later `ndk { abiFilters "x86",
// ... }`, a second call site, a `splits { abi { include ... } }` block
// a future author adds) is treated as a failure the release cannot
// silently absorb. A commented-out `// abiFilters "x86"` does NOT count
// because Gradle never executes it.
function assertNoAbiRestoration(gradle) {
  const { code: stripped } = stripGroovyComments(gradle);
  const abiFilterOccurrences = stripped.match(/\babiFilters\b[^\n]*/g) ?? [];
  if (abiFilterOccurrences.length !== 1) {
    throw new Error(
      `withReleaseApkSizeOptim: expected exactly one executable \`abiFilters\` statement in android/app/build.gradle, found ${abiFilterOccurrences.length}:\n` +
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
  const splitsBlock = stripped.match(/\bsplits\s*\{[\s\S]*?\babi\s*\{[\s\S]*?\}[\s\S]*?\}/);
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
  ABI_TAG_LABEL,
  ABI_INLINE_COMMENT,
  LEGACY_PACKAGING_PROPERTY_KEY,
  LEGACY_PACKAGING_PROPERTY_VALUE,
  REQUIRED_ABI,
  SCOPED_PROFILES,
  shouldApply,
  transformGradle,
  insertIntoDefaultConfig,
  assertNoAbiRestoration,
  setUseLegacyPackagingProperty,
  abiFilterActiveInRealDefaultConfig,
  locateRealDefaultConfigBounds,
  stripGroovyComments,
};
