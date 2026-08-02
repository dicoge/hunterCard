import { Platform } from 'react-native';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import platformStorage from '../stores/storage';
import {
  AuthProvider,
  ProviderUserInfo,
  GoogleUser,
  AppleUser,
  LinkedIdentity,
  HoloUser,
  AuthTokens,
} from '../types/auth';
import {
  signInWithApple as signInWithAppleNative,
  isAppleAuthAvailable,
  APPLE_CANCEL_CODE,
} from './auth/appleAuth';
import { registerAppleSession, requestAccountDeletion } from './auth';

// Re-exported so the auth store can check credential state / detect user cancel
// without importing the native module directly.
export { isAppleCredentialAuthorized } from './auth/appleAuth';
export { APPLE_CANCEL_CODE } from './auth/appleAuth';

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

const GOOGLE_WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID
  || process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID
  || '';

const GOOGLE_IOS_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || '';

// iOS 用 iOS OAuth client（reversed-client-id 自訂 scheme 導回）；其餘平台用 web client。
// 對齊 AUTH-Architecture §6.1：各平台 aud 對應不同 client id。
function googleClientId(): string {
  if (Platform.OS === 'ios' && GOOGLE_IOS_CLIENT_ID) return GOOGLE_IOS_CLIENT_ID;
  return GOOGLE_WEB_CLIENT_ID;
}

// iOS OAuth client 的 redirect 必須是 reversed client id 的自訂 URL scheme
// （com.googleusercontent.apps.XXXX:/oauthredirect）。其餘平台用預設 redirect。
function googleRedirectUri(): string {
  if (Platform.OS === 'ios' && GOOGLE_IOS_CLIENT_ID) {
    const reversed = GOOGLE_IOS_CLIENT_ID.split('.').reverse().join('.');
    return AuthSession.makeRedirectUri({ native: `${reversed}:/oauthredirect` });
  }
  return AuthSession.makeRedirectUri();
}

const APPLE_CLIENT_ID = process.env.EXPO_PUBLIC_APPLE_SERVICE_ID || '';

// **Web** Sign in with Apple is disabled in this PoC. A browser client cannot
// verify the Apple ID token (signature / issuer / audience / expiry / nonce) on
// its own, so trusting the decoded payload as an identity source would be
// insecure. Re-enable only once token verification runs server-side. Web Apple
// login is optional per the product spec (Google is the required web provider).
//
// This flag does NOT gate **native iOS** Apple login: iOS uses the native
// `expo-apple-authentication` flow (see signInWithProvider), which returns a
// trusted Apple `sub` from the OS without any client-side JWT decoding.
export const APPLE_LOGIN_ENABLED = false;

const APPLE_DISABLED_MESSAGE =
  'Apple 登入尚未開放（需後端驗證 Apple ID token）。請改用 Google 登入。';

/** iOS 上是否可用原生 Sign in with Apple。 */
async function canUseNativeApple(): Promise<boolean> {
  return Platform.OS === 'ios' && (await isAppleAuthAvailable());
}

/**
 * 觸發原生 Sign in with Apple 並映射成共通模型所需的 ProviderUserInfo。
 * Apple 只在「首次」授權回傳 name / email；後續登入為 null——呼叫端據此保留既有值
 * （見 findOrCreateHoloUser）。email 可能為 private relay 或被隱藏，一律不作唯一身份。
 * 使用者取消時 re-throw 帶 APPLE_CANCEL_CODE 的錯誤，讓上層靜默處理。
 */
async function signInWithAppleProviderInfo(): Promise<{
  info: ProviderUserInfo;
  tokens: AuthTokens;
  authorizationCode: string | null;
}> {
  let session;
  try {
    session = await signInWithAppleNative();
  } catch (err: any) {
    if (err?.code === APPLE_CANCEL_CODE) {
      throw Object.assign(new Error('已取消 Apple 登入'), { code: APPLE_CANCEL_CODE });
    }
    throw err;
  }
  const email = session.user.email ?? '';
  const name = session.user.name || email || 'Apple 使用者';
  return {
    info: { id: session.user.id, email, name },
    tokens: {
      accessToken: session.identityToken ?? '',
      expiresAt: Date.now() + 3600 * 1000,
      provider: 'apple',
    },
    authorizationCode: session.authorizationCode,
  };
}

const googleScopes = ['openid', 'profile', 'email'];
const appleScopes = ['name', 'email'];

