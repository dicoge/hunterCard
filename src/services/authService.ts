import { Platform } from 'react-native';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import * as Crypto from 'expo-crypto';
import {
  AuthProvider,
  LinkedIdentity,
  HoloUser,
} from '../types/auth';
import {
  appleLoginSurface,
  googleLoginSurface,
  resolveApiBase,
  resolveWebRedirectUri,
} from './authStrategy';

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

// Backend API base. Native (iOS/Android) MUST use an absolute URL — a relative
// '/api' cannot be resolved by React Native's fetch and breaks every auth call
// (DIC-922 blocker 5). Web uses its own same-origin. Computed per call so web
// picks up window.location at runtime and native never depends on a build-time
// window global. See resolveApiBase (authStrategy) for the precedence rules.
function apiBase(): string {
  return resolveApiBase({
    platformOS: Platform.OS,
    webOrigin: typeof window !== 'undefined' ? window.location?.origin ?? null : null,
    envOverride: process.env.EXPO_PUBLIC_API_BASE_URL,
  });
}

// Web Sign in with Apple stays gated: the browser cannot verify an Apple ID
// token, so it requires the server verify path (Services ID + backend secret).
const APPLE_WEB_ENABLED = process.env.EXPO_PUBLIC_APPLE_WEB_LOGIN_ENABLED === 'true';

// Android Apple carries an extra gate: its return channel must be a VERIFIED
// HTTPS App Link (a custom scheme is not app-exclusive — CR DIC-961). App Link
// verification depends on a deployed assetlinks.json with the real signing-cert
// fingerprint (owner-only), so Android Apple stays OFF until the operator both
// deploys that file and sets EXPO_PUBLIC_APPLE_ANDROID_ENABLED=true. Fail-closed.
const APPLE_ANDROID_ENABLED = process.env.EXPO_PUBLIC_APPLE_ANDROID_ENABLED === 'true';

// The verified HTTPS App Link the Android callback returns to. It MUST match the
// intent-filter host/path (app.config.js) and be on the server's return allow-
// list (APPLE_WEB_ALLOWED_RETURNS). Overridable for non-prod hosting.
const APPLE_ANDROID_RETURN_URL =
  process.env.EXPO_PUBLIC_APPLE_ANDROID_RETURN_URL ||
  'https://holohunter.dicoge.com/auth/apple/return';

// Apple login is delivered NATIVELY on iOS (expo-apple-authentication → backend
// RS256 verify against the app bundle id) and needs no Services ID. On web it is
// only offered once APPLE_WEB_ENABLED; on Android it is hard-disabled regardless
// of the flag (DIC-665 / DIC-920). Deriving this from the SAME pure surface
// function that dispatch uses keeps the UI and the runtime in lockstep — the
// button is hidden exactly when the surface is 'disabled', never shown as a
// nonfunctional entry (DIC-866 acceptance #5).
export const APPLE_LOGIN_ENABLED =
  appleLoginSurface(Platform.OS, APPLE_WEB_ENABLED, APPLE_ANDROID_ENABLED) !== 'disabled';

export const APPLE_DISABLED_MESSAGE =
  'Apple 登入尚未開放（需後端驗證 Apple ID token）。請改用 Google 登入。';

// Web/Android Apple login runs the server-callback flow (obtainAppleWebSession),
// which resolves identity and issues the session on the server; it never hands a
// client-held id_token back, so the token-based dispatch path must never be used
// for these surfaces.
const APPLE_WEB_TOKEN_UNSUPPORTED =
  'Apple 網頁/Android 登入改由伺服器回呼處理（/api/auth/apple/web），此路徑不回傳 id_token。';

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

