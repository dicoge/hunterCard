/**
 * POST /api/auth/delete-account
 *   Authorization: Bearer <access_token>
 *   → 200 { deleted:true } 才可讓 client 清本機 session。
 *
 * 權威、已驗證的帳號刪除（DIC-665）。身份取自 **後端驗過的 access token**，不信任 client
 * 傳來的 userId。流程與 fail-closed 規則見 api/_lib/delete-handler.ts：
 *   - google：刪 auth:identity / auth:user（無 provider 端撤銷需求）。
 *   - apple：先撤銷 Apple 授權（App Store 5.1.1(v)），撤銷成功才刪資料；否則 fail-closed。
 *
 * App Store 審查規範 5.1.1(v)：提供社群登入的 App 必須讓使用者在 App 內刪除帳號，
 * 並在使用 Sign in with Apple 時撤銷 Apple 授權（revoke token）。
 *
 * ⚠️ Apple refresh_token 儲存仍為 non-shipping foundation（api/_lib/apple-token-store.ts
 * 為介面樁）。故對 apple-linked 使用者，撤銷取不到憑證時 fail-closed 回 501
 * `apple_deletion_not_implemented`——刻意不回成功。Google 刪除為 shipping 路徑。
 *
 * 依賴環境變數（於 Vercel 設定，切勿提交進 repo）：
 *   AUTH_SESSION_SECRET（驗 access token）
 *   KV_REST_API_URL / KV_REST_API_TOKEN（@vercel/kv；user / identity 儲存）
 *   APPLE_TEAM_ID / APPLE_CLIENT_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY(.p8)（Apple 撤銷）
 */
import { kv } from '@vercel/kv';

import { getSessionConfig, verifySessionToken } from '../_lib/session';
import {
  deleteUser,
  getUserById,
  type KVLike,
} from '../_lib/user-store';
import {
  handleDeleteAccount,
  type AppleRevokeResult,
} from '../_lib/delete-handler';
import { getAppleConfig, revokeRefreshToken } from '../_lib/apple-auth';
import {
  getStoredAppleRefreshToken,
  deleteStoredAppleRefreshToken,
} from '../_lib/apple-token-store';

export const config = { runtime: 'nodejs' };
export const maxDuration = 10;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * saga 步驟 1：撤銷某 user 的 Apple 授權——**只撤銷，不刪保存的 refresh token**。
 * 撤銷對 Apple 為 idempotent（重複撤銷同一 token 為 no-op），故重試安全。任一步未成功皆
 * fail-closed（ok:false）→ handler 不刪任何資料。刪除保存的 token 延後到 user 狀態刪除
 * 成功之後（cleanupAppleAfterDelete），避免 user 刪除失敗時 token 已被清掉而永久卡住帳號。
 */
async function revokeAppleForUser(userId: string): Promise<AppleRevokeResult> {
  const cfg = getAppleConfig();
  if (!cfg) {
    return { ok: false, status: 501, reason: 'apple_revocation_not_configured' };
  }
  const refreshToken = await getStoredAppleRefreshToken(userId);
  if (!refreshToken) {
    // foundation：token store 未接持久化 → 無憑證可撤銷，fail-closed。
    return { ok: false, status: 501, reason: 'apple_deletion_not_implemented' };
  }
  try {
    const revoked = await revokeRefreshToken(cfg, refreshToken);
    if (!revoked) {
      return { ok: false, status: 502, reason: 'revoke_failed' };
    }
    return { ok: true };
  } catch {
    return { ok: false, status: 500, reason: 'internal_error' };
  }
}

/**
 * saga 步驟 3：user 狀態原子刪除成功後才刪保存的 Apple refresh token（best-effort）。
 * 刻意排最後：若刪除失敗，token 保留供重試重新撤銷＋重刪，帳號不被永久卡住。
 */
async function cleanupAppleAfterDelete(userId: string): Promise<void> {
  await deleteStoredAppleRefreshToken(userId);
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  const sessionConfig = getSessionConfig();

  const result = await handleDeleteAccount(
    { authorization: req.headers.get('authorization') },
    {
      sessionSecret: sessionConfig?.secret ?? null,
      verifyAccessToken: (token) =>
        verifySessionToken(token, sessionConfig?.secret ?? ''),
      getUser: (userId) =>
        getUserById({ kv: kv as unknown as KVLike }, userId),
      deleteUser: (userId) =>
        deleteUser({ kv: kv as unknown as KVLike }, userId),
      revokeAppleForUser,
      cleanupAppleAfterDelete,
    }
  );

  return json(result.body, result.status);
}
