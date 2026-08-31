#!/usr/bin/env node
/**
 * DIC-1266 release-APK size + content guards.
 *
 * Written against the actual failure mode from DIC-1265 QA: the exact
 * production-content APK verified fine but was 151 MB, which the Multica
 * attachment upload path rejected (Telegram media delivery is capped by
 * Bot API at 50 MB). This test enforces the invariants that keep the
 * `production-apk` sideload deliverable AND keep it the same app as the
 * store bundle:
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
 *   3. ABI / device compatibility gate — the `withReleaseApkSizeOptim`
 *      plugin exists at `plugins/withReleaseApkSizeOptim.js`, is registered
 *      in `app.base.json` plugins, restricts native libs to `arm64-v8a`,
 *      compresses jniLibs, and only fires when
 *      `EAS_BUILD_PROFILE ∈ {production, production-apk}` (or the explicit
 *      override) — so preview/development builds and local prebuild are
 *      unaffected. Idempotent: re-running the transform yields the same
 *      contents.
 *
 *   4. hEB01 214 with nameZh 214/214 and skillsZh 214/214 in
 *      `data/database.json`. This is the sourceProduct coverage that
 *      DIC-1265 QA verified inside the bundled APK; the size reduction
 *      must not silently drop cards or translations, so the guard asserts
 *      the source of truth here.
 *
 *   5. No executable OpenRouter code path in `api/`. `api/recognize-card.ts`
 *      documents the DIC-1185 denylist; a future edit that opens an
 *      `openrouter.ai` fetch would defeat the whole reason we are shipping
 *      a smaller APK — one delivery incident does not entitle a provider
 *      restoration. Only prose that names OpenRouter as denied is allowed
 *      (checked by grepping for actual URLs/fetches, not word mentions).
 *
 * Each check exits non-zero on failure with an explanation the release
 * agents can act on directly; a green run is one line per check plus a
 * final summary.
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
  // Neither Expo nor the RN template exposes a boolean toggle for
  // `android:debuggable` in app.json, but a `manifestPlaceholders.debuggable`
  // or an explicit `androidManifest` mutation could reintroduce it. Guard the
  // known escape hatches so a future edit fails loudly here rather than
  // shipping a debug APK past DIC-1265 signer verification.
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
    `${pluginRelPath}.js is required — it restricts the sideload APK's native libs to arm64-v8a and compresses jniLibs so the artifact fits under the Multica attachment cap`,
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

check('plugin only fires for production / production-apk profiles', () => {
  const plugin = require_(path.join(ROOT, 'plugins', 'withReleaseApkSizeOptim.js'));
  const { shouldApply } = plugin.__internal;
  const saved = { profile: process.env.EAS_BUILD_PROFILE, override: process.env.HUNTER_APK_SIZE_OPTIM };
  try {
    delete process.env.EAS_BUILD_PROFILE;
    delete process.env.HUNTER_APK_SIZE_OPTIM;
    assert.equal(shouldApply(), false, 'no env set → plugin must NOT modify build.gradle (keeps local prebuild + CI emulator working)');
    process.env.EAS_BUILD_PROFILE = 'development';
    assert.equal(shouldApply(), false, 'development profile → plugin must NOT restrict ABIs');
    process.env.EAS_BUILD_PROFILE = 'preview';
    assert.equal(shouldApply(), false, 'preview profile → plugin must NOT restrict ABIs');
    process.env.EAS_BUILD_PROFILE = 'production';
    assert.equal(shouldApply(), true, 'production profile (AAB) → plugin MUST restrict ABIs, or the AAB drifts from the APK on ABI');
    process.env.EAS_BUILD_PROFILE = 'production-apk';
    assert.equal(shouldApply(), true, 'production-apk profile (sideload) → plugin MUST restrict ABIs, that is the whole point');
    delete process.env.EAS_BUILD_PROFILE;
    process.env.HUNTER_APK_SIZE_OPTIM = '1';
    assert.equal(shouldApply(), true, 'explicit HUNTER_APK_SIZE_OPTIM=1 override → plugin fires (used by this test)');
  } finally {
    if (saved.profile == null) delete process.env.EAS_BUILD_PROFILE;
    else process.env.EAS_BUILD_PROFILE = saved.profile;
    if (saved.override == null) delete process.env.HUNTER_APK_SIZE_OPTIM;
    else process.env.HUNTER_APK_SIZE_OPTIM = saved.override;
  }
});

check('plugin transform inserts arm64-v8a-only abiFilters + useLegacyPackaging jniLibs', () => {
  const plugin = require_(path.join(ROOT, 'plugins', 'withReleaseApkSizeOptim.js'));
  const { transformGradle, ABI_TAG, JNI_TAG, REQUIRED_ABI } = plugin.__internal;
  // Faithful shape of the RN 0.81 android/app/build.gradle skeleton used by
  // Expo prebuild. Kept small on purpose — we assert the plugin's
  // modifications, not the template.
  const skeleton = `
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
}
`;
  const out1 = transformGradle(skeleton);
  assert.ok(out1.includes(ABI_TAG), 'transformed gradle must carry the ABI tag');
  assert.ok(out1.includes(JNI_TAG), 'transformed gradle must carry the jniLibs tag');
  assert.match(out1, /ndk\s*\{[^}]*abiFilters\s+"arm64-v8a"/m, 'ndk.abiFilters "arm64-v8a" must be inserted inside defaultConfig');
  assert.match(out1, /packagingOptions\s*\{\s*\n\s*jniLibs\s*\{[^}]*useLegacyPackaging\s*=\s*true/m, 'packagingOptions.jniLibs.useLegacyPackaging = true must be inserted inside the top-level android block');
  assert.equal(REQUIRED_ABI, 'arm64-v8a', 'the required ABI must remain arm64-v8a — that is the QA-verified target');
  // Idempotency: running the transform again on the already-modified file
  // must be a no-op. Expo re-runs config plugins on every prebuild.
  const out2 = transformGradle(out1);
  assert.equal(out1, out2, 'transformGradle must be idempotent — Expo prebuild re-runs plugins and re-inserting would duplicate the ABI block and fail gradle');
});

check('plugin refuses unknown gradle layouts instead of silently doing nothing', () => {
  const plugin = require_(path.join(ROOT, 'plugins', 'withReleaseApkSizeOptim.js'));
  const { insertIntoDefaultConfig, insertPackagingOptions } = plugin.__internal;
  assert.throws(
    () => insertIntoDefaultConfig('android { }'),
    /could not locate `defaultConfig \{`/,
    'the plugin MUST throw when defaultConfig cannot be found — a silent no-op ships the 151 MB APK',
  );
  assert.throws(
    () => insertPackagingOptions('apply plugin: "x"'),
    /could not locate `android \{`/,
    'the plugin MUST throw when the android block cannot be found — a silent no-op ships the 151 MB APK',
  );
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

// ---------- 5. No executable OpenRouter code path -----------------------------

check('api/ has no executable OpenRouter fetch (DIC-1185 hard denylist)', () => {
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
  const stripSingleLineComments = (src) =>
    src
      // Block comments — greedy across lines
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // Line comments (best-effort: does not respect strings, but sufficient
      // for detecting a fetch URL that is actually reachable from code)
      .split('\n')
      .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
      .join('\n');
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    const code = stripSingleLineComments(raw);
    // Any reference to openrouter.ai OR the OPENROUTER_API_KEY env var outside
    // a comment counts — the FinOps denylist covers both the host and the key.
    // Named-import ONLY of the openrouter provider constant is also treated as
    // an executable reference; the ban is total.
    const hostMatch = code.match(/["'`]https?:\/\/[^"'`]*openrouter\.ai[^"'`]*["'`]/i);
    const envMatch = code.match(/OPENROUTER_API_KEY/);
    const importMatch = code.match(/from\s+["'`]openrouter/i) || code.match(/require\s*\(\s*["'`]openrouter/i);
    if (hostMatch) OFFENDING.push(`${path.relative(ROOT, file)}: openrouter host in code — ${hostMatch[0]}`);
    if (envMatch) OFFENDING.push(`${path.relative(ROOT, file)}: OPENROUTER_API_KEY read in code`);
    if (importMatch) OFFENDING.push(`${path.relative(ROOT, file)}: openrouter package imported`);
  }
  assert.deepEqual(
    OFFENDING,
    [],
    `api/ must not contain any executable OpenRouter path. Offenders:\n${OFFENDING.join('\n')}\n\n` +
      'OpenRouter is a permanent FinOps denylist (DIC-1185). A build that opens a connection to ' +
      'openrouter.ai defeats the whole reason the APK exists.',
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
