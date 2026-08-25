// DIC-1189: payment environment guard (fail-closed scaffolding).
//
// There is NO payment integration in the repo yet — this module exists so that
// when Stripe / RevenueCat / StoreKit code is eventually wired in it MUST call
// assertPaymentEnv() at boot before it can talk to the payment provider. The
// guard enforces three invariants that hold even in the absence of an
// integration:
//
//   - staging deployment MUST NOT hold live secrets: any Stripe `sk_live_*`,
//     `pk_live_*`, `whsec_live_*`, or RevenueCat production public key
//     (`appl_*` used as RC secret / v3 secret prefix) will throw so the
//     staging pod refuses to boot with them.
//   - production deployment MUST NOT hold test secrets: any Stripe `sk_test_*`
//     / `pk_test_*` / `whsec_test_*` or RevenueCat sandbox secret prefix will
//     throw so a leaked test key from staging cannot silently service real
//     traffic.
//   - unknown / missing APP_ENV with a payment secret set is treated as
//     production (via resolveAppEnv()'s fail-closed default) — so an
//     unattributed environment cannot accept a test key.
//
// The guard does NOT require secrets to be present. Deployments without any
// payment env pass through (there is no payment code yet). What it enforces is
// that WHEN a payment env is set, it matches the deployment lane.

import { resolveAppEnv, type AppEnv } from '../../src/config/appEnv';

export type PaymentEnvIssue = {
  varName: string;
  reason:
    | 'live_key_in_staging'
    | 'test_key_in_production'
    | 'unknown_prefix_in_staging'
    | 'unknown_prefix_in_production';
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
const REVENUECAT_TEST_PREFIXES = [
  'sk_test_',
  'sandbox_',
];

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
  for (const { name, provider } of PAYMENT_ENV_VARS) {
    const raw = env[name];
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const cls = classifyPaymentSecret(provider, raw);
    if (appEnv === 'staging') {
      if (cls === 'live') {
        issues.push({ varName: name, reason: 'live_key_in_staging' });
      } else if (cls === 'unknown') {
        issues.push({ varName: name, reason: 'unknown_prefix_in_staging' });
      }
    } else {
      // appEnv === 'production' (unknown env resolved to production by
      // resolveAppEnv()'s fail-closed rule).
      if (cls === 'test') {
        issues.push({ varName: name, reason: 'test_key_in_production' });
      } else if (cls === 'unknown') {
        issues.push({ varName: name, reason: 'unknown_prefix_in_production' });
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
    const rendered = issues
      .map((i) => `${i.varName}=${i.reason}`)
      .join('; ');
    super(`PaymentEnvGuardError: ${rendered}`);
    this.name = 'PaymentEnvGuardError';
    this.issues = issues;
  }
}

/**
 * Boot-time check. Any future payment integration MUST call this before it
 * initialises its provider client. Throws PaymentEnvGuardError on any
 * mismatch. Called from a deployment with no payment env set → no-op.
 */
export function assertPaymentEnv(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): void {
  const appEnv = resolveAppEnv();
  const issues = findPaymentEnvIssues(appEnv, env);
  if (issues.length > 0) {
    throw new PaymentEnvGuardError(issues);
  }
}
