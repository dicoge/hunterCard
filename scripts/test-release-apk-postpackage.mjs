#!/usr/bin/env node
/**
 * DIC-1266 post-package release-APK artifact guard.
 *
 * DIC-1277 QA reproduced a real `production-apk` prebuild +
 * `./gradlew app:assembleRelease` at head 8a69af08 and found the packaged
 * APK contained all four native ABI directories (arm64-v8a, armeabi-v7a,
 * x86, x86_64) even though the generated Gradle text carried
 * `abiFilters "arm64-v8a"`. Root cause: `@react-native/gradle-plugin`
 * `NdkConfiguratorUtils.kt` calls
 *
 *   ext.defaultConfig.ndk.abiFilters.addAll(
 *     project.getReactNativeArchitectures())
 *
 * which UNIONS the property list into whatever we set. The check that
 * the gradle text contains the arm64 filter is therefore necessary but
 * insufficient — only the packaged APK proves the final ABI set.
 *
 * This script:
 *   1. Takes an APK path (defaults to
 *      `android/app/build/outputs/apk/release/app-release.apk`).
 *   2. Inspects its `lib/<abi>/` directories via `unzip -Z1`.
 *   3. Enforces:
 *        - exactly one lib directory, `lib/arm64-v8a/`;
 *        - no `armeabi-v7a` / `x86` / `x86_64` / `armeabi` / `mips*` dirs;
 *        - total on-disk size below the Multica/Telegram cap (default
 *          50 * 1024 * 1024 bytes = 52,428,800; override via
 *          `HUNTER_APK_SIZE_LIMIT_BYTES`);
 *        - `com.dicoge.holohunter` package identity via `aapt` when
 *          available, else via a magic-header/manifest string scan.
 *
 * It ALSO tolerates optional inputs and prints machine-readable JSON
 * on success — the CI job downstream (see .github/workflows/ci.yml
 * `release-apk-postpackage-guard`) writes a build-provenance record.
 *
 * Failing this suite must be the ONLY release gate that trusts what
 * actually landed inside the APK. Generated Gradle text can lie; the
 * packaged bytes cannot.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_APK = path.join(ROOT, 'android/app/build/outputs/apk/release/app-release.apk');
const DEFAULT_SIZE_LIMIT_BYTES = 50 * 1024 * 1024; // 52,428,800 — Telegram Bot API cap.

const apkPath = process.env.HUNTER_APK_PATH || process.argv[2] || DEFAULT_APK;
const sizeLimit = Number(process.env.HUNTER_APK_SIZE_LIMIT_BYTES ?? DEFAULT_SIZE_LIMIT_BYTES);

function fail(msg) {
  process.stderr.write(`FAIL ${msg}\n`);
  process.exit(1);
}

function which(bin) {
  const r = spawnSync('/usr/bin/env', ['which', bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

// The GitHub Actions `android-actions/setup-android` action installs the
// SDK but does NOT put `build-tools/<version>/aapt` on PATH; searching
// `$ANDROID_HOME/build-tools/*/aapt` covers that case AND matches the
// EAS build image layout.
function findAapt() {
  const onPath = which('aapt2') || which('aapt');
  if (onPath) return onPath;
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.HOME ? `${process.env.HOME}/Library/Android/sdk` : null,
  ].filter(Boolean);
  for (const root of roots) {
    const buildTools = path.join(root, 'build-tools');
    if (!fs.existsSync(buildTools)) continue;
    const versions = fs
      .readdirSync(buildTools)
      .filter((d) => /^\d/.test(d))
      .sort()
      .reverse(); // newest first
    for (const v of versions) {
      for (const bin of ['aapt2', 'aapt']) {
        const p = path.join(buildTools, v, bin);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

// DIC-1269 CR round 6 blocker 2 removed the byte-scan and manifest-
// stringpool fallbacks — package identity now requires aapt/aapt2 as
// an authoritative source. The classes*.dex string pool can carry the
// applicationId string even when AndroidManifest.xml declares a
// different package, so any byte-scan is fail-open by construction.

if (!fs.existsSync(apkPath)) {
  fail(`APK not found at ${apkPath}. Run \`expo prebuild --platform android --clean\` and \`./gradlew app:assembleRelease\` first, or pass the path as argv[1] / HUNTER_APK_PATH.`);
}

const stat = fs.statSync(apkPath);
if (!stat.isFile() || stat.size === 0) {
  fail(`APK at ${apkPath} is not a file or is empty (size=${stat.size}).`);
}

// --------- 1. Total byte size ---------------------------------------------

// Strict `< limit` — an APK exactly AT the limit still fails. DIC-1269 CR
// round 6 blocker 1 flagged the `>` boundary as fail-open: an artifact
// exactly at the Telegram cap would exit 0 even though the contract
// requires strictly below.
if (stat.size >= sizeLimit) {
  fail(
    `APK size ${stat.size} bytes (${(stat.size / (1024 * 1024)).toFixed(2)} MiB) meets or exceeds the ` +
      `Multica/Telegram attachment cap of ${sizeLimit} bytes (${(sizeLimit / (1024 * 1024)).toFixed(2)} MiB) — ` +
      `contract is strict < limit, not <=. Set HUNTER_APK_SIZE_LIMIT_BYTES to override for a test.`,
  );
}

// --------- 2. Packaged ABI set --------------------------------------------

const unzip = which('unzip');
if (!unzip) fail('the `unzip` binary is required to inspect APK ABI contents but was not found on PATH.');

