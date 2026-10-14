# Data safety — source inventory and answers

Scope: the **Android native release binary** only. Play's Data safety form asks about the
app users install, not the website. Where web and native differ — and for card images they
differ completely — the native behaviour is what is recorded here.

Play's definition of "collected" is **data transmitted off the device**. A manifest
permission is not collection; on-device processing is not collection.

Every row below is derived from code, with the file and line that proves it.

---

## The card image question (re-derived 2026-10-14 — photos ARE uploaded)

**Owner decision 2026-10-14: "正式支援上傳照片給 AI 並同步隱私告知".** The previous answer
("no image leaves the device") was true only by accident: native posted the bare `file://`
path, the server wrapped it as `data:image/jpeg;base64,file:///...`, Gemini could not decode
it, and native AI recognition never worked. That defect is fixed, so the answer flips.

What the Android binary now sends, per scan, after the user accepted the in-app disclosure
(`src/services/photoUploadDisclosure.ts`, `ScanScreen.requestPhotoUploadConsent`):

- `takePictureAsync({ quality: 0.7, base64: true })` / `launchImageLibraryAsync({ base64: true })`
  return the photo bytes; `buildRecognitionDataUrl` types them from their signature bytes
  (JPEG / PNG / WebP only) and caps one image at 2.5 MB decoded
  (`src/services/recognitionImagePolicy.ts`). Nothing else is sent; the `file://` uri never is.
- `POST /api/recognize-card` (HTTPS) → the handler validates the same rules and answers 400
  before resolving a provider for anything else → forwards the image to Google Gemini
  (`generativelanguage.googleapis.com`, `gemini-2.5-flash`).
- Our server does not write the image anywhere and logs no image content.
- If the scan is cancelled, the client abort is forwarded to the Gemini fetch.

**What we cannot assert.** Google's handling depends on which Gemini API terms apply.
Per https://ai.google.dev/gemini-api/terms (effective 2026-03-23, read 2026-10-14):
Unpaid Services content may be used to improve Google products and may be human-reviewed;
Paid Services (Cloud project with an active billing account) carry the no-product-improvement
terms, with limited logging for safety/abuse. **The production project's billing tier has not
been verified**, so nothing in the app, policy or this form may promise that Google does not
retain or train on the photos.

---

## 1. Off-device data flows in the Android binary

| # | Data | Trigger | Destination | Evidence |
| --- | --- | --- | --- | --- |
| 1 | **Card photo** (JPEG/PNG/WebP bytes, ≤2.5 MB) | Every AI scan, only after the in-app disclosure was accepted | `POST /api/recognize-card` → Google Gemini | `src/services/cardRecognition.ts` (`recognitionPayload`), `api/recognize-card.ts`. See the section above. |
| 2 | Google ID token (email, display name, avatar URL, Google subject ID) | Sign-in with Google | `POST /api/auth/login` → identity record in Vercel KV | `src/services/authService.ts:379-418`, `:822-826`; `api/_lib/identity-store.ts:44-53` |
| 3 | ~~Expo push token + platform~~ — **does not happen in the review build** | Would be app launch, but `App.tsx:11` gates it on `FEATURES.pushAlerts` and `pushAlerts: !STORE_MVP`; the manifest also strips `POST_NOTIFICATIONS` for this profile (DIC-1259) so the runtime prompt is gone | — | `App.tsx:11`; `src/config/releaseFlags.ts:52`; `eas.json` sets `EXPO_PUBLIC_STORE_MVP=1` on both store profiles; `app.config.js` adds `POST_NOTIFICATIONS` to `blockedPermissions` under that flag |
| 4 | ~~Price-alert definitions~~ — **does not happen in the review build** | `watchlist: !STORE_MVP` removes the feature that creates them | — | `src/config/releaseFlags.ts:50` |
| 5 | Account sync payload (favorites, decks, collection, price alerts, settings) | While signed in | `POST /api/auth/[action=sync]` → Vercel KV | `api/_lib/account-sync-store.ts` |
| 6 | Session token | Session validation | `POST /api/auth/me` | `src/services/authService.ts:1025` |

Read-only fetches (`/data/database.json`, card images, tournament data) send no user data.

## 2. What the app does NOT do

No analytics SDK, no crash reporting SDK, no advertising SDK, no tracking library — absent
from `package.json` and from all imports. `AdSlot` exists but is hard-disabled
(`src/components/AdSlot.tsx:11`, `PRODUCTION_ADS_ENABLED = false`).

