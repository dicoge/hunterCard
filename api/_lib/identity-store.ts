/**
 * Server-authoritative internal-user / identities store (DIC-663).
 *
 * Implements the DIC-662 identity contract (docs/AUTH-Architecture.md §3, §5, §6)
 * on Vercel KV. The internal user id is the identity primary key; a provider
 * identity is keyed by `(provider, subject)`, NOT by email — email is only a
 * snapshot and never participates in identity resolution or merging (so Apple
 * private-relay / changed emails cannot cause wrong merges).
 *
 * How the Postgres contract maps onto KV:
 *   - `uq_provider_subject_active` unique index → an atomic `SET NX` claim on
 *     `auth:idx:{provider}:{subject}` → userId. First writer wins; a losing
 *     writer reads the existing owner and returns IDENTITY_ALREADY_LINKED.
 *   - The mandatory user-lock protocol (`SELECT ... FOR UPDATE`) → a per-user
 *     KV lock (`SET NX PX`) with compare-and-delete release, held around every
 *     ownership-mutating op (link / unlink / delete). login-or-create needs no
 *     lock because the atomic claim already serialises new-identity creation.
 *
 * Honesty contract (CR DIC-854 blocker #1/#2): every KV write is awaited and
 * NEVER swallowed. A failed write throws; callers must surface the failure and
 * MUST NOT report link/unlink/delete success. When KV is not configured the
 * endpoints fail closed (see `isIdentityStoreConfigured`).
 *
 * Not in scope here (deferred to the DIC-662 merge endpoint): executing an
 * account merge. A cross-account collision returns 409 IDENTITY_ALREADY_LINKED
 * with a `merge_token`; the client's honest behaviour is "unlink from the other
 * account first" (reject), never a silent merge.
 */
import { kv } from '@vercel/kv';
import crypto from 'crypto';

export type Provider = 'google' | 'apple';

export interface VerifiedIdentity {
  provider: Provider;
  subject: string;
  email?: string;
  name?: string;
  picture?: string;
}

export interface StoredUser {
  id: string;
  status: 'active' | 'disabled' | 'pending_deletion';
  role: 'free_user' | 'subscriber';
  displayName: string;
  primaryEmail?: string;
  photoUrl?: string;
  createdAt: string;
}

interface IdentityDetail {
  provider: Provider;
  subject: string;
  email?: string;
  displayName?: string;
  photoUrl?: string;
  linkedAt: string;
}

export interface PublicLinkedProvider {
  provider: Provider;
  providerId: string;
  email?: string;
  displayName?: string;
  photoUrl?: string;
  linkedAt: string;
}

export interface PublicUser {
  internalId: string;
  displayName: string;
  primaryEmail?: string;
  photoUrl?: string;
  role: StoredUser['role'];
  linkedProviders: PublicLinkedProvider[];
  createdAt: string;
}

export type IdentityErrorCode =
  | 'INVALID_TOKEN'
  | 'TOKEN_EXPIRED'
  | 'IDENTITY_ALREADY_LINKED'
  | 'SAME_PROVIDER_ALREADY_LINKED'
  | 'CANNOT_UNLINK_LAST_METHOD'
  | 'ACCOUNT_DISABLED'
  | 'NO_SUCH_IDENTITY'
  | 'USER_NOT_FOUND'
  | 'STORE_NOT_CONFIGURED'
  | 'LOCK_TIMEOUT';

const STATUS_BY_CODE: Record<IdentityErrorCode, number> = {
  INVALID_TOKEN: 401,
  TOKEN_EXPIRED: 401,
  IDENTITY_ALREADY_LINKED: 409,
  SAME_PROVIDER_ALREADY_LINKED: 409,
  CANNOT_UNLINK_LAST_METHOD: 409,
  ACCOUNT_DISABLED: 403,
  NO_SUCH_IDENTITY: 404,
  USER_NOT_FOUND: 404,
  STORE_NOT_CONFIGURED: 501,
  LOCK_TIMEOUT: 503,
};

export class IdentityStoreError extends Error {
  code: IdentityErrorCode;
  status: number;
  extra?: Record<string, unknown>;

  constructor(code: IdentityErrorCode, message?: string, extra?: Record<string, unknown>) {
    super(message ?? code);
    this.name = 'IdentityStoreError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.extra = extra;
  }
}

