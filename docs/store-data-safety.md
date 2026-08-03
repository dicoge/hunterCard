# HoloHunter — Store Data Safety Answers (App Store + Google Play)

Copy-paste-ready answers for the App Store Privacy Nutrition Label and the
Google Play Data Safety form, derived from the **current shipping
implementation** (not future plans). Keep this in sync with the code whenever the
auth, scan, or push flows change.

Support / deletion contact: `dicoge.chen@gmail.com`
Privacy Policy: `/privacy` · Support: `/support`

## A. Ground-truth data inventory (what the code actually does)

| Data | Source in code | Where it goes | Linked to identity? | Retention |
|---|---|---|---|---|
| Google account ID (`sub`), email, name (given/family), profile picture URL | `signInWithProvider('google')` → `fetchGoogleUserInfo` (`src/services/authService.ts`) | Stored **on device only** (`localStorage 'holohunter-users'` + zustand persist `'holohunter-auth'` / AsyncStorage). **Not** sent to our backend. | Yes (account) | Until sign-out / delete / uninstall (local) |
| Google OAuth access + refresh token | `exchangeOAuthCode` | Stored **on device only** (persist `'holohunter-auth'`) | Yes (account) | Until sign-out / delete / uninstall (local) |
| Card scan images | `recognizeViaApi` (`src/services/cardRecognition.ts`), native path in `ScanScreen.tsx` | Uploaded (both native + web) to our `POST /api/recognize-card` → forwarded to **Google Gemini** (`generativelanguage.googleapis.com`, `api/recognize-card.ts` `callVision`). **No OpenRouter.** | No (image only) | Not retained by our server; processed by Google per its policy |
| Expo push token + platform (iOS/Android) | `pushNotificationService.ts` → `POST /api/push/register` | **Vercel KV** (`api/lib/kv-storage.ts`), keyed by push token | **No** — anonymous, not tied to Google account | Until removed on request (no in-app delete yet) |
| Watchlist card numbers, favorites, language/currency prefs, scan count | `watchlistStore.ts`, `scanQuotaStore.ts`, settings | **On device only** (localStorage / AsyncStorage). Not uploaded. | Device-local | Until uninstall / clear data |

Key facts that drive the answers below:
- **Apple Sign-In is disabled** (`APPLE_LOGIN_ENABLED = false`). Only Google is live.
- Account profile data is retrieved from Google and kept **on the device**; it is
  **not transmitted to a HoloHunter backend**.
- The **only** user data our servers receive: (1) scan **images** (ephemeral,
  forwarded to Google Gemini), (2) an anonymous **push token** (Vercel KV).
- **No** advertising SDKs, **no** analytics SDKs, **no** data sold or shared for
  ads/tracking. Scan quota is a local, device-only counter (100/month for
  signed-in free users; guests cannot scan). No paid subscription / no payments.

---

## B. App Store — Privacy Nutrition Label

Apple treats data as **"collected"** only if it is transmitted off the device
beyond the current session. Account profile data here is stored **on-device only**,
so under a strict reading it is **not "collected."** However, the card image and
push token **are** transmitted off device. Recommended declaration:

### Data Used to Track You
**None.** HoloHunter does not track users across apps/websites and contains no
advertising or third-party analytics SDKs.

### Data Linked to You
Declare only if you choose the conservative reading that on-device account data is
"collected." If so:

| Category → Type | Purpose | Linked | Tracking |
|---|---|---|---|
| Contact Info → Email Address | App Functionality (sign-in) | Yes | No |
| Contact Info → Name | App Functionality | Yes | No |
| Identifiers → User ID (Google account ID) | App Functionality (authentication) | Yes | No |
| User Content → Photos (Google profile picture URL) | App Functionality | Yes | No |

> Note: If you rely on Apple's "data that never leaves the device is not
> collected" guidance, the four rows above can be omitted, because email / name /
> user ID / picture are stored only on the device and are never sent to our
> servers. Pick one reading and be consistent with the Privacy Policy. The
> conservative (declare-it) reading above is the safer choice for review.

### Data Not Linked to You
| Category → Type | Purpose | Linked | Tracking |
|---|---|---|---|
| User Content → Photos or Videos (card scan image) | App Functionality (card recognition) | No | No |
| Identifiers → Device ID (Expo push token) | App Functionality (price notifications) | No | No |

- **Card scan image**: sent to our server and on to Google Gemini for a single
  recognition; not stored by us, not linked to an account, not for tracking.
- **Push token**: anonymous device token stored to deliver notifications; not
  linked to the Google account.

### Account deletion (App Store requirement)
In-app **Settings → Delete Account** removes the local account record and signs
the user out. It does **not** by itself revoke Google authorization or delete the
server-side push token. Full revocation: Sign Out (revokes the Google token) or
Google Account settings; push token removal by emailing `dicoge.chen@gmail.com`.
Disclose this honestly — do **not** claim all cloud/authorization data is deleted.

---

## C. Google Play — Data Safety form

### Overall
- **Does your app collect or share any of the required user data types?** Yes.
- **Is all collected data encrypted in transit?** Yes (HTTPS).
- **Do you provide a way for users to request that their data be deleted?** Yes —
  email `dicoge.chen@gmail.com`; plus in-app sign-out (revokes Google token) and
  uninstall/clear-data for local data.

### Data types — collected / shared

**1. Photos and videos → Photos (card scan image)**
- Collected: **Yes** · Shared: **Yes** (processed by Google Gemini as a service
  provider) · Processed ephemerally: **Yes** (not retained by our server)
- Purpose: **App functionality** (card recognition)
- Required or optional: Optional (only if the user scans)
- Linked to identity: No

**2. App activity / Personal info via Google Sign-In (Email, Name, User ID) —
   OPTIONAL declaration**
- These are obtained from Google Sign-In and stored **on device only**; they are
  **not sent to our servers**. Google Play's "collected" definition centers on
  transmission off the device to you/your processors. Because this data is not
  transmitted to us, it can be declared **Not collected**.
- If you prefer the conservative reading (sign-in provider receives the data),
  declare: Personal info → Email address, Name; App info and performance /
  Identifiers → User IDs. Purpose: **App functionality (Account management /
  Authentication)**; Shared: No; Linked: Yes; Not for ads.
- Pick one reading and keep it consistent with the App Store label and the policy.

**3. Device or other IDs → Device or other IDs (Expo push token)**
- Collected: **Yes** · Shared: **No**
- Purpose: **App functionality** (push price notifications)
- Required or optional: Optional (only if notifications are granted; mobile only)
- Linked to identity: No (anonymous, keyed by token in Vercel KV)

### Data types — NOT collected (device-local only)
Favorites/collections, watchlist card numbers, language/currency preferences, and
the monthly scan counter are stored only on the device (AsyncStorage /
localStorage) and are never uploaded — declare **Not collected**.

### Security practices
- Data encrypted in transit: **Yes**.
- Data deletion request mechanism: **Yes** (email + sign-out + uninstall).
- No data sold. No data shared with advertisers or analytics providers. The only
  third-party recipients are service providers strictly for functionality: Google
  (Sign-In, Gemini vision), Vercel (backend + KV), Expo (push delivery).
