/**
 * POST /api/auth/delete-account
 *
 * App Store 審查規範 5.1.1(v)：提供社群登入的 App 必須讓使用者在 App 內刪除帳號，
 * 並在使用 Sign in with Apple 時撤銷 Apple 授權（revoke token）。
 *
 * 撤銷策略（重要）：
 *   撤銷所需的 refresh_token 必須在「登入當下」用 fresh authorizationCode 換取並保存
 *   （見 api/auth/apple/register.ts）。authorizationCode 單次使用且短效，刪除當下
 *   通常已失效，因此本端點**不**接受 client 傳來的 authorizationCode。
 *
 * fail-closed：無法確認撤銷成功時一律回非 2xx，client 端不得將帳號視為已刪除、
 * 不得清除本機 session（見 src/stores/authStore.ts deleteAccount）。
 *
 * ⚠️ non-shipping foundation：refresh_token 儲存尚未接後端持久化
 * （api/lib/apple-token-store.ts 為介面樁）。因此目前對已設定 Apple 環境變數的情況
 * 仍會回 501 `apple_deletion_not_implemented`——這是刻意的 fail-closed，不是成功。
 *
 * 依賴環境變數（於 Vercel 設定，切勿提交進 repo）：
 *   APPLE_TEAM_ID / APPLE_CLIENT_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY(.p8)
 */
import { getAppleConfig, revokeRefreshToken } from '../lib/apple-auth';
import {
  getStoredAppleRefreshToken,
  deleteStoredAppleRefreshToken,
} from '../lib/apple-token-store';

export const config = { runtime: 'nodejs' };
export const maxDuration = 10;

interface DeleteRequestBody {
  provider?: string;
  userId?: string;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  let body: DeleteRequestBody;
  try {
    body = (await req.json()) as DeleteRequestBody;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  if (body.provider !== 'apple') {
    // Google 撤銷尚未接線；fail-closed，client 不得視為已刪除。
    return json({ revoked: false, reason: 'provider_not_supported' }, 501);
  }
  if (!body.userId) {
    return json({ revoked: false, reason: 'missing_user_id' }, 400);
  }

  const cfg = getAppleConfig();
  if (!cfg) {
    return json({ revoked: false, reason: 'apple_revocation_not_configured' }, 501);
  }

  // 取出登入時保存的 refresh_token。foundation 階段 token store 未實作 → null。
  const refreshToken = await getStoredAppleRefreshToken(body.userId);
  if (!refreshToken) {
    // 沒有可撤銷的憑證：fail-closed，明確標示尚未實作，切勿回成功。
    return json({ revoked: false, reason: 'apple_deletion_not_implemented' }, 501);
  }

  try {
    const revoked = await revokeRefreshToken(cfg, refreshToken);
    if (!revoked) {
      return json({ revoked: false, reason: 'revoke_failed' }, 502);
    }

    await deleteStoredAppleRefreshToken(body.userId);
    // TODO(後續): 於此級聯刪除 / 匿名化與此 userId 關聯的後端使用者資料。
    return json({ revoked: true }, 200);
  } catch {
    return json({ revoked: false, reason: 'internal_error' }, 500);
  }
}
