// DIC-1189: payment environment guard (fail-closed scaffolding).
//
// There is NO live payment integration in the repo yet — this module exists
// so that when Stripe / RevenueCat / StoreKit code is eventually wired in it
// MUST call assertPaymentEnv() at boot before it can talk to the provider.
//
// The guard enforces FOUR invariants that hold even in the absence of an
// integration (rework-blocker #6 — extended from the original three):
//
//   1. Environment: APP_ENV must be explicitly 'production' or 'staging' via
//      resolveAppEnvStrict(). Missing / unknown APP_ENV throws
//      AppEnvUnresolved, so a payment provider client can never be
//      constructed in an unattributed environment.
//
//   2. Credential mode: every declared payment secret in PAYMENT_ENV_VARS is
//      classified by prefix (Stripe sk_live/sk_test/pk_*, RevenueCat
//      appl_/goog_/sk_test/sandbox_). Staging refuses any 'live' credential;
//      production refuses any 'test' credential; unknown prefixes fail
//      closed in whichever environment they show up in.
//
//   3. Product mode: STRIPE_MODE / REVENUECAT_ENVIRONMENT sentinel vars, if
//      set, must match the deployment lane ('test' & 'sandbox' on staging;
//      'live' & 'production' on production). Any mismatch throws.
//
//   4. Webhook livemode: STRIPE_WEBHOOK_LIVEMODE, if set, must be exactly
//      'true' in production and exactly 'false' in staging. This is the
//      Stripe-webhook payload's own `livemode` boolean lifted into env so
//      the deployment refuses to boot a webhook handler that would accept
//      the wrong mode.
//
// The guard does NOT require payment secrets to be present (there is no
// payment code yet). What it enforces is that WHEN they are set, everything
// agrees with the deployment lane.
//
// assertPaymentEnv() is called at module load of api/_lib/kv-namespace.ts
// (the boot-time entry point every API endpoint imports transitively), so
// every serverless-function cold start runs the check before it can service
// its first request.

import { resolveAppEnvStrict, type AppEnv } from '../../src/config/appEnv';

export type PaymentEnvReason =
  | 'live_key_in_staging'
  | 'test_key_in_production'
  | 'unknown_prefix_in_staging'
  | 'unknown_prefix_in_production'
  | 'product_mode_mismatch_in_staging'
  | 'product_mode_mismatch_in_production'
  | 'unknown_product_mode_in_staging'
  | 'unknown_product_mode_in_production'
  | 'webhook_livemode_mismatch_in_staging'
  | 'webhook_livemode_mismatch_in_production'
  | 'unknown_webhook_livemode';

export type PaymentEnvIssue = {
  varName: string;
  reason: PaymentEnvReason;
};

type Classification = 'live' | 'test' | 'unknown';

// Prefix maps. Kept explicit and small — anything not on the list is treated
// as 'unknown', which fails closed in the environment it's set in (unknown
// live/test provenance is not a safe basis for accepting a payment secret).
const STRIPE_LIVE_PREFIXES = ['sk_live_', 'rk_live_', 'pk_live_', 'whsec_live_'];
const STRIPE_TEST_PREFIXES = ['sk_test_', 'rk_test_', 'pk_test_', 'whsec_test_'];

const REVENUECAT_LIVE_PREFIXES = [
  'sk_live_', // RC v3 secret (live)
  'appl_', // RC iOS public SDK key (live)
  'goog_', // RC Android public SDK key (live)
  'strp_', // RC Stripe app public SDK key (live)
];
const REVENUECAT_TEST_PREFIXES = ['sk_test_', 'sandbox_'];

// Known payment env vars that this guard understands. The list is deliberately
// forward-looking: future Stripe / RevenueCat integrations should set one of
// these names so the guard automatically covers them at boot.
export const PAYMENT_ENV_VARS: ReadonlyArray<{
  name: string;
  provider: 'stripe' | 'revenuecat';
}> = [
  { name: 'STRIPE_SECRET_KEY', provider: 'stripe' },
  { name: 'STRIPE_RESTRICTED_KEY', provider: 'stripe' },
  { name: 'STRIPE_WEBHOOK_SECRET', provider: 'stripe' },
  { name: 'EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY', provider: 'stripe' },
  { name: 'REVENUECAT_SECRET_KEY', provider: 'revenuecat' },
  { name: 'REVENUECAT_WEBHOOK_AUTH', provider: 'revenuecat' },
  { name: 'EXPO_PUBLIC_REVENUECAT_IOS_KEY', provider: 'revenuecat' },
  { name: 'EXPO_PUBLIC_REVENUECAT_ANDROID_KEY', provider: 'revenuecat' },
];

// Product-mode sentinels. STRIPE_MODE is the human-readable declaration of
// which Stripe workspace this deployment is bound to (test vs live catalog);
// REVENUECAT_ENVIRONMENT is the same for RC (sandbox vs production catalog).
// Set them alongside the secret keys and the guard cross-checks agreement
// with the deployment lane.
export const PRODUCT_MODE_VARS: ReadonlyArray<{
  name: string;
  provider: 'stripe' | 'revenuecat';
  expectedProduction: string;
  expectedStaging: string;
}> = [
  { name: 'STRIPE_MODE', provider: 'stripe', expectedProduction: 'live', expectedStaging: 'test' },
  {
    name: 'REVENUECAT_ENVIRONMENT',
    provider: 'revenuecat',
    expectedProduction: 'production',
    expectedStaging: 'sandbox',
  },
];

