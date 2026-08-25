// Provider-neutral entitlement state machine (DIC-1149 Phase 1a).
//
// Given a current SubscriptionSnapshot and an incoming ProviderEvent, produce
// the next snapshot. The transition table is EXPLICIT — every allowed pair is
// listed. Anything not listed collapses to `unknown` (fail-closed) so a
// mis-classified event never silently grants entitlement.
//
// Two invariants govern every call to {@link reduce}:
//
//  1. **Idempotence / ordering.** Events with `revision <= current.revision`
//     are dropped. Providers frequently redeliver webhooks and adapters that
//     read `restorePurchases()` after a fresh `purchase()` will see the same
//     transaction twice. Comparing revisions at the domain boundary means
//     downstream code never has to worry about it.
//
//  2. **No client escalation.** The reducer accepts an event and returns a
//     snapshot; it does NOT accept a bare "client says the purchase
//     succeeded" signal. Adapters must first verify with the server (or,
//     for restore, with the provider itself) before emitting
//     `purchase_verified` / `renewal_verified` / `restore_verified`. The
//     `PurchaseOutcome.succeeded` type is deliberately non-load-bearing.

import type {
  EntitlementState,
  ProviderEvent,
  SubscriptionSnapshot,
} from './types';
import { DEFAULT_FREE_SNAPSHOT, UNKNOWN_SNAPSHOT } from './types';

/**
 * Reasons a transition can be rejected. Diagnostic — the reducer still
 * returns a snapshot even when it rejects an event, and callers can log
 * the reason.
 */
export type TransitionRejection =
  | 'duplicate_or_out_of_order'
  | 'unsupported_transition'
  | 'provider_mismatch';

export interface ReduceResult {
  snapshot: SubscriptionSnapshot;
  rejected: TransitionRejection | null;
}

/**
 * Explicit allowed transitions per event kind. Read this table top-to-bottom
 * before changing it: every row is a decision about entitlement semantics.
 */
const ALLOWED: Record<ProviderEvent['kind'], ReadonlyArray<EntitlementState>> = {
  // A first-time purchase can arrive from `free` (new subscriber) or from
  // any post-entitlement terminal state (win-back). It is NOT valid from
  // `active` / `grace` / `cancelled_until_expiry` — those should route
  // through `renewal_verified` instead so revision ordering is preserved.
  purchase_verified: ['free', 'expired', 'refunded_revoked', 'unknown'],

  // A renewal can extend any live state or restore from grace / billing issue.
  renewal_verified: [
    'active',
    'grace',
    'billing_issue',
    'cancelled_until_expiry',
  ],

  // Entering grace only makes sense from an active-ish state.
  entered_grace: ['active', 'cancelled_until_expiry'],

  // Billing issue reported outside grace suspends entitlement.
  billing_issue_reported: ['active', 'grace', 'cancelled_until_expiry'],

  // Scheduling a cancel is only valid from active / grace / billing_issue.
  cancel_scheduled: ['active', 'grace', 'billing_issue'],

  // Expiration is the natural terminal for cancelled_until_expiry and grace.
  expired: [
    'active',
    'grace',
    'billing_issue',
    'cancelled_until_expiry',
  ],

  // Refunds / revocations can arrive from any state EXCEPT `free` (nothing
  // to refund) and `unknown` (we would be inventing a chargeback we cannot
  // verify).
  refund_or_revoke: [
    'active',
    'grace',
    'billing_issue',
    'cancelled_until_expiry',
    'expired',
  ],

  // Restore is defensive: it can promote `free` / `unknown` back to an
  // entitled state when the provider confirms a still-valid subscription
  // the client had forgotten. It also refreshes existing entitled states.
  restore_verified: [
    'free',
    'unknown',
    'active',
    'grace',
    'billing_issue',
    'cancelled_until_expiry',
  ],
};

/**
 * Next state produced by each event kind. Distinct from {@link ALLOWED},
 * which decides whether the event may fire at all.
 */
