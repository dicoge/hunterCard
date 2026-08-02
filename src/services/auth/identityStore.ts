/**
 * Platform-free identity-table logic for the common HoloUser account model.
 *
 * This is the PoC stand-in for the DIC-662 server-authoritative identity store.
 * It is intentionally decoupled from React Native / Expo / OAuth so the identity
 * invariants can be unit-tested under plain Node (see scripts/test-identity-store.mjs)
 * and later swapped for real server endpoints without touching the invariants.
 *
 * Invariants enforced here (CR DIC-855 #4/#7):
 *  - Identity uniqueness key is (provider, providerId=sub) — NEVER email. Apple
 *    private relay / hidden / mismatched emails must not merge or split accounts.
 *  - Returning logins that omit name/email (Apple after first auth) must not wipe
 *    values captured on first authorization.
 *  - Linking the same (provider, sub) that belongs to another user is a collision
 *    and must be rejected (no silent merge).
 *  - Unlinking must always leave at least one login method.
 *
 * NOTE: This module must import TYPES ONLY (no runtime imports) so it can be run
 * directly by `node --experimental-strip-types` in tests.
 */
import type { AuthProvider, ProviderUserInfo, HoloUser, LinkedIdentity } from '../../types/auth';

export const USERS_STORAGE_KEY = 'holohunter-users';

/** Minimal async KV surface (web localStorage / native AsyncStorage / test fake). */
export interface IdentityStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export async function loadUsers(storage: IdentityStorage): Promise<HoloUser[]> {
  const raw = await storage.getItem(USERS_STORAGE_KEY);
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as HoloUser[]) : [];
}

export async function saveUsers(storage: IdentityStorage, users: HoloUser[]): Promise<void> {
  await storage.setItem(USERS_STORAGE_KEY, JSON.stringify(users));
}

function matchesIdentity(user: HoloUser, provider: AuthProvider, providerId: string): boolean {
  return user.linkedProviders.some((p) => p.provider === provider && p.providerId === providerId);
}

function generateInternalId(): string {
  return 'holo_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export interface FindOrCreateResult {
  users: HoloUser[];
  user: HoloUser;
  isNew: boolean;
}

/**
 * Resolve a login to a HoloUser by (provider, sub). Creates a new user on first
 * sight. On a returning login, only overwrites name/email/photo when the provider
 * actually supplied a value (Apple returns null after first auth).
 *
 * Returns the (possibly mutated) users array; caller persists it.
 */
export function findOrCreateUser(
  users: HoloUser[],
  providerInfo: ProviderUserInfo,
  provider: AuthProvider,
): FindOrCreateResult {
  const existing = users.find((u) => matchesIdentity(u, provider, providerInfo.id));

  if (existing) {
    const identity = existing.linkedProviders.find((p) => p.provider === provider && p.providerId === providerInfo.id)!;
    if (providerInfo.email) identity.email = providerInfo.email;
    if (providerInfo.name) identity.displayName = providerInfo.name;
    if (providerInfo.picture) identity.photoUrl = providerInfo.picture;
    return { users, user: existing, isNew: false };
  }

  const newUser: HoloUser = {
    internalId: generateInternalId(),
    displayName: providerInfo.name,
    primaryEmail: providerInfo.email,
    photoUrl: providerInfo.picture,
    linkedProviders: [
      {
        provider,
        providerId: providerInfo.id,
        email: providerInfo.email,
        displayName: providerInfo.name,
        photoUrl: providerInfo.picture,
        linkedAt: new Date().toISOString(),
      },
    ],
    createdAt: new Date().toISOString(),
  };

  return { users: [...users, newUser], user: newUser, isNew: true };
}

export class ProviderCollisionError extends Error {
  provider: AuthProvider;
  constructor(provider: AuthProvider) {
    super(
      `This ${provider} account is already linked to another HoloHunter account. ` +
      `Please unlink it from the other account first.`
    );
    this.name = 'ProviderCollisionError';
    this.provider = provider;
  }
}

export class AlreadyLinkedError extends Error {
  provider: AuthProvider;
  constructor(provider: AuthProvider) {
    super(`This ${provider} account is already linked to your account.`);
    this.name = 'AlreadyLinkedError';
    this.provider = provider;
  }
}

export class LastProviderError extends Error {
  constructor() {
    super('Cannot unlink the only login method. Add another provider first.');
    this.name = 'LastProviderError';
  }
}

export class ProviderNotLinkedError extends Error {
  provider: AuthProvider;
  constructor(provider: AuthProvider) {
    super(`No ${provider} provider linked to this account.`);
    this.name = 'ProviderNotLinkedError';
    this.provider = provider;
  }
}

export interface LinkResult {
  users: HoloUser[];
  user: HoloUser;
}

/**
 * Link a second provider identity onto currentUser under the same internalId.
 * Throws on collision (identity owned by a different user) or if already linked.
 */
export function linkIdentity(
  users: HoloUser[],
  currentUser: HoloUser,
  providerInfo: ProviderUserInfo,
  provider: AuthProvider,
): LinkResult {
  const collision = users.find(
    (u) => u.internalId !== currentUser.internalId && matchesIdentity(u, provider, providerInfo.id),
  );
  if (collision) throw new ProviderCollisionError(provider);

  if (matchesIdentity(currentUser, provider, providerInfo.id)) {
    throw new AlreadyLinkedError(provider);
  }

  const newIdentity: LinkedIdentity = {
    provider,
    providerId: providerInfo.id,
    email: providerInfo.email,
    displayName: providerInfo.name,
    photoUrl: providerInfo.picture,
    linkedAt: new Date().toISOString(),
  };

  const updatedUser: HoloUser = {
    ...currentUser,
    linkedProviders: [...currentUser.linkedProviders, newIdentity],
    photoUrl: currentUser.photoUrl || providerInfo.picture,
  };

  const nextUsers = users.map((u) => (u.internalId === currentUser.internalId ? updatedUser : u));
  return { users: nextUsers, user: updatedUser };
}

/**
 * Unlink a provider, always preserving at least one login method.
 * Throws LastProviderError if it would remove the last one.
 */
export function unlinkIdentity(
  users: HoloUser[],
  currentUser: HoloUser,
  provider: AuthProvider,
): LinkResult {
  if (currentUser.linkedProviders.length <= 1) throw new LastProviderError();

  const remaining = currentUser.linkedProviders.filter((p) => p.provider !== provider);
  if (remaining.length === currentUser.linkedProviders.length) {
    throw new ProviderNotLinkedError(provider);
  }

  const updatedUser: HoloUser = {
    ...currentUser,
    linkedProviders: remaining,
    primaryEmail: remaining[0]?.email || undefined,
  };

  const nextUsers = users.map((u) => (u.internalId === currentUser.internalId ? updatedUser : u));
  return { users: nextUsers, user: updatedUser };
}
