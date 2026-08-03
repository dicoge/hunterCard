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

const LOCK_TTL_MS = 5000;
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

async function acquireLockKey(lockKey: string): Promise<string> {
  const token = crypto.randomUUID();
  for (let i = 0; i < LOCK_RETRIES; i++) {
    const ok = await kv.set(lockKey, token, { nx: true, px: LOCK_TTL_MS });
    if (ok === 'OK') return token;
    await sleep(LOCK_RETRY_MS);
  }
  throw new IdentityStoreError('LOCK_TIMEOUT', `Could not acquire lock ${lockKey}`);
}

async function releaseLockKey(lockKey: string, token: string): Promise<void> {
  await kv.eval(COMPARE_AND_DELETE, [lockKey], [token]);
}

const acquireLock = (userId: string) => acquireLockKey(LOCK_KEY(userId));
const releaseLock = (userId: string, token: string) => releaseLockKey(LOCK_KEY(userId), token);

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

// Undo the membership/detail a link committed before its index publish. The
// index is not touched: on this path it was either never published or belongs to
// another account, never to `userId`.
async function rollbackLink(userId: string, provider: Provider, subject: string): Promise<void> {
  await kv.srem(IDENTITIES_KEY(userId), member(provider, subject)).catch(() => {});
  await kv.del(DETAIL_KEY(userId, provider, subject)).catch(() => {});
}

async function writeDetail(
  userId: string,
  identity: VerifiedIdentity,
  linkedAt: string,
  pending = false,
): Promise<void> {
  const detail: IdentityDetail = {
    provider: identity.provider,
    subject: identity.subject,
    email: identity.email,
    displayName: identity.name,
    photoUrl: identity.picture,
    linkedAt,
    pending,
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
        await rollbackLink(userId, provider, subject);
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
        // Discard the crashed pending sibling. Release its provider index FIRST,
        // and only while it still names US (compare-and-delete), then drop the
        // detail/membership. Ordering index-first means a crash mid-cleanup can
        // only ever leave an index-less pending ghost (safe/repairable), never a
        // live userId-owned index whose detail/membership are already gone — which
        // would leak the old subject (unusable login, and unclaimable by any other
        // account) and could split the identity. Owner-fencing keeps the delete a
        // no-op if the sibling's index was legitimately reclaimed elsewhere
        // (CR DIC-875 #2).
        await kv.eval(COMPARE_AND_DELETE, [IDX_KEY(provider, s.subject)], [userId]);
        await rollbackLink(userId, provider, s.subject);
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
    await writeDetail(userId, identity, linkedAt, /* pending */ true);
    await kv.sadd(IDENTITIES_KEY(userId), selfMember);

    // Publish the index last. A failure here is after membership commit, so roll
    // back the now-unpublished membership best-effort; even if that rollback
    // fails, the detail stays PENDING and index-less, so neither login nor
    // hydrate can enter via it.
    const claimed = await kv
      .set(IDX_KEY(provider, subject), userId, { nx: true })
      .catch(async (err) => {
        await rollbackLink(userId, provider, subject);
        throw err;
      });
    if (claimed !== 'OK') {
      const owner2 = await kv.get<string>(IDX_KEY(provider, subject));
      if (owner2 !== userId) {
        // A concurrent account grabbed this identity between our pre-check and
        // publish: undo the membership we committed and reject the collision.
        await rollbackLink(userId, provider, subject);
        throw new IdentityStoreError('IDENTITY_ALREADY_LINKED', `${provider} identity owned by ${owner2}`, {
          merge_token: issueMergeToken(userId, owner2 ?? 'unknown', provider, subject),
        });
      }
      // owner2 === userId: a prior partial attempt already published our own
      // claim; the membership we just (re)committed makes it whole. Keep it.
    }
    // Index now names us → flip the detail to COMMITTED so it becomes visible and
    // the link is durably complete. On repair this is the finishing write.
    await writeDetail(userId, identity, linkedAt, /* pending */ false);
    return { user: await hydrate(user), alreadyLinked: false };
  } finally {
    await releaseLock(userId, lock);
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
    // Owner-fenced index cleanup: delete the provider index ONLY while it still
    // names THIS user. If the identity was legitimately (re)claimed by another
    // account — e.g. this membership is a stale/pending ghost while the live index
    // points elsewhere — an unconditional delete would wipe that account's live
    // index and split its login. Compare-and-delete makes such a delete a no-op
    // (CR DIC-874 #2). The detail/membership below are keyed by THIS user, so they
    // are always ours to remove.
    await kv.eval(COMPARE_AND_DELETE, [IDX_KEY(provider, subject)], [userId]);
    await kv.del(DETAIL_KEY(userId, provider, subject));
    await kv.srem(IDENTITIES_KEY(userId), target);

    const remaining = members.filter((m) => m !== target);
    const details = await loadDetails(userId, remaining);
    const next: StoredUser = { ...user, primaryEmail: details[0]?.email ?? user.primaryEmail };
    await kv.set(USER_KEY(userId), next);
    return await hydrate(next);
  } finally {
    await releaseLock(userId, lock);
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
    for (const m of members) {
      const { provider, subject } = splitMember(m);
      // Owner-fenced: drop the provider index ONLY while it still names THIS user.
      // A stale/pending membership whose live index was reclaimed by another
      // account must not let this delete wipe that account's index (CR DIC-874 #2).
      await kv.eval(COMPARE_AND_DELETE, [IDX_KEY(provider, subject)], [userId]);
      await kv.del(DETAIL_KEY(userId, provider, subject));
    }
    await kv.del(IDENTITIES_KEY(userId));
    await kv.del(USER_KEY(userId));
    return { deletedInternalUser: true, deletedProviders: members.length };
  } finally {
    await releaseLock(userId, lock);
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
