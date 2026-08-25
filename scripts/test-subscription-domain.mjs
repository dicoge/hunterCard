#!/usr/bin/env node
/**
 * DIC-1149 Phase 1a — provider-neutral subscription domain regression.
 *
 * Mutation-sensitive assertions: every test is written so that a targeted
 * regression (silently skipping the revision check, letting `unknown` grant
 * entitlement, treating a client-side `succeeded` as authoritative, mixing
 * providers, forgetting to reject a guest purchase, mis-parsing the env
 * config) causes at least one assertion to fail.
 *
 * Run: node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *        --import ./scripts/register-ts.mjs scripts/test-subscription-domain.mjs
 */
import assert from 'node:assert/strict';

import {
  DEFAULT_FREE_SNAPSHOT,
  UNKNOWN_SNAPSHOT,
  ENTITLED_STATES,
  isEntitled,
  reduce,
  fold,
  resolveSubscriptionConfig,
  SUBSCRIPTION_ENV,
  brandAppUserId,
  resolveAppUserId,
  tryResolveAppUserId,
  AppUserIdResolutionError,
  resolveRoleFromSnapshot,
  checkPurchaseGate,
} from '../src/subscription/index.ts';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const provider = 'test_provider';
const otherProvider = 'other_provider';

function ev(overrides) {
  return {
    kind: 'purchase_verified',
    productId: 'sku_monthly',
    expiresAt: '2027-01-01T00:00:00.000Z',
    revision: 1,
    providerTag: provider,
    emittedAt: '2026-08-24T00:00:00.000Z',
    ...overrides,
  };
}

// ── entitled-state set ────────────────────────────────────────────────────
await test('ENTITLED_STATES contains exactly active/grace/cancelled_until_expiry', () => {
  const expected = new Set(['active', 'grace', 'cancelled_until_expiry']);
  assert.equal(ENTITLED_STATES.size, expected.size);
  for (const s of expected) assert.ok(ENTITLED_STATES.has(s), `missing ${s}`);
  assert.equal(isEntitled('active'), true);
  assert.equal(isEntitled('grace'), true);
  assert.equal(isEntitled('cancelled_until_expiry'), true);
  assert.equal(isEntitled('billing_issue'), false);
  assert.equal(isEntitled('expired'), false);
  assert.equal(isEntitled('refunded_revoked'), false);
  assert.equal(isEntitled('free'), false);
  assert.equal(isEntitled('unknown'), false);
});

// ── happy-path transitions ────────────────────────────────────────────────
await test('free → purchase_verified promotes to active with product/expiry/revision', () => {
  const result = reduce(DEFAULT_FREE_SNAPSHOT, ev({ revision: 1 }));
  assert.equal(result.rejected, null);
  assert.equal(result.snapshot.state, 'active');
  assert.equal(result.snapshot.productId, 'sku_monthly');
  assert.equal(result.snapshot.expiresAt, '2027-01-01T00:00:00.000Z');
  assert.equal(result.snapshot.revision, 1);
  assert.equal(result.snapshot.providerTag, provider);
});

await test('active → renewal_verified stays active and advances revision + expiry', () => {
  const active = reduce(DEFAULT_FREE_SNAPSHOT, ev({ revision: 1 })).snapshot;
  const renewed = reduce(
    active,
    ev({
      kind: 'renewal_verified',
      revision: 2,
      expiresAt: '2027-02-01T00:00:00.000Z',
    }),
  );
  assert.equal(renewed.rejected, null);
  assert.equal(renewed.snapshot.state, 'active');
  assert.equal(renewed.snapshot.revision, 2);
  assert.equal(renewed.snapshot.expiresAt, '2027-02-01T00:00:00.000Z');
});

