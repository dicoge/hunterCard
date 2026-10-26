#!/usr/bin/env node
/**
 * DIC-1189 tests for api/_lib/env-guard.ts (rework — extended to credential
 * mode, product mode, webhook livemode, and strict environment attribution).
 *
 * Invariants:
 * - Empty env AND APP_ENV set: guard is a no-op (there is no payment
 *   integration to protect until secrets are set).
 * - APP_ENV missing / unknown: assertPaymentEnv() throws AppEnvUnresolved
 *   even with empty payment env — unattributed environment is never OK
 *   (rework-blocker #6).
 * - Staging (APP_ENV=staging): rejects any Stripe / RevenueCat live-prefixed
 *   key, any unknown-prefix key, STRIPE_MODE=live, REVENUECAT_ENVIRONMENT=
 *   production, STRIPE_WEBHOOK_LIVEMODE=true.
 * - Production: rejects test-prefixed keys, STRIPE_MODE=test,
 *   REVENUECAT_ENVIRONMENT=sandbox, STRIPE_WEBHOOK_LIVEMODE=false.
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
import { AppEnvUnresolved } from '../src/config/appEnv.ts';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function withEnv(overrides, fn) {
  const before = { ...process.env };
  try {
    // Wipe every guard-adjacent var. Payment vars start empty by default.
    for (const k of [
      'APP_ENV',
      'EXPO_PUBLIC_APP_ENV',
      'STRIPE_SECRET_KEY',
      'STRIPE_RESTRICTED_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY',
      'REVENUECAT_SECRET_KEY',
      'REVENUECAT_WEBHOOK_AUTH',
      'EXPO_PUBLIC_REVENUECAT_IOS_KEY',
      'EXPO_PUBLIC_REVENUECAT_ANDROID_KEY',
      'STRIPE_MODE',
      'REVENUECAT_ENVIRONMENT',
      'STRIPE_WEBHOOK_LIVEMODE',
    ]) {
      delete process.env[k];
    }
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    for (const [k, v] of Object.entries(before)) process.env[k] = v;
  }
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

test('production: multiple test keys → all reported', () => {
  const issues = findPaymentEnvIssues('production', {
    STRIPE_SECRET_KEY: 'sk_test_a',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_b',
  });
  assert.equal(issues.length, 2);
  assert.ok(issues.every((i) => i.reason === 'test_key_in_production'));
});

// ── product mode (rework-blocker #6) ───────────────────────────────────────
test('staging: STRIPE_MODE=live → mismatch', () => {
  const issues = findPaymentEnvIssues('staging', { STRIPE_MODE: 'live' });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].varName, 'STRIPE_MODE');
  assert.equal(issues[0].reason, 'product_mode_mismatch_in_staging');
});
test('staging: STRIPE_MODE=test → accepted', () => {
  assert.deepEqual(findPaymentEnvIssues('staging', { STRIPE_MODE: 'test' }), []);
});
test('production: STRIPE_MODE=test → mismatch', () => {
  const issues = findPaymentEnvIssues('production', { STRIPE_MODE: 'test' });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].reason, 'product_mode_mismatch_in_production');
});
test('staging: STRIPE_MODE=garbage → unknown', () => {
  const issues = findPaymentEnvIssues('staging', { STRIPE_MODE: 'garbage' });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].reason, 'unknown_product_mode_in_staging');
});
test('staging: REVENUECAT_ENVIRONMENT=production → mismatch', () => {
  const issues = findPaymentEnvIssues('staging', { REVENUECAT_ENVIRONMENT: 'production' });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].reason, 'product_mode_mismatch_in_staging');
});
test('production: REVENUECAT_ENVIRONMENT=production → accepted', () => {
  assert.deepEqual(
    findPaymentEnvIssues('production', { REVENUECAT_ENVIRONMENT: 'production' }),
    [],
  );
});

// ── webhook livemode (rework-blocker #6) ───────────────────────────────────
test('staging: STRIPE_WEBHOOK_LIVEMODE=true → mismatch', () => {
  const issues = findPaymentEnvIssues('staging', { STRIPE_WEBHOOK_LIVEMODE: 'true' });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].varName, 'STRIPE_WEBHOOK_LIVEMODE');
  assert.equal(issues[0].reason, 'webhook_livemode_mismatch_in_staging');
});
test('staging: STRIPE_WEBHOOK_LIVEMODE=false → accepted', () => {
  assert.deepEqual(findPaymentEnvIssues('staging', { STRIPE_WEBHOOK_LIVEMODE: 'false' }), []);
});
test('production: STRIPE_WEBHOOK_LIVEMODE=false → mismatch', () => {
  const issues = findPaymentEnvIssues('production', { STRIPE_WEBHOOK_LIVEMODE: 'false' });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].reason, 'webhook_livemode_mismatch_in_production');
});
test('any: STRIPE_WEBHOOK_LIVEMODE=garbage → unknown', () => {
  const issues = findPaymentEnvIssues('production', { STRIPE_WEBHOOK_LIVEMODE: 'garbage' });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].reason, 'unknown_webhook_livemode');
});

// ── assertPaymentEnv end-to-end (uses resolveAppEnvStrict() via process.env) ──
test('assertPaymentEnv: throws on staging + live key, error message hides value', () => {
  withEnv({ APP_ENV: 'staging' }, () => {
    assert.throws(
      () => assertPaymentEnv({ STRIPE_SECRET_KEY: 'sk_live_supersecret_9876' }),
      (err) => {
        assert.ok(err instanceof PaymentEnvGuardError);
        assert.ok(err.message.includes('STRIPE_SECRET_KEY'));
        assert.ok(err.message.includes('live_key_in_staging'));
        assert.ok(!err.message.includes('supersecret'));
        assert.ok(!err.message.includes('sk_live_'));
        return true;
      },
    );
  });
});

test('assertPaymentEnv: production + test key → throws', () => {
  withEnv({ APP_ENV: 'production' }, () => {
    assert.throws(
      () => assertPaymentEnv({ STRIPE_SECRET_KEY: 'sk_test_abcd' }),
      /test_key_in_production/,
    );
  });
});

test('assertPaymentEnv: empty payment env is a no-op when APP_ENV is set', () => {
  withEnv({ APP_ENV: 'staging' }, () => assert.doesNotThrow(() => assertPaymentEnv({})));
  withEnv({ APP_ENV: 'production' }, () => assert.doesNotThrow(() => assertPaymentEnv({})));
});

test('assertPaymentEnv: missing APP_ENV throws AppEnvUnresolved even with empty payment env', () => {
  withEnv({}, () =>
    assert.throws(
      () => assertPaymentEnv({}),
      (err) => err instanceof AppEnvUnresolved,
    ),
  );
});

test('assertPaymentEnv: production + webhook livemode=false → throws', () => {
  withEnv({ APP_ENV: 'production' }, () =>
    assert.throws(
      () => assertPaymentEnv({ STRIPE_WEBHOOK_LIVEMODE: 'false' }),
      /webhook_livemode_mismatch_in_production/,
    ),
  );
});

console.log(`\npayment-env-guard: ${passed} tests passed`);
