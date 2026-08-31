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
  const { code: stripped } = stripGroovyComments(out);
  const strippedAbiCount = (stripped.match(/\babiFilters\s+["']arm64-v8a["']/g) ?? []).length;
  assert.equal(
    strippedAbiCount,
    1,
    `after transform, the stripped Gradle must contain exactly one executable arm64-v8a abiFilters call. Found ${strippedAbiCount}.`,
  );
  // Also idempotent under repeat: running transformGradle a second time
  // sees the abiFilters call in the real block and skips.
  const out2 = transformGradle(out);
  assert.equal(out, out2, 'transformGradle idempotency holds when a comment-hidden fake block precedes the real one');
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
