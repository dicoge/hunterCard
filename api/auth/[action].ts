/**
 * POST /api/auth/[action]  (DIC-663 / DIC-866)
 *
 * One Serverless Function serving the three session actions, so the deployment
 * stays within the Vercel Hobby 12-function cap (three separate files pushed the
 * count to 13 and the Preview deploy was rejected). URLs are unchanged
 * (/api/auth/login | link | unlink); the static sibling routes delete-account and
 * apple/register keep filesystem-routing priority over this dynamic segment.
 *
 *   - login  (§5.1) — public: verify provider token, login-or-create, issue session
 *   - link   (§5.2) — Bearer session: link a second verified provider
 *   - unlink (§5.3) — Bearer session: remove a provider, refusing the last method
 */
import { loginOrCreate, linkIdentity, unlinkIdentity } from '../_lib/identity-store';
import { issueSession } from '../_lib/session';
import {
  backendUnavailable,
  errorResponse,
  isProvider,
  json,
  sessionUserId,
  verifyProviderToken,
} from '../_lib/auth-endpoint';

export const config = { runtime: 'nodejs' };
export const maxDuration = 10;

interface AuthBody {
  provider?: unknown;
  idToken?: unknown;
  nonce?: unknown;
}

function actionFromUrl(url: string): string {
  return new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
}

async function handleLogin(body: AuthBody): Promise<Response> {
  if (!isProvider(body.provider)) return json({ error: 'invalid_provider' }, 400);
  if (typeof body.idToken !== 'string' || !body.idToken) {
    return json({ error: 'missing_id_token' }, 400);
  }
  const nonce = typeof body.nonce === 'string' ? body.nonce : undefined;
  const identity = await verifyProviderToken(body.provider, body.idToken, nonce);
  const { user, isNew } = await loginOrCreate(identity);
  return json({ user, isNew, session: issueSession(user.internalId) }, 200);
}

async function handleLink(req: Request, body: AuthBody): Promise<Response> {
  const userId = sessionUserId(req);
  if (!userId) return json({ error: 'INVALID_TOKEN', reason: 'invalid_session' }, 401);
  if (!isProvider(body.provider)) return json({ error: 'invalid_provider' }, 400);
  if (typeof body.idToken !== 'string' || !body.idToken) {
    return json({ error: 'missing_id_token' }, 400);
  }
  const nonce = typeof body.nonce === 'string' ? body.nonce : undefined;
  const identity = await verifyProviderToken(body.provider, body.idToken, nonce);
  const { user, alreadyLinked } = await linkIdentity(userId, identity);
  return json({ ok: true, user, alreadyLinked }, 200);
}

async function handleUnlink(req: Request, body: AuthBody): Promise<Response> {
  const userId = sessionUserId(req);
  if (!userId) return json({ error: 'INVALID_TOKEN', reason: 'invalid_session' }, 401);
  if (!isProvider(body.provider)) return json({ error: 'invalid_provider' }, 400);
  const user = await unlinkIdentity(userId, body.provider);
  return json({ ok: true, user }, 200);
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const unavailable = backendUnavailable();
  if (unavailable) return unavailable;

  let body: AuthBody;
  try {
    body = (await req.json()) as AuthBody;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  try {
    switch (actionFromUrl(req.url)) {
      case 'login':
        return await handleLogin(body);
      case 'link':
        return await handleLink(req, body);
      case 'unlink':
        return await handleUnlink(req, body);
      default:
        return json({ error: 'not_found' }, 404);
    }
  } catch (err) {
    return errorResponse(err);
  }
}
