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
  // true while the membership/detail have been committed but the login-granting
  // index has NOT yet been published (a crash between the two leaves this set).
  // A pending detail is invisible to hydrate and never returned as alreadyLinked:
  // it is a ghost to be finished or discarded, never a live link (CR DIC-866 #2).
  pending?: boolean;
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
  | 'IDENTITY_LINK_PENDING'
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
  IDENTITY_LINK_PENDING: 409,
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
const member = (p: Provider, sub: string) => `${p}:${sub}`;
const splitMember = (m: string): { provider: Provider; subject: string } => {
  const i = m.indexOf(':');
  return { provider: m.slice(0, i) as Provider, subject: m.slice(i + 1) };
};

// Lease length for the per-user lock. This is a RENEWABLE lease, not a hard
// deadline: every fenced write re-validates ownership and PEXPIREs the key in the
// SAME atomic Redis call, so a live-but-slow Vercel function keeps extending its
// own lease while a genuinely stalled/dead holder lets it lapse. The correctness
// guarantee against a stale holder is the ownership check fused INTO each write,
// NOT this number — raising it alone would not fix the race (CR DIC-877). It is
// sized only to give a healthy request comfortable headroom.
const LOCK_TTL_MS = 15000;
const LOCK_RETRIES = 50;
const LOCK_RETRY_MS = 20;
// Bounded retries for the create-path index claim: enough to outlast a concurrent
// winner's index-publish->commit gap without hanging on a genuinely stuck link.
const CREATE_CLAIM_RETRIES = 10;

// Atomic compare-and-delete: delete KEYS[1] only while its value still equals
// ARGV[1]. Two uses: releasing a lock we still hold (never stomp a lock another
// writer re-acquired after ours expired), and reclaiming a dangling identity
// index only while it still points at the exact stale owner we observed — so a
// concurrent creator that already republished a live index is never clobbered
// (CR DIC-866 #1: dangling-index reclamation race).
const COMPARE_AND_DELETE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

