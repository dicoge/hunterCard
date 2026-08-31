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
 *   1. Package identity is `com.dicoge.holohunter`.
 *   2. Release / non-debug packaging in `app.base.json` and `eas.json`.
 *   3. Size-optim plugin is registered, strictly scoped to `production-apk`,
 *      comment-aware in its Gradle DSL selection (a doc-comment
 *      `/* defaultConfig { } *​/` before the real DSL block must NOT trick
 *      the insertion into landing inside ignored text — DIC-1269 CR round-2
 *      blocker 2), and structurally rejects any ABI restoration
 *      (`splits { abi { include "x86" } }`, a second `abiFilters`, a
 *      flavor / variant reintroducing non-arm64) as well as unknown
 *      Gradle template layouts. Sets `expo.useLegacyPackaging=true` via
 *      `withGradleProperties` (DIC-1269 CR round-1 blocker 1).
 *   4. hEB01 214 with nameZh 214/214 and skillsZh 214/214.
 *   5. No `openrouter` / `OPENROUTER_` occurrence anywhere in `api/` that
 *      would evaluate at runtime. Backed by the AST-based scanner in
 *      `scripts/lib/openrouter-scan.mjs`, which folds string literals,
 *      template literals, `+`, `Array.join`, `String.concat`,
 *      `String.fromCharCode`, and identifier references bound to static
 *      values — so `['open','router.ai'].join('')`,
 *      `['OPEN','ROUTER_API_KEY'].join('')`, `'@open' + 'router/sdk'`,
 *      `fetch('https://' + h + '/…')` where `h` folds to `'openrouter.ai'`,
 *      and `process.env[k]` where `k` folds to `'OPENROUTER_API_KEY'`
 *      all fail closed (DIC-1269 CR round-2 blocker 1). Import specifiers
 *      that fold to `@openrouter/*` fail via the same rule.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  assert.equal(base.expo?.android?.package, EXPECTED_PACKAGE);
  assert.equal(base.expo?.ios?.bundleIdentifier, EXPECTED_PACKAGE);
});

// ---------- 2. Release / non-debug packaging ----------------------------------

check('app.base.json does not opt into debuggable manifests', () => {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.base.json'), 'utf8'));
  const android = base.expo?.android ?? {};
  assert.equal(android.manifestPlaceholders?.debuggable, undefined);
  assert.equal(android.debuggable, undefined);
});

check('eas.json production / production-apk do not carry a dev override', () => {
  const eas = JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));
  for (const profileName of ['production', 'production-apk']) {
    const profile = eas.build?.[profileName];
    assert.ok(profile, `eas.json must define the "${profileName}" build profile`);
    assert.notEqual(profile.distribution, 'development');
    assert.notEqual(profile.developmentClient, true);
    assert.notEqual(profile.env?.NODE_ENV, 'development');
  }
});

// ---------- 3. Plugin: presence, scoping, and DSL transform -------------------

check('withReleaseApkSizeOptim plugin exists and is registered', () => {
  const pluginRelPath = './plugins/withReleaseApkSizeOptim';
  const pluginFile = path.join(ROOT, `${pluginRelPath}.js`);
  assert.ok(fs.existsSync(pluginFile));
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.base.json'), 'utf8'));
  const plugins = base.expo?.plugins ?? [];
  const registered = plugins.some((entry) => {
    if (typeof entry === 'string') return entry === pluginRelPath;
    if (Array.isArray(entry) && typeof entry[0] === 'string') return entry[0] === pluginRelPath;
    return false;
  });
  assert.ok(registered, `${pluginRelPath} must be listed in app.base.json expo.plugins`);
});