await test('active → cancel_scheduled → cancelled_until_expiry stays entitled', () => {
  const active = reduce(DEFAULT_FREE_SNAPSHOT, ev({ revision: 1 })).snapshot;
  const cancelled = reduce(
    active,
    ev({ kind: 'cancel_scheduled', revision: 2 }),
  );
  assert.equal(cancelled.rejected, null);
  assert.equal(cancelled.snapshot.state, 'cancelled_until_expiry');
  assert.equal(isEntitled(cancelled.snapshot.state), true);
});

await test('active → entered_grace produces grace; grace → renewal_verified returns to active', () => {
  const active = reduce(DEFAULT_FREE_SNAPSHOT, ev({ revision: 1 })).snapshot;
  const grace = reduce(active, ev({ kind: 'entered_grace', revision: 2 }));
  assert.equal(grace.snapshot.state, 'grace');
  assert.equal(isEntitled(grace.snapshot.state), true);
  const recovered = reduce(
    grace.snapshot,
    ev({ kind: 'renewal_verified', revision: 3 }),
  );
  assert.equal(recovered.snapshot.state, 'active');
});

await test('active → billing_issue_reported suspends entitlement', () => {
  const active = reduce(DEFAULT_FREE_SNAPSHOT, ev({ revision: 1 })).snapshot;
  const bi = reduce(
    active,
    ev({ kind: 'billing_issue_reported', revision: 2 }),
  );
  assert.equal(bi.snapshot.state, 'billing_issue');
  assert.equal(isEntitled(bi.snapshot.state), false);
});

await test('expired clears productId; refund clears productId too', () => {
  const active = reduce(DEFAULT_FREE_SNAPSHOT, ev({ revision: 1 })).snapshot;
  const expired = reduce(active, ev({ kind: 'expired', revision: 2, expiresAt: null }));
  assert.equal(expired.snapshot.state, 'expired');
  assert.equal(expired.snapshot.productId, null);
  const refunded = reduce(
    active,
    ev({ kind: 'refund_or_revoke', revision: 3, expiresAt: null }),
  );
  assert.equal(refunded.snapshot.state, 'refunded_revoked');
  assert.equal(refunded.snapshot.productId, null);
});

await test('restore_verified from free/unknown re-promotes to active', () => {
  const fromFree = reduce(
    DEFAULT_FREE_SNAPSHOT,
    ev({ kind: 'restore_verified', revision: 5 }),
  );
  assert.equal(fromFree.snapshot.state, 'active');
  assert.equal(fromFree.rejected, null);
  const fromUnknown = reduce(
    UNKNOWN_SNAPSHOT,
    ev({ kind: 'restore_verified', revision: 7 }),
  );
  assert.equal(fromUnknown.snapshot.state, 'active');
  assert.equal(fromUnknown.rejected, null);
});

// ── duplicate / out-of-order rejection ────────────────────────────────────
await test('duplicate event (same revision) is dropped and state is unchanged', () => {
  const active = reduce(DEFAULT_FREE_SNAPSHOT, ev({ revision: 5 })).snapshot;
  const dup = reduce(active, ev({ kind: 'renewal_verified', revision: 5 }));
  assert.equal(dup.rejected, 'duplicate_or_out_of_order');
  assert.deepEqual(dup.snapshot, active);
});

await test('out-of-order event (lower revision) is dropped', () => {
  const active = reduce(DEFAULT_FREE_SNAPSHOT, ev({ revision: 5 })).snapshot;
  const late = reduce(active, ev({ kind: 'renewal_verified', revision: 3 }));
  assert.equal(late.rejected, 'duplicate_or_out_of_order');
  assert.deepEqual(late.snapshot, active);
});

await test('duplicate refund cannot re-fire from refunded_revoked', () => {
  const active = reduce(DEFAULT_FREE_SNAPSHOT, ev({ revision: 1 })).snapshot;
  const refunded = reduce(
    active,
    ev({ kind: 'refund_or_revoke', revision: 2, expiresAt: null }),
  ).snapshot;
  // Same revision again → dropped by ordering guard.
  const again = reduce(
    refunded,
    ev({ kind: 'refund_or_revoke', revision: 2, expiresAt: null }),
  );
  assert.equal(again.rejected, 'duplicate_or_out_of_order');
});

