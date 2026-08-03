/**
 * Sign in with Apple 伺服器端輔助：client secret 產生、authorization code 交換、
 * refresh token 撤銷。供 apple/register 與 auth/delete-account 共用。
 *
 * 需要的環境變數（於 Vercel 設定，切勿提交進 repo）：
 *   APPLE_TEAM_ID / APPLE_CLIENT_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY(.p8)
 */
import crypto from 'crypto';

export const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
export const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';

export interface AppleConfig {
  teamId: string;
  clientId: string;
  keyId: string;
  privateKey: string;
}

/** 從環境變數讀取設定；缺任一項回傳 null。 */
export function getAppleConfig(): AppleConfig | null {
  const teamId = process.env.APPLE_TEAM_ID;
  const clientId = process.env.APPLE_CLIENT_ID;
  const keyId = process.env.APPLE_KEY_ID;
  const privateKey = process.env.APPLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!teamId || !clientId || !keyId || !privateKey) return null;
  return { teamId, clientId, keyId, privateKey };
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/** 產生 Apple client secret（ES256 JWT），有效 5 分鐘。 */
export function buildAppleClientSecret(cfg: AppleConfig): string {
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

/**
 * 以「登入時」拿到的 fresh authorizationCode 換取 refresh_token。
 * authorizationCode 單次使用且短效——必須在登入當下使用，不可保存供日後刪除。
 * 失敗回傳 null。
 */
export async function exchangeAuthorizationCode(
  cfg: AppleConfig,
  authorizationCode: string
): Promise<string | null> {
  const res = await fetch(APPLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: buildAppleClientSecret(cfg),
      code: authorizationCode,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { refresh_token?: string };
  return data.refresh_token ?? null;
}

/** 撤銷已保存的 refresh_token（帳號刪除時呼叫）。成功回傳 true。 */
export async function revokeRefreshToken(
  cfg: AppleConfig,
  refreshToken: string
): Promise<boolean> {
  const res = await fetch(APPLE_REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: buildAppleClientSecret(cfg),
      token: refreshToken,
      token_type_hint: 'refresh_token',
    }),
  });
  return res.ok;
}