check('plugin fires for production-apk ONLY (never production) — DIC-1269 CR blocker 2', () => {
  const plugin = require_(path.join(ROOT, 'plugins', 'withReleaseApkSizeOptim.js'));
  const { shouldApply } = plugin.__internal;
  const saved = { profile: process.env.EAS_BUILD_PROFILE, override: process.env.HUNTER_APK_SIZE_OPTIM };
  try {
    delete process.env.EAS_BUILD_PROFILE;
    delete process.env.HUNTER_APK_SIZE_OPTIM;
    assert.equal(shouldApply(), false, 'no env set → plugin must NOT modify anything');
    process.env.EAS_BUILD_PROFILE = 'development';
    assert.equal(shouldApply(), false, 'development profile → plugin must NOT restrict ABIs');
    process.env.EAS_BUILD_PROFILE = 'preview';
    assert.equal(shouldApply(), false, 'preview profile → plugin must NOT restrict ABIs');
    process.env.EAS_BUILD_PROFILE = 'production';
    assert.equal(shouldApply(), false, 'production (Play AAB) must NOT be narrowed — DIC-1269 CR blocker 2');
    process.env.EAS_BUILD_PROFILE = 'production-apk';
    assert.equal(shouldApply(), true, 'production-apk (sideload) → plugin MUST fire');
    delete process.env.EAS_BUILD_PROFILE;
    process.env.HUNTER_APK_SIZE_OPTIM = '1';
    assert.equal(shouldApply(), true, 'explicit override → plugin fires');
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
//      override any raw `useLegacyPackaging = true` insertion (DIC-1269
//      CR round-1 blocker 1). The transform now sets a Gradle property
//      instead of inserting a duplicate DSL block, so this template block
//      must remain untouched — the guard verifies that too.
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

check('plugin transform inserts arm64-v8a abiFilters inside REAL defaultConfig and leaves Expo template block intact', () => {
  const plugin = require_(path.join(ROOT, 'plugins', 'withReleaseApkSizeOptim.js'));
  const { transformGradle, REQUIRED_ABI, ABI_INLINE_COMMENT } = plugin.__internal;
  const out = transformGradle(REAL_TEMPLATE_SKELETON);
  assert.ok(out.includes(ABI_INLINE_COMMENT), 'transformed gradle must carry the DIC-1266 inline comment');
  assert.match(
    out,
    /defaultConfig\s*\{[\s\S]*?ndk\s*\{[^}]*abiFilters\s+"arm64-v8a"[\s\S]*?\}[\s\S]*?applicationId/,
    'ndk.abiFilters "arm64-v8a" must be inserted inside defaultConfig, BEFORE the existing children',
  );
  assert.equal(REQUIRED_ABI, 'arm64-v8a');
  const out2 = transformGradle(out);
  assert.equal(out, out2, 'transformGradle must be idempotent');
  const expoTemplateBlock = out.match(
    /packagingOptions\s*\{[\s\S]*?jniLibs\s*\{[\s\S]*?findProperty\('expo\.useLegacyPackaging'\)[\s\S]*?useLegacyPackaging[^\n]+\.toBoolean\(\)[\s\S]*?\}[\s\S]*?\}/,
  );
  assert.ok(expoTemplateBlock, "the Expo template's packagingOptions { jniLibs { … } } block must survive the transform verbatim");
});

check('plugin ignores comment-hidden `defaultConfig` and inserts into the real DSL block — DIC-1269 CR round-2 blocker 2', () => {
  const plugin = require_(path.join(ROOT, 'plugins', 'withReleaseApkSizeOptim.js'));
  const {
    transformGradle,
    locateRealDefaultConfigBounds,
    abiFilterActiveInRealDefaultConfig,
    stripGroovyComments,
  } = plugin.__internal;
  // The exact attacker mutation Mac-Codex flagged in round 3:
  // a valid-Groovy `/* … defaultConfig { } … */` doc-comment BEFORE the
  // real android { defaultConfig { … } } DSL. A naive regex hits the
  // commented `defaultConfig` first and would splice the ABI block into
  // ignored text — resulting in an APK that still ships all four ABIs.
  const attackerSource = `
/*
Future template documentation:
defaultConfig {
}
*/
android {
    defaultConfig {
        applicationId 'com.dicoge.holohunter'
        minSdkVersion 24
    }
}
`;
  const bounds = locateRealDefaultConfigBounds(attackerSource);
  assert.ok(bounds, 'the plugin must find the REAL defaultConfig even with a comment-hidden fake before it');
  // Verify the found bounds point at the executable DSL, not the comment.
  const openContextOriginal = attackerSource.slice(Math.max(0, bounds.openOriginal - 40), bounds.openOriginal + 1);
  assert.ok(
    openContextOriginal.includes('android {'),
    `open brace must belong to the real android { block. Got context: ${JSON.stringify(openContextOriginal)}`,
  );
  // Prior-application check must NOT be fooled by a commented abiFilters.
  const withCommentedAbi = attackerSource.replace(
    /defaultConfig \{\s*applicationId/,
    "defaultConfig {\n        // abiFilters \"arm64-v8a\"  fake\n        applicationId",
  );
  assert.equal(
    abiFilterActiveInRealDefaultConfig(withCommentedAbi),
    false,
    'a `// abiFilters "arm64-v8a"` comment inside the real block must NOT satisfy idempotency — Gradle never executes it',
  );
  // The transform must succeed and land the ABI block inside the REAL DSL.
  const out = transformGradle(attackerSource);
  const { findExecutableAbiFilterCalls } = plugin.__internal;
  const executableCalls = findExecutableAbiFilterCalls(out);
  assert.equal(
    executableCalls.length,
    1,
    `after transform, exactly one executable abiFilters call must exist. Found ${executableCalls.length}:\n${executableCalls.map((c) => '  ' + c.originalLine.trim()).join('\n')}`,
  );
  assert.match(
    executableCalls[0].originalLine,
    /"arm64-v8a"/,
    `the sole executable abiFilters call must include "arm64-v8a". Got: ${executableCalls[0].originalLine.trim()}`,
  );
  // Verify the executable call sits INSIDE the real android > defaultConfig
  // structural anchor, not in the comment.
  const boundsAfter = plugin.__internal.locateRealDefaultConfigBounds(out);
  assert.ok(boundsAfter, 'the real defaultConfig block must remain locatable after transform');
  assert.ok(
    executableCalls[0].strippedStart > boundsAfter.openStripped &&
      executableCalls[0].strippedStart < boundsAfter.closeStripped,
    'the executable abiFilters call must live inside the real defaultConfig block',
  );
  // Also idempotent under repeat: running transformGradle a second time
  // sees the abiFilters call in the real block and skips.
  const out2 = transformGradle(out);
  assert.equal(out, out2, 'transformGradle idempotency holds when a comment-hidden fake block precedes the real one');
  // stripGroovyComments export exists (used by the paired prebuild suite).
  assert.equal(typeof stripGroovyComments, 'function');
});

check('plugin ignores triple-quoted-string-hidden `defaultConfig` — DIC-1269 CR round-3 blocker 2', () => {
  const plugin = require_(path.join(ROOT, 'plugins', 'withReleaseApkSizeOptim.js'));
  const { transformGradle, locateRealDefaultConfigBounds, findExecutableAbiFilterCalls } = plugin.__internal;
  // The exact CR round-3 mutation: a Groovy triple-quoted string whose
  // body contains a fake `defaultConfig { }` block. The previous
  // stripGroovyComments PRESERVED string bodies, so the search matched
  // inside the string; the ABI block landed there and never affected the
  // real android { defaultConfig { … } }.
  const attackerSource = 'def docs = """\ndefaultConfig {\n}\n"""\nandroid {\n    defaultConfig { applicationId "com.dicoge.holohunter" }\n}\n';
  const bounds = locateRealDefaultConfigBounds(attackerSource);
  assert.ok(bounds, 'the plugin must find the REAL defaultConfig even with a triple-quoted-string fake before it');
  // The bounds must be inside the executable android { block, not the
  // string body.
  const openContext = attackerSource.slice(Math.max(0, bounds.openOriginal - 30), bounds.openOriginal + 1);
  assert.ok(
    /android\s*\{/.test(openContext),
    `open brace must belong to the real android { block. Got context: ${JSON.stringify(openContext)}`,
  );
  const out = transformGradle(attackerSource);
  // The triple-quoted string body must survive unchanged — verified by
  // slicing between its opening and closing `"""`.
  const openStr = out.indexOf('"""');
  const closeStr = out.indexOf('"""', openStr + 3);
  const stringBody = out.slice(openStr, closeStr + 3);
  assert.equal(
    stringBody,
    '"""\ndefaultConfig {\n}\n"""',
    `the triple-quoted string body must survive unchanged; got: ${JSON.stringify(stringBody)}`,
  );
  const executableCalls = findExecutableAbiFilterCalls(out);
  assert.equal(
    executableCalls.length,
    1,
    `exactly one executable abiFilters call must exist. Found ${executableCalls.length}:\n${executableCalls.map((c) => '  ' + c.originalLine.trim()).join('\n')}`,
  );
  assert.match(
    executableCalls[0].originalLine,
    /"arm64-v8a"/,
    `the sole executable call must include "arm64-v8a". Got: ${executableCalls[0].originalLine.trim()}`,
  );
});

check('plugin selects the TOP-LEVEL android closure, never a nested unused android — DIC-1269 CR round-4 blocker 2', () => {
  const plugin = require_(path.join(ROOT, 'plugins', 'withReleaseApkSizeOptim.js'));
  const { transformGradle, findExecutableAbiFilterCalls, locateRealDefaultConfigBounds } = plugin.__internal;
  // The exact CR round-4 attacker mutation: a valid Groovy closure
  // `def unused = { android { defaultConfig { } } }` that is never
  // invoked. The previous selector picked the first textual `android {`
  // at any nesting depth, so it landed the arm64 marker inside the
  // unused closure. The real top-level `android { defaultConfig { … } }`
  // stayed unfiltered — the release APK would silently retain all four
  // ABIs. The selector now requires `android` to sit at projection
  // brace depth 0 (top-level) and `defaultConfig` to be its direct
  // executable child.
  const attackerSource = `def unused = {
  android {
    defaultConfig { }
  }
}
android {
  defaultConfig { applicationId 'com.dicoge.holohunter' }
}
`;
  const bounds = locateRealDefaultConfigBounds(attackerSource);
  assert.ok(bounds, 'the plugin must find the REAL top-level android > defaultConfig, ignoring a nested unused closure');
  const openContext = attackerSource.slice(Math.max(0, bounds.openOriginal - 30), bounds.openOriginal + 1);
  assert.match(
    openContext,
    /\}\s*\}\s*android\s*\{\s*defaultConfig\s*\{$/,
    `open brace must belong to the SECOND (top-level) android { block. Got context: ${JSON.stringify(openContext)}`,
  );
  const out = transformGradle(attackerSource);
  const calls = findExecutableAbiFilterCalls(out);
  assert.equal(calls.length, 1, `exactly one executable abiFilters call must exist. Found ${calls.length}:\n${calls.map((c) => '  ' + c.originalLine.trim()).join('\n')}`);
  const markerOffset = out.indexOf('// DIC-1266:abiFilter=arm64-v8a');
  const realAndroidIdx = out.lastIndexOf('android {');
  assert.ok(
    markerOffset > realAndroidIdx,
    `the arm64 marker offset (${markerOffset}) must come AFTER the real top-level android { offset (${realAndroidIdx}). ` +
      'Landing the marker in the nested unused closure is the exact bypass this test forbids.',
  );
});

check('findBlockAtDepth ignores nested and rejects too-shallow / too-deep blocks', () => {
  const plugin = require_(path.join(ROOT, 'plugins', 'withReleaseApkSizeOptim.js'));
  const { findBlockAtDepth } = plugin.__internal;
  const src = `outer { android { inner { } } }\nandroid { top { } }`;
  const topAndroid = findBlockAtDepth(src, 'android', 0);
  assert.ok(topAndroid, 'a top-level android block MUST be found');
  assert.equal(src[topAndroid.openIdx], '{');
  assert.equal(src[topAndroid.closeIdx], '}');
  // The top-level match must be the SECOND `android {`, not the one
  // nested inside `outer { … }`.
  const startCtx = src.slice(topAndroid.openIdx - 8, topAndroid.openIdx + 1);
  assert.equal(startCtx, 'android {', `top-level android bounds must sit at the second occurrence. Got context: ${JSON.stringify(startCtx)}`);
  // Depth-1 lookup finds the nested android instead.
  const nestedAndroid = findBlockAtDepth(src, 'android', 1);
  assert.ok(nestedAndroid, 'a depth-1 android block MUST be found');
  assert.ok(nestedAndroid.openIdx < topAndroid.openIdx, 'the depth-1 android must sit before the top-level one');
});

check('plugin idempotency is not fooled by an `abiFilters "arm64-v8a"` inside a Groovy string literal', () => {
  const plugin = require_(path.join(ROOT, 'plugins', 'withReleaseApkSizeOptim.js'));
  const { abiFilterActiveInRealDefaultConfig } = plugin.__internal;
  // A raw string containing the literal text `abiFilters "arm64-v8a"`
  // is NOT executable Groovy — Gradle never runs it. The idempotency
  // check must refuse to accept it as prior application; otherwise a
  // hostile edit that appended such a string would skip the real
  // insertion.
  const withStringLiteralAbi = `
android {
    defaultConfig {
        def fakeDoc = "abiFilters \\"arm64-v8a\\" — this is data, not a call"
        applicationId 'com.dicoge.holohunter'
    }
}
`;
  assert.equal(
    abiFilterActiveInRealDefaultConfig(withStringLiteralAbi),
    false,
    'a string literal containing the abiFilters text must NOT satisfy the executable-idempotency check',
  );
});

check('plugin refuses when a later abiFilters block would restore non-arm64 ABIs', () => {
  const plugin = require_(path.join(ROOT, 'plugins', 'withReleaseApkSizeOptim.js'));
  const { transformGradle } = plugin.__internal;
  const abused = REAL_TEMPLATE_SKELETON.replace(
    /signingConfigs \{ \}/,
    `signingConfigs { }\n\n    productFlavors {\n        universal {\n            ndk { abiFilters "arm64-v8a", "x86_64", "armeabi-v7a" }\n        }\n    }`,
  );
  assert.throws(
    () => transformGradle(abused),
    /expected exactly one executable `abiFilters` statement|references a non-arm64 ABI/,
    'a second executable abiFilters (in a flavor / splits / variant) must fail closed',
  );
  const splitsAbused = REAL_TEMPLATE_SKELETON.replace(
    /signingConfigs \{ \}/,
    `signingConfigs { }\n\n    splits {\n        abi {\n            enable true\n            reset()\n            include "arm64-v8a", "x86_64"\n            universalApk false\n        }\n    }`,
  );
  assert.throws(
    () => transformGradle(splitsAbused),
    /splits \{ abi \{[\s\S]*non-arm64 ABI|expected exactly one executable `abiFilters`/,
    'a splits.abi.include list that names non-arm64 must fail the transform',
  );
  // Commented-out ABI restorations do NOT count.
  const commentedRestoration = REAL_TEMPLATE_SKELETON.replace(
    /signingConfigs \{ \}/,
    `signingConfigs { }\n\n    // productFlavors { universal { ndk { abiFilters "x86_64" } } }\n    /* splits { abi { include "x86_64" } } */`,
  );
  const out = transformGradle(commentedRestoration);
  assert.ok(out.includes(`abiFilters "arm64-v8a"`), 'commented-out non-arm64 references must not block the real insertion');
});

check('plugin refuses unknown gradle layouts (no defaultConfig at all) — no silent no-op', () => {
  const plugin = require_(path.join(ROOT, 'plugins', 'withReleaseApkSizeOptim.js'));
  const { transformGradle } = plugin.__internal;
  assert.throws(
    () => transformGradle('android { }'),
    /could not locate a real `defaultConfig \{ \.\.\. \}` block/,
    'a build.gradle without any defaultConfig must fail closed, not silently pass',
  );
});

check('plugin sets expo.useLegacyPackaging=true (Expo-supported property path)', () => {
  const plugin = require_(path.join(ROOT, 'plugins', 'withReleaseApkSizeOptim.js'));
  const { setUseLegacyPackagingProperty, LEGACY_PACKAGING_PROPERTY_KEY, LEGACY_PACKAGING_PROPERTY_VALUE } =
    plugin.__internal;
  const before = [
    { type: 'property', key: 'expo.gif.enabled', value: 'true' },
    { type: 'property', key: LEGACY_PACKAGING_PROPERTY_KEY, value: 'false' },
    { type: 'property', key: 'expo.edgeToEdgeEnabled', value: 'true' },
  ];
  const after = setUseLegacyPackagingProperty(structuredClone(before));
  const overridden = after.find((item) => item.key === LEGACY_PACKAGING_PROPERTY_KEY);
  assert.equal(overridden?.value, LEGACY_PACKAGING_PROPERTY_VALUE);
  const added = setUseLegacyPackagingProperty(
    structuredClone(before.filter((item) => item.key !== LEGACY_PACKAGING_PROPERTY_KEY)),
  );
  const appended = added.find((item) => item.key === LEGACY_PACKAGING_PROPERTY_KEY);
  assert.equal(appended?.value, LEGACY_PACKAGING_PROPERTY_VALUE);
  for (const list of [after, added]) {
    const matching = list.filter((item) => item.key === LEGACY_PACKAGING_PROPERTY_KEY);
    assert.equal(matching.length, 1);
  }
});

// ---------- 4. hEB01 content coverage -----------------------------------------

check('data/database.json ships hEB01 214 with nameZh 214/214 and skillsZh 214/214', () => {
  const dbPath = path.join(ROOT, 'data', 'database.json');
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const cards = db.cards ?? {};
  const hEB01 = Object.values(cards).filter((card) => card?.sourceProduct === 'hEB01');
  assert.equal(hEB01.length, 214, `hEB01 must contain exactly 214 cards. Found ${hEB01.length}.`);
  const withNameZh = hEB01.filter((card) => typeof card?.nameZh === 'string' && card.nameZh.trim().length > 0);
  assert.equal(withNameZh.length, 214, `hEB01 nameZh must be 214/214. Found ${withNameZh.length}/214.`);
  const withSkillsZh = hEB01.filter((card) => {
    const s = card?.skillsZh;
    if (!s || typeof s !== 'object') return false;
    return Object.values(s).some((v) => typeof v === 'string' && v.trim().length > 0);
  });
  assert.equal(withSkillsZh.length, 214, `hEB01 skillsZh must be 214/214. Found ${withSkillsZh.length}/214.`);
});

// ---------- 5. AST-based no-OpenRouter guard (DIC-1269 CR round-3 blocker 1) --

async function loadScanner() {
  const mod = await import(pathToFileURL(path.join(ROOT, 'scripts/lib/openrouter-scan.mjs')).href);
  return mod;
}

check('scanForOpenRouter reports fragmented composition — DIC-1269 CR round-2 blocker 1 (host/env/import)', async () => {
  const { scanForOpenRouter } = await loadScanner();
  // The exact mutation the CR ran to prove the previous grep bypass. If
  // this scanner also reports 0 offenders on this input, the fix is
  // useless — every branch must fail closed here.
  const fragmented = `
    const h = ['open', 'router.ai'].join('');
    const k = ['OPEN', 'ROUTER_API_KEY'].join('');
    const m = '@open' + 'router/sdk';
    void import(m);
    void fetch('https://' + h + '/api/v1/chat/completions', {
      headers: { Authorization: process.env[k] },
    });
  `;
  const offenders = scanForOpenRouter(fragmented, '<inline-mutation>');
  const flatValues = offenders.map((o) => o.value).join('\n');
  assert.ok(offenders.length > 0, 'the scanner MUST report at least one offender for the CR mutation');
  assert.ok(
    /openrouter\.ai/i.test(flatValues),
    `the folded host \`openrouter.ai\` must be caught. Offenders:\n${flatValues}`,
  );
  assert.ok(
    /OPENROUTER_API_KEY/.test(flatValues),
    `the folded env-var \`OPENROUTER_API_KEY\` must be caught. Offenders:\n${flatValues}`,
  );
  assert.ok(
    /@openrouter\/sdk/i.test(flatValues),
    `the folded package specifier \`@openrouter/sdk\` must be caught. Offenders:\n${flatValues}`,
  );
});

check('scanForOpenRouter catches ARRAY-BOUND fragmentation — DIC-1269 CR round-3 blocker 1', async () => {
  const { scanForOpenRouter } = await loadScanner();
  const arrayBound = `
    const hostParts = ['open', 'router.ai'];
    const keyParts = ['OPEN', 'ROUTER_API_KEY'];
    const moduleParts = ['@open', 'router/sdk'];
    const h = hostParts.join('');
    const k = keyParts.join('');
    const m = moduleParts.join('');
    void import(m);
    void fetch('https://' + h + '/api/v1/chat/completions', {
      headers: { Authorization: process.env[k] },
    });
  `;
  const offenders = scanForOpenRouter(arrayBound, '<inline-array-bound>');
  const flat = offenders.map((o) => o.value).join('\n');
  assert.ok(offenders.length > 0, `the scanner MUST report offenders for the CR round-3 mutation. Got 0.`);
  assert.ok(/openrouter\.ai/i.test(flat), `folded host \`openrouter.ai\` must be caught. Offenders:\n${flat}`);
  assert.ok(/OPENROUTER_API_KEY/.test(flat), `folded env-var \`OPENROUTER_API_KEY\` must be caught. Offenders:\n${flat}`);
  assert.ok(/@openrouter\/sdk/i.test(flat), `folded module spec \`@openrouter/sdk\` must be caught. Offenders:\n${flat}`);
  // DIC-1269 CR round-4: the array-binding fix must be REACHABLE through
  // the fold that resolves through the binding, not only through the
  // `ArrayExpression(empty-join)` visitor. Removing array persistence
  // (e.g., reverting VariableDeclarator to string-only storage) leaves
  // the empty-join visitor still reporting the literal arrays, which
  // would silently pass this regression. Require joined `CallExpression`
  // offenders AND the final composed URL from `BinaryExpression` folding
  // to prove the identifier→array→join→string chain actually works.
  const callExprOffenders = offenders.filter((o) => o.kind === 'CallExpression');
  assert.ok(
    callExprOffenders.some((o) => /openrouter\.ai$/i.test(o.value)),
    `at least one CallExpression offender must resolve through the array binding to \`openrouter.ai\` (identifier→array→join). Offenders:\n${JSON.stringify(offenders, null, 2)}`,
  );
  assert.ok(
    callExprOffenders.some((o) => /^OPENROUTER_API_KEY$/.test(o.value)),
    `at least one CallExpression offender must resolve through the array binding to \`OPENROUTER_API_KEY\`. Offenders:\n${JSON.stringify(offenders, null, 2)}`,
  );
  assert.ok(
    callExprOffenders.some((o) => /^@openrouter\/sdk$/i.test(o.value)),
    `at least one CallExpression offender must resolve through the array binding to \`@openrouter/sdk\`. Offenders:\n${JSON.stringify(offenders, null, 2)}`,
  );
  const composedUrl = offenders.find(
    (o) => o.kind === 'BinaryExpression' && /^https:\/\/openrouter\.ai\/api\/v1\/chat\/completions$/i.test(o.value),
  );
  assert.ok(
    composedUrl,
    `the final composed URL \`https://openrouter.ai/api/v1/chat/completions\` must be reported as a BinaryExpression fold. Offenders:\n${JSON.stringify(offenders, null, 2)}`,
  );
});

check('scanForOpenRouter respects LEXICAL SCOPE — an inner dead block cannot poison outer bindings (DIC-1269 CR round-4 blocker 1)', async () => {
  const { scanForOpenRouter } = await loadScanner();
  // The exact CR round-4 mutation. Previously the file-global env map
  // let the inner block's `const hostPrefix = "google"` overwrite the
  // outer `const hostPrefix = "open"`, so the downstream
  // `[hostPrefix, "router.ai"].join('')` folded to `"googlerouter.ai"` —
  // no match for "openrouter". The scanner now uses a Babel lexical-
  // scope stack: inner bindings are popped when the block ends, so the
  // outer prefix is what the fold resolves to.
  const lexicalShadow = `
    const hostPrefix = "open";
    const keyPrefix = "OPEN";
    const modulePrefix = "@open";
    {
      const hostPrefix = "google";
      const keyPrefix = "GEMINI";
      const modulePrefix = "@google";
    }
    const host = [hostPrefix, "router.ai"].join("");
    const key = [keyPrefix, "ROUTER_API_KEY"].join("");
    const moduleName = [modulePrefix, "router/sdk"].join("");
    void import(moduleName);
    void fetch("https://" + host + "/api/v1/chat/completions", {
      headers: { Authorization: process.env[key] },
    });
  `;
  const offenders = scanForOpenRouter(lexicalShadow, '<inline-lex-shadow>');
  assert.ok(
    offenders.length > 0,
    `the scanner MUST report offenders for the CR round-4 lexical-shadow mutation. Got 0.`,
  );
  const callOffenders = offenders.filter((o) => o.kind === 'CallExpression');
  assert.ok(
    callOffenders.some((o) => /^openrouter\.ai$/i.test(o.value)),
    `a CallExpression fold through the outer-scope hostPrefix must produce \`openrouter.ai\`. Offenders:\n${JSON.stringify(offenders, null, 2)}`,
  );
  assert.ok(
    callOffenders.some((o) => /^OPENROUTER_API_KEY$/.test(o.value)),
    `a CallExpression fold through the outer-scope keyPrefix must produce \`OPENROUTER_API_KEY\`. Offenders:\n${JSON.stringify(offenders, null, 2)}`,
  );
  assert.ok(
    callOffenders.some((o) => /^@openrouter\/sdk$/i.test(o.value)),
    `a CallExpression fold through the outer-scope modulePrefix must produce \`@openrouter/sdk\`. Offenders:\n${JSON.stringify(offenders, null, 2)}`,
  );
  assert.ok(
    offenders.some((o) => o.kind === 'BinaryExpression' && /^https:\/\/openrouter\.ai\/api\/v1\/chat\/completions$/i.test(o.value)),
    `the final composed URL must fold to \`https://openrouter.ai/api/v1/chat/completions\`. Offenders:\n${JSON.stringify(offenders, null, 2)}`,
  );
});

check('scanForOpenRouter — inner-scope binding stays inside its block (Google prefix in dead block must NOT leak out)', async () => {
  const { scanForOpenRouter } = await loadScanner();
  // Sanity: the inner scope's `googlerouter.ai` folding should be
  // reported as an offender INSIDE the block (any string containing
  // `openrouter` … wait, `googlerouter.ai` also contains `router` but
  // not `openrouter`). Actually more useful: the outer scope must not
  // see the inner `google` binding. Here we verify no offender's value
  // starts with `googlerouter` — the outer fold must NOT accidentally
  // pick up the inner shadow value.
  const src = `
    const prefix = "open";
    {
      const prefix = "google";
      const inner = [prefix, "router-inner"].join("");  // "googlerouter-inner"
    }
    const outer = [prefix, "router-outer"].join("");    // MUST fold with "open" not "google"
  `;
  const offenders = scanForOpenRouter(src, '<inline-scope-isolation>');
  const outerOffenders = offenders.filter((o) => /router-outer$/.test(o.value));
  assert.ok(
    outerOffenders.some((o) => /^openrouter-outer$/.test(o.value)),
    `the outer fold must resolve \`prefix\` to \`"open"\`, yielding \`openrouter-outer\`. Offenders:\n${JSON.stringify(offenders, null, 2)}`,
  );
  assert.ok(
    !outerOffenders.some((o) => /^googlerouter-outer$/.test(o.value)),
    `the outer fold must NOT see the inner shadow value \`"google"\` (that would mean bindings escape their block). Offenders:\n${JSON.stringify(offenders, null, 2)}`,
  );
});

check('scanForOpenRouter catches classic contiguous forms as well', async () => {
  const { scanForOpenRouter } = await loadScanner();
  const contiguous = `
    const host = 'https://openrouter.ai/api/v1/chat/completions';
    const k = 'OPENROUTER_API_KEY';
    import openrouterSdk from '@openrouter/sdk';
    const openrouterClient = null;
    process.env.OPENROUTER_API_KEY;
  `;
  const offenders = scanForOpenRouter(contiguous, '<inline-contiguous>');
  assert.ok(offenders.length >= 3, `expected multiple offenders. Got ${offenders.length}: ${JSON.stringify(offenders)}`);
});

check('scanForOpenRouter is quiet on clean code that only mentions the denylist in comments', async () => {
  const { scanForOpenRouter } = await loadScanner();
  const cleanFile = `
    /**
     * OpenRouter is a hard denylist here (DIC-1185). We only reach Google direct.
     */
    // openrouter.ai must not appear in executable code.
    const host = 'https://generativelanguage.googleapis.com';
    const key = process.env.GEMINI_API_KEY;
    void fetch(host, { headers: { Authorization: key } });
  `;
  const offenders = scanForOpenRouter(cleanFile, '<inline-clean>');
  assert.deepEqual(offenders, [], `clean code must yield zero offenders. Got: ${JSON.stringify(offenders)}`);
});

check('api/ scan is empty on the checked-in code', async () => {
  const { scanApiDirectory } = await loadScanner();
  const offenders = scanApiDirectory(path.join(ROOT, 'api'));
  assert.deepEqual(
    offenders,
    [],
    `api/ must contain zero executable OpenRouter references. Offenders:\n${JSON.stringify(offenders, null, 2)}`,
  );
});

// ---------- run ----------------------------------------------------------------

let failed = 0;
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
process.stdout.write(`\n${checks.length - failed}/${checks.length} checks passed\n`);
if (failed) process.exit(1);
