import { timingSafeEqual } from 'node:crypto';
import { resolveAppEnvStrict, type AppEnv } from '../../src/config/appEnv';

/**
 * Fail-closed shared-secret check for endpoints that may only be called by the
 * scheduled job, never by end users (DIC-390 #1). If the secret env var is
 * unset, every request is rejected rather than left open.
 *
 * DIC-1189 rework-blocker #3: staging uses PUSH_NOTIFY_SECRET_STAGING;
 * production uses PUSH_NOTIFY_SECRET. Separate secrets mean a leaked staging
 * webhook secret cannot be used against production (and vice versa).
 */
function internalSecret(): string | null {
  let appEnv: AppEnv;
  try {
    appEnv = resolveAppEnvStrict();
  } catch {
    return null;
  }
  if (appEnv === 'staging') {
    return process.env.PUSH_NOTIFY_SECRET_STAGING || null;
  }
  return process.env.PUSH_NOTIFY_SECRET || null;
}

export function isInternalRequest(req: Request): boolean {
  const secret = internalSecret();
  if (!secret) return false;
  const provided = req.headers.get('x-internal-secret') ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
