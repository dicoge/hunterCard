// Subscription env / config schema (DIC-1149 Phase 1a).
//
// Same fail-closed philosophy as src/config/releaseFlags.ts: an env that is
// absent / whitespace / malformed / unknown must NEVER open the gate. Any
// unresolved configuration collapses the subscription layer to the same
// state as Store MVP Production: no premium, no paywall attempts, no
// provider calls, the free_user path preserved.
//
// This file names the env vars but does NOT hard-code values, keys,
// secrets, product ids, or prices. Concrete values live in Vercel / EAS /
// the eventual `.env.example` documentation entry — never in code.

/**
 * Env var names the subscription layer reads. Named as constants so the
 * spelling is single-sourced (grep against `SUBSCRIPTION_ENV.*` finds every
 * consumer). Values are intentionally NOT documented here — see the docs/
 * architecture note added alongside this module for the deployment-time
 * documentation.
 */
export const SUBSCRIPTION_ENV = Object.freeze({
  /**
   * Which provider the app should route purchases through. Absent /
   * unknown → subscription layer disabled, everyone stays `free_user`.
   * Never set this to a comma-separated list; the layer supports one
   * provider per build in Phase 1a.
   */
  PROVIDER_TAG: 'EXPO_PUBLIC_SUBSCRIPTION_PROVIDER',
  /**
   * Environment the provider adapter should target. Absent / unknown →
   * subscription layer disabled. Valid values are `sandbox` and
   * `production`. `sandbox` is fail-closed against real charges (adapters
   * must refuse to bind a production key when this is set).
   */
  PROVIDER_ENV: 'EXPO_PUBLIC_SUBSCRIPTION_ENV',
  /**
   * Public identifier used by the adapter to introduce itself to the
   * provider SDK (e.g., a public API key or app id). Provider secrets do
   * NOT live under an EXPO_PUBLIC_* prefix — those are backend-only.
   */
  PROVIDER_PUBLIC_KEY: 'EXPO_PUBLIC_SUBSCRIPTION_PUBLIC_KEY',
} as const);

/**
 * Legal env values. Anything outside this closed set collapses to
 * "disabled" — the fail-closed rule.
 */
export type SubscriptionProviderEnv = 'sandbox' | 'production';

export interface SubscriptionConfigResolved {
  readonly enabled: true;
  readonly providerTag: string;
  readonly providerEnv: SubscriptionProviderEnv;
  readonly providerPublicKey: string;
}

export interface SubscriptionConfigDisabled {
  readonly enabled: false;
  /** Diagnostic — never a load-bearing signal for entitlement. */
  readonly reason:
    | 'unset'
    | 'malformed_provider_tag'
    | 'malformed_provider_env'
    | 'missing_public_key';
}

export type SubscriptionConfig =
  | SubscriptionConfigResolved
  | SubscriptionConfigDisabled;

/**
 * Read a value from an env bag with strict trimming. Undefined / non-string
 * / whitespace-only → `null`, matching the fail-closed policy elsewhere in
 * the codebase.
 */
function readTrimmed(bag: Record<string, string | undefined>, key: string): string | null {
  const raw = bag[key];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

const PROVIDER_TAG_RE = /^[a-z][a-z0-9_-]{1,63}$/;
const PROVIDER_PUBLIC_KEY_MIN = 8;
const PROVIDER_PUBLIC_KEY_MAX = 512;

/**
 * Resolve the subscription config from an env bag. Pure function — no
 * process.env read here — so tests can pass an arbitrary bag and callers
 * that must read `process.env` do so at the composition edge (see
 * {@link resolveSubscriptionConfigFromProcess}).
 *
 * Fail-closed order (matches order of checks): provider tag first, env
 * next, public key last. The FIRST failing rule wins so the diagnostic
 * `reason` is deterministic.
 */
export function resolveSubscriptionConfig(
  bag: Record<string, string | undefined>,
): SubscriptionConfig {
  const rawTag = readTrimmed(bag, SUBSCRIPTION_ENV.PROVIDER_TAG);
  if (rawTag === null) {
    return { enabled: false, reason: 'unset' };
  }
  const providerTag = rawTag.toLowerCase();
  if (!PROVIDER_TAG_RE.test(providerTag)) {
    return { enabled: false, reason: 'malformed_provider_tag' };
  }

  const rawEnv = readTrimmed(bag, SUBSCRIPTION_ENV.PROVIDER_ENV);
  if (rawEnv === null) {
    return { enabled: false, reason: 'unset' };
  }
  const providerEnv = rawEnv.toLowerCase();
  if (providerEnv !== 'sandbox' && providerEnv !== 'production') {
    return { enabled: false, reason: 'malformed_provider_env' };
  }

  const publicKey = readTrimmed(bag, SUBSCRIPTION_ENV.PROVIDER_PUBLIC_KEY);
  if (publicKey === null) {
    return { enabled: false, reason: 'missing_public_key' };
  }
  if (
    publicKey.length < PROVIDER_PUBLIC_KEY_MIN ||
    publicKey.length > PROVIDER_PUBLIC_KEY_MAX
  ) {
    return { enabled: false, reason: 'missing_public_key' };
  }

  return {
    enabled: true,
    providerTag,
    providerEnv: providerEnv as SubscriptionProviderEnv,
    providerPublicKey: publicKey,
  };
}

/**
 * Composition-edge helper. Reads from `process.env` and delegates to the
 * pure resolver. Kept out of the pure module so unit tests can exercise
 * every branch without polluting the environment.
 */
export function resolveSubscriptionConfigFromProcess(): SubscriptionConfig {
  return resolveSubscriptionConfig(process.env as Record<string, string | undefined>);
}
