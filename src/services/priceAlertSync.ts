/**
 * Mirror the local exact-version price alerts to the push backend (DIC-1023).
 *
 * Background push needs a real Expo push token, which only exists on a native
 * build with notifications granted. On web / guest / denied-permission there is
 * no token, so the alert stays purely local — the UI says so rather than
 * implying a browser background notification that does not exist.
 */
import { getCachedPushToken, getApiBase } from './pushNotificationService';
import type { PriceAlert } from '../utils/priceAlerts';

export type SyncOutcome = 'synced' | 'local-only' | 'failed';

async function post(action: 'upsert' | 'remove', alert: Pick<PriceAlert, 'cardNumber' | 'printing'> & Partial<PriceAlert>): Promise<SyncOutcome> {
  const token = getCachedPushToken();
  if (!token) return 'local-only';
  try {
    const res = await fetch(`${getApiBase()}/api/push/price-alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, action, alert }),
    });
    if (!res.ok) {
      console.warn(`[price-alerts] ${action} returned ${res.status}`);
      return 'failed';
    }
    return 'synced';
  } catch (err) {
    console.warn(`[price-alerts] ${action} failed:`, err);
    return 'failed';
  }
}

export function pushAlertAvailable(): boolean {
  return getCachedPushToken() !== null;
}

export function syncAlertUpsert(alert: PriceAlert): Promise<SyncOutcome> {
  return post('upsert', alert);
}

export function syncAlertRemove(cardNumber: string, printing: string): Promise<SyncOutcome> {
  return post('remove', { cardNumber, printing });
}
