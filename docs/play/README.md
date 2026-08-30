# Google Play submission pack

Everything needed to put `com.dicoge.holohunter` in front of Google Play review, derived
from the current code rather than from earlier documentation.

| Document | Covers |
| --- | --- |
| [`permissions.md`](./permissions.md) | Release manifest audit, dependency attribution, what was removed and why |
| [`data-safety.md`](./data-safety.md) | Data safety source inventory and answers |
| [`app-content.md`](./app-content.md) | App content declarations, reviewer instructions, content rating, target audience |
| [`store-listing.md`](./store-listing.md) | Listing copy and graphics |
| [`testing-plan.md`](./testing-plan.md) | Internal QA and the Closed Test 12-tester / 14-day requirement |
| [`subscription.md`](./subscription.md) | Monthly-only launch product: Console setup, why it cannot ship with this binary, what must be re-answered |
| [`submit-checklist.md`](./submit-checklist.md) | Step-by-step submission runbook |
| [`expected-release-permissions.txt`](./expected-release-permissions.txt) | Baseline the built artifact is verified against |
| [`store-listing/`](./store-listing/) | Icon, feature graphic, phone screenshots |

`docs/release-testflight-google-play-closed-testing.md` remains the general iOS + Android
release runbook. Its permission and privacy questionnaire sections are superseded by this
directory — see the corrections table at the end of `data-safety.md`.

## Read this first

**0. The push token is NOT collected by the review build.** An earlier revision of
`data-safety.md` declared the Expo push token as collected. `App.tsx:11` gates
`initPushNotifications()` on `FEATURES.pushAlerts`, which is `!STORE_MVP`, and both store
profiles set `EXPO_PUBLIC_STORE_MVP=1`. The token is never requested or uploaded in the
submitted artifact, and neither are price alerts. Corrected — over-declaring is a mismatch
too, and the answer flips on that one environment variable.

**1. Card images are not transmitted by the Android app — but only by accident.** Reading
the call graph says the opposite: `recognizeCardFromImage` posts `{ image }` to
`/api/recognize-card` on every platform, and the server forwards to Google Gemini. What
saves it is that `preprocessCardImage` is DOM-only code and React Native defines no global
`Image` or `document`, so on native it returns the original `file://` path and a path
string is what gets posted, not pixels. Recognition then fails over to on-device OCR.
Photos are correctly declared **not collected** — see the full derivation at the top of
`data-safety.md`. Because the behaviour is incidental rather than designed, adding a native
image preprocessor or `base64: true` would start uploading real photos silently;
`npm run test:privacy-disclosure` fails on exactly those changes and is wired into CI.

