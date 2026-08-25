# DIC-1149 — Subscription Domain Foundation (Phase 1a)

Parent: DIC-1148. Priority: P0. This is the provider-neutral engineering
foundation for the eventual paid subscription. It ships **no** provider
integration, **no** product IDs, **no** keys/secrets, and **no** account
or store action. It also does not — on its own — change what any user
sees today.

## Scope

Delivered in one focused PR:

1. **Domain types + state machine** — `src/subscription/types.ts`,
   `src/subscription/stateMachine.ts`. Eight explicit entitlement states
   (`free`, `active`, `grace`, `billing_issue`, `cancelled_until_expiry`,
   `expired`, `refunded_revoked`, `unknown`). The reducer is a pure
   function; any event it cannot classify collapses the snapshot to
   `unknown` (fail-closed).
2. **Provider adapter interfaces** — `src/subscription/providers/types.ts`.
   Concrete providers (RevenueCat, Stripe, App Store Server API, Play
   Billing, …) implement `SubscriptionProviderAdapter`. Phase 1a ships
   an empty registry; wiring a real provider is a follow-up.
3. **Fail-closed config schema** — `src/subscription/config.ts`. Env vars
   are named as constants; a pure resolver decides `enabled: true |
   false`. Any unset / whitespace / malformed / unknown value returns
   `enabled: false`, matching the existing `EXPO_PUBLIC_STORE_MVP`
   convention in `src/config/releaseFlags.ts`.
4. **App User ID contract** — `src/subscription/appUserId.ts`. The App
   User ID is the injected backend user UUID (`HoloUser.internalId`),
   branded so adapters cannot accept an email / OAuth sub / device id
   by mistake. See §"Why the backend UUID" below.
5. **Entitlement resolver** — `src/subscription/entitlementResolver.ts`.
   Bridges the neutral snapshot down to the existing `UserRole` enum
   (`guest` / `free_user` / `subscriber`). Every unresolved case
   collapses to `free_user` so `permissionService` and `scanQuotaStore`
   observe exactly the behaviour they do today.
6. **Mutation-sensitive unit tests** — `scripts/test-subscription-domain.mjs`,
   42 checks. Wired into CI as `test:subscription-domain`.

Explicitly out of scope (owner-controlled, parent-blocked): RevenueCat /
Stripe / App Store / Play Console / Vercel / OpenRouter / production
payment / secret / credential / legal consent / owner-account actions.

## Preservation contracts

The pre-existing surface must not shift. Verified by the test suite and
by the resolver's fallback rules:

- **Store MVP Production stays `free_user`.** `STORE_MVP=1` sets
  `FEATURES.premium = false`; the resolver's rule #2 (`premiumEnabled
  === false → free_user`) short-circuits before it inspects any
  snapshot. Store MVP builds also never configure the three
  `EXPO_PUBLIC_SUBSCRIPTION_*` env vars, so rule #3 short-circuits too.
- **Existing scan limits (100/month for `free_user`, 0 for `guest`)
  are untouched.** `src/services/permissionService.ts` and
  `src/store/scanQuotaStore.ts` are unchanged; they still read `UserRole`
  from the auth store, and the resolver produces the same three roles.
- **`effectiveRole()` (CR DIC-913 #2) still governs the permission
  layer.** The new resolver is upstream of it — a snapshot-produced
  `subscriber` still gets collapsed by `effectiveRole` when
  `FEATURES.premium` is false.
- **Auth / permission contracts are untouched.** No changes to
  `src/types/auth.ts`, `src/store/authStore.ts`, or
  `api/_lib/identity-store.ts`.

## Fail-closed contract

The rule everywhere: **absent / malformed / ambiguous → deny**.

- `resolveSubscriptionConfig` returns `enabled: false` on unset,
  whitespace-only, unknown env value, malformed provider tag, or missing
  public key. The first failing check wins so the diagnostic `reason`
  is deterministic.
- `reduce` drops duplicate / out-of-order provider events (`revision`
  guard), rejects cross-provider events (`providerTag` guard), and
  collapses to `unknown` for any unlisted transition. `unknown` is
  never entitled.
- `resolveRoleFromSnapshot` returns `free_user` for every unresolved
  branch (no user, no config, no snapshot, unknown snapshot,
  cross-provider snapshot, non-entitled state).
- `checkPurchaseGate` blocks guests (`guest_must_sign_in`) so a paywall
  CTA cannot fire against no user.

## Why the backend UUID (irreversible choice — worth explicit review)

`HoloUser.internalId` is the App User ID. Rejected alternatives, with
reasons:

| Candidate            | Why not                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| Email                | Mutable; a change orphans the provider's stored entitlement.                                                   |
| Apple OAuth sub      | Unique per (bundle-id, user); the app spans a web bundle and a native bundle, so one human has two subs.       |
| Google OAuth token   | Access tokens rotate; id-token `sub` is stable per project but the app already uses multiple Google projects.  |
| Device id            | A paid entitlement must survive a factory reset and follow the user across devices.                            |
| Ephemeral session id | Restart loses the entitlement.                                                                                 |

`HoloUser.internalId` already spans every login surface, survives an
email change, and survives an OAuth-provider swap. It is injected via
`AppUserIdentityResolver` so tests and future backends can swap it
without editing `appUserId.ts`.

## No client-only escalation

`PurchaseOutcome.succeeded` is a client-side signal only. The reducer
has NO input shape that accepts it — the only way to change state is
via a `ProviderEvent` produced by an adapter that has verified with
the server (per the interface contract). The corresponding regression
test in `scripts/test-subscription-domain.mjs` guards this: passing
anything that is not a `ProviderEvent` cannot produce an entitled
snapshot.

Restore is handled the same way. `SubscriptionProviderAdapter.restore`
returns a list of verified events; a failure rejects loudly. A failed
restore does not fabricate a snapshot — the test suite covers this.

## Environment variables (names only)

Values live in Vercel / EAS project config, never in this repo.

| Name                                    | Purpose                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------- |
| `EXPO_PUBLIC_SUBSCRIPTION_PROVIDER`     | Provider tag (lowercase snake/dash); one provider per build.                |
| `EXPO_PUBLIC_SUBSCRIPTION_ENV`          | `"sandbox"` or `"production"`. Anything else disables the layer.            |
| `EXPO_PUBLIC_SUBSCRIPTION_PUBLIC_KEY`   | Adapter-SDK bootstrap identifier (public). Never a secret.                  |

All three must be present and well-formed before the subscription layer
is `enabled`. Unset in Store MVP Production, by design.

Provider secrets (webhook signing keys, server API keys, App Store /
Play server keys) are **backend-only** and must NOT use the
`EXPO_PUBLIC_*` prefix — Expo inlines those into the bundle. A concrete
adapter that needs a server-side secret will introduce its own
non-`EXPO_PUBLIC_*` env vars in a later phase.

## Rollback

The feature is inert on this PR: no product IDs, no adapter, no provider
call is made from any code path today. Rollback options, from least to
most invasive:

1. **Config revert (zero-code).** Unset `EXPO_PUBLIC_SUBSCRIPTION_*` in
   Vercel / EAS. `resolveSubscriptionConfig` returns `enabled: false`;
   the entitlement resolver collapses everyone to `free_user` (or
   `guest` for signed-out). This is already the default state — no
   deploy required.
2. **Release-flag revert.** Toggle `EXPO_PUBLIC_STORE_MVP=1` (already
   the store-build default). `FEATURES.premium` becomes `false`; the
   resolver's rule #2 short-circuits.
3. **Code revert.** `git revert` this PR. Nothing outside
   `src/subscription/**`, `scripts/test-subscription-domain.mjs`, three
   lines in `package.json`, one CI step, and one `.env.example` block
   changes. No shared file is modified in a way that would leave a
   loose end after revert.

There is no data migration to reverse; the subscription layer stores
nothing in this phase.

## What Phase 1b+ adds (not in this PR)

- A concrete `SubscriptionProviderAdapter` implementation (e.g.,
  RevenueCat) with its own env-var block and installation instructions.
- A `useSubscription()` hook that owns the current snapshot (fetch +
  cache + refresh) and calls the reducer on new events.
- Server-authoritative entitlement fetch endpoint under `/api/`.
- Paywall UI + copy.
- Wiring `resolveRoleFromSnapshot` output into `useAuthStore.role` so
  `subscriber` is observable end-to-end.