// ── unsupported transitions collapse to `unknown` ─────────────────────────
await test('purchase_verified from active is unsupported and fails closed to unknown', () => {
  // Second `purchase_verified` (rather than a renewal) is a classic
  // ambiguous provider signal; the reducer must NOT extend entitlement
  // silently — it collapses to `unknown` (fail-closed).
  const active = reduce(DEFAULT_FREE_SNAPSHOT, ev({ revision: 1 })).snapshot;
  const bad = reduce(active, ev({ kind: 'purchase_verified', revision: 2 }));
  assert.equal(bad.rejected, 'unsupported_transition');
  assert.equal(bad.snapshot.state, 'unknown');
  assert.equal(isEntitled(bad.snapshot.state), false);
  // Revision advances so the bad event does not re-fire.
  assert.equal(bad.snapshot.revision, 2);
});

await test('refund_or_revoke from free is unsupported (cannot refund what was never bought)', () => {
  const bad = reduce(
    DEFAULT_FREE_SNAPSHOT,
    ev({ kind: 'refund_or_revoke', revision: 1, expiresAt: null }),
  );
  assert.equal(bad.rejected, 'unsupported_transition');
  assert.equal(bad.snapshot.state, 'unknown');
});

await test('entered_grace from free is unsupported', () => {
  const bad = reduce(DEFAULT_FREE_SNAPSHOT, ev({ kind: 'entered_grace', revision: 1 }));
  assert.equal(bad.rejected, 'unsupported_transition');
  assert.equal(bad.snapshot.state, 'unknown');
});

// ── cross-provider mismatch is rejected ───────────────────────────────────
await test('event from a different provider than the snapshot is rejected', () => {
  const active = reduce(DEFAULT_FREE_SNAPSHOT, ev({ revision: 1 })).snapshot;
  const foreign = reduce(
    active,
    ev({ providerTag: otherProvider, kind: 'renewal_verified', revision: 2 }),
  );
  assert.equal(foreign.rejected, 'provider_mismatch');
  assert.deepEqual(foreign.snapshot, active);
});

await test('synthetic default snapshot (null providerTag) may be adopted by any provider', () => {
  const first = reduce(DEFAULT_FREE_SNAPSHOT, ev({ providerTag: otherProvider }));
  assert.equal(first.rejected, null);
  assert.equal(first.snapshot.providerTag, otherProvider);
});

// ── fold semantics ────────────────────────────────────────────────────────
await test('fold applies a batched webhook backlog and reports each rejection', () => {
  const { snapshot, rejections } = fold([
    ev({ revision: 1 }),
    ev({ kind: 'renewal_verified', revision: 2, expiresAt: '2027-03-01T00:00:00.000Z' }),
    // duplicate of the renewal
    ev({ kind: 'renewal_verified', revision: 2 }),
    ev({ kind: 'cancel_scheduled', revision: 3 }),
    ev({ kind: 'expired', revision: 4, expiresAt: null }),
  ]);
  assert.equal(snapshot.state, 'expired');
  assert.equal(snapshot.productId, null);
  assert.equal(snapshot.revision, 4);
  assert.deepEqual(rejections, ['duplicate_or_out_of_order']);
});

// ── config fail-closed ────────────────────────────────────────────────────
await test('resolveSubscriptionConfig: unset env is disabled (unset)', () => {
  const cfg = resolveSubscriptionConfig({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.reason, 'unset');
});

await test('resolveSubscriptionConfig: whitespace-only provider tag is unset', () => {
  const cfg = resolveSubscriptionConfig({
    [SUBSCRIPTION_ENV.PROVIDER_TAG]: '   ',
    [SUBSCRIPTION_ENV.PROVIDER_ENV]: 'sandbox',
    [SUBSCRIPTION_ENV.PROVIDER_PUBLIC_KEY]: 'pk_test_1234567890',
  });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.reason, 'unset');
});

