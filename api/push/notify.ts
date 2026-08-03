import { timingSafeEqual } from 'node:crypto';
import { getWatchlist, getLastAlertTimes, setLastAlertTimes } from '../_lib/kv-storage';

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
// Minimum gap between pushes of the same card to the same recipient, so a card
// trending above the alert threshold for several days isn't pushed on every cron
// run (DIC-390 #4). Keyed per recipient (not per card) so one watcher's success
// can't suppress the alert for another watcher who hasn't received it yet
// (DIC-390 CR blocker 2).
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Composite hash-field key for the per-recipient/per-card cooldown record. An
// Expo push token never contains '|', so the split point is unambiguous.
function cooldownKey(token: string, cardNumber: string): string {
  return `${token}|${cardNumber}`;
}
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

    // Expand each alert into its concrete recipients first, then apply the
    // cooldown per recipient. Skipping at the card level (before choosing
    // recipients) would let one watcher's recent delivery suppress the alert for
    // a different watcher who never received it (DIC-390 CR blocker 2).
    const recipients = alerts.flatMap((alert) =>
      Object.entries(watchlist)
        .filter(([, cards]) => Array.isArray(cards) && cards.includes(alert.cardNumber))
        .map(([token]) => ({ token, alert })),
    );

    const lastAlertTimes = await getLastAlertTimes(
      [...new Set(recipients.map(({ token, alert }) => cooldownKey(token, alert.cardNumber)))],
    );

    const messages: ExpoMessage[] = [];
    let skipped = 0;

    for (const { token, alert } of recipients) {
      const lastSent = Number(lastAlertTimes[cooldownKey(token, alert.cardNumber)] ?? 0);
      if (lastSent && now - lastSent < COOLDOWN_MS) {
        skipped += 1;
        continue;
      }
      messages.push({
        to: token,
        title: alert.title,
        body: alert.body,
        data: { cardNumber: alert.cardNumber },
      });
    }

    let sent = 0;
    let errors = 0;
    // Only recipient+card pairs with an Expo-confirmed 'ok' ticket enter the 24h
    // cooldown. A failed delivery must NOT record the cooldown, otherwise the
    // next cron run would skip that recipient and they never get the alert
    // (DIC-390 CR blocker 2).
    const succeeded = new Set<string>();

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
      if (tickets.length === 0) {
        // No per-message ticket to confirm: count as delivered but skip the
        // cooldown so the next run can retry.
        sent += batch.length;
        continue;
      }
      // Tickets come back in the same order as the batch we sent.
      batch.forEach((message, i) => {
        if (tickets[i]?.status === 'ok') succeeded.add(cooldownKey(message.to, message.data.cardNumber));
      });
    }

    if (succeeded.size > 0) await setLastAlertTimes([...succeeded], now);

    return json({ ok: true, sent, errors, skipped });
  } catch (err: any) {
    console.error('[push/notify]', err);
    return json({ error: err.message || 'Notification failed', sent: 0, errors: 1 }, 500);
  }
}
