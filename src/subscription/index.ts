// Public surface of the subscription foundation (DIC-1149 Phase 1a).
//
// Import from `../subscription` (this barrel) so future refactors of the
// internal file layout do not break consumers.

export type {
  EntitlementState,
  ProviderEvent,
  PurchaseContext,
  PurchaseOutcome,
  PurchaseFailureReason,
  SubscriptionSnapshot,
} from './types';
export {
  isEntitled,
  ENTITLED_STATES,
  DEFAULT_FREE_SNAPSHOT,
  UNKNOWN_SNAPSHOT,
} from './types';

export { reduce, fold } from './stateMachine';
export type { ReduceResult, TransitionRejection } from './stateMachine';

export type {
  AppUserIdentity,
  SubscriptionProviderAdapter,
  SubscriptionProviderRegistry,
} from './providers/types';
export { EMPTY_PROVIDER_REGISTRY } from './providers/types';

export {
  brandAppUserId,
  resolveAppUserId,
  tryResolveAppUserId,
  AppUserIdResolutionError,
} from './appUserId';
export type { AppUserIdentityResolver, AppUserIdError } from './appUserId';

export {
  SUBSCRIPTION_ENV,
  resolveSubscriptionConfig,
  resolveSubscriptionConfigFromProcess,
} from './config';
export type {
  SubscriptionConfig,
  SubscriptionConfigResolved,
  SubscriptionConfigDisabled,
  SubscriptionProviderEnv,
} from './config';

export {
  resolveRoleFromSnapshot,
  checkPurchaseGate,
} from './entitlementResolver';
export type { ResolveRoleInputs, PurchaseGateReason } from './entitlementResolver';
