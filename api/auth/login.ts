/**
 * POST /api/auth/login  { provider:'google', id_token, nonce? }
 *   → 200 { user, session:{access_token,refresh_token,expires_in}, is_new_user }
 *
 * 權威登入端點（DIC-665）：驗 provider id_token → 以 (provider, sub) 找/建 internal
 * user → 後端簽發 session token。client 送的是 native Google Sign-In 拿到的 id_token，
 * **後端才是身份與 session 的唯一權威來源**（不信任 client 解碼的 payload / userinfo）。
 *
 * fail-closed：驗證失敗 401；audience / session secret 未設定 501；provider 不支援 501。
 *
 * 依賴環境變數（於 Vercel 設定）：
 *   EXPO_PUBLIC_GOOGLE_{WEB,IOS,ANDROID}_CLIENT_ID（audience，公開值）
 *   AUTH_SESSION_SECRET（HS256 session 簽章密鑰，機密，勿進 repo）
 *   KV_REST_API_URL / KV_REST_API_TOKEN（@vercel/kv）
 */
import { kv } from '@vercel/kv';

import {
  verifyGoogleIdToken,
  getConfiguredGoogleAudiences,
} from '../lib/google-auth';
import { resolveOrCreateUser, type KVLike } from '../lib/user-store';
import {
  getSessionConfig,
  signAccessToken,
  signRefreshToken,
} from '../lib/session';
import { handleLogin, type LoginRequestBody } from '../lib/login-handler';

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
