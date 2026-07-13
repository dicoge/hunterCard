/**
 * POST /api/push/register
 * Body: { token: string }
 * Appends the Expo push token to the token store (deduped).
 */
import { addToken } from '../../lib/pushStore';

export const config = { runtime: 'nodejs' };
export const maxDuration = 10;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== 'POST') {
    return json({ ok: false, error: 'Method not allowed' }, 405);
  }

  try {
    const { token } = (await req.json()) as { token?: unknown };
    if (typeof token !== 'string' || !token.trim()) {
      return json({ ok: false, error: 'Missing token' }, 400);
    }
    addToken(token.trim());
    return json({ ok: true });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'Bad request' }, 400);
  }
}
