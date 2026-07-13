import { readJsonFile, writeJsonFile } from '../lib/github-storage';

export const config = { runtime: 'nodejs' };

type Platform = 'ios' | 'android';
type PushToken = {
  token: string;
  platform: Platform;
  createdAt: string;
  updatedAt: string;
};

const TOKENS_PATH = 'data/push-tokens.json';
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

    const tokens = await readJsonFile<PushToken[]>(TOKENS_PATH, []);
    const now = new Date().toISOString();
    const existing = tokens.find((entry) => entry.token === token);

    if (existing) {
      existing.platform = platform;
      existing.updatedAt = now;
    } else {
      tokens.push({ token, platform, createdAt: now, updatedAt: now });
    }

    await writeJsonFile(TOKENS_PATH, tokens, `chore(push): register ${platform} device`);
    return json({ ok: true });
  } catch (err: any) {
    console.error('[push/register]', err);
    return json({ error: err.message || 'Registration failed' }, 500);
  }
}