const USER_KEY = (id: string) => `auth:user:${id}`;
const IDX_KEY = (p: Provider, sub: string) => `auth:idx:${p}:${sub}`;
const DETAIL_KEY = (id: string, p: Provider, sub: string) => `auth:idetail:${id}:${p}:${sub}`;
const IDENTITIES_KEY = (id: string) => `auth:user:${id}:identities`;
const LOCK_KEY = (id: string) => `auth:lock:${id}`;
const FENCE_KEY = (id: string) => `auth:fence:${id}`;
// Deletion tombstone, owned by session.ts as `auth:deleted:{userId}`. identity-store
// reads it DIRECTLY here — symmetric to session.ts reading our `auth:user:{id}` — so
// login/link/unlink can observe an in-flight account deletion UNDER the per-user lock
// without importing session.ts (no import cycle). CR round-8 blocker #1.
const DELETED_KEY = (id: string) => `auth:deleted:${id}`;
const member = (p: Provider, sub: string) => `${p}:${sub}`;
const splitMember = (m: string): { provider: Provider; subject: string } => {
  const i = m.indexOf(':');
  return { provider: m.slice(0, i) as Provider, subject: m.slice(i + 1) };
};

// The lock lease MUST outlive the serverless handler budget so it cannot lapse
// while our handler is still alive and let a second writer corrupt the same
// user's read-modify-write (CR round-4 blocker #3: "the fixed 5-second lease can
// expire inside the 10-second handler"). We set the lease above the handler
// budget and additionally expose renewLock for defence-in-depth on long ops.
export const HANDLER_MAX_DURATION_MS = 10000; // mirrors maxDuration in api/auth/[action].ts
export const LOCK_TTL_MS = 15000; // strictly greater than HANDLER_MAX_DURATION_MS
const LOCK_RETRIES = 50;
const LOCK_RETRY_MS = 20;
const CREATE_RETRIES = 5;

// Compare-and-delete: delete KEYS[1] only if its value equals ARGV[1]. Used for
// two things that must not clobber a value another writer has since changed:
//   - lock release (never delete a lock re-acquired after our TTL expired), and
//   - freeing an identity index (never stomp an index a concurrent flow has
//     already reclaimed for a different user — CR blocker #1, delete/reclaim).
// The GET and DEL run atomically on the server, closing the check-then-act race
// that a separate `kv.get` + `kv.del` would leave open.
const COMPARE_AND_DELETE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
const RELEASE_LOCK = COMPARE_AND_DELETE;
// Extend the lease iff we still hold it (compare-and-pexpire, atomic).
const RENEW_LOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;

// A held lock carries a fencing token: a monotonically increasing number handed
// out at acquisition so a stale holder (whose lease lapsed) is strictly ordered
// behind the current holder and can be detected at commit.
interface Lock {
  token: string;
  fence: number;
}

// Free an identity index iff it still points at `userId` (atomic check-and-del).
async function freeIndexIfOwned(provider: Provider, subject: string, userId: string): Promise<boolean> {
  const freed = await kv.eval(COMPARE_AND_DELETE, [IDX_KEY(provider, subject)], [userId]);
  return freed === 1;
}

/**
 * True iff a deletion tombstone exists for this user. Read under the per-user lock
 * by login/link/unlink so an in-flight (or partially-failed) account deletion is
 * observed before any ownership mutation resurrects the account or mints a session
 * for it (CR round-8 blocker #1).
 */
async function isTombstoned(userId: string): Promise<boolean> {
  return Boolean(await kv.get(DELETED_KEY(userId)));
}

