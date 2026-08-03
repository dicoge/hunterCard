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
  beforeSet: null, // async (key, value) => void — awaited before each set (interleave hook)
  beforeDel: null, // async (key) => void — awaited before each del (interleave hook)
  beforeEval: null, // async (script, keys) => void — awaited before each eval (interleave hook)
};

function resetKv() {
  kvState.values.clear();
  kvState.sets.clear();
  kvState.failOn = null;
  kvState.beforeSet = null;
  kvState.beforeDel = null;
  kvState.beforeEval = null;
}

function maybeFail(op, key) {
  if (kvState.failOn && kvState.failOn(op, key)) {
    throw new Error(`injected KV failure: ${op} ${key}`);
  }
}

// A fenced eval passes its value pre-encoded the way real Redis stores it: bare
// strings verbatim, objects as JSON. kv.get would JSON-parse (raw-string
// fallback), so decode the same way to keep the in-memory store's shape identical
// to what a normal kv.set(key, object) would have produced.
function decodeFencedValue(encoded) {
  try {
    return JSON.parse(encoded);
  } catch {
    return encoded;
  }
}

const kv = {
  async get(key) {
    return kvState.values.has(key) ? kvState.values.get(key) : null;
  },
  async set(key, value, opts) {
    if (kvState.beforeSet) await kvState.beforeSet(key, value);
    maybeFail('set', key);
    if (opts && opts.nx && kvState.values.has(key)) return null;
    kvState.values.set(key, value);
    return 'OK';
  },
  async del(key) {
    if (kvState.beforeDel) await kvState.beforeDel(key);
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
    if (kvState.beforeEval) await kvState.beforeEval(script, keys, args);
    // Lease-fenced writes (CR DIC-877): the ownership check, lease renewal and ALL
    // of a logical mutation's writes are ONE atomic op. In this mock the whole
    // handler runs synchronously after the interleave hook, so — exactly like real
    // Redis Lua — nothing else can run between the token check and the writes. A
    // stale holder (KEYS[1] no longer holds ARGV[1]) gets 'LOCK_LOST' and performs
    // NONE of the writes. Scripts are tagged with a leading `-- <OP>` comment (a
    // no-op in Lua) so we dispatch each one unambiguously. maybeFail is invoked per
    // underlying write so the existing failOn(op, key) injections still fire.
    if (script.includes("return 'LOCK_LOST'")) {
      if (kvState.values.get(keys[0]) !== args[0]) return 'LOCK_LOST';
      // PEXPIRE lease renewal is a no-op in this TTL-less mock.
      const setValue = (key, encoded) => kvState.values.set(key, decodeFencedValue(encoded));
      const sremMember = (key, m) => {
        const set = kvState.sets.get(key);
        if (set) {
          set.delete(m);
          if (set.size === 0) kvState.sets.delete(key);
        }
      };
      if (script.includes('-- PUBLISH')) {
        // Fenced first-writer index publish. KEYS=[lock, idx]; ARGV=[token, owner].
        const idxKey = keys[1];
        maybeFail('set', idxKey);
        if (kvState.values.has(idxKey)) return 'EXISTS';
        setValue(idxKey, args[1]);
        return 'OK';
      }
      if (script.includes('-- SET')) {
        // Fenced unconditional SET (pending->committed flip). KEYS=[lock, detail].
        maybeFail('set', keys[1]);
        setValue(keys[1], args[1]);
        return 'OK';
      }
      if (script.includes('-- SADD')) {
        // Fenced membership add. KEYS=[lock, identities]; ARGV=[token, ttl, member].
        const identitiesKey = keys[1];
        maybeFail('sadd', identitiesKey);
        const set = kvState.sets.get(identitiesKey) ?? new Set();
        set.add(args[2]);
        kvState.sets.set(identitiesKey, set);
        return 'OK';
      }
      if (script.includes('-- ROLLBACK')) {
        // Owner-fenced index release + detail delete + membership removal.
        // KEYS=[lock, idx, detail, identities]; ARGV=[token, ttl, idxOwner, member].
        const [, idxKey, detailKey, identitiesKey] = keys;
        const [, , idxOwner, memberArg] = args;
        maybeFail('del', idxKey);
        if (kvState.values.get(idxKey) === idxOwner) kvState.values.delete(idxKey);
        maybeFail('del', detailKey);
        kvState.values.delete(detailKey);
        maybeFail('srem', identitiesKey);
        sremMember(identitiesKey, memberArg);
        return 'OK';
      }
      if (script.includes('-- UNLINK')) {
        // Owner-fenced index release + detail delete + membership removal + user set.
        // KEYS=[lock, idx, detail, identities, user]; ARGV=[token, ttl, idxOwner, member, userJson].
        const [, idxKey, detailKey, identitiesKey, userKey] = keys;
        const [, , idxOwner, memberArg, userVal] = args;
        maybeFail('del', idxKey);
        if (kvState.values.get(idxKey) === idxOwner) kvState.values.delete(idxKey);
        maybeFail('del', detailKey);
        kvState.values.delete(detailKey);
        maybeFail('srem', identitiesKey);
        sremMember(identitiesKey, memberArg);
        maybeFail('set', userKey);
        setValue(userKey, userVal);
        return 'OK';
      }
      if (script.includes('-- DELUSER')) {
        // Per-identity owner-fenced index release + detail delete, then identities
        // set + user record. KEYS=[lock, idx1, detail1, ..., identities, user];
        // ARGV=[token, ttl, n, owner1, ...].
        const n = Number(args[2]);
        for (let i = 0; i < n; i++) {
          const idxKey = keys[1 + i * 2];
          const detailKey = keys[2 + i * 2];
          const owner = args[3 + i];
          maybeFail('del', idxKey);
          if (kvState.values.get(idxKey) === owner) kvState.values.delete(idxKey);
          maybeFail('del', detailKey);
          kvState.values.delete(detailKey);
        }
        const identitiesKey = keys[1 + n * 2];
        const userKey = keys[2 + n * 2];
        maybeFail('del', identitiesKey);
        kvState.values.delete(identitiesKey);
        kvState.sets.delete(identitiesKey);
        maybeFail('del', userKey);
        kvState.values.delete(userKey);
        return 'OK';
      }
      throw new Error(`Unexpected fenced eval script: ${script}`);
    }
    // Atomic compare-and-delete (KEYS[1] is deleted only while its value still
    // equals ARGV[1]). Used for lock release and dangling-index reclamation alike.
    if (script.includes("redis.call('DEL', KEYS[1])")) {
      const [targetKey] = keys;
      const [expected] = args;
      if (kvState.values.get(targetKey) === expected) {
        kvState.values.delete(targetKey);
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

compileTs('api/_lib/identity-store.ts');
const store = require(path.join(outDir, 'api/_lib/identity-store.js'));

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

async function testConcurrentFirstLoginCreatesSingleUser() {
  resetKv();
  const id = () => identity('google', 'race-sub', 'a@example.com', 'Ann');

  // Deterministically drive the create race: hold the FIRST internal-user record
  // write so a second concurrent first-login has a window to (in the buggy code)
  // reclaim the freshly-claimed index and mint a duplicate user. The fix takes a
  // per-identity lock and claims the index only AFTER the user exists, so any
  // interleaving must still resolve to exactly one internal user.
  let held = false;
  kvState.beforeSet = async (key) => {
    if (!held && /^auth:user:holo_[0-9a-f]+$/.test(key)) {
      held = true;
      await new Promise((r) => setTimeout(r, 60));
    }
  };

  const results = await Promise.all([store.loginOrCreate(id()), store.loginOrCreate(id())]);
  kvState.beforeSet = null;

  const ids = new Set(results.map((r) => r.user.internalId));
  assert.equal(ids.size, 1, 'both concurrent first-logins resolve to one internal user');
  assert.equal(results.filter((r) => r.isNew).length, 1, 'exactly one create, one returning login');

  const userKeys = [...kvState.values.keys()].filter((k) => /^auth:user:holo_[0-9a-f]+$/.test(k));
  assert.equal(userKeys.length, 1, 'exactly one internal user record persisted (no duplicate)');
}

async function testFailedLinkDoesNotGrantFutureLogin() {
  resetKv();
  const apple = (await store.loginOrCreate(identity('apple', 'a-1', 'a@icloud.com'))).user;

  // Fail the membership write midway through linking Google: the link must throw
  // AND leave no index claim behind, or a later Google login would silently enter
  // this account despite the 500 (CR DIC-866: partial link fail-open).
  kvState.failOn = (op, key) => op === 'sadd' && key === `auth:user:${apple.internalId}:identities`;
  await assert.rejects(
    store.linkIdentity(apple.internalId, identity('google', 'g-1', 'a@example.com')),
    /injected KV failure/,
    'a failed link must throw',
  );
  kvState.failOn = null;

  // The compensated claim is gone: logging in with that Google identity now
  // creates a fresh, separate user rather than resolving into the linker.
  const fresh = await store.loginOrCreate(identity('google', 'g-1', 'a@example.com'));
  assert.equal(fresh.isNew, true, 'failed link left no claim, so Google login creates a new user');
  assert.notEqual(
    fresh.user.internalId,
    apple.internalId,
    'a failed link must never grant future login into the linker account',
  );
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

async function testStaleCreatorCannotOverwriteElectedWinner() {
  resetKv();
  const id = () => identity('google', 'lease-sub', 'a@example.com', 'Ann');

  // Reproduce the create-lock lease-expiry attack (CR DIC-866 #1): park one
  // creator right before it publishes the identity index — the exact point a
  // fixed 5s lease would have expired — and force any create lock to "expire"
  // (delete it) so a lock-based implementation would let a second creator
  // through. The second creator fully commits and publishes first. The parked
  // (stale) creator must then be UNABLE to publish a duplicate or overwrite the
  // winner: the index is claimed with an atomic first-writer-wins SET NX, not an
  // unconditional set. On the pre-fix lease code both creators reach the
  // unconditional `kv.set(IDX,…)` and the stale one overwrites → two users.
  let parked = false;
  kvState.beforeSet = async (key) => {
    if (!parked && key.startsWith('auth:idx:')) {
      parked = true;
      kvState.values.delete('auth:idxlock:google:lease-sub'); // simulate lease expiry
      await new Promise((r) => setTimeout(r, 80));
    }
  };

  const results = await Promise.all([store.loginOrCreate(id()), store.loginOrCreate(id())]);
  kvState.beforeSet = null;

  const created = results.filter((r) => r.isNew);
  assert.equal(created.length, 1, 'exactly one create, one adopt (no duplicate mint)');
  const winnerId = created[0].user.internalId;

  const ids = new Set(results.map((r) => r.user.internalId));
  assert.equal(ids.size, 1, 'both logins resolve to a single internal user');
  assert.equal([...ids][0], winnerId, 'the parked creator adopts the elected winner');

  assert.equal(
    kvState.values.get('auth:idx:google:lease-sub'),
    winnerId,
    'index still points at the elected winner — a stale write neither published nor overwrote',
  );
  const userKeys = [...kvState.values.keys()].filter((k) => /^auth:user:holo_[0-9a-f]+$/.test(k));
  assert.deepEqual(userKeys, [`auth:user:${winnerId}`], 'exactly the winner user persists');
}

async function testLinkCrashBeforeCommitGrantsNoLogin() {
  resetKv();
  const apple = (await store.loginOrCreate(identity('apple', 'a-2', 'a@icloud.com'))).user;

  // Fail the membership commit AND make every compensating cleanup write fail
  // too (the crash/rollback-failure case). Because the fix publishes the
  // login-granting index only AFTER membership is committed, an interrupted link
  // leaves NO index no matter how cleanup fares — so a later login refuses to
  // enter the linker (CR DIC-866 #2). The pre-fix code published the index
  // FIRST; with rollback failing, that index survived and a later login silently
  // entered this account, which is exactly what this asserts against.
  kvState.failOn = (op, key) =>
    (op === 'sadd' && key === `auth:user:${apple.internalId}:identities`) ||
    (op === 'del' && key === 'auth:idx:google:g-2') ||
    op === 'srem' ||
    (op === 'del' && key.startsWith('auth:idetail:'));
  await assert.rejects(
    store.linkIdentity(apple.internalId, identity('google', 'g-2', 'a@example.com')),
    /injected KV failure/,
    'an interrupted link must throw',
  );
  kvState.failOn = null;

  assert.notEqual(
    kvState.values.get('auth:idx:google:g-2'),
    apple.internalId,
    'no surviving index may grant login into the linker after a failed link',
  );
  const fresh = await store.loginOrCreate(identity('google', 'g-2', 'a@example.com'));
  assert.equal(fresh.isNew, true, 'interrupted link grants no login into the linker');
  assert.notEqual(fresh.user.internalId, apple.internalId, 'must never resolve into the linker account');
}

async function testDisabledUserNotRestorable() {
  resetKv();
  const { user } = await store.loginOrCreate(identity('google', 'dis-1', 'a@example.com'));
  const stored = kvState.values.get(`auth:user:${user.internalId}`);

  // A deactivated account must not be restorable via /auth/me (getUser): the
  // restore path must fail closed rather than hand the account back (CR DIC-866 #3).
  kvState.values.set(`auth:user:${user.internalId}`, { ...stored, status: 'disabled' });
  await expectError(store.getUser(user.internalId), 'ACCOUNT_DISABLED');

  kvState.values.set(`auth:user:${user.internalId}`, { ...stored, status: 'pending_deletion' });
  await expectError(store.getUser(user.internalId), 'ACCOUNT_DISABLED');
}

async function testRolePreservedNotDowngraded() {
  resetKv();
  const { user } = await store.loginOrCreate(identity('google', 'sub-role', 'a@example.com', 'Ann'));
  assert.equal(user.role, 'free_user', 'new users start as free_user');

  // Promote to subscriber in the store of record, then prove neither a returning
  // login nor a session restore downgrades the server-authoritative role
  // (CR DIC-866 #4: role discarded → subscribers silently downgraded).
  const stored = kvState.values.get(`auth:user:${user.internalId}`);
  kvState.values.set(`auth:user:${user.internalId}`, { ...stored, role: 'subscriber' });

  const relogin = await store.loginOrCreate(identity('google', 'sub-role', 'a@example.com', 'Ann'));
  assert.equal(relogin.user.role, 'subscriber', 'returning login preserves subscriber role');

  const restored = await store.getUser(user.internalId);
  assert.equal(restored.role, 'subscriber', 'session restore preserves subscriber role');
}

async function testDanglingIndexReclamationElectsSingleWinner() {
  resetKv();
  const id = () => identity('google', 'dang-sub', 'a@example.com', 'Ann');
  // Seed a DANGLING index: it points at a user record that no longer exists (an
  // earlier owner deleted out from under it). Two fresh logins now both lose the
  // first SET NX to this dangling index and race to reclaim it.
  kvState.values.set('auth:idx:google:dang-sub', 'holo_deadbeef');

  // Force the exact stale-delete interleaving: park creator A's reclaim in the
  // get→delete window while holding the STALE owner (holo_deadbeef). While A is
  // suspended, creator B reclaims the dangling index and publishes its own live
  // candidate. When A resumes, a naive UNCONDITIONAL delete would wipe B's live
  // index and let A publish a duplicate — an identity split. The fix reclaims
  // with an atomic compare-and-delete against the observed stale owner, so A's
  // delete is a no-op and exactly one internal user stays canonical. The park
  // covers both the pre-fix path (kv.del) and the fixed path (compare-and-delete
  // eval) so this test is a genuine regression against the old code.
  let parkedReclaim = false;
  const parkOnce = async () => {
    if (!parkedReclaim) {
      parkedReclaim = true;
      await new Promise((r) => setTimeout(r, 80));
    }
  };
  kvState.beforeDel = async (key) => {
    if (key === 'auth:idx:google:dang-sub') await parkOnce();
  };
  kvState.beforeEval = async (script, keys) => {
    if (script.includes("redis.call('DEL', KEYS[1])") && keys[0] === 'auth:idx:google:dang-sub') {
      await parkOnce();
    }
  };

  const results = await Promise.all([store.loginOrCreate(id()), store.loginOrCreate(id())]);
  kvState.beforeDel = null;
  kvState.beforeEval = null;

  const ids = new Set(results.map((r) => r.user.internalId));
  assert.equal(ids.size, 1, 'both creators resolve to exactly one internal user (no split)');
  assert.equal(results.filter((r) => r.isNew).length, 1, 'exactly one create, one adopt');
  const winnerId = [...ids][0];
  assert.equal(
    kvState.values.get('auth:idx:google:dang-sub'),
    winnerId,
    'index still points at the single canonical winner — no stale delete clobbered it',
  );
  const userKeys = [...kvState.values.keys()].filter((k) => /^auth:user:holo_[0-9a-f]+$/.test(k));
  assert.deepEqual(userKeys, [`auth:user:${winnerId}`], 'exactly one internal user persists');
}

async function testGhostLinkAfterCrashIsHiddenRepairedAndNotSplit() {
  resetKv();
  const apple = (await store.loginOrCreate(identity('apple', 'a-3', 'a@icloud.com', 'Kim'))).user;

  // Crash the link EXACTLY after membership+detail are committed and BEFORE the
  // index is published: fail the index SET and every compensating cleanup write,
  // so the membership+detail survive with NO index — the ghost-link state.
  kvState.failOn = (op, key) =>
    (op === 'set' && key === 'auth:idx:google:g-3') ||
    op === 'srem' ||
    (op === 'del' && key.startsWith('auth:idetail:'));
  await assert.rejects(
    store.linkIdentity(apple.internalId, identity('google', 'g-3', 'g@example.com', 'Kim')),
    /injected KV failure/,
    'a crash before index publish must throw',
  );
  kvState.failOn = null;

  // 1) No ghost exposure: the pending, index-less membership must NOT surface
  //    through getUser/hydrate (pre-fix it would report google as linked).
  const afterCrash = await store.getUser(apple.internalId);
  assert.equal(afterCrash.linkedProviders.length, 1, 'ghost pending link is hidden from hydrate');
  assert.equal(afterCrash.linkedProviders[0].provider, 'apple');
  assert.equal(
    kvState.values.get('auth:idx:google:g-3'),
    undefined,
    'the crash published no index',
  );

  // 2) Retry must REPAIR/finish the link, not short-circuit as alreadyLinked
  //    (pre-fix the surviving membership made retry return alreadyLinked forever,
  //    so the index was never published).
  const retry = await store.linkIdentity(
    apple.internalId,
    identity('google', 'g-3', 'g@example.com', 'Kim'),
  );
  assert.equal(retry.alreadyLinked, false, 'retry finishes the pending link, not a premature alreadyLinked');
  assert.equal(retry.user.linkedProviders.length, 2, 'both providers are now committed and visible');
  assert.equal(
    kvState.values.get('auth:idx:google:g-3'),
    apple.internalId,
    'retry published the index to the linker',
  );

  // 3) No identity split: a fresh Google login now resolves INTO the linker,
  //    never a separate new user.
  const login = await store.loginOrCreate(identity('google', 'g-3', 'g@example.com', 'Kim'));
  assert.equal(login.isNew, false, 'google login resolves into the repaired account');
  assert.equal(login.user.internalId, apple.internalId, 'no identity split — same internal user');
}

async function testFailedFinalLinkCommitFailsClosedAndRepairs() {
  resetKv();
  const apple = (await store.loginOrCreate(identity('apple', 'a-4', 'a@icloud.com', 'Kim'))).user;

  // Inject ONLY the final pending->committed flip failure: the link publishes the
  // login-granting index, then throws while flipping the google detail to
  // committed. Pre-fix the index survived live AND a later google login followed
  // it while refreshSnapshot cleared pending — granting access despite the failed
  // link response (CR DIC-874 #1: final-link-commit failure grants login).
  const detailKey = `auth:idetail:${apple.internalId}:google:g-4`;
  // The commit flip is now a lease-fenced eval (atomic ownership-check + write),
  // so inject its failure on the eval path: the fenced SET (no NX) targeting the
  // google detail with pending:false in its encoded value.
  kvState.beforeEval = async (script, keys, args) => {
    if (
      script.includes("return 'LOCK_LOST'") &&
      !script.includes("'NX'") &&
      keys[1] === detailKey &&
      String(args[1]).includes('"pending":false')
    ) {
      throw new Error('injected KV failure: pending->committed flip');
    }
  };
  await assert.rejects(
    store.linkIdentity(apple.internalId, identity('google', 'g-4', 'g@example.com', 'Kim')),
    /injected KV failure/,
    'the final commit failure must throw (no false link success)',
  );
  kvState.beforeEval = null;

  // The index was published, but the link is NOT committed (detail still pending).
  assert.equal(kvState.values.get('auth:idx:google:g-4'), apple.internalId, 'index was published');
  assert.equal(kvState.values.get(detailKey).pending, true, 'the google detail is still pending');

  // 1) Provider login FAILS CLOSED: it must neither grant access via the live
  //    index nor auto-commit the pending detail.
  await expectError(
    store.loginOrCreate(identity('google', 'g-4', 'g@example.com', 'Kim')),
    'IDENTITY_LINK_PENDING',
  );
  assert.equal(
    kvState.values.get(detailKey).pending,
    true,
    'a failed-closed login must not auto-commit the pending link',
  );
  const usersAfterLogin = [...kvState.values.keys()].filter((k) => /^auth:user:holo_[0-9a-f]+$/.test(k));
  assert.deepEqual(
    usersAfterLogin,
    [`auth:user:${apple.internalId}`],
    'the failed-closed login minted no split user',
  );

  // getUser/hydrate still hides the ghost: google is NOT reported as linked.
  const afterFail = await store.getUser(apple.internalId);
  assert.equal(afterFail.linkedProviders.length, 1, 'pending link stays hidden from hydrate');
  assert.equal(afterFail.linkedProviders[0].provider, 'apple');

  // 2) Retry REPAIRS safely — the link finishes and commits, no split.
  const retry = await store.linkIdentity(apple.internalId, identity('google', 'g-4', 'g@example.com', 'Kim'));
  assert.equal(retry.alreadyLinked, false, 'retry finishes the pending link, not premature alreadyLinked');
  assert.equal(retry.user.linkedProviders.length, 2, 'both providers committed after repair');
  assert.equal(kvState.values.get(detailKey).pending, false, 'the google detail is now committed');

  const login = await store.loginOrCreate(identity('google', 'g-4', 'g@example.com', 'Kim'));
  assert.equal(login.isNew, false, 'google login now resolves into the repaired account');
  assert.equal(login.user.internalId, apple.internalId, 'no identity split after repair');
  const usersFinal = [...kvState.values.keys()].filter((k) => /^auth:user:holo_[0-9a-f]+$/.test(k));
  assert.deepEqual(usersFinal, [`auth:user:${apple.internalId}`], 'exactly one internal user throughout');
}

// Forge account A's stale/pending ghost for a (provider, subject) whose LIVE
// index belongs to another account: a membership + pending detail on A, but no
// index of A's own. This is the exact state a crashed/failed link leaves behind.
function forgeGhostMembership(userId, provider, subject) {
  const setKey = `auth:user:${userId}:identities`;
  const set = kvState.sets.get(setKey) ?? new Set();
  set.add(`${provider}:${subject}`);
  kvState.sets.set(setKey, set);
  kvState.values.set(`auth:idetail:${userId}:${provider}:${subject}`, {
    provider,
    subject,
    email: 'ghost@example.com',
    linkedAt: new Date().toISOString(),
    pending: true,
  });
}

async function testDeleteDoesNotWipeAnotherAccountsLiveIndex() {
  resetKv();
  // B legitimately owns the google identity (committed, live index -> B).
  const b = (await store.loginOrCreate(identity('google', 'shared', 'b@example.com', 'Bee'))).user;
  // A is a separate account that carries a stale ghost membership for the SAME
  // google identity while the live index points at B, not A.
  const a = (await store.loginOrCreate(identity('apple', 'a-owner', 'a@icloud.com', 'Ann'))).user;
  forgeGhostMembership(a.internalId, 'google', 'shared');
  assert.equal(kvState.values.get('auth:idx:google:shared'), b.internalId, 'B owns the live google index');

  // Deleting A must NOT delete B's live google index: cleanup is owner-fenced with
  // compare-and-delete, so A's ghost delete is a no-op (CR DIC-874 #2). Pre-fix an
  // unconditional kv.del wiped B's index and split B's login.
  await store.deleteUser(a.internalId);
  assert.equal(kvState.values.get('auth:idx:google:shared'), b.internalId, "delete A left B's index intact");

  const bLogin = await store.loginOrCreate(identity('google', 'shared', 'b@example.com', 'Bee'));
  assert.equal(bLogin.isNew, false, "B's returning login stays stable");
  assert.equal(bLogin.user.internalId, b.internalId, 'no identity split for B');
  const users = [...kvState.values.keys()].filter((k) => /^auth:user:holo_[0-9a-f]+$/.test(k));
  assert.deepEqual(users, [`auth:user:${b.internalId}`], 'only B remains; delete minted no extra user');
}

async function testUnlinkDoesNotWipeAnotherAccountsLiveIndex() {
  resetKv();
  const b = (await store.loginOrCreate(identity('google', 'shared', 'b@example.com', 'Bee'))).user;
  const a = (await store.loginOrCreate(identity('apple', 'a-owner', 'a@icloud.com', 'Ann'))).user;
  forgeGhostMembership(a.internalId, 'google', 'shared');
  assert.equal(kvState.values.get('auth:idx:google:shared'), b.internalId, 'B owns the live google index');

  // Unlinking google from A (a ghost it does not truly own) must leave B's live
  // index untouched (owner-fenced compare-and-delete). A keeps its apple method.
  const afterUnlink = await store.unlinkIdentity(a.internalId, 'google');
  assert.equal(afterUnlink.linkedProviders.length, 1, 'A keeps exactly its real apple method');
  assert.equal(afterUnlink.linkedProviders[0].provider, 'apple');
  assert.equal(kvState.values.get('auth:idx:google:shared'), b.internalId, "unlink A left B's index intact");

  const bLogin = await store.loginOrCreate(identity('google', 'shared', 'b@example.com', 'Bee'));
  assert.equal(bLogin.isNew, false, "B's returning login stays stable");
  assert.equal(bLogin.user.internalId, b.internalId, 'no identity split for B');
  const users = [...kvState.values.keys()].filter((k) => /^auth:user:holo_[0-9a-f]+$/.test(k));
  assert.deepEqual(
    users.sort(),
    [`auth:user:${a.internalId}`, `auth:user:${b.internalId}`].sort(),
    'both accounts remain; unlink minted no extra user',
  );
}

async function testUnlinkLastCommittedMethodIgnoresPendingGhost() {
  resetKv();
  // One COMMITTED apple login method plus a forged PENDING google ghost (a
  // crashed link: membership + pending detail, but no google index of its own).
  // The last-method invariant must count only the committed apple method, so the
  // raw two-member set must NOT be read as "two login methods". Pre-fix
  // (members.length <= 1) the ghost inflated the count and let apple — the only
  // real login method — be unlinked, stranding the account with zero usable
  // methods (CR DIC-875 #1).
  const apple = (await store.loginOrCreate(identity('apple', 'a-875', 'a@icloud.com', 'Kim'))).user;
  forgeGhostMembership(apple.internalId, 'google', 'g-ghost-875');
  assert.equal(
    kvState.values.get('auth:idx:google:g-ghost-875'),
    undefined,
    'the pending google ghost owns no index',
  );

  await expectError(store.unlinkIdentity(apple.internalId, 'apple'), 'CANNOT_UNLINK_LAST_METHOD');

  // Apple remains fully usable: its index and committed detail are untouched, and
  // a returning apple login still resolves into the same account.
  assert.equal(
    kvState.values.get('auth:idx:apple:a-875'),
    apple.internalId,
    "apple's index survives the refused unlink",
  );
  const afterRefuse = await store.getUser(apple.internalId);
  assert.equal(afterRefuse.linkedProviders.length, 1, 'apple stays linked; ghost stays hidden');
  assert.equal(afterRefuse.linkedProviders[0].provider, 'apple');
  const relogin = await store.loginOrCreate(identity('apple', 'a-875', 'a@icloud.com', 'Kim'));
  assert.equal(relogin.isNew, false, 'apple login still resolves into the account');
  assert.equal(relogin.user.internalId, apple.internalId, 'apple is still a working login method');
}

async function testReplacePendingSiblingReleasesOldProviderIndex() {
  resetKv();
  const apple = (await store.loginOrCreate(identity('apple', 'a-876', 'a@icloud.com', 'Kim'))).user;

  // Forge a PENDING google sibling for subject g-old that DID publish its index to
  // this account before crashing (membership + pending detail + a live index -> us).
  // This is the "failed pending link" state that a fresh link with a DIFFERENT
  // google subject must clean up.
  forgeGhostMembership(apple.internalId, 'google', 'g-old');
  kvState.values.set('auth:idx:google:g-old', apple.internalId);
  assert.equal(kvState.values.get('auth:idx:google:g-old'), apple.internalId, 'stale google index -> us');

  // Link a DIFFERENT google subject. The pending-sibling cleanup must atomically
  // compare-and-delete the old google index (g-old) while it still names us,
  // BEFORE removing its detail/membership, so g-old is fully released.
  const linked = await store.linkIdentity(apple.internalId, identity('google', 'g-new', 'g@example.com', 'Kim'));
  assert.equal(linked.alreadyLinked, false, 'the new google subject links freshly');
  assert.equal(linked.user.linkedProviders.length, 2, 'apple + the new google subject are linked');
  const googleLinked = linked.user.linkedProviders.find((p) => p.provider === 'google');
  assert.equal(googleLinked.providerId, 'g-new', 'the new google subject is the live one');

  // The old index is gone (released), not left dangling at us.
  assert.equal(
    kvState.values.get('auth:idx:google:g-old'),
    undefined,
    'the old provider index was released, not leaked at the account',
  );
  // The new subject is usable: a returning google login resolves INTO this account.
  const newLogin = await store.loginOrCreate(identity('google', 'g-new', 'g@example.com', 'Kim'));
  assert.equal(newLogin.isNew, false, 'the new google subject logs into the account');
  assert.equal(newLogin.user.internalId, apple.internalId, 'no split for the new subject');

  // The released old subject is now claimable by a SEPARATE fresh account — proof
  // the leaked index no longer locks it (and no owner/split regression).
  const oldReclaim = await store.loginOrCreate(identity('google', 'g-old', 'other@example.com', 'Oz'));
  assert.equal(oldReclaim.isNew, true, 'the released old subject is claimable by a new user');
  assert.notEqual(oldReclaim.user.internalId, apple.internalId, 'old subject no longer resolves into the linker');
}

async function testStaleLinkHolderCannotCommitPastLeaseExpiry() {
  resetKv();
  // One committed apple login method. Two DIFFERENT google subjects then race to
  // link onto this same user. The per-user lock serialises them — UNLESS the first
  // holder's lease expires mid-request (the Vercel-function-timeout attack from
  // CR DIC-877). We reproduce exactly that: park the first link at its index
  // PUBLICATION point (its first ownership fence), expire its lease so a second
  // link can take the lock and fully commit its own google identity, then resume
  // the first. The first is now a STALE holder: its fence must fail, so it can
  // neither publish nor commit — exactly one google may win, and the loser must
  // strand no state and grant no login. On the pre-fix 5s-lock code the parked
  // holder would resume and publish/commit a SECOND google identity onto the user.
  const apple = (await store.loginOrCreate(identity('apple', 'a-lease', 'a@icloud.com', 'Kim'))).user;
  const lockKey = `auth:lock:${apple.internalId}`;

  let parked = false;
  kvState.beforeEval = async (script, keys) => {
    // Fire once, at the FIRST holder's first ownership fence (its publish point):
    if (script.includes("redis.call('PEXPIRE'") && keys[0] === lockKey && !parked) {
      parked = true;
      // Simulate the lease lapsing under a long function: drop the lock so the
      // second link can acquire it while the first is suspended here.
      kvState.values.delete(lockKey);
      // The second link runs to full completion under its own (valid) lease.
      await store.linkIdentity(
        apple.internalId,
        identity('google', 'g-second', 'second@example.com', 'Bee'),
      );
    }
  };

  // The first link resumes into its fence, discovers its lease is gone, and aborts.
  await expectError(
    store.linkIdentity(apple.internalId, identity('google', 'g-first', 'first@example.com', 'Ann')),
    'LOCK_TIMEOUT',
  );
  kvState.beforeEval = null;

  // Exactly one google committed — the second holder — alongside apple.
  const after = await store.getUser(apple.internalId);
  const googles = after.linkedProviders.filter((p) => p.provider === 'google');
  assert.equal(googles.length, 1, 'exactly one google identity committed (no stale double-link)');
  assert.equal(googles[0].providerId, 'g-second', 'the valid-lease holder is the one that committed');
  assert.equal(after.linkedProviders.length, 2, 'apple + exactly one google');

  // The winning index points at the user; the loser published no index.
  assert.equal(kvState.values.get('auth:idx:google:g-second'), apple.internalId, 'winner index -> user');
  assert.equal(
    kvState.values.get('auth:idx:google:g-first'),
    undefined,
    'the stale holder published no index',
  );

  // The loser stranded no state: no leftover membership or detail for g-first.
  assert.equal(
    kvState.values.get(`auth:idetail:${apple.internalId}:google:g-first`),
    undefined,
    'the stale holder left no detail behind',
  );
  const members = kvState.sets.get(`auth:user:${apple.internalId}:identities`);
  assert.ok(!members.has('google:g-first'), 'the stale holder left no membership behind');

  // The loser subject is NOT login-capable into this account: a fresh login with
  // g-first mints a separate new user rather than resolving into the linker.
  const loserLogin = await store.loginOrCreate(identity('google', 'g-first', 'first@example.com', 'Ann'));
  assert.equal(loserLogin.isNew, true, 'the stale-linked subject grants no login into the account');
  assert.notEqual(loserLogin.user.internalId, apple.internalId, 'no login into the linker for the loser');
}

async function testStaleHolderCannotFlipCommitAfterLeaseReplaced() {
  resetKv();
  // Codex CR DIC-877 atomic-boundary case. The prior test parks at the PUBLISH
  // fence and DELETES the lock (lease absent). This one hits the DIFFERENT commit
  // write and REPLACES the lock token (another holder acquired the lease after
  // ours lapsed — a mismatch, not mere absence), at the exact instant the stale
  // holder's pending->committed flip is about to run. Because the ownership check
  // and the SET are fused into ONE Redis eval, a token that no longer occupies the
  // lock makes the flip perform NO write and throw: there is no check-then-write
  // window (the gap Codex flagged) for the stale holder to slip a commit through.
  // On check-then-write code the holder would pass a separate fence and then flip
  // the detail to committed, granting login on a lease it no longer holds.
  const apple = (await store.loginOrCreate(identity('apple', 'a-flip', 'a@icloud.com', 'Kim'))).user;
  const lockKey = `auth:lock:${apple.internalId}`;
  const detailKey = `auth:idetail:${apple.internalId}:google:g-flip`;
  const idxKey = 'auth:idx:google:g-flip';

  let replaced = false;
  kvState.beforeEval = async (script, keys, args) => {
    // Fire once, at the first holder's COMMIT flip: the fenced SET (no NX) writing
    // the google detail with pending:false. The index is already published by this
    // point, so this is strictly the commit boundary, after the publish succeeded.
    if (
      !replaced &&
      script.includes("return 'LOCK_LOST'") &&
      !script.includes("'NX'") &&
      keys[1] === detailKey &&
      String(args[1]).includes('"pending":false')
    ) {
      replaced = true;
      // Another holder acquired the lease after ours lapsed: overwrite the lock
      // with a DIFFERENT token. Our token no longer occupies the lock, so the very
      // next atomic eval — this same commit flip — must refuse and write nothing.
      kvState.values.set(lockKey, 'someone-elses-token');
    }
  };

  await expectError(
    store.linkIdentity(apple.internalId, identity('google', 'g-flip', 'flip@example.com', 'Ann')),
    'LOCK_TIMEOUT',
  );
  kvState.beforeEval = null;

  // The published index survives (published before the commit boundary), but the
  // flip wrote nothing: the detail is still PENDING — a repairable ghost, never a
  // live link.
  assert.equal(kvState.values.get(idxKey), apple.internalId, 'index was published pre-commit');
  const detail = kvState.values.get(detailKey);
  assert.ok(detail && detail.pending === true, 'commit flip performed no write — detail stays pending');

  // The pending ghost is hidden from hydrate: no committed google method appears.
  const after = await store.getUser(apple.internalId);
  const googles = after.linkedProviders.filter((p) => p.provider === 'google');
  assert.equal(googles.length, 0, 'the un-committed link is not a live method');

  // ...and it fails CLOSED on login: a fresh g-flip login neither resolves into the
  // account nor mints a duplicate — it throws IDENTITY_LINK_PENDING, so the stale
  // holder's abandoned flip grants no access and strands no login-capable state.
  await expectError(
    store.loginOrCreate(identity('google', 'g-flip', 'flip@example.com', 'Ann')),
    'IDENTITY_LINK_PENDING',
  );
}

async function testStaleUnlinkHolderCannotWipeRepublishedIdentity() {
  resetKv();
  // Codex CR DIC-877 CR9, the concrete unlink race. A user with two committed
  // login methods (apple + google) unlinks google. On the pre-CR9 code the index
  // release was fenced but the detail/membership/user writes that follow were NOT:
  // a holder could release google's index, then — after its lease lapsed and a new
  // holder repaired/republished the same identity — resume and delete the detail +
  // membership and overwrite the user snapshot, STRANDING a live google index that
  // no detail or membership backs. We reproduce the stale holder by replacing the
  // lock token at the instant its unlink write-set is about to run. Because the
  // ENTIRE write-set is now one atomic fenced eval, a token that no longer occupies
  // the lock makes it write NOTHING: index, detail, membership and user all survive.
  const apple = (await store.loginOrCreate(identity('apple', 'a-un', 'a@icloud.com', 'Kim'))).user;
  await store.linkIdentity(apple.internalId, identity('google', 'g-un', 'g@example.com', 'Ann'));
  const lockKey = `auth:lock:${apple.internalId}`;
  const idxKey = 'auth:idx:google:g-un';
  const detailKey = `auth:idetail:${apple.internalId}:google:g-un`;
  const identitiesKey = `auth:user:${apple.internalId}:identities`;

  let replaced = false;
  kvState.beforeEval = async (script, keys) => {
    // Fire once, at the unlink write-set's atomic eval (its ownership fence).
    if (!replaced && script.includes('-- UNLINK') && keys[0] === lockKey) {
      replaced = true;
      // Another holder acquired the lease after ours lapsed: overwrite the lock with
      // a DIFFERENT token, so the very next atomic eval — this unlink — must refuse.
      kvState.values.set(lockKey, 'someone-elses-token');
    }
  };

  await expectError(store.unlinkIdentity(apple.internalId, 'google'), 'LOCK_TIMEOUT');
  kvState.beforeEval = null;

  // The stale holder wrote NOTHING: the google identity is wholly intact, so no
  // live index is left stranded without a detail/membership behind it.
  assert.equal(kvState.values.get(idxKey), apple.internalId, 'google index survives — not stranded/released');
  const detail = kvState.values.get(detailKey);
  assert.ok(detail && detail.pending === false, 'google detail survives, still committed');
  const members = kvState.sets.get(identitiesKey);
  assert.ok(members.has('google:g-un'), 'google membership survives');

  // Both methods remain live and google still grants login into this same account.
  const after = await store.getUser(apple.internalId);
  assert.equal(after.linkedProviders.length, 2, 'apple + google both remain after the refused unlink');
  const relogin = await store.loginOrCreate(identity('google', 'g-un', 'g@example.com', 'Ann'));
  assert.equal(relogin.isNew, false, 'google still resolves into the account');
  assert.equal(relogin.user.internalId, apple.internalId, 'google login lands on the same user');
}

async function testStaleDeleteHolderCannotWipeRepublishedAccount() {
  resetKv();
  // Codex CR DIC-877 CR9, the delete-cascade variant. A user with two committed
  // methods is deleted. On the pre-CR9 code each index release was fenced but the
  // detail/identities/user deletes were not, so a stale holder could resume after
  // its lease lapsed and wipe records a new holder had rebuilt. We replace the lock
  // token at the instant the cascade's atomic eval is about to run: because the
  // whole cascade is one fenced op, the stale holder writes NOTHING — the user and
  // every identity survive intact rather than being half-deleted past lease expiry.
  const apple = (await store.loginOrCreate(identity('apple', 'a-del', 'a@icloud.com', 'Kim'))).user;
  await store.linkIdentity(apple.internalId, identity('google', 'g-del', 'g@example.com', 'Ann'));
  const lockKey = `auth:lock:${apple.internalId}`;
  const userKey = `auth:user:${apple.internalId}`;
  const identitiesKey = `auth:user:${apple.internalId}:identities`;
  const appleIdx = 'auth:idx:apple:a-del';
  const googleIdx = 'auth:idx:google:g-del';

  let replaced = false;
  kvState.beforeEval = async (script, keys) => {
    if (!replaced && script.includes('-- DELUSER') && keys[0] === lockKey) {
      replaced = true;
      kvState.values.set(lockKey, 'someone-elses-token');
    }
  };

  await expectError(store.deleteUser(apple.internalId), 'LOCK_TIMEOUT');
  kvState.beforeEval = null;

  // The stale holder wrote NOTHING: the whole account survives.
  assert.ok(kvState.values.get(userKey), 'user record survives the refused delete');
  assert.equal(kvState.values.get(appleIdx), apple.internalId, 'apple index survives');
  assert.equal(kvState.values.get(googleIdx), apple.internalId, 'google index survives');
  const members = kvState.sets.get(identitiesKey);
  assert.ok(members && members.has('apple:a-del') && members.has('google:g-del'), 'both memberships survive');
  const after = await store.getUser(apple.internalId);
  assert.equal(after.linkedProviders.length, 2, 'both methods remain after the refused delete');
}

(async () => {
  const tests = [
    testStaleLinkHolderCannotCommitPastLeaseExpiry,
    testStaleHolderCannotFlipCommitAfterLeaseReplaced,
    testStaleUnlinkHolderCannotWipeRepublishedIdentity,
    testStaleDeleteHolderCannotWipeRepublishedAccount,
    testNewAndReturningUser,
    testLinkSecondProviderAndUnlink,
    testCrossAccountCollision,
    testSameProviderGuard,
    testCannotUnlinkLastMethodAndConcurrency,
    testConcurrentUnlinkAndDeleteLeaveNoDanglingIndex,
    testConcurrentFirstLoginCreatesSingleUser,
    testStaleCreatorCannotOverwriteElectedWinner,
    testDanglingIndexReclamationElectsSingleWinner,
    testGhostLinkAfterCrashIsHiddenRepairedAndNotSplit,
    testFailedFinalLinkCommitFailsClosedAndRepairs,
    testDeleteDoesNotWipeAnotherAccountsLiveIndex,
    testUnlinkDoesNotWipeAnotherAccountsLiveIndex,
    testUnlinkLastCommittedMethodIgnoresPendingGhost,
    testReplacePendingSiblingReleasesOldProviderIndex,
    testWriteFailureIsNotReportedAsSuccess,
    testFailedLinkDoesNotGrantFutureLogin,
    testLinkCrashBeforeCommitGrantsNoLogin,
    testDisabledUserNotRestorable,
    testRolePreservedNotDowngraded,
    testPrivateRelayEmailChangeDoesNotSplitOrMerge,
    testDeleteCascadeRemovesIdentities,
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
