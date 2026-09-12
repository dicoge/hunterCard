# DIC-1409 CR-fix · Mac-Codex FAIL blockers at `da98d1d43…`

## [P0] TS2769 / Validate gate

`CardTile.tsx` / `SeriesCard.tsx` fed a `TouchableOpacity | View` union
into `React.createElement`, which TypeScript cannot overload-resolve.
Both now render conditional JSX (pressable vs static container) with
identical props, styles, and testIDs. `npx tsc --noEmit` is **0 errors**
— the previously "pre-existing" pair included (the CR correctly
established they were introduced by this PR's Phase 2).

## [P1] Bottom-tab navigation from root-stack screens

`buildShellTabs()` navigated to bare drawer-child names, which are
unresolvable from `SearchResults` / `TutorialDetail` /
`TutorialSimulation` (root-stack children) — presses were silently
unhandled. Fix: `navigation.navigate('MainDrawer', { screen })`, which
React Navigation resolves from both drawer children and root-stack
screens.

New `test:shell-tab-navigation` mounts `NavigationContainer` + the REAL
exported `StackNavigator` (root stack + MainDrawer + every shipped
screen — no stubs) and proves: Home→搜尋 tab→Search (drawer context),
SearchResults→首頁 tab→Home, TutorialDetail→牌組 tab→DeckEditor (stack
contexts), asserting `getCurrentRoute()` and mounted screen content
after real DOM clicks. Stub-level assertions in `shell-tokens` /
`app47-shell` updated to the nested contract.

## [P1] Search + Scan routes off legacy UI

- **SearchScreen** (搜尋 tab landing): rebuilt on the shared `RouteShell`
  + v2 tokens (Pen `BxPhh` $app-elev r14 field idiom, accent action,
  surface cards, pill suggestions). All real wiring preserved: query
  state, submit → `SearchResults(query)`, four suggestion taps.
  `headerShown: false` (RouteShell owns the chrome).
- **ScanScreen**: new shared `ScanTopBar` (Pen `x7iIL`: Close ✕ / REAL
  quota pill / Flash) renders on the live-camera overlay AND every
  pre-camera surface (web permission gate, gallery mode). `ScanQuotaBanner`
  restyled from the legacy COLORS banner into the Pen `LQDgk` pill —
  every state branch (premium-unlimited, guest, low, exhausted, role
  tag) behavior-identical. Flash moved from the bottom controls into the
  top bar per Pen (same real `onFlash`); Close dispatches nested
  MainDrawer/Home. Pre-camera surfaces restyled to v2 tokens.
  `headerShown: false` (the route owns its Pen top action row; the
  drawer header was double chrome).
- New `test:scan-search-shell` (4 checks) renders the REAL screens:
  RouteShell + Pen idioms on Search, real suggestion-tap navigation
  mutation, Pen top bar + real quota pill on the shipped ScanScreen
  pre-camera state with a real close-navigation mutation, and the
  live-camera overlay's top bar + real flash dispatch.
- Render evidence in this directory captures the REAL routes as shipped
  (no synthetic composition): `search-render-{mobile-390,tablet-768,
  desktop-1440}.png` + `scan-precamera-render-mobile-390.png` (the
  route's true state in a camera-less browser; live-camera chrome is
  proven behaviourally by the suite above).

Both new suites are wired into the CI DIC-1409 step.

## Battery at this head (all green)

shell-tokens 15 · app-shell 10 · app47-shell 8 · app812-shell 5 ·
app1316-shell 5 · shell-tab-navigation 4 · scan-search-shell 4 ·
landing-pen-render 37 · i18n 32 · search-results-layout 23 ·
scan-screen-fail-safe 37 · deck-editor-name-resolver 3 ·
deck-editor-pen-mobile-layout 13 · favorites-ui-wiring 4 ·
favorites-nav-route 11 · store-mvp-fail-closed 216 · store-mvp-behavior
149 · store-mvp-ui-gates 104 · apple-delete-truth-copy 56 ·
legal-copy-vs-behavior 29 · auth-strategy 6 · auth-error-map 8.
`npx tsc --noEmit`: 0 errors.

---

# Round 2 · re-review FAIL blockers at `3d1b872df…`

## [P1] Native pre-camera states on the Pen shell

Both native branches now render through the exported
`ScanNativePermissionGate` (the EXACT shipped surface): Pen `x7iIL` top
bar (working close, real quota pill, inert flash) over v2 chrome for
permission-loading AND permission-denied. `CameraPermissionDeniedView`
restyled from legacy COLORS to v2 tokens with the DIC-1286 recovery
contract byte-preserved (canAskAgain gating, settings recovery,
testIDs). Regression: two new native-state checks render the gate
directly (react-native-web pins Platform.OS, so the platform conditional
itself cannot flip in the harness) asserting Pen top bar presence,
$app-bg chrome, close dispatch, hidden re-ask on permanent denial, and
the real openSettings invocation.

## [P1] Camera-ready evidence through the shipped route

`render:scan-search` now mounts `NavigationContainer` + the real
`StackNavigator`, navigates to the shipped Scan route, performs the
route's REAL permission-button gesture, and reaches camera-ready via a
deterministic `navigator.mediaDevices.getUserMedia` seam (fake
MediaStream at the web-platform API boundary — the app's only camera
acquisition path). Captures: `scan-camera-ready-render-{mobile-390,
tablet-768,desktop-1440}.png` (+ fixtures). The suite adds a matching
route-level regression (navigate → real gesture → camera-ready chrome
asserted, `getCurrentRoute() === 'Scan'`). Fixing this surfaced a real
stacking bug: the overlay chrome flowed AFTER the 100%-height <video>
instead of over it — `ScanOverlay`'s root is now absolutely positioned
over the camera.

## i18n

`ScanTopBar` accessibility labels now use the zh/ja translation
contract: new symmetric `scan_close_a11y` key pair + existing
`scan_flash`/`scan_flash_on`.

## Integration

`origin/main` merged (catalog sync 2026-09-10 — data only; PR #189 was
behind).

Full battery re-run green (scan-search-shell now 7); `tsc --noEmit` 0.
