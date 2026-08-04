/**
 * 自家 app session token（HS256 JWT，DIC-665）。
 *
 * 登入時後端驗過 provider id_token、解出 internal user 後，由後端**權威簽發** access /
 * refresh token；client 不再自行決定身份或 session。密鑰取自 AUTH_SESSION_SECRET，
 * 未設定即 fail-closed（端點回 501，不簽任何 token）。
 *
 * 純函式 + 可注入 now，單元測試可離線驗證簽 / 驗與過期。
 */
import crypto from 'crypto';

export const ACCESS_TTL_SEC = 60 * 60; // 1h
export const REFRESH_TTL_SEC = 60 * 60 * 24 * 30; // 30d

export type SessionTokenType = 'access' | 'refresh';

export interface SessionConfig {
  secret: string;
  accessTtlSec: number;
  refreshTtlSec: number;
}

export interface SessionPayload {
  sub: string;
  type: SessionTokenType;
  iat: number;
  exp: number;
}

export class SessionTokenInvalidError extends Error {
  code = 'INVALID_SESSION';
  constructor(message: string) {
    super(message);
    this.name = 'SessionTokenInvalidError';
  }
}

/** 讀 AUTH_SESSION_SECRET；未設定回 null（呼叫端 fail-closed 回 501）。 */
export function getSessionConfig(): SessionConfig | null {
  const secret = process.env.AUTH_SESSION_SECRET;
  if (!secret) return null;
  return { secret, accessTtlSec: ACCESS_TTL_SEC, refreshTtlSec: REFRESH_TTL_SEC };
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function sign(signingInput: string, secret: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(signingInput)
    .digest('base64url');
}

function signToken(
  userId: string,
  type: SessionTokenType,
  secret: string,
  ttlSec: number,
  nowMs: number
): string {
  const nowSec = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({ sub: userId, type, iat: nowSec, exp: nowSec + ttlSec })
  );
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${sign(signingInput, secret)}`;
}

export function signAccessToken(
  userId: string,
  config: SessionConfig,
  now: () => number = Date.now
): string {
  return signToken(userId, 'access', config.secret, config.accessTtlSec, now());
}

export function signRefreshToken(
  userId: string,
  config: SessionConfig,
  now: () => number = Date.now
): string {
  return signToken(userId, 'refresh', config.secret, config.refreshTtlSec, now());
}

/**
 * 驗簽 + 檢查過期，回傳 payload。簽章不符 / 過期 / 型別不符一律 throw
 * SessionTokenInvalidError（fail-closed）。以 timingSafeEqual 比對簽章。
 */
export function verifySessionToken(
  token: string,
  secret: string,
  now: () => number = Date.now
): SessionPayload {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new SessionTokenInvalidError('Malformed session token');
  }
  const [headerB64, payloadB64, signatureB64] = parts;
  const expected = sign(`${headerB64}.${payloadB64}`, secret);

  const given = Buffer.from(signatureB64);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    throw new SessionTokenInvalidError('Bad signature');
  }

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw new SessionTokenInvalidError('Malformed payload');
  }

  const nowSec = Math.floor(now() / 1000);
  if (typeof payload.exp !== 'number' || nowSec > payload.exp) {
    throw new SessionTokenInvalidError('Session token expired');
  }
  return payload;
}