export function isIdentityStoreConfigured(): boolean {
  return Boolean(
    (process.env.KV_REST_API_URL || process.env.KV_URL) &&
      (process.env.KV_REST_API_TOKEN || process.env.KV_REST_API_READ_ONLY_TOKEN),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function newUserId(): string {
  return 'holo_' + crypto.randomBytes(9).toString('hex');
}

async function acquireLock(userId: string): Promise<Lock> {
  const token = crypto.randomUUID();
  for (let i = 0; i < LOCK_RETRIES; i++) {
    const ok = await kv.set(LOCK_KEY(userId), token, { nx: true, px: LOCK_TTL_MS });
    if (ok === 'OK') {
      // Monotonic fence: a later acquisition always reads a strictly higher value.
      const fence = Number(await kv.incr(FENCE_KEY(userId)));
      return { token, fence };
    }
    await sleep(LOCK_RETRY_MS);
  }
  throw new IdentityStoreError('LOCK_TIMEOUT', `Could not acquire lock for ${userId}`);
}

/** Extend our lease (defence-in-depth for unusually long critical sections). */
async function renewLock(userId: string, lock: Lock): Promise<void> {
  await kv.eval(RENEW_LOCK, [LOCK_KEY(userId)], [lock.token, String(LOCK_TTL_MS)]);
}

/** True iff we are still the current lock holder (lease not lapsed/stolen). */
async function stillHolds(userId: string, lock: Lock): Promise<boolean> {
  return (await kv.get<string>(LOCK_KEY(userId))) === lock.token;
}

/**
 * Guard a commit against a lost lease: if we no longer hold the lock (a stale
 * holder whose lease lapsed), abort instead of writing over the current holder.
 * With LOCK_TTL_MS > HANDLER_MAX_DURATION_MS this is belt-and-braces, but it makes
 * the fencing explicit and fails safe if timings ever drift.
 */
async function assertHeld(userId: string, lock: Lock): Promise<void> {
  if (!(await stillHolds(userId, lock))) {
    throw new IdentityStoreError('LOCK_TIMEOUT', `Lock lease lost for ${userId} (fence ${lock.fence})`);
  }
}

async function releaseLock(userId: string, lock: Lock): Promise<void> {
  await kv.eval(RELEASE_LOCK, [LOCK_KEY(userId)], [lock.token]);
}

async function loadUser(userId: string): Promise<StoredUser | null> {
  return (await kv.get<StoredUser>(USER_KEY(userId))) ?? null;
}

async function loadDetails(userId: string, members: string[]): Promise<IdentityDetail[]> {
  const details: IdentityDetail[] = [];
  for (const m of members) {
    const { provider, subject } = splitMember(m);
    const detail = await kv.get<IdentityDetail>(DETAIL_KEY(userId, provider, subject));
    if (detail) details.push(detail);
  }
  return details;
}

/**
 * The membership set is a secondary cache; the identity index is the sole
 * ownership authority. A member counts as linked ONLY when its index still
 * points at this user. This reconcile-on-read is what makes a partially-applied
 * link/unlink safe: a membership entry left behind by a rolled-back link, or an
 * index freed by a half-finished unlink, is simply not reported as linked (and
 * is never loginnable, because login also goes through the index). Pure read —
 * no repair writes here, so hydrate/getUser never mutate.
 */
async function ownedMembers(userId: string): Promise<string[]> {
  const members = ((await kv.smembers(IDENTITIES_KEY(userId))) as string[] | null) ?? [];
  const owned: string[] = [];
  for (const m of members) {
    const { provider, subject } = splitMember(m);
    if ((await kv.get<string>(IDX_KEY(provider, subject))) === userId) owned.push(m);
  }
  return owned;
}

async function hydrate(user: StoredUser): Promise<PublicUser> {
  const details = await loadDetails(user.id, await ownedMembers(user.id));
  const linkedProviders: PublicLinkedProvider[] = details
    .map((d) => ({
      provider: d.provider,
      providerId: d.subject,
      email: d.email,
      displayName: d.displayName,
      photoUrl: d.photoUrl,
      linkedAt: d.linkedAt,
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
  return {
    internalId: user.id,
    displayName: user.displayName,
    primaryEmail: user.primaryEmail,
    photoUrl: user.photoUrl,
    role: user.role,
    linkedProviders,
    createdAt: user.createdAt,
  };
}

export interface LoginResult {
  user: PublicUser;
  isNew: boolean;
  session?: string;
}

/**
 * Mints a session token for a just-validated user. login-or-create invokes this
 * INSIDE the same serialisable boundary that validated the user (the per-user
 * lock on the returning path; immediately after the atomic index claim on the
 * create path), so a concurrent unlink/delete cannot slip a valid session out for
 * an unlinked provider or a deleted user (CR round-6 blocker #2). It is a callback
 * — not a direct import of session.ts — so identity-store keeps no dependency on
 * the session layer (no import cycle).
 */
export type SessionMinter = (userId: string) => Promise<string>;

// Sentinel telling loginOrCreate to re-read the index and retry (ownership moved
// under us while we waited for the lock, or the owner turned out to be deleted).
const RETRY = Symbol('retry');

/**
 * Returning-login critical section (CR round-4 blocker #3). Runs under the same
 * fenced per-user lock delete/unlink hold, so it cannot resurrect a user that a
 * concurrent delete is removing. Returns RETRY when the caller must re-read the
 * index (ownership changed / owner deleted), otherwise the resolved login.
 */
async function loginExistingOwner(
  identity: VerifiedIdentity,
  ownerId: string,
  mintSession?: SessionMinter,
): Promise<LoginResult | typeof RETRY> {
  const { provider, subject } = identity;
  const lock = await acquireLock(ownerId);
  try {
    // Re-read ownership under the lock: between reading the index and taking the
    // lock a delete/unlink may have freed or reassigned it. If it no longer points
    // at ownerId, do NOT touch ownerId's records — retry from a fresh index read.
    if ((await kv.get<string>(IDX_KEY(provider, subject))) !== ownerId) return RETRY;

    const user = await loadUser(ownerId);
    if (!user) {
      // Index points at a user that no longer exists: a partial delete left the
      // index dangling. Atomically free it iff still ours (never stomp a reclaim),
      // then retry as a create.
      await freeIndexIfOwned(provider, subject, ownerId);
      return RETRY;
    }
    if (await isTombstoned(ownerId)) {
      // The account is being (or has been) deleted — its tombstone was committed
      // under this SAME lock. Do NOT resurrect the record or mint a session bound
      // to a deleted user (CR round-8 blocker #1: login must never return a newly
      // minted but immediately unusable session). Free the stale index iff still
      // ours so the retry falls through to creating a FRESH user for this subject.
      await freeIndexIfOwned(provider, subject, ownerId);
      return RETRY;
    }
    if (user.status !== 'active') {
      throw new IdentityStoreError('ACCOUNT_DISABLED', `User ${ownerId} is ${user.status}`);
    }
    // Fail safe if our lease somehow lapsed before the write (belt-and-braces:
    // LOCK_TTL_MS already exceeds the handler budget).
    await assertHeld(ownerId, lock);
    const refreshed = await refreshSnapshot(user, identity);
    // Mint the session while STILL holding the lock, so a concurrent delete/unlink
    // cannot complete between validating this user and issuing its token.
    const sessionToken = mintSession ? await mintSession(refreshed.id) : undefined;
    return { user: await hydrate(refreshed), isNew: false, session: sessionToken };
  } finally {
    await releaseLock(ownerId, lock);
  }
}

/**
 * §5.1 login-or-create. The atomic claim on the identity index is the sole
 * serialisation point and the single COMMIT point of a create.
 *
 * Ordering matters (CR blocker #1 — concurrent login-create race): the user
 * record, detail and membership are written FIRST, keyed by an unguessable id
 * that is unreachable until the index points at it; only then is the index
 * claimed with SET NX. Because a live create never exposes an index without its
 * user, the returning path's "dangling index" cleanup below can never delete an
 * in-progress index and split one provider subject into two internal users. If
 * we lose the claim, we roll the orphan user back and re-read the winner.
 *
 * Returning-login serialisation (CR round-4 blocker #3): a returning login does a
 * read-modify-write of the owner's snapshot (refreshSnapshot writes the user
 * record + detail). A concurrent delete/unlink mutates the SAME records under the
 * per-user lock, so a lock-free login could resurrect a just-deleted user
 * (zombie) or refresh a record the delete is tearing down. We therefore take the
 * SAME fenced lock those ops hold before touching an existing owner, and re-read
 * the index under it: if ownership changed out from under us we retry from
 * scratch (falling through to create when the account was deleted) instead of
 * writing over a deleted user. Create needs no lock — its SET NX claim is already
 * the serialisation point for a brand-new subject.
 */
export async function loginOrCreate(
  identity: VerifiedIdentity,
  mintSession?: SessionMinter,
): Promise<LoginResult> {
  const { provider, subject } = identity;

  for (let attempt = 0; attempt < CREATE_RETRIES; attempt++) {
    const ownerId = await kv.get<string>(IDX_KEY(provider, subject));

    if (ownerId) {
      const returning = await loginExistingOwner(identity, ownerId, mintSession);
      if (returning === RETRY) continue;
      return returning;
    }

    const candidateId = newUserId();
    const now = new Date().toISOString();
    const user: StoredUser = {
      id: candidateId,
      status: 'active',
      role: 'free_user',
      displayName: identity.name || identity.email || 'HoloHunter User',
      primaryEmail: identity.email,
      photoUrl: identity.picture,
      createdAt: now,
    };
    // Secondary records first (unreachable until the index commit below).
    await kv.set(USER_KEY(candidateId), user);
    await writeDetail(candidateId, identity, now);
    await kv.sadd(IDENTITIES_KEY(candidateId), member(provider, subject));

    // Commit: claim the unique index LAST.
    const claimed = await kv.set(IDX_KEY(provider, subject), candidateId, { nx: true });
    if (claimed !== 'OK') {
      // Lost the race. Roll back the orphan user (it was never reachable) and
      // loop to re-read the winner rather than creating a duplicate.
      await rollbackCreate(candidateId, provider, subject);
      continue;
    }
    // Mint right after the commit — the atomic claim is this path's serialisation
    // point and the id is unreachable to any concurrent delete until now, so the
    // session is issued within the same boundary that created the user.
    const sessionToken = mintSession ? await mintSession(candidateId) : undefined;
    return { user: await hydrate(user), isNew: true, session: sessionToken };
  }

  throw new IdentityStoreError('LOCK_TIMEOUT', 'login-or-create contention exceeded retries');
}

async function rollbackCreate(userId: string, provider: Provider, subject: string): Promise<void> {
  await kv.del(IDENTITIES_KEY(userId));
  await kv.del(DETAIL_KEY(userId, provider, subject));
  await kv.del(USER_KEY(userId));
}

async function writeDetail(userId: string, identity: VerifiedIdentity, linkedAt: string): Promise<void> {
  const detail: IdentityDetail = {
    provider: identity.provider,
    subject: identity.subject,
    email: identity.email,
    displayName: identity.name,
    photoUrl: identity.picture,
    linkedAt,
  };
  await kv.set(DETAIL_KEY(userId, identity.provider, identity.subject), detail);
}

// Update the email/name/photo snapshot on returning login. Identity resolution
// already happened by subject; this only refreshes display data and never
// re-keys or merges by email.
async function refreshSnapshot(user: StoredUser, identity: VerifiedIdentity): Promise<StoredUser> {
  const existing = await kv.get<IdentityDetail>(
    DETAIL_KEY(user.id, identity.provider, identity.subject),
  );
  const linkedAt = existing?.linkedAt ?? new Date().toISOString();
  await writeDetail(user.id, identity, linkedAt);
  const next: StoredUser = {
    ...user,
    displayName: identity.name || user.displayName,
    primaryEmail: identity.email ?? user.primaryEmail,
    photoUrl: identity.picture ?? user.photoUrl,
  };
  await kv.set(USER_KEY(user.id), next);
  return next;
}

export interface LinkResult {
  user: PublicUser;
  alreadyLinked: boolean;
}

/**
 * §5.2 link a second provider to an existing internal user.
 *
 * The atomic index claim is the COMMIT point. Secondary records (detail,
 * membership) are written after it under the per-user lock; if any secondary
 * write fails we roll the claim back (CR blocker #1) so we never leave a
 * loginnable-but-invisible identity. A cross-account collision returns 409
 * IDENTITY_ALREADY_LINKED + merge_token and mutates nothing.
 */
export async function linkIdentity(userId: string, identity: VerifiedIdentity): Promise<LinkResult> {
  const { provider, subject } = identity;
  const lock = await acquireLock(userId);
  try {
    const user = await loadUser(userId);
    if (!user) throw new IdentityStoreError('USER_NOT_FOUND', userId);
    if (await isTombstoned(userId)) throw new IdentityStoreError('USER_NOT_FOUND', userId); // deletion in flight
    if (user.status !== 'active') throw new IdentityStoreError('ACCOUNT_DISABLED', userId);

    const owned = await ownedMembers(userId);
    const sameProvider = owned.find((m) => splitMember(m).provider === provider);
    if (sameProvider) {
      if (sameProvider === member(provider, subject)) {
        return { user: await hydrate(user), alreadyLinked: true }; // idempotent
      }
      throw new IdentityStoreError(
        'SAME_PROVIDER_ALREADY_LINKED',
        `User already has a ${provider} identity; unlink it before linking a different one`,
      );
    }

    // Commit: claim the unique index. If it is already owned by someone else it
    // is a collision; if already owned by us it is a partial-link leftover to heal.
    const claimed = await kv.set(IDX_KEY(provider, subject), userId, { nx: true });
    const claimedNow = claimed === 'OK';
    if (!claimedNow) {
      const owner = await kv.get<string>(IDX_KEY(provider, subject));
      if (owner !== userId) {
        throw new IdentityStoreError('IDENTITY_ALREADY_LINKED', `${provider} identity owned by ${owner}`, {
          merge_token: issueMergeToken(userId, owner ?? '', provider, subject),
        });
      }
    }

    try {
      const now = new Date().toISOString();
      await writeDetail(userId, identity, now);
      await kv.sadd(IDENTITIES_KEY(userId), member(provider, subject));
    } catch (err) {
      // Roll back so the failed link leaves no residual ownership. Only free the
      // index if we claimed it in THIS call (never revoke pre-existing ownership).
      if (claimedNow) await kv.del(IDX_KEY(provider, subject));
      await kv.del(DETAIL_KEY(userId, provider, subject));
      await kv.srem(IDENTITIES_KEY(userId), member(provider, subject));
      throw err;
    }
    return { user: await hydrate(user), alreadyLinked: false };
  } finally {
    await releaseLock(userId, lock);
  }
}

/**
 * §5.3 unlink a provider, refusing to remove the last login method.
 *
 * Convergent + atomic (CR blocker #1). The decisive step is an atomic
 * compare-and-delete that frees the identity index iff it still points at us —
 * this both removes login capability and cannot stomp an index a concurrent flow
 * reclaimed. Everything else is idempotent cleanup, and the membership `srem`
 * runs LAST, so any failure leaves the target still discoverable in the set and
 * a retry re-finds it and completes the unlink instead of failing with
 * NO_SUCH_IDENTITY. The target is found via the raw membership set (not the
 * owned set) precisely so a resumed unlink — whose index is already freed — still
 * matches and converges.
 */
export async function unlinkIdentity(userId: string, provider: Provider): Promise<PublicUser> {
  const lock = await acquireLock(userId);
  try {
    const user = await loadUser(userId);
    if (!user) throw new IdentityStoreError('USER_NOT_FOUND', userId);
    if (await isTombstoned(userId)) throw new IdentityStoreError('USER_NOT_FOUND', userId); // deletion in flight

    const members = ((await kv.smembers(IDENTITIES_KEY(userId))) as string[] | null) ?? [];
    const target = members.find((m) => splitMember(m).provider === provider);
    if (!target) {
      // Idempotent (CR round-4 blocker #2): the provider is already unlinked — a
      // completed unlink, or a retry after one whose session-revocation step
      // failed. Converge to success (return the current user) instead of throwing
      // NO_SUCH_IDENTITY, so the caller's retry reaches the correct final state.
      return await hydrate(user);
    }

    const { subject } = splitMember(target);
    const idxOwner = await kv.get<string>(IDX_KEY(provider, subject));
    const targetIsOwned = idxOwner === userId;

    // Last-method guard counts only loginnable (index-owned) identities, and only
    // applies while the target is still owned. On a resume (index already freed),
    // the decisive step already passed this guard once — re-blocking it would
    // strand the half-unlinked identity, so we let cleanup finish.
    if (targetIsOwned) {
      const owned = await ownedMembers(userId);
      if (owned.length <= 1) {
        throw new IdentityStoreError('CANNOT_UNLINK_LAST_METHOD', 'At least one login method must remain');
      }
      // Decisive: atomically free the index iff still ours (never stomp a reclaim).
      await freeIndexIfOwned(provider, subject, userId);
    }

    // Idempotent cleanup. Recompute the snapshot from what remains loginnable,
    // then remove the membership entry LAST so a mid-cleanup failure still leaves
    // the target discoverable for a convergent retry.
    await kv.del(DETAIL_KEY(userId, provider, subject));
    const remaining = await ownedMembers(userId);
    const details = await loadDetails(userId, remaining);
    const next: StoredUser = { ...user, primaryEmail: details[0]?.email ?? user.primaryEmail };
    await kv.set(USER_KEY(userId), next);
    await kv.srem(IDENTITIES_KEY(userId), target);
    return await hydrate(next);
  } finally {
    await releaseLock(userId, lock);
  }
}

export interface DeleteResult {
  deletedInternalUser: boolean;
  deletedProviders: number;
}

/**
 * §5.4 identity cascade, assuming the per-user lock is ALREADY held. Idempotent:
 * returns deletedInternalUser:false (no throw) once the user record is gone, so a
 * convergent retry is safe.
 */
async function deleteUserLocked(userId: string): Promise<DeleteResult> {
  const user = await loadUser(userId);
  if (!user) return { deletedInternalUser: false, deletedProviders: 0 };

  const members = ((await kv.smembers(IDENTITIES_KEY(userId))) as string[] | null) ?? [];
  for (const m of members) {
    const { provider, subject } = splitMember(m);
    // Atomic compare-and-delete: free the index iff it STILL points at us. The
    // old GET-then-DEL had a check-then-act race — if a new user reclaimed the
    // subject between the GET and the DEL, the stale DEL would stomp the new
    // owner's index (CR blocker #1, delete/reclaim interleaving).
    await freeIndexIfOwned(provider, subject, userId);
    await kv.del(DETAIL_KEY(userId, provider, subject));
  }
  await kv.del(IDENTITIES_KEY(userId));
  await kv.del(USER_KEY(userId));
  return { deletedInternalUser: true, deletedProviders: members.length };
}

/** §5.4 cascade delete the internal user and all its identities. */
export async function deleteUser(userId: string): Promise<DeleteResult> {
  const lock = await acquireLock(userId);
  try {
    return await deleteUserLocked(userId);
  } finally {
    await releaseLock(userId, lock);
  }
}

/** Callbacks the account-deletion commit runs, kept as callbacks so identity-store
 *  takes no dependency on session.ts / apple-token-store (no import cycle). */
export interface DeletionHooks {
  /** Write the durable deletion tombstone (session.markUserDeleted). */
  writeTombstone: (userId: string) => Promise<void>;
  /** Post-cascade idempotent cleanup: discard Apple token + revoke ALL sessions. */
  afterCascade: (userId: string) => Promise<void>;
}

/**
 * Account-deletion state machine as ONE fenced per-user critical section (CR
 * round-8 blocker #1). The deletion TOMBSTONE is the single durable commit point
 * and is written FIRST, under the SAME lock login/link/unlink/delete take — not by
 * the handler lock-free. Fencing it here is what lets a concurrent returning login
 * (which re-checks the tombstone under this lock) refuse to hand out a session for
 * an account being deleted, closing the "newly minted but immediately unusable
 * session" window. After the tombstone: the identity cascade, then afterCascade
 * (Apple-token discard + revoke-all) — every step idempotent, so a retry converges.
 * If the tombstone SET itself fails, the lock releases having committed nothing and
 * the caller's live token simply retries.
 */
export async function commitAccountDeletion(userId: string, hooks: DeletionHooks): Promise<void> {
  const lock = await acquireLock(userId);
  try {
    await hooks.writeTombstone(userId);
    await assertHeld(userId, lock);
    await deleteUserLocked(userId);
    await hooks.afterCascade(userId);
  } finally {
    await releaseLock(userId, lock);
  }
}

export async function getUser(userId: string): Promise<PublicUser | null> {
  const user = await loadUser(userId);
  return user ? hydrate(user) : null;
}

// Opaque, short-lived collision token. Merge EXECUTION is a separate DIC-662
// endpoint; this only proves the two candidate accounts to a future merge flow.
function issueMergeToken(current: string, other: string, provider: Provider, subject: string): string {
  const payload = Buffer.from(
    JSON.stringify({ current, other, provider, subject, iat: Date.now() }),
  ).toString('base64url');
  const secret = process.env.AUTH_SESSION_SECRET ?? '';
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
