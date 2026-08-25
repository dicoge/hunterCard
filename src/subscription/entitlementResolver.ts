// Bridge between the provider-neutral subscription snapshot and the
// existing role / permission contract (DIC-1149 Phase 1a).
//
// The rest of the app reasons in `UserRole` ('guest' / 'free_user' /
// 'subscriber'). This module is the only place that maps a domain
// {@link SubscriptionSnapshot} down into that role, so:
//
//   - Existing consumers (permissionService, scanQuotaStore) do not change
//     shape and existing scan limits stay the same.
//   - Store MVP Production keeps observing `free_user` because it never
//     configures a provider (so the resolver never runs against a real
//     snapshot, and the fallback is always `free_user`).
//   - There is no client-only path from "purchase button was tapped" to
//     `subscriber`. The resolver only escalates when it observes a
//     server-authoritative snapshot in an entitled state AND a signed-in
//     user AND the release gate that permits subscription features.
//
// Kept independent of the react-native `Platform` import chain in
// src/config/releaseFlags.ts: `premiumEnabled` is passed IN, so the domain
// module can be unit-tested in pure Node. The composition edge in the app
// reads `FEATURES.premium` once and forwards it here.

import type { UserRole } from '../types/auth';
import { isEntitled, type SubscriptionSnapshot } from './types';
import type { SubscriptionConfig } from './config';

export interface ResolveRoleInputs {
  /** Auth store's view of the user. `null` means guest. */
  readonly signedInUserId: string | null;
  /** The current server-authoritative snapshot, if any. */
  readonly snapshot: SubscriptionSnapshot | null;
  /** Resolved subscription config; when `.enabled=false` we short-circuit. */
  readonly config: SubscriptionConfig;
  /**
   * Release flag: `FEATURES.premium` from src/config/releaseFlags.ts. When
   * false (Store MVP Production, currently), every entitlement collapses
   * to `free_user` — matches the existing effectiveRole() rule so we do
   * not double-decide it in the permission layer.
   */
  readonly premiumEnabled: boolean;
}

/**
 * Map the domain state to the existing `UserRole` enum. Every non-entitled
 * or unresolved case collapses to the appropriate free path.
 *
 * Rules:
 *   1. No signed-in user → `guest`. Never mind the snapshot; a guest cannot
 *      hold an entitlement in Phase 1a (that would require an anonymous
 *      user model we have not designed).
 *   2. `premiumEnabled === false` → `free_user`. Store MVP profile still
 *      collapses subscribers to free.
 *   3. `config.enabled === false` → `free_user`. Missing / malformed env
 *      never grants a subscription.
 *   4. Snapshot is `null` or from a different provider than the configured
 *      one → `free_user`. We do NOT invent a subscriber role from a stale
 *      client snapshot.
 *   5. Snapshot is `unknown` → `free_user`. Fail-closed.
 *   6. Snapshot state is entitled (`active` / `grace` /
 *      `cancelled_until_expiry`) → `subscriber`. Any other state
 *      (`billing_issue` / `expired` / `refunded_revoked`) → `free_user`.
 */
export function resolveRoleFromSnapshot(inputs: ResolveRoleInputs): UserRole {
  const { signedInUserId, snapshot, config, premiumEnabled } = inputs;

  if (!signedInUserId) return 'guest';
  if (!premiumEnabled) return 'free_user';
  if (!config.enabled) return 'free_user';
  if (!snapshot) return 'free_user';
  if (snapshot.state === 'unknown') return 'free_user';
  if (snapshot.providerTag !== null && snapshot.providerTag !== config.providerTag) {
    return 'free_user';
  }
  return isEntitled(snapshot.state) ? 'subscriber' : 'free_user';
}

/**
 * Guard for the paywall CTA. A guest cannot purchase in Phase 1a — we do
 * not have an anonymous entitlement model, and letting a guest tap
 * "purchase" would either (a) fail at the provider with a confusing error
 * or (b) create an entitlement bound to nothing.
 *
 * Returns the reason so the UI can render appropriate copy (e.g., "Sign in
 * to subscribe") instead of hiding the affordance silently.
 */
export type PurchaseGateReason =
  | 'ok'
  | 'guest_must_sign_in'
  | 'premium_disabled_by_release'
  | 'subscription_disabled_by_config'
  | 'already_entitled';

export function checkPurchaseGate(inputs: ResolveRoleInputs): PurchaseGateReason {
  const { signedInUserId, snapshot, config, premiumEnabled } = inputs;
  if (!signedInUserId) return 'guest_must_sign_in';
  if (!premiumEnabled) return 'premium_disabled_by_release';
  if (!config.enabled) return 'subscription_disabled_by_config';
  if (snapshot && isEntitled(snapshot.state)) return 'already_entitled';
  return 'ok';
}