No payment integration: no Stripe, RevenueCat, `react-native-iap` or
`expo-in-app-purchases`. The `subscriber` role exists in the data model
(`api/_lib/identity-store.ts:48`) but no code grants it, and `effectiveRole()` collapses it
to `free_user` while premium is off (`src/services/permissionService.ts:10-13`). **No
purchase or financial data is collected**, and there is no external payment flow for Google
Play Billing policy to object to.

No location, contacts, SMS, call log, health or audio data. `RECORD_AUDIO` is blocked at
the manifest level.

> **A monthly subscription is planned** (owner decision 2026-08-30 —
> [`subscription.md`](./subscription.md)). It changes this section the day it ships: Financial
> info → Purchase history very likely becomes collected, and the deletion answers need a line
> on what happens to purchase records, which are commonly retained for tax and audit purposes
> even after an account is deleted. Until the binary can complete a purchase, the answers
> above stay as written. `npm run test:privacy-disclosure` fails the build if a billing
> dependency is added without this being revisited.

## 3. Answers

### Photos and videos → Photos

| Field | Answer |
| --- | --- |
| Collected | **Yes** |
| Shared | **OWNER DECISION** — Google Gemini receives the photo. Play's service-provider exception applies only if Google processes it on our behalf under terms that fit that exception; under Unpaid Gemini API terms Google may use content to improve its products, which likely makes it "shared". Verify the billing tier / terms in force, then answer. |
| Processed ephemerally | **OWNER DECISION** — our server keeps nothing beyond the request, but "ephemeral" covers the whole processing, including Google's retention under the applicable terms. Do not tick it unless the owner has confirmed Google-side retention fits Play's definition. |
| Required or optional | **Optional** — scanning is optional and declining the disclosure uploads nothing; manual search works without it. |
| Purpose | App functionality (card recognition). Not advertising, analytics or personalisation. |

Justification: see "The card image question" above. Camera captures are also written to the
app's private cache directory by `takePictureAsync` and are not cleared by the app; on-device
storage alone is not collection, but the upload is.

These owner answers are **not** self-certified by the development change and the Play
Console form has **not** been edited.

### Personal info → Name, Email address, User IDs

| Field | Answer | Reason |
| --- | --- | --- |
| Collected | **Yes** | Google ID token contents are persisted server-side: `displayName`, `primaryEmail`, `photoUrl`, provider subject ID and an internal user ID (`api/_lib/identity-store.ts:44-53`, `:617-627`). |
| Shared | No | Stored in the developer's own Vercel KV; no onward transfer. |
| Processed ephemerally | No | Persisted until the account is deleted. |
| Required or optional | **Optional** | Guest mode exists (`src/screens/LoginScreen.tsx:95-102`); browsing and search need no account, scanning does. |
| Purpose | App functionality, Account management | Sign-in and cross-device sync. |

### Device or other IDs

| Field | Answer |
| --- | --- |
| Collected | **No — for the Play review build** |

**Corrected 2026-08-30, reinforced by DIC-1259.** An earlier revision of this file declared
the Expo push token as collected. That is true of a full build and **false of the artifact
being submitted**. Two independent gates keep it false:

1. **Code compiled out.** `App.tsx:11` gates `initPushNotifications()` on
   `FEATURES.pushAlerts`, and `pushAlerts: !STORE_MVP` (`src/config/releaseFlags.ts:52`).
   Both the `production` and `production-apk` profiles set `EXPO_PUBLIC_STORE_MVP=1`
   (`eas.json`), so in the submitted build the token is never requested, never uploaded,
   and `/api/push/register` is never called. `watchlist: !STORE_MVP` likewise means
   `/api/push/price-alerts` never fires.
2. **Permission stripped at the manifest layer.** `app.config.js` adds
   `POST_NOTIFICATIONS` to `expo.android.blockedPermissions` when
   `EXPO_PUBLIC_STORE_MVP=1`, so Gradle emits `tools:node="remove"` and the merged
   manifest for the submitted artifact does not request it. The Play listing therefore
   does not show a runtime prompt for a code path that cannot fire, and this Device IDs
   answer stays consistent with what the shipping APK actually declares.

Over-declaring is a mismatch in the same way under-declaring is, so answer No — and re-check
this line if `EXPO_PUBLIC_STORE_MVP` is ever changed for a store profile, because the answer
flips with that one variable.

