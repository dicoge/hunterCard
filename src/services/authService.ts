import { Platform } from 'react-native';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import * as Crypto from 'expo-crypto';
import {
  AuthProvider,
  LinkedIdentity,
  HoloUser,
} from '../types/auth';
import { appleLoginSurface, googleLoginSurface } from './authStrategy';

WebBrowser.maybeCompleteAuthSession();

// Server-authoritative web auth (DIC-663). The client only runs the OAuth/OIDC
// prompt to obtain a provider ID token; identity resolution and all data
// ownership live on the server (api/auth/*). We never treat browser-local state
// as the source of truth, and we never report success unless the server
// confirms it (fail-closed).

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

// Native iOS uses a dedicated Google OAuth iOS client (its own client id +
// reversed-client-id redirect scheme), not the Web client.
const GOOGLE_IOS_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || '';

const APPLE_CLIENT_ID = process.env.EXPO_PUBLIC_APPLE_SERVICE_ID || '';

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL || '/api';

// Web Sign in with Apple stays gated: the browser cannot verify an Apple ID
// token, so it requires the server verify path (Services ID + backend secret).
const APPLE_WEB_ENABLED = process.env.EXPO_PUBLIC_APPLE_WEB_LOGIN_ENABLED === 'true';

// Apple login is delivered NATIVELY on iOS (expo-apple-authentication → backend
// RS256 verify against the app bundle id) and needs no Services ID. On web it is
// only offered once APPLE_WEB_ENABLED; on Android it is hard-disabled regardless
// of the flag (DIC-665 / DIC-920). Deriving this from the SAME pure surface
// function that dispatch uses keeps the UI and the runtime in lockstep — the
// button is hidden exactly when the surface is 'disabled', never shown as a
// nonfunctional entry (DIC-866 acceptance #5).
export const APPLE_LOGIN_ENABLED = appleLoginSurface(Platform.OS, APPLE_WEB_ENABLED) !== 'disabled';

export const APPLE_DISABLED_MESSAGE =
  'Apple 登入尚未開放（需後端驗證 Apple ID token）。請改用 Google 登入。';

const googleScopes = ['openid', 'profile', 'email'];
const appleScopes = ['openid', 'name', 'email'];

