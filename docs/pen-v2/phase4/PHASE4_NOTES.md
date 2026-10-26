# DIC-1409 Phase 4 · App 04–07 on the shared Pen v2 shell

Source of truth: `docs/pen-v2/holohunter-landing-v2-updated.pen` (SHA-256
`6fbf0c06b15d726573871357bd7119c4d0046aa5d6eb3949aa735bd727d9272f`), frames
`eurld` (App / 04 掃描卡牌), `wC1cO` (App / 05 掃描估值清單), `uXuqo`
(App / 06 牌組編輯器), `siVsa` (App / 07 我的), re-read live through Pencil
MCP this turn (`claude mcp list` → pencil ✓ Connected).

## origin/main integration (before Phase 4 code)

- Merge base was `9e96afd3b9c1`; current main `eb5c6912418f` (DIC-1380 W1–W14:
  LandingScreen, account sync services, favorites store, Pen-uXuqo DeckEditor
  mobile layout, fail-closed STORE_MVP default, card display-name resolver).
- Merge commit `2ab628fd5` integrates main into the branch.
  `git diff --diff-filter=D --name-only origin/main HEAD` → **0 deletions**:
  nothing from current main is dropped; the branch diff vs main is exactly the
  Pen v2 Phase 1–4 work.
- One follow-up (`a6f144b40`): DIC-1380 made STORE_MVP fail-closed on every
  platform when the env is unset, so `test-app-shell-parity.mjs` now pins
  `EXPO_PUBLIC_STORE_MVP=0` explicitly (same pattern as
  test-store-mvp-behavior). App behavior unchanged.
- Post-merge, main's own new suites pass on the merged tree:
  store-mvp-fail-closed 216 · landing-pen-render 30 · favorites-nav-route 11 ·
  favorites-ui-wiring 4 · deck-editor-name-resolver 3 ·
  deck-editor-pen-mobile-layout 13 · card-display-name 13 ·
  account-sync-client 14.

## Route matrix (Pen node → code)

