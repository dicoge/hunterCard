# HoloHunter — Store Data Safety Answers (App Store + Google Play)

Copy-paste-ready answers for the App Store Privacy Nutrition Label and the
Google Play Data Safety form, derived from the **current shipping
implementation** (not future plans). These are the definitive answers to submit —
there are no alternative readings to choose from. Keep this in sync with the code
whenever the auth, scan, or push flows change.

Support / deletion contact: `dicoge.chen@gmail.com`
Privacy Policy: `/privacy` · Support: `/support`

## Release precondition (load-bearing — verify before submitting)

The card-image answers below depend on the production `GEMINI_API_KEY` being on
the **paid Gemini API tier (billing enabled on the Google Cloud project)**. This
is not optional:

- **Paid tier** — Google "doesn't use your prompts … or responses to improve our
  products," logs prompts/responses "for a limited period of time, solely for
  detecting and preventing violations," and acts as a **data processor** under
  the Google Data Processing Addendum. This is what makes Google a *service
  provider / processor* for the card images.
- **Free (unpaid) tier** — Google "uses the content you submit … to provide,
  improve, and develop Google products and services and machine learning
  technologies," human reviewers may read it, and the terms say "Do not submit
  sensitive, confidential, or personal information to the Unpaid Services." On
  this tier Google is **not** a mere processor, the "service provider" exceptions
  below do **not** apply, and the image transfer would have to be declared as
  data *shared* with a third party for its own purposes.

Source: **Gemini API Additional Terms of Service**, "How Google Uses Your Data" —
https://ai.google.dev/gemini-api/terms (also note: for EEA/Switzerland/UK users,
the paid-service data terms apply to all services). **Action: confirm billing is
enabled on the production key and keep it enabled; the answers below assume it.**

## A. Ground-truth data inventory (what the code actually does)

| Data | Source in code | Where it goes | Linked to identity? | Retention |
|---|---|---|---|---|
| Google account ID (`sub`), email, name (given/family), profile picture URL | `signInWithProvider('google')` → `fetchGoogleUserInfo` (`src/services/authService.ts`) | Stored **on device only** (`localStorage 'holohunter-users'` + zustand persist `'holohunter-auth'` / AsyncStorage). **Not** sent to our backend. | Yes (account) | Until sign-out / delete / uninstall (local) |
| Google OAuth access + refresh token | `exchangeOAuthCode` | Stored **on device only** (persist `'holohunter-auth'`) | Yes (account) | Until sign-out / delete / uninstall (local) |
| Card scan images | `recognizeViaApi` (`src/services/cardRecognition.ts`), native path in `ScanScreen.tsx` | Uploaded (both native + web) to our `POST /api/recognize-card` → forwarded to **Google Gemini** (`gemini-2.5-flash` on `generativelanguage.googleapis.com`, `api/recognize-card.ts` `callVision`). **No OpenRouter.** | No (image only) | Not retained by our server; on the paid tier Google logs briefly for abuse detection only, no training |
| Expo push token + platform (iOS/Android) | `pushNotificationService.ts` → `POST /api/push/register` | **Vercel KV** (`api/lib/kv-storage.ts`), keyed by push token | **No** — anonymous, not tied to Google account | Until removed on request (no in-app delete yet) |
| Watchlist card numbers, favorites, language/currency prefs, scan count | `watchlistStore.ts`, `scanQuotaStore.ts`, settings | **On device only** (localStorage / AsyncStorage). Not uploaded. | Device-local | Until uninstall / clear data |

Key facts that drive the answers below:
- **Apple Sign-In is disabled** (`APPLE_LOGIN_ENABLED = false`). Only Google is live.
- Account profile data is retrieved from Google and kept **on the device**; it is
  **not transmitted to a HoloHunter backend**.
- The **only** user data our servers receive: (1) scan **images** (forwarded to
  Google Gemini, paid tier), (2) an anonymous **push token** (Vercel KV).
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
the device (never sent to our servers). We **declare them anyway** — over-disclosure
is review-safe, and it keeps the label consistent with the OAuth flow the user
sees. This is the position to submit; do not omit them.

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
| Identifiers → Device ID (Expo push token) | App Functionality (price notifications) | No | No |

### Card scan image — excluded from the label (with the reason to record)
The scanned card image **qualifies for Apple's real-time-request exclusion**:
Apple's definition of "collect" excludes data "transmitted off the device … to
service the transmitted request in real time" that is not stored or used for other
purposes. The image is uploaded solely to obtain one recognition result and is not
retained by our server; on the paid Gemini tier Google processes it as a service
provider without training or independent use. **Therefore it is not listed on the
Nutrition Label.** (Contents are card artwork only — no faces, no account or
identity data.) If a reviewer asks, cite `api/recognize-card.ts` (no persistence)
and the Gemini API paid-tier terms above.

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

**1. Personal info → Email address**
- Collected: **Yes** · Shared: **No**
- Purpose: **App functionality** (account management / sign-in)
- Required or optional: Optional (only if the user signs in)
- Processed ephemerally: No · Linked to identity: Yes
- (Obtained via Google Sign-In, stored on-device. Declared for transparency and
  label-consistency with the OAuth flow.)

**2. Personal info → Name**
- Collected: **Yes** · Shared: **No**
- Purpose: **App functionality**
- Required or optional: Optional · Processed ephemerally: No · Linked: Yes

**3. App info and performance → other / Identifiers → User IDs (Google account ID)**
- Collected: **Yes** · Shared: **No**
- Purpose: **App functionality** (authentication)
- Required or optional: Optional · Processed ephemerally: No · Linked: Yes

**4. Photos and videos → Photos (card scan image)**
- Collected: **Yes** · Shared: **No** · Processed ephemerally: **Yes**
- Purpose: **App functionality** (card recognition)
- Required or optional: Optional (only if the user scans) · Linked: No
- *Why "Shared: No":* the image is transferred to **Google (Gemini API, paid
  tier) acting as a service provider processing on our behalf.** Google Play's
  definition of "sharing" **excludes** transfers to a service provider that
  processes data on the developer's behalf, so this is collection-only, not
  sharing. *Why "ephemeral":* our server does not store it, and under the paid
  Gemini tier Google does not train on it and logs it only briefly for abuse
  detection (Gemini API Terms, cited above).

**5. Device or other IDs → Device or other IDs (Expo push token)**
- Collected: **Yes** · Shared: **No**
- Purpose: **App functionality** (push price notifications)
- Required or optional: Optional (only if notifications granted; mobile only)
- Processed ephemerally: No · Linked to identity: No (anonymous, keyed by token in Vercel KV)

### Data types — NOT collected (device-local only)
Favorites/collections, watchlist card numbers, language/currency preferences, and
the monthly scan counter are stored only on the device (AsyncStorage /
localStorage) and are never uploaded — declare **Not collected**.

### Security practices
- Data encrypted in transit: **Yes**.
- Data deletion request mechanism: **Yes** (email + sign-out + uninstall).
- No data sold. No data shared with advertisers or analytics providers. The only
  third-party recipients are service providers strictly for functionality: Google
  (Sign-In, Gemini vision — paid tier / processor), Vercel (backend + KV), Expo
  (push delivery).
