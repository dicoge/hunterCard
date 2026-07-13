import { timingSafeEqual } from 'node:crypto';
import { getWatchlist, getLastAlertTimes, setLastAlertTimes } from '../lib/kv-storage';

export const config = { runtime: 'nodejs' };

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

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
// Minimum gap between pushes for the same card, so a card trending above the
// alert threshold for several days isn't pushed on every cron run (DIC-390 #4).
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Internal-Secret',
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

// Fail-closed shared-secret check: this endpoint may only be called by the cron
// script / Vercel cron, never by end users (DIC-390 #1). If the secret env var
// is unset, every request is rejected rather than left open.
function isAuthorized(req: Request): boolean {
  const secret = process.env.PUSH_NOTIFY_SECRET;
  if (!secret) return false;
  const provided = req.headers.get('x-internal-secret') ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
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
  if (!isAuthorized(req)) return json({ error: 'Unauthorized' }, 401);

  try {
    const body = await req.json().catch(() => ({}));
    const alerts = Array.isArray(body.alerts) ? body.alerts.map(normalizeAlert).filter(Boolean) as Alert[] : [];
    if (alerts.length === 0) return json({ ok: true, sent: 0, errors: 0, skipped: 0 });

    const watchlist = await getWatchlist();
    const now = Date.now();
    const lastAlertTimes = await getLastAlertTimes(alerts.map((alert) => alert.cardNumber));

    const messages: ExpoMessage[] = [];
    const pushedCards = new Set<string>();
    let skipped = 0;

    for (const alert of alerts) {
      const lastSent = Number(lastAlertTimes[alert.cardNumber] ?? 0);
      if (lastSent && now - lastSent < COOLDOWN_MS) {
        skipped += 1;
        continue;
      }

      const subscribers = Object.entries(watchlist)
        .filter(([, cards]) => Array.isArray(cards) && cards.includes(alert.cardNumber))
        .map(([token]) => token);

      if (subscribers.length === 0) continue;
      pushedCards.add(alert.cardNumber);

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

    if (pushedCards.size > 0) await setLastAlertTimes([...pushedCards], now);

    return json({ ok: true, sent, errors, skipped });
  } catch (err: any) {
    console.error('[push/notify]', err);
    return json({ error: err.message || 'Notification failed', sent: 0, errors: 1 }, 500);
  }
}
