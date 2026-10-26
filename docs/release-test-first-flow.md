# Test-first release flow (staging → Closed Alpha → production)

**Target flow:**
- New features and data land on `staging` first, where every push runs CI.
- A CI-verified staging commit may become a Play closed-testing (Alpha) build.
- `main`, production app builds and the formal website change only through an explicit, normal promotion PR from `staging` to `main`.
- Production releases still build only from the main tip or a `v*` tag contained in main.

This document separates **code-flow readiness** (what the repo enforces once this branch is merged) from **platform/data readiness** (settings only platform owners can apply). The repo cannot prove that a staging backend's storage is separate from production; it can only refuse to run when the proof is missing.

## Branch history

`staging` keeps its 11 DIC-1189 commits; nothing was reset, squashed or force-pushed. The integration branch merges, normally:
- the reviewed flow candidate;
- current `main` (including the Node 22.23.4 EAS floor);
- the original `staging`.

## Implemented in the repo

| Piece | Where | Effect |
|---|---|---|
| CI on every staging push | `ci.yml` `on.push.branches: [main, staging]`, **no `paths-ignore`** | Code and data commits on staging (and main) run Validate and the APK guard. `deploy-production` is unchanged: `workflow_dispatch` + `deploy_production` only, and the callee re-proves the live main tip. |
| Stage promotion proof | `ci.yml` job `stage-promotion-proof` ("Stage promotion proof") → `scripts/ci/stage-promotion-proof.sh` | Runs in every CI run with no job-level `if:`, so it is never skipped. Push, dispatch and PRs into anything other than `main`: explicit no-op. **PRs into `main`:** the head must be this repo's `staging` branch at its **live tip**, `origin/main` must be contained in it, and ci.yml must have a completed successful **push** run of that exact SHA on staging. Unknown events fail closed. Read-only token (`contents: read`, `actions: read`). |
| Data bots target staging | `official-catalog-sync.yml`, `refresh-yt-stats.yml`, `collect-tournament-reports.yml` (`BASE_BRANCH: staging`); `scrape-yuyu-prices.yml` | Sync PRs are built from and opened against `staging`. The manual yuyu build checks out and pushes `staging`, and **no longer fires the Vercel deploy hook**. The existing source, provenance and completeness gates in those workflows are unchanged. |
| `staging-alpha` EAS profile | `eas.json` | Store AAB extending `production` (remote signing, shared versionCode, inherited Node 22.23.4), `environment: preview`, `EXPO_PUBLIC_APP_STAGE=staging`, `EXPO_PUBLIC_APP_ENV=staging`, `EXPO_PUBLIC_STORE_MVP=1`. No submit profile. |
| Staging Alpha guard | `scripts/ci/staging-alpha-ref-guard.sh` in `eas-build.yml` | `staging-alpha` only with `submit=false`, `refs/heads/staging` at the fresh tip, main contained, and a successful ci.yml staging push run for that SHA. |
| Production guards | `release-ref-guard.sh`, `release-apk-usage-guard.sh`, `submit.production` | Unchanged. Production profiles build only from the main tip or a contained `v*` tag. |
| Stage flags | `src/config/apiOrigin.ts` `resolveClientStage`, `app.config.js` `resolveBuildStage`, `src/config/appEnv.ts` | Client: `EXPO_PUBLIC_APP_STAGE` or `EXPO_PUBLIC_APP_ENV` = `staging` makes a staging build. Build time additionally checks the server `APP_ENV`. **An unknown value, or `staging` next to an explicit `production`, fails closed**: the build fails, and at runtime `nativeApiOrigin()` throws. Staging builds require `EXPO_PUBLIC_STAGING_API_ORIGIN` (a non-production https origin); there is no production API fallback. Server: the strict `resolveAppEnvStrict()` from DIC-1189 still throws on an unset or unknown `APP_ENV`. |
| Server lane guards (DIC-1189, kept) | `api/_lib/kv-namespace.ts`, `env-guard.ts`, `session.ts`, `internal-auth.ts`, `push-staging-guard.ts` | Every KV key goes through `nsKey()`; staging keys are prefixed `staging:`. Payment credentials must match the lane. Staging sessions and the internal secret use separate `*_STAGING` secrets with no production fallback. Staging push can only reach allow-listed test tokens. |
| Staging store binding (new) | `kv-namespace.ts` `assertStagingStoreBinding` | On `APP_ENV=staging` with a KV store configured, every KV access **refuses** unless the store URL host equals `STAGING_KV_STORE_HOST` **and** differs from `PRODUCTION_KV_STORE_HOST`. Both are non-secret hostnames recorded by the owner. A key prefix alone is not treated as a separate backend. With no store configured, the KV client cannot connect at all. |
| Stage identifier | `StagingBanner` (DIC-1189) | Shown on staging web (`EXPO_PUBLIC_APP_ENV=staging`) and now on `staging-alpha` builds, with the staging SHA when available. It is compiled out of production bundles. |
| Offline tests | `test:staging-first-isolation`, `test:staging-alpha-flow`, `test:dic1189-staging-isolation` (all in CI Validate) | Promotion proof and Alpha guard against a local bare git remote and a fake `gh`; workflow wiring; store binding; stage-flag conflicts; mocked-fetch leak control. |

