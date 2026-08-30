# Store listing pack

Every string is ready to paste into Play Console → Grow → Store presence → Main store
listing. Nothing here describes a feature that is not in the shipping build.

## Text

> **Rewritten 2026-08-30 for the DIC-1256 review build.** The previous copy sold reference
> prices, market data, collection tracking and deck cost — all of which DIC-1256 removes from
> the store build. DIC-1256 item 8 requires the listing not to describe hidden features, and
> Play rejects listings that promise what the binary does not do. Nothing below mentions
> prices, favorites, alerts or a subscription.

| Field | Limit | Value |
| --- | --- | --- |
| App name | 30 | `HoloHunter` |
| Short description | 80 | see below |
| Full description | 4000 | see below |

**Short description (English, 71 chars):**

```
Unofficial card search, scanner and deck builder for hololive TCG players.
```

**Short description (繁體中文):**

```
非官方 hololive TCG 卡牌查詢、掃描與牌組工具
```

**Full description (English):**

```
HoloHunter is an unofficial, fan-made companion app for players of the hololive OFFICIAL
CARD GAME.

Search and browse
- Find cards by card number, member name, series or colour.
- Browse every booster pack and starter deck in one place.
- Open a card to see its artwork, card number, type, colour, rarity, skills and effects.

Scan a card with your camera
- Point your camera at a card, or pick a photo from your library, and HoloHunter identifies
  it for you.
- Recognition runs on your device. The card image is not uploaded to our servers.
- Scanning requires a free account. Browsing and searching do not.

Build decks
- Create and edit decks, and check them against the game's deck construction rules.

For players
- Read the rules tutorial if you are new to the game.
- Follow monthly tournament reports and deck analytics.
- Jump to the official card list for any card.

HoloHunter is not affiliated with, endorsed by, or sponsored by COVER Corporation or the
official hololive OFFICIAL CARD GAME project. All card names, artwork and trademarks belong
to their respective owners.
```

**Full description (繁體中文):**

```
HoloHunter 是為 hololive OFFICIAL CARD GAME 玩家製作的非官方輔助工具。

查詢與瀏覽
- 以卡號、成員名稱、系列或顏色搜尋卡片。
- 一次瀏覽所有擴充包與起始牌組。
- 開啟卡片查看卡圖、卡號、卡種、顏色、稀有度與技能效果。

用相機掃描卡牌
- 用相機對準卡片，或從相簿選取照片，HoloHunter 會為你辨識。
- 辨識在你的裝置上完成，卡牌影像不會上傳到我們的伺服器。
- 掃描功能需要免費帳號；查詢與瀏覽不需要登入。

組牌
- 建立與編輯牌組，並依遊戲的牌組構築規則檢查。

給玩家
- 新手可閱讀規則教學。
- 追蹤每月賽事月報與牌組分析。
- 一鍵前往官方卡表查看該卡。

HoloHunter 並非 COVER Corporation 或 hololive OFFICIAL CARD GAME 官方授權、背書或贊助的
應用程式。所有卡片名稱、圖像與商標均屬各自權利人所有。
```

The scan paragraph states that recognition is on-device. Play compares the listing, the
privacy policy and the Data safety form against each other, so keep this line consistent
with `data-safety.md` — if the native path ever starts uploading images, this sentence has
to change in the same release.

## Graphics

Committed under `docs/play/store-listing/`. Format contract (asserted by
`npm run test:play-store-assets`, wired into CI):

| Asset | Play requirement | File | Actual |
| --- | --- | --- | --- |
| App icon | 512×512 PNG, **32-bit RGBA** (IHDR colour type 6) | `icon-512.png` | 512×512, RGBA |
| Feature graphic | 1024×500 PNG or JPEG, **24-bit RGB** (colour type 2) | `feature-graphic-1024x500.png` | 1024×500, RGB |
| Phone screenshot 1 | 16:9–9:16, 320–3840 px, **24-bit RGB** (colour type 2) | `phone-01-home.png` | 1080×1920, RGB |

> **Screenshots are one file short of the Play minimum, on purpose.** Play requires two phone
> screenshots at submission; only one is committed. `phone-02-search-results.png`,
> `phone-03-card-detail.png` and `phone-04-features.png` were captured from the build 6 APK
> and showed features DIC-1256 removes from the review build (secondary-market prices, the
> 市場數據 section, the 收藏 / 入手提醒 drawer entries). The CR (DIC-1257) requires that
> invalidated screenshots be replaced from the slim production-profile surface rather than
> re-cropped or re-encoded from the wrong build, so they are deleted. Capture the missing
> two — plus a fresh `phone-01-home.png` for consistency — from the DIC-1256 store build
> before submitting.
>
> **Capture recipe** (unchanged): `adb exec-out screencap -p` from the `com.dicoge.holohunter`
> store-mvp build running on an Android 16 (API 36) emulator at 1080x2400, cropped to
> 1080x1920 because the raw 9:20 device aspect falls outside Play's 16:9–9:16 range. Good
> candidates in the slimmed build: home, search results, a card detail page, the deck
> editor, and the rules tutorial.
>
> **Colour format** matters as much as dimensions. `adb screencap -p` writes 8-bit RGBA;
> Play requires 24-bit RGB for phone screenshots. After capturing, drop each new PNG into
> `docs/play/store-listing/` and run:
>
> ```
> node scripts/generate-play-store-assets.mjs --recode-screenshots
> ```
>
> That re-encodes every `phone-*.png` in-place, preserving pixel content while stripping the
> alpha channel. `npm run test:play-store-assets` will fail the build if any surface still
> carries the wrong IHDR colour type.

**The feature graphic and icon are unaffected by DIC-1256.** Rerun
`node scripts/generate-play-store-assets.mjs` after any wording or palette change. The graphic
uses the app icon's navy-and-gold palette, carries a 非官方 · UNOFFICIAL badge, names no
feature, and deliberately contains no card artwork — so nothing on it is invalidated by the
slim-down. The generator is pure Node.js (pngjs + puppeteer) and produces the exact colour
types this document lists on both macOS and CI Linux.

> **IP risk worth a decision.** The invalidated screenshots that showed hololive card
> artwork were `phone-02-search-results.png` and `phone-03-card-detail.png`, which contained
> COVER Corporation's intellectual property. When recapturing, the minimum-risk listing is
> two screenshots that contain no card art — e.g. home and a features/drawer view. Play's
> minimum of two is still met.

## Other listing fields

| Field | Value |
| --- | --- |
| App category | Tools (alternative: Entertainment). Avoid anything implying official status. |
| Tags | Card game companion, price tracker, collection |
| Contact email | **OWNER** — publicly visible on the listing |
| Contact website | `https://holohunter.dicoge.com` |
| Contact phone | Optional; omit unless the owner wants it public |
| Privacy policy | `https://holohunter.dicoge.com/privacy` |
| Countries / regions | **OWNER** |
| In-app purchases badge | None today. Play adds it automatically once a subscription exists and the app can sell it — see [`subscription.md`](./subscription.md). The description above must not mention a subscription until then. |

## Closed testing release notes

```
First closed testing release.

Please check card search, card detail pages and reference prices, camera scanning
after signing in, deck editing, and general stability on your device. Report anything
that crashes, shows wrong card data, or reads confusingly.
```
