# DIC-1409 Phase 7 · Landing 1440 / 390 parity on the Pen v2 composition

Source of truth: `docs/pen-v2/holohunter-landing-v2-updated.pen` (SHA-256
`6fbf0c06b15d726573871357bd7119c4d0046aa5d6eb3949aa735bd727d9272f`), frames
`XwzSU` (HoloHunter Landing / Desktop 1440, 1440×6724) and `D2SGVB`
(HoloHunter Landing / Mobile 390, 390×6555), read node-by-node through
Pencil MCP this session (`claude mcp list` → pencil ✓ Connected). Started
from exact accepted head `b1d9f5ea694858b50b8af9b24344fc7f1d514c2d`.

## Named regressions → fixes (issue §實作範圍 6)

| Regression named in DIC-1409 | Pen anchor | Fix in `src/screens/LandingScreen.tsx` |
| --- | --- | --- |
| Hero 圖像構圖 | `z5AkG` (Card Left `uR7Wd` / Center `ntKk3` / Right `LFnFH`) | Tilted three-card trio on a fixed 640×560 canvas (−9° / +2° / +9°), Pen-anchored bundled card art, catalog number + UR badge meta bars, floating 主牌組合法性 43/50 chip with donut ring and floating 星街すいせい price chip with the pink sparkline. Canvas scales proportionally 768→1440 so nothing clips. |
| 光影深度 | `Rlx6E` glow layers | Web `backgroundImage` radial glows (cyan/pink/purple) behind the hero, per-card colored shadow glows, CTA pink shadow bloom; native falls back to the shell's solid-color pattern. |
| 價格視覺 | `N8ds5T` / `PPAfW` | Full chart card: thumb + 星街すいせい / UR header, 7D/30D/90D segmented control (30D desktop / 7D mobile per Pen), NT$ 3,600 + green Δ chip, 13-bar chart with gradient-highlighted newest bar + 3,600 label + date axis, 買入成本 cell, truthful 店家收購/買賣差價/價格趨勢預測 即將推出 cells. Replaces the old text price rows. |
| 搜尋 mockup | `hUcaS` first bento cell | Search mockup card: ⌕ input with すいせい + accent caret, 藍/Holomen/hBP04/有平行版/SR 以上 filter chips (active/outline states), 6-tile result grid, clipped at the card edge per Pen. |
| 牌組面板 | `voo0h` / `RzGa0` | Deck-builder panel: 白上フブキ Buzz + 草稿 pill, 缺卡預估總額 NT$ 2,140, four progress rows with Pen color tokens ($accent/$accent-3/$accent-2/$c-yellow) and 有 x / 需 y counts, 還缺的 7 張 + 套用低價版本, placeholder tile row. |
| CTA | `A4YPK` / `QumbV` | Gradient pink→purple primary pill（以訪客登入 →）with glow, dark Google pill with G badge（使用 Google 帳號開始（即將推出）), white 登入 nav pill per Pen `xFOCN`, and the Final CTA gradient card（先從查一張卡開始）with tilted translucent shapes. |
| 字級/留白 | frame metrics | Desktop sections now 96px vertical rhythm at 1440 content width, 42/54 section headlines, 56/68 hero headline, section eyebrow pills (tinted, per-section color) replacing bare uppercase labels; flat stats strip per `vfBpS`/`ufjjN` (bordered stat cards removed). |

Additional Pen parity: bento features grid (`GAolm`) with icon-tile cards,
colored 01/02/03 step chips (`ZpbU9`), Pen plans composition (訂閱會員 +
即將推出, gradient free CTA), FAQ split accordion (`e2W4Rq`) with REAL
expand/collapse state (desktop first-open, mobile all-open per `QNfNX`),
Pen column footer (`TldCK`/`r86yeO`) with brand block + 產品/資源/關於.

## Truthful-copy decisions (Phase 6 precedent)

- Free-plan features keep the reviewed list (Pen's would overclaim
  買賣差價/趨勢預測, both 即將推出).
- FAQ keeps the four reviewed Q&As (Pen's fifth answer asserts specific
  report months) presented in the Pen accordion composition.
- All sync claims retain their build-gate qualifiers; coming-soon
  surfaces (Google login, 訂閱會員, 店家收購, 買賣差價, 價格趨勢預測)
  never render fabricated values.

## Real wiring (unchanged)

Guest + Google CTAs (nav, hero, plans, final CTA) drive the real
`useAuthStore` (`continueAsGuest` / `loginWithGoogle` with loading +
error + dismiss states); legal/pricing/support links open the shipped
static pages; burger menu + FAQ accordion are real component state;
`AppNavigator` routing untouched.

## Tests

`test:landing-pen-render` rewritten for the Pen v2 composition — 37
checks: Pen-file-derived section order (desktop + mobile), hero `<Image>`
anchors derived from the Pen image fills, chart card (values, segments,
axis, truthful coming-soon cells), deck panel (rows, counts, totals),
search mockup chips, floating hero chips, mobile price card, a REAL FAQ
accordion toggle mutation, footer columns, sync-copy gate (qualifier
list extended with 僅限啟用), Store-MVP truth checks.

Full affected battery green: landing-pen-render 37 · shell-tokens 15 ·
app-shell 10 · app47-shell 8 · app812-shell 5 · app1316-shell 5 · i18n 32 ·
search-results-layout 23 · scan-screen-fail-safe 37 · store-mvp-fail-closed
216 · store-mvp-behavior 149 · store-mvp-ui-gates 104 ·
apple-delete-truth-copy 56 · legal-copy-vs-behavior 29 · auth-strategy 6 ·
auth-error-map 8. `npx tsc --noEmit`: the same 2 pre-existing errors
(CardTile/SeriesCard createElement union overload) — none introduced.

## Render evidence (390 / 768 / 1440)

`npm run render:landing` + `render:landing-screenshots` → HTML fixtures +
viewport and full-page PNGs per breakpoint in `docs/pen-v2/phase7/`
(bundled Pen-anchored card art resolved into the fixtures). The screen
renders the real signed-out auth store.
