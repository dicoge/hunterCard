#!/usr/bin/env node
/**
 * DIC-1189 tests for api/_lib/env-guard.ts (fail-closed payment env guard).
 *
 * Invariants:
 * - Empty env: guard is a no-op (there is no payment integration to protect).
 * - Staging deployment (APP_ENV=staging): rejects any Stripe / RevenueCat
 *   live-prefixed key AND any unknown prefix.
 * - Production deployment (APP_ENV=production or unset/unknown): rejects any
 *   test-prefixed key AND any unknown prefix.
 * - Error message NEVER contains the offending secret value — only var name
 *   and reason code. Secrets do not leak to logs.
 *
 * Run: node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *   --import ./scripts/register-ts.mjs scripts/test-payment-env-guard.mjs
 */

import assert from 'node:assert/strict';
import {
  findPaymentEnvIssues,
  assertPaymentEnv,
  classifyPaymentSecret,
  PaymentEnvGuardError,
} from '../api/_lib/env-guard.ts';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ── classifier ─────────────────────────────────────────────────────────────
test('classifyPaymentSecret: Stripe prefixes', () => {
  assert.equal(classifyPaymentSecret('stripe', 'sk_live_abc'), 'live');
  assert.equal(classifyPaymentSecret('stripe', 'sk_test_abc'), 'test');
  assert.equal(classifyPaymentSecret('stripe', 'pk_live_abc'), 'live');
  assert.equal(classifyPaymentSecret('stripe', 'pk_test_abc'), 'test');
  assert.equal(classifyPaymentSecret('stripe', 'whsec_live_abc'), 'live');
  assert.equal(classifyPaymentSecret('stripe', 'whsec_test_abc'), 'test');
  assert.equal(classifyPaymentSecret('stripe', 'nonsense_abc'), 'unknown');
});

test('classifyPaymentSecret: RevenueCat prefixes', () => {
  assert.equal(classifyPaymentSecret('revenuecat', 'sk_live_abc'), 'live');
  assert.equal(classifyPaymentSecret('revenuecat', 'sk_test_abc'), 'test');
  assert.equal(classifyPaymentSecret('revenuecat', 'appl_live_key'), 'live');
  assert.equal(classifyPaymentSecret('revenuecat', 'goog_live_key'), 'live');
  assert.equal(classifyPaymentSecret('revenuecat', 'sandbox_key'), 'test');
  assert.equal(classifyPaymentSecret('revenuecat', 'nonsense_abc'), 'unknown');
});

// ── findPaymentEnvIssues in staging ────────────────────────────────────────
test('staging: empty env → no issues', () => {
  assert.deepEqual(findPaymentEnvIssues('staging', {}), []);
});

test('staging: Stripe live key → rejected', () => {
  const issues = findPaymentEnvIssues('staging', { STRIPE_SECRET_KEY: 'sk_live_abcd' });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].varName, 'STRIPE_SECRET_KEY');
  assert.equal(issues[0].reason, 'live_key_in_staging');
});

test('staging: Stripe test key → accepted', () => {
  assert.deepEqual(findPaymentEnvIssues('staging', { STRIPE_SECRET_KEY: 'sk_test_abcd' }), []);
});

test('staging: RevenueCat live SDK key → rejected', () => {
  const issues = findPaymentEnvIssues('staging', { EXPO_PUBLIC_REVENUECAT_IOS_KEY: 'appl_live_xxx' });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].reason, 'live_key_in_staging');
});

test('staging: unknown prefix → rejected as unknown_prefix_in_staging', () => {
  const issues = findPaymentEnvIssues('staging', { STRIPE_SECRET_KEY: 'garbage_abcd' });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].reason, 'unknown_prefix_in_staging');
});

test('staging: publishable test key accepted (client-side)', () => {
  assert.deepEqual(
    findPaymentEnvIssues('staging', { EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_abcd' }),
    [],
  );
});

// ── findPaymentEnvIssues in production ─────────────────────────────────────
test('production: empty env → no issues', () => {
  assert.deepEqual(findPaymentEnvIssues('production', {}), []);
});

test('production: Stripe test key → rejected', () => {
  const issues = findPaymentEnvIssues('production', { STRIPE_SECRET_KEY: 'sk_test_abcd' });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].reason, 'test_key_in_production');
});

test('production: Stripe live key → accepted', () => {
  assert.deepEqual(findPaymentEnvIssues('production', { STRIPE_SECRET_KEY: 'sk_live_abcd' }), []);
});

test('production: RevenueCat sandbox key → rejected', () => {
  const issues = findPaymentEnvIssues('production', { REVENUECAT_SECRET_KEY: 'sk_test_xyz' });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].reason, 'test_key_in_production');
});

test('production: unknown prefix → rejected as unknown_prefix_in_production', () => {
  const issues = findPaymentEnvIssues('production', { STRIPE_SECRET_KEY: 'garbage_abcd' });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].reason, 'unknown_prefix_in_production');
});

// ── multiple issues bundled into one error ─────────────────────────────────
test('production: multiple test keys → all reported', () => {
  const issues = findPaymentEnvIssues('production', {
    STRIPE_SECRET_KEY: 'sk_test_a',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_b',
  });
  assert.equal(issues.length, 2);
  assert.ok(issues.every((i) => i.reason === 'test_key_in_production'));
});

// ── assertPaymentEnv end-to-end (uses resolveAppEnv() via process.env) ─────
test('assertPaymentEnv: throws on staging + live key, error message hides value', () => {
  const before = process.env.APP_ENV;
  process.env.APP_ENV = 'staging';
  try {
    assert.throws(
      () => assertPaymentEnv({ STRIPE_SECRET_KEY: 'sk_live_supersecret_9876' }),
      (err) => {
        assert.ok(err instanceof PaymentEnvGuardError);
        assert.ok(err.message.includes('STRIPE_SECRET_KEY'));
        assert.ok(err.message.includes('live_key_in_staging'));
        // Secret value MUST NOT appear anywhere in the error message.
        assert.ok(!err.message.includes('supersecret'));
        assert.ok(!err.message.includes('sk_live_'));
        return true;
      },
    );
  } finally {
    if (before === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = before;
  }
});

test('assertPaymentEnv: production + test key → throws', () => {
  const before = process.env.APP_ENV;
  process.env.APP_ENV = 'production';
  try {
    assert.throws(
      () => assertPaymentEnv({ STRIPE_SECRET_KEY: 'sk_test_abcd' }),
      /test_key_in_production/,
    );
  } finally {
    if (before === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = before;
  }
});

test('assertPaymentEnv: empty env is a no-op (no payment integration yet)', () => {
  const before = { APP_ENV: process.env.APP_ENV };
  try {
    process.env.APP_ENV = 'staging';
    assert.doesNotThrow(() => assertPaymentEnv({}));
    process.env.APP_ENV = 'production';
    assert.doesNotThrow(() => assertPaymentEnv({}));
    delete process.env.APP_ENV;
    assert.doesNotThrow(() => assertPaymentEnv({}));
  } finally {
    if (before.APP_ENV === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = before.APP_ENV;
  }
});

console.log(`\npayment-env-guard: ${passed} tests passed`);