// Webhook livemode sentinel. Stripe webhook payloads carry a `livemode`
// boolean; this env var declares the deployment's expected value so the
// handler can refuse a webhook whose livemode disagrees with the pod that
// received it (a leaked test webhook into production, or vice versa).
export const WEBHOOK_LIVEMODE_VAR = 'STRIPE_WEBHOOK_LIVEMODE';

function classifyStripe(value: string): Classification {
  if (STRIPE_LIVE_PREFIXES.some((p) => value.startsWith(p))) return 'live';
  if (STRIPE_TEST_PREFIXES.some((p) => value.startsWith(p))) return 'test';
  return 'unknown';
}

function classifyRevenueCat(value: string): Classification {
  if (REVENUECAT_TEST_PREFIXES.some((p) => value.startsWith(p))) return 'test';
  if (REVENUECAT_LIVE_PREFIXES.some((p) => value.startsWith(p))) return 'live';
  return 'unknown';
}

export function classifyPaymentSecret(
  provider: 'stripe' | 'revenuecat',
  value: string,
): Classification {
  return provider === 'stripe' ? classifyStripe(value) : classifyRevenueCat(value);
}

/**
 * Pure classification: returns every issue found in the given env for the
 * given APP_ENV, without throwing. Tests use this to assert the guard's
 * decisions; production callers use assertPaymentEnv() which throws.
 */
export function findPaymentEnvIssues(
  appEnv: AppEnv,
  env: Record<string, string | undefined>,
): PaymentEnvIssue[] {
  const issues: PaymentEnvIssue[] = [];

  // (2) Credential mode.
  for (const { name, provider } of PAYMENT_ENV_VARS) {
    const raw = env[name];
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const cls = classifyPaymentSecret(provider, raw);
    if (appEnv === 'staging') {
      if (cls === 'live') issues.push({ varName: name, reason: 'live_key_in_staging' });
      else if (cls === 'unknown') issues.push({ varName: name, reason: 'unknown_prefix_in_staging' });
    } else {
      if (cls === 'test') issues.push({ varName: name, reason: 'test_key_in_production' });
      else if (cls === 'unknown') issues.push({ varName: name, reason: 'unknown_prefix_in_production' });
    }
  }

  // (3) Product mode.
  for (const { name, expectedProduction, expectedStaging } of PRODUCT_MODE_VARS) {
    const raw = env[name];
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const value = raw.trim().toLowerCase();
    const expected = appEnv === 'production' ? expectedProduction : expectedStaging;
    // Recognise a fixed set of tokens; anything else is 'unknown'.
    const knownTokens = new Set([expectedProduction, expectedStaging]);
    if (!knownTokens.has(value)) {
      issues.push({
        varName: name,
        reason:
          appEnv === 'staging'
            ? 'unknown_product_mode_in_staging'
            : 'unknown_product_mode_in_production',
      });
    } else if (value !== expected) {
      issues.push({
        varName: name,
        reason:
          appEnv === 'staging'
            ? 'product_mode_mismatch_in_staging'
            : 'product_mode_mismatch_in_production',
      });
    }
  }

  // (4) Webhook livemode.
  {
    const raw = env[WEBHOOK_LIVEMODE_VAR];
    if (typeof raw === 'string' && raw.length > 0) {
      const value = raw.trim().toLowerCase();
      if (value !== 'true' && value !== 'false') {
        issues.push({ varName: WEBHOOK_LIVEMODE_VAR, reason: 'unknown_webhook_livemode' });
      } else {
        const expected = appEnv === 'production' ? 'true' : 'false';
        if (value !== expected) {
          issues.push({
            varName: WEBHOOK_LIVEMODE_VAR,
            reason:
              appEnv === 'staging'
                ? 'webhook_livemode_mismatch_in_staging'
                : 'webhook_livemode_mismatch_in_production',
          });
        }
      }
    }
  }

  return issues;
}

export class PaymentEnvGuardError extends Error {
  readonly issues: PaymentEnvIssue[];
  constructor(issues: PaymentEnvIssue[]) {
    // Body message NEVER echoes the offending value — just its var name and
    // reason. Secrets do not appear in logs / crash traces.
    const rendered = issues.map((i) => `${i.varName}=${i.reason}`).join('; ');
    super(`PaymentEnvGuardError: ${rendered}`);
    this.name = 'PaymentEnvGuardError';
    this.issues = issues;
  }
}

/**
 * Boot-time check. Called at module load of api/_lib/kv-namespace.ts and
 * exposed for any future payment integration to call directly. Throws
 * PaymentEnvGuardError on any mismatch. Called from a deployment with no
 * payment env set → no-op (returns cleanly).
 *
 * (1) Environment: throws AppEnvUnresolved via resolveAppEnvStrict() when
 *     APP_ENV is missing/unknown.
 */
export function assertPaymentEnv(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): void {
  const appEnv = resolveAppEnvStrict();
  const issues = findPaymentEnvIssues(appEnv, env);
  if (issues.length > 0) {
    throw new PaymentEnvGuardError(issues);
  }
}
