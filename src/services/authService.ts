import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import {
  AuthProvider,
  LinkedIdentity,
  HoloUser,
} from '../types/auth';

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

const APPLE_CLIENT_ID = process.env.EXPO_PUBLIC_APPLE_SERVICE_ID || '';

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL || '/api';

// Sign in with Apple (web) is disabled until the server verify path is enabled.
// The client cannot verify an Apple ID token on its own, and the server gate
// (APPLE_WEB_LOGIN_ENABLED) is off by default. Web Apple is optional per the
// product spec (Google is the required web provider). See
// docs/Web-Apple-Login-Evaluation.md.
export const APPLE_LOGIN_ENABLED = false;

export const APPLE_DISABLED_MESSAGE =
  'Apple 登入尚未開放（需後端驗證 Apple ID token）。請改用 Google 登入。';

const googleScopes = ['openid', 'profile', 'email'];
const appleScopes = ['openid', 'name', 'email'];

function randomNonce(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
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
    linkedProviders,
    createdAt: u.createdAt,
  };
}

// Runs the provider OAuth/OIDC prompt and returns an ID token for server-side
// verification. For Google we PKCE-exchange the code for an id_token; for Apple
// the id_token arrives directly in the authorize response.
async function obtainProviderIdToken(
  provider: AuthProvider,
  loginHint?: string,
): Promise<{ idToken: string; nonce: string }> {
  if (provider === 'apple' && !APPLE_LOGIN_ENABLED) {
    throw new AuthError(APPLE_DISABLED_MESSAGE, 400, 'apple_disabled');
  }
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

// Best-effort server-side session revocation. Logout must always clear local
// state, so a network/backend failure here is swallowed; the server record also
// expires on its own TTL. When it does reach the server the session is revoked
// immediately so the bearer token can't be replayed.
export async function logoutSession(session: string): Promise<void> {
  try {
    await apiPost('/auth/logout', {}, session);
  } catch {
    // ignore — local logout proceeds regardless
  }
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
