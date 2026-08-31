#!/usr/bin/env node
/**
 * DIC-1266 release-APK size + content guards (static half).
 *
 * The paired suite is `scripts/test-release-apk-prebuild-effective.mjs` — it
 * runs a real `npx expo prebuild --platform android --no-install --clean`
 * against the plugin so the effective generated `android/app/build.gradle`
 * and `android/gradle.properties` are asserted, not only the plugin's
 * isolated string transform. Both suites run in CI (Validate + eas-build
 * preflight).
 *
 * This static suite enforces:
 *
 *   1. Package identity is `com.dicoge.holohunter` (all three build config
 *      files must agree — a divergence means the sideload APK is not the
 *      store app, so the QA/CR chain has been reading the wrong artifact).
 *
 *   2. Release / non-debug packaging — `app.base.json` may not opt back
 *      into debuggable manifests, and `eas.json` `production` /
 *      `production-apk` must not carry a `NODE_ENV=development` override
 *      or a `distribution: development` slot.
 *
 *   3. Size-optim plugin is registered AND is strictly scoped to
 *      `production-apk` (DIC-1269 CR blocker 2 — the `production` AAB must
 *      keep all four native ABIs so the Play Store per-device APK split
 *      does not drop `armeabi-v7a`, `x86`, or `x86_64` support without an
 *      explicit accepted contract). The plugin:
 *       - injects `defaultConfig.ndk.abiFilters "arm64-v8a"` into
 *         `android/app/build.gradle`;
 *       - refuses to insert twice when the tag lives INSIDE
 *         `defaultConfig` (relocating the tag elsewhere in the file must
 *         NOT trick the idempotency check into no-op — DIC-1269 CR
 *         blocker 3);
 *       - refuses (throws) when a competing `abiFilters` block that
 *         restores non-arm64 ABIs is present anywhere in the file — a
 *         later `ndk { abiFilters "x86", "x86_64" }` cannot silently
 *         revert the size optimisation (DIC-1269 CR blocker 3);
 *       - refuses (throws) when a `splits { abi { include ... } }`
 *         construct references non-arm64 ABIs, since split APKs bypass
 *         `abiFilters`;
 *       - sets `expo.useLegacyPackaging=true` via `withGradleProperties`
 *         (Expo's own template block at `android/app/build.gradle:134-139`
 *         reads that property and calls `useLegacyPackaging enable…
 *         .toBoolean()`, so writing the property is the ONLY way to
 *         override the default `false` — a raw `build.gradle` insertion
 *         is reverted by the later template block; see
 *         DIC-1269 CR blocker 1).
 *
 *   4. hEB01 214 with nameZh 214/214 and skillsZh 214/214 in
 *      `data/database.json` (the exact DIC-1265 QA baseline).
 *
 *   5. No `openrouter` / `OPENROUTER` occurrence in `api/` OUTSIDE
 *      comments — a structural invariant. The DIC-1269 CR flagged three
 *      composition-based bypasses that the previous grep-of-URL guard
 *      missed:
 *        - `fetch('https://' + 'openrouter.ai/…')` still writes
 *          `openrouter.ai` into a source string, so a comment-stripped
 *          case-insensitive grep for `openrouter` finds it;
 *        - `process.env['OPENROUTER_' + 'API_KEY']` still writes
 *          `OPENROUTER_` into a source string, so the same grep finds it;
 *        - `require('openrouter-sdk')` matches the same rule.
 *      All existing `openrouter` mentions in `api/` live inside comments
 *      (verified below), so a hard "zero occurrences after comment strip"
 *      rule is safe AND catches the composed forms.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

// ---------- 1. Package identity ------------------------------------------------

const EXPECTED_PACKAGE = 'com.dicoge.holohunter';

check('package identity is com.dicoge.holohunter across app.base.json', () => {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.base.json'), 'utf8'));
  assert.equal(
    base.expo?.android?.package,
    EXPECTED_PACKAGE,
    `android.package must be ${EXPECTED_PACKAGE} — the DIC-1265 QA verified this exact package inside the signed APK; changing it means the sideload APK is not the same app the store profile ships`,
  );
  assert.equal(
    base.expo?.ios?.bundleIdentifier,
    EXPECTED_PACKAGE,
    `ios.bundleIdentifier must be ${EXPECTED_PACKAGE} — iOS/Android identity must stay locked to the same product`,
  );
});

// ---------- 2. Release / non-debug packaging ----------------------------------

check('app.base.json does not opt into debuggable manifests', () => {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.base.json'), 'utf8'));
  const android = base.expo?.android ?? {};
  assert.equal(
    android.manifestPlaceholders?.debuggable,
    undefined,
    'android.manifestPlaceholders.debuggable must not be set — the release manifest must never be debuggable',
  );
  assert.equal(
    android.debuggable,
    undefined,
    'android.debuggable must not be set at the app level — release builds are non-debug by construction',
  );
});

check('eas.json production / production-apk do not carry a dev override', () => {
  const eas = JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));
  for (const profileName of ['production', 'production-apk']) {
    const profile = eas.build?.[profileName];
    assert.ok(profile, `eas.json must define the "${profileName}" build profile`);
    assert.notEqual(
      profile.distribution,
      'development',
      `"${profileName}" must not use distribution: development — that swaps in the dev client and reintroduces debuggable code`,
    );
    assert.notEqual(
      profile.developmentClient,
      true,
      `"${profileName}" must not enable developmentClient — a dev client build is not a release artifact`,
    );
    assert.notEqual(
      profile.env?.NODE_ENV,
      'development',
      `"${profileName}" must not force NODE_ENV=development — that would ship the dev bundle as if it were the release one`,
    );
  }
});

// ---------- 3. ABI / device compatibility + jniLibs compression ---------------

check('withReleaseApkSizeOptim plugin exists and is registered', () => {
  const pluginRelPath = './plugins/withReleaseApkSizeOptim';
  const pluginFile = path.join(ROOT, `${pluginRelPath}.js`);
  assert.ok(
    fs.existsSync(pluginFile),
    `${pluginRelPath}.js is required — it restricts the sideload APK's native libs to arm64-v8a and enables jniLibs compression so the artifact fits under the Multica attachment cap`,
  );
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.base.json'), 'utf8'));
  const plugins = base.expo?.plugins ?? [];
  const registered = plugins.some((entry) => {
    if (typeof entry === 'string') return entry === pluginRelPath;
    if (Array.isArray(entry) && typeof entry[0] === 'string') return entry[0] === pluginRelPath;
    return false;
  });
  assert.ok(
    registered,
    `${pluginRelPath} must be listed in app.base.json expo.plugins — otherwise Expo prebuild never runs it and the APK ships with all four ABIs again`,
  );
});

check('plugin fires for production-apk ONLY (never production) — DIC-1269 CR blocker 2', () => {
  const plugin = require_(path.join(ROOT, 'plugins', 'withReleaseApkSizeOptim.js'));
  const { shouldApply } = plugin.__internal;
  const saved = { profile: process.env.EAS_BUILD_PROFILE, override: process.env.HUNTER_APK_SIZE_OPTIM };
  try {
    delete process.env.EAS_BUILD_PROFILE;
    delete process.env.HUNTER_APK_SIZE_OPTIM;
    assert.equal(shouldApply(), false, 'no env set → plugin must NOT modify anything (keeps local prebuild + CI emulator working)');
    process.env.EAS_BUILD_PROFILE = 'development';
    assert.equal(shouldApply(), false, 'development profile → plugin must NOT restrict ABIs');
    process.env.EAS_BUILD_PROFILE = 'preview';
    assert.equal(shouldApply(), false, 'preview profile → plugin must NOT restrict ABIs');
    process.env.EAS_BUILD_PROFILE = 'production';
    assert.equal(
      shouldApply(),
      false,
      'production profile (Play AAB) must NOT be narrowed — DIC-1269 CR blocker 2 keeps armeabi-v7a / x86 / x86_64 available to the Play Store per-device split without an explicit accepted contract',
    );
    process.env.EAS_BUILD_PROFILE = 'production-apk';
    assert.equal(shouldApply(), true, 'production-apk profile (sideload) → plugin MUST fire, that is the whole point');
    delete process.env.EAS_BUILD_PROFILE;
    process.env.HUNTER_APK_SIZE_OPTIM = '1';
    assert.equal(shouldApply(), true, 'explicit HUNTER_APK_SIZE_OPTIM=1 override → plugin fires (used by the prebuild-effective suite)');
  } finally {
    if (saved.profile == null) delete process.env.EAS_BUILD_PROFILE;
    else process.env.EAS_BUILD_PROFILE = saved.profile;
    if (saved.override == null) delete process.env.HUNTER_APK_SIZE_OPTIM;
    else process.env.HUNTER_APK_SIZE_OPTIM = saved.override;
  }
});

// A skeleton that reproduces the two important shapes of the real Expo /
// RN 0.81 generated `android/app/build.gradle`:
//   1. `defaultConfig { … }` where the ABI filter must land;
//   2. a LATER `packagingOptions { jniLibs { … findProperty(
//      'expo.useLegacyPackaging') ?: 'false' … } }` block that would
//      override any raw `useLegacyPackaging = true` insertion earlier in
//      the file (DIC-1269 CR blocker 1). The transform now sets a Gradle
//      property instead of inserting a duplicate DSL block, so this
//      template block must remain untouched — the guard verifies that
//      too.
const REAL_TEMPLATE_SKELETON = `
apply plugin: "com.android.application"

android {
    ndkVersion rootProject.ext.ndkVersion

    defaultConfig {
        applicationId 'com.dicoge.holohunter'
        minSdkVersion 24
        targetSdkVersion 36
        versionCode 1
        versionName "1.0.0"
    }

    signingConfigs { }

    buildTypes {
        release {
            signingConfig signingConfigs.debug
        }
    }

    packagingOptions {
        jniLibs {
            def enableLegacyPackaging = findProperty('expo.useLegacyPackaging') ?: 'false'
            useLegacyPackaging enableLegacyPackaging.toBoolean()
        }
    }
}
`;

check('plugin transform inserts arm64-v8a-only abiFilters and leaves Expo template block intact', () => {
  const plugin = require_(path.join(ROOT, 'plugins', 'withReleaseApkSizeOptim.js'));
  const { transformGradle, ABI_TAG, REQUIRED_ABI } = plugin.__internal;
  const out = transformGradle(REAL_TEMPLATE_SKELETON);
  assert.ok(out.includes(ABI_TAG), 'transformed gradle must carry the ABI tag');
  assert.match(
    out,
    /defaultConfig\s*\{[\s\S]*?ndk\s*\{[^}]*abiFilters\s+"arm64-v8a"[\s\S]*?\}[\s\S]*?applicationId/,
    'ndk.abiFilters "arm64-v8a" must be inserted inside defaultConfig, BEFORE the existing children',
  );
  assert.equal(REQUIRED_ABI, 'arm64-v8a');
  // Idempotency: running the transform again on the already-modified file
  // must be a no-op. Expo re-runs config plugins on every prebuild.
  const out2 = transformGradle(out);
  assert.equal(
    out,
    out2,
    'transformGradle must be idempotent — Expo prebuild re-runs plugins and re-inserting would duplicate the ABI block and fail gradle',
  );
  // The Expo template's later `useLegacyPackaging enableLegacyPackaging.
  // toBoolean()` block is deliberately left untouched — the plugin sets
  // the gradle property instead, which that same block reads.
  const expoTemplateBlock = out.match(
    /packagingOptions\s*\{[\s\S]*?jniLibs\s*\{[\s\S]*?findProperty\('expo\.useLegacyPackaging'\)[\s\S]*?useLegacyPackaging[^\n]+\.toBoolean\(\)[\s\S]*?\}[\s\S]*?\}/,
  );
  assert.ok(
    expoTemplateBlock,
    "the Expo template's packagingOptions { jniLibs { … findProperty('expo.useLegacyPackaging') … } } block must survive the transform verbatim — the plugin sets that property via withGradleProperties, so the template block is what applies the compression",
  );
});

check('plugin refuses when a later abiFilters block would restore non-arm64 ABIs', () => {
  const plugin = require_(path.join(ROOT, 'plugins', 'withReleaseApkSizeOptim.js'));
  const { transformGradle } = plugin.__internal;
  // Attacker mutation: inject an extra abiFilters somewhere in the file
  // that lists x86_64 / armeabi-v7a; if the plugin only checks its own
  // insertion, the resulting APK still ships those ABIs.
  const abused = REAL_TEMPLATE_SKELETON.replace(
    /signingConfigs \{ \}/,
    `signingConfigs { }\n\n    productFlavors {\n        universal {\n            ndk { abiFilters "arm64-v8a", "x86_64", "armeabi-v7a" }\n        }\n    }`,
  );
  assert.throws(
    () => transformGradle(abused),
    /expected exactly one `abiFilters` statement|references a non-arm64 ABI/,
    'the plugin MUST throw when a second abiFilters statement (in a flavor / splits / variant) restores non-arm64 ABIs — a silent pass ships the oversized APK',
  );
  // Attacker mutation: `splits { abi { include "x86_64" } }` outputs
  // per-ABI slices and bypasses abiFilters entirely.
  const splitsAbused = REAL_TEMPLATE_SKELETON.replace(
    /signingConfigs \{ \}/,
    `signingConfigs { }\n\n    splits {\n        abi {\n            enable true\n            reset()\n            include "arm64-v8a", "x86_64"\n            universalApk false\n        }\n    }`,
  );
  assert.throws(
    () => transformGradle(splitsAbused),
    /splits \{ abi \{[\s\S]*non-arm64 ABI|expected exactly one `abiFilters`/,
    'a splits.abi.include list that names non-arm64 must fail the transform',
  );
});

check('plugin idempotency check requires the marker to live INSIDE defaultConfig', () => {
  const plugin = require_(path.join(ROOT, 'plugins', 'withReleaseApkSizeOptim.js'));
  const { markerLivesInsideDefaultConfig, ABI_TAG, transformGradle } = plugin.__internal;
  // Attacker mutation: the DIC-1266 tag sits in a comment ELSEWHERE in
  // the file, so a naive `gradle.includes(ABI_TAG)` check would think the
  // ABI filter is already applied and skip the real insertion.
  const relocatedMarker = REAL_TEMPLATE_SKELETON.replace(
    /apply plugin: "com.android.application"/,
    `apply plugin: "com.android.application"\n// ${ABI_TAG} — moved out of defaultConfig by a hostile edit`,
  );
  assert.equal(
    markerLivesInsideDefaultConfig(relocatedMarker, ABI_TAG),
    false,
    'a marker outside defaultConfig must NOT satisfy the idempotency check',
  );
  const out = transformGradle(relocatedMarker);
  const insideCount = (out.match(new RegExp(ABI_TAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
  assert.ok(
    insideCount >= 2,
    `the transform must still insert its ABI block when a relocated marker is present — found ${insideCount} marker occurrences after transform`,
  );
  assert.equal(
    markerLivesInsideDefaultConfig(out, ABI_TAG),
    true,
    'after the real insertion, the marker must live inside defaultConfig',
  );
});

check('plugin refuses unknown gradle layouts instead of silently doing nothing', () => {
  const plugin = require_(path.join(ROOT, 'plugins', 'withReleaseApkSizeOptim.js'));
  const { insertIntoDefaultConfig } = plugin.__internal;
  assert.throws(
    () => insertIntoDefaultConfig('android { }'),
    /could not locate `defaultConfig \{`/,
    'the plugin MUST throw when defaultConfig cannot be found — a silent no-op ships the 151 MB APK',
  );
});

check('plugin sets expo.useLegacyPackaging=true (Expo-supported property path)', () => {
  const plugin = require_(path.join(ROOT, 'plugins', 'withReleaseApkSizeOptim.js'));
  const {
    setUseLegacyPackagingProperty,
    LEGACY_PACKAGING_PROPERTY_KEY,
    LEGACY_PACKAGING_PROPERTY_VALUE,
  } = plugin.__internal;
  // Seed with the real Expo default the RN template writes into
  // android/gradle.properties.
  const before = [
    { type: 'property', key: 'expo.gif.enabled', value: 'true' },
    { type: 'property', key: 'expo.webp.enabled', value: 'true' },
    { type: 'property', key: LEGACY_PACKAGING_PROPERTY_KEY, value: 'false' },
    { type: 'property', key: 'expo.edgeToEdgeEnabled', value: 'true' },
  ];
  const after = setUseLegacyPackagingProperty(structuredClone(before));
  const overridden = after.find((item) => item.key === LEGACY_PACKAGING_PROPERTY_KEY);
  assert.equal(
    overridden?.value,
    LEGACY_PACKAGING_PROPERTY_VALUE,
    'existing expo.useLegacyPackaging entry must be overwritten to true — a duplicate append would leave gradle reading whichever came last (undefined order)',
  );
  const withoutExisting = before.filter((item) => item.key !== LEGACY_PACKAGING_PROPERTY_KEY);
  const added = setUseLegacyPackagingProperty(structuredClone(withoutExisting));
  const appended = added.find((item) => item.key === LEGACY_PACKAGING_PROPERTY_KEY);
  assert.equal(appended?.value, LEGACY_PACKAGING_PROPERTY_VALUE, 'a missing entry must be appended');
  // No duplicates in either case (would confuse Gradle property resolution).
  for (const list of [after, added]) {
    const matching = list.filter((item) => item.key === LEGACY_PACKAGING_PROPERTY_KEY);
    assert.equal(matching.length, 1, `expo.useLegacyPackaging must appear exactly once — found ${matching.length}`);
  }
});

// ---------- 4. hEB01 content coverage -----------------------------------------

check('data/database.json ships hEB01 214 with nameZh 214/214 and skillsZh 214/214', () => {
  const dbPath = path.join(ROOT, 'data', 'database.json');
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const cards = db.cards ?? {};
  const hEB01 = Object.values(cards).filter((card) => card?.sourceProduct === 'hEB01');
  assert.equal(
    hEB01.length,
    214,
    `hEB01 must contain exactly 214 cards (DIC-1265 QA baseline). Found ${hEB01.length}. A size-optim change that drops cards is a content contract violation, not a size fix.`,
  );
  const withNameZh = hEB01.filter((card) => typeof card?.nameZh === 'string' && card.nameZh.trim().length > 0);
  assert.equal(
    withNameZh.length,
    214,
    `hEB01 nameZh must be 214/214 non-empty (DIC-1265 QA baseline). Found ${withNameZh.length}/214.`,
  );
  const withSkillsZh = hEB01.filter((card) => {
    const s = card?.skillsZh;
    if (!s || typeof s !== 'object') return false;
    return Object.values(s).some((v) => typeof v === 'string' && v.trim().length > 0);
  });
  assert.equal(
    withSkillsZh.length,
    214,
    `hEB01 skillsZh must be 214/214 with at least one non-empty translated field (DIC-1265 QA baseline: 1870/1870 non-empty text leaves across the 214 cards). Found ${withSkillsZh.length}/214.`,
  );
});

// ---------- 5. Structural no-OpenRouter guard (DIC-1269 CR blocker 3) ---------

/**
 * Strip Groovy/JS `//` line comments and `/* … *​/` block comments so the
 * denylist scan only sees code the runtime could execute. String-literal
 * detection sits inside this normalised form; a composed
 * `'https://' + 'openrouter.ai/…'` still leaves the `openrouter` token in
 * the second literal, which the tight case-insensitive grep below catches.
 * Only genuine comments (never a `//` inside a string) survive as removed
 * regions, so a URL that happens to embed `://` reads correctly.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let quote = null; // '"' | "'" | '`' | null
  let templateDepth = 0;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < n) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (quote === '`' && ch === '$' && next === '{') {
        out += next;
        i += 2;
        templateDepth += 1;
        quote = null;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '}' && templateDepth > 0) {
      templateDepth -= 1;
      quote = '`';
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

check('api/ has zero non-comment occurrences of `openrouter` or `OPENROUTER` (DIC-1185 hard denylist)', () => {
  const apiDir = path.join(ROOT, 'api');
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|mjs|cjs)$/i.test(entry.name)) files.push(p);
    }
  };
  walk(apiDir);
  const OFFENDING = [];
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    const code = stripComments(raw);
    // Structural rule: zero occurrences of `openrouter` or `OPENROUTER`
    // outside comments. Fragmented forms — `'openrouter' + '.ai'`,
    // `'OPENROUTER_' + 'API_KEY'`, `require('openrouter-sdk')`, dynamic
    // property access `env['OPENROUTER_' + suffix]` — all still write at
    // least one of these tokens into executable source, so this catches
    // them without needing an AST. The current api/ has these tokens
    // ONLY in comments (verified by baseline `grep -rin openrouter api/`),
    // so a zero-tolerance rule is behaviour-preserving here.
    const lines = code.split('\n');
    lines.forEach((line, idx) => {
      const rx = /openrouter/gi;
      let m;
      while ((m = rx.exec(line)) !== null) {
        OFFENDING.push(`${path.relative(ROOT, file)}:${idx + 1} → …${line.slice(Math.max(0, m.index - 8), Math.min(line.length, m.index + 24))}…`);
      }
    });
  }
  assert.deepEqual(
    OFFENDING,
    [],
    `api/ must contain zero \`openrouter\`/\`OPENROUTER\` occurrences outside comments. Offenders:\n  ${OFFENDING.join('\n  ')}\n\n` +
      'OpenRouter is a permanent FinOps denylist (DIC-1185). A build that opens a connection to ' +
      'openrouter.ai — including via string composition like `\'https://\' + \'openrouter.ai/…\'` ' +
      'or dynamic env lookup like `process.env[\'OPENROUTER_\' + \'API_KEY\']` — defeats the whole ' +
      'reason the APK exists.',
  );
});

// ---------- run ----------------------------------------------------------------

let failed = 0;
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
process.stdout.write(`\n${checks.length - failed}/${checks.length} checks passed\n`);
if (failed) process.exit(1);
