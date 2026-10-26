#!/usr/bin/env node
/**
 * DIC-1189 tests for api/_lib/kv-namespace.ts (rework: fail-closed on
 * missing/unknown APP_ENV, no bare-key fallback).
 *
 * Invariants:
 * - APP_ENV=production      → nsKey() is identity (production wire keys
 *                             byte-identical to pre-DIC-1189).
 * - APP_ENV=staging         → nsKey() prepends `staging:` (idempotent —
 *                             double-prefixed keys collapse to one).
 * - anything else (unset,
 *   'prod', 'stg', 'staging-typo', whitespace) → THROWS AppEnvUnresolved.
 * - Empty / non-string keys → throw at the key check.
 * - assertNamespaced()      → no-op in production; throws in staging on a
 *                             key missing the `staging:` prefix; throws
 *                             AppEnvUnresolved on unresolved APP_ENV.
 *
 * NOTE: This test module explicitly sets process.env.APP_ENV=production
 * before importing the module under test, because api/_lib/kv-namespace.ts
 * runs assertPaymentEnv() as an IIFE at module load (rework-blocker #6).
 * Individual tests then use withEnv() to override for the case being
 * exercised.
 *
 * Run: APP_ENV=production node --experimental-strip-types \
 *   --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *   --import ./scripts/register-ts.mjs scripts/test-kv-namespace.mjs
 */

// IMPORTANT: set APP_ENV BEFORE the import so the module-load IIFE sees a
// resolved environment. Individual tests use withEnv() to change it after.
if (!process.env.APP_ENV) process.env.APP_ENV = 'production';

import assert from 'node:assert/strict';
import { AppEnvUnresolved } from '../src/config/appEnv.ts';
import { nsKey, nsKeys, assertNamespaced, STAGING_KV_PREFIX } from '../api/_lib/kv-namespace.ts';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function withEnv(overrides, fn) {
  const before = { ...process.env };
  try {
    for (const key of ['APP_ENV', 'EXPO_PUBLIC_APP_ENV']) delete process.env[key];
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

// ── production data path is identity ───────────────────────────────────────
test('production (APP_ENV=production): nsKey returns key unchanged', () => {
  withEnv({ APP_ENV: 'production' }, () => {
    assert.equal(nsKey('push:tokens'), 'push:tokens');
    assert.equal(nsKey('push:watchlist:abc'), 'push:watchlist:abc');
    assert.equal(nsKey('some:other:key'), 'some:other:key');
  });
});

// ── staging path prefixes ──────────────────────────────────────────────────
test('staging (APP_ENV=staging): nsKey adds staging: prefix', () => {
  withEnv({ APP_ENV: 'staging' }, () => {
    assert.equal(nsKey('push:tokens'), 'staging:push:tokens');
    assert.equal(nsKey('push:watchlist:tok123'), 'staging:push:watchlist:tok123');
  });
});

test('staging: nsKey is idempotent (does not double-prefix)', () => {
  withEnv({ APP_ENV: 'staging' }, () => {
    assert.equal(nsKey('staging:push:tokens'), 'staging:push:tokens');
    assert.equal(nsKey(nsKey('push:tokens')), 'staging:push:tokens');
  });
});

test('staging: prefix constant is exported for callers that need it', () => {
  assert.equal(STAGING_KV_PREFIX, 'staging:');
});

// ── fail-closed on unset / unknown APP_ENV ─────────────────────────────────
test('missing APP_ENV: nsKey throws AppEnvUnresolved (rework-blocker #2)', () => {
  withEnv({}, () =>
    assert.throws(() => nsKey('push:tokens'), (err) => err instanceof AppEnvUnresolved),
  );
});

test('unknown APP_ENV values throw AppEnvUnresolved (never silently return bare key)', () => {
  for (const bad of ['prod', 'stg', 'staging-typo', 'yes', '1', 'test', ' ']) {
    withEnv({ APP_ENV: bad }, () =>
      assert.throws(
        () => nsKey('push:tokens'),
        (err) => err instanceof AppEnvUnresolved,
        `APP_ENV=${JSON.stringify(bad)} must throw, not return bare key`,
      ),
    );
  }
});

test('trimmed / case-insensitive APP_ENV resolves correctly', () => {
  withEnv({ APP_ENV: '  PRODUCTION ' }, () =>
    assert.equal(nsKey('push:tokens'), 'push:tokens'),
  );
  withEnv({ APP_ENV: 'STAGING' }, () =>
    assert.equal(nsKey('push:tokens'), 'staging:push:tokens'),
  );
});

// ── nsKeys array helper ────────────────────────────────────────────────────
test('nsKeys maps over an array', () => {
  withEnv({ APP_ENV: 'staging' }, () => {
    assert.deepEqual(nsKeys(['a', 'b', 'staging:c']), ['staging:a', 'staging:b', 'staging:c']);
  });
  withEnv({ APP_ENV: 'production' }, () => {
    assert.deepEqual(nsKeys(['a', 'b']), ['a', 'b']);
  });
});

// ── invalid input ──────────────────────────────────────────────────────────
test('nsKey throws on empty string (independent of env)', () => {
  withEnv({ APP_ENV: 'production' }, () => assert.throws(() => nsKey(''), /non-empty string/));
  withEnv({ APP_ENV: 'staging' }, () => assert.throws(() => nsKey(''), /non-empty string/));
});

test('nsKey throws on non-string', () => {
  withEnv({ APP_ENV: 'production' }, () => {
    // @ts-expect-error runtime guard
    assert.throws(() => nsKey(undefined), /non-empty string/);
    // @ts-expect-error runtime guard
    assert.throws(() => nsKey(null), /non-empty string/);
    // @ts-expect-error runtime guard
    assert.throws(() => nsKey(123), /non-empty string/);
  });
});

// ── assertNamespaced boundary check ────────────────────────────────────────
test('assertNamespaced: no-op in production', () => {
  withEnv({ APP_ENV: 'production' }, () => assert.doesNotThrow(() => assertNamespaced('push:tokens')));
});

test('assertNamespaced: staging throws on bare key', () => {
  withEnv({ APP_ENV: 'staging' }, () =>
    assert.throws(() => assertNamespaced('push:tokens'), /missing the "staging:" prefix/),
  );
});

test('assertNamespaced: staging accepts staging-prefixed key', () => {
  withEnv({ APP_ENV: 'staging' }, () =>
    assert.doesNotThrow(() => assertNamespaced('staging:push:tokens')),
  );
});

test('assertNamespaced: throws AppEnvUnresolved on unset APP_ENV', () => {
  withEnv({}, () =>
    assert.throws(() => assertNamespaced('push:tokens'), (err) => err instanceof AppEnvUnresolved),
  );
});

console.log(`\nkv-namespace: ${passed} tests passed`);
