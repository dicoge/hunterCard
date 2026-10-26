# DIC-1409 Phase 3 · App 01–03 on the shared Pen v2 shell

Source of truth: `docs/pen-v2/holohunter-landing-v2-updated.pen` (SHA-256
`6fbf0c06b15d726573871357bd7119c4d0046aa5d6eb3949aa735bd727d9272f`), frames
`tmKqY` (App / 01 首頁), `Z6jlE` (App / 02 搜尋結果), `o7WO3r` (App / 03 卡牌詳情),
re-read live through Pencil MCP this turn (`claude mcp list` → pencil ✓ Connected).

## What changed

### App 01 首頁 — `src/screens/HomeScreen.tsx` (rewritten on the shell)

- `AppShell` + brand `AppBar` (bell → Watchlist, gear → Settings, brand mark →
  `openDrawer`) + `BottomTabBar` with 首頁 active. Drawer header hidden for Home
  only; the drawer itself stays reachable via the brand mark.
- Search field per Pen node `BxPhh` ($app-elev, r14, 46h) → navigates `Search`.
- Quick Actions per node `OJimN`: 掃描卡牌 / 賽事月報 / 規則教學 / 入手提醒 tiles
  ($app-surface, r14, accent glyphs) → `Scan` / `TournamentReport` / `Tutorial` /
  `Watchlist`; the watchlist tile ships behind the same `FEATURES.watchlist`
  flag that registers its route.
- 依顏色快速篩選 per node `gfXsp`: six flex chips (dot = `$c-*` category color,
  Pen labels 白藍綠赤紫黃) → `SearchResults` with the shipped query vocabulary
  (白色/藍色/綠色/紅色/紫色/黃色 — `COLOR_TO_CN` resolves both 藍色 and 青色).
- ブースターパック / スタートデッキ / 特殊・PR sections render `SeriesCard`
  (Pen `C / Series Card`, new `fluid` prop for grid cells; 2 cols mobile,
  4 cols desktop) from the same `buildSeriesCatalog` production path
  (DIC-972 contract intact — the guest-data regression still passes).
  Section heads carry the Pen「全部 N」count.
- Data wiring unchanged: `loadDatabaseJson`/`loadSeriesNamesJson` module cache,
  plus a `__seedHomeSeriesCacheForTest` seam (same pattern as SearchResults).

### App 02 搜尋結果 — `src/screens/SearchResultsScreen.tsx` (shell wrap)

- Every branch (loading / error / empty / results) renders inside `AppShell`:
  back arrow (Pen node `A2SWo`) → `goBack`, live query as the app-bar title
  (node `j5Et8`), `BottomTabBar` with 搜尋 active.
- Result-count row restyled to Pen node `xKkbE` (15/700 + 13/600).
- The DIC-1150/1192 contracts are untouched: same `FlatList`, `gridItemStyle`,
  `CardListItem`, testIDs, exports, and geometry — all 23 layout tests and both
  ◇-color renders still pass. `searchCards` is now exported for the
  render-evidence scripts (real-data previews only, no fixture data).

### App 03 卡牌詳情 — `src/screens/CardDetailScreen.tsx` (shell wrap + Pen fixes)

- `AppShell` with back arrow + card number in the app bar (Pen node `QhPGe`)
  and an external-link action → 官方卡表 (node `CE6L7`); no bottom tab bar,
  matching the Pen frame.
- Pen→Preview regressions fixed: price value now 30/700 Outfit on
  `$text-primary` (node `x0c32A`) instead of legacy mint green; price block is
  a `$app-surface` r16 card (node `qJqlm`); card name 21/800 (node `HMarO`).
- Every Store-MVP gate keeps its exact structure (`FEATURES.favorites &&
  collectionVersion`, `FEATURES.marketData && (<View …priceSection`,
  `FEATURES.marketData && <MarketDataPanel`, external links, both watchlist
  wrappers) — all 76 UI-gate checks + 149 behavior checks pass.

### Navigation — `src/navigation/AppNavigator.tsx`

`headerShown: false` for Home (drawer) and CardDetail / SearchResults (stack)
only; no route added or removed, deep links unchanged.

### i18n

New `common_back` key (zh 返回 / ja 戻る) for the shell back arrows; key parity
and the 32-check i18n suite pass.

## Tests (mutation-sensitive)

`npm run test:app-shell` — 10 asserts pinned to Pen values and navigation
contracts (shell landmarks + active tab, Pen $app-elev/r14 search field,
quick-action dispatch order, six Pen chip labels + `#4C8DFF` blue + query
payloads, SeriesCard catalog rendering + navigation, query-in-app-bar +
搜尋-active + grid items, goBack dispatch ×2, no tab bar on detail,
30px/700/#F6F6FB price value). Wired into CI next to `test:shell-tokens`.

Existing suites re-run green: search-results-layout (23), dic1159 (26),
i18n (32), store-mvp-ui-gates (76), store-mvp-behavior (149), dic1141 ×2,
dic1086, card-data-correctness, dic-361, native-guest-data, shell-tokens (15).
`npx tsc --noEmit`: 2 pre-existing errors (CardTile/SeriesCard createElement
union overload, present at HEAD with 3) — none introduced.

## Render evidence (real screens, real data)

`npm run render:app-screens` renders the shipped HomeScreen /
SearchResultsScreen / CardDetailScreen through react-native-web + JSDOM — real
bundled database (3 622 cards), real `searchCards` mapper (query すいせい → 23
cards; detail card hBP01-081 星街すいせい), one process per breakpoint so
`useWindowDimensions` sees the true viewport. `npm run render:app-screenshots`
captures 390 / 768 / 1440 PNGs in Puppeteer (retina):

- `app01-home-render-{mobile-390,tablet-768,desktop-1440}.png`
- `app02-search-results-render-{mobile-390,tablet-768,desktop-1440}.png`
- `app03-card-detail-render-{mobile-390,tablet-768,desktop-1440}.png`

Known limitations (honest): status-bar glyphs render as boxes in headless
Chrome (font fallback); card art loads from the official CDN at capture time;
search result rows keep the information-dense DIC-1150 list layout (number,
Bloom badge, colors, effects) on the v2 tokens rather than the Pen 3-up
`C / Card Tile` grid — swapping to tiles would delete contract-tested identity
info, so tile-grid adoption is deferred to a PM call.
