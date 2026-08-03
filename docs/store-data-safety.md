# HoloHunter — Store Data Safety Answers (App Store + Google Play)

Copy-paste-ready answers for the App Store Privacy Nutrition Label and the
Google Play Data Safety form, derived from the **current shipping
implementation** (not future plans). These are the definitive answers to submit —
there are no alternative readings to choose from. Keep this in sync with the code
whenever the auth, scan, or push flows change.

Support / deletion contact: `dicoge.chen@gmail.com`
Privacy Policy: `/privacy` · Support: `/support`

## Gemini API tier / billing — NOT verified in this repo (answers do not assume paid)

The card-scan image is uploaded to **Google Gemini**
(`generativelanguage.googleapis.com`, `api/recognize-card.ts`). How Google may
retain, log, or use that image depends on the **API tier and billing status of
the production Google Cloud project**, which **cannot be verified from this
repository**. The answers below therefore do **not** assume the paid tier and do
**not** claim Google acts only as a data processor. They are filled to the
**conservative floor that holds on any tier**:

- Even the **paid** Gemini tier is **not zero-retention**: Google "logs prompts
  and responses for a limited period of time, solely for detecting and
  preventing violations." Limited-period logging means the image is retained
  **beyond** the real-time request → it is **not** ephemeral and **not** covered
  by Apple's real-time-request exclusion.
- The **free** tier is worse: Google "uses the content you submit … to provide,
  improve, and develop Google products … and machine learning technologies,"
  human reviewers may read it, and the terms say "Do not submit sensitive,
  confidential, or personal information to the Unpaid Services."

Source: **Gemini API Additional Terms of Service**, "How Google Uses Your Data" —
https://ai.google.dev/gemini-api/terms

**Consequence for the forms (unconditional):** the card image is **declared** on
both stores, marked **not "processed ephemerally"** on Google Play, and marked
**Shared: Yes** on Google Play (we cannot rely on Play's service-provider
exclusion without a verified paid-tier Data Processing Addendum).

> **Ops recommendation (does not change the answers above):** enable and keep
> paid billing on the production `GEMINI_API_KEY` project and retain the Google
> Data Processing Addendum. That improves the privacy posture for users, but the
> store answers stay as written until a verified zero-retention contract/config
> exists — do not soften them on assumption.

## A. Ground-truth data inventory (what the code actually does)

| Data | Source in code | Where it goes | Linked to identity? | Retention |
|---|---|---|---|---|
| Google account ID (`sub`), email, name (given/family), profile picture URL | `signInWithProvider('google')` → `fetchGoogleUserInfo` (`src/services/authService.ts`) | Stored **on device only** (`localStorage 'holohunter-users'` + zustand persist `'holohunter-auth'` / AsyncStorage). **Not** sent to our backend. | Yes (account) | Until sign-out / delete / uninstall (local) |
| Google OAuth access + refresh token | `exchangeOAuthCode` | Stored **on device only** (persist `'holohunter-auth'`) | Yes (account) | Until sign-out / delete / uninstall (local) |
| Card scan images | `recognizeViaApi` (`src/services/cardRecognition.ts`), native path in `ScanScreen.tsx` | Uploaded (both native + web) to our `POST /api/recognize-card` → forwarded to **Google Gemini** (`gemini-2.5-flash` on `generativelanguage.googleapis.com`, `api/recognize-card.ts` `callVision`). **No OpenRouter.** | No (image only) | Not stored by our server. Google's retention depends on the (unverified) API tier; Gemini terms permit limited-period logging → treat as retained beyond the request |
| Expo push token + platform (iOS/Android) | `pushNotificationService.ts` → `POST /api/push/register` | **Vercel KV** (`api/lib/kv-storage.ts`), keyed by push token | **No** — anonymous, not tied to Google account | Until removed on request (no in-app delete yet) |
| Watchlist card numbers, favorites, language/currency prefs, scan count | `watchlistStore.ts`, `scanQuotaStore.ts`, settings | **On device only** (localStorage / AsyncStorage). Not uploaded. | Device-local | Until uninstall / clear data |

Key facts that drive the answers below:
- **Apple Sign-In is disabled** (`APPLE_LOGIN_ENABLED = false`). Only Google is live.
- Account profile data is retrieved from Google and kept **on the device**; it is
  **not transmitted to a HoloHunter backend**. Under Google Play's definition,
  data that stays on the device is **not "collected"** — so these fields are
  **not** declared as collected on Play (see §C).
- The **only** user data that leaves the device to our / third-party servers:
  (1) scan **images** (forwarded to Google Gemini), (2) an anonymous **push
  token** (Vercel KV).
- **No** advertising SDKs, **no** analytics SDKs, **no** data sold or shared for
  ads/tracking. Scan quota is a local, device-only counter (100/month for
  signed-in free users; guests cannot scan). No paid subscription / no payments.

---

## B. App Store — Privacy Nutrition Label (definitive)

### Data Used to Track You
**None.** HoloHunter does not track users across apps/websites and contains no
advertising or third-party analytics SDKs.

