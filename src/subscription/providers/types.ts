// Provider adapter interfaces (DIC-1149 Phase 1a).
//
// These are the shapes concrete providers (RevenueCat, Stripe, App Store
// Server API, Play Billing, …) must implement to plug into the neutral
// subscription domain. No concrete provider lives here in Phase 1a — the
// point of this file is to freeze the seam so the domain and its tests can
// exist without a billing SDK, and so the eventual concrete adapter is a
// clean drop-in.
//
// Rules enforced by the interface shape:
//
//  1. Adapters take an {@link AppUserIdentity} — an injected backend UUID —
//     rather than an email / Apple sub / Google token / device id. There is
//     no overload that accepts anything else.
//
//  2. Adapters return {@link PurchaseOutcome} for a purchase attempt, but
//     `succeeded` here is a CLIENT-side signal only. The caller must still
//     fetch a fresh {@link SubscriptionSnapshot} from the server before
//     unlocking any feature — the domain state machine's `purchase_verified`
//     transition is only fired by a verified source, not by this outcome.
//
//  3. Adapters translate provider payloads into neutral {@link ProviderEvent}
//     values via {@link SubscriptionProviderAdapter.normalizeEvent}. If a
//     payload cannot be classified, they MUST return `null` — never invent a
//     kind. `null` collapses to the `unknown` state at the state machine.

import type {
  ProviderEvent,
  PurchaseContext,
  PurchaseOutcome,
  SubscriptionSnapshot,
} from '../types';

/**
 * The only permitted app-user identity. See ./../appUserId.ts for the
 * construction / validation rules. Adapters MUST NOT accept a bare string
 * — the branded type is what enforces that at the call site.
 */
export interface AppUserIdentity {
  readonly __brand: 'AppUserIdentity';
  readonly value: string;
}

/**
 * Adapters must self-report a stable tag. It becomes the `providerTag` on
 * every event and snapshot they emit; the state machine uses it to reject
 * cross-provider transitions.
 */
export interface SubscriptionProviderAdapter {
  readonly providerTag: string;

  /**
   * Kick off a purchase. Returns a client-side outcome. The caller MUST
   * NOT treat `succeeded` as an entitlement grant on its own — that is
   * what {@link fetchSnapshot} + the state machine are for.
   */
  purchase(context: PurchaseContext): Promise<PurchaseOutcome>;

  /**
   * Ask the provider to re-emit all events for this user. Fails loudly
   * (rejects) on transport / auth error — the caller must NOT silently
   * treat a failed restore as "no entitlement".
   */
  restore(identity: AppUserIdentity): Promise<readonly ProviderEvent[]>;

  /**
   * Fetch the current server-authoritative snapshot for this user. Returns
   * `null` if the provider has no record of the user at all (distinct from
   * "the user has no entitlement", which is a `free` snapshot).
   */
  fetchSnapshot(identity: AppUserIdentity): Promise<SubscriptionSnapshot | null>;

  /**
   * Normalise a raw provider payload (webhook body, SDK callback, …) into
   * a neutral {@link ProviderEvent}. Return `null` when the payload cannot
   * be classified — the state machine will then collapse the snapshot to
   * `unknown` (fail-closed) rather than acting on an inferred event.
   *
   * Adapters MUST assign a monotonic `revision` here (typically derived
   * from the provider's own event id / cursor). Two different payloads
   * with the same revision indicate a provider bug and must produce
   * different revisions (adapter's responsibility).
   */
  normalizeEvent(rawPayload: unknown): ProviderEvent | null;
}

/**
 * A registry keyed by provider tag. Present so the eventual concrete
 * providers can be plugged in without touching the domain. Phase 1a ships
 * this empty — the type exists only so that call sites are already written
 * against a map instead of a hard-coded switch.
 */
export type SubscriptionProviderRegistry = Readonly<
  Record<string, SubscriptionProviderAdapter>
>;

export const EMPTY_PROVIDER_REGISTRY: SubscriptionProviderRegistry = Object.freeze({});
