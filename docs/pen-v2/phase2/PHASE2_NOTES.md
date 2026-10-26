# DIC-1409 Phase 2 · v2 tokens + shared shell

Source of truth: `docs/pen-v2/holohunter-landing-v2-updated.pen` (SHA-256
`6fbf0c06b15d726573871357bd7119c4d0046aa5d6eb3949aa735bd727d9272f`, from Phase 1).

## Token module

`src/theme/tokensV2.ts` mirrors the Pen `SetVariables()` call verbatim:

- **Palette** — `bg #08080F`, `surface #12121D`, `surface-2 #1A1A2A`, `border #282838`, `app-bg #0A0A13`, `app-surface #14141F`, `app-elev #1C1C2B`, `accent #FF4D9D`, `accent-2 #3DE0FF`, `accent-3 #8B5CF6`, `text-primary #F6F6FB`, `text-secondary #9494B0`, `text-muted #6A6A85`
- **State** — default/hover/focus/disabled/loading/error (`#F6F6FB / #FFFFFF / #FF4D9D / #4B4B60 / #9494B0 / #F87171`) plus `coming-soon-bg/fg`
- **Category** — white/blue/green/red/purple/yellow
- **Typography** — display font `Outfit`, body font `Noto Sans TC`, 11-step scale (micro → hero)
- **Layout** — `min-touch 44`, `safe-mobile 20`, `content-desktop 1328`, `statusBar.height 54`, `appBar.height 56`, `bottomTab.height 84 / fab 64`, `cardTile 112×199 (art 112×156)`, `seriesCard 175×69`
- **Radii / spacing / shadows / gradients / opacity** — semantic aliases keyed off the same palette

`src/constants/index.ts::COLORS` now re-exports from `PALETTE_V2` (the legacy `#ff6b9d / #0f0f23 / #1a1a2e / #a0aec0` values are gone) so every screen that still imports the old symbol picks up the v2 palette automatically, without needing to be rewritten in this phase. Old text like `rarityU/#10b981` maps to `$c-green #34D399`, etc.

## Shared shell components (Web / Android / iOS via RN)

| Component | File | Pen source | Notes |
| --- | --- | --- | --- |
| `AppShell` | `src/components/shell/AppShell.tsx` | wraps StatusBar/AppBar/Content/BottomTabBar with app-bg | scrollable content clamped to `content-desktop 1328` |
| `AppBar` | `src/components/shell/AppBar.tsx` | `App Bar` (id `upe1D`, 390×56) | brand mark + title/subtitle + ≤3 actions |
| `AppStatusBar` | `src/components/shell/StatusBar.tsx` | `C / Status Bar` (id `lELzX`, 390×54) | time + signal/wifi/battery glyphs |
| `BottomTabBar` | `src/components/shell/BottomTabBar.tsx` | `C / Tab Bar` (id `H8TW7`, 390×96) | 4 labeled tabs + centered Scan FAB (64×64, pink gradient) |
| `CardTile` | `src/components/cards/CardTile.tsx` | `C / Card Tile` (id `mJyjf`, 112×199) | art foot with rarity + price, name below |
| `SeriesCard` | `src/components/cards/SeriesCard.tsx` | `C / Series Card` (id `E1cDY`, 175×69) | thumb + code + title |

## Navigation preservation

`SHELL_TAB_ROUTE_MAP` in `src/components/shell/tabRegistry.ts` keeps every drawer destination reachable through the bottom tab bar:

- `home → Home`
- `search → Search`
- `scan → Scan`
- `deck → DeckEditor`
- `me → Settings`

Ancillary routes (`SearchResults`, `CardDetail`, `Collection`, `TournamentReport`, `Watchlist`, `Tutorial`, `TutorialDetail`, `TutorialSimulation`, `Favorites`, `Login`) fold into the closest tab via `activeTabForRoute(route)` so deep links still highlight the correct tab without needing to rewrite the shipped drawer navigator this phase (Phase 3 wires the actual stack).

## Tests (mutation-sensitive)

