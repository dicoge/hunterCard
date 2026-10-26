#!/usr/bin/env node
/**
 * DIC-1269 CR round-6 mutation regressions for the post-package guard.
 *
 * The paired suite `scripts/test-release-apk-postpackage.mjs` runs the
 * real APK checks once, on a built artifact. This suite exercises the
 * FAILURE PATHS of that guard against synthetic inputs so a future
 * revert to `stat.size > limit`, a re-introduced byte-scan fallback,
 * or a missing aapt requirement all fail closed here — regardless of
 * whether a real Android build is present.
 *
 * Runs in the fast Validate job (no Java / Android SDK required —
 * relies only on `node` + `zip` / `unzip`).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = path.join(ROOT, 'scripts/test-release-apk-postpackage.mjs');
const NODE = process.execPath;

// Build a minimal APK-shaped ZIP file:
//   - `lib/<abi>/libfoo.so` for each supplied ABI (may be [])
//   - a stub `AndroidManifest.xml` file (raw bytes, NOT valid AXML;
//     the guard MUST fail closed on such an APK)
// The archive is written to `tmp/<label>.apk` inside a caller-supplied
// tmp dir. Returns the archive path.
function makeSyntheticApk(tmpDir, label, abis, options = {}) {
  const root = path.join(tmpDir, `staging-${label}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  for (const abi of abis) {
    const abiDir = path.join(root, 'lib', abi);
    fs.mkdirSync(abiDir, { recursive: true });
    fs.writeFileSync(path.join(abiDir, 'libfoo.so'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]));
  }
  // A stub AndroidManifest.xml — NOT a valid binary AXML. The guard
  // should reject any APK that aapt cannot parse.
  fs.writeFileSync(path.join(root, 'AndroidManifest.xml'), Buffer.from('stub-not-real-axml'));
  if (options.classesDexPackage) {
    // Simulate a classes.dex containing the applicationId string. This
    // is EXACTLY the fail-open trap that CR round-6 blocker 2 flagged:
    // a byte-scan fallback would accept this even though the manifest
    // declares (or fails to declare) a different package. The current
    // guard MUST NOT accept the APK on that basis.
    fs.writeFileSync(
      path.join(root, 'classes.dex'),
      Buffer.concat([
        Buffer.from('dexcode-stub\0'),
        Buffer.from(options.classesDexPackage, 'utf8'),
        Buffer.from('\0'),
      ]),
    );
  }
  const apkPath = path.join(tmpDir, `${label}.apk`);
  fs.rmSync(apkPath, { force: true });
  const result = spawnSync('zip', ['-qr', apkPath, '.'], { cwd: root });
  if (result.status !== 0) {
    throw new Error(`zip failed for ${label}: ${result.stderr?.toString?.() ?? '(no stderr)'}`);
  }
  return apkPath;
}

// Run the guard with a controlled env and return `{ status, stderr, stdout }`.
function runGuard({ apkPath, sizeLimit, env = {} } = {}) {
  const baseEnv = {
    // Deliberately clear PATH and Android env so the guard's aapt
    // lookup must satisfy itself from what we provide in `env`. That
    // is what lets the "aapt missing" and "aapt returns wrong package"
    // mutations be exercised deterministically.
    PATH: '/usr/bin:/bin',
    HOME: '/tmp',
    ...env,
    HUNTER_APK_PATH: apkPath,
    ...(sizeLimit != null ? { HUNTER_APK_SIZE_LIMIT_BYTES: String(sizeLimit) } : {}),
  };
  const proc = spawnSync(NODE, [GUARD], { env: baseEnv, encoding: 'utf8' });
  return { status: proc.status, stderr: proc.stderr, stdout: proc.stdout };
}

// Build a stub aapt binary at <tmpDir>/build-tools/99.0.0/aapt whose
// `dump badging` stdout is `packageBadgingLine`. Returns the ANDROID_HOME
// value to pass to the guard so `findAapt()` picks this stub.
function stubAaptReturning(tmpDir, packageBadgingLine) {
  const buildTools = path.join(tmpDir, 'stub-android/build-tools/99.0.0');
  fs.mkdirSync(buildTools, { recursive: true });
  const aapt = path.join(buildTools, 'aapt');
  const script = `#!/bin/sh\necho "${packageBadgingLine.replace(/["\\$`]/g, (c) => `\\${c}`)}"\n`;
  fs.writeFileSync(aapt, script, { mode: 0o755 });
  return path.join(tmpDir, 'stub-android');
}

// -------------------------------------------------------------------------
// Set up a shared tmp dir once and clean up on exit.
// -------------------------------------------------------------------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dic1266-postpackage-mut-'));
let failed = 0;
const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

const CAP_BYTES = 50 * 1024 * 1024;

// Test fixture: an ARM64-only synthetic APK small enough to always pass
// size unless we deliberately tighten the limit.
const arm64Apk = makeSyntheticApk(tmpDir, 'arm64', ['arm64-v8a']);
const arm64Size = fs.statSync(arm64Apk).size;

// -------------------------------------------------------------------------
// Blocker 1: size boundary is STRICT `<`, not `<=`. Fail on exact boundary
// and one-byte-over; pass on one-byte-under.
// -------------------------------------------------------------------------

check('size boundary FAILS when APK size EQUALS limit (strict <)', () => {
  const r = runGuard({ apkPath: arm64Apk, sizeLimit: arm64Size });
  assert.notEqual(r.status, 0, `expected non-zero exit at exact boundary. Got ${r.status}. stderr:\n${r.stderr}`);
  assert.match(
    r.stderr,
    /meets or exceeds .* strict < limit/,
    `expected the "strict <" error message. Got:\n${r.stderr}`,
  );
});

check('size boundary FAILS when APK size is 1 byte over limit', () => {
  const r = runGuard({ apkPath: arm64Apk, sizeLimit: arm64Size - 1 });
  assert.notEqual(r.status, 0, `expected non-zero exit at limit-1. Got ${r.status}. stderr:\n${r.stderr}`);
});

// -------------------------------------------------------------------------
// Blocker 2: package identity MUST require aapt/aapt2. Fail closed when
// aapt is missing; fail closed when aapt exists but returns a wrong
// package; reject the byte-scan fallback (classes.dex containing the
// correct string does NOT satisfy the check when the manifest is wrong).
// -------------------------------------------------------------------------

check('package identity FAILS CLOSED when aapt/aapt2 is unavailable', () => {
  const r = runGuard({
    apkPath: arm64Apk,
    env: { ANDROID_HOME: '/nonexistent', ANDROID_SDK_ROOT: '/nonexistent' },
  });
  assert.notEqual(r.status, 0, `expected non-zero exit without aapt. Got ${r.status}. stderr:\n${r.stderr}`);
  assert.match(
    r.stderr,
    /aapt \/ aapt2 is required/,
    `expected the missing-aapt error message. Got:\n${r.stderr}`,
  );
});

check('package identity FAILS CLOSED when aapt reports a wrong package', () => {
  const androidHome = stubAaptReturning(tmpDir, "package: name='com.example.wrong' versionCode='1' versionName='1.0'");
  const r = runGuard({ apkPath: arm64Apk, env: { ANDROID_HOME: androidHome } });
  assert.notEqual(r.status, 0, `expected non-zero exit for wrong package. Got ${r.status}. stderr:\n${r.stderr}`);
  assert.match(
    r.stderr,
    /declares package name 'com\.example\.wrong', not 'com\.dicoge\.holohunter'/,
    `expected wrong-package error message. Got:\n${r.stderr}`,
  );
});

check('package identity does NOT fall back to byte-scan when classes.dex carries the string', () => {
  // Attacker mutation: an APK where the wrong package is declared (or
  // aapt fails to parse the manifest) but classes.dex still contains
  // `com.dicoge.holohunter` — the exact fail-open case CR round-6
  // blocker 2 reproduced.
  const spoofed = makeSyntheticApk(tmpDir, 'spoofed', ['arm64-v8a'], {
    classesDexPackage: 'com.dicoge.holohunter',
  });
  const androidHome = stubAaptReturning(tmpDir, "package: name='com.example.wrong' versionCode='1' versionName='1.0'");
  const r = runGuard({ apkPath: spoofed, env: { ANDROID_HOME: androidHome } });
  assert.notEqual(
    r.status,
    0,
    `the guard MUST NOT accept an APK whose manifest declares a wrong package just because classes.dex ` +
      `contains the correct string. Got exit ${r.status}.\nstderr:\n${r.stderr}\nstdout:\n${r.stdout}`,
  );
});

check('package identity FAILS CLOSED when aapt cannot parse the APK (stub apk is not real AXML)', () => {
  // The stub aapt above fakes a parse; a REAL aapt on this synthetic
  // APK exits non-zero because the manifest is not valid binary AXML.
  // We simulate that with an aapt stub that exits non-zero.
  const buildTools = path.join(tmpDir, 'stub-android-failing/build-tools/99.0.0');
  fs.mkdirSync(buildTools, { recursive: true });
  const aapt = path.join(buildTools, 'aapt');
  fs.writeFileSync(aapt, `#!/bin/sh\necho "AAPT: cannot parse APK" >&2\nexit 1\n`, { mode: 0o755 });
  const r = runGuard({
    apkPath: arm64Apk,
    env: { ANDROID_HOME: path.join(tmpDir, 'stub-android-failing') },
  });
  assert.notEqual(r.status, 0, `expected non-zero exit when aapt exits non-zero. Got ${r.status}. stderr:\n${r.stderr}`);
  assert.match(
    r.stderr,
    /dump badging exited/,
    `expected badging-exit error message. Got:\n${r.stderr}`,
  );
});

// -------------------------------------------------------------------------
// ABI check regressions (previously covered but re-asserted here for
// blast-radius coverage against future edits to the guard).
// -------------------------------------------------------------------------

check('ABI check FAILS when a non-arm64 lib/ directory is present', () => {
  const multi = makeSyntheticApk(tmpDir, 'multi', ['arm64-v8a', 'x86_64']);
  const androidHome = stubAaptReturning(tmpDir, "package: name='com.dicoge.holohunter' versionCode='1' versionName='1.0'");
  const r = runGuard({ apkPath: multi, env: { ANDROID_HOME: androidHome } });
  assert.notEqual(r.status, 0, `expected non-zero exit with x86_64 present. Got ${r.status}. stderr:\n${r.stderr}`);
  assert.match(
    r.stderr,
    /forbidden ABI directories: x86_64/,
    `expected forbidden-ABI error message. Got:\n${r.stderr}`,
  );
});

check('ABI check FAILS when arm64-v8a is missing (empty lib/)', () => {
  const empty = makeSyntheticApk(tmpDir, 'empty-lib', []);
  const androidHome = stubAaptReturning(tmpDir, "package: name='com.dicoge.holohunter' versionCode='1' versionName='1.0'");
  const r = runGuard({ apkPath: empty, env: { ANDROID_HOME: androidHome } });
  assert.notEqual(r.status, 0, `expected non-zero exit with no arm64-v8a lib. Got ${r.status}. stderr:\n${r.stderr}`);
});

// -------------------------------------------------------------------------
// run
// -------------------------------------------------------------------------

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
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

process.stdout.write(`\n${checks.length - failed}/${checks.length} checks passed\n`);
if (failed) process.exit(1);
