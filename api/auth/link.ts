/**
 * POST /api/auth/link  (DIC-663, §5.2)
 *
 * Auth: Bearer <session>. Body: { provider, idToken, nonce? }.
 * Links a verified second provider to the session's internal user. Ownership
 * mutation happens under a per-user lock with the atomic identity unique
 * constraint; a cross-account collision returns 409 IDENTITY_ALREADY_LINKED.
 *
 * A failed write throws → non-2xx; the client must NOT report link success.
 */
import { linkIdentity } from '../lib/identity-store';
import {
  backendUnavailable,
  errorResponse,
  isProvider,
  json,
  sessionUserId,
  verifyProviderToken,
} from '../lib/auth-endpoint';

export const config = { runtime: 'nodejs' };
export const maxDuration = 10;

interface LinkBody {
  provider?: unknown;
  idToken?: unknown;
  nonce?: unknown;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const unavailable = backendUnavailable();
  if (unavailable) return unavailable;

  const userId = sessionUserId(req);
  if (!userId) return json({ error: 'INVALID_TOKEN', reason: 'invalid_session' }, 401);

  let body: LinkBody;
  try {
    body = (await req.json()) as LinkBody;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  if (!isProvider(body.provider)) return json({ error: 'invalid_provider' }, 400);
  if (typeof body.idToken !== 'string' || !body.idToken) {
    return json({ error: 'missing_id_token' }, 400);
  }
  const nonce = typeof body.nonce === 'string' ? body.nonce : undefined;

  try {
    const identity = await verifyProviderToken(body.provider, body.idToken, nonce);
    const { user, alreadyLinked } = await linkIdentity(userId, identity);
    return json({ ok: true, user, alreadyLinked }, 200);
  } catch (err) {
    return errorResponse(err);
  }
}