> If a later release turns push alerts on, this becomes: Collected = Yes, Shared = Yes
> (delivery via Expo Push Service at `exp.host`), not ephemeral, purpose App functionality —
> and the deletion gap applies, since there is no unregister endpoint.

### App activity → Other user-generated content

| Field | Answer | Reason |
| --- | --- | --- |
| Collected | **Yes** | Account sync writes user content server-side while signed in (flow 5). |
| Shared | No | Developer's own backend. |
| Required or optional | Optional | Only while signed in. |
| Purpose | App functionality | Cross-device sync. |

> **The field list shrinks with DIC-1256 and must be re-derived, not assumed.** Price alerts
> are already out of the review build (`watchlist: !STORE_MVP`). DIC-1256 removes favorites
> and the collection UI from the store build as well, which should leave decks and settings.
> Confirm what the slimmed build actually syncs before answering — the honest answer is
> whichever fields still reach `/api/auth/[action=sync]`, not whichever fields the store
> exists to hold.

### Everything else

Location, Financial info, Health and fitness, Messages, Contacts, Calendar, Audio, Files
and docs, Web browsing history, Installed apps: **not collected**. See section 2.

## 4. Security and deletion declarations

| Question | Answer | Basis |
| --- | --- | --- |
| Is all data encrypted in transit? | **Yes** | Every endpoint is HTTPS. |
| Do you provide a way for users to request that their data be deleted? | **Yes** | Settings → 刪除帳號 calls `POST /api/auth/delete-account`, which cascade-deletes the user record, every linked identity, its indexes, and the account-sync snapshot (`api/auth/delete-account.ts:35-74`; `api/_lib/identity-store.ts:852-870`; `api/_lib/account-sync-store.ts:552-557`). The client clears the local session only when the server returns `deleted: true` (`src/services/authService.ts:1012-1018`), and the UI is wired to it through `src/store/authStore.ts:235-242` from `src/screens/SettingsScreen.tsx:105`. |
| Data deletion contact | `dicoge.chen@gmail.com` | For the two cases the in-app flow does not cover. |

> **Two known gaps in deletion — declare them, do not paper over them.**
>
> 1. **The push token is not deleted by account deletion**, and there is no unregister
>    endpoint. Uninstalling does not remove it either. The privacy policy says so
>    explicitly and gives the email channel.
> 2. **Apple-linked accounts cannot self-delete.** `api/auth/delete-account.ts:50-58`
>    returns HTTP 501 when an Apple identity has no stored refresh token, deliberately
>    fail-closed. Apple sign-in is disabled by default on Android
>    (`src/services/authStrategy.ts:37-46`), so this does not affect the Android
>    submission — but it must not be enabled for Android before the deletion path works.

## 5. Prominent disclosure

**Required and implemented (2026-10-14).** Before the first upload the app shows a system
dialog (`scan_ai_disclosure_*` in `src/i18n/locales/{zh,ja}.ts`): photo → HoloHunter server →
Google Gemini; used only for that recognition; our server keeps nothing; Google handles it
under its own terms and we cannot promise on its behalf; account deletion does not cover
Google-side processing. Upload happens only after an explicit "同意並上傳"; declining
uploads nothing. Bumping `PHOTO_UPLOAD_DISCLOSURE_VERSION` re-asks every device. The public
privacy policy says the same (`public/privacy.html`, section 3, zh + en) — it must be
**deployed** before the uploading build is submitted (release gate, not done by this change).

## 6. Corrections to `docs/release-testflight-google-play-closed-testing.md`

That document's conclusion about images was right; several of its other claims are not.

| Claim in that document | Reality |
| --- | --- |
| "native binary 完全不傳送影像 off-device" | **No longer true since 2026-10-14** — native uploads the photo after consent (see above). |
| "無帳號機制" / "無帳號" | **False.** Google Sign-In, a cloud identity store, account linking, deletion and cross-device sync are all live. |
| Push tokens written to `data/push-tokens.json` in the GitHub repo | **Stale.** They are in Vercel KV under `push:tokens` (`api/_lib/kv-storage.ts:32-39`). |
| "App access：若不需要登入選全部功能免登入" | **Wrong for this app.** Scanning requires an account (`src/services/permissionService.ts:17`), so reviewer instructions and credentials are required. |
| Watchlist is local-only and nothing syncs server-side | **Stale.** Price alerts sync via `/api/push/price-alerts`, and account sync stores favorites, decks, collection and settings server-side while signed in. |
