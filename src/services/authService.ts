import { Platform } from 'react-native';
import {
  AuthProvider,
  HoloUser,
  AuthTokens,
} from '../types/auth';
import {
  signInWithGoogle as signInWithGoogleNative,
  signOutGoogle,
} from './auth/googleAuth';

const PRODUCTION_API_BASE = 'https://holocard-hunter.vercel.app';

function getApiBase(): string {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return window.location.origin;
  }
  return PRODUCTION_API_BASE;
}

// Sign in with Apple is disabled in this path. The client cannot verify an Apple
// ID token (signature / issuer / audience / expiry / nonce) on its own, so
// trusting a decoded payload as an identity source would be insecure. iOS native
// Apple runs through appleAuth; Web Apple is DIC-663. Either way identity must be
// verified server-side before it is trusted.
export const APPLE_LOGIN_ENABLED = false;

const APPLE_DISABLED_MESSAGE =
  'Apple 登入尚未開放（需後端驗證 Apple ID token）。請改用 Google 登入。';

// Account linking / unlinking is not yet server-authoritative. The previous
// client-side implementation ran a browser OAuth flow, trusted the provider's
// `userinfo.sub` (unverified), and wrote the merged identity to localStorage
// only — none of which is a trustworthy identity boundary. Both are fail-closed
// here until a backend endpoint verifies the provider's token and mutates the
// same server-side (provider, sub) identity store with uniqueness/race safety.
const LINK_NOT_IMPLEMENTED_MESSAGE =
  '帳號綁定尚未開放（需後端權威驗證與 (provider, sub) 身份儲存）。';
const UNLINK_NOT_IMPLEMENTED_MESSAGE =
  '解除綁定尚未開放（需後端權威端點驗證 token、處理唯一性與競態後更新 (provider, sub) 身份儲存）。';

export interface SignInResult {
  user: HoloUser;
  tokens: AuthTokens;
  isNewUser: boolean;
}

export async function signInWithProvider(provider: AuthProvider): Promise<SignInResult> {
  if (provider === 'apple') {
    // Apple 登入未在此路徑實作：iOS 原生 Apple 走 appleAuth（原生流程），
    // Web Apple 屬 DIC-663。無論如何都需後端驗證 Apple id_token，client 不自行信任。
    throw new Error(APPLE_DISABLED_MESSAGE);
  }

  // Google（Android 第一優先）：原生 Sign-In 取 id_token → 後端 /api/auth/login 驗簽 /
  // iss / aud / exp / iat 新鮮度，並對 id_token 做一次性消費（防重放）後，以 (google, sub)
  // 找/建 internal user 並簽發 app session。internal user id 與 session 一律由後端權威決定，
  // client 不 mint 身份、不信任本地解碼 payload、也不寫入本機 users。
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

/**
 * 解除綁定：fail-closed。以本機 localStorage 改寫 linkedProviders 只會製造與後端
 * (provider, sub) 身份儲存不一致的假象——真正的解綁需後端權威端點驗 token、保證帳號
 * 至少保留一個登入方式、並處理唯一性與競態。未實作前一律拒絕，不做任何本機變更。
 */
export async function unlinkProvider(
  _currentUser: HoloUser,
  _provider: AuthProvider,
): Promise<HoloUser> {
  throw new Error(UNLINK_NOT_IMPLEMENTED_MESSAGE);
}

/**
 * 帳號刪除：呼叫後端權威端點 `POST /api/auth/delete-account`，以 access token 認證身份。
 * 後端才是唯一能移除 auth:identity / auth:user 的地方；client 不再只清本機 localStorage
 * 就宣稱成功（那會留下伺服器端身份殘留、且下次登入仍被辨識為舊帳號）。
 *
 * fail-closed：無 access token、或後端回非 2xx，一律 throw——呼叫端據此**維持登入狀態**，
 * 不清 session（見 store deleteUserAccount）。唯有後端 2xx 才算刪除成功。
 */
export async function deleteAccount(
  _currentUser: HoloUser,
  tokens: AuthTokens | null,
): Promise<void> {
  const accessToken = tokens?.accessToken;
  if (!accessToken) {
    throw new Error('無有效登入憑證，無法刪除帳號。');
  }

  let res: Response;
  try {
    res = await fetch(`${getApiBase()}/api/auth/delete-account`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch {
    throw new Error('刪除帳號失敗：無法連線後端。');
  }

  if (!res.ok) {
    // 後端未確認刪除成功：fail-closed，維持登入狀態。
    throw new Error(`刪除帳號失敗（${res.status}）。`);
  }
}

/**
 * 登出時的 provider 端清理。
 *
 * Google：呼叫原生 `GoogleSignin.signOut()` 清除 SDK 快取的 Google 帳號 session。
 * 先前把 app 自己的 session **JWT** 送去 `oauth2.googleapis.com/revoke` 是錯的——那不是
 * Google 簽發的 access/refresh token，revoke 端點無從辨識，等於什麼都沒登出。正確做法是
 * 用原生 SDK 的 signOut() 清掉快取帳號；下次登入會重新彈出帳號選擇器並取得**全新** id_token
 * （新指紋），故後端一次性重放防護不會擋住合法的「登出後立即再登入」。
 *
 * Apple：iOS 原生 Apple 無「登出」API（登出即清本機 session 即可），此處 no-op。撤銷授權
 * 屬帳號刪除流程（見 deleteAccount / delete-handler），不在一般登出做。
 *
 * best-effort：provider 端清理失敗不應阻擋本機登出（呼叫端仍會清本機 session）。
 */
export async function providerSignOut(tokens: AuthTokens | null): Promise<void> {
  if (tokens?.provider !== 'google') return;
  try {
    await signOutGoogle();
  } catch {}
}