| Route | Pen frame / nodes | Change |
| --- | --- | --- |
| App 04 掃描卡牌 (`ScanScreen` → `ScanOverlay`) | `eurld`: scan frame `Aj73G` (portrait 250×350, r16, #FFFFFF08), corners `K3Ja4K…` (32px white, r10), hint `RrYjs` (14/600), tips `Cc84X` (#FFFFFF0F pills), mode switch `Cys7V` (#00000080 pill, active #FFFFFF1F), controls `TOYLP`/`AQf9b` (#FFFFFF14 r14 boxes), shutter `TbHVE` (72px accent) | ScanOverlay restyled to those exact values: portrait card window (`SCAN_AREA_HEIGHT = SCAN_AREA_SIZE * 1.4` — crop pipeline reads onLayout, so recognition follows), white corner brackets, three tip chips (existing `scan_tip_number/glare/flat` keys), segmented 自動掃描/手動 switch on the same `onToggleAutoScan` contract, Pen control boxes + 72px accent shutter. The DIC-1294/1296 Animated two-node structure is untouched (fail-safe suite: 37 asserts). |
| App 05 掃描估值清單 (`ScanSessionPanel`) | `wC1cO`: summary `Ahd5w` ($app-surface r16), value `ekhnv` ($text-primary), prices (`jifqD` $accent-2), warning `yo1XN` (#D6B25A), action bar `Y1xPi` | Token restyle on the same structure/testIDs: panel surface `#12121DF2`, session prices on `$accent-2 #3DE0FF` (legacy `#00C853` green removed), pending-version warning on Pen amber, active version chips on `$accent`. All session logic (addCard/removeCard/setCardVersion/clearSession/copy) untouched. |
| App 06 牌組編輯器 (`DeckEditorScreen`) | `uXuqo`: Status Bar `W1wiV`, Tab Bar `Ta1pp` (牌組 active), app bar `R8I4w`, zone tabs `AMhtu`, missing bar `QUFqI` | Main's DIC-1380 editor already carries the Pen app bar / status banner / zone tabs / grid / missing bar — Phase 4 mounts it inside the shared `AppShell` (status bar + bottom tab bar, 牌組 active; shared AppBar disabled in favor of its own Pen app bar) and hides the now-redundant drawer header. Editor internals byte-identical; all deck suites pass unchanged. |
| App 07 我的 (`SettingsScreen`) | `siVsa`: app bar `xQIU2` (我的 18/800), account card `ZYJRw` ($app-surface r16, 44px gradient avatar), stats `vGwTI` ($app-surface r13 tiles), Tab Bar 我的 active | Wrapped in `AppShell` (我的 app bar + tab bar) and given the Pen account card (real auth store: display name / primary email / linked-provider badges, guest fallback) + stats tiles fed by the real deck-store collection count and price-alert count, gated on the same FEATURES flags. The Pen 收藏市值 tile is intentionally NOT rendered — no price join exists on this surface and a number would be mock data. Every pre-existing section (language / currency / price sources / account auth / delete disclosure) is byte-preserved. |
| Navigation | — | `headerShown:false` added for DeckEditor + Settings only (their shells now provide chrome). Scan keeps its drawer header this phase — its Pen top bar (close/quota/flash) is deferred with the full-camera pass, and removing the header now would orphan the route's exit affordance. No route added/removed. |

## Tests

New `npm run test:app47-shell` — 8 mutation-sensitive asserts (Pen portrait
frame constants + white 32px corners, tips row ×3 + segmented mode switch with
selected-state aria + inactive-only toggle dispatch, session panel on the real
scanSessionStore with `$accent-2` price + expanded summary/copy nodes,
DeckEditor inside the shell with 牌組 active + DIC-1088 library grid intact,
我的 shell + account card + real-store stat tiles + retained settings surface +
tab dispatch). Wired into the same CI step as Phases 2–3
(`test:shell-tokens && test:app-shell && test:app47-shell`).

One existing assertion updated with justification:
`test-scan-screen-fail-safe.mjs` pinned the historical landscape ratio
(`height: SCAN_AREA_SIZE * 0.63`); its invariant — the pulse wrapper owns the
same explicit layout box as the border frame — is now asserted directly
against the shared `SCAN_AREA_HEIGHT` on BOTH nodes, so the protection is
stronger, not weaker.

`scripts/fixtures/native-module-stub.mjs` gained expo-camera named exports
(`CameraView`/`useCameraPermissions`/`CameraType` no-ops) so the render
evidence can import the real ScanScreen under node; the web render path never
mounts CameraView.

Full battery after all Phase 4 edits (all green): app-shell 10 ·
app47-shell 8 · shell-tokens 15 · search-results-layout 23 · i18n 32 ·
scan-screen-fail-safe 37 · store-mvp-fail-closed 216 · store-mvp-behavior 149 ·
store-mvp-ui-gates 104 · deck-editor-pen-mobile-layout 13 · dic1159 26 ·
dic1086 · native-guest-data · landing-pen-render 30.
`npx tsc --noEmit`: the same 2 pre-existing errors as HEAD-before-merge
(CardTile/SeriesCard createElement union overload) — none introduced.

## Render evidence (390 / 768 / 1440, real stores)

`npm run render:app47` + `npm run render:app47-screenshots` → 15 PNGs + HTML
fixtures in `docs/pen-v2/phase4/`:

- `app04-scan-*` — the shipped ScanScreen. Honest caveat: headless DOM has no
  camera, so this capture shows the real initializing state; the Pen App/04
  chrome is therefore also captured from the same shipped ScanOverlay in its
  camera-ready state (`app04-scan-overlay-*`).
- `app05-scan-session-*` — real scanSessionStore with three real database
  cards added through `addCard` (hBP01-081 / hBP01-007 / hBP03-044), panel
  expanded; version chips, pending states, currency selector all live.
- `app06-deck-editor-*` — real deckStore deck (`createDeck` + `setActiveDeck`)
  in the editor: Pen app bar, zone tabs with counts, real 155-card 推し picker
  from the bundled database, missing bar, shared tab bar.
- `app07-me-*` — shipped SettingsScreen, guest auth state, with account card,
  stat tiles, and the full settings surface.
