import { upsertToken } from '../_lib/kv-storage';

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

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const token = body.token;
    const platform = body.platform;

    if (!isExpoToken(token)) return json({ error: 'Invalid Expo push token' }, 400);
    if (platform !== 'ios' && platform !== 'android') return json({ error: 'Invalid platform' }, 400);

    await upsertToken(token, platform);
    return json({ ok: true });
  } catch (err: any) {
    console.error('[push/register]', err);
    return json({ error: err.message || 'Registration failed' }, 500);
  }
}