// CSPRNG nonce (expo-crypto). Math.random() is not cryptographically secure and
// must not be used to mint an OIDC nonce; 16 random bytes hex-encoded gives 128
// bits of entropy. Used for the iOS/web OIDC nonce that the backend binds against
// the ID token's `nonce` claim.
function randomNonce(): string {
  const bytes = Crypto.getRandomBytes(16);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

const PROVIDER_ERROR_MESSAGES: Record<string, (provider?: string) => string> = {
  IDENTITY_ALREADY_LINKED: (p) =>
    `此 ${p ?? ''} 帳號已綁定到另一個 HoloHunter 帳號，請先從該帳號解除綁定後再試。`,
  SAME_PROVIDER_ALREADY_LINKED: (p) =>
    `你已綁定一個 ${p ?? ''} 帳號。若要更換，請先解除舊的再綁定新的。`,
  CANNOT_UNLINK_LAST_METHOD: () => '無法解除唯一的登入方式，請先綁定其他登入方式。',
  ACCOUNT_DISABLED: () => '此帳號已停用，請聯絡客服。',
  INVALID_TOKEN: () => '登入驗證失敗，請重新登入。',
  TOKEN_EXPIRED: () => '登入已逾時，請重新登入。',
  TOKEN_REPLAYED: () => '此登入憑證已使用過，請重新登入。',
  STORE_NOT_CONFIGURED: () => '登入服務尚未設定完成（後端未就緒），請稍後再試。',
};

class AuthError extends Error {
  code?: string;
  status: number;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

function toAuthError(data: any, status: number, provider?: AuthProvider): AuthError {
  const code: string | undefined = data?.error;
  const friendly = code && PROVIDER_ERROR_MESSAGES[code];
  const message = friendly
    ? friendly(provider)
    : data?.reason
      ? `操作未完成（${data.reason}）。`
      : `操作未完成（HTTP ${status}）。`;
  return new AuthError(message, status, code);
}

async function apiPost(path: string, body: unknown, session?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (session) headers.Authorization = `Bearer ${session}`;
  return fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function readJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

interface ServerPublicUser {
  internalId: string;
  displayName: string;
  primaryEmail?: string;
  photoUrl?: string;
  role: 'free_user' | 'subscriber';
  linkedProviders: Array<{
    provider: AuthProvider;
    providerId: string;
    email?: string;
    displayName?: string;
    photoUrl?: string;
    linkedAt: string;
  }>;
  createdAt: string;
}

function toHoloUser(u: ServerPublicUser): HoloUser {
  const linkedProviders: LinkedIdentity[] = u.linkedProviders.map((p) => ({
    provider: p.provider,
    providerId: p.providerId,
    email: p.email ?? '',
    displayName: p.displayName ?? u.displayName,
    photoUrl: p.photoUrl,
    linkedAt: p.linkedAt,
  }));
  return {
    internalId: u.internalId,
    displayName: u.displayName,
    primaryEmail: u.primaryEmail,
    photoUrl: u.photoUrl,
    // Carry the server-authoritative role through verbatim; only fall back to
    // free_user if the server omitted it (never override a real subscriber).
    role: u.role === 'subscriber' ? 'subscriber' : 'free_user',
    linkedProviders,
    createdAt: u.createdAt,
  };
}

// Turns an iOS Google OAuth client id into its reversed-client-id custom URL
// scheme (com.googleusercontent.apps.XXX), which is the redirect Google expects
// for native iOS and is registered in the app's CFBundleURLTypes (app.config.js).
function reversedIosClientScheme(iosClientId: string): string {
  return iosClientId.split('.').reverse().join('.');
}

// Native iOS Google: run the OAuth prompt against the iOS client and its
// reversed-client-id redirect, PKCE-exchange the code, and return the id_token
// (aud = iOS client id) for the SAME server verify path used by web.
async function obtainGoogleNativeIdToken(
  loginHint?: string,
): Promise<{ idToken: string; nonce: string }> {
  if (!GOOGLE_IOS_CLIENT_ID) {
    throw new AuthError(
      '尚未設定 iOS 的 Google client ID（EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID）。',
      500,
      'client_id_missing',
    );
  }
  const redirectUri = `${reversedIosClientScheme(GOOGLE_IOS_CLIENT_ID)}:/oauthredirect`;
  const nonce = randomNonce();
  const authRequest = new AuthSession.AuthRequest({
    clientId: GOOGLE_IOS_CLIENT_ID,
    scopes: googleScopes,
    redirectUri,
    usePKCE: true,
    extraParams: {
      nonce,
      ...(loginHint ? { login_hint: loginHint } : {}),
    },
  });

  const result = await authRequest.promptAsync(googleDiscovery);
  if (result.type !== 'success') {
    throw new AuthError(
      result.type === 'cancel' ? '已取消登入' : `登入失敗（${result.type}）`,
      400,
      result.type,
    );
  }
  const code = result.params.code;
  if (!code) throw new AuthError('未取得授權碼', 400, 'no_code');
  const codeVerifier = authRequest.codeVerifier;
  if (!codeVerifier) throw new AuthError('PKCE code verifier 遺失', 400, 'no_verifier');

  const tokenResponse = await AuthSession.exchangeCodeAsync(
    {
      clientId: GOOGLE_IOS_CLIENT_ID,
      code,
      redirectUri,
      extraParams: { code_verifier: codeVerifier },
    },
    googleDiscovery,
  );
  const idToken = tokenResponse.idToken;
  if (!idToken) throw new AuthError('Google 未回傳 id_token', 400, 'no_id_token');
  return { idToken, nonce };
}

// Minimal structural view of @react-native-google-signin/google-signin (v16,
// classic play-services-auth GoogleSignin). The module is imported dynamically
// (below) and typed against this local interface so it never enters the web/iOS
// bundle and so tsc/CI don't hard-depend on the package's evolving type surface.
// signIn() returns a discriminated response ({ type: 'success', data } |
// { type: 'cancelled' }); older builds throw on cancel — both are handled.
interface NativeGoogleUser {
  idToken?: string | null;
}
interface NativeGoogleSignInResponse {
  type?: string;
  data?: NativeGoogleUser | null;
  idToken?: string | null;
}
interface NativeGoogleSignInModule {
  GoogleSignin: {
    configure(options: { webClientId: string; offlineAccess?: boolean }): void;
    hasPlayServices(options?: { showPlayServicesUpdateDialog?: boolean }): Promise<boolean>;
    signIn(): Promise<NativeGoogleSignInResponse>;
    signOut(): Promise<null>;
  };
}

function isCancelledError(err: unknown): boolean {
  const code = String((err as { code?: unknown })?.code ?? '');
  // SIGN_IN_CANCELLED (classic GoogleSignin), 12501 (legacy
  // GoogleSignInStatusCodes), -5 (iOS). Match defensively across library versions.
  return code === 'SIGN_IN_CANCELLED' || code === '12501' || code === '-5';
}

// Native Android Google (DIC-665): classic play-services-auth Google Sign-In
// (@react-native-google-signin/google-signin v16 `GoogleSignin`; NOT Credential
// Manager — that API is not exported by this library version, and this classic
// flow cannot bind an OIDC nonce). We configure the library with the Web (server)
// OAuth client id so the returned ID token's `aud` is that Web client — exactly
// the audience the backend already verifies — and forward it to the SAME server
// verify path used by web and iOS. Because there is no client-supplied nonce,
// replay protection is enforced server-side: each ID token is single-use (see
// api/_lib/token-replay.ts). The Android OAuth client (package
// `com.dicoge.holohunter` + signing-cert SHA-1) only authorizes the native flow
// in Google Console; it is not passed here and is never trusted client-side. The
// module is imported lazily so it stays out of the web/iOS bundle (mirrors the
// iOS-only expo-apple-authentication import).
async function obtainGoogleNativeIdTokenAndroid(): Promise<{ idToken: string; nonce?: string }> {
  if (!GOOGLE_CLIENT_ID) {
    throw new AuthError(
      '尚未設定 Google Web client ID（EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID）；Android 原生登入無法取得可被後端驗證的 ID token。',
      500,
      'client_id_missing',
    );
  }
  const mod = (await import(
    '@react-native-google-signin/google-signin'
  )) as unknown as NativeGoogleSignInModule;
  const { GoogleSignin } = mod;
  GoogleSignin.configure({ webClientId: GOOGLE_CLIENT_ID });

  try {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  } catch {
    throw new AuthError(
      '此裝置的 Google Play 服務不可用或需更新，無法使用 Google 登入。',
      400,
      'play_services_unavailable',
    );
  }

  let response: NativeGoogleSignInResponse;
  try {
    response = await GoogleSignin.signIn();
  } catch (err) {
    if (isCancelledError(err)) throw new AuthError('已取消登入', 400, 'cancel');
    throw new AuthError('Google 登入失敗，請再試一次。', 400, 'google_failed');
  }

  // v13+ signals cancellation as a value, not a throw.
  if (response?.type === 'cancelled') {
    throw new AuthError('已取消登入', 400, 'cancel');
  }
  const idToken = response?.data?.idToken ?? response?.idToken;
  if (!idToken) throw new AuthError('Google 未回傳 id_token', 400, 'no_id_token');
  return { idToken };
}

// Clears the classic Google Sign-In SDK's cached account on Android so the next
// sign-in re-prompts the account chooser instead of silently reusing the last
// account. Called on logout / account deletion. Android-only and best-effort: the
// server session is already invalidated by the caller, so a failure here (module
// absent on web/iOS, or no cached account) must never surface as a logout error.
// The module is imported lazily so it stays out of the web/iOS bundle.
export async function signOutNativeGoogle(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    const mod = (await import(
      '@react-native-google-signin/google-signin'
    )) as unknown as NativeGoogleSignInModule;
    await mod.GoogleSignin.signOut();
  } catch {
    // Best-effort: never block logout on provider SDK state.
  }
}

// Native iOS Apple: OS-native Sign in with Apple returns an identityToken (a
// signed JWT, aud = app bundle id) that we forward to the backend for RS256
// verification — no client-local trust. `expo-apple-authentication` is imported
// lazily so it never enters the web bundle.
async function obtainAppleNativeIdToken(): Promise<{ idToken: string; nonce: string }> {
  const AppleAuthentication = await import('expo-apple-authentication');
  if (!(await AppleAuthentication.isAvailableAsync())) {
    throw new AuthError('此裝置不支援 Apple 登入（需 iOS 13 以上）。', 400, 'apple_unavailable');
  }
  const nonce = randomNonce();
  let credential: import('expo-apple-authentication').AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce,
    });
  } catch (e: any) {
    if (e?.code === 'ERR_REQUEST_CANCELED') {
      throw new AuthError('已取消登入', 400, 'cancel');
    }
    throw new AuthError('Apple 登入失敗，請再試一次。', 400, 'apple_failed');
  }
  const idToken = credential.identityToken;
  if (!idToken) throw new AuthError('Apple 未回傳 identityToken', 400, 'no_id_token');
  return { idToken, nonce };
}

