# Release-parity evidence contract (DIC-1401)

This directory backs the "手機正式版與 Web Production 的功能進度必須相同"
(mobile Production and Web Production must be at parity) rule with checked
evidence instead of a claim.

## SHA parity (`scripts/ci/release-parity.mjs`)

- Every Web build (Production and staging) writes a STATIC
  `dist/version.json` (`scripts/ci/write-build-version.mjs`, invoked from
  `vercel.json`'s buildCommand) reporting the exact commit SHA
  (`VERCEL_GIT_COMMIT_SHA`) currently serving that deployment. It is served
  as a plain static file from the output directory — deliberately NOT an
  `api/*` serverless function — because api routes count against Vercel's
  per-deployment function cap (12 on Hobby), and adding one as a 13th broke
  both deployments (see `scripts/ci/vercel-function-count-guard.mjs`).
- `scripts/ci/release-parity.mjs` compares that SHA against a mobile
  production build's source SHA (from EAS build provenance) and reports one
  of three statuses — never guessed:
  - `synced` — both SHAs resolved and are byte-identical.
  - `not-synced` — both SHAs resolved but differ.
  - `unknown` — either SHA could not be resolved. Treated as a FAILURE by
    the CLI (non-zero exit), never silently treated as "close enough".
- Wired as a manual workflow (`.github/workflows/release-parity-check.yml`)
  so it can be run on demand against the real Production URL and a specific
  EAS build's source SHA — it makes no network assumption at CI/PR time and
  is not required to run on push.

## Flag parity (`flags.json` + `scripts/test-release-flags-parity.mjs`)

- `flags.json` is the single source of truth for every release flag that is
  *intended* to be identical between Web Production and mobile Production.
- Each entry's `parity` must be either:
  - `"synced"` — the test asserts `mobileProductionEasValue` (read live from
    `eas.json`) literally equals `webProductionVercelValue`. Any drift fails
    CI.
  - `"documented-exception"` — the flag is currently NOT the same across
    lanes, with a recorded reason/trackingIssue/followUp. The test still
    pins the current mobile-side value (via `eas.json`) so any FUTURE
    undocumented change is caught, but does not claim the flag is currently
    synced.
- This is deliberately conservative: DIC-1401 is CI/CD-and-branch scope only
  and must not silently change product feature behaviour to force a flag
  into sync. `EXPO_PUBLIC_STORE_MVP` is currently a documented exception —
  see `flags.json` for the exact current state and the two pending fixes
  (a not-yet-merged Web Production `vercel.json` define change, and a
  DEV-gate code fix to `src/config/releaseFlags.ts`'s fallback) that must
  both land before it can be marked `synced`.

## Per-deploy-profile define injection guard (`scripts/ci/store-mvp-define-guard.mjs`)

DIC-1401 user correction: `EXPO_PUBLIC_STORE_MVP` must be **explicitly**
injected by every deploy profile that ships to a real audience — never left
to `src/config/releaseFlags.ts`'s runtime fallback, which (pre-fix) resolves
an unset/blank/invalid value asymmetrically (`Platform.OS !== 'web'`,
fail-closed on native but fail-OPEN on web). `scripts/test-store-mvp-define-guard.mjs`
statically asserts, directly against the committed config (no live
dashboard/network calls, no secrets):

- `vercel.json`'s `buildCommand` sets `EXPO_PUBLIC_STORE_MVP` to a literal
  `"0"` or `"1"` immediately before the `expo export` invocation — never
  missing/blank.
- Where `vercel.json` also declares `EXPECTED_VERCEL_BRANCH` (each branch's
  own lane self-declaration; the runtime "wrong project ships wrong branch"
  gate is `scripts/ci/vercel-branch-guard.sh` bound to the trusted
  `VERCEL_PROJECT_ID` / `VERCEL_PROJECT_PRODUCTION_URL` via
  `scripts/ci/vercel-project-registry.tsv`), the declared
  `EXPO_PUBLIC_STORE_MVP` value must match this repo's policy: `staging`
  → `"0"`, `main` → `"1"`.
- `eas.json`'s `production` and `production-apk` build profiles (following
  `extends` chains) resolve `EXPO_PUBLIC_STORE_MVP` to exactly `"1"`.

This guard cannot fix the runtime fallback itself (product code, DEV-gate
scope) — it only guarantees that every profile it covers never actually
*reaches* that fallback in the first place, by construction.

## Public deploy-status mirror (`.github/workflows/vercel-deploy-status-post.yml`)

The "post a Production-success / preview-failure comment when Vercel
finishes a deployment" deliverable ships as a schedule-triggered
consumer (`on: schedule` every 5 min + `workflow_dispatch`) loaded
from the default branch by GitHub Actions contract. It polls GitHub's
Deployments API for Vercel-authored deployments, extracts the latest
Vercel-authored terminal status, classifies the environment, and posts
the DIC-1401-required summary comment. Behavioural, trust-boundary,
Deployments-API permission (`deployments: read`), runtime-stub, and
Vercel-creator-gate coverage is in
`scripts/test-deploy-status-classify.mjs` (29 tests).

The residual `deployment_status` PR-YAML vulnerability class (a future
PR adds its own `on: deployment_status` workflow with explicit
`contents: write`) is external to this repo — the closing mechanism
(disable Vercel's GitHub Deployments integration in the Vercel
dashboard) is owned by DIC-1399, per DIC-1401 parent card rule 6.
Full history of the six previous CR rounds, the platform-limitation
analysis, and the two unblock paths are in
`release-parity/deploy-status-mirror-blocked.md`.

