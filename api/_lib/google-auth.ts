/**
 * 伺服器端 Google ID token 驗證（DIC-665）。
 *
 * client（native Google Sign-In）拿到的 `id_token` 一律送後端驗證，**前端不可**
 * 自行解碼 payload 當身份來源，也**不可**信任 userinfo.sub。驗證項目：
 *   - 簽章：RS256，公鑰取自 Google JWKS（kid 對應）。
 *   - iss ∈ {accounts.google.com, https://accounts.google.com}
 *   - aud ∈ 已設定的 OAuth client id（web / ios / android）
 *   - exp / iat（含少量 clock skew）
 *   - nonce（若呼叫端提供 expectedNonce）
 *
 * 設計為可注入（fetchJwks / now），讓單元測試以測試用 RSA 金鑰簽 token 後離線驗證。
 * fail-closed：任一項不符即 throw GoogleTokenInvalidError；未設定 audience 即
 * throw GoogleAuthNotConfiguredError（端點對應回 501）。
 */
import crypto from 'crypto';

export const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

const GOOGLE_ISSUERS = new Set([
  'accounts.google.com',
  'https://accounts.google.com',
]);

const CLOCK_SKEW_SEC = 60;

/**
 * id_token 新鮮度上限（秒）：拒絕 `iat` 早於此值的 token。這是反重放的一環——
 * classic Google Sign-In 無法把 server nonce 寫入 token，改以「短新鮮度視窗 + 一次性
 * 消費」（見 replay-guard.ts）取代 nonce channel-binding，壓縮可被重放的時間窗。
 */
export const MAX_ID_TOKEN_AGE_SEC = 5 * 60; // 5 分鐘

export interface GoogleIdentity {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
  /** token 簽發時間（epoch 秒）。 */
  issuedAt: number;
  /** token 過期時間（epoch 秒）；呼叫端據此決定一次性佔用鍵的 TTL。 */
  expiresAt: number;
}

export class GoogleTokenInvalidError extends Error {
  code = 'INVALID_TOKEN';
  constructor(message: string) {
    super(message);
    this.name = 'GoogleTokenInvalidError';
  }
}

export class GoogleAuthNotConfiguredError extends Error {
  code = 'AUTH_NOT_CONFIGURED';
  constructor(message = 'No Google OAuth audience configured') {
    super(message);
    this.name = 'GoogleAuthNotConfiguredError';
  }
}

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

export type JwksFetcher = () => Promise<{ keys: Jwk[] }>;

export interface VerifyGoogleOptions {
  /** 允許的 aud 值（各平台 OAuth client id）；空陣列 → fail-closed。 */
  allowedAudiences: string[];
  /** 若提供，token 的 nonce 必須完全相等。 */
  expectedNonce?: string | null;
  /** 現在時間（ms）；預設 Date.now，測試可注入固定值。 */
  now?: () => number;
  /** 取 JWKS；預設打 Google certs endpoint，測試可注入假金鑰集。 */
  fetchJwks?: JwksFetcher;
}

function decodeSegment(segment: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new GoogleTokenInvalidError('Malformed token segment');
  }
}

async function defaultFetchJwks(): Promise<{ keys: Jwk[] }> {
  const res = await fetch(GOOGLE_CERTS_URL);
  if (!res.ok) {
    throw new GoogleTokenInvalidError(`JWKS fetch failed: ${res.status}`);
  }
  return (await res.json()) as { keys: Jwk[] };
}

function verifySignature(
  signingInput: string,
  signatureB64url: string,
  jwk: Jwk
): boolean {
  // format:'jwk' 讓 Node 直接以 JWK（n/e）建 RSA 公鑰；型別以 JsonWebKeyInput 表達。
  const key = crypto.createPublicKey({
    key: jwk as unknown as crypto.JsonWebKeyInput['key'],
    format: 'jwk',
  });
  return crypto.verify(
    'RSA-SHA256',
    Buffer.from(signingInput),
    key,
    Buffer.from(signatureB64url, 'base64url')
  );
}

/**
 * 驗證 Google `id_token` 並回傳身份。任何驗證失敗都 throw（fail-closed），
 * 呼叫端據此回 401；audience 未設定 throw GoogleAuthNotConfiguredError（→ 501）。
 */
