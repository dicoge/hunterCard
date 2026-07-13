import { addWatchlistCard, removeWatchlistCard } from '../lib/kv-storage';

export const config = { runtime: 'nodejs' };

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

function isExpoToken(token: unknown): token is string {
  return typeof token === 'string' && /^ExponentPushToken\[[^\]]+\]$|^ExpoPushToken\[[^\]]+\]$/.test(token);
}

function isCardNumber(cardNumber: unknown): cardNumber is string {
  return typeof cardNumber === 'string' && cardNumber.trim().length > 0 && cardNumber.length <= 80;
}

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const token = body.token;
    const cardNumber = typeof body.cardNumber === 'string' ? body.cardNumber.trim() : body.cardNumber;
    const action = body.action;

    if (!isExpoToken(token)) return json({ error: 'Invalid Expo push token' }, 400);
    if (!isCardNumber(cardNumber)) return json({ error: 'Invalid cardNumber' }, 400);
    if (action !== 'add' && action !== 'remove') return json({ error: 'Invalid action' }, 400);

    const nextCards = action === 'add'
      ? await addWatchlistCard(token, cardNumber)
      : await removeWatchlistCard(token, cardNumber);

    return json({ ok: true, cards: nextCards });
  } catch (err: any) {
    console.error('[push/watchlist]', err);
    return json({ error: err.message || 'Watchlist update failed' }, 500);
  }
}