// Web OAuth/OIDC prompt (browser). For Google we PKCE-exchange the code for an
// id_token; for Apple the id_token arrives directly in the authorize response.
async function obtainWebIdToken(
  provider: AuthProvider,
  loginHint?: string,
): Promise<{ idToken: string; nonce: string }> {
  const clientId = provider === 'google' ? GOOGLE_CLIENT_ID : APPLE_CLIENT_ID;
  if (!clientId) {
    throw new AuthError(
      `尚未設定 ${provider} 的 client ID（${provider === 'google' ? 'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID' : 'EXPO_PUBLIC_APPLE_SERVICE_ID'}）。`,
      500,
      'client_id_missing',
    );
  }

  const redirectUri = AuthSession.makeRedirectUri();
  const scopes = provider === 'google' ? googleScopes : appleScopes;
  const discovery = provider === 'google' ? googleDiscovery : appleDiscovery;
  const nonce = randomNonce();

  const authRequest = new AuthSession.AuthRequest({
    clientId,
    scopes,
    redirectUri,
    usePKCE: true,
    extraParams: {
      nonce,
      ...(provider === 'apple' ? { response_mode: 'form_post' } : {}),
      ...(loginHint ? { login_hint: loginHint } : {}),
    },
  });

  const result = await authRequest.promptAsync(discovery);
  if (result.type !== 'success') {
    throw new AuthError(
      result.type === 'cancel' ? '已取消登入' : `登入失敗（${result.type}）`,
      400,
      result.type,
    );
  }

  if (provider === 'apple') {
    const idToken = result.params.id_token;
    if (!idToken) throw new AuthError('Apple 未回傳 id_token', 400, 'no_id_token');
    return { idToken: idToken as string, nonce };
  }

  const code = result.params.code;
  if (!code) throw new AuthError('未取得授權碼', 400, 'no_code');
  const codeVerifier = authRequest.codeVerifier;
  if (!codeVerifier) throw new AuthError('PKCE code verifier 遺失', 400, 'no_verifier');

  const tokenResponse = await AuthSession.exchangeCodeAsync(
    {
      clientId,
      code,
      redirectUri,
      extraParams: { code_verifier: codeVerifier },
    },
    discovery,
  );
  const idToken = tokenResponse.idToken;
  if (!idToken) throw new AuthError('Google 未回傳 id_token', 400, 'no_id_token');
  return { idToken, nonce };
}

