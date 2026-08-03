/**
 * Google 登入（Android 第一優先，iOS / Web 共用同一介面）— DIC-665。
 *
 * 使用 expo-auth-session 的 Authorization Code + PKCE 瀏覽器流程（Android/iOS
 * 走系統 Custom Tabs / SFSafariViewController，非 WebView，符合 Google 對
 * embedded webview 的封鎖規範）。回傳與 Apple 相同形狀的 AuthSession：
 *   - user.id  = Google 穩定 subject（`sub`）——身份主鍵，**不以 email 為依據**。
 *   - identityToken = Google 簽發的 `id_token`（JWT），交由後端驗證簽章 / audience。
 *
 * client_id 依平台挑選；native 的 redirect 必須是「反轉 client id」自訂 scheme
 * （`com.googleusercontent.apps.<id>:/oauthredirect`），這正是 Google 對
 * installed-app OAuth client 允許的 redirect，也是 Expo Google provider 內部
 * 採用的做法。各平台 client ID / Android keystore SHA-1 設定見 docs/AUTH_SETUP.md。
 */
import { Platform } from 'react-native';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';

import type { AuthSession as HoloAuthSession, AuthUser } from '../../types/auth';

// Web 上 OAuth 彈窗回跳後需要這行才能結束 auth session。
WebBrowser.maybeCompleteAuthSession();

/** 使用者主動取消登入彈窗時丟出的錯誤碼（對齊 appleAuth 的 APPLE_CANCEL_CODE）。 */
export const GOOGLE_CANCEL_CODE = 'ERR_GOOGLE_CANCELED';

const googleDiscovery: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
  userInfoEndpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
};

const GOOGLE_SCOPES = ['openid', 'profile', 'email'];

const WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '';
const IOS_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '';
const ANDROID_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID ?? '';

const GOOGLE_CLIENT_SUFFIX = '.apps.googleusercontent.com';

export class GoogleAuthNotConfiguredError extends Error {
  code = 'ERR_GOOGLE_NOT_CONFIGURED';
  constructor() {
    super('Google 登入尚未設定，請見 docs/AUTH_SETUP.md');
    this.name = 'GoogleAuthNotConfiguredError';
  }
}

/** 依平台挑對應的 Google OAuth client ID；缺該平台專用值時退回 Web client。 */
function getClientId(): string {
  if (Platform.OS === 'ios') return IOS_CLIENT_ID || WEB_CLIENT_ID;
  if (Platform.OS === 'android') return ANDROID_CLIENT_ID || WEB_CLIENT_ID;
  return WEB_CLIENT_ID;
}

/**
 * `123-abc.apps.googleusercontent.com` → `com.googleusercontent.apps.123-abc`
 * 這是 Google installed-app client 的反轉 scheme，作為 native redirect。
 */
function reversedClientScheme(clientId: string): string | null {
  if (!clientId.endsWith(GOOGLE_CLIENT_SUFFIX)) return null;
  return `com.googleusercontent.apps.${clientId.slice(0, -GOOGLE_CLIENT_SUFFIX.length)}`;
}

function buildRedirectUri(clientId: string): string {
  if (Platform.OS === 'web') {
    return AuthSession.makeRedirectUri();
  }
  const scheme = reversedClientScheme(clientId);
  return AuthSession.makeRedirectUri(
    scheme ? { native: `${scheme}:/oauthredirect` } : undefined
  );
}

/** 該平台是否已備妥 Google client ID；未備妥時 UI 應停用 / 隱藏按鈕。 */
export function isGoogleAuthConfigured(): boolean {
  return getClientId().length > 0;
}

interface GoogleUserInfo {
  sub: string;
  email?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
}

async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const res = await fetch(googleDiscovery.userInfoEndpoint as string, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch Google user info: ${res.status}`);
  }
  return (await res.json()) as GoogleUserInfo;
}

/**
 * 觸發 Google 登入流程並回傳一個 AuthSession。
 * 使用者取消時丟出帶 GOOGLE_CANCEL_CODE 的錯誤（呼叫端據此靜默處理）。
 */
export async function signInWithGoogle(): Promise<HoloAuthSession> {
  const clientId = getClientId();
  if (!clientId) {
    throw new GoogleAuthNotConfiguredError();
  }

  const redirectUri = buildRedirectUri(clientId);
  const authRequest = new AuthSession.AuthRequest({
    clientId,
    scopes: GOOGLE_SCOPES,
    redirectUri,
    usePKCE: true,
  });

  const result = await authRequest.promptAsync(googleDiscovery);
  if (result.type !== 'success') {
    if (result.type === 'cancel' || result.type === 'dismiss') {
      const err = new Error('User cancelled Google sign-in') as Error & { code?: string };
      err.code = GOOGLE_CANCEL_CODE;
      throw err;
    }
    throw new Error(`Google auth failed: ${result.type}`);
  }

  const code = result.params.code;
  if (!code) throw new Error('No authorization code returned from Google');

  const codeVerifier = authRequest.codeVerifier;
  if (!codeVerifier) throw new Error('PKCE code verifier missing');

  const tokenResponse = await AuthSession.exchangeCodeAsync(
    {
      clientId,
      code,
      redirectUri,
      extraParams: { code_verifier: codeVerifier },
    },
    googleDiscovery
  );

  const info = await fetchGoogleUserInfo(tokenResponse.accessToken);
  const composedName =
    info.name ??
    [info.given_name, info.family_name].filter(Boolean).join(' ') ??
    null;

  const user: AuthUser = {
    id: info.sub, // Google 穩定 subject — 身份主鍵
    provider: 'google',
    email: info.email ?? null,
    name: composedName || null,
  };

  return {
    user,
    identityToken: tokenResponse.idToken ?? null,
    // Code 已在前端交換並消耗；後端 session 驗證改用 identityToken(id_token)。
    authorizationCode: null,
    createdAt: new Date().toISOString(),
  };
}