// Lease-fenced writes (CR DIC-877). Each script fuses the ownership check, the
// lease renewal, and EVERY related Redis write of one logical mutation into ONE
// atomic Redis evaluation. This closes both TOCTOU gaps Codex flagged: (1) the
// check-then-write gap between a fence and its single write (CR8), and (2) the
// post-fence gap where an index op was fenced but the FOLLOWING detail/membership/
// user writes were not, letting a holder that lost its lease between them strand a
// live index with no matching detail/membership (CR9). A stale holder whose lease
// token no longer occupies the lock (KEYS[1] != ARGV[1]) returns 'LOCK_LOST' and
// performs NONE of the writes — the whole mutation is all-or-nothing, never a
// partial write past lease expiry. A live holder atomically extends its lease
// (PEXPIRE) in the same op. The leading `-- TAG` comment is ignored by Redis Lua
// and lets the test's in-memory KV mock dispatch each script unambiguously.
//
// FENCED_SET_NX → first-writer index publish. Returns 'OK' | 'EXISTS' | 'LOCK_LOST'.
//   KEYS = [lock, idx]; ARGV = [token, owner, ttl]
const FENCED_SET_NX = `-- PUBLISH
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 'LOCK_LOST' end
redis.call('PEXPIRE', KEYS[1], ARGV[3])
if redis.call('SET', KEYS[2], ARGV[2], 'NX') then return 'OK' else return 'EXISTS' end`;
// FENCED_SET → unconditional value write (the pending->committed detail flip).
//   KEYS = [lock, detail]; ARGV = [token, detailJson, ttl]
const FENCED_SET = `-- SET
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 'LOCK_LOST' end
redis.call('PEXPIRE', KEYS[1], ARGV[3])
redis.call('SET', KEYS[2], ARGV[2])
return 'OK'`;
// FENCED_STAGE_LINK → the WHOLE link-staging write-set (the pending detail SET and
// the membership SADD) in ONE atomic op, before the index publish. Prior to CR10
// these were two separate fenced evals (FENCED_SET then a standalone SADD): if the lease
// token was replaced between them, the first (pending detail) persisted while the
// second (membership) was fenced out with LOCK_LOST, stranding an orphan pending
// detail with no backing membership. Fusing them means a holder whose token no
// longer occupies the lock (KEYS[1] != ARGV[1]) writes NEITHER — the staging pair
// is all-or-nothing, never a lone orphan detail (CR DIC-881 CR10). Both writes are
// still PENDING and index-less, so even a fully-staged pair is a hidden, repairable
// ghost — never login-capable.
//   KEYS = [lock, detail, identities]; ARGV = [token, ttl, detailJson, member]
const FENCED_STAGE_LINK = `-- STAGE
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 'LOCK_LOST' end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], ARGV[3])
redis.call('SADD', KEYS[3], ARGV[4])
return 'OK'`;
// FENCED_ROLLBACK → discard one (provider, subject) link atomically: owner-fenced
// index release + detail delete + membership removal. Used by pending-sibling
// cleanup and by link rollback. The index is deleted ONLY while it still names
// ARGV[3] (our userId), so a sibling whose index was legitimately reclaimed
// elsewhere is left intact.
//   KEYS = [lock, idx, detail, identities]; ARGV = [token, ttl, idxOwner, member]
const FENCED_ROLLBACK = `-- ROLLBACK
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 'LOCK_LOST' end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
if redis.call('GET', KEYS[2]) == ARGV[3] then redis.call('DEL', KEYS[2]) end
redis.call('DEL', KEYS[3])
redis.call('SREM', KEYS[4], ARGV[4])
return 'OK'`;
// FENCED_UNLINK → the whole unlink write-set in one op: owner-fenced index
// release + detail delete + membership removal + refreshed user snapshot. A
// holder that lost its lease writes NOTHING, so it can neither release an index
// nor wipe a detail/membership another holder just republished.
//   KEYS = [lock, idx, detail, identities, user]
//   ARGV = [token, ttl, idxOwner, member, userJson]
const FENCED_UNLINK = `-- UNLINK
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 'LOCK_LOST' end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
if redis.call('GET', KEYS[2]) == ARGV[3] then redis.call('DEL', KEYS[2]) end
redis.call('DEL', KEYS[3])
redis.call('SREM', KEYS[4], ARGV[4])
redis.call('SET', KEYS[5], ARGV[5])
return 'OK'`;
// FENCED_DELETE_USER → the whole cascade delete in one op: for each of ARGV[3]=n
// identities an owner-fenced index release + detail delete, then the identities
// set and the user record. Variadic: KEYS after the lock are n (idx, detail)
// pairs then the identities key then the user key; ARGV after [token, ttl, n] are
// the n index owners. All-or-nothing under the lease.
//   KEYS = [lock, idx1, detail1, ..., idxN, detailN, identities, user]
//   ARGV = [token, ttl, n, owner1, ..., ownerN]
const FENCED_DELETE_USER = `-- DELUSER
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 'LOCK_LOST' end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
local n = tonumber(ARGV[3])
for i = 0, n - 1 do
  local idxKey = KEYS[2 + i * 2]
  local detailKey = KEYS[3 + i * 2]
  if redis.call('GET', idxKey) == ARGV[4 + i] then redis.call('DEL', idxKey) end
  redis.call('DEL', detailKey)
end
redis.call('DEL', KEYS[2 + n * 2])
redis.call('DEL', KEYS[3 + n * 2])
return 'OK'`;