// Runs the provider prompt on the right surface (native iOS, native Android, or
// web) and returns a provider ID token for server-side verification. Identity
// resolution always lives on the server — this only obtains the token. The
// surface is decided by the pure helpers in authStrategy (unit-tested) so the
// Android native path can never silently regress to the browser PKCE fallback.
async function obtainProviderIdToken(
  provider: AuthProvider,
  loginHint?: string,
): Promise<{ idToken: string; nonce?: string }> {
  if (provider === 'apple') {
    const surface = appleLoginSurface(Platform.OS, APPLE_WEB_ENABLED);
    if (surface === 'native-ios') return obtainAppleNativeIdToken();
    if (surface === 'disabled') throw new AuthError(APPLE_DISABLED_MESSAGE, 400, 'apple_disabled');
    return obtainWebIdToken('apple', loginHint);
  }
  const surface = googleLoginSurface(Platform.OS);
  if (surface === 'native-ios') return obtainGoogleNativeIdToken(loginHint);
  if (surface === 'native-android') return obtainGoogleNativeIdTokenAndroid();
  return obtainWebIdToken('google', loginHint);
}

export interface SignInResult {
  user: HoloUser;
  session: string;
  isNewUser: boolean;
}

export async function signInWithProvider(provider: AuthProvider): Promise<SignInResult> {
  const { idToken, nonce } = await obtainProviderIdToken(provider);
  const res = await apiPost('/auth/login', { provider, idToken, nonce });
  const data = await readJson(res);
  if (!res.ok) throw toAuthError(data, res.status, provider);
  return { user: toHoloUser(data.user), session: data.session, isNewUser: Boolean(data.isNew) };
}

