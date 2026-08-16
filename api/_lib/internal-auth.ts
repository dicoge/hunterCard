import { timingSafeEqual } from 'node:crypto';

/**
 * Fail-closed shared-secret check for endpoints that may only be called by the
 * scheduled job, never by end users (DIC-390 #1). If the secret env var is
 * unset, every request is rejected rather than left open.
 */
export function isInternalRequest(req: Request): boolean {
  const secret = process.env.PUSH_NOTIFY_SECRET;
  if (!secret) return false;
  const provided = req.headers.get('x-internal-secret') ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
