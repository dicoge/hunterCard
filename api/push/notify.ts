import { readJsonFile } from '../lib/github-storage';

export const config = { runtime: 'nodejs' };

type PushWatchlist = Record<string, string[]>;
type Alert = {
  cardNumber: string;
  title: string;
  body: string;
};

type ExpoMessage = {
  to: string;
  title: string;
  body: string;
  data: { cardNumber: string };
};

const WATCHLIST_PATH = 'data/push-watchlist.json';
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function normalizeAlert(alert: any): Alert | null {
  if (!alert || typeof alert.cardNumber !== 'string' || typeof alert.title !== 'string' || typeof alert.body !== 'string') {
    return null;
  }
  return {
    cardNumber: alert.cardNumber.trim(),
    title: alert.title,
    body: alert.body,
  };
}

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const alerts = Array.isArray(body.alerts) ? body.alerts.map(normalizeAlert).filter(Boolean) as Alert[] : [];
    if (alerts.length === 0) return json({ ok: true, sent: 0, errors: 0 });

    const watchlist = await readJsonFile<PushWatchlist>(WATCHLIST_PATH, {});
    const messages: ExpoMessage[] = [];

    for (const alert of alerts) {
      const subscribers = Object.entries(watchlist)
        .filter(([, cards]) => Array.isArray(cards) && cards.includes(alert.cardNumber))
        .map(([token]) => token);

      for (const token of subscribers) {
        messages.push({
          to: token,
          title: alert.title,
          body: alert.body,
          data: { cardNumber: alert.cardNumber },
        });
      }
    }

    let sent = 0;
    let errors = 0;

    for (const batch of chunk(messages, 100)) {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
      });

      if (!res.ok) {
        errors += batch.length;
        console.warn(`[push/notify] Expo Push API ${res.status}: ${await res.text()}`);
        continue;
      }

      const data = await res.json().catch(() => ({}));
      const tickets = Array.isArray(data?.data) ? data.data : [];
      sent += tickets.filter((ticket: any) => ticket?.status === 'ok').length;
      errors += tickets.filter((ticket: any) => ticket?.status === 'error').length;
      if (tickets.length === 0) sent += batch.length;
    }

    return json({ ok: true, sent, errors });
  } catch (err: any) {
    console.error('[push/notify]', err);
    return json({ error: err.message || 'Notification failed', sent: 0, errors: 1 }, 500);
  }
}
