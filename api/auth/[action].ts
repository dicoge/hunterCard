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
 *   - me            — Bearer session (GET / HEAD / POST): validate the session,
 *                     return the current user. Without a valid session it returns
 *                     structured JSON 401 immediately. The client MUST call this
 *                     before entering authenticated UI so a stale/tampered local
 *                     flag alone can never grant access (CR DIC-866: persisted
 *                     auth fail-open).
 */
import { loginOrCreate, linkIdentity, unlinkIdentity, getUser } from '../_lib/identity-store';
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
  // Validate the request shape BEFORE touching any backend dependency: invalid
  // input must return a fast 4xx without waiting on KV / session / provider.
  if (!isProvider(body.provider)) return json({ error: 'invalid_provider' }, 400);
  if (typeof body.idToken !== 'string' || !body.idToken) {
    return json({ error: 'missing_id_token' }, 400);
  }
  const unavailable = backendUnavailable();
  if (unavailable) return unavailable;
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
  const unavailable = backendUnavailable();
  if (unavailable) return unavailable;
  const nonce = typeof body.nonce === 'string' ? body.nonce : undefined;
  const identity = await verifyProviderToken(body.provider, body.idToken, nonce);
  const { user, alreadyLinked } = await linkIdentity(userId, identity);
  return json({ ok: true, user, alreadyLinked }, 200);
}

async function handleUnlink(req: Request, body: AuthBody): Promise<Response> {
  const userId = sessionUserId(req);
  if (!userId) return json({ error: 'INVALID_TOKEN', reason: 'invalid_session' }, 401);
  if (!isProvider(body.provider)) return json({ error: 'invalid_provider' }, 400);
  const unavailable = backendUnavailable();
  if (unavailable) return unavailable;
  const user = await unlinkIdentity(userId, body.provider);
  return json({ ok: true, user }, 200);
}

async function handleMe(req: Request): Promise<Response> {
  // The session check is a pure in-process HMAC verification (no I/O): an
  // unauthenticated probe returns 401 JSON immediately, before any KV/session
  // dependency is touched, so it can never hang on backend init (DIC-891).
  const userId = sessionUserId(req);
  if (!userId) return json({ error: 'INVALID_TOKEN', reason: 'invalid_session' }, 401);
  const unavailable = backendUnavailable();
  if (unavailable) return unavailable;
  const user = await getUser(userId);
  if (!user) return json({ error: 'USER_NOT_FOUND', reason: 'no_such_user' }, 401);
  return json({ user }, 200);
}

export default async function handler(req: Request): Promise<Response> {
  const action = actionFromUrl(req.url);

  // `me` is a read. Accept GET/HEAD (the production auth contract) alongside the
  // POST the current client already sends, and resolve it without parsing a body
  // so an unauthenticated GET returns structured JSON 401 fast — never 405, never
  // a body-parse dependency (DIC-891).
  if (action === 'me') {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405);
    }
    try {
      return await handleMe(req);
    } catch (err) {
      return errorResponse(err);
    }
  }

  // Mutating actions require POST.
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let body: AuthBody;
  try {
    body = (await req.json()) as AuthBody;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  try {
    switch (action) {
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