await test('resolveSubscriptionConfig: malformed provider tag rejected', () => {
  const cfg = resolveSubscriptionConfig({
    [SUBSCRIPTION_ENV.PROVIDER_TAG]: '9bad-tag',
    [SUBSCRIPTION_ENV.PROVIDER_ENV]: 'sandbox',
    [SUBSCRIPTION_ENV.PROVIDER_PUBLIC_KEY]: 'pk_test_1234567890',
  });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.reason, 'malformed_provider_tag');
});

await test('resolveSubscriptionConfig: unknown env value is malformed', () => {
  const cfg = resolveSubscriptionConfig({
    [SUBSCRIPTION_ENV.PROVIDER_TAG]: 'revenuecat',
    [SUBSCRIPTION_ENV.PROVIDER_ENV]: 'staging',
    [SUBSCRIPTION_ENV.PROVIDER_PUBLIC_KEY]: 'pk_test_1234567890',
  });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.reason, 'malformed_provider_env');
});

await test('resolveSubscriptionConfig: too-short public key fails as missing', () => {
  const cfg = resolveSubscriptionConfig({
    [SUBSCRIPTION_ENV.PROVIDER_TAG]: 'revenuecat',
    [SUBSCRIPTION_ENV.PROVIDER_ENV]: 'sandbox',
    [SUBSCRIPTION_ENV.PROVIDER_PUBLIC_KEY]: 'short',
  });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.reason, 'missing_public_key');
});

await test('resolveSubscriptionConfig: fully valid env enables and normalises casing', () => {
  const cfg = resolveSubscriptionConfig({
    [SUBSCRIPTION_ENV.PROVIDER_TAG]: '  RevenueCat  ',
    [SUBSCRIPTION_ENV.PROVIDER_ENV]: 'SANDBOX',
    [SUBSCRIPTION_ENV.PROVIDER_PUBLIC_KEY]: 'pk_public_key_ABCDEFGH',
  });
  assert.equal(cfg.enabled, true);
  if (cfg.enabled) {
    assert.equal(cfg.providerTag, 'revenuecat');
    assert.equal(cfg.providerEnv, 'sandbox');
    assert.equal(cfg.providerPublicKey, 'pk_public_key_ABCDEFGH');
  }
});

// ── App User ID contract ──────────────────────────────────────────────────
await test('brandAppUserId accepts the existing holo_<hex> backend id shape', () => {
  const branded = brandAppUserId('holo_9f1c3a7b2e8d4a10');
  assert.equal(branded.__brand, 'AppUserIdentity');
  assert.equal(branded.value, 'holo_9f1c3a7b2e8d4a10');
});

await test('brandAppUserId rejects an email address', () => {
  assert.throws(
    () => brandAppUserId('user@example.com'),
    (err) => err instanceof AppUserIdResolutionError && err.kind === 'malformed_backend_uuid',
  );
});