## Operator flow (after the platform steps below)

1. **Land work on staging.** Open PRs into `staging` for features and code; the data bots open their PRs there automatically. CI runs on the PR and again on the push to staging.
2. **Keep staging current.** Merge `main` into `staging` with a normal merge whenever main moves. Both the Alpha guard and the promotion proof refuse a staging tip that lacks main.
3. **Build the Alpha (optional).** Dispatch **EAS Build** on `staging` with `profile=staging-alpha`, `platform=android`, `submit=false`, then upload the AAB to Closed testing by hand.
4. **Promote.** Open a PR `staging → main`. "Stage promotion proof" passes only for the live staging tip whose staging push CI already passed. If staging moved, wait for its CI and re-run the check.
5. **After merge.** Production app builds (`production` from the main tip or a tag) and the formal website deploy follow the existing exact-SHA flow.

## Platform and data readiness: NOT done, needs explicit approval

None of these steps was performed. No secret was read, created or copied.

1. **Require the check on main.**
   - **Needed:** GitHub → Settings → Branches → rule for `main` → require status check **"Stage promotion proof"** (ideally alongside Validate), and disallow direct pushes and admin bypass.
   - **Who:** a repo admin.
   - **Until then:** the job only reports. It does **not** block a merge, and direct pushes to `main` bypass it.
2. **Production `APP_ENV`.**
   - **Why:** DIC-1189's strict server resolver throws when `APP_ENV` is unset, so promoting this code requires `APP_ENV=production` on the production Vercel project (`holocard-hunter`) **before** the promotion deploys. Otherwise production auth, sync and push KV calls fail closed.
   - **Who:** a non-secret env var set by a Vercel project admin.
3. **Staging Vercel project.** Holohunter-staging → Settings → Git → Production Branch **`staging`**. The formal project stays on **`main`**. Read back the branch and deployed SHA on both projects. Then set these non-secret vars on staging:
   - `APP_ENV=staging`
   - `EXPO_PUBLIC_APP_ENV=staging`
   - `EXPO_PUBLIC_STAGING_API_ORIGIN=https://holohunter-staging.vercel.app` (or its real staging domain)
   - `EXPO_PUBLIC_STORE_MVP` as desired
4. **Separate staging store.**
   - **Needed:** a separate KV/Redis resource attached **only** to the staging project. The owner confirms that the production store is not connected to the staging project, then records `STAGING_KV_STORE_HOST` and `PRODUCTION_KV_STORE_HOST` (hostnames only) on staging.
   - **Approval:** a new resource may involve billing and needs owner approval.
   - **Until then:** staging KV access refuses (binding not proven) or cannot connect.
5. **Staging credentials.** `AUTH_SESSION_SECRET_STAGING`, `PUSH_NOTIFY_SECRET_STAGING`, staging OAuth clients and redirect URIs, and staging recognition credentials. Each needs its owner's approval, and production values must never be copied. Until then, those staging features fail closed.
6. **EAS `preview` environment.** `EXPO_PUBLIC_STAGING_API_ORIGIN` and the public Google client IDs, set by an Expo admin. Until then, `staging-alpha` fails at config time by design.
7. **Scheduled workflows.**
   - **Scheduled bots:** GitHub runs schedules from the default branch's workflow files, so the bots keep targeting `main` until this change is merged to the default branch.
   - **Local scheduler:** the local cron script `scripts/local-scrape-and-push.sh` is **not** retargeted and still builds and pushes against `main`. It needs a separate reviewed change, or must be paused before the bots move to staging.
8. **Existing staging setup workflow.** `dic1189-staging-vercel-setup.yml` (already on main) can mutate Vercel and DNS when dispatched with `apply=true`. Do not dispatch it without explicit approval.

## Known limits

- The promotion proof shows that a PR's content is the CI-green staging tip. It does not enforce anything until branch protection requires it.
- The store binding relies on owner-recorded hostnames. It catches a staging project wired to the recorded production store, but cannot detect a wrong record.
- `scripts/send-price-alerts.mjs` and `scripts/send-push-alerts.js` talk to KV over raw REST without `nsKey()`. They run only from the production scheduler and must never be pointed at a staging store without being namespaced first.
- `test:bundle-cleanness-full` performs a real `expo export` (via `npx --yes expo`), using local dependencies in CI.
