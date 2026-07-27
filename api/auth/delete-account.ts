/**
 * POST /api/auth/delete-account
 *
 * App Store 審查規範 5.1.1(v)：提供社群登入的 App 必須讓使用者在 App 內刪除帳號，
 * 並在使用 Sign in with Apple 時撤銷 Apple 授權（revoke token）。
 *
 * 本端點依賴以下環境變數（於 Vercel 專案設定，切勿提交進 repo）：
 *   APPLE_TEAM_ID      Apple Developer Team ID
 *   APPLE_CLIENT_ID    Services ID（web）或 app bundle id（native）
 *   APPLE_KEY_ID       Sign in with Apple 私鑰的 Key ID
 *   APPLE_PRIVATE_KEY  .p8 私鑰內容（含 BEGIN/END，換行以 \n 表示）
 *
 * 未設定完整環境變數時回傳 501，讓 client 端仍清除本機 session 並提示使用者。
 *
 * 註：完整撤銷需要在「登入時」用 authorizationCode 向 /auth/token 換取 refresh_token
 * 並保存；此處示範以當前 authorizationCode 直接換取後撤銷（見 docs/AUTH_SETUP.md）。
 */
import crypto from 'crypto';

export const config = { runtime: 'nodejs' };
export const maxDuration = 10;

const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';

interface DeleteRequestBody {
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

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/** 產生 Apple client secret（ES256 JWT），有效 5 分鐘。 */
function buildAppleClientSecret(cfg: {
  teamId: string;
  clientId: string;
  keyId: string;
  privateKey: string;
}): string {
  const header = { alg: 'ES256', kid: cfg.keyId, typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: cfg.teamId,
    iat: now,
    exp: now + 300,
    aud: 'https://appleid.apple.com',
    sub: cfg.clientId,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(payload)
  )}`;
  const signer = crypto.createSign('SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign({ key: cfg.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${base64url(signature)}`;
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
    // Google 撤銷尚未接線；client 端仍會清除本機 session。
    return json({ revoked: false, reason: 'provider_not_supported' }, 501);
  }

  const teamId = process.env.APPLE_TEAM_ID;
  const clientId = process.env.APPLE_CLIENT_ID;
  const keyId = process.env.APPLE_KEY_ID;
  const privateKey = process.env.APPLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!teamId || !clientId || !keyId || !privateKey) {
    return json({ revoked: false, reason: 'apple_revocation_not_configured' }, 501);
  }

  if (!body.authorizationCode) {
    return json({ revoked: false, reason: 'missing_authorization_code' }, 400);
  }

  try {
    const clientSecret = buildAppleClientSecret({ teamId, clientId, keyId, privateKey });

    // 1. authorizationCode → refresh_token
    const tokenRes = await fetch(APPLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: body.authorizationCode,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenRes.ok) {
      return json({ revoked: false, reason: 'token_exchange_failed' }, 502);
    }
    const tokenData = (await tokenRes.json()) as { refresh_token?: string };
    const refreshToken = tokenData.refresh_token;
    if (!refreshToken) {
      return json({ revoked: false, reason: 'no_refresh_token' }, 502);
    }

    // 2. 撤銷 refresh_token
    const revokeRes = await fetch(APPLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        token: refreshToken,
        token_type_hint: 'refresh_token',
      }),
    });

    if (!revokeRes.ok) {
      return json({ revoked: false, reason: 'revoke_failed' }, 502);
    }

    // TODO(後續): 於此刪除後端與此 userId 關聯的使用者資料。
    return json({ revoked: true }, 200);
  } catch {
    return json({ revoked: false, reason: 'internal_error' }, 500);
  }
}
