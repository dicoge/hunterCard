# App content — answer pack

Play Console → Policy → App content. Every answer below is grounded in the shipping
Android build. Items the owner must supply are marked **OWNER** and collected in
`README.md`.

## Privacy policy

| Field | Value |
| --- | --- |
| Privacy policy URL | `https://holohunter.dicoge.com/privacy` |

Already declared in `app.base.json` (`expo.privacyPolicyUrl`). The page is served from
`public/privacy.html` and was corrected as part of this work — the previous version told
users that card images never leave the device, which the code contradicts. Confirm the
URL resolves publicly and is reachable without a login before submitting; Play rejects
policies behind a paywall or sign-in.

## Ads

| Question | Answer |
| --- | --- |
| Does your app contain ads? | **No** |

`src/components/AdSlot.tsx:11` sets `PRODUCTION_ADS_ENABLED = false` and no ad network SDK
is present in `package.json`. If ads are ever switched on, this answer and the store
listing's "Contains ads" badge must change in the same release.

## App access

| Question | Answer |
| --- | --- |
| Is any part of your app restricted? | **Yes — some functionality is restricted** |

The app opens on a sign-in screen offering Google sign-in or **以訪客身份進入** (continue as
guest). Guests can browse sets, search cards, open card details with prices, read the rules
tutorial and view tournament reports. Guests **cannot** use card scanning
(`src/services/permissionService.ts:17`, `canScan = role !== 'guest'`).

Provide one instruction set covering the guest path, and one login credential for the
scan feature.

**Reviewer instructions — paste into "Instructions" (English):**

```
Most of the app is usable without any account. On the first screen, tap
"以訪客身份進入" (the second button, "Continue as guest") to enter. As a guest you can
browse card sets, search cards, open card details with reference prices, read the rules
tutorial, and view tournament reports.

Card scanning requires a signed-in account. To review that feature, tap the first button
("Sign in with Google") and use the test account below. After signing in, open the menu
(top-left) and choose "掃描卡牌" (Scan card), then point the camera at any trading card.

Test account: <OWNER: Google account address>
Password: <OWNER: password>
Note: this account has 2-Step Verification disabled so it can be used from a review device.

The app is an unofficial fan-made companion for the hololive OFFICIAL CARD GAME. It is not
affiliated with or endorsed by COVER Corporation.
```

> **OWNER — blocking.** Play requires working credentials for any gated functionality.
> Create a dedicated Google account for review, disable 2-Step Verification on it, sign in
> with it once on a real device so Google does not treat the reviewer's sign-in as
> suspicious, and never reuse a personal account. A reviewer who cannot reach the scan
> feature will reject the release under "App access".

## Content rating (IARC questionnaire)

Answer as an app, not a game. The intended answers:

| Question area | Answer |
| --- | --- |
| Category | Reference / Utility |
| Violence, sexuality, profanity, controlled substances, horror | None |
| Gambling, simulated gambling, real-money contests | **None.** The app shows secondary-market reference prices for physical cards. It sells nothing, holds no balance, and runs no draw, pack-opening or loot mechanic. |
| User-generated content, sharing, communication between users | **None.** No comments, posts, messaging, profiles or social graph. |
| Shares user location | No |
| Allows purchases | No — no billing integration exists in this build |
| Digital purchases / in-app purchases | No |
| Personal information shared with third parties | **No** for the review build. Card images are not shared (recognition is on-device), and the push token is never registered because `pushAlerts: !STORE_MVP` disables the code path AND `app.config.js` strips `POST_NOTIFICATIONS` from the store-mvp manifest (DIC-1259). Answer consistently with Data safety. |

Expected outcome: Everyone / PEGI 3 / ESRB E. The rating is issued by IARC from the
answers; do not hand-pick a rating.

> **A monthly subscription is planned for a LATER release** (owner sequencing 2026-08-30:
> first Closed Test ships free, monetization does not block review — see
> [`subscription.md`](./subscription.md)). Answer the purchase questions **No** for as long
> as the submitted binary cannot complete a purchase — which is the case today. When billing
> eventually ships, both purchase answers become Yes and **the content rating questionnaire
> has to be re-run**, because changing them reissues the IARC rating. Do not answer Yes in
> advance to save a step: it would declare a capability the artifact does not have.

## Target audience and content

| Field | Answer |
| --- | --- |
| Target age groups | **13–15, 16–17, 18 and over** |
| Appeals to children? | No |
| Designed for Families / Teacher Approved? | No — do not opt in |

Rationale: this is a collector and player utility centred on secondary-market pricing. It
is not designed for children, and the store listing, icon and feature graphic contain no
child-directed themes. Including under-13 would pull the app into the Families policy
programme, which requires a certified ads SDK, additional disclosures and a stricter
review — for no benefit here.

The hololive property has broad appeal, so be prepared for Play to ask whether the app
appeals to children. The honest answer is no: the app's function is price lookup and
collection tracking for people who buy cards.

## News app

| Question | Answer |
| --- | --- |
| Is this a news app? | **No** |

The tournament monthly report (`賽事月報`) is derived analytics over public tournament
results, not journalism. It has no editorial staff and no news feed.

## Financial features

| Question | Answer |
| --- | --- |
| Does your app provide any financial features? | **No** |

Play means lending, banking, investments, crypto exchanges, insurance and money
transmission. HoloHunter displays observed secondary-market prices for physical trading
cards. It brokers nothing, holds no funds, and executes no transaction. Do not tick any
financial-product box because the app shows a price.

## Other declarations

| Question | Answer |
| --- | --- |
| Government app | No |
| COVID-19 contact tracing or status | No |
| Health apps / clinical features | No |
| Data safety | See `data-safety.md` |
| Advertising ID | **Not used.** No ads or analytics SDK; the app does not read the advertising ID. Declare accordingly so Play does not require an ad-ID permission declaration. |

## Data deletion

| Field | Value |
| --- | --- |
| Can users request account deletion? | Yes |
| In-app path | Settings → 刪除帳號 (Delete Account) |
| Web URL for deletion requests | None — an email channel is used instead |
| Deletion contact | `dicoge.chen@gmail.com` |

The in-app flow performs a real backend cascade delete; it is not a local clear. See
`data-safety.md` section 4, including the two documented gaps: the push token is not
covered by the flow, and Apple-linked accounts fail closed with HTTP 501. Both are
disclosed in the privacy policy.

> **OWNER — recommended.** Play prefers a **web URL** where a user who has uninstalled the
> app can request deletion. A short static page at
> `https://holohunter.dicoge.com/delete-account` describing the in-app path and the email
> channel would satisfy this cleanly. Not built here because it is a new public page and
> belongs in its own change.