**2. Build 6 requested three permissions nothing uses.** `SYSTEM_ALERT_WINDOW` (from React
Native's debug-only manifest), `READ_EXTERNAL_STORAGE` and `WRITE_EXTERNAL_STORAGE` are now
blocked in `app.base.json`. Details and evidence in `permissions.md`.

**3. The privacy policy described a system that no longer exists.** It presented the whole
account system as a "local mock" with no cloud data and nothing to delete, and claimed to
store subscription transaction identifiers. In reality Google Sign-In writes a real cloud
identity record, `POST /api/auth/delete-account` performs a real cascade delete, and there
is no billing integration of any kind. Those sections are corrected in both languages.

## Blocked

**The release AAB has not been built.** The issue requires it to come from `main` after
DIC-1245 merges, so that the old `holocard-hunter.vercel.app` API origin that got build 6
rejected is gone. PR #162 is still open. Once it merges, follow part B of
`submit-checklist.md`; remote versionCode is 6, so `autoIncrement` produces 7.

**Nothing has been submitted to Play.** No Play Console access, owner credentials, verified
developer identity, or service account key were available. The first submission must be
manual in any case.

## Owner-only inputs

Collected here so they are asked for once. **Do not send secrets through chat or a ticket
comment** — put credentials and keys straight into Play Console or an EAS secret.

### Blocking — the submission cannot proceed without these

| # | Input | Needed for |
| --- | --- | --- |
| 1 | Play Console account **type** (Personal / Organisation) and **creation date** | Decides whether the 12-tester / 14-day closed-test requirement applies (`testing-plan.md`) |
| 2 | Identity verification (and organisation verification if applicable) complete | Play blocks publishing until it clears |
| 3 | Public developer name, contact email, website, physical address | Store listing and account settings |
| 4 | A dedicated **Google test account** for reviewers, with 2-Step Verification disabled and signed in once on a real device | App access — scanning is gated behind sign-in, so review fails without it |
| 5 | **12+ Gmail addresses or a Google Group** for closed testing; recruit 14–15 to absorb dropouts | Closed test track |
| 6 | Countries and regions for distribution | Store listing |
| 7 | Play Console app record created with package `com.dicoge.holohunter` (irreversible) | Everything |

### Decisions needed before the Data safety form can be answered

| # | Question | Why it matters |
| --- | --- | --- |
| 8 | Confirm the Android app is the only thing being submitted, and that the **web** build's Gemini image upload is out of scope for this listing | Play asks about the installed binary. The web build does upload card images; the Android build does not. Keep the two straight when answering, and revisit if a WebView or PWA wrapper is ever shipped to Play. |
| 9 | Is there a service-provider agreement covering Expo Push Service? | Decides the "shared" answer for the push token. Absent one, declare it shared. |
| 10 | Ship screenshots containing hololive card artwork, or only the two without it? | IP takedown risk on a fan-made listing. See `store-listing.md`. |

### Subscription — decided 2026-08-30, see [`subscription.md`](./subscription.md)

The owner has chosen a **monthly subscription only** as the launch product, no annual plan
for the initial review, with price and trial still to be confirmed.

This does not change any answer in the pack yet, because **the shipping binary cannot sell
anything**: there is no billing library, `EXPO_PUBLIC_STORE_MVP=1` compiles premium out of
store builds, the `subscriber` role collapses to `free_user`, and the upgrade button is a
no-op stub. A Play Console product can be prepared now, but the app cannot be reviewed as a
subscription app until Play Billing is actually implemented.

**Sequencing resolved 2026-08-30:** review and Closed Testing proceed independently of
monetization. The initial AAB is free with no paid UI and does not wait on RevenueCat,
subscription products, merchant approval or the final price. The slim-down is DIC-1256.
`subscription.md` holds the Console field list, the permanent product IDs needing sign-off,
and everything to re-answer when billing eventually lands.

### DIC-1256 changes what this pack can claim

DIC-1256 removes favorites, price alerts and **all** market/price data from the store build.
That reaches further than the paid UI and invalidates parts of this pack:

- **Store listing copy is rewritten** — the old text sold reference prices, collection
  tracking and deck cost. See `store-listing.md`.
- **Three of the four screenshots are invalid** and must be recaptured from the slimmed
  build; only the home screen survives. Play needs a minimum of two.
- **Data safety Device IDs is now "not collected"** — see the correction below.
- **`POST_NOTIFICATIONS` has no feature behind it** in the review build; `permissions.md`
  recommends blocking it for store profiles.

### Not required until billing ships

Payments profile, tax and banking details, and contracts. Today the app has **no billing
integration at all** — no Stripe, no Play Billing, no IAP library — so no Google Play
Billing policy question arises yet. If
subscriptions are added later, Android digital subscriptions must go through Google Play
Billing and must not link out to web checkout, and Data safety, the privacy policy and the
content rating all have to be re-answered.

## Recommended follow-ups, deliberately not done here

Each changes user-facing behaviour or adds a public page, so each belongs in its own
reviewed change rather than being bundled into a submission-prep PR.

1. **Remove the doomed recognition round trip on native.** Every native scan posts a
   `file://` path string to `/api/recognize-card`, waits for it to fail, and only then runs
   on-device OCR. That is wasted latency on the device and a wasted Gemini call on the
   server. Making the platform split explicit would also turn today's accidental
   privacy-safe behaviour into an intentional one.
2. **A public data-deletion page** at `https://holohunter.dicoge.com/delete-account`. Play
   prefers a web URL over an email address for users who have uninstalled.
3. **A push-token unregister endpoint.** Today the token survives account deletion and
   uninstall, and can only be removed by emailing the developer. Implementing
   `/api/push/unregister` would let the deletion answer cover every data type.
4. **Apple account deletion.** `api/auth/delete-account.ts` returns HTTP 501 for Apple
   identities without a stored refresh token. Apple sign-in is off by default on Android so
   this does not affect the Play submission — but it must be fixed before Apple sign-in is
   enabled on Android.
