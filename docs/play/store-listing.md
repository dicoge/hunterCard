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

All committed under `docs/play/store-listing/`.

| Asset | Play requirement | File | Actual |
| --- | --- | --- | --- |
| App icon | 512×512 PNG, 32-bit | `icon-512.png` | 512×512 |
| Feature graphic | 1024×500 PNG or JPEG | `feature-graphic-1024x500.png` | 1024×500 |
| Phone screenshot 1 | 16:9–9:16, 320–3840 px | `phone-01-home.png` | 1080×1920 |
| Phone screenshot 2 | " | `phone-02-search-results.png` | 1080×1920 |
| Phone screenshot 3 | " | `phone-03-card-detail.png` | 1080×1920 |
| Phone screenshot 4 | " | `phone-04-features.png` | 1080×1920 |

Play requires a minimum of two phone screenshots; four are supplied.

> **The four committed screenshots are invalidated by DIC-1256 and must be recaptured.**
> They were taken from the build 6 APK, which still had every feature the review build is
> losing:
>
> | File | Shows | Status |
> | --- | --- | --- |
> | `phone-01-home.png` | Home screen, set browser | **Still valid** — nothing on it is being removed |
> | `phone-02-search-results.png` | Search results with `NT$` prices on every row | **Invalid** — prices are removed |
> | `phone-03-card-detail.png` | Card detail including the whole 市場數據 section | **Invalid** — market data is removed |
> | `phone-04-features.png` | Navigation drawer listing 收藏 and 掃描卡牌 | **Invalid** — 收藏 and 入手提醒 are removed from the drawer |
>
> Play requires a minimum of two phone screenshots, and only one survives. Recapture from the
> DIC-1256 store build before submitting — the same emulator method works: `adb exec-out
> screencap -p`, then crop 1080x2400 to 1080x1920, because the raw 9:20 device aspect falls
> outside Play's accepted range. Good candidates in the slimmed build: home, search results,
> a card detail page, the deck editor, and the rules tutorial.

**Provenance of the existing screenshots.** Captured with `adb exec-out screencap -p` from the
`com.dicoge.holohunter` build 6 APK running on an Android 16 (API 36) emulator at 1080x2400,
then cropped to 1080x1920. They are unretouched captures of real screens showing real card
data — no mockups, no composited device frames, no invented content. That method is what
should be reused; only the build they came from is now wrong.

**The feature graphic and icon are unaffected.** Rerun
`node scripts/generate-play-store-assets.mjs` after any wording or palette change. The graphic
uses the app icon's navy-and-gold palette, carries a 非官方 · UNOFFICIAL badge, names no
feature, and deliberately contains no card artwork — so nothing on it is invalidated by the
slim-down.

> **IP risk worth a decision.** Screenshots 2 and 3 contain hololive card artwork, which is
> COVER Corporation's intellectual property. This is normal and hard to avoid for a card
> companion app, and the listing is explicit that the app is unofficial — but it is a real
> takedown vector for fan-made tools. Screenshots 1 and 4 contain no card art. If the owner
> wants the minimum-risk listing, ship 1 and 4 only; Play's minimum of two is still met.

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
