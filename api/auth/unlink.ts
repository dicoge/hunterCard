/**
 * POST /api/auth/unlink  (DIC-663, §5.3)
 *
 * Auth: Bearer <session>. Body: { provider }.
 * Removes a provider from the session's internal user, refusing to remove the
 * last remaining login method (409 CANNOT_UNLINK_LAST_METHOD).
 *
 * A failed write throws → non-2xx; the client must NOT report unlink success.
 */
import { unlinkIdentity } from '../lib/identity-store';
import {
  backendUnavailable,
  errorResponse,
  isProvider,
  json,
  sessionUserId,
} from '../lib/auth-endpoint';

export const config = { runtime: 'nodejs' };
export const maxDuration = 10;

interface UnlinkBody {
  provider?: unknown;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const unavailable = backendUnavailable();
  if (unavailable) return unavailable;

  const userId = sessionUserId(req);
  if (!userId) return json({ error: 'INVALID_TOKEN', reason: 'invalid_session' }, 401);

  let body: UnlinkBody;
  try {
    body = (await req.json()) as UnlinkBody;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  if (!isProvider(body.provider)) return json({ error: 'invalid_provider' }, 400);

  try {
    const user = await unlinkIdentity(userId, body.provider);
    return json({ ok: true, user }, 200);
  } catch (err) {
    return errorResponse(err);
  }
}
