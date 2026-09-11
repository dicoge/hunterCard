# DIC-1409 Phase 6 · App 13–16 on the shared Pen v2 shell

Source of truth: `docs/pen-v2/holohunter-landing-v2-updated.pen` (SHA-256
`6fbf0c06b15d726573871357bd7119c4d0046aa5d6eb3949aa735bd727d9272f`), frames
`rV4Za` / `I6WwjY` / `x44r8t` / `p28zL`, read live through Pencil MCP this
session (`claude mcp list` → pencil ✓ Connected). Started from exact accepted
head `98459073fe48cd869401564fd5d4b2aedb1cb703`.

## Route / Pen-node / data-binding / state matrix

| Route | Pen frame / nodes | Data + state binding (unchanged) |
| --- | --- | --- |
| TutorialDetail (`TutorialDetailScreen`) | `rV4Za` App/13 教學詳情 — app bar `QeI3c` with real chapter title (node `DEchs`), 首頁 tab fold | Wrapped in `RouteShell`; the real `route.params.sectionId` drives the shipped tutorial dataset; existing `tutorial-detail-content-<id>` testID and all section content (description/images/items/phases) untouched; stack header off. |
| TutorialSimulation (`TutorialSimulationScreen`) | `I6WwjY` App/14 教學模擬 — app bar `phsBJ`, board `ZQ3b7`, actions `k0Q7h` | Wrapped in `RouteShell` (title `nav_tutorial_simulation`); the real phase/step progression state machine (`handleNext`/`handlePrev`, progress math, final-step `goBack`) and `SimulationBoard`/`SimulationStepCard` internals are byte-identical; stack header off. |
| Settings (`SettingsScreen`) | `x44r8t` App/15 設定 — group cards `Qpkox`/`Vp4g7`/`phxwj`, headings `U2n8Jp`/`sed7I`/`Ld7b7` | Refinement of the existing App 07 shell composition — no second shell layered (asserted). Sections became $app-surface r14 group cards with 11/700 muted headings; every section, auth provider row, Store-MVP copy branch, and delete disclosure is byte-preserved. |
| Login (`LoginScreen`) | `p28zL` App/16 登入 — glow `wPWUr`, logo tile `FTEuu`, brand `c9cMr`, Google `ilZGG`, Apple `TU4oT`, divider `y24cJ`, guest `qfrcy`, terms `d7fA7X` | Full v2 restyle: status bar only (no tab bar, per Pen), gradient logo tile, $accent-2 brand label, white r14 Google / #101018 Apple buttons, $accent-2 guest link. All real states preserved: loading spinner, error box + dismiss, `APPLE_LOGIN_ENABLED` gate, and the `STORE_MVP` description swap (`login_description` vs `login_description_store`) on the exact original ternary. Pen's 使用電子郵件 button is NOT rendered — no email auth provider exists in `authService`; rendering it would be a fabricated affordance. Pen headline copy (開始獵卡之旅) is not adopted; the existing localized `login_welcome`/`login_tagline` strings serve the headline slot, avoiding unreviewed copy. |

Navigator: `headerShown:false` added for TutorialDetail + TutorialSimulation
stack screens only. No route or deep link added/removed.

## Tests

New `npm run test:app1316-shell` — 5 mutation-sensitive tests: TutorialDetail
shell + real chapter title + route-param-driven content + goBack dispatch;
TutorialSimulation shell + real step render + 首頁 fold; Settings group-card
source contract + single-shell assertion (no RouteShell layering on App 07);
Login Pen surface (status bar, no tab bar, logo tile, white r14 Google button,
full-profile copy swap) + a REAL `continueAsGuest` store mutation (guest press
flips `useAuthStore.isGuest`). Wired into the DIC-1409 CI step — now
`test:shell-tokens && app-shell && app47-shell && app812-shell && app1316-shell`.

Full affected battery green: app-shell 10 · app47-shell 8 · app812-shell 5 ·
app1316-shell 5 · shell-tokens 15 · i18n 32 · search-results-layout 23 ·
scan-screen-fail-safe 37 · store-mvp-fail-closed 216 · store-mvp-behavior 149 ·
store-mvp-ui-gates 104 · apple-delete-truth-copy 56 · legal-copy-vs-behavior 29 ·
auth-strategy 6 · auth-error-map 8.
`npx tsc --noEmit`: the same 2 pre-existing errors (CardTile/SeriesCard
createElement union overload, unchanged since before Phase 3) — none introduced.

## Render evidence (390 / 768 / 1440, real data/stores)

`npm run render:app1316` + `render:app1316-screenshots` → 12 PNGs + HTML
fixtures in `docs/pen-v2/phase6/`. TutorialDetail renders a real section via
its real route param; TutorialSimulation runs the shipped phase data (real
board + 步驟 1/3 state); Settings renders the live guest auth state with the
new group cards; Login renders the real signed-out auth store (Apple button
absent because `APPLE_LOGIN_ENABLED` is off in this build — the gate's real
behavior, not a removal).
