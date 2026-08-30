# Data safety — source inventory and answers

Scope: the **Android native release binary** only. Play's Data safety form asks about
the app users install, not the website. Where web and native differ, the native
behaviour is what is recorded here.

Play's definition of "collected" is **data transmitted off the device**. A manifest
permission is not collection; on-device processing is not collection.

Every row below is derived from code, with the file and line that proves it. Nothing
here is inferred from a previous document.

---

## Correction to the previous inventory

`docs/release-testflight-google-play-closed-testing.md` stated that the native binary
performs local OCR only and never uploads card images, and that the app has no account
mechanism. **Both statements are false in current code.** The Data safety form must not
be filled from that document. The specific corrections are listed at the end of this file.

---

## 1. Off-device data flows in the Android binary

| # | Data | Trigger | Destination | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Card image (base64 JPEG) — camera capture or gallery pick | Every scan | `POST /api/recognize-card` → forwarded to `generativelanguage.googleapis.com` (Google Gemini `gemini-2.5-flash`) | `src/services/cardRecognition.ts:372-386`, `:466-475`; `api/recognize-card.ts:320` |
| 2 | Google ID token (contains email, display name, avatar URL, Google subject ID) | Sign-in with Google | `POST /api/auth/login` → identity record written to Vercel KV | `src/services/authService.ts:379-418`, `:822-826`; `api/_lib/identity-store.ts:44-53` |
| 3 | Expo push token + platform | App launch on native | `POST /api/push/register` → Vercel KV hash `push:tokens` | `src/services/pushNotificationService.ts:40-84`; `api/_lib/kv-storage.ts:32-39` |
| 4 | Price-alert definitions (card number, printing, thresholds, currency) | User creates or removes a price alert | `POST /api/push/price-alerts` | `src/services/priceAlertSync.ts:18` |
| 5 | Account sync payload (favorites, decks, collection, price alerts, settings) | While signed in | `POST /api/auth/[action=sync]` → Vercel KV | `api/_lib/account-sync-store.ts` |
| 6 | Session token | Session validation | `POST /api/auth/me` | `src/services/authService.ts:1025` |

Read-only fetches (`/data/database.json`, card images, tournament data) send no user data
and are not collection.

## 2. What the app does NOT do

Verified absent from `package.json` and from all imports: no analytics SDK, no crash
reporting SDK, no advertising SDK, no Firebase Analytics, no tracking library. The
`AdSlot` component exists but is hard-disabled (`src/components/AdSlot.tsx:11`,
`PRODUCTION_ADS_ENABLED = false`).

No payment integration of any kind: no Stripe, no RevenueCat, no `react-native-iap`, no
`expo-in-app-purchases`. The `subscriber` role exists in the data model
(`api/_lib/identity-store.ts:48`) but there is no code path that grants it. **No purchase
or financial data is collected**, and there is no external payment flow that Google Play
Billing policy could object to. `scripts/test-privacy-disclosure.mjs` fails the build if a
billing dependency is added without re-answering this form.

No location, contacts, SMS, call log, health, or audio data. `RECORD_AUDIO` is blocked at
the manifest level.

## 3. Answers

### Photos and videos → Photos

| Field | Answer | Reason |
| --- | --- | --- |
| Collected | **Yes** | The image is transmitted off-device on every scan (flow 1). This holds for gallery picks as well as camera captures. |
| Shared | **See the decision below** | The image is forwarded to Google's Generative Language API. |
| Processed ephemerally | **Our backend: yes.** Google: owner must confirm. | `api/recognize-card.ts` contains no persistence — no KV write, no filesystem write, no blob storage. The image exists only in the request and is forwarded. |
| Required or optional | Optional | Scanning is one feature; search and browsing work without it. |
| Purpose | App functionality | Identifying the card in the photo. Nothing else. |

> **Owner decision required — the Gemini API tier.** Play's service-provider exception lets
> you answer "not shared" when a third party only processes data on your behalf and is
> contractually barred from using it for its own purposes. Google's paid Gemini API tier
> does not use submitted content to improve its models; the free tier does. **If the
> project's `GEMINI_API_KEY` is on the free tier, the service-provider exception does not
> hold** and Photos must be declared as shared with a third party. Confirm the billing
> status of the key before answering. When in doubt, answer **Shared = Yes** and name the
> recipient as "Google Gemini API, for card recognition" — over-declaring is survivable,
> under-declaring is an enforcement action.

### Personal info → Name, Email address, User IDs

| Field | Answer | Reason |
| --- | --- | --- |
| Collected | **Yes** | Google ID token contents are persisted server-side: `displayName`, `primaryEmail`, `photoUrl`, provider subject ID and an internal user ID (`api/_lib/identity-store.ts:44-53`, `:617-627`). |
| Shared | No | Stored in the developer's own Vercel KV. No onward transfer. |
| Processed ephemerally | No | Persisted until the account is deleted. |
| Required or optional | **Optional** | Guest mode exists (`src/screens/LoginScreen.tsx:95-102`). Browsing and search need no account; scanning does. |
| Purpose | App functionality, Account management | Sign-in and cross-device sync. |

