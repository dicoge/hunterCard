/**
 * POST /api/auth/delete-account  (DIC-663)
 *
 * App Store 審查規範 5.1.1(v)：提供社群登入的 App 必須讓使用者在 App 內刪除帳號，
 * 並在使用 Sign in with Apple 時撤銷 Apple 授權（revoke token）。
 *
 * 這是共用的「server-authoritative + fail-closed」刪除流程（CR DIC-854 blocker #2）。
 * 使用者身份取自 **session**（Bearer），不信任 client 傳來的 userId：
 *   1. 讀取 internal user 的 linked providers。
 *   2. 若有 Apple identity → 必須成功撤銷 Apple 授權才繼續；
 *      Apple 未設定 / 無保存的 refresh_token / 撤銷失敗 → 一律回非 2xx，**不刪除**。
 *   3. 撤銷確認後（或無 Apple identity）→ cascade 刪除 internal user 與所有 identities。
 *
 * fail-closed：任何一步無法確認成功即回非 2xx；client 端不得將帳號視為已刪除、
 * 不得清除本機 session（見 src/store/authStore.ts deleteUserAccount）。
 *
 * 撤銷所需的 refresh_token 於「登入當下」以 fresh authorizationCode 換取並保存
 * （見 api/auth/apple/register.ts）。⚠️ non-shipping foundation：
 * api/_lib/apple-token-store.ts 目前為介面樁，尚未接持久化，因此對「有 Apple identity」
 * 的帳號目前仍會回 501 `apple_deletion_not_implemented`（刻意 fail-closed，不是成功）。
 */
import { deleteUser, getUser } from '../_lib/identity-store';
import { getAppleConfig, revokeRefreshToken } from '../_lib/apple-auth';
import {
  getStoredAppleRefreshToken,
  deleteStoredAppleRefreshToken,
} from '../_lib/apple-token-store';
import { backendUnavailable, errorResponse, json, sessionUserId } from '../_lib/auth-endpoint';
import { toNodeHandler } from '../_lib/node-adapter';

export const config = { runtime: 'nodejs' };
export const maxDuration = 10;

async function webHandler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const unavailable = backendUnavailable();
  if (unavailable) return unavailable;

  const userId = sessionUserId(req);
  if (!userId) return json({ error: 'INVALID_TOKEN', reason: 'invalid_session' }, 401);

  try {
    const user = await getUser(userId);
    if (!user) return json({ deleted: false, reason: 'user_not_found' }, 404);

    const hasApple = user.linkedProviders.some((p) => p.provider === 'apple');

    if (hasApple) {
      const cfg = getAppleConfig();
      if (!cfg) {
        return json({ deleted: false, reason: 'apple_revocation_not_configured' }, 501);
      }
      const refreshToken = await getStoredAppleRefreshToken(userId);
      if (!refreshToken) {
        // No credential to revoke → fail-closed, do not delete.
        return json({ deleted: false, reason: 'apple_deletion_not_implemented' }, 501);
      }
      const revoked = await revokeRefreshToken(cfg, refreshToken);
      if (!revoked) return json({ deleted: false, reason: 'revoke_failed' }, 502);
      await deleteStoredAppleRefreshToken(userId);
    }

    const result = await deleteUser(userId);
    return json({ deleted: result.deletedInternalUser, revokedApple: hasApple }, 200);
  } catch (err) {
    return errorResponse(err);
  }
}

// Bridged to Vercel's classic Node `(req, res)` runtime (see node-adapter.ts).
export default toNodeHandler(webHandler);
