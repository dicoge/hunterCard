## HoloHunter Landing v2 · Pen Frame Inventory (Phase 1 output)

Source `.pen`: `docs/pen-v2/holohunter-landing-v2-updated.pen`
SHA-256: `6fbf0c06b15d726573871357bd7119c4d0046aa5d6eb3949aa735bd727d9272f`

Base file (uploaded to DIC-1409 as attachment `holohunter-landing-v2.pen`) already contained 13 top-level nodes: Desktop Landing 1440, Mobile Landing 390, 7 App screens (01–07), 4 shared components. Phase 1 adds 9 new App frames for the routes the app already ships (Collection, Favorites, TournamentReport, Watchlist, Tutorial, TutorialDetail, TutorialSimulation, Settings, Login/Auth) using the same shell (StatusBar / TabBar / AppBar) and tokens.

All new frames are 390 × 844 with `fill: $app-bg`, `clip: true`, and use the v2 tokens (`$accent #FF4D9D`, `$accent-2 #3DE0FF`, `$accent-3 #8B5CF6`, `$app-bg #0A0A13`, `$app-surface #14141F`, `$app-elev #1C1C2B`, `$border #282838`, fonts `Outfit` / `Noto Sans TC`).

### Full inventory after Phase 1

| # | ID | Name | Size | Preview |
| - | --- | --- | --- | --- |
| 1 | `XwzSU` | HoloHunter Landing / Desktop 1440 | 1440 × 6724 | `XwzSU.png` |
| 2 | `D2SGVB` | HoloHunter Landing / Mobile 390 | 390 × 6555 | `D2SGVB.png` |
| 3 | `lELzX` | C / Status Bar | 390 × 54 | `lELzX.png` |
| 4 | `H8TW7` | C / Tab Bar | 390 × 96 | `H8TW7.png` |
| 5 | `mJyjf` | C / Card Tile | 112 × 199 | `mJyjf.png` |
| 6 | `E1cDY` | C / Series Card | 175 × 69 | `E1cDY.png` |
| 7 | `tmKqY` | App / 01 首頁 | 390 × 844 | `tmKqY.png` |
| 8 | `Z6jlE` | App / 02 搜尋結果 | 390 × 844 | `Z6jlE.png` |
| 9 | `o7WO3r` | App / 03 卡牌詳情 | 390 × 844 | `o7WO3r.png` |
| 10 | `eurld` | App / 04 掃描卡牌 | 390 × 844 | `eurld.png` |
| 11 | `wC1cO` | App / 05 掃描估值清單 | 390 × 844 | `wC1cO.png` |
| 12 | `uXuqo` | App / 06 牌組編輯器 | 390 × 844 | `uXuqo.png` |
| 13 | `siVsa` | App / 07 我的 | 390 × 844 | `siVsa.png` |
| 14 | `ej9RF` | App / 08 收藏 (Collection) — NEW | 390 × 844 | `ej9RF.png` |
| 15 | `sSDxQ` | App / 09 我的最愛 (Favorites) — NEW | 390 × 844 | `sSDxQ.png` |
| 16 | `wRgD8` | App / 10 賽事月報 (TournamentReport) — NEW | 390 × 844 | `wRgD8.png` |
| 17 | `VyzfW` | App / 11 到價提醒 (Watchlist) — NEW | 390 × 844 | `VyzfW.png` |
| 18 | `DAQIq` | App / 12 規則教學 (Tutorial) — NEW | 390 × 844 | `DAQIq.png` |
| 19 | `rV4Za` | App / 13 教學詳情 (TutorialDetail) — NEW | 390 × 844 | `rV4Za.png` |
| 20 | `I6WwjY` | App / 14 教學模擬 (TutorialSimulation) — NEW | 390 × 844 | `I6WwjY.png` |
| 21 | `x44r8t` | App / 15 設定 (Settings) — NEW | 390 × 844 | `x44r8t.png` |
| 22 | `p28zL` | App / 16 登入 (Login/Auth) — NEW | 390 × 844 | `p28zL.png` |