### Device or other IDs

| Field | Answer | Reason |
| --- | --- | --- |
| Collected | **Yes** | Expo push token, a persistent device identifier, is uploaded at launch and stored (flow 3). |
| Shared | **Yes** | Delivery goes through Expo Push Service (`exp.host`). Declare the recipient unless the owner can point to a service-provider agreement with Expo. |
| Processed ephemerally | No | Stored indefinitely in KV. |
| Required or optional | Optional | Only registered if notification permission is granted. |
| Purpose | App functionality | Watchlist price-alert delivery. |

### App activity → Other user-generated content

| Field | Answer | Reason |
| --- | --- | --- |
| Collected | **Yes** | Favorites, decks, collection counts, price alerts and settings sync server-side while signed in (flows 4 and 5). |
| Shared | No | Developer's own backend. |
| Required or optional | Optional | Only while signed in. |
| Purpose | App functionality | Cross-device sync. |

### Everything else

Location, Financial info, Health and fitness, Messages, Contacts, Calendar, Audio, Files
and docs, Web browsing history, Installed apps: **not collected**. See section 2.

## 4. Security and deletion declarations

| Question | Answer | Basis |
| --- | --- | --- |
| Is all data encrypted in transit? | **Yes** | Every endpoint is HTTPS. |
| Do you provide a way for users to request that their data be deleted? | **Yes** | In-app: Settings → Delete Account calls `POST /api/auth/delete-account`, which cascade-deletes the user record, every linked identity, its indexes, and the account-sync snapshot (`api/auth/delete-account.ts:35-74`; `api/_lib/identity-store.ts:852-870`; `api/_lib/account-sync-store.ts:552-557`). The client only clears the local session when the server returns `deleted: true` (`src/services/authService.ts:1012-1018`). |
| Data deletion URL / contact | `dicoge.chen@gmail.com` | Needed for the two cases the in-app flow does not cover. |

> **Two known gaps in deletion — declare them, do not paper over them.**
>
> 1. **The push token is not deleted by account deletion**, and there is no unregister
>    endpoint. Uninstalling does not remove it either. The privacy policy now says so
>    explicitly and gives the email channel. `scripts/test-privacy-disclosure.mjs` fails
>    if an unregister endpoint appears without the policy and this form being updated.
> 2. **Apple-linked accounts cannot self-delete.** `api/auth/delete-account.ts:50-58`
>    returns HTTP 501 when an Apple identity has no stored refresh token, deliberately
>    fail-closed. Apple sign-in is disabled by default on Android
>    (`src/services/authStrategy.ts:37-46`), so this does not affect the Android
>    submission — but it must not be turned on for Android before the deletion path
>    works, or the "users can request deletion" answer becomes false.

## 5. Prominent disclosure

Play requires prominent in-app disclosure before collecting sensitive data where the use
is not obvious from context. Sending the photo to a third-party cloud AI service is not
obvious from a button labelled "scan".

- The privacy policy at `https://holohunter.dicoge.com/privacy` now states plainly that
  the image is uploaded on mobile as well as web, names `/api/recognize-card` and Google
  Gemini, says the server does not retain the image, and describes on-device OCR as a
  fallback rather than the default (`public/privacy.html`, sections 3 and 6, both
  languages).
- The scan screen shows `🤖 AI 辨識中…` during recognition
  (`src/services/scanRecognitionFlow.ts:130`), which hints at cloud processing but is not
  a disclosure.

**Recommended before Production rollout, not blocking for Closed Testing:** a one-time
consent sheet on first use of the scan feature stating that the photo is sent to Google
Gemini for recognition, with a link to the policy. Filed as a follow-up rather than done
here because it changes a user-facing flow and belongs in its own reviewed change.

## 6. Corrections to `docs/release-testflight-google-play-closed-testing.md`

| Claim in that document | Reality |
| --- | --- |
| "native binary 完全不傳送影像 off-device"; "native 用本機 OCR，不上傳影像" | False. `recognizeCardFromImage` uploads to `/api/recognize-card` as step 0 on every platform; local OCR is the fallback (`src/services/cardRecognition.ts:466-475`). |
| "無帳號機制" / "無帳號" | False. Google Sign-In, a cloud identity store, account linking, deletion and cross-device sync are all live. |
| Push tokens written to `data/push-tokens.json` in the GitHub repo | Stale. They are in Vercel KV under `push:tokens` (`api/_lib/kv-storage.ts:32-39`). |
| "App access：若不需要登入選全部功能免登入" | Wrong for this app. Scanning requires an account (`src/services/permissionService.ts:17`), so reviewer instructions and credentials are required. |

That document has been left in place as the general release runbook; a pointer to this
directory has been added to its permission and privacy sections so the stale answers
cannot be used by accident.
