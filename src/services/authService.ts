import {
  AuthProvider,
  HoloUser,
  AuthTokens,
} from '../types/auth';
import { signInWithGoogle as signInWithGoogleNative } from './auth/googleAuth';

// Sign in with Apple is disabled in this path. The client cannot verify an Apple
// ID token (signature / issuer / audience / expiry / nonce) on its own, so
// trusting a decoded payload as an identity source would be insecure. iOS native
// Apple runs through appleAuth; Web Apple is DIC-663. Either way identity must be
// verified server-side before it is trusted.
export const APPLE_LOGIN_ENABLED = false;

const APPLE_DISABLED_MESSAGE =
  'Apple 登入尚未開放（需後端驗證 Apple ID token）。請改用 Google 登入。';

// Account linking is not yet server-authoritative. The previous client-side
// implementation ran a browser OAuth flow, trusted the provider's `userinfo.sub`
// (unverified), and wrote the merged identity to localStorage only — none of
// which is a trustworthy identity boundary. It is fail-closed here until a
// backend endpoint verifies the second provider's token and updates the same
// server-side (provider, sub) identity store with uniqueness/race safety.
const LINK_NOT_IMPLEMENTED_MESSAGE =
  '帳號綁定尚未開放（需後端權威驗證與 (provider, sub) 身份儲存）。';

const GOOGLE_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID
  || process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID
  || '';

const APPLE_CLIENT_ID = process.env.EXPO_PUBLIC_APPLE_SERVICE_ID || '';

export interface SignInResult {
  user: HoloUser;
  tokens: AuthTokens;
  isNewUser: boolean;
}

function loadLocalUsers(): HoloUser[] {
  try {
    const raw = localStorage.getItem('holohunter-users');
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveLocalUsers(users: HoloUser[]): void {
  try {
    localStorage.setItem('holohunter-users', JSON.stringify(users));
  } catch {}
}

export async function signInWithProvider(provider: AuthProvider): Promise<SignInResult> {
  if (provider === 'apple') {
    // Apple 登入未在此路徑實作：iOS 原生 Apple 走 appleAuth（原生流程），
    // Web Apple 屬 DIC-663。無論如何都需後端驗證 Apple id_token，client 不自行信任。
    throw new Error(APPLE_DISABLED_MESSAGE);
  }

  // Google（Android 第一優先）：原生 Sign-In 取 id_token（帶 server-bound nonce）→ 後端
  // /api/auth/login 驗簽 / iss / aud / exp / nonce 後，以 (google, sub) 找/建 internal
  // user 並簽發 app session。internal user id 與 session 一律由後端權威決定，client 不 mint
  // 身份、不信任本地解碼 payload、也不寫入本機 users。
  const backend = await signInWithGoogleNative();

  const user: HoloUser = {
    internalId: backend.user.internalId,
    displayName: backend.user.displayName ?? '',
    primaryEmail: backend.user.primaryEmail ?? undefined,
    photoUrl: backend.user.photoUrl ?? undefined,
    linkedProviders: backend.user.linkedProviders.map((p) => ({
      provider: p.provider as AuthProvider,
      providerId: p.providerId,
      email: p.email ?? '',
      displayName: p.displayName ?? '',
      photoUrl: p.photoUrl ?? undefined,
      linkedAt: p.linkedAt,
    })),
    createdAt: backend.user.createdAt,
  };

  const tokens: AuthTokens = {
    accessToken: backend.accessToken,
    refreshToken: backend.refreshToken ?? undefined,
    expiresAt: backend.expiresAt,
    provider: 'google',
  };

  return { user, tokens, isNewUser: backend.isNewUser };
}

/**
 * 帳號綁定：fail-closed。尚未有後端權威綁定端點（驗第二 provider 的 token、以
 * (provider, sub) 更新伺服器端身份、處理唯一性 / 競態）。在此之前不提供 client-side 綁定，
 * 以免以未驗證的身份寫入本機而被信任。
 */
export async function linkProvider(
  _currentUser: HoloUser,
  provider: AuthProvider,
): Promise<HoloUser> {
  if (provider === 'apple' && !APPLE_LOGIN_ENABLED) {
    throw new Error(APPLE_DISABLED_MESSAGE);
  }
  throw new Error(LINK_NOT_IMPLEMENTED_MESSAGE);
}

export async function unlinkProvider(
  currentUser: HoloUser,
  provider: AuthProvider,
): Promise<HoloUser> {
  if (currentUser.linkedProviders.length <= 1) {
    throw new Error('Cannot unlink the only login method. Add another provider first.');
  }

  const updatedProviders = currentUser.linkedProviders.filter((p) => p.provider !== provider);

  if (updatedProviders.length === currentUser.linkedProviders.length) {
    throw new Error(`No ${provider} provider linked to this account.`);
  }

  const updatedUser: HoloUser = {
    ...currentUser,
    linkedProviders: updatedProviders,
    primaryEmail: updatedProviders[0]?.email || undefined,
  };

  const allUsers = loadLocalUsers();
  const userIndex = allUsers.findIndex((u) => u.internalId === currentUser.internalId);
  if (userIndex >= 0) {
    allUsers[userIndex] = updatedUser;
    saveLocalUsers(allUsers);
  }

  return updatedUser;
}

export async function deleteAccount(currentUser: HoloUser): Promise<void> {
  try {
    const allUsers = loadLocalUsers();
    const filtered = allUsers.filter((u) => u.internalId !== currentUser.internalId);
    saveLocalUsers(filtered);
  } catch {
    throw new Error('Failed to delete account data.');
  }
}

export async function providerSignOut(tokens: AuthTokens | null): Promise<void> {
  if (!tokens?.accessToken) return;
  const revokeUrl = tokens.provider === 'google'
    ? 'https://oauth2.googleapis.com/revoke'
    : 'https://appleid.apple.com/auth/revoke';
  try {
    await fetch(revokeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${tokens.accessToken}&client_id=${tokens.provider === 'google' ? GOOGLE_CLIENT_ID : APPLE_CLIENT_ID}`,
    });
  } catch {}
}
