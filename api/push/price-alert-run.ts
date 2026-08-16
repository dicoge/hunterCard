// Scheduled evaluation of the exact-version desired-price alerts (DIC-1023).
//
// The feeder (scripts/send-price-alerts.mjs) only supplies a price snapshot for
// the exact printings that actually have alerts. Deciding WHO gets notified —
// and recording the arm state that prevents a re-notify on an unchanged price —
// happens here, server-side, so the feeder can never be used to push arbitrary
// messages at arbitrary devices.

import {
  getAllPriceAlerts, getAlertArmStates, setAlertArmStates,
  claimAlertSend, releaseAlertClaim, commitAlertClaim,
} from '../_lib/kv-storage';
import { isInternalRequest } from '../_lib/internal-auth';
import { parsePriceSnapshot, indexPrices } from '../_lib/price-alert-request';
import {
  evaluatePriceAlerts, buildAlertMessage, armStateKey, priceAlertKey,
  type AlertArmState, type AlertRecipient, type AlertSend,
} from '../../src/utils/priceAlerts';

export const config = { runtime: 'nodejs' };

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Internal-Secret',
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

export default async function handler(req: Request) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!isInternalRequest(req)) return json({ error: 'Unauthorized' }, 401);

  // Claims this run holds and has not yet resolved, so an unexpected failure can
  // hand them back immediately instead of waiting out the lease.
  const held = new Set<string>();

  try {
    const body = await req.json().catch(() => ({}));
    const snapshot = parsePriceSnapshot(body?.prices);
    if (!snapshot.ok) return json({ error: snapshot.error }, 400);

    const byToken = await getAllPriceAlerts();
    const recipients: AlertRecipient[] = Object.entries(byToken).flatMap(
      ([token, alerts]) => alerts.map((alert) => ({ token, alert })),
    );
    if (recipients.length === 0) {
      return json({ ok: true, sent: 0, errors: 0, skipped: 0, rearmed: 0, unpriced: 0 });
    }

    const prices = indexPrices(snapshot.prices);
    const stateKeys = recipients.map(({ token, alert }) =>
      armStateKey(token, alert.cardNumber, alert.printing));
    const states = await getAlertArmStates([...new Set(stateKeys)]);

    const evaluation = evaluatePriceAlerts(
      recipients,
      (cardNumber, printing) => prices.get(priceAlertKey(cardNumber, printing)) ?? null,
      states,
    );

    const now = Date.now();

    // Leaving the interval re-arms immediately and unconditionally — it is not
    // contingent on any delivery outcome. Drop the claim BEFORE marking the
    // alert armed: if the run dies between the two the alert is merely still
    // disarmed and the next run re-arms it again, whereas the reverse order
    // would leave it armed behind a claim nothing ever clears.
    const rearmPatch: Record<string, AlertArmState> = {};
    for (const key of evaluation.rearm) {
      await releaseAlertClaim(key);
      rearmPatch[key] = { armed: true };
    }
    await setAlertArmStates(rearmPatch);

    // Take the atomic claim before building any Expo payload. Two overlapping
    // runs both see the alert as armed, but only one can win the claim, so only
    // one can notify — the disarm below is what ends the episode, not what
    // makes it exclusive.
    const claimed: AlertSend[] = [];
    let contended = 0;
    for (const send of evaluation.sends) {
      if (await claimAlertSend(send.stateKey)) {
        claimed.push(send);
        held.add(send.stateKey);
      } else {
        contended += 1;
      }
    }

    let sent = 0;
    let errors = 0;

    /** Hand a claim back so the next run retries this alert straight away. */
    const release = async (send: AlertSend) => {
      await releaseAlertClaim(send.stateKey);
      held.delete(send.stateKey);
    };

    for (const batch of chunk(claimed, 100)) {
      const messages = batch.map((send: AlertSend) => ({
        to: send.token,
        ...buildAlertMessage(send),
        data: {
          cardNumber: send.alert.cardNumber,
          printing: send.alert.printing,
          price: send.price,
          currency: send.currency,
        },
      }));

      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messages),
      });

      if (!res.ok) {
        errors += batch.length;
        console.warn(`[push/price-alert-run] Expo Push API ${res.status}: ${await res.text()}`);
        for (const send of batch) await release(send);
        continue;
      }

      const data = await res.json().catch(() => ({}));
      const tickets = Array.isArray(data?.data) ? data.data : [];
      if (tickets.length === 0) {
        // No per-message ticket to confirm delivery: count it but leave the
        // alert armed and unclaimed so the next run retries instead of going
        // silent.
        sent += batch.length;
        for (const send of batch) await release(send);
        continue;
      }

      // Tickets come back in the same order as the batch we sent.
      const confirmed: AlertSend[] = [];
      const patch: Record<string, AlertArmState> = {};
      batch.forEach((send, i) => {
        if (tickets[i]?.status === 'ok') {
          sent += 1;
          confirmed.push(send);
          patch[send.stateKey] = { armed: false, lastNotifiedAt: now, lastPrice: send.price };
        } else {
          errors += 1;
        }
      });

      // Disarm first, then close the claim — see commitAlertClaim.
      await setAlertArmStates(patch);
      for (const send of confirmed) {
        await commitAlertClaim(send.stateKey);
        held.delete(send.stateKey);
      }
      for (const send of batch) {
        if (held.has(send.stateKey)) await release(send);
      }
    }

    return json({
      ok: true,
      sent,
      errors,
      skipped: evaluation.skipped,
      contended,
      rearmed: evaluation.rearm.length,
      unpriced: evaluation.unpriced,
    });
  } catch (err: any) {
    console.error('[push/price-alert-run]', err);
    // Best effort only: if this fails too (or the process is killed outright)
    // the lease expiry is what guarantees the alert comes back.
    for (const stateKey of held) {
      await releaseAlertClaim(stateKey).catch(() => {});
    }
    return json({ error: err.message || 'Price alert run failed', sent: 0, errors: 1 }, 500);
  }
}
