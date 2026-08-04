import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import {
  AuthProvider,
  ProviderUserInfo,
  GoogleUser,
  AppleUser,
  LinkedIdentity,
  HoloUser,
  AuthTokens,
} from '../types/auth';
import { signInWithGoogle as signInWithGoogleNative } from './auth/googleAuth';

WebBrowser.maybeCompleteAuthSession();

const googleDiscovery = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
};

const appleDiscovery = {
  authorizationEndpoint: 'https://appleid.apple.com/auth/authorize',
  tokenEndpoint: 'https://appleid.apple.com/auth/token',
  revocationEndpoint: 'https://appleid.apple.com/auth/revoke',
};

const GOOGLE_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID
  || process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID
  || '';

const APPLE_CLIENT_ID = process.env.EXPO_PUBLIC_APPLE_SERVICE_ID || '';

// Sign in with Apple is disabled in this web PoC. The client cannot verify the
// Apple ID token (signature / issuer / audience / expiry / nonce) on its own, so
// trusting the decoded payload as an identity source would be insecure. Re-enable
// only once token verification runs server-side. Web Apple login is optional per
// the product spec (Google is the required web provider).
export const APPLE_LOGIN_ENABLED = false;

const APPLE_DISABLED_MESSAGE =
  'Apple 登入尚未開放（需後端驗證 Apple ID token）。請改用 Google 登入。';

const googleScopes = ['openid', 'profile', 'email'];
const appleScopes = ['name', 'email'];

