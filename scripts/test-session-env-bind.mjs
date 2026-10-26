#!/usr/bin/env node
/**
 * DIC-1189 tests for api/_lib/session.ts environment binding + separate
 * staging secret (rework-blocker #3).
 *
 * Invariants:
 * - Production uses AUTH_SESSION_SECRET; staging uses
 *   AUTH_SESSION_SECRET_STAGING. Each lane's issue+verify roundtrip works
 *   with its own secret; presenting the other lane's secret fails.
 * - A session minted on production does not verify on staging (env
 *   binding) and vice versa. Signature must match AND env claim must
 *   match the current deployment lane.
 * - Missing APP_ENV: neither issue nor verify succeed.
 *
 * Run: APP_ENV=production node --experimental-strip-types \
 *   --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *   --import ./scripts/register-ts.mjs scripts/test-session-env-bind.mjs
 */

if (!process.env.APP_ENV) process.env.APP_ENV = 'production';

import assert from 'node:assert/strict';
import { issueSession, verifySession, isSessionConfigured } from '../api/_lib/session.ts';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function withEnv(overrides, fn) {
  const before = { ...process.env };
  try {
    for (const k of ['APP_ENV', 'EXPO_PUBLIC_APP_ENV', 'AUTH_SESSION_SECRET', 'AUTH_SESSION_SECRET_STAGING']) {
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

// ── happy paths ────────────────────────────────────────────────────────────
test('production: issue+verify roundtrip with AUTH_SESSION_SECRET', () => {
  withEnv({ APP_ENV: 'production', AUTH_SESSION_SECRET: 'prodsecret1234567890' }, () => {
    const token = issueSession('user-A');
    assert.equal(verifySession(token), 'user-A');
  });
});

test('staging: issue+verify roundtrip with AUTH_SESSION_SECRET_STAGING', () => {
  withEnv({ APP_ENV: 'staging', AUTH_SESSION_SECRET_STAGING: 'stagingsecret9876543' }, () => {
    const token = issueSession('user-B');
    assert.equal(verifySession(token), 'user-B');
  });
});

// ── secret isolation ───────────────────────────────────────────────────────
test('staging refuses to issue when AUTH_SESSION_SECRET_STAGING is unset (does NOT fall back to prod secret)', () => {
  withEnv({ APP_ENV: 'staging', AUTH_SESSION_SECRET: 'prodsecret' }, () => {
    assert.throws(() => issueSession('user-X'), /AUTH_SESSION_SECRET/);
    assert.equal(isSessionConfigured(), false);
  });
});

test('staging verify with production secret set → still rejects (no cross-lane sharing)', () => {
  // Mint a token on production, then attempt to verify on staging without
  // AUTH_SESSION_SECRET_STAGING set. The staging verify path must NOT read
  // AUTH_SESSION_SECRET, so verifying returns null.
  let prodToken;
  withEnv({ APP_ENV: 'production', AUTH_SESSION_SECRET: 'prodsecret' }, () => {
    prodToken = issueSession('user-C');
  });
  withEnv({ APP_ENV: 'staging', AUTH_SESSION_SECRET: 'prodsecret' }, () => {
    assert.equal(verifySession(prodToken), null);
  });
});

// ── env binding ────────────────────────────────────────────────────────────
test('token minted on production does NOT verify on staging even with matching secret', () => {
  // Simulate the pathological case: same secret leaked to both lanes. Env
  // binding still fails the verify because the token carries env='production'.
  const shared = 'sharedsecret12345678';
  let prodToken;
  withEnv({ APP_ENV: 'production', AUTH_SESSION_SECRET: shared }, () => {
    prodToken = issueSession('user-D');
  });
  withEnv({ APP_ENV: 'staging', AUTH_SESSION_SECRET_STAGING: shared }, () => {
    assert.equal(verifySession(prodToken), null);
  });
});

test('token minted on staging does NOT verify on production even with matching secret', () => {
  const shared = 'sharedsecret12345678';
  let stagingToken;
  withEnv({ APP_ENV: 'staging', AUTH_SESSION_SECRET_STAGING: shared }, () => {
    stagingToken = issueSession('user-E');
  });
  withEnv({ APP_ENV: 'production', AUTH_SESSION_SECRET: shared }, () => {
    assert.equal(verifySession(stagingToken), null);
  });
});

// ── unattributed environment ───────────────────────────────────────────────
test('missing APP_ENV: issueSession throws (no secret resolvable)', () => {
  withEnv({}, () => assert.throws(() => issueSession('user-F'), /AUTH_SESSION_SECRET/));
});

test('missing APP_ENV: verifySession returns null (cannot decide lane)', () => {
  withEnv({}, () => assert.equal(verifySession('anything'), null));
});

// ── expiry still enforced ──────────────────────────────────────────────────
test('production: expired token → null', () => {
  withEnv({ APP_ENV: 'production', AUTH_SESSION_SECRET: 'prodsecret' }, () => {
    const token = issueSession('user-G', -1); // negative ttl → already expired
    assert.equal(verifySession(token), null);
  });
});

console.log(`\nsession-env-bind: ${passed} tests passed`);
