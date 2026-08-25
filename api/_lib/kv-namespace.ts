// DIC-1189: KV key namespace guard.
//
// The staging deployment is required to have its OWN Vercel KV / Upstash
// instance provisioned by the dic1189 setup workflow (independent resource).
// This namespace layer is defence-in-depth for the case where the staging KV
// instance ends up co-tenanted with production (workflow degrade path, manual
// misconfig, forgotten secret): every write from a staging process is scoped
// under `staging:` so it can never collide with or overwrite a production key,
// and every read/write in production is byte-identical to what shipped before
// (no prefix), so switching this module in has zero effect on the live
// production data path.
//
// Fail-closed rule: nsKey() reads APP_ENV via resolveAppEnv() which itself
// fails closed to production on unknown values, so a corrupted/missing env in
// a staging Vercel deployment would degrade to production behaviour (bare
// keys) — the *deployment* is broken at that point (banner/noindex also
// missing), which is what we want a human to see and fix rather than
// silently mixing traffic.

import { resolveAppEnv } from '../../src/config/appEnv';

export const STAGING_KV_PREFIX = 'staging:';

/**
 * Namespace a KV key for the current APP_ENV.
 *
 * - production / unset / unknown → returns `key` unchanged (production data
 *   path is byte-identical to pre-DIC-1189).
 * - staging → returns `staging:${key}` unless the key ALREADY carries the
 *   prefix (idempotent so wrappers can be composed without double-prefixing).
 *
 * Bare-key defence: staging callsites must NOT pass an empty key or a key that
 * begins with the raw prefix as a way of "opting out" of the namespace. Empty
 * keys throw; deliberately double-prefixed keys are collapsed to a single
 * prefix (idempotent).
 */
export function nsKey(key: string): string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('nsKey: key must be a non-empty string');
  }
  if (resolveAppEnv() !== 'staging') return key;
  if (key.startsWith(STAGING_KV_PREFIX)) return key;
  return `${STAGING_KV_PREFIX}${key}`;
}

/**
 * Namespace every string in an array of KV keys. Convenience for callers like
 * batched deletes / mget.
 */
export function nsKeys(keys: readonly string[]): string[] {
  return keys.map((k) => nsKey(k));
}

/**
 * Assert that a key seen inside a KV script (Lua argv) is namespace-correct
 * for the current env. Intended for defensive callsites that pass raw keys to
 * `kv.eval(...)` — Lua scripts see whatever the caller wrote, so we surface
 * mistakes at the boundary instead of after data lands in the wrong lane.
 */
export function assertNamespaced(key: string): void {
  if (resolveAppEnv() !== 'staging') return;
  if (!key.startsWith(STAGING_KV_PREFIX)) {
    throw new Error(
      `assertNamespaced: staging KV key "${key}" is missing the "${STAGING_KV_PREFIX}" prefix — refuse to write to production namespace.`,
    );
  }
}
