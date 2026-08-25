// Provider-neutral subscription domain (DIC-1149 Phase 1a).
//
// This module intentionally does NOT depend on RevenueCat, Stripe, App Store,
// Play Console, or any concrete billing SDK. Concrete providers are wired
// later behind the adapter interface in ./providers/types.ts. Everything here
// speaks only in the domain language of "entitlement state" so that the state
// machine is testable in isolation and safe to reason about without a live
// billing backend.

/**
 * Explicit entitlement states.
 *
 * The eight values are the closed set the state machine reasons over. Every
 * downstream consumer (permissions, quota, paywall copy) must switch on this
 * enum exhaustively so that adding a new state is a compile-time change.
 *
 * Semantics:
 *  - `free`                    — no active paid entitlement; default for guest
 *                                and free_user. Store MVP Production stays here.
 *  - `active`                  — paid entitlement in-force; premium unlocked.
 *  - `grace`                   — provider says renewal failed but a grace
 *                                window is open; treat as entitled until the
 *                                window closes. Do NOT hide features mid-window.
 *  - `billing_issue`           — provider flagged a billing failure OUTSIDE
 *                                grace (or grace has been consumed). Entitlement
 *                                is suspended; UI must prompt the user to fix
 *                                billing but must NOT accuse them of fraud.
 *  - `cancelled_until_expiry`  — user cancelled but the paid period has not
 *                                yet ended. Still entitled; do not downgrade
 *                                until `expiresAt` is reached.
 *  - `expired`                 — paid period ended without renewal. Entitlement
 *                                is gone. Distinguish from `refunded_revoked`
 *                                because the user did nothing wrong.
 *  - `refunded_revoked`        — provider issued a refund or forcibly revoked
 *                                the entitlement (chargeback, policy violation,
 *                                admin action). Entitlement is gone AND the
 *                                revocation reason should surface in support UI.
 *  - `unknown`                 — the domain could not classify the provider
 *                                signal. FAIL CLOSED: treat as no entitlement.
 *                                Never surface premium features from `unknown`;
 *                                never surface a "cancel" affordance from
 *                                `unknown` (there is nothing verified to
 *                                cancel).
 */
export type EntitlementState =
  | 'free'
  | 'active'
  | 'grace'
  | 'billing_issue'
  | 'cancelled_until_expiry'
  | 'expired'
  | 'refunded_revoked'
  | 'unknown';

/**
 * The five state families entitled consumers actually care about. Consumers
 * should read {@link isEntitled} rather than duplicating this list.
 */
export const ENTITLED_STATES: ReadonlySet<EntitlementState> = new Set([
  'active',
  'grace',
  'cancelled_until_expiry',
]);

export function isEntitled(state: EntitlementState): boolean {
  return ENTITLED_STATES.has(state);
}

/**
 * Provider-neutral subscription snapshot. Concrete providers translate their
 * own payloads into this shape at the adapter boundary — everything above the
 * adapter reasons in these fields.
 */
export interface SubscriptionSnapshot {
  /** Domain state; the single source of truth for entitlement decisions. */
  state: EntitlementState;
  /**
   * Opaque product identifier. Provider-neutral (no App Store SKU / Play SKU /
   * Stripe price ID hard-coded here). May be `null` when the state is `free`
   * or `unknown`.
   */
  productId: string | null;
  /**
   * ISO-8601 timestamp at which the current paid period ends. `null` when
   * there is no active or cancelled-until-expiry period.
   */
  expiresAt: string | null;
  /**
   * Monotonic provider event revision. Used to reject out-of-order and
   * duplicate provider events at the domain boundary. See {@link reduce}.
   * Starts at 0 for the initial `free` snapshot.
   */
  revision: number;
  /**
   * Which provider produced this snapshot (opaque tag). `null` for the
   * synthetic default `free` snapshot.
   */
  providerTag: string | null;
  /**
   * ISO-8601 timestamp when the snapshot was recorded. Diagnostic only.
   */
  recordedAt: string;
}

/**
 * The neutral event shape provider adapters emit. Concrete adapters translate
 * webhook payloads / SDK callbacks / restore-purchase results into one of
 * these before handing off to the state machine.
 */
export interface ProviderEvent {
  /**
   * Event kind. Kept small and explicit so a new kind is a compile-time change.
   */
  kind:
    | 'purchase_verified'
    | 'renewal_verified'
    | 'entered_grace'
    | 'billing_issue_reported'
    | 'cancel_scheduled'
    | 'expired'
    | 'refund_or_revoke'
    | 'restore_verified';
  /**
   * Opaque product id from the provider. Provider-neutral: the domain does
   * not compare this against any hard-coded catalog.
   */
  productId: string | null;
  /**
   * When the paid period ends after applying this event, if known. `null`
   * means "no active period after this event".
   */
  expiresAt: string | null;
  /**
   * Monotonic revision assigned by the adapter (usually derived from the
   * provider's own event id / sequence number). Events with revision `<=`
   * the current snapshot's revision are dropped as duplicate/out-of-order.
   */
  revision: number;
  /**
   * Which provider produced this event.
   */
  providerTag: string;
  /**
   * ISO-8601 timestamp the event was emitted at (provider clock, when
   * available). Diagnostic only.
   */
  emittedAt: string;
}

/**
 * Purchase context handed to the adapter. Contains the injectable backend
 * user id (see ./appUserId.ts) so that adapters never invent one from an
 * email / device id / OAuth subject.
 */
export interface PurchaseContext {
  appUserId: string;
  productId: string;
}

/**
 * Result of a purchase / restore attempt. Client-side success is NOT an
 * entitlement grant on its own — the server-authoritative snapshot is what
 * decides. This shape carries only the outcome; the entitlement is fetched
 * from the server afterwards.
 */
export type PurchaseOutcome =
  | { kind: 'succeeded'; productId: string }
  | { kind: 'cancelled' }
  | { kind: 'pending' }
  | { kind: 'failed'; reason: PurchaseFailureReason };

export type PurchaseFailureReason =
  | 'network'
  | 'payment_declined'
  | 'not_allowed'
  | 'unknown';

/**
 * The synthetic default snapshot used whenever we have no verified provider
 * state. This is what a guest, a fresh install, and Store MVP Production all
 * observe — the app must be fully usable in this state (no premium features,
 * but no lockout either) so that a missing or broken subscription backend
 * cannot brick the app.
 */
export const DEFAULT_FREE_SNAPSHOT: SubscriptionSnapshot = Object.freeze({
  state: 'free',
  productId: null,
  expiresAt: null,
  revision: 0,
  providerTag: null,
  recordedAt: '1970-01-01T00:00:00.000Z',
});

/**
 * Fail-closed snapshot used when configuration is absent/malformed or a
 * provider event cannot be classified. Distinct from `free` so that
 * observability can distinguish "we know the user has no entitlement" from
 * "we could not resolve the user's entitlement".
 */
export const UNKNOWN_SNAPSHOT: SubscriptionSnapshot = Object.freeze({
  state: 'unknown',
  productId: null,
  expiresAt: null,
  revision: 0,
  providerTag: null,
  recordedAt: '1970-01-01T00:00:00.000Z',
});
