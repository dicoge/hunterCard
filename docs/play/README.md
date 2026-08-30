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
| [`submit-checklist.md`](./submit-checklist.md) | Step-by-step submission runbook |
| [`expected-release-permissions.txt`](./expected-release-permissions.txt) | Baseline the built artifact is verified against |
| [`store-listing/`](./store-listing/) | Icon, feature graphic, phone screenshots |

`docs/release-testflight-google-play-closed-testing.md` remains the general iOS + Android
release runbook. Its permission and privacy questionnaire sections are superseded by this
directory — see the corrections table at the end of `data-safety.md`.

## Read this first

Two findings change what can honestly be declared.

**1. The Android app uploads scan images off-device.** Every scan — camera capture or
gallery pick — posts the image to `/api/recognize-card`, which forwards it to Google's
Gemini vision API. On-device OCR is only the fallback when that call fails
(`src/services/cardRecognition.ts:466-475`, `api/recognize-card.ts:320`). The previous
submission document stated the opposite, and the published privacy policy told users their
card images never leave the device. Filling in Data safety from those sources would have
been a false declaration. The privacy policy has been corrected and
`npm run test:privacy-disclosure` now fails the build if the policy and the code disagree
again, in either direction.

**2. Build 6 requested three permissions nothing uses.** `SYSTEM_ALERT_WINDOW` (from React
Native's debug-only manifest), `READ_EXTERNAL_STORAGE` and `WRITE_EXTERNAL_STORAGE` are now
blocked in `app.base.json`. Details and evidence in `permissions.md`.

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
| 8 | Is the `GEMINI_API_KEY` on Google's **paid** Gemini API tier or the free tier? | The paid tier does not train on submitted content, which supports the service-provider exception and a "not shared" answer for Photos. The free tier does not, and Photos must then be declared as shared. See `data-safety.md` §3. |
| 9 | Is there a service-provider agreement covering Expo Push Service? | Decides the "shared" answer for the push token. Absent one, declare it shared. |
| 10 | Ship screenshots containing hololive card artwork, or only the two without it? | IP takedown risk on a fan-made listing. See `store-listing.md`. |

### Not required for this submission

Payments profile, tax and banking details, contracts, and final subscription product IDs,
prices, trial and refund policy. The app has **no billing integration at all** — no Stripe,
no Play Billing, no IAP library — so no Google Play Billing policy question arises. If
subscriptions are added later, Android digital subscriptions must go through Google Play
Billing and must not link out to web checkout, and Data safety, the privacy policy and the
content rating all have to be re-answered.

## Recommended follow-ups, deliberately not done here

Each changes user-facing behaviour or adds a public page, so each belongs in its own
reviewed change rather than being bundled into a submission-prep PR.

1. **First-run consent for the scan upload.** Play expects prominent disclosure before
   sending a photo to a third-party cloud service. The privacy policy now says it; a
   one-time in-app sheet on first scan would be the stronger position before Production.
2. **A public data-deletion page** at `https://holohunter.dicoge.com/delete-account`. Play
   prefers a web URL over an email address for users who have uninstalled.
3. **A push-token unregister endpoint.** Today the token survives account deletion and
   uninstall, and can only be removed by emailing the developer. Implementing
   `/api/push/unregister` would let the deletion answer cover every data type.
4. **Apple account deletion.** `api/auth/delete-account.ts` returns HTTP 501 for Apple
   identities without a stored refresh token. Apple sign-in is off by default on Android so
   this does not affect the Play submission — but it must be fixed before Apple sign-in is
   enabled on Android.
