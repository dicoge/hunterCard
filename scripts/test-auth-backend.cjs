#!/usr/bin/env node
/**
 * Regression tests for the server-authoritative identity store (DIC-663).
 *
 * Exercises the DIC-662 contract on an in-memory Vercel-KV mock: new/returning
 * login, cross-account collision, same-provider guard, last-method guard,
 * concurrent mutation serialisation, write-failure honesty (no false success),
 * and Apple private-relay / changed-email handling (identity keyed by subject,
 * never by email).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-backend-tests-'));

const kvState = {
  values: new Map(),
  sets: new Map(),
  failOn: null, // (op, key) => boolean — inject a write failure
};

function resetKv() {
  kvState.values.clear();
  kvState.sets.clear();
  kvState.failOn = null;
}

function maybeFail(op, key) {
  if (kvState.failOn && kvState.failOn(op, key)) {
    throw new Error(`injected KV failure: ${op} ${key}`);
  }
}

const kv = {
  async get(key) {
    return kvState.values.has(key) ? kvState.values.get(key) : null;
  },
  async set(key, value, opts) {
    maybeFail('set', key);
    if (opts && opts.nx && kvState.values.has(key)) return null;
    kvState.values.set(key, value);
    return 'OK';
  },
  async del(key) {
    maybeFail('del', key);
    const had = kvState.values.delete(key) || kvState.sets.delete(key);
    return had ? 1 : 0;
  },
  async sadd(key, ...members) {
    maybeFail('sadd', key);
    const set = kvState.sets.get(key) ?? new Set();
    let added = 0;
    for (const m of members) {
      if (!set.has(m)) added += 1;
      set.add(m);
    }
    kvState.sets.set(key, set);
    return added;
  },
  async srem(key, ...members) {
    maybeFail('srem', key);
    const set = kvState.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const m of members) if (set.delete(m)) removed += 1;
    if (set.size === 0) kvState.sets.delete(key);
    return removed;
  },
  async smembers(key) {
    const set = kvState.sets.get(key);
    return set ? [...set] : [];
  },
  async eval(script, keys, args) {
    // Only the lock compare-and-delete script is used by the store.
    if (script.includes("redis.call('DEL', KEYS[1])")) {
      const [lockKey] = keys;
      const [token] = args;
      if (kvState.values.get(lockKey) === token) {
        kvState.values.delete(lockKey);
        return 1;
      }
      return 0;
    }
    throw new Error(`Unexpected eval script: ${script}`);
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request) {
  if (request === '@vercel/kv') return { kv };
  return originalLoad.apply(this, arguments);
};

function compileTs(relPath) {
  const input = path.join(ROOT, relPath);
  const output = path.join(outDir, relPath).replace(/\.ts$/, '.js');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const source = fs.readFileSync(input, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: input,
  });
  fs.writeFileSync(output, compiled.outputText);
}

// session.ts reads AUTH_SESSION_SECRET lazily (per call), so setting it before
// any issue/verify call is enough. It also lets identity-store sign merge tokens.
process.env.AUTH_SESSION_SECRET = process.env.AUTH_SESSION_SECRET || 'test-session-secret';

compileTs('api/lib/identity-store.ts');
const store = require(path.join(outDir, 'api/lib/identity-store.js'));

compileTs('api/lib/session.ts');
const session = require(path.join(outDir, 'api/lib/session.js'));

function identity(provider, subject, email, name) {
  return { provider, subject, email, name };
}

async function expectError(promise, code) {
  try {
    await promise;
  } catch (err) {
    assert.equal(err.code, code, `expected error code ${code}, got ${err.code} (${err.message})`);
    return err;
  }
  throw new Error(`expected ${code} to be thrown, but call resolved`);
}

async function testNewAndReturningUser() {
  resetKv();
  const first = await store.loginOrCreate(identity('google', 'sub-1', 'a@example.com', 'Ann'));
  assert.equal(first.isNew, true);
  assert.equal(first.user.linkedProviders.length, 1);
  assert.equal(first.user.linkedProviders[0].providerId, 'sub-1');

  const second = await store.loginOrCreate(identity('google', 'sub-1', 'a@example.com', 'Ann'));
  assert.equal(second.isNew, false, 'returning login must not create a new user');
  assert.equal(second.user.internalId, first.user.internalId, 'same internal user id on return');
}

async function testLinkSecondProviderAndUnlink() {
  resetKv();
  const { user } = await store.loginOrCreate(identity('google', 'g-1', 'a@example.com', 'Ann'));
  const linked = await store.linkIdentity(user.internalId, identity('apple', 'a-1', 'a@icloud.com', 'Ann'));
  assert.equal(linked.user.linkedProviders.length, 2, 'both providers linked to one internal user');

  const afterUnlink = await store.unlinkIdentity(user.internalId, 'apple');
  assert.equal(afterUnlink.linkedProviders.length, 1);
  assert.equal(afterUnlink.linkedProviders[0].provider, 'google');
}

async function testCrossAccountCollision() {
  resetKv();
  const userA = (await store.loginOrCreate(identity('google', 'shared-sub', 'a@example.com'))).user;
  const userB = (await store.loginOrCreate(identity('apple', 'b-sub', 'b@example.com'))).user;

  // userB tries to link a Google identity already owned by userA.
  const err = await expectError(
    store.linkIdentity(userB.internalId, identity('google', 'shared-sub', 'a@example.com')),
    'IDENTITY_ALREADY_LINKED',
  );
  assert.ok(err.extra && err.extra.merge_token, 'collision returns a merge_token');
  // Ownership is unchanged: userA still owns it, userB still has only apple.
  const b = await store.getUser(userB.internalId);
  assert.equal(b.linkedProviders.length, 1);
  assert.equal(b.linkedProviders[0].provider, 'apple');
}

async function testSameProviderGuard() {
  resetKv();
  const { user } = await store.loginOrCreate(identity('google', 'g-1', 'a@example.com'));
  await expectError(
    store.linkIdentity(user.internalId, identity('google', 'g-2', 'a2@example.com')),
    'SAME_PROVIDER_ALREADY_LINKED',
  );
}

async function testCannotUnlinkLastMethodAndConcurrency() {
  resetKv();
  const { user } = await store.loginOrCreate(identity('google', 'g-1', 'a@example.com'));
  await store.linkIdentity(user.internalId, identity('apple', 'a-1', 'a@icloud.com'));

  // Two concurrent unlinks of the only two methods: the per-user lock must
  // serialise them so exactly one succeeds and one hits the last-method guard.
  const results = await Promise.allSettled([
    store.unlinkIdentity(user.internalId, 'google'),
    store.unlinkIdentity(user.internalId, 'apple'),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one concurrent unlink succeeds');
  assert.equal(rejected.length, 1, 'the other is rejected');
  assert.equal(rejected[0].reason.code, 'CANNOT_UNLINK_LAST_METHOD');

  const remaining = await store.getUser(user.internalId);
  assert.equal(remaining.linkedProviders.length, 1, 'user keeps exactly one login method');
}

async function testConcurrentUnlinkAndDeleteLeaveNoDanglingIndex() {
  resetKv();
  const { user } = await store.loginOrCreate(identity('google', 'g-9', 'a@example.com'));
  await store.linkIdentity(user.internalId, identity('apple', 'a-9', 'a@icloud.com'));

  await Promise.allSettled([
    store.unlinkIdentity(user.internalId, 'apple'),
    store.deleteUser(user.internalId),
  ]);

  // Whatever the interleaving, no identity index may point at a deleted user.
  for (const key of kvState.values.keys()) {
    if (key.startsWith('auth:idx:')) {
      const ownerId = kvState.values.get(key);
      const ownerExists = kvState.values.has(`auth:user:${ownerId}`);
      assert.ok(ownerExists, `dangling identity index ${key} -> ${ownerId}`);
    }
  }
}

async function testWriteFailureIsNotReportedAsSuccess() {
  resetKv();
  const { user } = await store.loginOrCreate(identity('apple', 'a-1', 'a@icloud.com'));

  // Fail the membership write while linking Google.
  kvState.failOn = (op, key) => op === 'sadd' && key === `auth:user:${user.internalId}:identities`;
  await assert.rejects(
    store.linkIdentity(user.internalId, identity('google', 'g-1', 'a@example.com')),
    /injected KV failure/,
    'a failed write must throw, never resolve as success',
  );

  kvState.failOn = null;
  const after = await store.getUser(user.internalId);
  assert.equal(after.linkedProviders.length, 1, 'the failed link is not reflected as linked');
  assert.equal(after.linkedProviders[0].provider, 'apple');

  // Lock must have been released so a retry can proceed.
  const retry = await store.linkIdentity(user.internalId, identity('google', 'g-1', 'a@example.com'));
  assert.equal(retry.user.linkedProviders.length, 2, 'retry after transient failure succeeds');
}

async function testPrivateRelayEmailChangeDoesNotSplitOrMerge() {
  resetKv();
  const first = await store.loginOrCreate(identity('apple', 'apple-sub-1', 'real@icloud.com', 'Kim'));
  // Same subject, different (relay) email on next login — must resolve to the
  // SAME internal user, never create a new one or merge by email.
  const second = await store.loginOrCreate(
    identity('apple', 'apple-sub-1', 'abc123@privaterelay.appleid.com', 'Kim'),
  );
  assert.equal(second.isNew, false);
  assert.equal(second.user.internalId, first.user.internalId);
  assert.equal(second.user.linkedProviders.length, 1, 'no second identity created by email change');
  assert.equal(second.user.primaryEmail, 'abc123@privaterelay.appleid.com', 'email snapshot updated');

  // A different email that happens to match another account must NOT merge:
  // a brand new subject is a brand new user even with a colliding email.
  const other = await store.loginOrCreate(identity('google', 'google-sub-x', 'real@icloud.com', 'Kim'));
  assert.notEqual(other.user.internalId, first.user.internalId, 'shared email must not merge accounts');
}

async function testDeleteCascadeRemovesIdentities() {
  resetKv();
  const { user } = await store.loginOrCreate(identity('google', 'g-1', 'a@example.com'));
  await store.linkIdentity(user.internalId, identity('apple', 'a-1', 'a@icloud.com'));

  const result = await store.deleteUser(user.internalId);
  assert.equal(result.deletedInternalUser, true);
  assert.equal(result.deletedProviders, 2);
  assert.equal(await store.getUser(user.internalId), null, 'user is gone');
  // The freed (provider, subject) can be claimed by a fresh signup.
  const fresh = await store.loginOrCreate(identity('google', 'g-1', 'c@example.com'));
  assert.equal(fresh.isNew, true);
  assert.notEqual(fresh.user.internalId, user.internalId);
}

function userRecordKeys() {
  return [...kvState.values.keys()].filter((k) => /^auth:user:[^:]+$/.test(k));
}

function indexKeys() {
  return [...kvState.values.keys()].filter((k) => k.startsWith('auth:idx:'));
}

// CR blocker #1: two concurrent login-or-creates for the SAME (provider, subject)
// must converge on ONE internal user. The index is claimed last (the commit), so
// the loser rolls its orphan user back and re-reads the winner instead of minting
// a duplicate. Result: one user record, one index, both callers see the same id.
async function testConcurrentLoginCreateProducesOneUser() {
  resetKv();
  const [a, b] = await Promise.all([
    store.loginOrCreate(identity('google', 'race-sub', 'a@example.com', 'Ann')),
    store.loginOrCreate(identity('google', 'race-sub', 'a@example.com', 'Ann')),
  ]);
  assert.equal(a.user.internalId, b.user.internalId, 'both concurrent logins map to one user');
  assert.equal(userRecordKeys().length, 1, 'exactly one internal user record survives the race');
  assert.equal(indexKeys().length, 1, 'exactly one identity index for the shared subject');
  assert.equal(
    kvState.values.get('auth:idx:google:race-sub'),
    a.user.internalId,
    'the index points at the surviving user',
  );
  // Exactly one caller created; the other observed the winner.
  assert.equal([a.isNew, b.isNew].filter(Boolean).length, 1, 'only one caller is the creator');
}

// CR blocker #1: when a secondary write fails AFTER the link claimed the index,
// the claim must be rolled back so the identity is neither loginnable nor owned.
async function testLinkPartialWriteFreesIndex() {
  resetKv();
  const { user } = await store.loginOrCreate(identity('apple', 'a-1', 'a@icloud.com'));

  kvState.failOn = (op, key) => op === 'sadd' && key === `auth:user:${user.internalId}:identities`;
  await assert.rejects(
    store.linkIdentity(user.internalId, identity('google', 'g-free', 'a@example.com')),
    /injected KV failure/,
  );
  kvState.failOn = null;

  // The index the link claimed must be gone — nothing loginnable left behind.
  assert.equal(
    await kv.get('auth:idx:google:g-free'),
    null,
    'a failed link must free the index it claimed (no residual ownership)',
  );
  const after = await store.getUser(user.internalId);
  assert.equal(after.linkedProviders.length, 1, 'only the original provider remains linked');
}

// CR blocker #1: a create that fails BEFORE the index commit must leave no
// loginnable index. The orphan user record is unreachable (no index points at
// it) and can never resolve a login, and a clean retry mints a valid user.
async function testCreatePartialWriteLeavesNoLoginnableIndex() {
  resetKv();
  kvState.failOn = (op, key) => op === 'sadd' && key.endsWith(':identities');
  await assert.rejects(
    store.loginOrCreate(identity('google', 'crash-sub', 'x@example.com')),
    /injected KV failure/,
  );
  kvState.failOn = null;

  assert.equal(await kv.get('auth:idx:google:crash-sub'), null, 'no index written before commit');
  // A clean login for the same subject now creates a fresh, fully valid user.
  const fresh = await store.loginOrCreate(identity('google', 'crash-sub', 'x@example.com'));
  assert.equal(fresh.isNew, true);
  assert.equal(fresh.user.linkedProviders.length, 1, 'retry yields a valid single-provider user');
  assert.equal(indexKeys().length, 1, 'exactly one index after clean retry');
}

// CR blocker #2: a signed, unexpired token must stop working once its session
// record is revoked. Logout, unlink-others, and delete must all invalidate the
// bearer so a stolen/copied 30-day token cannot be replayed.
async function testSessionRevocationStopsStolenToken() {
  resetKv();
  const token = await session.issueSession('holo_user_1', 'google');
  assert.equal(await session.verifySession(token), 'holo_user_1', 'fresh session verifies');

  // Simulate a stolen copy of the same still-signed, still-unexpired token.
  const stolen = token;
  await session.revokeSession('holo_user_1', decodeJti(token));
  assert.equal(await session.verifySession(token), null, 'revoked token no longer verifies');
  assert.equal(await session.verifySession(stolen), null, 'stolen copy is dead once revoked');
}

// CR blocker #2: unlinking a provider must revoke exactly the sessions that
// provider minted — including the caller's own token if it came from the removed
// provider — while leaving sessions from other still-linked providers alive. The
// old "revoke every OTHER session, keep the caller" logic was backwards: it kept
// the removed provider's caller token and killed the still-valid providers.
async function testUnlinkRevokesOnlyRemovedProviderSessions() {
  resetKv();
  const googleSession = await session.issueSession('holo_user_2', 'google');
  const appleCaller = await session.issueSession('holo_user_2', 'apple');
  const appleOther = await session.issueSession('holo_user_2', 'apple');

  await session.revokeSessionsByProvider('holo_user_2', 'apple');

  assert.equal(await session.verifySession(googleSession), 'holo_user_2', 'other provider session kept');
  assert.equal(await session.verifySession(appleCaller), null, 'removed-provider caller token revoked');
  assert.equal(await session.verifySession(appleOther), null, 'removed-provider other token revoked');
}

async function testSessionContextCarriesProvider() {
  resetKv();
  const token = await session.issueSession('holo_user_p', 'apple');
  const ctx = await session.verifySessionContext(token);
  assert.equal(ctx.userId, 'holo_user_p');
  assert.equal(ctx.provider, 'apple', 'session context exposes the minting provider');
}

async function testRevokeAllSessionsOnDelete() {
  resetKv();
  const a = await session.issueSession('holo_user_3', 'google');
  const b = await session.issueSession('holo_user_3', 'apple');
  await session.revokeAllUserSessions('holo_user_3');
  assert.equal(await session.verifySession(a), null, 'all sessions revoked on delete');
  assert.equal(await session.verifySession(b), null, 'all sessions revoked on delete');
}

// CR blocker #1: an unlink that fails AFTER the decisive index-free but BEFORE the
// membership srem must converge on retry, not strand the identity or fail with
// NO_SUCH_IDENTITY. The target is found via the raw membership set, so a resumed
// unlink (index already freed) still matches; the last-method guard is skipped
// because the target is no longer index-owned; cleanup finishes idempotently.
async function testUnlinkPartialWriteConverges() {
  resetKv();
  const { user } = await store.loginOrCreate(identity('google', 'g-1', 'a@example.com'));
  await store.linkIdentity(user.internalId, identity('apple', 'a-1', 'a@icloud.com'));

  // Fail the detail delete, which runs after the atomic index-free. The index is
  // already gone but membership still lists apple: a half-applied unlink.
  const detailKey = `auth:idetail:${user.internalId}:apple:a-1`;
  kvState.failOn = (op, key) => op === 'del' && key === detailKey;
  await assert.rejects(store.unlinkIdentity(user.internalId, 'apple'), /injected KV failure/);
  kvState.failOn = null;

  // The apple index is freed already; apple is not loginnable, google remains.
  assert.equal(await kv.get('auth:idx:apple:a-1'), null, 'index freed by the decisive step');
  const mid = await store.getUser(user.internalId);
  assert.equal(mid.linkedProviders.length, 1, 'apple no longer reported as linked');
  assert.equal(mid.linkedProviders[0].provider, 'google');

  // Retry converges instead of throwing NO_SUCH_IDENTITY / CANNOT_UNLINK_LAST_METHOD.
  const after = await store.unlinkIdentity(user.internalId, 'apple');
  assert.equal(after.linkedProviders.length, 1, 'retry completes the unlink cleanly');
  assert.equal(after.linkedProviders[0].provider, 'google');
  const members = await kv.smembers(`auth:user:${user.internalId}:identities`);
  assert.ok(!members.includes('apple:a-1'), 'membership entry cleaned up on convergent retry');
}

// CR blocker #1: delete frees an index with an atomic compare-and-delete, so if
// the (provider, subject) has been reclaimed by a NEW user, the stale delete must
// NOT stomp the new owner's index. The old GET-then-DEL had a check-then-act race;
// here we assert the invariant directly: a reclaimed index survives the delete.
async function testDeleteDoesNotStompReclaimedIndex() {
  resetKv();
  const { user } = await store.loginOrCreate(identity('google', 'g-1', 'a@example.com'));

  // Simulate the subject reclaimed by another internal user after `user` linked it.
  kvState.values.set('auth:user:holo_reclaimer', { id: 'holo_reclaimer', status: 'active' });
  kvState.values.set('auth:idx:google:g-1', 'holo_reclaimer');

  await store.deleteUser(user.internalId);

  assert.equal(
    kvState.values.get('auth:idx:google:g-1'),
    'holo_reclaimer',
    'delete must never free an index a new owner has reclaimed',
  );
  assert.equal(await store.getUser(user.internalId), null, 'the deleted user is still fully gone');
}

function decodeJti(token) {
  const encoded = token.slice(0, token.indexOf('.'));
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')).jti;
}

(async () => {
  const tests = [
    testNewAndReturningUser,
    testLinkSecondProviderAndUnlink,
    testCrossAccountCollision,
    testSameProviderGuard,
    testCannotUnlinkLastMethodAndConcurrency,
    testConcurrentUnlinkAndDeleteLeaveNoDanglingIndex,
    testWriteFailureIsNotReportedAsSuccess,
    testPrivateRelayEmailChangeDoesNotSplitOrMerge,
    testDeleteCascadeRemovesIdentities,
    testConcurrentLoginCreateProducesOneUser,
    testLinkPartialWriteFreesIndex,
    testCreatePartialWriteLeavesNoLoginnableIndex,
    testSessionRevocationStopsStolenToken,
    testUnlinkRevokesOnlyRemovedProviderSessions,
    testSessionContextCarriesProvider,
    testRevokeAllSessionsOnDelete,
    testUnlinkPartialWriteConverges,
    testDeleteDoesNotStompReclaimedIndex,
  ];
  for (const test of tests) {
    await test();
    console.log(`✓ ${test.name}`);
  }
  console.log(`\n${tests.length} auth backend tests passed`);
})()
  .finally(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
    Module._load = originalLoad;
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