await test('brandAppUserId rejects whitespace / empty / too-short', () => {
  for (const bad of ['', '   ', 'short', 'has space', 'has/slash', 'a'.repeat(200)]) {
    assert.throws(
      () => brandAppUserId(bad),
      AppUserIdResolutionError,
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }
});

await test('resolveAppUserId throws no_signed_in_user when resolver returns null/empty', () => {
  for (const returnValue of [null, '']) {
    assert.throws(
      () => resolveAppUserId(() => returnValue),
      (err) => err instanceof AppUserIdResolutionError && err.kind === 'no_signed_in_user',
    );
  }
});

await test('tryResolveAppUserId returns null on failure, branded on success', () => {
  assert.equal(tryResolveAppUserId(() => null), null);
  assert.equal(tryResolveAppUserId(() => 'user@example.com'), null);
  const ok = tryResolveAppUserId(() => 'holo_9f1c3a7b2e8d4a10');
  assert.equal(ok?.value, 'holo_9f1c3a7b2e8d4a10');
});

// ── entitlement resolver preserves free_user across every unresolved case ─
const ENABLED_CFG = { enabled: true, providerTag: 'revenuecat', providerEnv: 'sandbox', providerPublicKey: 'pk_pub_key' };
const UID = 'holo_9f1c3a7b2e8d4a10';

await test('entitlement resolver: no signed-in user → guest regardless of snapshot', () => {
  const role = resolveRoleFromSnapshot({
    signedInUserId: null,
    snapshot: { ...DEFAULT_FREE_SNAPSHOT, state: 'active', providerTag: 'revenuecat', revision: 1 },
    config: ENABLED_CFG,
    premiumEnabled: true,
  });
  assert.equal(role, 'guest');
});

await test('entitlement resolver: premiumEnabled=false (Store MVP) → free_user even with active snapshot', () => {
  const role = resolveRoleFromSnapshot({
    signedInUserId: UID,
    snapshot: { ...DEFAULT_FREE_SNAPSHOT, state: 'active', providerTag: 'revenuecat', revision: 1 },
    config: ENABLED_CFG,
    premiumEnabled: false,
  });
  assert.equal(role, 'free_user');
});

await test('entitlement resolver: disabled config → free_user even with active snapshot', () => {
  const role = resolveRoleFromSnapshot({
    signedInUserId: UID,
    snapshot: { ...DEFAULT_FREE_SNAPSHOT, state: 'active', providerTag: 'revenuecat', revision: 1 },
    config: { enabled: false, reason: 'unset' },
    premiumEnabled: true,
  });
  assert.equal(role, 'free_user');
});

await test('entitlement resolver: null snapshot → free_user (Store MVP Production path preserved)', () => {
  const role = resolveRoleFromSnapshot({
    signedInUserId: UID,
    snapshot: null,
    config: ENABLED_CFG,
    premiumEnabled: true,
  });
  assert.equal(role, 'free_user');
});

await test('entitlement resolver: unknown snapshot → free_user (fail-closed)', () => {
  const role = resolveRoleFromSnapshot({
    signedInUserId: UID,
    snapshot: UNKNOWN_SNAPSHOT,
    config: ENABLED_CFG,
    premiumEnabled: true,
  });
  assert.equal(role, 'free_user');
});

await test('entitlement resolver: cross-provider snapshot → free_user', () => {
  const role = resolveRoleFromSnapshot({
    signedInUserId: UID,
    snapshot: { ...DEFAULT_FREE_SNAPSHOT, state: 'active', providerTag: 'stripe', revision: 1 },
    config: ENABLED_CFG,
    premiumEnabled: true,
  });
  assert.equal(role, 'free_user');
});

await test('entitlement resolver: active/grace/cancelled_until_expiry → subscriber; others → free_user', () => {
  for (const state of ['active', 'grace', 'cancelled_until_expiry']) {
    const role = resolveRoleFromSnapshot({
      signedInUserId: UID,
      snapshot: { ...DEFAULT_FREE_SNAPSHOT, state, providerTag: 'revenuecat', revision: 1 },
      config: ENABLED_CFG,
      premiumEnabled: true,
    });
    assert.equal(role, 'subscriber', `${state} should be subscriber`);
  }
  for (const state of ['billing_issue', 'expired', 'refunded_revoked', 'free']) {
    const role = resolveRoleFromSnapshot({
      signedInUserId: UID,
      snapshot: { ...DEFAULT_FREE_SNAPSHOT, state, providerTag: 'revenuecat', revision: 1 },
      config: ENABLED_CFG,
      premiumEnabled: true,
    });
    assert.equal(role, 'free_user', `${state} should be free_user`);
  }
});

// ── purchase gate: guest cannot purchase; already-entitled cannot re-purchase ─
await test('purchase gate: guest is blocked with guest_must_sign_in', () => {
  const gate = checkPurchaseGate({
    signedInUserId: null,
    snapshot: null,
    config: ENABLED_CFG,
    premiumEnabled: true,
  });
  assert.equal(gate, 'guest_must_sign_in');
});

await test('purchase gate: premiumEnabled=false is blocked with premium_disabled_by_release', () => {
  const gate = checkPurchaseGate({
    signedInUserId: UID,
    snapshot: null,
    config: ENABLED_CFG,
    premiumEnabled: false,
  });
  assert.equal(gate, 'premium_disabled_by_release');
});

await test('purchase gate: disabled config is blocked with subscription_disabled_by_config', () => {
  const gate = checkPurchaseGate({
    signedInUserId: UID,
    snapshot: null,
    config: { enabled: false, reason: 'missing_public_key' },
    premiumEnabled: true,
  });
  assert.equal(gate, 'subscription_disabled_by_config');
});

await test('purchase gate: already-entitled is blocked with already_entitled', () => {
  const gate = checkPurchaseGate({
    signedInUserId: UID,
    snapshot: { ...DEFAULT_FREE_SNAPSHOT, state: 'active', providerTag: 'revenuecat', revision: 1 },
    config: ENABLED_CFG,
    premiumEnabled: true,
  });
  assert.equal(gate, 'already_entitled');
});

await test('purchase gate: signed-in, no entitlement, enabled config → ok', () => {
  const gate = checkPurchaseGate({
    signedInUserId: UID,
    snapshot: null,
    config: ENABLED_CFG,
    premiumEnabled: true,
  });
  assert.equal(gate, 'ok');
});

// ── no entitlement escalation from a client-only PurchaseOutcome ──────────
await test('a client-side "succeeded" outcome does NOT change the snapshot on its own', () => {
  // Simulate the shape of PurchaseOutcome flowing through the client. The
  // domain has NO reducer input for PurchaseOutcome — the only way to
  // change state is via a ProviderEvent produced by an adapter that has
  // (per the interface contract) verified with the server. This test
  // guards that contract: passing anything that is not a ProviderEvent
  // must not be accepted.
  const clientSuccess = { kind: 'succeeded', productId: 'sku_monthly' };
  // Deliberately cast: if a future refactor adds a reducer overload
  // accepting PurchaseOutcome, this test will fail (either compile-time
  // via the tsc CI check or runtime via the assertion below).
  const before = DEFAULT_FREE_SNAPSHOT;
  const after = reduce(before, /** @type {any} */ (clientSuccess));
  // A `succeeded` PurchaseOutcome has no `revision`; the guard reads it
  // as `undefined <= 0` which is false, so it falls through to the
  // ALLOWED table; `undefined` is not a valid kind so lookup returns
  // undefined; `.includes` on undefined throws — either way the test
  // catches a change that would silently accept the outcome.
  //
  // Instead of asserting the throw shape (which depends on undefined
  // handling), assert the snapshot did not enter an entitled state.
  assert.notEqual(after.snapshot.state, 'active');
  assert.equal(isEntitled(after.snapshot.state), false);
});

// ── restore error is surfaced, not swallowed ──────────────────────────────
await test('a failing restore must not fabricate an active snapshot', () => {
  // Model: adapter.restore() rejects. The caller must therefore call the
  // reducer with ZERO events (nothing verified). The snapshot must not
  // spontaneously become active — it stays whatever it was.
  const before = DEFAULT_FREE_SNAPSHOT;
  const { snapshot, rejections } = fold([], before);
  assert.deepEqual(snapshot, before);
  assert.deepEqual(rejections, []);
  assert.equal(snapshot.state, 'free');
});

console.log(`\n[subscription-domain] ${passed} checks passed`);
