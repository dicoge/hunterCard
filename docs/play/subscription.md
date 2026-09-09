# Subscription — monthly only for initial review

Owner decision, 2026-08-30: the Google Play launch product is a **monthly subscription
only**. No annual product for the initial review. Prepare one monthly base plan. Price and
trial are still awaiting owner confirmation.

This file records what that means in Play Console, and — more importantly — what has to be
true in the app before that product can go to review at all.

## Read this before creating anything in Console

**The shipping Android build cannot sell anything today, and that is fine — the first
Closed Test ships free.** Owner sequencing decision (2026-08-30): the initial Play review
AAB does not wait on billing. Creating the subscription in Play Console is harmless and can
be done now, but it is prepared for a **later** release, not part of the initial submission.
Four separate things currently keep the store build free:

| # | Blocker | Evidence |
| --- | --- | --- |
| 1 | No billing library at all — no `react-native-iap`, no `expo-in-app-purchases`, nothing | `package.json` |
| 2 | Premium is compiled out of store builds. `eas.json` sets `EXPO_PUBLIC_STORE_MVP=1` on both `preview` and `production`, and `FEATURES.premium = !STORE_MVP` | `src/config/releaseFlags.ts:53-54`, `eas.json` |
| 3 | The `subscriber` role is deliberately collapsed to `free_user` while premium is off, so even a granted entitlement would do nothing | `src/services/permissionService.ts:10-13` |
| 4 | The only upgrade affordance is a no-op stub, and it is behind the same disabled flag | `src/screens/ScanScreen.tsx:453-460` — the `scan_upgrade` button's `onPress` is `() => {}` |

So the honest position is: **a monthly base plan can be prepared, but the app cannot be
submitted as a subscription app in the same review as the current binary.** Answering "yes"
to App content's purchase questions against this build would be a declaration that does not
match the artifact — the same class of mismatch that made the privacy policy a blocker.

`public/pricing.html` is already explicit that it is an engineering draft: line 217 says
prices must not be hardcoded before owner sign-off, and the plan cards show `NT$ 0` and
"Sandbox". Nothing there is a live checkout, so there is no Play Billing steering problem
today.

## Sequencing — decided 2026-08-30

The owner has ruled that app review and Closed Testing proceed **independently of
monetization**. The initial Play review AAB is free with **no paid UI**, and does not wait
on RevenueCat, subscription products, merchant approval, or the final monthly price. The UI
slim-down that makes that true is tracked in DIC-1256.

Nothing in this file blocks the submission. The monthly product is prepared on its own
timeline and lands in a later release, at which point everything under "What must be
re-answered" applies. Note the owner named **RevenueCat** as the intended billing layer;
whatever wrapper is used, the purchase itself must still go through Google Play Billing on
Android.

## Play Console object model for a monthly-only launch

Play's current model is three levels. Getting the vocabulary right matters because "product"
and "plan" are not interchangeable in the Console UI:

- **Subscription** — the sellable item, owns the product ID. One of these.
- **Base plan** — the billing terms. One auto-renewing base plan, billing period **P1M**.
- **Offer** — optional, attaches to a base plan. A free trial is an offer, not a base plan.

Monthly-only therefore means: one subscription, one base plan, and at most one offer.

| Field | Value | Status |
| --- | --- | --- |
| Subscription product ID | `holohunter_pro` (proposed) | Needs owner sign-off — **immutable once created** |
| Subscription name | HoloHunter Pro | Proposed |
| Base plan ID | `monthly` (proposed) | Needs sign-off — also immutable |
| Base plan type | Auto-renewing | Decided |
| Billing period | Monthly (P1M) | Decided by the owner |
| Renewal type | Auto-renewing | Decided |
| Grace period | Play default | Owner |
| Account hold | Play default | Owner |
| **Price** | — | **Awaiting owner** |
| **Free trial** | — | **Awaiting owner** — if yes, create it as an *offer* on the monthly base plan |
| Tax category | Standard digital goods | Owner to confirm with tax setup |
| Countries / regions and per-region pricing | — | Owner |

> Product IDs and base plan IDs **cannot be renamed or reused after creation**. Do not create
> them to "reserve the name" before the owner confirms — a wrong ID is permanent, and the
> only fix is a second product with a worse name.

Deliberately **not** created: any annual, quarterly or lifetime base plan. Adding a second
base plan later does not require a new subscription, so nothing here forecloses an annual
plan after launch.

## What the app must do before this product can be reviewed

Not implemented here — this is a feature, and it needs its own issue and review. Listed so
the size of the decision is visible:

1. **Google Play Billing, not a web checkout.** Android digital subscriptions must use Play
   Billing. Linking users out to a web payment page for the same digital content violates
   the payments policy. `AdSlot.tsx:113-115` already contains a link to
   `pricing.html`, currently unreachable because `PRODUCTION_ADS_ENABLED = false` — that link
   must never become a purchase path on Android.
2. **A real purchase flow** replacing the `scan_upgrade` no-op stub, plus a restore-purchases
   path.
3. **Server-side purchase verification** against the Play Developer API, and entitlement
   granting that sets the `subscriber` role the identity store already models
   (`api/_lib/identity-store.ts:48`).
4. **Turning premium on for store builds**, which means changing `EXPO_PUBLIC_STORE_MVP` or
   splitting the flag so the paywall ships while other MVP strips stay in place.
5. **Subscription lifecycle**: renewals, cancellation, grace period, account hold, refunds
   and revocation via Play's real-time developer notifications.

## What must be re-answered when it ships

The current submission pack states, correctly and verifiably, that the app collects no
purchase data and has no billing. All of that becomes false on the day billing lands:

| Surface | Current answer | After billing |
| --- | --- | --- |
| Data safety → Financial info → Purchase history | Not collected | Almost certainly **collected** — depends on what the backend stores against the account |
| App content → Allows purchases | No | Yes |
| App content → Digital purchases | No | Yes |
| Content rating questionnaire | No purchases | Re-run — the answers change, so the IARC rating is reissued |
| Store listing | No IAP badge | "In-app purchases" badge appears automatically |
| Privacy policy | "no payment or subscription mechanism at all" (both languages) | Must describe what is stored, for how long, and what deletion covers |
| Account deletion | Cascade delete covers identity and sync data | Must state what happens to purchase records, which are often retained for tax and audit reasons even after account deletion |

`npm run test:privacy-disclosure` fails the build the moment a billing dependency appears in
`package.json`. That is deliberate: it is the tripwire that stops billing shipping while the
policy still tells users there is no payment mechanism. Its failure message points here.

## Still needed from the owner

1. Price, and per-region pricing if not using Play's automatic conversion.
2. Free trial: yes or no, and if yes the length.
3. Sign-off on the product ID `holohunter_pro` and base plan ID `monthly` — both permanent.
4. What the subscription actually unlocks, in user-facing words, for the listing and the
   paywall. All the code models today is an unlimited scan quota for `subscriber`
   (`permissionService.ts:23-27`, `scanQuota: -1` against a 100/month free limit) plus an
   unused `canViewPremium` flag (`:18`). Anything richer — the AI price and trend forecasts
   the marketing copy has mentioned — does not exist yet, and the listing must not promise a
   feature the build does not ship.