const listing = spawnSync('unzip', ['-Z1', apkPath], { encoding: 'utf8' });
if (listing.status !== 0) {
  fail(`\`unzip -Z1 ${apkPath}\` failed: ${listing.stderr || 'no stderr'}`);
}

const libEntries = listing.stdout
  .split('\n')
  .filter((line) => /^lib\/[^/]+\//.test(line));
const abiDirs = new Set(libEntries.map((line) => line.split('/')[1]));
const REQUIRED_ABIS = new Set(['arm64-v8a']);
const FORBIDDEN_ABIS = new Set(['armeabi', 'armeabi-v7a', 'x86', 'x86_64', 'mips', 'mips64']);

const forbiddenPresent = [...abiDirs].filter((abi) => FORBIDDEN_ABIS.has(abi));
if (forbiddenPresent.length > 0) {
  fail(
    `APK packages forbidden ABI directories: ${forbiddenPresent.join(', ')}. ` +
      `The production-apk sideload artifact must ship arm64-v8a ONLY. ` +
      `The RN gradle plugin's NdkConfiguratorUtils.kt \`abiFilters.addAll(reactNativeArchitectures)\` ` +
      `unions the gradle.properties list onto the DSL filter — set ` +
      `reactNativeArchitectures=arm64-v8a in android/gradle.properties or the plugin bypasses ` +
      `every DSL-level filter.`,
  );
}

const missingRequired = [...REQUIRED_ABIS].filter((abi) => !abiDirs.has(abi));
if (missingRequired.length > 0) {
  fail(
    `APK is missing required ABI directories: ${missingRequired.join(', ')}. ` +
      `An APK without arm64-v8a cannot install on any modern Android device the QA target uses.`,
  );
}

if (abiDirs.size !== 1 || !abiDirs.has('arm64-v8a')) {
  fail(
    `APK must contain exactly one lib/<abi>/ directory (arm64-v8a). Found: ${[...abiDirs].join(', ') || '(none)'}`,
  );
}

// --------- 3. Package identity (authoritative manifest parsing) ----------

// DIC-1269 CR round 6 blocker 2: the previous byte-scan fallback searched
// the WHOLE APK (including compressed classes.dex) for the package name
// string. An attacker (or drift) could ship an AndroidManifest.xml
// declaring a wrong package and still pass the guard because the string
// `com.dicoge.holohunter` happens to appear inside a dex string pool.
// Fix: require an authoritative manifest source — `aapt dump badging`
// or `aapt2 dump badging` — whose output MUST include a
// `package: name='<applicationId>'` line. If aapt is unavailable, or
// its output cannot be parsed, we fail CLOSED. No byte-scan fallback.
const aapt = findAapt();
if (!aapt) {
  fail(
    'aapt / aapt2 is required to authoritatively read the APK manifest and was not found on PATH ' +
      'nor under $ANDROID_HOME/build-tools/ / $ANDROID_SDK_ROOT/build-tools/. ' +
      'Install Android SDK build-tools (setup-android GitHub Action or Android Studio locally). ' +
      'The guard refuses to fall back to a full-APK byte scan because dex string pools can carry ' +
      'the applicationId string even when AndroidManifest.xml declares a DIFFERENT package.',
  );
}
const badge = spawnSync(aapt, ['dump', 'badging', apkPath], { encoding: 'utf8' });
if (badge.status !== 0) {
  fail(
    `${path.basename(aapt)} dump badging exited ${badge.status} — cannot authoritatively parse APK manifest.\n` +
      `stderr: ${badge.stderr || '(empty)'}\n` +
      `Refusing to fall back to byte-scan; fix the input APK or install a working build-tools version.`,
  );
}
const aaptBadging = badge.stdout;
const packageMatch = aaptBadging.match(/^package:\s+name='([^']+)'/m);
if (!packageMatch) {
  fail(
    `${path.basename(aapt)} dump badging did not report a \`package: name='...'\` line. ` +
      `Refusing to accept an APK whose manifest cannot be parsed authoritatively.\n` +
      `First 400 bytes of badging output: ${aaptBadging.slice(0, 400)}`,
  );
}
const packageName = packageMatch[1];
if (packageName !== 'com.dicoge.holohunter') {
  fail(
    `AndroidManifest.xml declares package name '${packageName}', not 'com.dicoge.holohunter'. ` +
      `Refusing to deliver an artifact whose applicationId drifted from the DIC-1265 QA baseline.`,
  );
}

// --------- 4. Non-debuggable check via aapt -------------------------------

// Now that aapt is a hard requirement, this check is authoritative too.
if (/application-debuggable/.test(aaptBadging)) {
  fail(
    'APK is marked application-debuggable. The production-apk release artifact must not ship a debug manifest.',
  );
}

// --------- 5. Report ------------------------------------------------------

const output = {
  apkPath,
  sizeBytes: stat.size,
  sizeMiB: Number((stat.size / (1024 * 1024)).toFixed(2)),
  sizeLimitBytes: sizeLimit,
  sizeLimitMiB: Number((sizeLimit / (1024 * 1024)).toFixed(2)),
  packagedAbis: [...abiDirs],
  packageName,
  packageSource: `${path.basename(aapt)} dump badging`,
  requiredAbis: [...REQUIRED_ABIS],
  forbiddenAbis: [...FORBIDDEN_ABIS],
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
process.stdout.write(
  `ok  release-apk-postpackage: ${output.sizeMiB} MiB, ABIs=[${output.packagedAbis.join(',')}], package=${output.packageName}\n`,
);