### Phase 1 per-route notes

- **08 Collection** — Stats hero (total value + delta chip + 3 metric cells), Cards/Decks/History underline tabs, 2-column card grid via `C / Card Tile` refs. Reuses `$app-surface`/`$app-elev` for card layering. Tab bar 牌組 active.
- **09 Favorites** — Pill filter chips (全部/卡牌/套牌/賽事, active uses `$accent` fill), sort control, list rows with 44×60 art + name + code + price + colored delta. Tab bar 我的 active.
- **10 TournamentReport** — Month navigator, purple-gradient hero with 本月熱門卡 (採用/4 強/優勝), bar chart bound to color tokens (`$c-white/purple/red/green/blue/yellow`), 1/2/3 medal podium rows. Tab bar 首頁 active.
- **11 Watchlist** — `$accent-2` info banner (last sync + source), underline tabs, list rows with price vs. target, status badges tinted by `$c-green` / muted / `$c-red`. Tab bar 首頁 active.
- **12 Tutorial** — Purple→pink gradient hero with progress bar (3/5 chapters), 5-chapter list with numbered chip + completed/active/locked icon states, 2-tile 熱門教學 row. Tab bar 首頁 active.
- **13 TutorialDetail** — Breadcrumb + gradient hero card (icon tile + CHAPTER 04 label + meta + progress line), 4-step navigator with completed/active/pending pills, article card with 開始模擬 (primary `$accent`) and 完整文字 buttons. Tab bar 首頁 active.
- **14 TutorialSimulation** — Turn bar (turn number + HP), duel board (opponent row + Turn Track divider + your row) with center-card ring and `BUZZ` chips on Buzz slots, `$accent` hint banner, 出手 (primary) / 防禦 / 跳過 action row. Tab bar 首頁 active.
- **15 Settings** — Account card (gradient avatar + Premium chip), 3 grouped sections (帳號/偏好/應用) with icon + label + right value + chevron/toggle. Toggle states use `$accent` on / muted off. Tab bar 我的 active.
- **16 Login/Auth** — Radial background glow, gradient logo tile with `crosshair` icon + shadow, headline stack, primary Google (white) + Apple (black) + email options, secondary Guest link, terms footer. No tab bar (auth flow full-bleed).

### Design tokens (from `GetVariables()`)

```
bg #08080F  surface #12121D  surface-2 #1A1A2A  border #282838
text-primary #F6F6FB  text-secondary #9494B0  text-muted #6A6A85
accent #FF4D9D  accent-2 #3DE0FF  accent-3 #8B5CF6
app-bg #0A0A13  app-surface #14141F  app-elev #1C1C2B
state-default/hover/focus/disabled/loading/error
coming-soon-bg #3D2547  coming-soon-fg #FFB4D9
c-white #E4E4EE  c-blue #4C8DFF  c-green #34D399
c-red #F87171  c-purple #C084FC  c-yellow #FBBF24
font-display Outfit  font-body Noto Sans TC
min-touch 44  safe-mobile 20  content-desktop 1328
```

### Known caveats to fix later phases

- Card art tiles (`Card Tile` / `Series Card` refs) reference `images/*.png` URLs that only resolve in the pen file's asset registry; screenshots show these as transparent checkerboard. Not a design defect — the pen-side asset registry stays as-is; RN layer will bind to the app's real card image loader.
- Phase 1 did NOT run a full refinement pass on the 9 existing frames or 4 shared components. The user comment allows multi-turn progressive push, so the refinement pass is queued as part of Phase 1 sign-off in Phase 2 kickoff — the existing frames still render at v1 quality, which the PM already accepted as a starting baseline.
- New frames intentionally do not include a `Hero` for App/15 Settings and App/16 Login/Auth (those routes are functional lists / full-bleed flows in the reference design language).
