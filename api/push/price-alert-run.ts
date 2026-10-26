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
import { toNodeHandler } from '../_lib/node-adapter';
// DIC-1189 rework 3rd pass — blocker #3a: this endpoint is the SECOND Expo
// sender in the codebase (alongside api/push/notify.ts). On staging every
// recipient must be filtered through the EXPO_STAGING_TEST_TOKENS allow-list
// (empty = no send) and every message data payload must carry
// `environment=staging` so the receiving client can distinguish synthetic
// from real. Production: allow-list is bypassed, tag is undefined, wire
// payload byte-identical.
import { filterPushRecipients, pushEnvironmentTag } from '../_lib/push-staging-guard';

export const config = { runtime: 'nodejs' };

/** The claim this run holds for one alert. Both halves fence every later write:
 * `rev` proves the configuration has not been edited underneath us, `owner`
 * proves the lease has not been taken over. */
type HeldClaim = { rev: string; owner: string };

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

async function webHandler(req: Request) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!isInternalRequest(req)) return json({ error: 'Unauthorized' }, 401);

  // Claims this run owns and has not yet resolved, keyed by alert state key, so
  // an unexpected failure can hand them back immediately instead of waiting out
  // the lease.
  const held = new Map<string, HeldClaim>();

  try {
    const body = await req.json().catch(() => ({}));
    const snapshot = parsePriceSnapshot(body?.prices);
    if (!snapshot.ok) return json({ error: snapshot.error }, 400);

    // The revision each alert was read at. Everything downstream — arm state,
    // claim, release, commit, re-arm — is fenced with it, so a configuration
    // the user edits after this read can never be judged by this snapshot.
    const byToken = await getAllPriceAlerts();
    const recipientsRaw: AlertRecipient[] = [];
    const revisions = new Map<string, string>();
    for (const [token, alerts] of Object.entries(byToken)) {
      for (const { rev, ...alert } of alerts) {
        recipientsRaw.push({ token, alert });
        revisions.set(armStateKey(token, alert.cardNumber, alert.printing), rev);
      }
    }
    // DIC-1189 rework 3rd pass — blocker #3a: apply the staging synthetic-only
    // filter here too. On production this is identity; on staging tokens not
    // on EXPO_STAGING_TEST_TOKENS are dropped BEFORE any claim/send, so their
    // arm state, revision fences, and claim leases never move.
    const recipients: AlertRecipient[] = filterPushRecipients(recipientsRaw);
    const stagingFilteredOut = recipientsRaw.length - recipients.length;
    if (recipients.length === 0) {
      return json({
        ok: true, sent: 0, errors: 0, skipped: stagingFilteredOut,
        contended: 0, stale: 0, superseded: 0, rearmed: 0, unpriced: 0,
      });
    }

    const prices = indexPrices(snapshot.prices);
    const states = await getAlertArmStates(
      [...revisions].map(([stateKey, rev]) => ({ stateKey, rev })),
    );

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
    for (const key of evaluation.rearm) await rearmAlertEpisode(key, revisions.get(key)!);

    // Take the atomic claim before building any Expo payload. Two overlapping
    // runs both see the alert as armed, but only one can win the claim, so only
    // one can notify — the disarm below is what ends the episode, not what
    // makes it exclusive. The owner token returned here fences every later
    // write, so a runner that was taken over or superseded cannot clean up or
    // disarm on the current owner's behalf.
    const claimed: AlertSend[] = [];
    let contended = 0;
    let stale = 0;
    for (const send of evaluation.sends) {
      const rev = revisions.get(send.stateKey)!;
      const claim = await claimAlertSend(
        send.token, priceAlertKey(send.alert.cardNumber, send.alert.printing), rev,
      );
      if (claim.status === 'claimed') {
        claimed.push(send);
        held.set(send.stateKey, { rev, owner: claim.owner });
      } else if (claim.status === 'stale') {
        // The user edited or deleted this alert after we read it. The decision
        // in hand was made against a configuration that no longer exists, so it
        // is dropped outright — the next run re-evaluates the new one.
        stale += 1;
      } else {
        contended += 1;
      }
    }

    let sent = 0;
    let errors = 0;
    let superseded = 0;

    /** Hand a claim back so the next run retries this alert straight away. */
    const release = async (send: AlertSend) => {
      const claim = held.get(send.stateKey);
      if (!claim) return;
      await releaseAlertClaim(send.stateKey, claim.rev, claim.owner);
      held.delete(send.stateKey);
    };

    // DIC-1189 rework 3rd pass — blocker #3a: on staging, stamp
    // `environment=staging` into every push message's data payload so the
    // receiving client (and any downstream analytics) can distinguish
    // synthetic from real. Undefined on production so the wire is unchanged.
    const envTag = pushEnvironmentTag();
    for (const batch of chunk(claimed, 100)) {
      const messages = batch.map((send: AlertSend) => ({
        to: send.token,
        ...buildAlertMessage(send),
        data: envTag
          ? {
              cardNumber: send.alert.cardNumber,
              printing: send.alert.printing,
              price: send.price,
              currency: send.currency,
              environment: envTag,
            }
          : {
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
        const { rev, owner } = held.get(send.stateKey)!;
        const outcome = await commitAlertClaim(send.stateKey, rev, owner, now, send.price);
        if (outcome !== 'committed') superseded += 1;
        held.delete(send.stateKey);
      }
    }

    return json({
      ok: true,
      sent,
      errors,
      skipped: evaluation.skipped + stagingFilteredOut,
      contended,
      stale,
      superseded,
      rearmed: evaluation.rearm.length,
      unpriced: evaluation.unpriced,
    });
  } catch (err: any) {
    console.error('[push/price-alert-run]', err);
    // Best effort only: if this fails too (or the process is killed outright)
    // the lease expiry is what guarantees the alert comes back.
    for (const [stateKey, { rev, owner }] of held) {
      await releaseAlertClaim(stateKey, rev, owner).catch(() => {});
    }
    return json({ error: err.message || 'Price alert run failed', sent: 0, errors: 1 }, 500);
  }
}

export default toNodeHandler(webHandler);
