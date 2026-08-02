/**
 * POST /api/auth/login  (DIC-663)
 *
 * Body: { provider: 'google'|'apple', idToken: string, nonce?: string }
 * Verifies the provider ID token server-side, resolves it to a server-authoritative
 * internal user (login-or-create, §5.1), and returns a signed session.
 *
 * Fail-closed: if the backend (KV / session secret / provider verify) is not
 * configured, returns 501 and the client must NOT treat the user as signed in.
 */
import { loginOrCreate } from '../lib/identity-store';
import { issueSession } from '../lib/session';
import {
  backendUnavailable,
  errorResponse,
  isProvider,
  json,
  verifyProviderToken,
} from '../lib/auth-endpoint';

export const config = { runtime: 'nodejs' };
export const maxDuration = 10;

interface LoginBody {
  provider?: unknown;
  idToken?: unknown;
  nonce?: unknown;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const unavailable = backendUnavailable();
  if (unavailable) return unavailable;

  let body: LoginBody;
  try {
    body = (await req.json()) as LoginBody;
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
    const { user, isNew } = await loginOrCreate(identity);
    return json({ user, isNew, session: issueSession(user.internalId) }, 200);
  } catch (err) {
    return errorResponse(err);
  }
}
