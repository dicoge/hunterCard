/**
 * One-time Apple exchange-code store (DIC-960 / CR DIC-961).
 *
 * The server-callback flow must NOT put a raw bearer session on the return
 * channel: on Android a custom-scheme / not-yet-verified App Link is not
 * app-exclusive, so a leaked session would be directly usable by an interceptor.
 * Instead the callback issues a short-lived, single-use exchange code and stores
 * the session under it, bound to the request's PKCE code challenge. Only the app
 * that started the flow holds the matching verifier, so only it can redeem the
 * code into a session — an intercepted code alone is useless.
 *
 * Backed by the same Vercel KV used for ID-token replay protection. The store is
 * dependency-injectable (a KV-like client) so the redemption/replay logic is
 * unit-testable in plain Node without a live KV.
 */
import { kv as defaultKv } from '@vercel/kv';
import { verifyCodeChallenge } from './apple-web-oauth';

const EXCHANGE_PREFIX = 'apple:exchange:';
// A redemption round-trip (return page → app → POST redeem) completes in
// seconds; keep the window tight so an intercepted code is near-worthless even
// before its single-use consumption.
const EXCHANGE_TTL_SECONDS = 120;

export interface AppleExchangePayload {
  session: string;
  isNew: boolean;
  // base64url(SHA-256(verifier)) recovered from the signed state at callback time.
  challenge: string;
}

// Minimal structural view of the two KV operations we need, so a fake in-memory
// client can be injected in tests. `getdel` is atomic get-and-delete, which is
// what makes redemption single-use even under concurrent submissions.
export interface ExchangeKv {
  set(key: string, value: unknown, opts: { nx: true; ex: number }): Promise<unknown>;
  getdel(key: string): Promise<unknown>;
}

/**
 * Store the session under a fresh one-time code. `nx` guards against the
 * astronomically unlikely code collision; a non-'OK' result means the code was
 * already taken and the caller must fail closed rather than overwrite.
 */
export async function storeAppleExchange(
  code: string,
  payload: AppleExchangePayload,
  kvClient: ExchangeKv = defaultKv as unknown as ExchangeKv,
): Promise<void> {
  const result = await kvClient.set(EXCHANGE_PREFIX + code, payload, {
    nx: true,
    ex: EXCHANGE_TTL_SECONDS,
  });
  if (result !== 'OK') {
    throw new Error('apple_exchange_collision');
  }
}

/**
 * Atomically consume `code` and, ONLY if `verifier` hashes to the stored
 * challenge, return the session. Returns null for an unknown/expired/replayed
 * code, a malformed payload, or a verifier mismatch — the caller maps that to a
 * generic 401 so the two cases are indistinguishable to an attacker. The code is
 * consumed on the first redeem attempt (getdel), giving single-use replay
 * resistance.
 */
export async function redeemAppleExchange(
  code: string,
  verifier: string,
  kvClient: ExchangeKv = defaultKv as unknown as ExchangeKv,
): Promise<{ session: string; isNew: boolean } | null> {
  if (!code || !verifier) return null;
  const raw = await kvClient.getdel(EXCHANGE_PREFIX + code);
  if (!raw) return null;
  let payload: AppleExchangePayload;
  try {
    payload = (typeof raw === 'string' ? JSON.parse(raw) : raw) as AppleExchangePayload;
  } catch {
    return null;
  }
  if (!payload || typeof payload.session !== 'string' || !payload.session) return null;
  if (typeof payload.challenge !== 'string' || !payload.challenge) return null;
  if (!verifyCodeChallenge(verifier, payload.challenge)) return null;
  return { session: payload.session, isNew: Boolean(payload.isNew) };
}
