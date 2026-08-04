/**
 * POST /api/auth/login  { provider:'google', id_token }
 *   → 200 { user, session:{access_token,refresh_token,expires_in}, is_new_user }
 *
 * 權威登入端點（DIC-665）：驗 provider id_token（簽章 / iss / aud / exp / iat 新鮮度）→
 * 一次性消費該 id_token（token 指紋 SET NX 佔用，防重放）→ 以 (provider, sub) 找/建
 * internal user → 後端簽發 session token。client 送的是 native Google Sign-In 拿到的
 * id_token，**後端才是身份與 session 的唯一權威來源**（不信任 client 解碼的 payload /
 * userinfo）。
 *
 * 反重放為何不用 token 內嵌 nonce：classic `@react-native-google-signin`（free tier）的
 * `signIn()` 不透傳 nonce，改以「嚴格 iat 新鮮度 + id_token 一次性消費」（見
 * _lib/replay-guard.ts）——與所選 SDK 實際可執行的 fail-closed 反重放合約。
 *
 * fail-closed：缺 id_token 400；驗證失敗 401；同一 token 重放 401；audience / session
 * secret 未設定 501；provider 不支援 501。
 *
 * 依賴環境變數（於 Vercel 設定）：
 *   EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID（audience，僅 Web client，公開值）
 *   AUTH_SESSION_SECRET（HS256 session 簽章密鑰，機密，勿進 repo）
 *   KV_REST_API_URL / KV_REST_API_TOKEN（@vercel/kv；user / identity / 一次性 token 儲存）
 */
import { kv } from '@vercel/kv';

import {
  verifyGoogleIdToken,
  getConfiguredGoogleAudiences,
} from '../_lib/google-auth';
import { resolveOrCreateUser, type KVLike } from '../_lib/user-store';
import { reserveIdTokenOnce, type ReplayKVLike } from '../_lib/replay-guard';
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
    verifyIdToken: (idToken, opts) =>
      verifyGoogleIdToken(idToken, {
        allowedAudiences: opts.allowedAudiences,
      }),
    reserveIdTokenOnce: (idToken, remainingTtlSec) =>
      reserveIdTokenOnce(
        { kv: kv as unknown as ReplayKVLike },
        idToken,
        remainingTtlSec
      ),
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
