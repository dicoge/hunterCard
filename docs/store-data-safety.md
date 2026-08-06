# HoloHunter — Store Data Safety Answers (App Store + Google Play)

Copy-paste-ready answers for the App Store Privacy Nutrition Label and the
Google Play Data Safety form, derived from the **current shipping
implementation** (not future plans). These are the definitive answers to submit —
there are no alternative readings to choose from. Keep this in sync with the code
whenever the auth, scan, or push flows change.

Support / deletion contact: `dicoge.chen@gmail.com`
Privacy Policy: `/privacy` · Support: `/support`

## Auth model — server-authoritative (DIC-663 / DIC-866)

HoloHunter uses a **server-authoritative account system**, not device-only
storage. At sign-in the client only runs the provider OAuth/OIDC prompt to obtain
a short-lived provider **ID token** and posts it to `POST /api/auth/login`
(`src/services/authService.ts` → `api/auth/[action].ts`). The backend verifies the
token, resolves the identity, and **stores an internal account and per-provider
identity records in Vercel KV** (`api/_lib/identity-store.ts`), then issues a
self-signed session token (`api/_lib/session.ts`). Consequences that drive the
answers below:

- The account identity fields (internal user id, provider `subject`, and the
  **email / display name / profile-picture** snapshots, plus role and link
  timestamps) **leave the device and are stored on our server** → under both
  Apple's and Google Play's definitions they are **collected**. (This reverses the
  earlier device-only assumption.)
- Identity is keyed by `(provider, subject)`; **email is a stored snapshot only**
  and never used for identity resolution or account merging.
- **Sign in with Apple is enabled natively on iOS**
  (`APPLE_LOGIN_ENABLED = isIOS || APPLE_WEB_ENABLED`, `src/services/authService.ts`);
  web Apple stays gated behind `EXPO_PUBLIC_APPLE_WEB_LOGIN_ENABLED`. Both Google
  and Apple are live login providers → declare Apple on the Apple label.
- The client does **not** store Google/Apple OAuth access/refresh tokens; it holds
  only the server-issued **session token** and a cached copy of the account
  snapshot (`holohunter-auth` persist), re-validated against the server each launch.

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
| Provider `subject`, email, display name, profile-picture URL, role, link timestamps | `signInWithProvider` → `POST /api/auth/login` (`src/services/authService.ts`, `api/auth/[action].ts`) | **Transmitted off-device to our backend** and stored in the **server identity DB (Vercel KV)** (`api/_lib/identity-store.ts`). A snapshot is also cached on-device (`holohunter-auth`). | Yes (account) | On server until account deletion (`/api/auth/delete-account`); local cache until sign-out / delete / uninstall |
| Provider ID token (transient) + server session token | `obtainProviderIdToken` → `/api/auth/login` → `api/_lib/session.ts` | ID token sent to our backend for verification (not stored). Session token stored **on device** (`holohunter-auth`); validated server-side each launch. | Yes (account) | Session TTL 30 days / until sign-out |
| Card scan images | `recognizeViaApi` (`src/services/cardRecognition.ts`), native path in `ScanScreen.tsx` | Uploaded (both native + web) to our `POST /api/recognize-card` → forwarded to **Google Gemini** (`gemini-2.5-flash` on `generativelanguage.googleapis.com`, `api/recognize-card.ts` `callVision`). **No OpenRouter.** | No (image only) | Not stored by our server. Google's retention depends on the (unverified) API tier; Gemini terms permit limited-period logging → treat as retained beyond the request |
| Expo push token + platform (iOS/Android) | `pushNotificationService.ts` → `POST /api/push/register` | **Vercel KV** (`api/lib/kv-storage.ts`), keyed by push token | **No** — anonymous, not tied to the account | Until removed on request (no in-app delete yet) |
| Watchlist card numbers, favorites, language/currency prefs, scan count | `watchlistStore.ts`, `scanQuotaStore.ts`, settings | **On device only** (localStorage / AsyncStorage). Not uploaded. | Device-local | Until uninstall / clear data |

Key facts that drive the answers below:
- **Google and Apple Sign-In are both live** — Google on web + iOS, Apple natively
  on iOS (web Apple gated by feature flag). Providers can be linked/unlinked.
- Account identity data (subject, email, name, photo, role) is **transmitted to and
  stored on our backend** (Vercel KV) → it **is "collected"** under both stores'
  definitions and is declared as such (§B, §C).
- The user data that leaves the device to our / third-party servers: (1) **account
  identity data** at sign-in (our Vercel backend), (2) scan **images** (forwarded
  to Google Gemini), (3) an anonymous **push token** (Vercel KV).
- Collections/favorites, watchlist, language/currency prefs, and the monthly scan
  counter stay **on device only** and are **not** synced across devices.
- **No** advertising SDKs, **no** analytics SDKs, **no** data sold or shared for
  ads/tracking. Scan quota is a local, device-only counter (100/month for
  signed-in free users; guests cannot scan). No paid subscription / no payments.

---

## B. App Store — Privacy Nutrition Label (definitive)

### Data Used to Track You
**None.** HoloHunter does not track users across apps/websites and contains no
advertising or third-party analytics SDKs.

