// DIC-1189: KV key namespace guard.
//
// The staging deployment is required to have its OWN Vercel KV / Upstash
// instance provisioned by the dic1189 setup workflow. This namespace layer is
// defence-in-depth for the case where the staging KV instance ever ends up
// co-tenanted with production: every write from a staging process is scoped
// under `staging:` so it can never collide with or overwrite a production
// key. In production nsKey() returns the bare key so wire format is
// byte-identical to pre-DIC-1189.
//
// Rework-blocker #2: nsKey() uses resolveAppEnvStrict() — missing / unknown
// APP_ENV throws AppEnvUnresolved rather than silently returning a bare
// production key. On production the Vercel project MUST set
// APP_ENV=production explicitly for this to succeed; the dic1189 setup
// workflow's `set-production-app-env` step (guarded, idempotent, no other
// mutation) makes that true on `holocard-hunter` in the same apply run.

import { AppEnvUnresolved, resolveAppEnvStrict } from '../../src/config/appEnv';
import { PAYMENT_ENV_VARS, PRODUCT_MODE_VARS, WEBHOOK_LIVEMODE_VAR, assertPaymentEnv } from './env-guard';

export const STAGING_KV_PREFIX = 'staging:';

// DIC-1189 rework-blocker #6: run assertPaymentEnv() at module import so any
// endpoint that transitively imports kv-namespace (all API paths that touch
// KV — auth, push, account-sync, apple-exchange, token-replay) has the
// payment env cross-checked BEFORE it serves its first request. Serverless
// cold starts import this module once per process, so the check runs once
// per instance.
//
// Silent no-op ONLY when APP_ENV is unset AND no payment-related env is
// present. Rework 3rd pass — blocker #5: "payment-related" is defined
// broadly across every dimension of exposure the guard covers:
//   - payment credentials (STRIPE_SECRET_KEY, RC keys, ...)
//   - product-mode sentinels (STRIPE_MODE, REVENUECAT_ENVIRONMENT)
//   - webhook livemode sentinel (STRIPE_WEBHOOK_LIVEMODE)
// So an unattributed deployment that sets STRIPE_MODE=test (with no
// credential) is still refused at boot — the sentinel itself is a signal
// that this deployment expects to service payment traffic, and that is
// exactly the case that must be laned.
(function bootGuard() {
  const hasPaymentExposure =
    PAYMENT_ENV_VARS.some(({ name }) => {
      const raw = process.env[name];
      return typeof raw === 'string' && raw.length > 0;
    }) ||
    PRODUCT_MODE_VARS.some(({ name }) => {
      const raw = process.env[name];
      return typeof raw === 'string' && raw.length > 0;
    }) ||
    (typeof process.env[WEBHOOK_LIVEMODE_VAR] === 'string' &&
      (process.env[WEBHOOK_LIVEMODE_VAR] as string).length > 0);
  try {
    assertPaymentEnv();
  } catch (err) {
    if (err instanceof AppEnvUnresolved && !hasPaymentExposure) {
      // Unattributed environment with zero payment exposure — allow (test/
      // dev). The first nsKey() call still throws AppEnvUnresolved if this
      // deployment ever tries to use KV, so KV traffic is not affected.
      return;
    }
    // Attributed env with a real mismatch, OR unattributed env with ANY
    // payment-related exposure — fail closed.
    throw err;
  }
})();

/**
 * Namespace a KV key for the current APP_ENV.
 *
 * - APP_ENV=production → returns `key` unchanged.
 * - APP_ENV=staging    → returns `staging:${key}` (idempotent — a key that
 *   already carries the prefix is returned unchanged).
 * - anything else      → throws AppEnvUnresolved (fail closed).
 *
 * Bare-key defence: empty keys throw; deliberately double-prefixed keys are
 * collapsed to a single prefix.
 */
export function nsKey(key: string): string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('nsKey: key must be a non-empty string');
  }
  const appEnv = resolveAppEnvStrict();
  if (appEnv !== 'staging') return key;
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
  if (resolveAppEnvStrict() !== 'staging') return;
  if (!key.startsWith(STAGING_KV_PREFIX)) {
    throw new Error(
      `assertNamespaced: staging KV key "${key}" is missing the "${STAGING_KV_PREFIX}" prefix — refuse to write to production namespace.`,
    );
  }
}