function nextState(kind: ProviderEvent['kind']): EntitlementState {
  switch (kind) {
    case 'purchase_verified':
    case 'renewal_verified':
    case 'restore_verified':
      return 'active';
    case 'entered_grace':
      return 'grace';
    case 'billing_issue_reported':
      return 'billing_issue';
    case 'cancel_scheduled':
      return 'cancelled_until_expiry';
    case 'expired':
      return 'expired';
    case 'refund_or_revoke':
      return 'refunded_revoked';
  }
}

/**
 * Compute the next snapshot given the current snapshot and an incoming
 * event. Pure function — no I/O, no clock reads except for `recordedAt`
 * being taken from the event's own `emittedAt` (adapter's responsibility).
 *
 * Rejection policy:
 *  - `provider_mismatch`: current snapshot came from provider A and the
 *    event is from provider B. Keep the current snapshot. We do not support
 *    concurrent providers per user in Phase 1a; a future migration is a
 *    separate design.
 *  - `duplicate_or_out_of_order`: event revision `<=` current revision.
 *    Keep the current snapshot.
 *  - `unsupported_transition`: event fired from a state that is not in the
 *    ALLOWED list. Fail closed to `unknown` — the classification we had is
 *    now stale and we would rather deny than accidentally grant.
 */
export function reduce(
  current: SubscriptionSnapshot,
  event: ProviderEvent,
): ReduceResult {
  // Provider mismatch guard — but a provider is allowed to "adopt" a
  // synthetic snapshot (providerTag === null) since that is the default we
  // ship to every client before any provider has ever spoken.
  if (current.providerTag !== null && current.providerTag !== event.providerTag) {
    return { snapshot: current, rejected: 'provider_mismatch' };
  }

  // Idempotence / ordering guard — always applied before the transition
  // table so that a duplicate event can never trigger a state change.
  if (event.revision <= current.revision) {
    return { snapshot: current, rejected: 'duplicate_or_out_of_order' };
  }

  const allowedFromStates = ALLOWED[event.kind];
  // Unknown event kind (e.g., a malformed client-side signal that reached
  // the reducer through a bypass) collapses to `unknown` too. We keep the
  // current revision so the bad input does not corrupt ordering.
  if (!allowedFromStates) {
    return {
      snapshot: {
        ...UNKNOWN_SNAPSHOT,
        revision: current.revision,
        providerTag: current.providerTag,
        recordedAt: current.recordedAt,
      },
      rejected: 'unsupported_transition',
    };
  }
  if (!allowedFromStates.includes(current.state)) {
    // Unsupported: we would have to invent an entitlement we cannot justify.
    // Collapse to `unknown` and carry the event's revision forward so we
    // do not re-process the same bad event on the next retry.
    return {
      snapshot: {
        ...UNKNOWN_SNAPSHOT,
        revision: event.revision,
        providerTag: event.providerTag,
        recordedAt: event.emittedAt,
      },
      rejected: 'unsupported_transition',
    };
  }

  return {
    snapshot: {
      state: nextState(event.kind),
      // `expired` and `refund_or_revoke` clear the product id — there is
      // nothing left to reference. Every other transition preserves it.
      productId:
        event.kind === 'expired' || event.kind === 'refund_or_revoke'
          ? null
          : event.productId,
      expiresAt: event.expiresAt,
      revision: event.revision,
      providerTag: event.providerTag,
      recordedAt: event.emittedAt,
    },
    rejected: null,
  };
}

/**
 * Fold a list of events. Convenience wrapper used by tests and by adapters
 * that batch-apply a webhook backlog on cold start. Any rejections are
 * returned alongside the final snapshot.
 */
export function fold(
  events: readonly ProviderEvent[],
  initial: SubscriptionSnapshot = DEFAULT_FREE_SNAPSHOT,
): { snapshot: SubscriptionSnapshot; rejections: TransitionRejection[] } {
  let snapshot = initial;
  const rejections: TransitionRejection[] = [];
  for (const event of events) {
    const result = reduce(snapshot, event);
    if (result.rejected) rejections.push(result.rejected);
    snapshot = result.snapshot;
  }
  return { snapshot, rejections };
}
