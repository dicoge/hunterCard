/**
 * `POST /api/auth/login` 的核心邏輯（DIC-665），與 HTTP 層及具體實作解耦以便單元測試。
 *
 * 權威流程（fail-closed）：
 *   1. **消費 server-bound 一次性 nonce**（原子 GETDEL）——見 nonce-store.ts。缺 nonce
 *      → 400；已消費 / 過期 / 偽造 → 401，且**不**進行後續驗證。
 *   2. 驗 provider id_token（簽章 / iss / aud / exp / **nonce 必相等**）——見 google-auth.ts。
 *   3. 以 (provider, sub) 找 / 建 internal user——見 user-store.ts（絕不以 email 為身份）。
 *   4. 後端簽發 access / refresh session token——見 session.ts。
 * client 不決定身份、不簽 session；任一步失敗都不回 2xx。nonce 為**強制**：不接受省略。
 *
 * 依賴以函式介面注入（LoginDeps），僅 `import type` 引用型別（型別在執行期被抹除），
 * 因此本模組在執行期無 sibling import，單元測試可用假的 verify / store / signer 離線驗證。
 */
import type { GoogleIdentity } from './google-auth';
import type { ProviderProfile, ResolveResult } from './user-store';

export interface LoginRequestBody {
  provider?: string;
  id_token?: string;
  nonce?: string | null;
}

export interface LoginDeps {
  /**
   * 原子消費 server-bound 一次性 nonce。回 true 表示存在且此刻被消費（放行）；
   * false 表示缺失 / 已消費 / 過期 / 偽造（handler 對應回 401）。
   */
  consumeNonce(nonce: string): Promise<boolean>;
  /** 驗證 Google id_token；驗證失敗須 throw（handler 對應回 401）。 */
  verifyIdToken(
    idToken: string,
    opts: { allowedAudiences: string[]; expectedNonce: string }
  ): Promise<GoogleIdentity>;
  /** 以 (provider, sub) 找 / 建 internal user。 */
  resolveOrCreateUser(
    provider: string,
    profile: ProviderProfile
  ): Promise<ResolveResult>;
  signAccessToken(userId: string): string;
  signRefreshToken(userId: string): string;
  /** 允許的 Google audience（各平台 client id）；空 → 501 AUTH_NOT_CONFIGURED。 */
  audiences: string[];
  /** AUTH_SESSION_SECRET 是否已設定；否 → 501 SESSION_NOT_CONFIGURED。 */
  sessionConfigured: boolean;
  /** access token 有效秒數（回應的 expires_in）。 */
  accessTtlSec: number;
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

  const nonce = body.nonce;
  if (typeof nonce !== 'string' || nonce.length === 0) {
    // nonce 為強制：不接受省略的 nonce（否則等同放棄重放防護）。
    return { status: 400, body: { error: 'MISSING_NONCE' } };
  }

  if (!deps.sessionConfigured) {
    // AUTH_SESSION_SECRET 未設定：不簽任何 session token。
    return { status: 501, body: { error: 'SESSION_NOT_CONFIGURED' } };
  }
  if (deps.audiences.length === 0) {
    // 沒有可比對的 aud：不驗、不信任，直接 fail-closed。
    return { status: 501, body: { error: 'AUTH_NOT_CONFIGURED' } };
  }

  // 原子消費一次性 nonce；不存在 / 已消費 / 過期 → 401，且不再驗 token（防重放）。
  const nonceOk = await deps.consumeNonce(nonce);
  if (!nonceOk) {
    return { status: 401, body: { error: 'NONCE_REPLAYED' } };
  }

  let identity: GoogleIdentity;
  try {
    identity = await deps.verifyIdToken(idToken, {
      allowedAudiences: deps.audiences,
      // 已消費的 nonce 必須與 token 的 nonce claim 完全相等，否則驗證失敗。
      expectedNonce: nonce,
    });
  } catch {
    return { status: 401, body: { error: 'INVALID_TOKEN' } };
  }

  const { user, isNewUser } = await deps.resolveOrCreateUser('google', {
    subject: identity.sub,
    email: identity.email,
    name: identity.name,
    photoUrl: identity.picture,
  });

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
