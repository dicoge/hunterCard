# Store listing pack

Every string is ready to paste into Play Console → Grow → Store presence → Main store
listing. Nothing here describes a feature that is not in the shipping build.

## Text

| Field | Limit | Value |
| --- | --- | --- |
| App name | 30 | `HoloHunter` |
| Short description | 80 | see below |
| Full description | 4000 | see below |

**Short description (English, 68 chars):**

```
Unofficial card search and reference price companion for hololive TCG.
```

**Short description (繁體中文, 27 chars) — use if the default listing language is zh-TW:**

```
非官方 hololive TCG 卡牌查詢與參考價格工具
```

**Full description (English):**

```
HoloHunter is an unofficial, fan-made companion app for players and collectors of the
hololive OFFICIAL CARD GAME.

Search and browse
- Find cards by card number, member name, series or colour.
- Browse every booster pack and starter deck in one place.
- Open a card to see its full details, skills and artwork.

Reference prices
- See observed secondary-market reference prices for each card and its variants.
- Compare printings before you buy or trade.

Scan a card with your camera
- Point your camera at a card, or pick a photo from your library, and HoloHunter
  identifies it for you.
- Recognition runs on your device. The card image is not uploaded to our servers.
- Scanning requires a free account. Browsing and searching do not.

Collection and decks
- Track how many copies of each card you own.
- Build and edit decks, and check what a deck would cost.

More for players
- Read the rules tutorial if you are new to the game.
- Follow monthly tournament reports and deck analytics.

Prices shown are informational references gathered from public secondary-market listings.
They are not offers to buy or sell, and they will not always match what you pay.

HoloHunter is not affiliated with, endorsed by, or sponsored by COVER Corporation or the
official hololive OFFICIAL CARD GAME project. All card names, artwork and trademarks
belong to their respective owners.
```

**Full description (繁體中文):**

```
HoloHunter 是為 hololive OFFICIAL CARD GAME 玩家與收藏者製作的非官方輔助工具。

查詢與瀏覽
- 以卡號、成員名稱、系列或顏色搜尋卡片。
- 一次瀏覽所有擴充包與起始牌組。
- 開啟卡片查看完整資訊、技能與圖像。

參考價格
- 查看各卡片與其版本的次級市場參考價格。
- 交易或購買前先比較不同版本。

用相機掃描卡牌
- 用相機對準卡片，或從相簿選取照片，HoloHunter 會為你辨識。
- 辨識在您的裝置上完成，卡牌影像不會上傳到我們的伺服器。
- 掃描功能需要免費帳號；查詢與瀏覽不需要登入。

收藏與牌組
- 記錄你擁有的卡片數量。
- 建立與編輯牌組，並試算牌組價格。

更多功能
- 新手可閱讀規則教學。
- 追蹤每月賽事月報與牌組分析。

頁面顯示的價格為公開次級市場資訊之整理，僅供參考，並非買賣要約，也不保證與實際成交價相同。

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

**Provenance of the screenshots.** Captured with `adb exec-out screencap` from the
`com.dicoge.holohunter` build running on an Android 16 (API 36) emulator at 1080×2400,
then cropped to 1080×1920 because the raw 9:20 device aspect falls outside Play's
accepted range. They are unretouched captures of real app screens showing real card data
and real prices — no mockups, no composited device frames, no invented content.

Contents: the home screen with the set browser; search results for set hBP01 with
reference prices; a card detail page showing skills and market data; and the navigation
drawer showing the feature set. Every feature visible is shipping. Nothing shows a
premium, subscription or paywall surface, because none exists in this build.

**The feature graphic is generated**, not hand-drawn — rerun
`node scripts/generate-play-store-assets.mjs` after any wording or palette change. It uses
the app icon's navy-and-gold palette, carries a 非官方 · UNOFFICIAL badge, and deliberately
contains no card artwork.

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
