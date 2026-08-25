#!/usr/bin/env node
/**
 * DIC-1189 tests for src/config/appEnv.ts.
 *
 * Fail-closed rule: any APP_ENV / EXPO_PUBLIC_APP_ENV value that isn't
 * literally the trimmed lowercase string "staging" resolves to production.
 * SITE_URL falls back to the canonical host of the resolved env. STAGING_SHA
 * comes from EXPO_PUBLIC_STAGING_SHA or VERCEL_GIT_COMMIT_SHA and is trimmed
 * to 12 chars.
 *
 * Run: node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *   --import ./scripts/register-ts.mjs scripts/test-app-env.mjs
 */

import assert from 'node:assert/strict';
import {
  resolveAppEnv,
  resolveAppEnvStrict,
  resolveSiteUrl,
  resolveStagingSha,
  AppEnvUnresolved,
  isServerRuntime,
} from '../src/config/appEnv.ts';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function withEnv(overrides, fn) {
  const before = { ...process.env };
  try {
    // Wipe every APP_ENV-adjacent var so the test is not contaminated by the
    // host shell. Fail-closed rule means missing == production, so the empty
    // env is a valid starting point.
    for (const key of ['APP_ENV', 'EXPO_PUBLIC_APP_ENV', 'EXPO_PUBLIC_SITE_URL', 'SITE_URL', 'EXPO_PUBLIC_STAGING_SHA', 'VERCEL_GIT_COMMIT_SHA']) {
      delete process.env[key];
    }
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    // Restore the exact env we started with — do not leak between tests.
    for (const key of Object.keys(process.env)) delete process.env[key];
    for (const [k, v] of Object.entries(before)) process.env[k] = v;
  }
}

// ── resolveAppEnv ──────────────────────────────────────────────────────────
test('resolveAppEnv: empty env → production (fail-closed)', () => {
  withEnv({}, () => assert.equal(resolveAppEnv(), 'production'));
});

test('resolveAppEnv: APP_ENV=staging → staging', () => {
  withEnv({ APP_ENV: 'staging' }, () => assert.equal(resolveAppEnv(), 'staging'));
});

test('resolveAppEnv on SERVER runtime: EXPO_PUBLIC_APP_ENV=staging ALONE → production (rework 3rd pass — server ignores client-only env)', () => {
  // Third rework pass — blocker #2a: on a server runtime,
  // EXPO_PUBLIC_APP_ENV alone must NOT authorize staging (or production).
  // The lenient resolver falls back to production; the strict resolver
  // throws (separate test below). Only server APP_ENV counts on server.
  withEnv({ EXPO_PUBLIC_APP_ENV: 'staging' }, () =>
    assert.equal(resolveAppEnv(), 'production'),
  );
});

test('resolveAppEnv: server APP_ENV wins over client EXPO_PUBLIC_APP_ENV', () => {
  withEnv({ APP_ENV: 'production', EXPO_PUBLIC_APP_ENV: 'staging' }, () =>
    assert.equal(resolveAppEnv(), 'production'),
  );
});

test('resolveAppEnv: trims + lowercases', () => {
  withEnv({ APP_ENV: '  STAGING  ' }, () => assert.equal(resolveAppEnv(), 'staging'));
});

test('resolveAppEnv: unknown / mistyped → production (fail-closed)', () => {
  for (const bad of ['stage', 'stg', 'production', 'prod', 'dev', 'development', 'yes', '1', ' ', 'test', 'stagng']) {
    withEnv({ APP_ENV: bad }, () =>
      assert.equal(resolveAppEnv(), 'production', `APP_ENV=${JSON.stringify(bad)} should fail-closed to production`),
    );
  }
});

// ── resolveSiteUrl ─────────────────────────────────────────────────────────
test('resolveSiteUrl: prod default is holohunter.dicoge.com', () => {
  withEnv({}, () => assert.equal(resolveSiteUrl(), 'https://holohunter.dicoge.com'));
});

test('resolveSiteUrl: staging default is test.holohunter.dicoge.com', () => {
  withEnv({ APP_ENV: 'staging' }, () =>
    assert.equal(resolveSiteUrl(), 'https://test.holohunter.dicoge.com'),
  );
});

test('resolveSiteUrl: EXPO_PUBLIC_SITE_URL overrides (trims trailing slash)', () => {
  withEnv({ APP_ENV: 'staging', EXPO_PUBLIC_SITE_URL: 'https://x.example.com/' }, () =>
    assert.equal(resolveSiteUrl(), 'https://x.example.com'),
  );
});

test('resolveSiteUrl: SITE_URL server-side fallback works when EXPO_PUBLIC_SITE_URL absent', () => {
  withEnv({ APP_ENV: 'staging', SITE_URL: 'https://s.example.com' }, () =>
    assert.equal(resolveSiteUrl(), 'https://s.example.com'),
  );
});

// ── resolveStagingSha ──────────────────────────────────────────────────────
test('resolveStagingSha: empty env → empty string', () => {
  withEnv({}, () => assert.equal(resolveStagingSha(), ''));
});

