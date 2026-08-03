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
const member = (p: Provider, sub: string) => `${p}:${sub}`;
const splitMember = (m: string): { provider: Provider; subject: string } => {
  const i = m.indexOf(':');
  return { provider: m.slice(0, i) as Provider, subject: m.slice(i + 1) };
};

const LOCK_TTL_MS = 5000;
const LOCK_RETRIES = 50;
const LOCK_RETRY_MS = 20;

// Compare-and-delete so we never delete a lock that has expired and been
// re-acquired by another writer (KEYS[1]=lock key, ARGV[1]=our token).
const RELEASE_LOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

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
  await kv.eval(RELEASE_LOCK, [lockKey], [token]);
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
 * Returns null when the identity has no live owner (no index, or a dangling
 * index whose user record is gone). `reclaimDangling` deletes such a dangling
 * index — only safe to pass under the per-identity create lock, so a merely
 * in-flight create is never mistaken for a crashed one.
 */
async function resolveExisting(
  identity: VerifiedIdentity,
  reclaimDangling: boolean,
): Promise<LoginResult | null> {
  const { provider, subject } = identity;
  const ownerId = await kv.get<string>(IDX_KEY(provider, subject));
  if (!ownerId) return null;

  const user = await loadUser(ownerId);
  if (!user) {
    if (reclaimDangling) await kv.del(IDX_KEY(provider, subject));
    return null;
  }
  if (user.status !== 'active') {
    throw new IdentityStoreError('ACCOUNT_DISABLED', `User ${ownerId} is ${user.status}`);
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

  const fast = await resolveExisting(identity, false);
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
  // half-written user and the SET NX below is a valid linearisation point.
  await kv.set(USER_KEY(candidateId), user);
  await writeDetail(candidateId, identity, now);
  await kv.sadd(IDENTITIES_KEY(candidateId), member(provider, subject));

  let published = false;
  try {
    // Two attempts: the second only runs if the first NX lost to a *dangling*
    // index (owner user gone), which resolveExisting reclaims below.
    for (let attempt = 0; attempt < 2; attempt++) {
      const claimed = await kv.set(IDX_KEY(provider, subject), candidateId, { nx: true });
      if (claimed === 'OK') {
        published = true;
        return { user: await hydrate(user), isNew: true };
      }
      // Lost the election. Adopt the committed winner; if the index is dangling
      // (points at a deleted user), reclaim it and retry our own claim once.
      const winner = await resolveExisting(identity, true);
      if (winner) return winner;
    }
    throw new IdentityStoreError('USER_NOT_FOUND', 'identity owner disappeared during create');
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

/** §5.2 link a second provider to an existing internal user. */
export async function linkIdentity(userId: string, identity: VerifiedIdentity): Promise<LinkResult> {
  const { provider, subject } = identity;
  const lock = await acquireLock(userId);
  try {
    const user = await loadUser(userId);
    if (!user) throw new IdentityStoreError('USER_NOT_FOUND', userId);
    if (user.status !== 'active') throw new IdentityStoreError('ACCOUNT_DISABLED', userId);

    const members = ((await kv.smembers(IDENTITIES_KEY(userId))) as string[] | null) ?? [];
    const sameProvider = members.find((m) => splitMember(m).provider === provider);
    if (sameProvider) {
      if (sameProvider === member(provider, subject)) {
        return { user: await hydrate(user), alreadyLinked: true }; // idempotent
      }
      throw new IdentityStoreError(
        'SAME_PROVIDER_ALREADY_LINKED',
        `User already has a ${provider} identity; unlink it before linking a different one`,
      );
    }

    const priorOwner = await kv.get<string>(IDX_KEY(provider, subject));
    if (priorOwner && priorOwner !== userId) {
      throw new IdentityStoreError('IDENTITY_ALREADY_LINKED', `${provider} identity owned by ${priorOwner}`, {
        merge_token: issueMergeToken(userId, priorOwner, provider, subject),
      });
    }

    // Commit membership BEFORE publishing the login-granting index. The index is
    // the only thing login resolves through, so publishing it last means an
    // interrupted link — a crash, or even a failed rollback — can never leave an
    // index that grants login without committed membership (CR DIC-866 #2:
    // partial link fail-open). The final SET NX is the atomic first-writer guard
    // against a concurrent claim of the same (provider, subject).
    const now = new Date().toISOString();
    await writeDetail(userId, identity, now);
    await kv.sadd(IDENTITIES_KEY(userId), member(provider, subject));

    // Publish the index last. A failure here is after membership commit, so roll
    // back the now-unpublished membership best-effort; even if that rollback
    // fails, no index exists so no login can enter via it.
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
    if (members.length <= 1) {
      throw new IdentityStoreError('CANNOT_UNLINK_LAST_METHOD', 'At least one login method must remain');
    }

    const { subject } = splitMember(target);
    await kv.del(IDX_KEY(provider, subject));
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
      await kv.del(IDX_KEY(provider, subject));
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
