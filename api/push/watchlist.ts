/**
 * /api/push/watchlist
 *
 * GET  → { ok: true, tokens: { [token]: { cards, updatedAt } } } (未來推播用)
 * POST { token, cardNumber, action: 'add' | 'remove' }
 *      → { ok: true, entry: { cards, updatedAt } }
 */
import { getWatchlist, updateWatchlist, WatchlistAction } from '../../lib/pushStore';

export const config = { runtime: 'nodejs' };
export const maxDuration = 10;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

  if (req.method === 'GET') {
    return json({ ok: true, ...getWatchlist() });
  }

  if (req.method === 'POST') {
    try {
      const { token, cardNumber, action } = (await req.json()) as {
        token?: unknown;
        cardNumber?: unknown;
        action?: unknown;
      };
      if (typeof token !== 'string' || !token.trim()) {
        return json({ ok: false, error: 'Missing token' }, 400);
      }
      if (typeof cardNumber !== 'string' || !cardNumber.trim()) {
        return json({ ok: false, error: 'Missing cardNumber' }, 400);
      }
      if (action !== 'add' && action !== 'remove') {
        return json({ ok: false, error: "action must be 'add' or 'remove'" }, 400);
      }
      const entry = updateWatchlist(token.trim(), cardNumber.trim(), action as WatchlistAction);
      return json({ ok: true, entry });
    } catch (e: any) {
      return json({ ok: false, error: e?.message || 'Bad request' }, 400);
    }
  }

  return json({ ok: false, error: 'Method not allowed' }, 405);
}
