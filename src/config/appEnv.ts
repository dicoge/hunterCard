// DIC-1189: single source of truth for staging vs production runtime resolution.
//
// Fail-closed rule (mirrors STORE_MVP in releaseFlags.ts): any value we do not
// recognise as an explicit staging opt-in is treated as production. A missing,
// blank, mistyped, or unknown APP_ENV must NEVER trip the staging-only
// affordances (TEST banner, noindex, `staging:` KV prefix), because those
// affordances are only safe on the isolated staging deployment.
//
// Two env names are read for symmetry with the rest of the codebase:
//   - APP_ENV                 — server / build-time (Node, Vercel functions)
//   - EXPO_PUBLIC_APP_ENV     — client bundle (Expo baked at export time)
// Both are set together by the Vercel staging project (dic1189 workflow), so on
// the staging deployment they agree; on production neither is set and this
// module reports production.

export type AppEnv = 'production' | 'staging';

function readRaw(): string {
  const client =
    typeof process !== 'undefined' && process.env
      ? process.env.EXPO_PUBLIC_APP_ENV
      : undefined;
  const server =
    typeof process !== 'undefined' && process.env
      ? process.env.APP_ENV
      : undefined;
  // Server value wins when both are set (server functions never render a client
  // bundle's stale build-time constant). Client-only contexts fall back to the
  // baked EXPO_PUBLIC_APP_ENV.
  const raw = server || client || '';
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

// LENIENT resolver — used by UI / feature-flag code (StagingBanner,
// STAGING_ONLY) where the fail-closed direction is "do not show staging
// affordances". Missing / unknown values resolve to production so the client
// bundle can never leak the staging banner or an experimental surface into
// an unattributed environment.
export function resolveAppEnv(): AppEnv {
  const raw = readRaw();
  if (raw === 'staging') return 'staging';
  // production / unset / whitespace / typo / unknown → fail-closed to production.
  return 'production';
}

// STRICT resolver — used by the KV namespace guard, the payment env guard,
// and every other data-path where the fail-closed direction is "throw rather
// than pick a lane" (rework-blocker #2/#6). Only recognises the two explicit
// sentinel values; anything else throws AppEnvUnresolved so bare production
// keys / secrets are never returned by silent default. On production Vercel
// deployments APP_ENV MUST be set to 'production' for the KV / payment paths
// to succeed — the dic1189 setup workflow's `set-production-app-env` step is
// what makes that true on `holocard-hunter` (production project).
export class AppEnvUnresolved extends Error {
  readonly raw: string;
  constructor(raw: string) {
    super(
      raw
        ? `APP_ENV / EXPO_PUBLIC_APP_ENV is set to ${JSON.stringify(raw)} which is neither 'production' nor 'staging' — refusing to guess a lane.`
        : "APP_ENV / EXPO_PUBLIC_APP_ENV is unset — refusing to guess a lane. Set APP_ENV='production' or APP_ENV='staging' on this deployment.",
    );
    this.name = 'AppEnvUnresolved';
    this.raw = raw;
  }
}

export function resolveAppEnvStrict(): AppEnv {
  const raw = readRaw();
  if (raw === 'staging') return 'staging';
  if (raw === 'production') return 'production';
  throw new AppEnvUnresolved(raw);
}

export const APP_ENV: AppEnv = resolveAppEnv();
export const IS_STAGING: boolean = APP_ENV === 'staging';
export const IS_PRODUCTION: boolean = APP_ENV === 'production';

// Public site URL — used by server-side redirect building and by any code that
// needs to construct absolute URLs for the current environment. Defaults are
// the canonical hosts: production keeps its existing host so no callsite that
// used to hardcode holohunter.dicoge.com breaks in prod.
const DEFAULT_SITE_URL: Record<AppEnv, string> = {
  production: 'https://holohunter.dicoge.com',
  staging: 'https://test.holohunter.dicoge.com',
};

export function resolveSiteUrl(): string {
  const explicit =
    (typeof process !== 'undefined' &&
      process.env &&
      (process.env.EXPO_PUBLIC_SITE_URL || process.env.SITE_URL)) ||
    '';
  if (typeof explicit === 'string' && explicit.trim()) {
    return explicit.trim().replace(/\/+$/, '');
  }
  // Resolve APP_ENV at call time (not via the module-const APP_ENV) so
  // consumers that override process.env after module load — e.g. Vercel
  // functions in a multi-tenant serverless runtime, tests — see the
  // freshly-resolved value instead of a build-time snapshot.
  return DEFAULT_SITE_URL[resolveAppEnv()];
}

export const SITE_URL: string = resolveSiteUrl();

// Staging git SHA — set by the Vercel deployment (VERCEL_GIT_COMMIT_SHA) and
// baked into the client bundle as EXPO_PUBLIC_STAGING_SHA by the buildCommand.
// Only meaningful in staging (production never renders it). Returns an empty
// string when unavailable so callers can decide how to degrade.
export function resolveStagingSha(): string {
  const sha =
    (typeof process !== 'undefined' &&
      process.env &&
      (process.env.EXPO_PUBLIC_STAGING_SHA ||
        process.env.VERCEL_GIT_COMMIT_SHA)) ||
    '';
  return typeof sha === 'string' ? sha.trim().slice(0, 12) : '';
}

export const STAGING_SHA: string = resolveStagingSha();