async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleUser> {
  const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch Google user info: ${response.status}`);
  }
  const data = await response.json();
  return {
    id: data.sub,
    email: data.email,
    name: data.name,
    givenName: data.given_name,
    familyName: data.family_name,
    picture: data.picture,
  };
}

// NOTE: this only base64-decodes the JWT payload — it does NOT verify the
// signature, issuer, audience, expiry, or nonce. It must never be used as a
// trusted identity source from the client. Kept for reference for the future
// server-verified Apple flow; gated behind APPLE_LOGIN_ENABLED.
function parseAppleIdToken(idToken: string): AppleUser {
  const payload = JSON.parse(atob(idToken.split('.')[1]));
  return {
    id: payload.sub,
    email: payload.email || '',
    name: payload.name || payload.email || 'Apple User',
    realUserStatus: payload.real_user_status,
  };
}

async function exchangeOAuthCode(
  clientId: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
  provider: AuthProvider,
): Promise<AuthTokens> {
  const discovery = provider === 'google' ? googleDiscovery : appleDiscovery;
  const tokenResponse = await AuthSession.exchangeCodeAsync(
    {
      clientId,
      code,
      redirectUri,
      extraParams: { code_verifier: codeVerifier },
    },
    discovery,
  );
  return {
    accessToken: tokenResponse.accessToken,
    refreshToken: tokenResponse.refreshToken ?? undefined,
    expiresAt: Date.now() + (tokenResponse.expiresIn ?? 3600) * 1000,
    provider,
  };
}

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

  // Google（Android 第一優先）：原生 Sign-In 取 id_token → 後端 /api/auth/login
  // 驗證簽章 / iss / aud / exp 後，以 (google, sub) 找/建 internal user 並簽發 app
  // session。internal user id 與 session 一律由後端權威決定，client 不 mint 身份、
  // 不再寫入本機 users（移除舊的 localStorage client-mint 信任路徑）。
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

export async function linkProvider(
  currentUser: HoloUser,
  provider: AuthProvider,
): Promise<HoloUser> {
  if (provider === 'apple' && !APPLE_LOGIN_ENABLED) {
    throw new Error(APPLE_DISABLED_MESSAGE);
  }
  const clientId = provider === 'google' ? GOOGLE_CLIENT_ID : APPLE_CLIENT_ID;
  if (!clientId) {
    throw new Error(`Missing client ID for ${provider}`);
  }

  const redirectUri = AuthSession.makeRedirectUri();
  const scopes = provider === 'google' ? googleScopes : appleScopes;
  const discovery = provider === 'google' ? googleDiscovery : appleDiscovery;

  const authRequest = new AuthSession.AuthRequest({
    clientId,
    scopes,
    redirectUri,
    usePKCE: true,
    extraParams: { login_hint: currentUser.primaryEmail || '' },
  });

  const result = await authRequest.promptAsync(discovery);
  if (result.type !== 'success') {
    throw new Error(result.type === 'cancel' ? 'User cancelled linking' : `Link failed: ${result.type}`);
  }

  const code = result.params.code;
  if (!code) throw new Error('No authorization code returned');

  const codeVerifier = authRequest.codeVerifier;
  if (!codeVerifier) throw new Error('PKCE code verifier missing');

  const tokens = await exchangeOAuthCode(clientId, code, codeVerifier, redirectUri, provider);

  let providerInfo: ProviderUserInfo;
  if (provider === 'google') {
    providerInfo = await fetchGoogleUserInfo(tokens.accessToken);
  } else {
    const idToken = result.params.id_token;
    if (!idToken) throw new Error('No id_token returned from Apple');
    const appleUser = parseAppleIdToken(idToken as string);
    providerInfo = {
      id: appleUser.id,
      email: appleUser.email,
      name: appleUser.name,
    };
  }

  const allUsers = loadLocalUsers();
  const collisionUser = allUsers.find(
    (u) => u.internalId !== currentUser.internalId &&
      u.linkedProviders.some((p) => p.provider === provider && p.providerId === providerInfo.id)
  );

  if (collisionUser) {
    throw new Error(
      `This ${provider} account is already linked to another HoloHunter account. ` +
      `Please unlink it from the other account first.`
    );
  }

  const alreadyLinked = currentUser.linkedProviders.some(
    (p) => p.provider === provider && p.providerId === providerInfo.id
  );
  if (alreadyLinked) {
    throw new Error(`This ${provider} account is already linked to your account.`);
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

  const userIndex = allUsers.findIndex((u) => u.internalId === currentUser.internalId);
  if (userIndex >= 0) {
    allUsers[userIndex] = updatedUser;
    saveLocalUsers(allUsers);
  }

  return updatedUser;
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

export interface CollisionResolution {
  user: HoloUser;
  action: 'linked' | 'rejected';
  reason?: string;
}

export async function resolveCollision(
  currentUser: HoloUser,
  newProvider: AuthProvider,
  newProviderInfo: ProviderUserInfo,
  strategy: 'reject' | 'merge_into_existing' | 'transfer_to_new',
): Promise<CollisionResolution> {
  const allUsers = loadLocalUsers();
  const collisionUser = allUsers.find(
    (u) => u.internalId !== currentUser.internalId &&
      u.linkedProviders.some((p) => p.provider === newProvider && p.providerId === newProviderInfo.id)
  );

  if (!collisionUser) {
    throw new Error('No collision detected.');
  }

  switch (strategy) {
    case 'reject':
      return { user: currentUser, action: 'rejected', reason: `Already linked to account ${collisionUser.internalId}` };

    case 'merge_into_existing':
      const mergedProviders = [
        ...collisionUser.linkedProviders,
        ...currentUser.linkedProviders.filter(
          (cp) => !collisionUser.linkedProviders.some((ep) => ep.provider === cp.provider)
        ),
      ];
      allUsers.splice(allUsers.findIndex((u) => u.internalId === currentUser.internalId), 1);
      collisionUser.linkedProviders = mergedProviders;
      collisionUser.displayName = currentUser.displayName || collisionUser.displayName;
      collisionUser.photoUrl = currentUser.photoUrl || collisionUser.photoUrl;
      saveLocalUsers(allUsers);
      return { user: collisionUser, action: 'linked' };

    default:
      return { user: currentUser, action: 'rejected', reason: 'Unsupported resolution strategy' };
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