### Data Linked to You
Obtained via Google / Apple Sign-In and **stored on our server** (Vercel KV
identity DB) as well as cached on-device. These are genuinely collected — declare
them:

| Category → Type | Purpose | Linked | Tracking |
|---|---|---|---|
| Contact Info → Email Address | App Functionality (sign-in / account) | Yes | No |
| Contact Info → Name | App Functionality (account display) | Yes | No |
| Identifiers → User ID (internal user id + provider `subject`) | App Functionality (authentication) | Yes | No |

(The profile-picture URL snapshot is stored server-side alongside the above and
needs no separate line item. Apple private-relay emails are accepted; email is a
snapshot only and is not used to key identity.)

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
In-app **Settings → Delete Account** runs a **server-authoritative, fail-closed**
deletion (`POST /api/auth/delete-account`): only on server-confirmed success does
it permanently delete the internal account and all linked identities from the
server (Vercel KV) and clear the device session (`api/auth/delete-account.ts`,
`api/_lib/identity-store.ts` `deleteUser`). Per Apple guideline **5.1.1(v)**, an
account with a linked **Apple** identity requires the server to **revoke the Apple
authorization** before deletion; if it cannot, the request fails and nothing is
deleted (Apple-token revocation persistence is still being finalized, so such
accounts currently receive a fail-closed "not yet available" and are not deleted).
**Sign Out** only clears the local session — it does **not** revoke Google/Apple
authorization. Deletion does not cover the anonymous push token (email
`dicoge.chen@gmail.com`) or device-local data (uninstall / clear data). Disclose
this honestly.

**Lawful-retention exception (narrow).** As a rule, server-confirmed deletion
retains none of the account/identity data. Data is retained **only where
applicable law explicitly requires it**, and then only the **minimum data
necessary for that legal obligation**, **only for the legally mandated period**,
used solely to satisfy that obligation, and deleted once the period ends. The App
currently has **no payment or transaction features, so there are no
payment/transaction records to retain today**; this exception does **not** extend
to retention for general operational or business purposes. State the exception in
these narrow terms — do not describe open-ended operational retention.

---

## C. Google Play — Data Safety form (definitive)

### Overall
- **Does your app collect or share any of the required user data types?** Yes.
- **Is all collected data encrypted in transit?** Yes (HTTPS).
- **Do you provide a way for users to request that their data be deleted?** Yes —
  in-app **Settings → Delete Account** (server-authoritative, fail-closed cascade
  delete of the server account/identities); plus email `dicoge.chen@gmail.com` and
  uninstall / clear-data for device-local data.

### Data types — collected (declare exactly these)

Under Google Play's Data Safety definitions, "collected" means data transmitted
off the device. The sign-in identity fields **are transmitted to and stored on our
backend** (Vercel KV), so they **are collected** and declared here.

**1. Personal info → Name (display name)**
- Collected: **Yes** · Shared: **No**
- Purpose: **App functionality** (account) · Required or optional: Optional (only if you sign in)
- Processed ephemerally: No · Linked to identity: Yes

**2. Personal info → Email address**
- Collected: **Yes** · Shared: **No**
- Purpose: **App functionality** (account) · Required or optional: Optional (only if you sign in)
- Processed ephemerally: No · Linked to identity: Yes

**3. Personal info → User IDs (internal user id + provider `subject`)**
- Collected: **Yes** · Shared: **No**
- Purpose: **App functionality** (authentication) · Required or optional: Optional (only if you sign in)
- Processed ephemerally: No · Linked to identity: Yes
- *(Note the Play taxonomy: "User IDs" is under **Personal info**, not a separate
  Identifiers group. The profile-picture URL snapshot is stored with these and
  needs no separate line item.)*
- *Why "Shared: No":* the identity data is stored in our own Vercel backend. The
  provider `subject` originates **from** Google/Apple (we do not transfer new user
  data to them beyond returning their own token for verification), so there is no
  third-party recipient to declare as sharing.

**4. Photos and videos → Photos (card scan image)**
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

**5. Device or other IDs → Device or other IDs (Expo push token)**
- Collected: **Yes** · Shared: **No**
- Purpose: **App functionality** (push price notifications)
- Required or optional: Optional (only if notifications granted; mobile only)
- Processed ephemerally: No · Linked to identity: No (anonymous, keyed by token in Vercel KV)

### Data types — NOT collected (device-local only)
The following stay on the device (localStorage / AsyncStorage) and are never
uploaded to our servers, so under Play's definition they are **Not collected** —
do **not** declare them:

- Favorites / collections, watchlist card numbers, language/currency preferences,
  and the monthly scan counter — on-device only, not synced across devices.
- The server-issued session token cached on-device — a local credential, not
  independently declared (the account it represents is declared above).

### Security practices
- Data encrypted in transit: **Yes**.
- Data deletion request mechanism: **Yes** (in-app server-authoritative Delete
  Account + email + uninstall).
- No data sold. No data shared with advertisers or analytics providers. Off-device
  recipients are: Google (Sign-In ID-token verification; and the card **image**
  sent to the Gemini API for recognition — tier/billing unverified, so that
  transfer is declared as sharing on Play), Apple (Sign in with Apple identity
  verification on iOS), Vercel (backend + KV storing the account/identity data and
  the anonymous push token), Expo (push delivery).