`npm run test:shell-tokens` runs 15 assertions covering:

1. Palette / state / category colors match the Pen file to the exact hex.
2. Semantic tokens surface Pen-derived colors (`background=$app-bg`, `brand=$accent`, `focusRing=$state-focus`, `onBg=$text-primary`, …).
3. Layout numbers (min-touch, safe-mobile, content-desktop, status bar 54, app bar 56, tab bar 84, FAB 64, card tile 112×199 / art 156, series card 175×69).
4. Type scale (`body 15`, `hero 32`) + font families (`Outfit`, `Noto Sans TC`).
5. Gradient pairings (`brand pink→purple`, `pink→cyan`).
6. `SHELL_TAB_ROUTE_MAP` keeps the deep-link contract with `AppNavigator`.
7. `SHELL_TAB_LABELS` keep Pen labels (`首頁 / 搜尋 / 牌組 / 我的`).
8. `activeTabForRoute` covers every registered destination (14 routes).
9. `buildShellTabs` returns five ordered items and each `onPress` dispatches the right navigation destination.
10. Real react-native-web render (JSDOM) — `AppShell` mounts StatusBar/AppBar/content/BottomTabBar landmarks with expected testIDs.
11. Real render — `BottomTabBar` press dispatches the right route for every tab and the Scan FAB.
12. Real render — active tab exposes `aria-selected="true"`.
13. Real render — `CardTile` renders rarity + price + name at Pen-derived testID contract.
14. Real render — `SeriesCard` renders code + title.
15. (Includes state palette + fonts as separate assertion groups.)

Every test compares an exact value that comes from the Pen file: renaming a token, dropping a route, or swapping a color will flip a specific assertion, not just mutate a DOM count.

## Render evidence (390 / 768 / 1440)

`npm run render:shell-preview` writes self-contained HTML snapshots that inline the full react-native-web StyleSheet at each breakpoint:

- `shell-preview-mobile-390.html`
- `shell-preview-tablet-768.html`
- `shell-preview-desktop-1440.html`

`npm run render:shell-screenshots` opens each fixture in Puppeteer at the matching viewport (retina) and captures a PNG:

- `shell-render-mobile-390.png` — StatusBar, AppBar, scrollable content (CardTile + SeriesCard grid), BottomTabBar with 首頁 active + Scan FAB
- `shell-render-tablet-768.png` — same shell stretched to tablet width; tab bar and FAB stay pinned to bottom
- `shell-render-desktop-1440.png` — full desktop breakpoint; content clamped to `content-desktop 1328`, shell chrome fills the width

## Files touched this phase

| Kind | Path |
| --- | --- |
| tokens | `src/theme/tokensV2.ts` (new) |
| tokens | `src/theme/index.ts` (new) |
| shell | `src/components/shell/AppShell.tsx` (new) |
| shell | `src/components/shell/AppBar.tsx` (new) |
| shell | `src/components/shell/StatusBar.tsx` (new) |
| shell | `src/components/shell/BottomTabBar.tsx` (new) |
| shell | `src/components/shell/tabRegistry.ts` (new) |
| shell | `src/components/shell/index.ts` (new) |
| cards | `src/components/cards/CardTile.tsx` (new) |
| cards | `src/components/cards/SeriesCard.tsx` (new) |
| cards | `src/components/cards/index.ts` (new) |
| migration | `src/constants/index.ts` (COLORS re-routed through PALETTE_V2) |
| test | `scripts/test-shell-tokens-parity.mjs` (new) |
| render | `scripts/render-shell-preview.mjs` (new) |
| render | `scripts/render-shell-screenshots.mjs` (new) |
| package | `package.json` (`test:shell-tokens`, `render:shell-preview`, `render:shell-screenshots` scripts) |
| evidence | `docs/pen-v2/phase2/shell-preview-*.html` |
| evidence | `docs/pen-v2/phase2/shell-render-*.png` |
| notes | `docs/pen-v2/phase2/PHASE2_NOTES.md` |
