import { Platform } from 'react-native';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import platformStorage from '../stores/storage';
import {
  AuthProvider,
  ProviderUserInfo,
  GoogleUser,
  AppleUser,
  HoloUser,
  AuthTokens,
} from '../types/auth';
import {
  signInWithApple as signInWithAppleNative,
  isAppleAuthAvailable,
  APPLE_CANCEL_CODE,
} from './auth/appleAuth';
import { registerAppleSession, requestAccountDeletion } from './auth';
import {
  IdentityStorage,
  loadUsers,
  saveUsers,
  findOrCreateUser,
  linkIdentity,
  unlinkIdentity,
} from './auth/identityStore';

// Re-exported so the auth store can check credential state / detect user cancel
// without importing the native module directly.
export { getAppleCredentialStatus } from './auth/appleAuth';
export type { AppleCredentialStatus } from './auth/appleAuth';
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
//
// **fail closed on iOS**：iOS 不能退回 web client——web client 的 aud 與導回 URI 與
// 原生流程不符，會導致 token 的 aud 錯誤 / 導回失敗。缺 iOS client id 時直接拋錯，
// 不靜默降級（CR DIC-855 #3）。
function googleClientId(): string {
  if (Platform.OS === 'ios') {
    if (!GOOGLE_IOS_CLIENT_ID) {
      throw new Error(
        'Missing EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID. iOS Google 登入必須使用 iOS OAuth client；' +
        '不可退回 web client。請於 .env / Vercel 設定 iOS client id。'
      );
    }
    return GOOGLE_IOS_CLIENT_ID;
  }
  if (!GOOGLE_WEB_CLIENT_ID) {
    throw new Error('Missing EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID for Google 登入。');
  }
  return GOOGLE_WEB_CLIENT_ID;
}

// iOS OAuth client 的 redirect 必須是 reversed client id 的自訂 URL scheme
// （com.googleusercontent.apps.XXXX:/oauthredirect），且該 scheme 必須註冊在
// app.config.js 的 iOS CFBundleURLTypes（見 app.config.js）。其餘平台用預設 redirect。
function googleRedirectUri(): string {
  if (Platform.OS === 'ios') {
    const reversed = googleClientId().split('.').reverse().join('.');
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

// Adapter so the zustand StateStorage (web localStorage / native AsyncStorage)
// satisfies the identity store's async KV surface with normalized return types.
const identityStorage: IdentityStorage = {
  getItem: async (key) => (await platformStorage.getItem(key)) ?? null,
  setItem: async (key, value) => {
    await platformStorage.setItem(key, value);
  },
};

// The local "users table" that fakes the server-side identity store for this
// PoC. Identity invariants live in ./auth/identityStore (unit-tested); this file
// only wires them to platform storage and the OAuth/native flows.
async function loadLocalUsers(): Promise<HoloUser[]> {
  try {
    return await loadUsers(identityStorage);
  } catch {
    return [];
  }
}

async function saveLocalUsers(users: HoloUser[]): Promise<void> {
  try {
    await saveUsers(identityStorage, users);
  } catch {}
}

async function findOrCreateHoloUser(providerInfo: ProviderUserInfo, provider: AuthProvider): Promise<{ user: HoloUser; isNew: boolean }> {
  const existing = await loadLocalUsers();
  const { users, user, isNew } = findOrCreateUser(existing, providerInfo, provider);
  await saveLocalUsers(users);
  return { user, isNew };
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
    // 綁定同樣要保存 fresh authorizationCode，供日後刪除撤銷用（與登入流程一致，
    // CR DIC-855 #5）——否則綁進來的 Apple 帳號日後無法被 App 撤銷。
    const { info, tokens, authorizationCode } = await signInWithAppleProviderInfo();
    providerInfo = info;
    await registerAppleSession({
      user: { id: info.id, provider: 'apple', name: info.name, email: info.email || null },
      identityToken: tokens.accessToken || null,
      authorizationCode,
      createdAt: new Date().toISOString(),
    });
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
  const { users, user } = linkIdentity(allUsers, currentUser, providerInfo, provider);
  await saveLocalUsers(users);
  return user;
}

export async function unlinkProvider(
  currentUser: HoloUser,
  provider: AuthProvider,
): Promise<HoloUser> {
  const allUsers = await loadLocalUsers();
  const { users, user } = unlinkIdentity(allUsers, currentUser, provider);
  await saveLocalUsers(users);
  return user;
}

export interface DeleteAccountResult {
  /** 本機使用者資料是否已刪除（本裝置的 identity store 記錄）。 */
  localDataDeleted: boolean;
  /**
   * 後端是否已「確認」撤銷 Apple 授權並刪除伺服器端資料。
   * 目前後端 refresh_token 儲存為 foundation stub（回 501），因此 iOS Apple 使用者
   * 一般為 false——呼叫端**不得**據此宣稱「帳號已完全刪除 / Apple 授權已撤銷」。
   * 非 iOS / 無 Apple provider 者為 true（無需伺服器撤銷）。
   */
  serverRevoked: boolean;
  /** serverRevoked 為 false 時的原因（例：apple_deletion_not_implemented）。 */
  reason?: string;
}

/**
 * 刪除帳號。
 *
 * 誠實回報（CR DIC-855 #2）：本機資料一定會刪除，但**不**把 501 / stub / local-only
 * 當成「已撤銷 Apple 授權 / 伺服器已刪除」。iOS Apple 使用者若後端未確認撤銷，
 * `serverRevoked` 回 false 並帶 reason，由呼叫端據實告知使用者，切勿宣稱已完成。
 *
 * 真正的 fail-closed 伺服器撤銷需 DIC-662 後端 identity/token store 上線（見已知限制）。
 */
export async function deleteAccount(currentUser: HoloUser): Promise<DeleteAccountResult> {
  let serverRevoked = true;
  let reason: string | undefined;

  if (Platform.OS === 'ios') {
    const apple = currentUser.linkedProviders.find((p) => p.provider === 'apple');
    if (apple) {
      // 尚無伺服器確認的撤銷：預設為未撤銷，只有後端回 ok:true 才翻成 true。
      serverRevoked = false;
      reason = 'apple_revocation_unconfirmed';
      try {
        const res = await requestAccountDeletion({
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
        serverRevoked = res.ok;
        reason = res.ok ? undefined : (res.reason ?? 'apple_revocation_unconfirmed');
      } catch {
        serverRevoked = false;
        reason = 'network_error';
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

  return { localDataDeleted: true, serverRevoked, reason };
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
