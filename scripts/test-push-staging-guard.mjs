#!/usr/bin/env node
/**
 * DIC-1189 tests for api/_lib/push-staging-guard.ts (rework-blocker #3c).
 *
 * Invariants:
 * - Production: filterPushRecipients returns the input unchanged;
 *   pushEnvironmentTag returns undefined so the wire payload is
 *   byte-identical to pre-DIC-1189.
 * - Staging without EXPO_STAGING_TEST_TOKENS: filterPushRecipients returns
 *   [] (fail-closed default — synthetic-only). No production Expo token
 *   can be reached.
 * - Staging with EXPO_STAGING_TEST_TOKENS: only tokens on the allow-list
 *   pass through. pushEnvironmentTag returns 'staging'.
 * - Missing APP_ENV: both functions throw (unattributed environment).
 *
 * Run: APP_ENV=production node --experimental-strip-types \
 *   --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *   --import ./scripts/register-ts.mjs scripts/test-push-staging-guard.mjs
 */

if (!process.env.APP_ENV) process.env.APP_ENV = 'production';

import assert from 'node:assert/strict';
import { AppEnvUnresolved } from '../src/config/appEnv.ts';
import { filterPushRecipients, pushEnvironmentTag } from '../api/_lib/push-staging-guard.ts';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function withEnv(overrides, fn) {
  const before = { ...process.env };
  try {
    for (const k of ['APP_ENV', 'EXPO_PUBLIC_APP_ENV', 'EXPO_STAGING_TEST_TOKENS']) delete process.env[k];
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

const recipients = [
  { token: 'ExponentPushToken[realUser1]' },
  { token: 'ExponentPushToken[realUser2]' },
  { token: 'ExponentPushToken[synthetic-A]' },
];

// ── production ─────────────────────────────────────────────────────────────
test('production: filterPushRecipients returns input unchanged', () => {
  withEnv({ APP_ENV: 'production' }, () =>
    assert.deepEqual(filterPushRecipients(recipients), recipients),
  );
});

test('production: pushEnvironmentTag is undefined (byte-identical wire)', () => {
  withEnv({ APP_ENV: 'production' }, () =>
    assert.equal(pushEnvironmentTag(), undefined),
  );
});

// ── staging fail-closed default ────────────────────────────────────────────
test('staging + no allow-list: filterPushRecipients returns [] (synthetic-only, fail-closed)', () => {
  withEnv({ APP_ENV: 'staging' }, () =>
    assert.deepEqual(filterPushRecipients(recipients), []),
  );
});

test('staging + empty allow-list ("  ,  ,  "): still returns [] (whitespace stripped)', () => {
  withEnv({ APP_ENV: 'staging', EXPO_STAGING_TEST_TOKENS: '  ,  ,  ' }, () =>
    assert.deepEqual(filterPushRecipients(recipients), []),
  );
});

// ── staging with allow-list ────────────────────────────────────────────────
test('staging + allow-list: only listed tokens pass', () => {
  withEnv({ APP_ENV: 'staging', EXPO_STAGING_TEST_TOKENS: 'ExponentPushToken[synthetic-A]' }, () =>
    assert.deepEqual(filterPushRecipients(recipients), [{ token: 'ExponentPushToken[synthetic-A]' }]),
  );
});

test('staging + allow-list with whitespace: trimmed correctly', () => {
  withEnv(
    {
      APP_ENV: 'staging',
      EXPO_STAGING_TEST_TOKENS: '  ExponentPushToken[synthetic-A] , ExponentPushToken[realUser1] ',
    },
    () =>
      assert.deepEqual(filterPushRecipients(recipients), [
        { token: 'ExponentPushToken[realUser1]' },
        { token: 'ExponentPushToken[synthetic-A]' },
      ]),
  );
});

test('staging: pushEnvironmentTag returns "staging"', () => {
  withEnv({ APP_ENV: 'staging' }, () => assert.equal(pushEnvironmentTag(), 'staging'));
});

// ── unattributed environment ───────────────────────────────────────────────
test('missing APP_ENV: filterPushRecipients throws', () => {
  withEnv({}, () =>
    assert.throws(() => filterPushRecipients(recipients), (err) => err instanceof AppEnvUnresolved),
  );
});

test('missing APP_ENV: pushEnvironmentTag throws', () => {
  withEnv({}, () =>
    assert.throws(() => pushEnvironmentTag(), (err) => err instanceof AppEnvUnresolved),
  );
});

console.log(`\npush-staging-guard: ${passed} tests passed`);