test('resolveStagingSha: EXPO_PUBLIC_STAGING_SHA takes precedence over VERCEL_GIT_COMMIT_SHA', () => {
  withEnv(
    { EXPO_PUBLIC_STAGING_SHA: 'abcdef1234567890abc', VERCEL_GIT_COMMIT_SHA: 'zzzz' },
    () => assert.equal(resolveStagingSha(), 'abcdef123456'),
  );
});

test('resolveStagingSha: trims to 12 chars', () => {
  withEnv({ VERCEL_GIT_COMMIT_SHA: '1ba84a9fc93d055845a4f93a2b015e0aa35b0f1d' }, () =>
    assert.equal(resolveStagingSha(), '1ba84a9fc93d'),
  );
});

// ── resolveAppEnvStrict (rework-blocker #2) ────────────────────────────────
test('resolveAppEnvStrict: APP_ENV=production returns production', () => {
  withEnv({ APP_ENV: 'production' }, () => assert.equal(resolveAppEnvStrict(), 'production'));
});

test('resolveAppEnvStrict: APP_ENV=staging returns staging', () => {
  withEnv({ APP_ENV: 'staging' }, () => assert.equal(resolveAppEnvStrict(), 'staging'));
});

test('resolveAppEnvStrict on SERVER: EXPO_PUBLIC_APP_ENV=staging ALONE → throws (client env alone cannot attribute server)', () => {
  // Rework 3rd pass — blocker #2a: on a server runtime, EXPO_PUBLIC_APP_ENV
  // must NOT satisfy the strict resolver. Only APP_ENV counts.
  withEnv({ EXPO_PUBLIC_APP_ENV: 'staging' }, () =>
    assert.throws(
      () => resolveAppEnvStrict(),
      (err) => err instanceof AppEnvUnresolved,
    ),
  );
});

test('resolveAppEnvStrict: empty env throws AppEnvUnresolved', () => {
  withEnv({}, () =>
    assert.throws(
      () => resolveAppEnvStrict(),
      (err) => err instanceof AppEnvUnresolved && err.raw === '',
    ),
  );
});

test('resolveAppEnvStrict: unknown value throws AppEnvUnresolved (carries raw)', () => {
  for (const bad of ['prod', 'stg', 'staging-typo', 'yes', '1', 'test']) {
    withEnv({ APP_ENV: bad }, () =>
      assert.throws(
        () => resolveAppEnvStrict(),
        (err) => err instanceof AppEnvUnresolved && err.raw === bad.trim().toLowerCase(),
      ),
    );
  }
});

test('resolveAppEnvStrict: case-insensitive / trimmed', () => {
  withEnv({ APP_ENV: '  PRODUCTION ' }, () =>
    assert.equal(resolveAppEnvStrict(), 'production'),
  );
});

// ── Server-side APP_ENV requirement (rework 3rd pass — blocker #2a) ────────
// On a server runtime (Node without window/document — where this test runs)
// EXPO_PUBLIC_APP_ENV alone must NOT authorize production keys. Only the
// server-scoped APP_ENV counts.
test('isServerRuntime: true in Node without window/document', () => {
  assert.equal(isServerRuntime(), true);
});

test('server: EXPO_PUBLIC_APP_ENV=production without APP_ENV → strict throws (no server auth via client env)', () => {
  withEnv({ EXPO_PUBLIC_APP_ENV: 'production' }, () =>
    assert.throws(
      () => resolveAppEnvStrict(),
      (err) => err instanceof AppEnvUnresolved,
    ),
  );
});

test('server: EXPO_PUBLIC_APP_ENV=staging without APP_ENV → strict throws (client env alone insufficient)', () => {
  withEnv({ EXPO_PUBLIC_APP_ENV: 'staging' }, () =>
    assert.throws(
      () => resolveAppEnvStrict(),
      (err) => err instanceof AppEnvUnresolved,
    ),
  );
});

test('server: APP_ENV=production authorizes production (regardless of client env)', () => {
  withEnv({ APP_ENV: 'production', EXPO_PUBLIC_APP_ENV: 'staging' }, () =>
    assert.equal(resolveAppEnvStrict(), 'production'),
  );
});

test('server: APP_ENV=staging + no client env → strict returns staging', () => {
  withEnv({ APP_ENV: 'staging' }, () => assert.equal(resolveAppEnvStrict(), 'staging'));
});

test('server: LENIENT resolver also refuses to be authorized by EXPO_PUBLIC_APP_ENV alone on server', () => {
  // The lenient (UI) resolver falls back to production on missing/unknown,
  // but the server-side branch must NOT read EXPO_PUBLIC_APP_ENV even if
  // set to "staging" — otherwise a leaked/mistaken client env would light
  // up staging affordances on production functions. Only production is
  // returned when APP_ENV is unset on a server runtime.
  withEnv({ EXPO_PUBLIC_APP_ENV: 'staging' }, () =>
    assert.equal(resolveAppEnv(), 'production'),
  );
});

console.log(`\nappEnv: ${passed} tests passed`);
