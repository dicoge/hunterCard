/**
 * `POST /api/auth/login` 的核心邏輯（DIC-665），與 HTTP 層及具體實作解耦以便單元測試。
 *
 * 權威流程（fail-closed）：
 *   1. 驗 provider id_token（簽章 / iss / aud / exp / **iat 新鮮度**）——見 google-auth.ts。
 *   2. **一次性消費該 id_token**（以 token 指紋 SET NX 佔用）——見 replay-guard.ts。同一 token
 *      再次交換（重放）→ 401，且不建立 user / 不簽 session。
 *   3. 以 (provider, sub) 找 / 建 internal user——見 user-store.ts（絕不以 email 為身份）。
 *   4. 後端簽發 access / refresh session token——見 session.ts。
 * client 不決定身份、不簽 session；任一步失敗都不回 2xx。
 *
 * 反重放為何不用 token 內嵌 nonce：classic `@react-native-google-signin`（free tier）的
 * `signIn()` 不透傳 nonce，要求 token 帶 nonce 會讓每次真實裝置登入都 fail-closed。改以
 * 「嚴格 iat 新鮮度 + id_token 一次性消費」——與所選 SDK 實際可執行的反重放合約（見
 * replay-guard.ts 對限制的誠實說明）。
 *
 * 依賴以函式介面注入（LoginDeps），僅 `import type` 引用型別（型別在執行期被抹除），
 * 因此本模組在執行期無 sibling import，單元測試可用假的 verify / store / signer 離線驗證。
 */
import type { GoogleIdentity } from './google-auth';
import type { ProviderProfile, ResolveResult } from './user-store';

export interface LoginRequestBody {
  provider?: string;
  id_token?: string;
}

export interface LoginDeps {
  /** 驗證 Google id_token（含 iat 新鮮度）；驗證失敗須 throw（handler 對應回 401）。 */
  verifyIdToken(
    idToken: string,
    opts: { allowedAudiences: string[] }
  ): Promise<GoogleIdentity>;
  /**
   * 一次性消費「已驗證的 id_token」。回 true 表示首次被本次呼叫佔用（放行）；
   * false 表示同一 token 曾被消費（重放）→ handler 對應回 401。
   * remainingTtlSec 為 token 剩餘壽命（exp - now），用來設定佔用鍵 TTL。
   */
  reserveIdTokenOnce(idToken: string, remainingTtlSec: number): Promise<boolean>;
  /** 以 (provider, sub) 找 / 建 internal user。 */
  resolveOrCreateUser(
    provider: string,
    profile: ProviderProfile
  ): Promise<ResolveResult>;
  signAccessToken(userId: string): string;
  signRefreshToken(userId: string): string;
  /** 允許的 Google audience（伺服器 Web client id）；空 → 501 AUTH_NOT_CONFIGURED。 */
  audiences: string[];
  /** AUTH_SESSION_SECRET 是否已設定；否 → 501 SESSION_NOT_CONFIGURED。 */
  sessionConfigured: boolean;
  /** access token 有效秒數（回應的 expires_in）。 */
  accessTtlSec: number;
  /** 現在時間（ms）；預設 Date.now，測試可注入。用來計算 token 剩餘壽命。 */
  now?: () => number;
}

export interface LoginResult {
  status: number;
  body: unknown;
}

function publicUser(user: ResolveResult['user']) {
  return {
    id: user.internalId,
    displayName: user.displayName,
    primaryEmail: user.primaryEmail,
    photoUrl: user.photoUrl,
    linkedProviders: user.linkedProviders.map((p) => ({
      provider: p.provider,
      providerId: p.providerId,
      email: p.email,
      displayName: p.displayName,
      photoUrl: p.photoUrl,
      linkedAt: p.linkedAt,
    })),
    createdAt: user.createdAt,
  };
}

export async function handleLogin(
  body: LoginRequestBody,
  deps: LoginDeps
): Promise<LoginResult> {
  // 本端點目前只處理 Google（native）。Apple native 走 iOS 原生流程、Web Apple 屬
  // DIC-663，皆未在此實作 → fail-closed。
  if (body.provider !== 'google') {
    return {
      status: 501,
      body: { error: 'PROVIDER_NOT_SUPPORTED', provider: body.provider ?? null },
    };
  }

  const idToken = body.id_token;
  if (typeof idToken !== 'string' || idToken.length === 0) {
    return { status: 400, body: { error: 'MISSING_ID_TOKEN' } };
  }

  if (!deps.sessionConfigured) {
    // AUTH_SESSION_SECRET 未設定：不簽任何 session token。
    return { status: 501, body: { error: 'SESSION_NOT_CONFIGURED' } };
  }
  if (deps.audiences.length === 0) {
    // 沒有可比對的 aud：不驗、不信任，直接 fail-closed。
    return { status: 501, body: { error: 'AUTH_NOT_CONFIGURED' } };
  }

  let identity: GoogleIdentity;
  try {
    identity = await deps.verifyIdToken(idToken, {
      allowedAudiences: deps.audiences,
    });
  } catch {
    return { status: 401, body: { error: 'INVALID_TOKEN' } };
  }

  // 一次性消費已驗證的 token：同一 token 重放 → 401，且不建立 user / 不簽 session。
  // TTL 綁 token 剩餘壽命；token 失效後由 exp 檢查接手。
  const nowSec = Math.floor((deps.now ?? (() => Date.now()))() / 1000);
  const remainingTtlSec = identity.expiresAt - nowSec;
  const firstUse = await deps.reserveIdTokenOnce(idToken, remainingTtlSec);
  if (!firstUse) {
    return { status: 401, body: { error: 'TOKEN_REPLAYED' } };
  }

  let resolved: ResolveResult;
  try {
    resolved = await deps.resolveOrCreateUser('google', {
      subject: identity.sub,
      email: identity.email,
      name: identity.name,
      photoUrl: identity.picture,
    });
  } catch {
    // 併發刪除（AccountConcurrentlyDeletedError）或身份儲存不一致：**不簽發任何 session**。
    // 回可重試的 fail-closed；client 重試會取得新 id_token 並乾淨建立單一新帳號（不分裂）。
    return { status: 503, body: { error: 'LOGIN_CONFLICT_RETRY' } };
  }
  const { user, isNewUser } = resolved;

  return {
    status: 200,
    body: {
      user: publicUser(user),
      session: {
        access_token: deps.signAccessToken(user.internalId),
        refresh_token: deps.signRefreshToken(user.internalId),
        expires_in: deps.accessTtlSec,
      },
      is_new_user: isNewUser,
    },
  };
}
