// Canonical production origin for the HoloHunter backend (DIC-1245).
//
// Native executable code (iOS / Android bundle, cron scripts running against
// production KV) MUST resolve the API to this origin — never the old
// holocard-hunter.vercel.app alias. Web still resolves API calls against its
// own window.location.origin, but the fallback used when there is no origin
// (SSR, native, cron) is this canonical host.
//
// Pure module — no react-native / expo / node imports — so it can be shared by
// the app bundle, the Vercel edge handler, and Node scripts, and stays
// unit-testable.
//
// If the operator ever needs to move production off holohunter.dicoge.com, this
// is the single place to change; the regression gate in
// scripts/test-native-bundle-origin.mjs then fails any executable path that
// still hardcodes the old vercel.app alias.
export const PRODUCTION_ORIGIN = 'https://holohunter.dicoge.com';

// Build stage (test-first release flow). Native builds talk to exactly one
// backend, chosen at build time:
//   EXPO_PUBLIC_APP_STAGE unset / '' / 'production' → PRODUCTION_ORIGIN, exactly
//       as before; every existing production profile leaves it unset.
//   EXPO_PUBLIC_APP_STAGE = 'staging' → EXPO_PUBLIC_STAGING_API_ORIGIN, which
//       must be a bare https origin whose host is NOT a production host.
//   any other value, or 'staging' without a usable origin → null. Callers fail
//       closed instead of falling back to production, so a staging build can
//       never silently read or write production KV through these clients.
// This only selects WHICH host is called. It proves nothing about whether that
// host's own storage is separate from production; that is platform state.
export type AppStage = 'production' | 'staging';

// Hosts that serve the production backend. Bare hostnames, never URLs: see
// scripts/test-native-bundle-origin.mjs, which forbids the old alias in URL form.
export const PRODUCTION_HOSTS: readonly string[] = ['holohunter.dicoge.com', 'holocard-hunter.vercel.app'];

export function isProductionHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return PRODUCTION_HOSTS.includes(h) || /^holocard-hunter-[a-z0-9-]+\.vercel\.app$/.test(h);
}

export function resolveAppStage(raw: string | null | undefined): AppStage | null {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (v === '' || v === 'production') return 'production';
  if (v === 'staging') return 'staging';
  return null;
}

export function resolveStagingOrigin(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw !== raw.trim() || !raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
  if (url.pathname !== '/' || url.search || url.hash) return null;
  if (raw.replace(/\/$/, '') !== url.origin) return null;
  if (isProductionHost(url.hostname)) return null;
  return url.origin;
}

export function resolveNativeApiOrigin(params: {
  stage: string | null | undefined;
  stagingOrigin: string | null | undefined;
}): string | null {
  const stage = resolveAppStage(params.stage);
  if (stage === 'production') return PRODUCTION_ORIGIN;
  if (stage === 'staging') return resolveStagingOrigin(params.stagingOrigin);
  return null;
}

export class StageApiOriginError extends Error {
  constructor() {
    super('This build is not configured for a usable backend: EXPO_PUBLIC_APP_STAGE=staging requires EXPO_PUBLIC_STAGING_API_ORIGIN to be a non-production https origin. Refusing to fall back to production.');
    this.name = 'StageApiOriginError';
  }
}

// The origin native clients use when there is no web page origin. The
// process.env member expressions are written out literally so Expo inlines
// them into the bundle at build time.
export function nativeApiOrigin(): string {
  const origin = resolveNativeApiOrigin({
    stage: process.env.EXPO_PUBLIC_APP_STAGE,
    stagingOrigin: process.env.EXPO_PUBLIC_STAGING_API_ORIGIN,
  });
  if (!origin) throw new StageApiOriginError();
  return origin;
}
