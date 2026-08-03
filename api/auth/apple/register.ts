/**
 * POST /api/auth/apple/register
 *
 * 登入當下呼叫：以「fresh」authorizationCode 換取 refresh_token 並保存於後端，
 * 供日後帳號刪除時撤銷（App Store 5.1.1(v)）。
 *
 * 為什麼要在登入時做？authorizationCode 單次使用且短效，刪除當下不一定還有效，
 * 因此不可保存 authorizationCode 供日後使用——必須在登入當下換成長效 refresh_token。
 *
 * ⚠️ non-shipping foundation：refresh_token 儲存尚未接後端持久化（見 api/_lib/apple-token-store.ts）。
 * 未設定完整 Apple 環境變數時回 501；token store 未實作時回 501。
 * 本端點對登入流程為「best-effort」，client 端失敗不應阻擋登入（見 registerAppleSession）。
 */
import { getAppleConfig, exchangeAuthorizationCode } from '../../_lib/apple-auth';
import {
  persistAppleRefreshToken,
  TokenStoreNotImplementedError,
} from '../../_lib/apple-token-store';

export const config = { runtime: 'nodejs' };
export const maxDuration = 10;

interface RegisterRequestBody {
  provider?: string;
  userId?: string;
  authorizationCode?: string | null;
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

  let body: RegisterRequestBody;
  try {
    body = (await req.json()) as RegisterRequestBody;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  if (body.provider !== 'apple') {
    return json({ stored: false, reason: 'provider_not_supported' }, 501);
  }
  if (!body.userId) {
    return json({ stored: false, reason: 'missing_user_id' }, 400);
  }
  if (!body.authorizationCode) {
    return json({ stored: false, reason: 'missing_authorization_code' }, 400);
  }

  const cfg = getAppleConfig();
  if (!cfg) {
    return json({ stored: false, reason: 'apple_not_configured' }, 501);
  }

  const refreshToken = await exchangeAuthorizationCode(cfg, body.authorizationCode);
  if (!refreshToken) {
    return json({ stored: false, reason: 'token_exchange_failed' }, 502);
  }

  try {
    await persistAppleRefreshToken(body.userId, refreshToken);
    return json({ stored: true }, 200);
  } catch (err) {
    if (err instanceof TokenStoreNotImplementedError) {
      return json({ stored: false, reason: 'token_store_not_implemented' }, 501);
    }
    return json({ stored: false, reason: 'internal_error' }, 500);
  }
}