function generateUserId(): string {
  return 'holo_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

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

async function findOrCreateHoloUser(providerInfo: ProviderUserInfo, provider: AuthProvider): Promise<{ user: HoloUser; isNew: boolean }> {
  const existing = await loadLocalUsers();
  let user = existing.find((u) =>
    u.linkedProviders.some((p) => p.provider === provider && p.providerId === providerInfo.id)
  );

  if (user) {
    const identity = user.linkedProviders.find((p) => p.provider === provider)!;
    // Returning Apple logins (and any provider that hides email) return null
    // name / email — only overwrite when the provider actually supplied a value,
    // otherwise we would wipe the values captured on first authorization.
    if (providerInfo.email) identity.email = providerInfo.email;
    if (providerInfo.name) identity.displayName = providerInfo.name;
    if (providerInfo.picture) identity.photoUrl = providerInfo.picture;
    await saveLocalUsers(existing);
    return { user, isNew: false };
  }

  const newUser: HoloUser = {
    internalId: generateUserId(),
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

  existing.push(newUser);
  await saveLocalUsers(existing);
  return { user: newUser, isNew: true };
}

const USERS_STORAGE_KEY = 'holohunter-users';

// The local "users table" that fakes the server-side identity store for this
// PoC. Backed by platformStorage so it works on both web (localStorage) and
// native iOS/Android (AsyncStorage) — the previous direct localStorage access
// crashed on React Native.
async function loadLocalUsers(): Promise<HoloUser[]> {
  try {
    const raw = await platformStorage.getItem(USERS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function saveLocalUsers(users: HoloUser[]): Promise<void> {
  try {
    await platformStorage.setItem(USERS_STORAGE_KEY, JSON.stringify(users));
  } catch {}
}

export async function signInWithProvider(provider: AuthProvider): Promise<SignInResult> {
  // iOS Apple → native Sign in with Apple (App Store 規範，且回傳可信 sub 無需 client 解 JWT)。
  if (provider === 'apple' && (await canUseNativeApple())) {
    const { info, tokens, authorizationCode } = await signInWithAppleProviderInfo();
    const { user, isNew } = await findOrCreateHoloUser(info, 'apple');
    // best-effort：把 fresh authorizationCode 送後端換 refresh_token，供日後刪除撤銷用。
    await registerAppleSession({
      user: { id: info.id, provider: 'apple', name: info.name, email: info.email || null },
      identityToken: tokens.accessToken || null,
      authorizationCode,
      createdAt: new Date().toISOString(),
    });
    return { user, tokens, isNewUser: isNew };
  }

  if (provider === 'apple' && !APPLE_LOGIN_ENABLED) {
    throw new Error(APPLE_DISABLED_MESSAGE);
  }
  const clientId = provider === 'google' ? googleClientId() : APPLE_CLIENT_ID;
  if (!clientId) {
    throw new Error(
      `Missing client ID for ${provider}. Set ${provider === 'google' ? 'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID / EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID' : 'EXPO_PUBLIC_APPLE_SERVICE_ID'} in .env`
    );
  }

  const redirectUri = provider === 'google' ? googleRedirectUri() : AuthSession.makeRedirectUri();
  const scopes = provider === 'google' ? googleScopes : appleScopes;
  const discovery = provider === 'google' ? googleDiscovery : appleDiscovery;

  const authRequest = new AuthSession.AuthRequest({
    clientId,
    scopes,
    redirectUri,
    usePKCE: true,
    extraParams: provider === 'apple'
      ? { response_mode: 'form_post' }
      : undefined,
  });

  const result = await authRequest.promptAsync(discovery);
  if (result.type !== 'success') {
    throw new Error(result.type === 'cancel' ? 'User cancelled login' : `Auth failed: ${result.type}`);
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

  const { user, isNew } = await findOrCreateHoloUser(providerInfo, provider);
  return { user, tokens, isNewUser: isNew };
}

export async function linkProvider(
  currentUser: HoloUser,
  provider: AuthProvider,
): Promise<HoloUser> {
  let providerInfo: ProviderUserInfo;

  if (provider === 'apple' && (await canUseNativeApple())) {
    // iOS：原生 Sign in with Apple 取得欲綁定的 Apple identity（sub）。
    const { info } = await signInWithAppleProviderInfo();
    providerInfo = info;
  } else {
    if (provider === 'apple' && !APPLE_LOGIN_ENABLED) {
      throw new Error(APPLE_DISABLED_MESSAGE);
    }
    const clientId = provider === 'google' ? googleClientId() : APPLE_CLIENT_ID;
    if (!clientId) {
      throw new Error(`Missing client ID for ${provider}`);
    }

    const redirectUri = provider === 'google' ? googleRedirectUri() : AuthSession.makeRedirectUri();
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
  }

  const allUsers = await loadLocalUsers();
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
    await saveLocalUsers(allUsers);
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

  const allUsers = await loadLocalUsers();
  const userIndex = allUsers.findIndex((u) => u.internalId === currentUser.internalId);
  if (userIndex >= 0) {
    allUsers[userIndex] = updatedUser;
    await saveLocalUsers(allUsers);
  }

  return updatedUser;
}

export async function deleteAccount(currentUser: HoloUser): Promise<void> {
  // App Store 5.1.1(v)：iOS 上以 Apple 登入者，刪除帳號時需撤銷 Apple 授權。
  // best-effort 通知後端撤銷（後端 refresh_token 儲存目前為 foundation stub，會回
  // 501；不阻擋本機刪除，以確保「App 內可刪除帳號」這條硬性規範可運作）。
  if (Platform.OS === 'ios') {
    const apple = currentUser.linkedProviders.find((p) => p.provider === 'apple');
    if (apple) {
      try {
        await requestAccountDeletion({
          user: {
            id: apple.providerId,
            provider: 'apple',
            name: apple.displayName ?? null,
            email: apple.email ?? null,
          },
          identityToken: null,
          authorizationCode: null,
          createdAt: new Date().toISOString(),
        });
      } catch {
        // best-effort：後端撤銷失敗不阻擋本機資料刪除。
      }
    }
  }

  try {
    const allUsers = await loadLocalUsers();
    const filtered = allUsers.filter((u) => u.internalId !== currentUser.internalId);
    await saveLocalUsers(filtered);
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
  const allUsers = await loadLocalUsers();
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
      body: `token=${tokens.accessToken}&client_id=${tokens.provider === 'google' ? googleClientId() : APPLE_CLIENT_ID}`,
    });
  } catch {}
}