### Data Linked to You
The account profile fields below are obtained via Google Sign-In and kept only on
the device (never sent to our servers). We **declare them anyway** on the App
Store — over-disclosure is review-safe and keeps the label consistent with the
OAuth flow the user sees. (Google Play is handled differently — see §C — because
Play's "collect" definition excludes on-device-only data.)

| Category → Type | Purpose | Linked | Tracking |
|---|---|---|---|
| Contact Info → Email Address | App Functionality (sign-in / account) | Yes | No |
| Contact Info → Name | App Functionality | Yes | No |
| Identifiers → User ID (Google account ID) | App Functionality (authentication) | Yes | No |

(The Google profile-picture URL is stored on-device with the above and needs no
separate line item.)

### Data Not Linked to You
| Category → Type | Purpose | Linked | Tracking |
|---|---|---|---|
| User Content → Photos or Videos (card scan image) | App Functionality (card recognition) | No | No |
| Identifiers → Device ID (Expo push token) | App Functionality (price notifications) | No | No |

### Card scan image — DECLARED (rationale to record)
The card image is **declared** (User Content → Photos or Videos, above). It is
**not** claimed under Apple's real-time-request exclusion, because that exclusion
requires the data to be used "solely … to service the transmitted request in real
time" and **not retained**. The image is transmitted off-device to Google Gemini,
and the Gemini API terms permit **limited-period logging** (retention beyond the
real-time request); there is **no verified zero-retention contract/config** for
the production project. Declaring it is the accurate, review-safe answer.
(Contents are card artwork only — no faces, no account or identity data — so it is
**Not Linked to You** and not used for tracking.) If a reviewer asks, cite
`api/recognize-card.ts` (our server does not persist it) and the Gemini API terms
above (Google-side retention depends on tier and is not zero).

### Account deletion (App Store requirement)
In-app **Settings → Delete Account** removes the local account record and signs
the user out. It does **not** by itself revoke Google authorization or delete the
server-side push token. Full revocation: Sign Out (revokes the Google token) or
Google Account settings; push-token removal by emailing `dicoge.chen@gmail.com`.
Disclose this honestly — do **not** claim all cloud/authorization data is deleted.

---

## C. Google Play — Data Safety form (definitive)

### Overall
- **Does your app collect or share any of the required user data types?** Yes.
- **Is all collected data encrypted in transit?** Yes (HTTPS).
- **Do you provide a way for users to request that their data be deleted?** Yes —
  email `dicoge.chen@gmail.com`; plus in-app sign-out (revokes Google token) and
  uninstall / clear-data for local data.

### Data types — collected (declare exactly these)

Under Google Play's Data Safety definitions, "collected" means data transmitted
off the device. The Google Sign-In profile fields (email, name, User ID, picture)
are stored **on the device only** and are **never sent to our servers**, so they
are **not collected** on Play — see the "NOT collected" list below. Only the two
types that actually leave the device are declared here.

**1. Photos and videos → Photos (card scan image)**
- Collected: **Yes** · Shared: **Yes** · Processed ephemerally: **No**
- Purpose: **App functionality** (card recognition)
- Required or optional: Optional (only if the user scans) · Linked to identity: No
- *Why "Shared: Yes":* the image is transferred to **Google (Gemini API)**, a
  third party. Play's "sharing" exclusion for a *service provider processing on
  the developer's behalf* requires that Google act as a processor — which depends
  on a **paid-tier Data Processing Addendum that is not verified** for the
  production project. Without that verification we do **not** rely on the
  exclusion, so the transfer is declared as sharing.
- *Why "Processed ephemerally: No":* our server does not store the image, but the
  Gemini API terms permit **limited-period logging** by Google (retention beyond
  the request), so it does not meet Play's "ephemeral" bar (Gemini API Terms,
  cited above).

**2. Device or other IDs → Device or other IDs (Expo push token)**
- Collected: **Yes** · Shared: **No**
- Purpose: **App functionality** (push price notifications)
- Required or optional: Optional (only if notifications granted; mobile only)
- Processed ephemerally: No · Linked to identity: No (anonymous, keyed by token in Vercel KV)

### Data types — NOT collected (device-local only)
The following stay on the device (localStorage / AsyncStorage) and are never
uploaded to our servers, so under Play's definition they are **Not collected** —
do **not** declare them:

- **Personal info → Name** and **Personal info → Email address** — obtained via
  Google Sign-In, stored on-device only.
- **Personal info → User IDs** (Google account ID `sub`) — on-device only. *(Note
  the Play taxonomy: "User IDs" is under **Personal info**, not a separate
  Identifiers group.)*
- Google OAuth access / refresh tokens and the profile-picture URL — on-device only.
- Favorites / collections, watchlist card numbers, language/currency preferences,
  and the monthly scan counter — on-device only.

### Security practices
- Data encrypted in transit: **Yes**.
- Data deletion request mechanism: **Yes** (email + sign-out + uninstall).
- No data sold. No data shared with advertisers or analytics providers. The only
  off-device recipients are: Google (Sign-In runs on-device; the card **image**
  is sent to the Gemini API for recognition — tier/billing unverified, so the
  transfer is declared as sharing on Play), Vercel (backend + KV for the
  anonymous push token), Expo (push delivery).
