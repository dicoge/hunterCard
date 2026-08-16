// Scheduled evaluation of the exact-version desired-price alerts (DIC-1023).
//
// The feeder (scripts/send-price-alerts.mjs) only supplies a price snapshot for
// the exact printings that actually have alerts. Deciding WHO gets notified —
// and recording the arm state that prevents a re-notify on an unchanged price —
// happens here, server-side, so the feeder can never be used to push arbitrary
// messages at arbitrary devices.

import {
  getAllPriceAlerts, getAlertArmStates,
  claimAlertSend, releaseAlertClaim, commitAlertClaim, rearmAlertEpisode,
} from '../_lib/kv-storage';
import { isInternalRequest } from '../_lib/internal-auth';
import { parsePriceSnapshot, indexPrices } from '../_lib/price-alert-request';
import {
  evaluatePriceAlerts, buildAlertMessage, armStateKey, priceAlertKey,
  type AlertRecipient, type AlertSend,
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

  // Claims this run owns and has not yet resolved, keyed by alert → owner token,
  // so an unexpected failure can hand them back immediately instead of waiting
  // out the lease.
  const held = new Map<string, string>();

  try {
    const body = await req.json().catch(() => ({}));
    const snapshot = parsePriceSnapshot(body?.prices);
    if (!snapshot.ok) return json({ error: snapshot.error }, 400);

    const byToken = await getAllPriceAlerts();
    const recipients: AlertRecipient[] = Object.entries(byToken).flatMap(
      ([token, alerts]) => alerts.map((alert) => ({ token, alert })),
    );
    if (recipients.length === 0) {
      return json({
        ok: true, sent: 0, errors: 0, skipped: 0, contended: 0, superseded: 0,
        rearmed: 0, unpriced: 0,
      });
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
    // contingent on any delivery outcome. One atomic write per alert, and it
    // only clears a delivered episode, so it can never disturb a send that
    // another runner is in the middle of.
    for (const key of evaluation.rearm) await rearmAlertEpisode(key);

    // Take the atomic claim before building any Expo payload. Two overlapping
    // runs both see the alert as armed, but only one can win the claim, so only
    // one can notify — the disarm below is what ends the episode, not what
    // makes it exclusive. The owner token returned here fences every later
    // write, so a runner that was taken over or superseded cannot clean up or
    // disarm on the current owner's behalf.
    const claimed: AlertSend[] = [];
    let contended = 0;
    for (const send of evaluation.sends) {
      const owner = await claimAlertSend(send.stateKey);
      if (owner) {
        claimed.push(send);
        held.set(send.stateKey, owner);
      } else {
        contended += 1;
      }
    }

    let sent = 0;
    let errors = 0;
    let superseded = 0;

    /** Hand a claim back so the next run retries this alert straight away. */
    const release = async (send: AlertSend) => {
      const owner = held.get(send.stateKey);
      if (!owner) return;
      await releaseAlertClaim(send.stateKey, owner);
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
      for (const [i, send] of batch.entries()) {
        if (tickets[i]?.status !== 'ok') {
          errors += 1;
          await release(send);
          continue;
        }
        // Confirmed delivery. Disarming IS closing the claim, so it cannot be
        // half-applied — and it only lands if we still own the episode.
        sent += 1;
        const owner = held.get(send.stateKey)!;
        const outcome = await commitAlertClaim(send.stateKey, owner, now, send.price);
        if (outcome !== 'committed') superseded += 1;
        held.delete(send.stateKey);
      }
    }

    return json({
      ok: true,
      sent,
      errors,
      skipped: evaluation.skipped,
      contended,
      superseded,
      rearmed: evaluation.rearm.length,
      unpriced: evaluation.unpriced,
    });
  } catch (err: any) {
    console.error('[push/price-alert-run]', err);
    // Best effort only: if this fails too (or the process is killed outright)
    // the lease expiry is what guarantees the alert comes back.
    for (const [stateKey, owner] of held) {
      await releaseAlertClaim(stateKey, owner).catch(() => {});
    }
    return json({ error: err.message || 'Price alert run failed', sent: 0, errors: 1 }, 500);
  }
}