export async function linkProvider(
  session: string,
  currentUser: HoloUser,
  provider: AuthProvider,
): Promise<HoloUser> {
  const { idToken, nonce } = await obtainProviderIdToken(provider, currentUser.primaryEmail);
  const res = await apiPost('/auth/link', { provider, idToken, nonce }, session);
  const data = await readJson(res);
  if (!res.ok) throw toAuthError(data, res.status, provider);
  return toHoloUser(data.user);
}

export async function unlinkProvider(
  session: string,
  provider: AuthProvider,
): Promise<HoloUser> {
  const res = await apiPost('/auth/unlink', { provider }, session);
  const data = await readJson(res);
  if (!res.ok) throw toAuthError(data, res.status, provider);
  return toHoloUser(data.user);
}

// Shared server delete/revoke flow. Resolves normally ONLY when the server
// confirms deletion; otherwise throws so the client keeps the session (the UI
// must not claim the account was deleted).
export async function deleteAccount(session: string): Promise<void> {
  const res = await apiPost('/auth/delete-account', {}, session);
  const data = await readJson(res);
  if (!res.ok || data?.deleted !== true) {
    throw toAuthError(data, res.status);
  }
}

// Server-validate a persisted session before the app trusts it. On success
// returns the fresh server user; a rejected session (401) throws an AuthError
// with status 401 so the caller can fail closed and drop the local session,
// while a transient/network error throws with status 0 (keep the session, just
// don't enter authenticated state yet). Never returns a user without a 2xx.
export async function validateSession(session: string): Promise<HoloUser> {
  let res: Response;
  try {
    res = await apiPost('/auth/me', {}, session);
  } catch {
    throw new AuthError('無法驗證登入狀態（網路問題），請稍後再試。', 0, 'network_error');
  }
  const data = await readJson(res);
  if (!res.ok) throw toAuthError(data, res.status);
  return toHoloUser(data.user);
}