// Redis stores plain strings verbatim but JSON-encodes objects; mirror that so a
// value written through a fenced eval reads back identically via kv.get (which
// JSON-parses, falling back to the raw string). Index owners are bare strings;
// identity details and user snapshots are objects.
function encodeForKv(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
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

// A held lease. Carries the key + the unique token that proves ownership; every
// ownership-mutating write revalidates against this token before it runs.
interface Lease {
  key: string;
  token: string;
}

async function acquireLockKey(lockKey: string): Promise<Lease> {
  const token = crypto.randomUUID();
  for (let i = 0; i < LOCK_RETRIES; i++) {
    const ok = await kv.set(lockKey, token, { nx: true, px: LOCK_TTL_MS });
    if (ok === 'OK') return { key: lockKey, token };
    await sleep(LOCK_RETRY_MS);
  }
  throw new IdentityStoreError('LOCK_TIMEOUT', `Could not acquire lock ${lockKey}`);
}

async function releaseLockKey(lease: Lease): Promise<void> {
  await kv.eval(COMPARE_AND_DELETE, [lease.key], [lease.token]);
}

function leaseLost(lease: Lease): IdentityStoreError {
  return new IdentityStoreError(
    'LOCK_TIMEOUT',
    `user lock ${lease.key} lost mid-mutation (lease expired); the write was not applied`,
  );
}

// Atomic first-writer index publish under the lease. Throws LOCK_TIMEOUT (no write
// performed) if the lease has lapsed; otherwise 'OK' (we claimed it) or 'EXISTS'
// (someone else holds the index — caller resolves the collision).
async function fencedSetNx(lease: Lease, key: string, value: string): Promise<'OK' | 'EXISTS'> {
  const res = await kv.eval(FENCED_SET_NX, [lease.key, key], [lease.token, value, String(LOCK_TTL_MS)]);
  if (res === 'LOCK_LOST') throw leaseLost(lease);
  return res as 'OK' | 'EXISTS';
}

// Atomic value write under the lease (throws LOCK_TIMEOUT, no write, if lapsed).
async function fencedSet(lease: Lease, key: string, value: unknown): Promise<void> {
  const res = await kv.eval(FENCED_SET, [lease.key, key], [lease.token, encodeForKv(value), String(LOCK_TTL_MS)]);
  if (res === 'LOCK_LOST') throw leaseLost(lease);
}

// Atomic link-staging write-set under the lease — the pending detail and the
// membership marker in ONE op, so a stale holder stages BOTH or NEITHER, never a
// lone orphan detail past lease replacement (CR DIC-881 CR10). Throws LOCK_TIMEOUT
// (no write) if the lease has lapsed.
async function fencedStageLink(
  lease: Lease,
  userId: string,
  identity: VerifiedIdentity,
  linkedAt: string,
  member_: string,
): Promise<void> {
  const res = await kv.eval(
    FENCED_STAGE_LINK,
    [lease.key, DETAIL_KEY(userId, identity.provider, identity.subject), IDENTITIES_KEY(userId)],
    [
      lease.token,
      String(LOCK_TTL_MS),
      encodeForKv(buildDetail(identity, linkedAt, /* pending */ true)),
      member_,
    ],
  );
  if (res === 'LOCK_LOST') throw leaseLost(lease);
}

// Atomic discard of one (provider, subject) link — owner-fenced index release +
// detail delete + membership removal, all under the lease. Used for pending-sibling
// cleanup and link rollback; a stale holder writes none of the three.
async function fencedRollback(
  lease: Lease,
  provider: Provider,
  subject: string,
  userId: string,
): Promise<void> {
  const res = await kv.eval(
    FENCED_ROLLBACK,
    [lease.key, IDX_KEY(provider, subject), DETAIL_KEY(userId, provider, subject), IDENTITIES_KEY(userId)],
    [lease.token, String(LOCK_TTL_MS), userId, member(provider, subject)],
  );
  if (res === 'LOCK_LOST') throw leaseLost(lease);
}

// Atomic unlink write-set — owner-fenced index release + detail delete + membership
// removal + refreshed user snapshot, all under the lease. A stale holder performs
// none of them, so it can never strand a live index whose detail/membership another
// holder just republished.
async function fencedUnlink(
  lease: Lease,
  provider: Provider,
  subject: string,
  userId: string,
  member_: string,
  nextUser: StoredUser,
): Promise<void> {
  const res = await kv.eval(
    FENCED_UNLINK,
    [
      lease.key,
      IDX_KEY(provider, subject),
      DETAIL_KEY(userId, provider, subject),
      IDENTITIES_KEY(userId),
      USER_KEY(userId),
    ],
    [lease.token, String(LOCK_TTL_MS), userId, member_, encodeForKv(nextUser)],
  );
  if (res === 'LOCK_LOST') throw leaseLost(lease);
}

// Atomic cascade delete — every identity's owner-fenced index release + detail
// delete, then the identities set and the user record, all under the lease. A
// stale holder writes nothing, so it can neither wipe an index another account
// reclaimed nor leave the user half-deleted past lease expiry.
async function fencedDeleteUser(lease: Lease, userId: string, members: string[]): Promise<void> {
  const keys: string[] = [lease.key];
  const argv: string[] = [lease.token, String(LOCK_TTL_MS), String(members.length)];
  const owners: string[] = [];
  for (const m of members) {
    const { provider, subject } = splitMember(m);
    keys.push(IDX_KEY(provider, subject), DETAIL_KEY(userId, provider, subject));
    owners.push(userId);
  }
  keys.push(IDENTITIES_KEY(userId), USER_KEY(userId));
  argv.push(...owners);
  const res = await kv.eval(FENCED_DELETE_USER, keys, argv);
  if (res === 'LOCK_LOST') throw leaseLost(lease);
}

const acquireLock = (userId: string) => acquireLockKey(LOCK_KEY(userId));
const releaseLock = (lease: Lease) => releaseLockKey(lease);

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

async function hydrate(user: StoredUser): Promise<PublicUser> {
  const members = ((await kv.smembers(IDENTITIES_KEY(user.id))) as string[] | null) ?? [];
  const details = await loadDetails(user.id, members);
  const linkedProviders: PublicLinkedProvider[] = details
    .filter((d) => !d.pending) // hide ghost links whose index was never published
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
}

/**
 * Resolve an existing identity to its owner, refreshing the display snapshot.
 * Returns null when the identity has no live, committed owner (no index, a
 * dangling index whose user record is gone, or an index whose link detail is
 * still pending). `reclaimDangling` deletes such a dangling index — only safe to
 * pass under the per-identity create lock, so a merely in-flight create is never
 * mistaken for a crashed one.
 *
 * `requireCommitted` governs the pending case (index published but its detail
 * not yet flipped pending->committed — see linkIdentity / loginOrCreate). The
 * login fast path passes true: it must FAIL CLOSED on an uncommitted link rather
 * than grant access or auto-commit it (CR DIC-874 #1). Create-time adoption
 * passes false: the pending detail belongs to a concurrent winner mid-commit, so
 * it returns null and lets the caller retry until that commit lands.
 */
async function resolveExisting(
  identity: VerifiedIdentity,
  reclaimDangling: boolean,
  requireCommitted: boolean,
): Promise<LoginResult | null> {
  const { provider, subject } = identity;
  const ownerId = await kv.get<string>(IDX_KEY(provider, subject));
  if (!ownerId) return null;

  const user = await loadUser(ownerId);
  if (!user) {
    // Reclaim ONLY while the index still names the exact dangling owner we just
    // read. An unconditional delete here lets a slow creator wipe a live index a
    // concurrent winner republished in the meantime — two creators both observe
    // the stale owner, one publishes, the other's delayed delete removes the
    // live index and publishes its own, splitting the identity (CR DIC-866 #1).
    // Compare-and-delete makes that stale delete a no-op.
    if (reclaimDangling) {
      await kv.eval(COMPARE_AND_DELETE, [IDX_KEY(provider, subject)], [ownerId]);
    }
    return null;
  }
  if (user.status !== 'active') {
    throw new IdentityStoreError('ACCOUNT_DISABLED', `User ${ownerId} is ${user.status}`);
  }
  // The login-granting index alone is NOT proof of a committed link. link/create
  // publish the index and only THEN flip the detail pending->committed, so a
  // failure in that final flip leaves index->owner with a still-pending detail.
  // Prove the committed state from the detail; never grant login on — nor let the
  // refreshSnapshot below auto-commit — a pending link (CR DIC-874 #1).
  const detail = await kv.get<IdentityDetail>(DETAIL_KEY(ownerId, provider, subject));
  if (!detail || detail.pending) {
    if (requireCommitted) {
      // Login fast path: fail closed. The uncommitted link is repaired by a retry
      // of linkIdentity under the per-user lock, never by a login side effect.
      throw new IdentityStoreError(
        'IDENTITY_LINK_PENDING',
        `${provider} identity link to ${ownerId} is not committed`,
      );
    }
    return null;
  }
  const refreshed = await refreshSnapshot(user, identity);
  return { user: await hydrate(refreshed), isNew: false };
}

/**
 * §5.1 login-or-create.
 *
 * Returning logins take the lock-free fast path. Creation needs NO lock: a fresh
 * internal user is fully committed under a brand-new id, and only THEN is the
 * identity index published with an atomic first-writer-wins `SET NX`. That
 * single conditional write is the whole election — whoever wins has already
 * committed their user, so a slow or "stale" creator can neither publish a
 * duplicate nor overwrite the winner: there is no lease, hence no post-expiry
 * window in which a stale writer could clobber the index (CR DIC-866 #1). A
 * losing creator adopts the winner and discards its own orphan, which grants no
 * login because no index ever referenced it (CR DIC-866 #2, create side).
 */
export async function loginOrCreate(identity: VerifiedIdentity): Promise<LoginResult> {
  const { provider, subject } = identity;

  const fast = await resolveExisting(identity, false, /* requireCommitted */ true);
  if (fast) return fast;

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
  // Commit the user BEFORE publishing the index, so the index never points at a
  // half-written user and the SET NX below is a valid linearisation point. The
  // detail starts PENDING and is committed only once the index is published, so a
  // crash before publish leaves only an index-less, hidden orphan.
  await kv.set(USER_KEY(candidateId), user);
  await writeDetail(candidateId, identity, now, /* pending */ true);
  await kv.sadd(IDENTITIES_KEY(candidateId), member(provider, subject));

  let published = false;
  try {
    // Retry the claim: a lost NX is retried when the index was *dangling* (owner
    // gone → reclaimed below) or is held by a concurrent winner whose detail is
    // still pending (mid-commit → back off until it lands). Either way we resolve
    // to a single owner without ever minting a duplicate.
    for (let attempt = 0; attempt < CREATE_CLAIM_RETRIES; attempt++) {
      const claimed = await kv.set(IDX_KEY(provider, subject), candidateId, { nx: true });
      if (claimed === 'OK') {
        // Index published → flip the detail to committed so login/hydrate can
        // enter via it. If that final flip fails we must NOT strand index->us with
        // a pending detail (login would then fail closed with no create-side
        // repair), so retract the index we just claimed (compare-and-delete, only
        // while it still names us) and let `finally` discard the orphan user.
        try {
          await writeDetail(candidateId, identity, now, /* pending */ false);
        } catch (err) {
          await kv
            .eval(COMPARE_AND_DELETE, [IDX_KEY(provider, subject)], [candidateId])
            .catch(() => {});
          throw err;
        }
        published = true;
        return { user: await hydrate(user), isNew: true };
      }
      // Lost the election. Adopt the committed winner; if the index is dangling
      // (points at a deleted user), reclaim it and retry our own claim.
      const winner = await resolveExisting(identity, true, /* requireCommitted */ false);
      if (winner) return winner;
      await sleep(LOCK_RETRY_MS);
    }
    throw new IdentityStoreError('LOCK_TIMEOUT', 'could not resolve identity owner during create');
  } finally {
    // Anything but a successful publish leaves an unreferenced orphan user; drop
    // it best-effort. It can never grant a login because no index points at it.
    if (!published) await discardOrphan(candidateId, identity);
  }
}

// Remove a create-path user that lost the identity-index election (or threw
// before publishing). Best-effort: the user is unreferenced by any index, so a
// failed cleanup here cannot grant a login — it only leaves collectable garbage.
async function discardOrphan(candidateId: string, identity: VerifiedIdentity): Promise<void> {
  await kv.del(DETAIL_KEY(candidateId, identity.provider, identity.subject)).catch(() => {});
  await kv.del(IDENTITIES_KEY(candidateId)).catch(() => {});
  await kv.del(USER_KEY(candidateId)).catch(() => {});
}

// Undo the membership/detail a link staged before its index publish, atomically
// under the lease. The index is owner-fenced: it is released only while it still
// names `userId`, so on the collision path (it belongs to another account) it is
// left intact, and on the failed-publish path (never published) the release is a
// no-op. A stale holder writes none of the three (CR DIC-877 CR9).
async function rollbackLink(
  lease: Lease,
  userId: string,
  provider: Provider,
  subject: string,
): Promise<void> {
  await fencedRollback(lease, provider, subject, userId);
}

function buildDetail(identity: VerifiedIdentity, linkedAt: string, pending: boolean): IdentityDetail {
  return {
    provider: identity.provider,
    subject: identity.subject,
    email: identity.email,
    displayName: identity.name,
    photoUrl: identity.picture,
    linkedAt,
    pending,
  };
}

async function writeDetail(
  userId: string,
  identity: VerifiedIdentity,
  linkedAt: string,
  pending = false,
): Promise<void> {
  await kv.set(DETAIL_KEY(userId, identity.provider, identity.subject), buildDetail(identity, linkedAt, pending));
}

// Update the email/name/photo snapshot on returning login. Identity resolution
// already happened by subject; this only refreshes display data and never
// re-keys or merges by email.
async function refreshSnapshot(user: StoredUser, identity: VerifiedIdentity): Promise<StoredUser> {
  const existing = await kv.get<IdentityDetail>(
    DETAIL_KEY(user.id, identity.provider, identity.subject),
  );
  const linkedAt = existing?.linkedAt ?? new Date().toISOString();
  // Preserve the existing pending flag: a display-snapshot refresh must NEVER
  // commit a link (flip pending->false). resolveExisting only reaches here for an
  // already-committed detail, so this is normally false; keeping it explicit means
  // no login side effect can ever auto-commit a failed link (CR DIC-874 #1).
  await writeDetail(user.id, identity, linkedAt, existing?.pending ?? false);
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

/** §5.2 link a second provider to an existing internal user. */
export async function linkIdentity(userId: string, identity: VerifiedIdentity): Promise<LinkResult> {
  const { provider, subject } = identity;
  const lock = await acquireLock(userId);
  try {
    const user = await loadUser(userId);
    if (!user) throw new IdentityStoreError('USER_NOT_FOUND', userId);
    if (user.status !== 'active') throw new IdentityStoreError('ACCOUNT_DISABLED', userId);

    const members = ((await kv.smembers(IDENTITIES_KEY(userId))) as string[] | null) ?? [];
    const selfMember = member(provider, subject);

    // Distinguish a fully COMMITTED link (index published to us, detail not
    // pending) from a PENDING ghost left by a crash between membership commit and
    // index publish. We hold the per-user lock, so any pending record we observe
    // is from a dead prior attempt, never a live concurrent one — safe to finish
    // or discard here. A ghost must be REPAIRED, never returned as alreadyLinked
    // (CR DIC-866 #2), or a later provider login would split the identity.
    let repairing = false;
    let preservedLinkedAt: string | undefined;
    if (members.includes(selfMember)) {
      const detail = await kv.get<IdentityDetail>(DETAIL_KEY(userId, provider, subject));
      const owner = await kv.get<string>(IDX_KEY(provider, subject));
      if (owner === userId && !detail?.pending) {
        return { user: await hydrate(user), alreadyLinked: true }; // fully committed, idempotent
      }
      if (owner && owner !== userId) {
        // The identity was committed to another account while our attempt sat
        // pending: drop our ghost membership and surface the collision.
        await rollbackLink(lock, userId, provider, subject);
        throw new IdentityStoreError('IDENTITY_ALREADY_LINKED', `${provider} identity owned by ${owner}`, {
          merge_token: issueMergeToken(userId, owner, provider, subject),
        });
      }
      // owner is us-but-pending, or unpublished → finish (repair) the link below.
      repairing = true;
      preservedLinkedAt = detail?.linkedAt;
    } else {
      // A DIFFERENT subject on the same provider blocks only if it is COMMITTED;
      // a pending sibling is a crashed attempt we can safely discard so it can't
      // shadow this link.
      for (const m of members) {
        const s = splitMember(m);
        if (s.provider !== provider) continue;
        const sibDetail = await kv.get<IdentityDetail>(DETAIL_KEY(userId, provider, s.subject));
        const sibOwner = await kv.get<string>(IDX_KEY(provider, s.subject));
        if (sibOwner === userId && !sibDetail?.pending) {
          throw new IdentityStoreError(
            'SAME_PROVIDER_ALREADY_LINKED',
            `User already has a ${provider} identity; unlink it before linking a different one`,
          );
        }
        // Discard the crashed pending sibling in ONE atomic fenced op: owner-fenced
        // index release (a no-op if the sibling's index was legitimately reclaimed
        // elsewhere — CR DIC-875 #2) together with its detail/membership removal.
        // Bundling all three means a holder that lost its lease writes NONE of them,
        // so it can never release a sibling's index and then — past lease expiry —
        // wipe a detail/membership a new holder republished, stranding a live index
        // (CR DIC-877 CR9). Under a live lease the whole cleanup is atomic.
        await rollbackLink(lock, userId, provider, s.subject);
      }

      const priorOwner = await kv.get<string>(IDX_KEY(provider, subject));
      if (priorOwner && priorOwner !== userId) {
        throw new IdentityStoreError('IDENTITY_ALREADY_LINKED', `${provider} identity owned by ${priorOwner}`, {
          merge_token: issueMergeToken(userId, priorOwner, provider, subject),
        });
      }
    }

    // Commit membership/detail as PENDING first, then publish the login-granting
    // index. Login and hydrate resolve/expose an identity only once the index is
    // published AND the detail is committed, so an interrupted link — a crash, or
    // even a failed rollback — can never leak a login-capable or user-visible
    // identity (CR DIC-866 #2). The final SET NX is the atomic first-writer guard
    // against a concurrent claim of the same (provider, subject).
    const now = new Date().toISOString();
    const linkedAt = preservedLinkedAt ?? now;
    // Stage the pending detail AND the membership in ONE atomic fenced eval: a
    // holder whose lease token was replaced mid-staging writes NEITHER, so it can
    // never persist a lone orphan pending detail with no backing membership (the
    // split-write-set CR10 flagged — previously two fenced evals with a replaceable
    // gap between them). These are still PENDING and index-less, so even a fully
    // staged pair is a hidden, repairable ghost — never login-capable (CR DIC-881).
    await fencedStageLink(lock, userId, identity, linkedAt, selfMember);

    // PUBLICATION POINT. The index publish is ATOMIC with the lease check: the
    // ownership guard and the first-writer SET NX are one Redis eval. If our lease
    // lapsed while we wrote membership/detail and another writer took the lock, the
    // eval performs no write and reports LOCK_LOST → we roll back the (still
    // index-less) membership and abort. There is no check-then-write window a stale
    // holder could slip a publish through (CR DIC-877). A thrown/injected failure
    // is likewise rolled back; the detail stays PENDING and index-less, invisible
    // to login and hydrate.
    const claimed = await fencedSetNx(lock, IDX_KEY(provider, subject), userId).catch(async (err) => {
      await rollbackLink(lock, userId, provider, subject);
      throw err;
    });
    if (claimed !== 'OK') {
      const owner2 = await kv.get<string>(IDX_KEY(provider, subject));
      if (owner2 !== userId) {
        // A concurrent account grabbed this identity between our pre-check and
        // publish: undo the membership we committed and reject the collision.
        await rollbackLink(lock, userId, provider, subject);
        throw new IdentityStoreError('IDENTITY_ALREADY_LINKED', `${provider} identity owned by ${owner2}`, {
          merge_token: issueMergeToken(userId, owner2 ?? 'unknown', provider, subject),
        });
      }
      // owner2 === userId: a prior partial attempt already published our own
      // claim; the membership we just (re)committed makes it whole. Keep it.
    }
    // COMMIT POINT. The pending->committed flip is what makes the link live and
    // visible, so it too is written ATOMICALLY under the lease check: a stale
    // holder's flip performs no write and throws LOCK_TIMEOUT. The index is already
    // published here, so a lapsed lease leaves a repairable pending ghost (login
    // fails closed on it) rather than rolling back — a later retry under a fresh
    // lease finishes it (CR DIC-877 / DIC-874 #1).
    await fencedSet(lock, DETAIL_KEY(userId, provider, subject), buildDetail(identity, linkedAt, /* pending */ false));
    return { user: await hydrate(user), alreadyLinked: false };
  } finally {
    await releaseLock(lock);
  }
}

/** §5.3 unlink a provider, refusing to remove the last login method. */
export async function unlinkIdentity(userId: string, provider: Provider): Promise<PublicUser> {
  const lock = await acquireLock(userId);
  try {
    const user = await loadUser(userId);
    if (!user) throw new IdentityStoreError('USER_NOT_FOUND', userId);

    const members = ((await kv.smembers(IDENTITIES_KEY(userId))) as string[] | null) ?? [];
    const target = members.find((m) => splitMember(m).provider === provider);
    if (!target) throw new IdentityStoreError('NO_SUCH_IDENTITY', `${provider} not linked`);

    // The last-method invariant must count only COMMITTED, owner-matched login
    // methods — a member whose index still names us AND whose detail is not
    // pending. A raw membership count would let a hidden pending ghost (a crashed
    // link whose index was never published, or was reclaimed elsewhere) mask that
    // the target is the ONLY real login method, and permit unlinking it — leaving
    // the account with zero usable login methods (CR DIC-875 #1).
    const committed: string[] = [];
    for (const m of members) {
      const { provider: p, subject: s } = splitMember(m);
      const [idxOwner, detail] = await Promise.all([
        kv.get<string>(IDX_KEY(p, s)),
        kv.get<IdentityDetail>(DETAIL_KEY(userId, p, s)),
      ]);
      if (idxOwner === userId && detail && !detail.pending) committed.push(m);
    }
    // Refuse only when removing the target would drop the committed count from
    // one to zero. Unlinking a non-committed ghost never reduces that count, and a
    // degenerate account with no committed method at all is not made worse.
    if (committed.includes(target) && committed.every((m) => m === target)) {
      throw new IdentityStoreError('CANNOT_UNLINK_LAST_METHOD', 'At least one login method must remain');
    }

    const { subject } = splitMember(target);
    // Compute the refreshed snapshot BEFORE the mutation, from the REMAINING
    // members' details — removing the target cannot change those, so reading them
    // now is equivalent to reading them after the delete.
    const remaining = members.filter((m) => m !== target);
    const details = await loadDetails(userId, remaining);
    const next: StoredUser = { ...user, primaryEmail: details[0]?.email ?? user.primaryEmail };

    // The ENTIRE unlink write-set — owner-fenced index release, detail delete,
    // membership removal, and the refreshed user snapshot — is ONE atomic fenced
    // eval. Owner-fencing keeps the index release a no-op if the identity was
    // legitimately reclaimed by another account (CR DIC-874 #2). Bundling all four
    // under the lease means a holder that lost its lease writes NOTHING: it cannot
    // release the index and then, past lease expiry, wipe a detail/membership a new
    // holder republished — the stranded-live-index race (CR DIC-877 CR9). Under a
    // live lease it is all-or-nothing.
    await fencedUnlink(lock, provider, subject, userId, target, next);
    return await hydrate(next);
  } finally {
    await releaseLock(lock);
  }
}

export interface DeleteResult {
  deletedInternalUser: boolean;
  deletedProviders: number;
}

/** §5.4 cascade delete the internal user and all its identities. */
export async function deleteUser(userId: string): Promise<DeleteResult> {
  const lock = await acquireLock(userId);
  try {
    const user = await loadUser(userId);
    if (!user) return { deletedInternalUser: false, deletedProviders: 0 };

    const members = ((await kv.smembers(IDENTITIES_KEY(userId))) as string[] | null) ?? [];
    // The ENTIRE cascade — every identity's owner-fenced index release + detail
    // delete, then the identities set and the user record — is ONE atomic fenced
    // eval. Owner-fencing keeps each index release a no-op while it names another
    // account (CR DIC-874 #2). Bundling everything under the lease means a holder
    // that lost its lease writes NOTHING: it can neither wipe an index a new holder
    // republished nor leave the user half-deleted past lease expiry (CR DIC-877 CR9).
    await fencedDeleteUser(lock, userId, members);
    return { deletedInternalUser: true, deletedProviders: members.length };
  } finally {
    await releaseLock(lock);
  }
}

// Used by the session-restore path (/auth/me). A disabled or pending-deletion
// user must NOT be restorable: it fails closed with ACCOUNT_DISABLED so a
// persisted session cannot re-enter authenticated UI for a deactivated account
// (CR DIC-866 #3). A missing user returns null (session no longer maps to a user).
export async function getUser(userId: string): Promise<PublicUser | null> {
  const user = await loadUser(userId);
  if (!user) return null;
  if (user.status !== 'active') {
    throw new IdentityStoreError('ACCOUNT_DISABLED', `User ${userId} is ${user.status}`);
  }
  return hydrate(user);
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
