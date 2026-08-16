// Exact-version desired-price alert configs for a device (DIC-1023).
//
// Identity is the Expo push token, exactly like /api/push/register and
// /api/push/watchlist — no new credential is introduced. The token is only ever
// echoed back to the caller that already supplied it, so nothing here can be
// used to enumerate other devices' alerts.

import {
  getPriceAlertsForToken, countPriceAlertsForToken, upsertPriceAlert, removePriceAlert,
} from '../_lib/kv-storage';
import { parsePriceAlertRequest, MAX_ALERTS_PER_TOKEN } from '../_lib/price-alert-request';

export const config = { runtime: 'nodejs' };

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const parsed = parsePriceAlertRequest(body);
    if (!parsed.ok) return json({ error: parsed.error }, parsed.status);

    if (parsed.action === 'upsert') {
      const existing = await countPriceAlertsForToken(parsed.token);
      const isNew = !(await getPriceAlertsForToken(parsed.token))
        .some((a) => a.cardNumber === parsed.alert.cardNumber && a.printing === parsed.alert.printing);
      if (isNew && existing >= MAX_ALERTS_PER_TOKEN) {
        return json({ error: `Too many alerts (max ${MAX_ALERTS_PER_TOKEN})` }, 429);
      }
      await upsertPriceAlert(parsed.token, parsed.key, parsed.alert);
    } else if (parsed.action === 'remove') {
      await removePriceAlert(parsed.token, parsed.key);
    }

    return json({ ok: true, alerts: await getPriceAlertsForToken(parsed.token) });
  } catch (err: any) {
    console.error('[push/price-alerts]', err);
    return json({ error: err.message || 'Price alert update failed' }, 500);
  }
}
