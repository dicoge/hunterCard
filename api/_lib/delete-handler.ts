/**
 * `POST /api/auth/delete-account` 的核心邏輯（DIC-665），與 HTTP 層解耦以便單元測試。
 *
 * 權威、已驗證的帳號刪除（fail-closed）：
 *   1. 從 `Authorization: Bearer <access_token>` 取出 app session token，後端**驗簽 + 驗型別**
 *      （access）解出 internal userId——**不信任** client 傳來的 userId（先前版本信任 body.userId
 *      是可被冒用的漏洞）。
 *   2. 讀出後端權威 user，對每一個 linked provider 決定撤銷需求：
 *        - apple：必須成功撤銷 Apple 授權（App Store 5.1.1(v)）；撤銷失敗 / 未設定 → fail-closed，
 *          **不**刪除任何資料、回非 2xx，client 須維持登入。
 *        - google：無 provider 端撤銷需求，直接進入資料刪除。
 *   3. 刪除後端權威狀態：每個 `auth:identity:{provider}:{subject}` 與 `auth:user:{id}`
 *      （見 user-store.ts deleteUser）。刪除後同一 Google 帳號再登入會被視為新使用者。
 *
 * client 端唯有收到 2xx 才可清本機 session；任一步失敗都回非 2xx 並保留登入狀態
 * （見 src/services/authService.ts deleteAccount）。
 *
 * 依賴以函式介面注入（DeleteDeps），單元測試可用假的 verify / store 離線驗證。
 */
import type { SessionPayload } from './session';
import type { StoredUser, DeleteResult } from './user-store';

export interface DeleteRequestInput {
  /** 原始 Authorization header 值（可能為 null）。 */
  authorization: string | null;
}

/** apple 撤銷結果：ok=false 時 handler fail-closed 用 status/reason 回應且不刪資料。 */
export interface AppleRevokeResult {
  ok: boolean;
  status?: number;
  reason?: string;
}

export interface DeleteDeps {
  /** AUTH_SESSION_SECRET；null → 501 SESSION_NOT_CONFIGURED（不驗、不刪）。 */
  sessionSecret: string | null;
  /** 驗 access token 簽章 + 過期，回 payload；失敗須 throw（handler 對應回 401）。 */
  verifyAccessToken(token: string): SessionPayload;
  /** 以 internal id 讀權威 user；找不到回 null。 */
  getUser(userId: string): Promise<StoredUser | null>;
  /** 刪除該 user 的所有身份鍵與 user record。 */
  deleteUser(userId: string): Promise<DeleteResult>;
  /**
   * 撤銷某 user 的 Apple 授權（僅在該 user 有 apple linked provider 時呼叫）。
   * 回 ok=false 即 fail-closed：不刪任何資料。未提供而使用者又是 apple → 視為未設定，fail-closed。
   */
  revokeAppleForUser?(userId: string): Promise<AppleRevokeResult>;
}

export interface DeleteResponse {
  status: number;
  body: unknown;
}

function parseBearer(authorization: string | null): string | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return m ? m[1].trim() : null;
}

export async function handleDeleteAccount(
  input: DeleteRequestInput,
  deps: DeleteDeps
): Promise<DeleteResponse> {
  if (!deps.sessionSecret) {
    // 無 session 密鑰：無法驗證身份，fail-closed。
    return { status: 501, body: { error: 'SESSION_NOT_CONFIGURED' } };
  }

  const token = parseBearer(input.authorization);
  if (!token) {
    return { status: 401, body: { error: 'MISSING_ACCESS_TOKEN' } };
  }

  let payload: SessionPayload;
  try {
    payload = deps.verifyAccessToken(token);
  } catch {
    return { status: 401, body: { error: 'INVALID_ACCESS_TOKEN' } };
  }
  if (payload.type !== 'access') {
    // 只接受 access token；refresh token 不得用來刪帳號。
    return { status: 401, body: { error: 'INVALID_ACCESS_TOKEN' } };
  }

  const userId = payload.sub;
  const user = await deps.getUser(userId);
  if (!user) {
    // 已無資料：idempotent 成功（token 有效但 user 已被刪）。
    return { status: 200, body: { deleted: true, alreadyDeleted: true } };
  }

  const hasApple = user.linkedProviders.some((p) => p.provider === 'apple');
  if (hasApple) {
    if (!deps.revokeAppleForUser) {
      return {
        status: 501,
        body: { error: 'APPLE_REVOCATION_NOT_CONFIGURED' },
      };
    }
    const revoke = await deps.revokeAppleForUser(userId);
    if (!revoke.ok) {
      // 撤銷未成功 → 一律 fail-closed，不刪任何資料。
      return {
        status: revoke.status ?? 502,
        body: { error: revoke.reason ?? 'APPLE_REVOKE_FAILED' },
      };
    }
  }

  const result = await deps.deleteUser(userId);
  return {
    status: 200,
    body: {
      deleted: true,
      removedIdentities: result.removedIdentities,
    },
  };
}
