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
    // XX: set only if the key already exists. Models the atomic SET XX KEEPTTL the
    // round-6 rebind uses, so a concurrently-deleted (logged-out) session record
    // cannot be resurrected. keepTtl / px are no-ops here (the mock has no TTL).
    if (opts && opts.xx && !kvState.values.has(key)) return null;
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
  async incr(key) {
    maybeFail('incr', key);
    const next = Number(kvState.values.get(key) ?? 0) + 1;
    kvState.values.set(key, next);
    return next;
  },
  async eval(script, keys, args) {
    // Compare-and-pexpire (renewLock): extend the lease iff we still hold it. The
    // mock does not model TTLs, so "extend" is a no-op — we only honour the
    // compare so a non-holder can't renew. Checked before the DEL branch because
    // both scripts share the GET compare prefix.
    if (script.includes("redis.call('PEXPIRE', KEYS[1]")) {
      const [lockKey] = keys;
      const [token] = args;
      return kvState.values.get(lockKey) === token ? 1 : 0;
    }
    // Compare-and-delete (lock release / freeIndexIfOwned).
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

compileTs('api/_lib/identity-store.ts');
const store = require(path.join(outDir, 'api/_lib/identity-store.js'));

compileTs('api/_lib/session.ts');
const session = require(path.join(outDir, 'api/_lib/session.js'));

function identity(provider, subject, email, name) {
  return { provider, subject, email, name };
}

// verifySessionContext now requires the backing user record to exist (round-6
// blocker #3: a token for a deleted user must not authenticate). Pure-session
// tests that mint tokens for synthetic user ids must seed that record first.
function seedUser(id) {
  kvState.values.set(`auth:user:${id}`, { id, status: 'active' });
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
  seedUser('holo_user_1');
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
  seedUser('holo_user_2');
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
  seedUser('holo_user_p');
  const token = await session.issueSession('holo_user_p', 'apple');
  const ctx = await session.verifySessionContext(token);
  assert.equal(ctx.userId, 'holo_user_p');
  assert.equal(ctx.provider, 'apple', 'session context exposes the minting provider');
}

// CR round-6 blocker #3: a successful delete revokes EVERY session for the user,
// INCLUDING the caller's own — the all-session-revocation contract. The round-5
// "keep the caller live" behaviour is gone; response-loss recovery is provided by
// the durable deletion receipt instead (see the receipt-recovery test below).
async function testDeleteRevokesAllSessionsIncludingCaller() {
  resetKv();
  seedUser('holo_user_3');
  const caller = await session.issueSession('holo_user_3', 'google');
  const other = await session.issueSession('holo_user_3', 'apple');
  await session.markUserDeleted('holo_user_3');
  await session.revokeAllUserSessions('holo_user_3');
  assert.equal(await session.verifySession(other), null, 'other device session revoked on delete');
  assert.equal(await session.verifySession(caller), null, "caller's own token revoked on delete");
  const members = await kv.smembers('auth:user:holo_user_3:sessions');
  assert.deepEqual(members, [], 'membership set fully cleared');
}

// CR round-6 blocker #3: a token for a deleted/nonexistent user must NOT verify,
// even though its signature and expiry are still valid and (in a partial-failure
// window) its session record might still exist. This is what makes a post-delete
// bearer fail closed everywhere it is checked (e.g. Apple register via sessionUserId).
async function testVerifySessionRejectsDeletedUser() {
  resetKv();
  seedUser('holo_del_1');
  const token = await session.issueSession('holo_del_1', 'google');
  assert.equal(await session.verifySession(token), 'holo_del_1', 'verifies while the user exists');
  // Simulate deletion of the user record while the (unrevoked) session record lingers.
  kvState.values.delete('auth:user:holo_del_1');
  assert.equal(
    await session.verifySession(token),
    null,
    'signed, unrevoked token fails once the backing user is gone',
  );
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

// ---- CR round-4 blockers -------------------------------------------------

// CR round-4 blocker #3 (fenced/renewable lock). The lease MUST outlive the
// serverless handler budget or it can lapse mid-handler and let a second writer
// corrupt the same user's read-modify-write. Assert the invariant directly.
async function testLockLeaseExceedsHandlerBudget() {
  assert.ok(
    store.LOCK_TTL_MS > store.HANDLER_MAX_DURATION_MS,
    `lock lease (${store.LOCK_TTL_MS}ms) must exceed handler budget (${store.HANDLER_MAX_DURATION_MS}ms)`,
  );
}

// CR round-4 blocker #3. Returning-login now takes the SAME per-user fenced lock
// as link/unlink/delete, so the fence advances across ALL of them (never resets),
// proving they share one authoritative lock rather than login running unserialised.
async function testFencedLockIsSharedAndMonotonic() {
  resetKv();
  const { user } = await store.loginOrCreate(identity('google', 'g-f', 'a@example.com'));
  const id = user.internalId;
  const fenceKey = `auth:fence:${id}`;
  // The create path is serialised by the atomic index claim, not the per-user
  // lock, so no fence is minted for a brand-new user.
  assert.equal(kvState.values.get(fenceKey) ?? 0, 0, 'create path takes no per-user lock');

  await store.linkIdentity(id, identity('apple', 'a-f', 'a@icloud.com'));
  const afterLink = Number(kvState.values.get(fenceKey));
  assert.ok(afterLink >= 1, 'link acquires the fenced lock');

  await store.loginOrCreate(identity('google', 'g-f', 'a@example.com')); // returning login
  const afterLogin = Number(kvState.values.get(fenceKey));
  assert.ok(afterLogin > afterLink, 'returning-login shares the SAME fenced lock (monotonic fence)');

  await store.unlinkIdentity(id, 'apple');
  const afterUnlink = Number(kvState.values.get(fenceKey));
  assert.ok(afterUnlink > afterLogin, 'unlink advances the same fence further');
}

// CR round-4 blocker #3 (login-vs-delete). A returning login and a delete of the
// same user race. The shared lock must prevent a zombie: login either refreshes a
// live user or (if delete won) creates a fresh user — it must NEVER resurrect the
// deleted record as a user with no owning index.
async function testReturningLoginDoesNotResurrectDeletedUser() {
  resetKv();
  const { user } = await store.loginOrCreate(identity('google', 'g-del', 'a@example.com', 'Ann'));
  const id = user.internalId;

  await Promise.allSettled([
    store.loginOrCreate(identity('google', 'g-del', 'a@example.com', 'Ann')),
    store.deleteUser(id),
  ]);

  // Every identity index must point at an existing user record.
  for (const key of indexKeys()) {
    const owner = kvState.values.get(key);
    assert.ok(kvState.values.has(`auth:user:${owner}`), `index ${key} -> missing user ${owner}`);
  }
  // Every surviving user record must be reachable via some index. A resurrected
  // zombie (user record with no owning index) would violate this.
  const pointedTo = new Set(indexKeys().map((k) => kvState.values.get(k)));
  for (const key of userRecordKeys()) {
    const uid = key.slice('auth:user:'.length);
    assert.ok(pointedTo.has(uid), `zombie user record ${uid} with no owning identity index`);
  }
  // If the original user survived, delete lost the race and it must still own its
  // index — never exist without ownership.
  if (kvState.values.has(`auth:user:${id}`)) {
    assert.equal(kvState.values.get('auth:idx:google:g-del'), id, 'surviving original user still owns its index');
  }
}

// CR round-4 blocker #2 (idempotent unlink). Unlinking a provider that is already
// gone must converge (return the current user), not throw NO_SUCH_IDENTITY — the
// convergence property a failed-and-retried unlink depends on.
async function testUnlinkIsIdempotentWhenProviderAbsent() {
  resetKv();
  const { user } = await store.loginOrCreate(identity('google', 'g-1', 'a@example.com'));
  await store.linkIdentity(user.internalId, identity('apple', 'a-1', 'a@icloud.com'));
  const id = user.internalId;

  const first = await store.unlinkIdentity(id, 'apple');
  assert.equal(first.linkedProviders.length, 1);
  const second = await store.unlinkIdentity(id, 'apple'); // already gone
  assert.equal(second.linkedProviders.length, 1, 'idempotent unlink returns the current user');
  assert.equal(second.linkedProviders[0].provider, 'google');
}

// These two helpers mirror the endpoint's composition of store + session
// primitives (api/auth/[action].ts handleUnlink / handleDeleteAccount) as of CR
// round-5. The full serverless handler pulls in provider-token verification and
// can't run in-process, so we drive the exact same ordered sequence here — keyed
// off the caller's OWN token (via verifySessionContext, exactly as the endpoint
// derives ctx) — to prove the endpoint contract (caller-token recoverability,
// retry-convergence) at the unit level.
async function unlinkFlow(callerToken, provider) {
  const ctx = await session.verifySessionContext(callerToken);
  assert.ok(ctx, 'caller token must still be valid on entry');
  const user = await store.unlinkIdentity(ctx.userId, provider);
  // If the caller's own token was minted by the removed provider, atomically
  // RE-BIND that same token to a still-linked provider BEFORE the provider-scoped
  // revoke, so the revoke skips it. The rebind reports whether it succeeded; a
  // false (concurrent logout already revoked it) means callerSessionRevoked:true.
  let callerSessionRevoked = false;
  if (ctx.provider === provider) {
    const remaining = user.linkedProviders[0] && user.linkedProviders[0].provider;
    const rebound = remaining
      ? await session.rebindSessionProvider(ctx.userId, ctx.jti, remaining)
      : false;
    callerSessionRevoked = !rebound;
  }
  await session.revokeSessionsByProvider(ctx.userId, provider);
  return { user, callerSessionRevoked };
}

// Deletion hooks the endpoint hands to commitAccountDeletion: tombstone write +
// idempotent post-cascade cleanup (Apple-token discard is a no-op here — these
// identity-path tests carry no Apple token — plus revoke ALL sessions incl caller).
const deletionHooks = {
  writeTombstone: (uid) => session.markUserDeleted(uid),
  afterCascade: async (uid) => {
    await session.revokeAllUserSessions(uid);
  },
};

async function deleteAccountFlow(callerToken) {
  const ctx = await session.verifySessionContext(callerToken);
  if (!ctx) {
    // Recovery branch: the caller's token was revoked by a successful delete (or a
    // tombstone committed first), but the response was lost. Its signed claims still
    // name the user; paired with the durable deletion receipt, converge to
    // deleted:true WITHOUT a live session by re-running the idempotent commit (CR
    // round-7 blocker #1).
    const claims = session.readSessionClaims(callerToken);
    if (claims && (await session.wasUserDeleted(claims.sub))) {
      await store.commitAccountDeletion(claims.sub, deletionHooks);
      return { deleted: true, recovered: true };
    }
    throw new Error('invalid_session');
  }
  // Tombstone + identity cascade + cleanup run as ONE fenced per-user critical
  // section (CR round-8 blocker #1). Once it returns, the tombstone commit exists,
  // so this and EVERY concurrent/recovery path reports deleted:true — never
  // deleted:false, which would leave a concurrent caller holding a dead session
  // (round-8 blocker #2).
  await store.commitAccountDeletion(ctx.userId, deletionHooks);
  return { deleted: true };
}

// CR round-5 blocker #1 (recoverable caller session after unlink). When the
// caller's own token was minted by the unlinked provider, the endpoint RE-BINDS
// that SAME token to a still-linked provider instead of revoking it. There is no
// new credential to deliver, the caller's token string is unchanged, and it keeps
// verifying — so a lost response is harmless. callerSessionRevoked is always false.
async function testUnlinkRebindsCallerSessionToRemainingProvider() {
  resetKv();
  const { user } = await store.loginOrCreate(identity('google', 'g-1', 'a@example.com'));
  await store.linkIdentity(user.internalId, identity('apple', 'a-1', 'a@icloud.com'));
  const id = user.internalId;

  const appleCaller = await session.issueSession(id, 'apple');
  assert.equal(await session.verifySession(appleCaller), id);

  const res = await unlinkFlow(appleCaller, 'apple');
  assert.equal(res.callerSessionRevoked, false, 'caller token is never revoked by unlink');
  assert.equal(await session.verifySession(appleCaller), id, 'the SAME caller token stays live after re-bind');
  const ctx = await session.verifySessionContext(appleCaller);
  assert.equal(ctx.provider, 'google', 'caller token re-bound to the remaining provider');
}

// CR round-5 blocker #1 (response-loss recoverability). The caller's own token is
// minted by the removed provider. The first unlink succeeds server-side but its
// response is lost; the client, still holding its SAME valid token, retries the
// SAME unlink. The retry converges (idempotent unlink, re-bind already applied,
// remaining provider-sessions revoked) and the caller never holds a dead token.
async function testUnlinkResponseLossRetryConverges() {
  resetKv();
  const { user } = await store.loginOrCreate(identity('google', 'g-1', 'a@example.com'));
  await store.linkIdentity(user.internalId, identity('apple', 'a-1', 'a@icloud.com'));
  const id = user.internalId;

  const appleCaller = await session.issueSession(id, 'apple');
  const appleOther = await session.issueSession(id, 'apple');

  await unlinkFlow(appleCaller, 'apple'); // succeeds server-side; response lost
  assert.equal(await session.verifySession(appleOther), null, 'other apple-minted session revoked');
  assert.equal(await session.verifySession(appleCaller), id, 'caller token still live (re-bound, persisted)');

  // Client lost the response and retries with the very SAME token it persisted.
  const res = await unlinkFlow(appleCaller, 'apple');
  assert.equal(res.callerSessionRevoked, false);
  assert.equal(res.user.linkedProviders.length, 1, 'idempotent: apple stays unlinked on retry');
  assert.equal(await session.verifySession(appleCaller), id, 'caller token remains valid across the retry/reload');
  const ctx = await session.verifySessionContext(appleCaller);
  assert.equal(ctx.provider, 'google', 'caller stays bound to the remaining provider');
}

// CR round-5 blocker #1 (converse). Unlinking a DIFFERENT provider than the one
// that minted the caller's token must leave the caller session live and untouched
// (no re-bind, no revoke of it).
async function testUnlinkOtherProviderKeepsCallerSession() {
  resetKv();
  const { user } = await store.loginOrCreate(identity('google', 'g-1', 'a@example.com'));
  await store.linkIdentity(user.internalId, identity('apple', 'a-1', 'a@icloud.com'));
  const id = user.internalId;

  const googleCaller = await session.issueSession(id, 'google');
  const res = await unlinkFlow(googleCaller, 'apple');
  assert.equal(res.callerSessionRevoked, false);
  assert.equal(await session.verifySession(googleCaller), id, 'caller google session stays live');
  const ctx = await session.verifySessionContext(googleCaller);
  assert.equal(ctx.provider, 'google', 'caller provider unchanged (no re-bind needed)');
}

// CR round-5 blocker #1/#3 (revoke fails AFTER re-bind, on a LATER DEL). The
// caller is same-provider (apple), so its token is re-bound first; the provider
// scoped revoke then revokes the OTHER apple sessions. We fail the SECOND (later)
// of those DELs — not the first/only one — to prove the caller stays re-bound and
// valid and the retry converges regardless of which DEL failed.
async function testUnlinkRetryConvergesAfterRevokeFailure() {
  resetKv();
  const { user } = await store.loginOrCreate(identity('google', 'g-1', 'a@example.com'));
  await store.linkIdentity(user.internalId, identity('apple', 'a-1', 'a@icloud.com'));
  const id = user.internalId;
  const appleCaller = await session.issueSession(id, 'apple');
  const appleOther1 = await session.issueSession(id, 'apple');
  const appleOther2 = await session.issueSession(id, 'apple');
  const other2Jti = decodeJti(appleOther2);

  // Re-bind runs first (caller -> google), then the provider revoke iterates the
  // remaining apple sessions in insertion order: other1 (succeeds), other2 (fails).
  kvState.failOn = (op, key) => op === 'del' && key === `auth:session:${other2Jti}`;
  await assert.rejects(unlinkFlow(appleCaller, 'apple'), /injected KV failure/);
  kvState.failOn = null;

  const mid = await store.getUser(id);
  assert.equal(mid.linkedProviders.length, 1, 'apple already unlinked (identity mutated)');
  assert.equal(await session.verifySession(appleCaller), id, 'caller token re-bound and still valid');
  assert.equal(
    (await session.verifySessionContext(appleCaller)).provider,
    'google',
    're-bind persisted despite the later revoke failure',
  );
  assert.equal(await session.verifySession(appleOther1), null, 'earlier revoke DEL already applied');
  assert.equal(await session.verifySession(appleOther2), id, 'later apple session still live after the failure');

  await unlinkFlow(appleCaller, 'apple'); // retry converges
  assert.equal(await session.verifySession(appleOther2), null, 'later apple session revoked on convergent retry');
  assert.equal(await session.verifySession(appleCaller), id, 'caller remains valid throughout');
}

// CR round-7 blocker #1 (multi-session delete, later session DEL fails). The
// tombstone (receipt) is written FIRST, THEN deleteUser cascades, THEN
// revokeAllUserSessions revokes every session (including the caller's). We fail a
// LATER (not first/only) session DEL. The receipt is already written, so the
// client retries with its now-revoked token and converges via the receipt-recovery
// branch (not a live caller session, which round-6+ forbids).
async function testDeleteRetryConvergesAfterRevokeFailure() {
  resetKv();
  const { user } = await store.loginOrCreate(identity('google', 'g-1', 'a@example.com'));
  const id = user.internalId;
  const caller = await session.issueSession(id, 'google');
  const other1 = await session.issueSession(id, 'google');
  const other2 = await session.issueSession(id, 'apple');
  const other2Jti = decodeJti(other2);

  kvState.failOn = (op, key) => op === 'del' && key === `auth:session:${other2Jti}`;
  await assert.rejects(deleteAccountFlow(caller), /injected KV failure/);
  kvState.failOn = null;

  assert.equal(await store.getUser(id), null, 'identity already deleted (durable commit)');
  assert.equal(await session.wasUserDeleted(id), true, 'deletion receipt written before the revoke step');
  // Every bearer already fails: even the sessions the failed revoke left behind
  // can't authenticate, because the user record is gone (verifySession user check).
  assert.equal(await session.verifySession(caller), null, 'caller bearer already fails (user gone)');
  assert.equal(await session.verifySession(other2), null, 'leftover session cannot authenticate (user gone)');

  const retry = await deleteAccountFlow(caller);
  assert.equal(retry.deleted, true, 'retry converges to deleted:true via the receipt-recovery branch');
  assert.equal(retry.recovered, true, 'recovery used the signed claims + receipt, not a live session');
}

// CR round-6 blocker #3 (response-loss recovery WITHOUT a live bearer). A first
// delete succeeds server-side and revokes the caller's own token, but the response
// is lost. The client retries with the SAME, now-dead token. The receipt-recovery
// branch decodes the token's signed claims, confirms the deletion receipt, and
// returns deleted:true — proving recovery does not depend on keeping an auth bearer.
async function testDeleteReceiptEnablesRevokedTokenRecovery() {
  resetKv();
  const { user } = await store.loginOrCreate(identity('google', 'g-1', 'a@example.com'));
  const id = user.internalId;
  const caller = await session.issueSession(id, 'google');

  const first = await deleteAccountFlow(caller);
  assert.equal(first.deleted, true, 'first delete succeeds');
  assert.equal(await session.verifySession(caller), null, 'caller token is dead after a successful delete');

  const retry = await deleteAccountFlow(caller); // client retries with the dead token
  assert.equal(retry.deleted, true, 'retry converges via the durable deletion receipt');
  assert.equal(retry.recovered, true, 'retry used the receipt-recovery branch (no live bearer)');
}

// CR round-7 blocker #1 (receipt SET failure injection). The tombstone is the
// FIRST write and the single commit point. If that very SET fails, NOTHING has
// been destroyed: the user record is intact and the caller's token is still live.
// The old ordering (delete THEN receipt) could delete the user yet fail the
// receipt, leaving every token a dead 401 with no receipt to converge against —
// unrecoverable. With tombstone-first, the caller simply retries with its still-
// valid token and the delete converges through the normal (non-recovery) path.
async function testDeleteReceiptWriteFailureIsRetryableWithLiveToken() {
  resetKv();
  const { user } = await store.loginOrCreate(identity('google', 'g-1', 'a@example.com'));
  const id = user.internalId;
  const caller = await session.issueSession(id, 'google');

  kvState.failOn = (op, key) => op === 'set' && key === `auth:deleted:${id}`;
  await assert.rejects(deleteAccountFlow(caller), /injected KV failure/);
  kvState.failOn = null;

  // Nothing was committed: user intact, no tombstone, caller token still authenticates.
  assert.ok(await store.getUser(id), 'user record is untouched when the receipt SET fails');
  assert.equal(await session.wasUserDeleted(id), false, 'no tombstone was written');
  assert.equal(await session.verifySession(caller), id, 'caller token is still live and retryable');

  const retry = await deleteAccountFlow(caller); // retry with the STILL-VALID token
  assert.equal(retry.deleted, true, 'retry converges to deleted:true');
  assert.equal(retry.recovered, undefined, 'converged via the normal path, not receipt recovery');
  assert.equal(await store.getUser(id), null, 'user is deleted on the convergent retry');
  assert.equal(await session.verifySession(caller), null, 'caller token dead after the successful retry');
}

// CR round-6 blocker #1 (atomic rebind vs. concurrent logout). If a logout revokes
// the caller's session record first, the rebind's SET XX must NOT resurrect it:
// rebind returns false and the token stays dead. The old GET-then-SET would have
// re-created the revoked record.
async function testRebindLosesToConcurrentLogout() {
  resetKv();
  seedUser('holo_rb_1');
  const caller = await session.issueSession('holo_rb_1', 'apple');
  const jti = decodeJti(caller);

  await session.revokeSession('holo_rb_1', jti); // concurrent logout wins the race
  const rebound = await session.rebindSessionProvider('holo_rb_1', jti, 'google');
  assert.equal(rebound, false, 'rebind cannot resurrect a logged-out session (SET XX)');
  assert.equal(await session.verifySession(caller), null, 'token stays dead after the failed rebind');
}

// CR round-6 blocker #1 (endpoint reports the real outcome). When the caller's
// token is concurrently logged out between deriving ctx and the rebind, the
// endpoint must report callerSessionRevoked:true rather than falsely claiming the
// session survived, so the client drops the dead token.
async function testUnlinkReportsRevokedWhenCallerTokenConcurrentlyLoggedOut() {
  resetKv();
  const { user } = await store.loginOrCreate(identity('google', 'g-1', 'a@example.com'));
  await store.linkIdentity(user.internalId, identity('apple', 'a-1', 'a@icloud.com'));
  const id = user.internalId;
  const appleCaller = await session.issueSession(id, 'apple');

  const ctx = await session.verifySessionContext(appleCaller);
  // Concurrent logout revokes the caller's token after ctx is derived, before rebind.
  await session.revokeSession(id, ctx.jti);

  const updated = await store.unlinkIdentity(ctx.userId, 'apple');
  const remaining = updated.linkedProviders[0].provider;
  const rebound = await session.rebindSessionProvider(ctx.userId, ctx.jti, remaining);
  const callerSessionRevoked = !rebound;
  await session.revokeSessionsByProvider(ctx.userId, 'apple');

  assert.equal(rebound, false, 'atomic rebind fails on the already-revoked record');
  assert.equal(callerSessionRevoked, true, 'endpoint reports callerSessionRevoked:true (no false success)');
  assert.equal(await session.verifySession(appleCaller), null, 'caller token stays dead');
}

// CR round-6 blocker #2 (session minted inside the serialisable boundary). On the
// returning-login path the mint callback runs while the per-user lock is HELD, so a
// concurrent unlink/delete cannot slip in between validating the user and issuing
// its token. On the create path there is no per-user lock — the atomic index claim
// is the serialisation point — so the mint runs only AFTER the index commit.
async function testLoginMintsSessionInsideSerializableBoundary() {
  resetKv();

  // Create path: the index must already point at the new user when we mint.
  let indexAtMint = null;
  const created = await store.loginOrCreate(
    identity('google', 'g-new', 'x@example.com'),
    async (uid) => {
      indexAtMint = kvState.values.get('auth:idx:google:g-new');
      return session.issueSession(uid, 'google');
    },
  );
  assert.equal(created.isNew, true);
  assert.equal(indexAtMint, created.user.internalId, 'create-path mint runs after the index commit');
  assert.equal(await session.verifySession(created.session), created.user.internalId, 'created session verifies');

  // Returning path: the per-user lock must be held when we mint.
  let lockHeldAtMint = null;
  const returning = await store.loginOrCreate(
    identity('google', 'g-new', 'x@example.com'),
    async (uid) => {
      lockHeldAtMint = kvState.values.has(`auth:lock:${uid}`);
      return session.issueSession(uid, 'google');
    },
  );
  assert.equal(returning.isNew, false);
  assert.equal(lockHeldAtMint, true, 'returning-login mints its session while holding the per-user lock');
  assert.equal(await session.verifySession(returning.session), returning.user.internalId, 'returning session verifies');
}

// CR round-6 blocker #2 (login vs. delete). A returning login (minting a session)
// and a delete of the same user race. A minted session must never point at a
// deleted user: because the mint shares the login lock and login re-reads the index
// under it, login either refreshes a live user or falls through to create a fresh
// one — never resurrects the deleted record, and never issues a session for it.
async function testConcurrentLoginAndDeleteNeverMintsSessionForDeletedUser() {
  resetKv();
  const { user } = await store.loginOrCreate(identity('google', 'g-del', 'a@example.com', 'Ann'));
  const id = user.internalId;

  const results = await Promise.allSettled([
    store.loginOrCreate(identity('google', 'g-del', 'a@example.com', 'Ann'), (uid) =>
      session.issueSession(uid, 'google'),
    ),
    store.deleteUser(id),
  ]);

  const login = results[0];
  if (login.status === 'fulfilled' && login.value.session) {
    const resolved = await session.verifySession(login.value.session);
    assert.ok(resolved, 'any minted session must verify against a live user');
    assert.ok(
      kvState.values.has(`auth:user:${resolved}`),
      'a minted session never points at a deleted user',
    );
  }
  // No identity index may dangle to a missing user.
  for (const key of indexKeys()) {
    const owner = kvState.values.get(key);
    assert.ok(kvState.values.has(`auth:user:${owner}`), `index ${key} -> missing user ${owner}`);
  }
}

// CR round-8 blocker #1 (login must never return a newly minted but immediately
// unusable session). A deletion tombstone is committed for the current owner while
// its index/user records still linger (the partial-failure window). A returning
// login for the SAME provider subject — minting a session exactly as handleLogin
// does — must NOT resurrect the tombstoned user or bind a session to it: it re-reads
// the tombstone UNDER the login lock, frees the stale index, and falls through to a
// FRESH user whose minted session verifies immediately.
async function testLoginAfterTombstoneMintsUsableFreshSession() {
  resetKv();
  const { user } = await store.loginOrCreate(identity('google', 'g-tomb', 'a@example.com', 'Ann'));
  const oldId = user.internalId;

  // Tombstone committed, but cascade not yet applied (index + user still present).
  await session.markUserDeleted(oldId);

  const relogin = await store.loginOrCreate(
    identity('google', 'g-tomb', 'a@example.com', 'Ann'),
    (uid) => session.issueSession(uid, 'google'),
  );
  assert.notEqual(relogin.user.internalId, oldId, 'login after tombstone creates a FRESH user, not the deleted one');
  assert.equal(relogin.isNew, true, 'the re-login is a brand-new account');
  const resolved = await session.verifySession(relogin.session);
  assert.equal(resolved, relogin.user.internalId, 'the freshly minted session is immediately usable');
  assert.equal(await session.wasUserDeleted(relogin.user.internalId), false, 'the fresh user carries no tombstone');
}

// CR round-8 blocker #2 (concurrent delete converges truthfully). Two callers of
// the SAME account delete concurrently through the handler flow. Once the tombstone
// commit exists, BOTH must report deleted:true — a second delete that sees the user
// already gone must not return deleted:false and leave that client holding a dead
// session. Both callers' tokens end up revoked.
async function testConcurrentDeleteBothConvergeToDeletedTrue() {
  resetKv();
  const { user } = await store.loginOrCreate(identity('google', 'g-cd', 'a@example.com'));
  const id = user.internalId;
  const caller1 = await session.issueSession(id, 'google');
  const caller2 = await session.issueSession(id, 'google');

  const [r1, r2] = await Promise.all([deleteAccountFlow(caller1), deleteAccountFlow(caller2)]);
  assert.equal(r1.deleted, true, 'first concurrent delete reports deleted:true');
  assert.equal(r2.deleted, true, 'second concurrent delete ALSO converges to deleted:true');

  assert.equal(await store.getUser(id), null, 'user is gone after both deletes');
  assert.equal(await session.wasUserDeleted(id), true, 'deletion tombstone committed');
  assert.equal(await session.verifySession(caller1), null, 'caller1 token revoked');
  assert.equal(await session.verifySession(caller2), null, 'caller2 token revoked');
}

// A one-shot gate: `promise` resolves when `open()` is called. Used to pin one
// coroutine at a precise point so the interleaving is deterministic rather than
// left to the scheduler.
function makeGate() {
  let open;
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

// An N-party barrier: every arriver blocks on the returned promise until the Nth
// arrives, at which point all proceed together. Lets us force multiple flows past
// a shared checkpoint before ANY of them continues.
function makeBarrier(n) {
  let count = 0;
  let releaseAll;
  const all = new Promise((resolve) => {
    releaseAll = resolve;
  });
  return {
    arrive() {
      count += 1;
      if (count >= n) releaseAll();
      return all;
    },
  };
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// CR round-9 blocker #3 (deterministic barrier over the REAL commitAccountDeletion
// vs a returning login). Unlike testLoginAfterTombstoneMintsUsableFreshSession
// (which hand-writes the tombstone and never exercises the lock), this drives the
// actual commitAccountDeletion and pins it INSIDE its critical section — tombstone
// already written under the per-user lock — while a concurrent returning login that
// mints tries to enter. A shared depth counter trips `overlap` if the two critical
// sections are ever simultaneously active, so if the tombstone/cascade were ever
// moved OUT of the lock again the login's mint would run concurrently and fail this
// test. The login must block until the delete releases, then converge to a FRESH,
// immediately-usable account — never a session bound to the doomed user.
async function testCommitDeletionRacingLoginIsMutuallyExclusive() {
  resetKv();
  const { user } = await store.loginOrCreate(identity('google', 'g-r9', 'a@example.com', 'Ann'));
  const oldId = user.internalId;

  let depth = 0;
  let overlap = false;
  const enter = () => {
    depth += 1;
    if (depth > 1) overlap = true;
  };
  const exit = () => {
    depth -= 1;
  };

  const tombstoneWritten = makeGate();
  const letDeleteProceed = makeGate();
  const instrumentedHooks = {
    writeTombstone: async (uid) => {
      enter(); // delete now holds the lock; mark its critical section active
      await session.markUserDeleted(uid); // tombstone written UNDER the lock
      tombstoneWritten.open();
      await letDeleteProceed.promise; // pin the delete inside the held lock
    },
    afterCascade: async (uid) => {
      await session.revokeAllUserSessions(uid);
      exit();
    },
  };

  const deletePromise = store.commitAccountDeletion(oldId, instrumentedHooks);
  await tombstoneWritten.promise; // delete is inside its critical section, holding the lock

  let loginDone = false;
  const loginPromise = store
    .loginOrCreate(identity('google', 'g-r9', 'a@example.com', 'Ann'), (uid) => {
      enter(); // login's mint — must NEVER run while the delete section is active
      const token = session.issueSession(uid, 'google');
      exit();
      return token;
    })
    .then((r) => {
      loginDone = true;
      return r;
    });

  // Give the login several lock-acquire retries to attempt entry. A correct lock
  // keeps it blocked; a lock escape would let it enter now and trip `overlap`.
  await realSleep(5 * 20);
  assert.equal(loginDone, false, 'returning login cannot complete while delete holds the per-user lock');
  assert.equal(overlap, false, 'delete and login critical sections never overlap while the lock is held');

  letDeleteProceed.open();
  const [, relogin] = await Promise.all([deletePromise, loginPromise]);

  assert.equal(overlap, false, 'no critical-section overlap across the entire delete-vs-login race');
  assert.notEqual(relogin.user.internalId, oldId, 'login converges to a FRESH user, not the deleted one');
  assert.equal(relogin.isNew, true, 'the re-login minted a brand-new account');
  assert.equal(
    await session.verifySession(relogin.session),
    relogin.user.internalId,
    'the freshly minted session is immediately usable',
  );
  assert.equal(await store.getUser(oldId), null, 'the doomed user is fully deleted');
  assert.equal(await session.wasUserDeleted(oldId), true, 'tombstone committed for the doomed user');
}

// CR round-9 blocker #3 (both concurrent deletes forced PAST session verification
// BEFORE commit contention). testConcurrentDeleteBothConvergeToDeletedTrue lets the
// scheduler decide whether the second caller still holds a live session or falls
// into the receipt-recovery branch. Here a 2-party barrier guarantees BOTH callers
// complete verifySessionContext (both observe a LIVE session — asserted) before
// EITHER commits. They then contend on the commit lock: one writes the tombstone and
// cascades, the other acquires the lock to find the user already gone. Both must
// still return deleted:true (never deleted:false, which would strand a client on a
// dead session), and both tokens must be revoked.
async function testConcurrentDeletePastVerifyBeforeCommitConverge() {
  resetKv();
  const { user } = await store.loginOrCreate(identity('google', 'g-r9cd', 'a@example.com'));
  const id = user.internalId;
  const caller1 = await session.issueSession(id, 'google');
  const caller2 = await session.issueSession(id, 'google');

  const barrier = makeBarrier(2);
  async function deletePastVerify(callerToken) {
    const ctx = await session.verifySessionContext(callerToken);
    assert.ok(ctx, 'caller must hold a LIVE session at verify time (not the recovery branch)');
    await barrier.arrive(); // block until BOTH callers have verified a live session
    await store.commitAccountDeletion(ctx.userId, deletionHooks);
    return { deleted: true, viaLiveSession: true };
  }

  const [r1, r2] = await Promise.all([deletePastVerify(caller1), deletePastVerify(caller2)]);
  assert.equal(r1.deleted, true, 'first concurrent delete reports deleted:true');
  assert.equal(r2.deleted, true, 'second concurrent delete ALSO converges to deleted:true');
  assert.equal(r1.viaLiveSession && r2.viaLiveSession, true, 'both committed from a live session, post-verify');

  assert.equal(await store.getUser(id), null, 'user is gone after both deletes');
  assert.equal(await session.wasUserDeleted(id), true, 'deletion tombstone committed');
  assert.equal(await session.verifySession(caller1), null, 'caller1 token revoked');
  assert.equal(await session.verifySession(caller2), null, 'caller2 token revoked');
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
    testDeleteRevokesAllSessionsIncludingCaller,
    testVerifySessionRejectsDeletedUser,
    testUnlinkPartialWriteConverges,
    testDeleteDoesNotStompReclaimedIndex,
    testLockLeaseExceedsHandlerBudget,
    testFencedLockIsSharedAndMonotonic,
    testReturningLoginDoesNotResurrectDeletedUser,
    testUnlinkIsIdempotentWhenProviderAbsent,
    testUnlinkRebindsCallerSessionToRemainingProvider,
    testUnlinkResponseLossRetryConverges,
    testUnlinkOtherProviderKeepsCallerSession,
    testUnlinkRetryConvergesAfterRevokeFailure,
    testDeleteRetryConvergesAfterRevokeFailure,
    testDeleteReceiptEnablesRevokedTokenRecovery,
    testDeleteReceiptWriteFailureIsRetryableWithLiveToken,
    testRebindLosesToConcurrentLogout,
    testUnlinkReportsRevokedWhenCallerTokenConcurrentlyLoggedOut,
    testLoginMintsSessionInsideSerializableBoundary,
    testConcurrentLoginAndDeleteNeverMintsSessionForDeletedUser,
    testLoginAfterTombstoneMintsUsableFreshSession,
    testConcurrentDeleteBothConvergeToDeletedTrue,
    testCommitDeletionRacingLoginIsMutuallyExclusive,
    testConcurrentDeletePastVerifyBeforeCommitConverge,
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
