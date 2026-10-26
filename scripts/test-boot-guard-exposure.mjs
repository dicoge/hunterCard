#!/usr/bin/env node
/**
 * DIC-1189 rework 3rd pass — mutation-sensitive test for the boot-guard
 * exposure detection in api/_lib/kv-namespace.ts (blocker #5 + #7).
 *
 * The IIFE at the top of kv-namespace.ts must refuse to import when the
 * environment shows ANY payment-related exposure but has no APP_ENV
 * attribution:
 *   - PAYMENT_ENV_VARS (STRIPE_SECRET_KEY, RC keys, ...)
 *   - PRODUCT_MODE_VARS (STRIPE_MODE, REVENUECAT_ENVIRONMENT)
 *   - WEBHOOK_LIVEMODE_VAR (STRIPE_WEBHOOK_LIVEMODE)
 *
 * We can't test module-load semantics inside a single Node process (the
 * import is cached and the IIFE has already fired), so this test spawns a
 * child Node for each scenario with a curated env and asserts the exit
 * code + stderr signals the expected failure/pass.
 *
 * Run: node scripts/test-boot-guard-exposure.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const IMPORT_SCRIPT = `import('${path.join(ROOT, 'api/_lib/kv-namespace.ts')}').then(() => { console.log('IMPORT_OK'); process.exit(0); }).catch(err => { console.error('IMPORT_FAIL:' + err.name + ':' + (err.message || '')); process.exit(2); });`;

function runImport(env) {
  const res = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      '--import',
      path.join(ROOT, 'scripts/register-ts.mjs'),
      '-e',
      IMPORT_SCRIPT,
    ],
    {
      cwd: ROOT,
      env: { ...process.env, ...env, ...Object.fromEntries(Object.entries(env).filter(([, v]) => v === undefined).map(([k]) => [k, undefined])) },
      encoding: 'utf8',
    },
  );
  return { exit: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function cleanEnv(overrides = {}) {
  const clean = { ...process.env };
  for (const k of [
    'APP_ENV',
    'EXPO_PUBLIC_APP_ENV',
    'STRIPE_SECRET_KEY',
    'STRIPE_MODE',
    'STRIPE_WEBHOOK_LIVEMODE',
    'REVENUECAT_ENVIRONMENT',
    'REVENUECAT_SECRET_KEY',
    'EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY',
  ]) {
    delete clean[k];
  }
  return { ...clean, ...overrides };
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ── Baseline: empty env → boot succeeds (test/dev context, no exposure) ───
test('empty env: import succeeds (no APP_ENV, no payment exposure)', () => {
  const res = runImport(cleanEnv());
  assert.equal(res.exit, 0, `stderr: ${res.stderr}`);
  assert.ok(res.stdout.includes('IMPORT_OK'));
});

test('APP_ENV=production + empty payment env → boot succeeds', () => {
  const res = runImport(cleanEnv({ APP_ENV: 'production' }));
  assert.equal(res.exit, 0, `stderr: ${res.stderr}`);
});

test('APP_ENV=staging + empty payment env → boot succeeds', () => {
  const res = runImport(cleanEnv({ APP_ENV: 'staging' }));
  assert.equal(res.exit, 0, `stderr: ${res.stderr}`);
});

// ── Product-mode sentinel triggers boot fail on unattributed env (#5) ────
test('STRIPE_MODE=test without APP_ENV → boot FAILS (product-mode sentinel is exposure)', () => {
  const res = runImport(cleanEnv({ STRIPE_MODE: 'test' }));
  assert.notEqual(res.exit, 0, 'expected non-zero exit');
  assert.ok(res.stderr.includes('AppEnvUnresolved'), `expected AppEnvUnresolved in stderr; got: ${res.stderr}`);
});

test('STRIPE_MODE=live without APP_ENV → boot FAILS', () => {
  const res = runImport(cleanEnv({ STRIPE_MODE: 'live' }));
  assert.notEqual(res.exit, 0);
  assert.ok(res.stderr.includes('AppEnvUnresolved'));
});

test('REVENUECAT_ENVIRONMENT=sandbox without APP_ENV → boot FAILS', () => {
  const res = runImport(cleanEnv({ REVENUECAT_ENVIRONMENT: 'sandbox' }));
  assert.notEqual(res.exit, 0);
  assert.ok(res.stderr.includes('AppEnvUnresolved'));
});

// ── Webhook livemode sentinel triggers boot fail on unattributed env ─────
test('STRIPE_WEBHOOK_LIVEMODE=true without APP_ENV → boot FAILS', () => {
  const res = runImport(cleanEnv({ STRIPE_WEBHOOK_LIVEMODE: 'true' }));
  assert.notEqual(res.exit, 0);
  assert.ok(res.stderr.includes('AppEnvUnresolved'));
});

test('STRIPE_WEBHOOK_LIVEMODE=false without APP_ENV → boot FAILS', () => {
  const res = runImport(cleanEnv({ STRIPE_WEBHOOK_LIVEMODE: 'false' }));
  assert.notEqual(res.exit, 0);
  assert.ok(res.stderr.includes('AppEnvUnresolved'));
});

// ── Credential still triggers boot fail on unattributed env (existing) ──
test('STRIPE_SECRET_KEY=sk_live_x without APP_ENV → boot FAILS', () => {
  const res = runImport(cleanEnv({ STRIPE_SECRET_KEY: 'sk_live_abcd' }));
  assert.notEqual(res.exit, 0);
  assert.ok(res.stderr.includes('AppEnvUnresolved'));
});

// ── Attributed env + wrong mode → boot fails with PaymentEnvGuardError ──
test('APP_ENV=staging + STRIPE_MODE=live → boot FAILS with PaymentEnvGuardError', () => {
  const res = runImport(cleanEnv({ APP_ENV: 'staging', STRIPE_MODE: 'live' }));
  assert.notEqual(res.exit, 0);
  assert.ok(
    res.stderr.includes('PaymentEnvGuardError'),
    `expected PaymentEnvGuardError; got: ${res.stderr.slice(0, 500)}`,
  );
});

test('APP_ENV=production + STRIPE_WEBHOOK_LIVEMODE=false → boot FAILS', () => {
  const res = runImport(cleanEnv({ APP_ENV: 'production', STRIPE_WEBHOOK_LIVEMODE: 'false' }));
  assert.notEqual(res.exit, 0);
  assert.ok(res.stderr.includes('PaymentEnvGuardError'));
});

// ── EXPO_PUBLIC_APP_ENV alone on server does NOT satisfy attribution ────
test('EXPO_PUBLIC_APP_ENV=production alone + STRIPE_MODE=live → boot FAILS on server (blocker #2a)', () => {
  const res = runImport(cleanEnv({ EXPO_PUBLIC_APP_ENV: 'production', STRIPE_MODE: 'live' }));
  assert.notEqual(res.exit, 0);
  assert.ok(
    res.stderr.includes('AppEnvUnresolved'),
    `expected AppEnvUnresolved (EXPO_PUBLIC_APP_ENV alone must not authorize server); got: ${res.stderr.slice(0, 500)}`,
  );
});

console.log(`\nboot-guard-exposure: ${passed} tests passed`);
