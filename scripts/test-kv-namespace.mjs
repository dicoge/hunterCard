#!/usr/bin/env node
/**
 * DIC-1189 tests for api/_lib/kv-namespace.ts.
 *
 * Invariants:
 * - production / unset / unknown APP_ENV → nsKey() is identity (production
 *   data path byte-identical to pre-DIC-1189).
 * - APP_ENV=staging → nsKey() prepends `staging:` (unless the key already
 *   carries the prefix — idempotent).
 * - Empty / non-string keys throw.
 * - assertNamespaced() throws in staging for a bare key; is a no-op in prod.
 *
 * Run: node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *   --import ./scripts/register-ts.mjs scripts/test-kv-namespace.mjs
 */

import assert from 'node:assert/strict';
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
test('production: empty env → nsKey returns key unchanged', () => {
  withEnv({}, () => {
    assert.equal(nsKey('push:tokens'), 'push:tokens');
    assert.equal(nsKey('push:watchlist:abc'), 'push:watchlist:abc');
    assert.equal(nsKey('some:other:key'), 'some:other:key');
  });
});

test('production: unknown APP_ENV → nsKey returns key unchanged (fail-closed to production)', () => {
  for (const bad of ['production', 'prod', 'stage', 'stg', 'yes', '1', 'staging-typo']) {
    withEnv({ APP_ENV: bad }, () => {
      assert.equal(nsKey('push:tokens'), 'push:tokens', `APP_ENV=${JSON.stringify(bad)} must not add prefix`);
    });
  }
});

// ── staging path prefixes ──────────────────────────────────────────────────
test('staging: nsKey adds staging: prefix', () => {
  withEnv({ APP_ENV: 'staging' }, () => {
    assert.equal(nsKey('push:tokens'), 'staging:push:tokens');
    assert.equal(nsKey('push:watchlist:tok123'), 'staging:push:watchlist:tok123');
  });
});

test('staging: nsKey is idempotent (does not double-prefix)', () => {
  withEnv({ APP_ENV: 'staging' }, () => {
    assert.equal(nsKey('staging:push:tokens'), 'staging:push:tokens');
    // Called twice returns the same value.
    assert.equal(nsKey(nsKey('push:tokens')), 'staging:push:tokens');
  });
});

test('staging: prefix constant is exported for callers that need it', () => {
  assert.equal(STAGING_KV_PREFIX, 'staging:');
});

// ── nsKeys array helper ────────────────────────────────────────────────────
test('nsKeys maps over an array', () => {
  withEnv({ APP_ENV: 'staging' }, () => {
    assert.deepEqual(nsKeys(['a', 'b', 'staging:c']), ['staging:a', 'staging:b', 'staging:c']);
  });
  withEnv({}, () => {
    assert.deepEqual(nsKeys(['a', 'b']), ['a', 'b']);
  });
});

// ── invalid input ──────────────────────────────────────────────────────────
test('nsKey throws on empty string', () => {
  withEnv({}, () => assert.throws(() => nsKey(''), /non-empty string/));
  withEnv({ APP_ENV: 'staging' }, () => assert.throws(() => nsKey(''), /non-empty string/));
});

test('nsKey throws on non-string', () => {
  withEnv({}, () => {
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
  withEnv({}, () => assert.doesNotThrow(() => assertNamespaced('push:tokens')));
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

console.log(`\nkv-namespace: ${passed} tests passed`);