export async function verifyGoogleIdToken(
  idToken: string,
  options: VerifyGoogleOptions
): Promise<GoogleIdentity> {
  if (options.allowedAudiences.length === 0) {
    throw new GoogleAuthNotConfiguredError();
  }
  if (typeof idToken !== 'string' || idToken.length === 0) {
    throw new GoogleTokenInvalidError('Missing id_token');
  }

  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new GoogleTokenInvalidError('id_token must have three segments');
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = decodeSegment(headerB64) as { alg?: string; kid?: string };
  if (header.alg !== 'RS256') {
    throw new GoogleTokenInvalidError(`Unexpected alg: ${header.alg}`);
  }
  if (!header.kid) {
    throw new GoogleTokenInvalidError('Missing kid in header');
  }

  const fetchJwks = options.fetchJwks ?? defaultFetchJwks;
  const { keys } = await fetchJwks();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    throw new GoogleTokenInvalidError('No matching JWK for kid');
  }

  if (!verifySignature(`${headerB64}.${payloadB64}`, signatureB64, jwk)) {
    throw new GoogleTokenInvalidError('Signature verification failed');
  }

  const payload = decodeSegment(payloadB64) as {
    iss?: string;
    aud?: string;
    sub?: string;
    exp?: number;
    iat?: number;
    nonce?: string;
    email?: string;
    email_verified?: boolean | string;
    name?: string;
    picture?: string;
  };

  if (!payload.iss || !GOOGLE_ISSUERS.has(payload.iss)) {
    throw new GoogleTokenInvalidError(`Untrusted issuer: ${payload.iss}`);
  }
  if (!payload.aud || !options.allowedAudiences.includes(payload.aud)) {
    throw new GoogleTokenInvalidError('Audience mismatch');
  }
  if (!payload.sub) {
    throw new GoogleTokenInvalidError('Missing subject');
  }

  const nowSec = Math.floor((options.now?.() ?? Date.now()) / 1000);
  if (typeof payload.exp !== 'number' || nowSec > payload.exp + CLOCK_SKEW_SEC) {
    throw new GoogleTokenInvalidError('Token expired');
  }
  // iat 為必要：反重放的新鮮度視窗與一次性佔用 TTL 都依賴它。
  if (typeof payload.iat !== 'number') {
    throw new GoogleTokenInvalidError('Missing iat');
  }
  if (nowSec + CLOCK_SKEW_SEC < payload.iat) {
    throw new GoogleTokenInvalidError('Token issued in the future');
  }
  // 嚴格新鮮度：拒絕過舊的 token，壓縮可被重放的時間窗（見 replay-guard.ts）。
  if (nowSec - payload.iat > MAX_ID_TOKEN_AGE_SEC + CLOCK_SKEW_SEC) {
    throw new GoogleTokenInvalidError('Token too old (stale iat)');
  }

  // nonce 為選用檢查：classic SDK 不寫入 nonce，故一般不傳 expectedNonce。若未來換用
  // 支援 nonce 的原生層再啟用，此處即可做完整 channel-binding。
  if (options.expectedNonce != null && payload.nonce !== options.expectedNonce) {
    throw new GoogleTokenInvalidError('Nonce mismatch');
  }

  const emailVerified =
    payload.email_verified === true || payload.email_verified === 'true';

  return {
    sub: payload.sub,
    email: payload.email ?? null,
    emailVerified,
    name: payload.name ?? null,
    picture: payload.picture ?? null,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
  };
}

/**
 * 允許的 Google audience：**僅**伺服器 Web client ID。
 *
 * native Google Sign-In 以 `webClientId`（= 伺服器 Web client）設定，故其 id_token 的
 * `aud` 一律是 Web client。刻意**不**接受 iOS / Android OAuth client id 當替代 audience——
 * 那些 client 沒有 client secret，接受它們會擴大可被接受的 token 來源。未設定 Web client
 * ID 時回空陣列，端點 fail-closed（501 AUTH_NOT_CONFIGURED）。
 */
export function getConfiguredGoogleAudiences(): string[] {
  const webClientId =
    process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ||
    process.env.GOOGLE_WEB_CLIENT_ID ||
    '';
  return webClientId.length > 0 ? [webClientId] : [];
}
