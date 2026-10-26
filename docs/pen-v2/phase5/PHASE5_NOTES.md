# DIC-1409 Phase 5 · App 08–12 on the shared Pen v2 shell

Source of truth: `docs/pen-v2/holohunter-landing-v2-updated.pen` (SHA-256
`6fbf0c06b15d726573871357bd7119c4d0046aa5d6eb3949aa735bd727d9272f`), frames
`ej9RF` / `sSDxQ` / `wRgD8` / `VyzfW` / `DAQIq`, re-read live through Pencil
MCP this turn (`claude mcp list` → pencil ✓ Connected). Started from exact
head `62235499d5a1b8bc43cd6ceb063c4146b125f1ff`.

## Shared piece

`src/components/shell/RouteShell.tsx` (new) — the chrome every App/08–16 Pen
frame shares: back arrow + title app bar (Pen nodes `kINuV`/`E0HjM5`/`gGf2d`/
`WLytG`/`tTuQW`), status bar, bottom tab bar with the tab `activeTabForRoute`
folds the route onto (single source: tabRegistry). Screens keep their own
content containers; RouteShell only supplies the shell.

## Route / Pen-node / data-binding matrix

| Route | Pen frame | Shell fold | Data binding (unchanged) |
| --- | --- | --- | --- |
| Collection (`CollectionScreen`) | `ej9RF` App/08 收藏 — app bar `kINuV`, grid `uXy4N` | 牌組 tab | real deck-store ownership map + real card catalog (`loadCardDatabase`); search/filter/quantity contracts (DIC-1086 testIDs `collection-search`/`collection-filters`/`collection-card-*`) intact |
| Favorites (`FavoritesScreen`) | `sSDxQ` App/09 我的最愛 — app bar `E0HjM5`, list `TezuV` | 我的 tab | real `useFavoritesStore` rows; removeFavorite still stamps the DIC-1380 sync tombstone (asserted in the new suite) |
| TournamentReport (`TournamentReportScreen`) | `wRgD8` App/10 賽事月報 — app bar `gGf2d` | 首頁 tab | real `/data/tournaments/*` artifacts, truth/freshness semantics untouched (41-test suite green). `useNavigation()` swapped for the `NavigationContext` read — the exact DIC-1380 W8 pattern DeckEditor uses — so harness renders don't throw; in-app behavior identical |
| Watchlist (`WatchlistScreen`) | `VyzfW` App/11 到價提醒 — app bar `WLytG`, list `UvZuq` | 首頁 tab | real price-alert store; exact-printing fail-closed pricing untouched (alert rows truthfully show 暫無資料 when the printing has no reference price) |
| Tutorial (`TutorialScreen`) | `DAQIq` App/12 規則教學 — app bar `tTuQW`, chapters `ccVfh` | 首頁 tab | shipped tutorial dataset + `TutorialDetail` navigation params unchanged |

Navigator: `headerShown:false` for these five routes only (their shells now
provide the chrome). No route added/removed; the Store-MVP gates around the
Favorites/Collection/Watchlist `Drawer.Screen` registrations are untouched
(104-check ui-gates suite green).

Pen fields without a real backing value are omitted, not fabricated: the
App/08 stats-hero 總價值 metrics, App/09 sort control and per-row prices, the
App/10 month-nav arrows (the real month chips already cover scoping), and the
App/11 命中/未達 tabs (no hit-state field exists in the alert store) are all
left out per the no-invented-values rule.

## Tests

New `npm run test:app812-shell` — 5 mutation-sensitive tests: shell landmarks
+ correct active tab per tabRegistry for every route; Favorites real-store row
render, back-dispatch, and a real removeFavorite mutation; Collection DIC-1086
search contract inside the shell; Watchlist real empty-state actions; Tutorial
real section cards dispatching `TutorialDetail` with a real `sectionId`;
TournamentReport shell title. Wired into the DIC-1409 CI step
(now `test:shell-tokens && test:app-shell && test:app47-shell && test:app812-shell`).

Full affected battery green after all edits: favorites-nav-route 11 ·
favorites-ui-wiring 4 · tournament-report 41 · tournament-donut 39 ·
tournament-deck-import 88 · price-alerts 25 · alert-unification 25 · i18n 32 ·
app-shell 10 · app47-shell 8 · app812-shell 5 · shell-tokens 15 ·
search-results-layout 23 · dic1086 · store-mvp-ui-gates 104 ·
store-mvp-behavior 149 · store-mvp-fail-closed 216.
`npx tsc --noEmit`: the same 2 pre-existing errors (CardTile/SeriesCard
createElement union overload) — none introduced.

## Render evidence (390 / 768 / 1440, real stores/data)

`npm run render:app812` + `render:app812-screenshots` → 15 PNGs + fixtures in
`docs/pen-v2/phase5/`. Favorites/ownership/alert entries are created through
the real store APIs against real database cards; the alert's target range is
the same user input the real editor collects. TournamentReport renders the
real committed `/data/tournaments` artifacts (served from `public/` in the
offline harness exactly as the site serves them). No mock values anywhere:
where the store has no data the capture shows the screen's real empty state.
