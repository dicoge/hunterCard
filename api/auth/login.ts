/**
 * POST /api/auth/login  { provider:'google', id_token, nonce }
 *   → 200 { user, session:{access_token,refresh_token,expires_in}, is_new_user }
 *
 * 權威登入端點（DIC-665）：消費一次性 nonce → 驗 provider id_token（含 nonce 相等）→
 * 以 (provider, sub) 找/建 internal user → 後端簽發 session token。client 送的是 native
 * Google Sign-In 拿到的 id_token 與先前向 /api/auth/nonce 取得的 nonce，**後端才是身份與
 * session 的唯一權威來源**（不信任 client 解碼的 payload / userinfo）。
 *
 * fail-closed：缺 nonce 400；nonce 已消費/過期/偽造 401；驗證失敗 401；audience / session
 * secret 未設定 501；provider 不支援 501。
 *
 * 依賴環境變數（於 Vercel 設定）：
 *   EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID（audience，僅 Web client，公開值）
 *   AUTH_SESSION_SECRET（HS256 session 簽章密鑰，機密，勿進 repo）
 *   KV_REST_API_URL / KV_REST_API_TOKEN（@vercel/kv；user / identity / nonce 儲存）
 */
import { kv } from '@vercel/kv';

import {
  verifyGoogleIdToken,
  getConfiguredGoogleAudiences,
} from '../_lib/google-auth';
import { resolveOrCreateUser, type KVLike } from '../_lib/user-store';
import { consumeNonce, type NonceKVLike } from '../_lib/nonce-store';
import {
  getSessionConfig,
  signAccessToken,
  signRefreshToken,
} from '../_lib/session';
import { handleLogin, type LoginRequestBody } from '../_lib/login-handler';

export const config = { runtime: 'nodejs' };
export const maxDuration = 10;

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

  let body: LoginRequestBody;
  try {
    body = (await req.json()) as LoginRequestBody;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const audiences = getConfiguredGoogleAudiences();
  const sessionConfig = getSessionConfig();

  const result = await handleLogin(body, {
    consumeNonce: (nonce) =>
      consumeNonce({ kv: kv as unknown as NonceKVLike }, nonce),
    verifyIdToken: (idToken, opts) =>
      verifyGoogleIdToken(idToken, {
        allowedAudiences: opts.allowedAudiences,
        expectedNonce: opts.expectedNonce,
      }),
    resolveOrCreateUser: (provider, profile) =>
      resolveOrCreateUser({ kv: kv as unknown as KVLike }, provider, profile),
    signAccessToken: (userId) =>
      sessionConfig ? signAccessToken(userId, sessionConfig) : '',
    signRefreshToken: (userId) =>
      sessionConfig ? signRefreshToken(userId, sessionConfig) : '',
    audiences,
    sessionConfigured: sessionConfig !== null,
    accessTtlSec: sessionConfig?.accessTtlSec ?? 0,
  });

  return json(result.body, result.status);
}
