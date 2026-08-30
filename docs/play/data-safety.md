# Data safety — source inventory and answers

Scope: the **Android native release binary** only. Play's Data safety form asks about the
app users install, not the website. Where web and native differ — and for card images they
differ completely — the native behaviour is what is recorded here.

Play's definition of "collected" is **data transmitted off the device**. A manifest
permission is not collection; on-device processing is not collection.

Every row below is derived from code, with the file and line that proves it.

---

## The card image question, answered properly

This is the single answer most likely to be got wrong, in either direction, so the whole
derivation is written out.

**Reading the call graph suggests every scan uploads a photo. It does not.**

`recognizeCardFromImage()` calls `recognizeViaApi()` as step 0 on every platform
(`src/services/cardRecognition.ts:466-475`), and `recognizeViaApi()` POSTs `{ image }` to
`/api/recognize-card` (`:372-386`), which forwards to Google Gemini
(`api/recognize-card.ts:320`). Taken at face value that means native uploads card photos.

What it actually sends depends on `preprocessCardImage()`
(`src/services/imagePreprocessor.ts:10`):

- The module is written entirely against the DOM — `new Image()`,
  `document.createElement('canvas')`, `canvas.toDataURL(...)`.
- React Native polyfills `fetch`, `Blob`, `File`, `FileReader`, `URL`, `FormData` and
  friends (`node_modules/react-native/Libraries/Core/setUpXHR.js`) but defines **no global
  `Image` and no `document`**. Expo's winter runtime adds `FormData`, `TextDecoder` and
  fetch, not `Image`.
- So on native `new Image()` throws inside the promise executor, the outer `catch` returns
  the **original uri unchanged** (`imagePreprocessor.ts:13-16`), and that uri is a
  `file:///...` path.
- Nothing upstream turns it into image data: `takePictureAsync({ quality: 0.8 })`
  (`src/screens/ScanScreen.tsx:559`) and `launchImageLibraryAsync({ quality: 0.8 })`
  (`:602`) are both called without `base64: true`.

So what leaves an Android device is a **local file path string**, not pixels. The server
wraps the unrecognised string as `data:image/jpeg;base64,file:///...`
(`api/recognize-card.ts:350`), Gemini cannot decode it, the call fails, and
`recognizeCardFromImage` falls through to the on-device OCR path (`expo-ocr-kit`).

**Conclusion: no card image content is transmitted off-device by the Android binary.**
Photos are therefore **not collected**. The web build genuinely does upload, because there
the DOM path works — but the web build is not what Play is asked about.

> **This is true by accident, not by design, and it is fragile.** Adding a native image
> preprocessor, a `.native.ts` variant of `imagePreprocessor`, `expo-image-manipulator`, or
> `base64: true` on either capture call would start uploading real photos silently, and the
> Data safety declaration would become false with nothing failing.
> `npm run test:privacy-disclosure` fails on each of those, and is wired into CI.

> **Latent bug worth fixing separately.** Every native scan still makes a doomed round trip
> to `/api/recognize-card` carrying a useless path string, and only then falls back to local
> OCR. That is wasted latency and a wasted Gemini call on the server. It is out of scope for
> the submission and is listed as a follow-up in `README.md`.

---

## 1. Off-device data flows in the Android binary

| # | Data | Trigger | Destination | Evidence |
| --- | --- | --- | --- | --- |
| 1 | **Not the image** — a local `file://` path string | Every scan | `POST /api/recognize-card`, forwarded to Gemini as undecodable data | See the derivation above. Contains no user data; it is an app-private cache path. |
| 2 | Google ID token (email, display name, avatar URL, Google subject ID) | Sign-in with Google | `POST /api/auth/login` → identity record in Vercel KV | `src/services/authService.ts:379-418`, `:822-826`; `api/_lib/identity-store.ts:44-53` |
| 3 | Expo push token + platform | App launch on native | `POST /api/push/register` → Vercel KV hash `push:tokens` | `src/services/pushNotificationService.ts:40-84`; `api/_lib/kv-storage.ts:32-39` |
| 4 | Price-alert definitions (card number, printing, thresholds, currency) | User creates or removes a price alert | `POST /api/push/price-alerts` | `src/services/priceAlertSync.ts:18` |
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

## 3. Answers

### Photos and videos → Photos

| Field | Answer |
| --- | --- |
| Collected | **No** |

Justification: recognition runs on-device via `expo-ocr-kit`; no image bytes are
transmitted. See the derivation above. Camera captures are written to the app's private
cache directory by `takePictureAsync` and are not cleared by the app, but on-device storage
is not collection.

Because Collected = No, the follow-up questions (shared, ephemeral, purpose) are not asked.
Do **not** tick "ephemeral processing" — that option only applies to data you collect.

Play may still surface Photos as a suggested data type because of the camera permission.
A permission is not collection; answer No.

### Personal info → Name, Email address, User IDs

| Field | Answer | Reason |
| --- | --- | --- |
| Collected | **Yes** | Google ID token contents are persisted server-side: `displayName`, `primaryEmail`, `photoUrl`, provider subject ID and an internal user ID (`api/_lib/identity-store.ts:44-53`, `:617-627`). |
| Shared | No | Stored in the developer's own Vercel KV; no onward transfer. |
| Processed ephemerally | No | Persisted until the account is deleted. |
| Required or optional | **Optional** | Guest mode exists (`src/screens/LoginScreen.tsx:95-102`); browsing and search need no account, scanning does. |
| Purpose | App functionality, Account management | Sign-in and cross-device sync. |

### Device or other IDs

| Field | Answer | Reason |
| --- | --- | --- |
| Collected | **Yes** | The Expo push token, a persistent device identifier, is uploaded at launch and stored (flow 3). |
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

Not required for the card image, because on Android no image is transmitted. The privacy
policy states the split plainly: on-device on mobile, uploaded to Gemini on web
(`public/privacy.html`, sections 3 and 6, both languages). Keep that split accurate — if
the native path ever starts uploading, Play expects an in-app disclosure before the first
upload, not just a policy line.

## 6. Corrections to `docs/release-testflight-google-play-closed-testing.md`

That document's conclusion about images was right; several of its other claims are not.

| Claim in that document | Reality |
| --- | --- |
| "native binary 完全不傳送影像 off-device" | **Correct**, and confirmed here by a fuller derivation — though the mechanism is accidental and now guarded by `test:privacy-disclosure`. |
| "無帳號機制" / "無帳號" | **False.** Google Sign-In, a cloud identity store, account linking, deletion and cross-device sync are all live. |
| Push tokens written to `data/push-tokens.json` in the GitHub repo | **Stale.** They are in Vercel KV under `push:tokens` (`api/_lib/kv-storage.ts:32-39`). |
| "App access：若不需要登入選全部功能免登入" | **Wrong for this app.** Scanning requires an account (`src/services/permissionService.ts:17`), so reviewer instructions and credentials are required. |
| Watchlist is local-only and nothing syncs server-side | **Stale.** Price alerts sync via `/api/push/price-alerts`, and account sync stores favorites, decks, collection and settings server-side while signed in. |