// Turns a non-success expo-auth-session prompt result into an AuthError whose
// `code` is specific enough for the UI to diagnose (DIC-922 blocker 4). A real
// cancel stays 'cancel'; otherwise we prefer the OAuth `error` param Google
// returns (e.g. redirect_uri_mismatch, access_denied) so a misconfigured
// redirect no longer looks like a generic failure. We only read the short
// machine `error` code, never a raw description that could carry detail.
function authErrorFromPromptResult(result: {
  type: string;
  params?: Record<string, string> | null;
  error?: { code?: string } | null;
}): AuthError {
  if (result.type === 'cancel' || result.type === 'dismiss') {
    return new AuthError('已取消登入', 400, 'cancel');
  }
  const oauthError = result.params?.error || result.error?.code || result.type;
  return new AuthError(`登入失敗（${oauthError}）`, 400, oauthError);
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
  return fetch(`${apiBase()}${path}`, {
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
    throw authErrorFromPromptResult(result as any);
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

  // Pin the web redirect to the page origin so it byte-matches the URI
  // registered in Google Console (DIC-922). makeRedirectUri() is
  // window.location-derived and drifts by page path / deploy origin, which is
  // what produced the production `redirect_uri_mismatch`. Fall back to
  // makeRedirectUri() only if no origin is resolvable (e.g. SSR).
  const pinnedRedirect = resolveWebRedirectUri({
    origin: typeof window !== 'undefined' ? window.location?.origin ?? null : null,
    override: process.env.EXPO_PUBLIC_GOOGLE_WEB_REDIRECT_URI,
  });
  const redirectUri = pinnedRedirect || AuthSession.makeRedirectUri();
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
    throw authErrorFromPromptResult(result as any);
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
    const surface = appleLoginSurface(Platform.OS, APPLE_WEB_ENABLED, APPLE_ANDROID_ENABLED);
    if (surface === 'native-ios') return obtainAppleNativeIdToken();
    if (surface === 'disabled') throw new AuthError(APPLE_DISABLED_MESSAGE, 400, 'apple_disabled');
    // 'web' / 'android-web' are handled by obtainAppleWebSession (server-callback)
    // before dispatch reaches here; a token can't be produced client-side.
    throw new AuthError(APPLE_WEB_TOKEN_UNSUPPORTED, 400, 'apple_web_surface');
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

// The in-app URL the server-callback bounces back to after Apple login. On web
// it is the SPA page origin; on Android it is a VERIFIED HTTPS App Link (NOT a
// custom scheme — a custom scheme is not app-exclusive and another installed app
// could intercept the return, CR DIC-961). openAuthSessionAsync watches for it;
// if the App Link is not yet verified the OS opens it in the browser (no silent
// interception) — fail-closed. The server also re-validates this against its own
// allow-list (open-redirect defence), so a non-allow-listed value fails closed.
function appleWebReturnUrl(platform: 'web' | 'android'): string {
  if (platform === 'web') {
    return typeof window !== 'undefined' ? window.location?.origin ?? '' : '';
  }
  return APPLE_ANDROID_RETURN_URL;
}

// base64url(SHA-256(input)) — the PKCE code challenge derivation, matching the
// server's crypto.createHash('sha256').digest('base64url'). expo-crypto returns
// standard base64, which we convert to the unpadded base64url alphabet.
async function sha256Base64Url(input: string): Promise<string> {
  const b64 = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input, {
    encoding: Crypto.CryptoEncoding.BASE64,
  });
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Parse the `#code=...` (or `#error=...`) fragment the server-callback return
// page deep-links back with. Fragments are used (not query) so even the one-time
// code never reaches a server log / Referer header.
function parseAuthFragment(url: string): Record<string, string> {
  const hash = url.indexOf('#');
  if (hash < 0) return {};
  const out: Record<string, string> = {};
  new URLSearchParams(url.slice(hash + 1)).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

// Server-callback Sign in with Apple for web + Android (DIC-960). The browser /
// Custom Tabs is sent to /api/auth/apple/web, Apple form_posts the id_token back
// to that server endpoint, and the app is deep-linked back with a ONE-TIME
// exchange code (never the session). The app redeems that code for the session by
// presenting a PKCE verifier it kept entirely off the return channel, so an
// intercepted return yields nothing usable (CR DIC-961). Identity resolution +
// session issuance stay server-side; the client re-validates via /auth/me.
async function obtainAppleWebSession(surface: 'web' | 'android-web'): Promise<SignInResult> {
  const platform = surface === 'android-web' ? 'android' : 'web';
  const returnUrl = appleWebReturnUrl(platform);
  if (!returnUrl) {
    throw new AuthError('無法決定 Apple 登入的回程網址。', 400, 'no_return_url');
  }
  // Mint a fresh PKCE verifier (256 bits) and send ONLY its challenge to the
  // server. The verifier never leaves the app / the interceptable return channel.
  const verifier = `${randomNonce()}${randomNonce()}`;
  const challenge = await sha256Base64Url(verifier);
  const startUrl =
    `${apiBase()}/auth/apple/web?platform=${platform}` +
    `&return=${encodeURIComponent(returnUrl)}` +
    `&code_challenge=${encodeURIComponent(challenge)}`;

  const result = await WebBrowser.openAuthSessionAsync(startUrl, returnUrl);
  if (result.type !== 'success' || !result.url) {
    // dismiss / cancel / opened — treat uniformly as a cancel (fail-closed: no
    // code was delivered, so the app must not enter authenticated state).
    throw new AuthError('已取消登入', 400, 'cancel');
  }

  const frag = parseAuthFragment(result.url);
  if (frag.error) {
    throw new AuthError(`Apple 登入失敗（${frag.error}）`, 400, frag.error);
  }
  const code = frag.code;
  if (!code) {
    throw new AuthError('Apple 登入未回傳授權碼，請重試。', 400, 'no_code');
  }
  // Redeem the one-time code for the server session. Only the matching verifier
  // unlocks it; a bad/expired/replayed code returns a generic 401.
  const res = await apiPost('/auth/apple-exchange', { code, verifier });
  const data = await readJson(res);
  if (!res.ok) throw toAuthError(data, res.status, 'apple');
  const session = data.session;
  if (!session) {
    throw new AuthError('Apple 登入未回傳 session，請重試。', 400, 'no_session');
  }
  // Validate the redeemed session against /auth/me before trusting it (never adopt
  // a session the server won't confirm).
  const user = await validateSession(session);
  return { user, session, isNewUser: Boolean(data.isNew) };
}

export async function signInWithProvider(provider: AuthProvider): Promise<SignInResult> {
  if (provider === 'apple') {
    const surface = appleLoginSurface(Platform.OS, APPLE_WEB_ENABLED, APPLE_ANDROID_ENABLED);
    if (surface === 'web' || surface === 'android-web') {
      return obtainAppleWebSession(surface);
    }
  }
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
