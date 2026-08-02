/**
 * test-identity-store.mjs
 *
 * Regression tests for the common-account identity invariants (DIC-664 / CR DIC-855 #7).
 * Exercises the platform-free identity logic in src/services/auth/identityStore.ts
 * without pulling in react-native / expo / zustand.
 *
 * Run:  node --experimental-strip-types scripts/test-identity-store.mjs
 * (Node 22.6+; type stripping lets us import the .ts helper directly.)
 */
import assert from 'node:assert/strict';
import {
  findOrCreateUser,
  linkIdentity,
  unlinkIdentity,
  ProviderCollisionError,
  AlreadyLinkedError,
  LastProviderError,
} from '../src/services/auth/identityStore.ts';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

// 1. New Apple user is created on first sight.
test('first Apple login creates a new user keyed by sub', () => {
  const r = findOrCreateUser([], { id: 'apple_sub_1', email: 'first@icloud.com', name: 'Aki' }, 'apple');
  assert.equal(r.isNew, true);
  assert.equal(r.user.linkedProviders.length, 1);
  assert.equal(r.user.linkedProviders[0].providerId, 'apple_sub_1');
  assert.equal(r.users.length, 1);
});

// 2. Returning Apple login (null name/email — private relay / hidden) must NOT
//    wipe the name/email captured on first authorization.
test('returning Apple login with null name/email preserves first-auth values', () => {
  const first = findOrCreateUser([], { id: 'apple_sub_1', email: 'first@icloud.com', name: 'Aki' }, 'apple');
  const returning = findOrCreateUser(first.users, { id: 'apple_sub_1', email: '', name: '' }, 'apple');
  assert.equal(returning.isNew, false);
  assert.equal(returning.user.internalId, first.user.internalId);
  const identity = returning.user.linkedProviders[0];
  assert.equal(identity.email, 'first@icloud.com');
  assert.equal(identity.displayName, 'Aki');
});

// 3. Email is NEVER the identity key: same email, different subs => two accounts.
test('same email under different subs stays two distinct accounts', () => {
  const a = findOrCreateUser([], { id: 'sub_a', email: 'shared@example.com', name: 'A' }, 'apple');
  const b = findOrCreateUser(a.users, { id: 'sub_b', email: 'shared@example.com', name: 'B' }, 'google');
  assert.equal(b.isNew, true);
  assert.equal(b.users.length, 2);
  assert.notEqual(a.user.internalId, b.user.internalId);
});

// 4. Linking a second provider keeps the same internalId (data does not move).
test('linking Google onto an Apple user keeps one internalId with two providers', () => {
  const apple = findOrCreateUser([], { id: 'apple_1', email: 'a@icloud.com', name: 'Aki' }, 'apple');
  const linked = linkIdentity(apple.users, apple.user, { id: 'google_1', email: 'a@gmail.com', name: 'Aki' }, 'google');
  assert.equal(linked.user.internalId, apple.user.internalId);
  assert.equal(linked.user.linkedProviders.length, 2);
  assert.deepEqual(
    linked.user.linkedProviders.map((p) => p.provider).sort(),
    ['apple', 'google'],
  );
});

// 5. Linking an identity already owned by another user is a collision (rejected).
test('linking a provider identity owned by another account throws collision', () => {
  const u1 = findOrCreateUser([], { id: 'google_1', email: 'g@gmail.com', name: 'G' }, 'google');
  const u2 = findOrCreateUser(u1.users, { id: 'apple_1', email: 'a@icloud.com', name: 'A' }, 'apple');
  assert.throws(
    () => linkIdentity(u2.users, u2.user, { id: 'google_1', email: 'g@gmail.com', name: 'G' }, 'google'),
    ProviderCollisionError,
  );
});

// 6. Linking an identity already on the same account is rejected as already-linked.
test('linking the same identity twice throws already-linked', () => {
  const apple = findOrCreateUser([], { id: 'apple_1', email: 'a@icloud.com', name: 'A' }, 'apple');
  const linked = linkIdentity(apple.users, apple.user, { id: 'google_1', email: 'g@gmail.com', name: 'G' }, 'google');
  assert.throws(
    () => linkIdentity(linked.users, linked.user, { id: 'google_1', email: 'g@gmail.com', name: 'G' }, 'google'),
    AlreadyLinkedError,
  );
});

// 7. Unlink preserves at least one provider; unlinking the last one is blocked.
test('unlink keeps at least one login method', () => {
  const apple = findOrCreateUser([], { id: 'apple_1', email: 'a@icloud.com', name: 'A' }, 'apple');
  const linked = linkIdentity(apple.users, apple.user, { id: 'google_1', email: 'g@gmail.com', name: 'G' }, 'google');

  const afterUnlink = unlinkIdentity(linked.users, linked.user, 'google');
  assert.equal(afterUnlink.user.linkedProviders.length, 1);
  assert.equal(afterUnlink.user.linkedProviders[0].provider, 'apple');

  assert.throws(
    () => unlinkIdentity(afterUnlink.users, afterUnlink.user, 'apple'),
    LastProviderError,
  );
});

console.log(`\nidentity-store: ${passed} tests passed`);
