# Test-first release flow (staging → Closed Alpha → production)

Target flow: new features and data land on `staging` first. A CI-verified staging commit may become a Play closed-testing (Alpha) build. Production apps and the formal websites only change through an explicit promotion of reviewed `main`, or a `v*` tag contained in main.

This document separates **code-flow readiness** (what the repo now enforces) from **platform/data readiness** (what only platform owners can set up). The repo does not, and cannot, prove that a staging backend's storage is separate from production.

## Implemented in the repo

| Piece | Where | Effect |
|---|---|---|
| CI on staging pushes | `.github/workflows/ci.yml` `on.push.branches: [main, staging]` | Validate and the APK guard run on every non-`data/**` push to staging. `deploy-production` is unchanged: it runs only on `workflow_dispatch` with `deploy_production`, and the callee re-proves the live main tip. |
| `staging-alpha` EAS profile | `eas.json` | Store AAB (extends `production`: remote signing, shared remote versionCode), `environment: preview`, `EXPO_PUBLIC_APP_STAGE=staging`, `EXPO_PUBLIC_STORE_MVP=1`. No submit profile. |
| Staging Alpha guard | `scripts/ci/staging-alpha-ref-guard.sh`, wired in `.github/workflows/eas-build.yml` | Allows `profile=staging-alpha` only when all of these hold: `submit=false` exactly; ref `refs/heads/staging`; SHA equals the freshly fetched `origin/staging` tip; `origin/main` is an ancestor of that tip; ci.yml has a completed, successful `push` run for that exact SHA on staging. |
| Production guard | `scripts/ci/release-ref-guard.sh` | Unchanged: `production` and `production-apk` still build only from the main tip or a `v*` tag contained in main. |
| Workflow token | `eas-build.yml` job `permissions: {contents: read, actions: read}` | Explicit and read-only. `actions: read` is needed to read CI runs. |
| Native API stage selection | `src/config/apiOrigin.ts` (`nativeApiOrigin`) | Used by recognition, push, account sync, Apple register/delete and the auth API base. Stage unset or `production` resolves to `https://holohunter.dicoge.com` exactly as before. `staging` resolves to `EXPO_PUBLIC_STAGING_API_ORIGIN`, which must be a bare https origin that is not a production host. Anything else throws `StageApiOriginError`: no request is made and nothing falls back to production. A production-host `EXPO_PUBLIC_API_BASE_URL` is ignored on staging builds. |
| Build-time stage gate | `app.config.js` `resolveBuildStage` | An unknown stage, or `staging` without a valid non-production origin, fails the EAS build before compile. |
| Offline tests | `scripts/test-staging-alpha-flow.mjs` (`npm run test:staging-alpha-flow`, in CI Validate) | Guard behaviour against a local bare git remote and a fake `gh`; resolver matrix; `app.config.js` agreement; auth base; account sync with a mocked fetch showing no request reaches production. |

Web needs no code change. It already calls `/api` on its own page origin, so a staging site calls the staging deployment's API.

## Operator flow once the platform steps below are done

1. **Land new work.** Merge features and data into `staging` through PRs (CI Validate runs on the PR and on the push).
2. **Keep staging current.** Merge `main` into `staging` with a normal merge (no reset or force push) whenever main moves. The Alpha guard refuses a staging tip that lacks main.
3. **Build the Alpha.** Dispatch **EAS Build** on ref `staging` with `profile=staging-alpha`, `platform=android`, `submit=false`.
4. **Upload.** Upload the AAB by hand to Play Console → Testing → Closed testing.
5. **Promote.** After validation, open a PR from `staging` (or the validated commits) to `main`. After review and merge, production builds (`production` profile from the main tip or a tag) and the website deploy follow the existing exact-SHA flow.

## Platform and data readiness (not done; needs explicit approval)

Each step names what is needed. None of these were performed, and no secret was read or created.

1. **Staging Vercel project branch.**
   - Today: `holohunter-staging` has Production Branch = `main`, so its Production deployment serves main code, not staging.
   - Needed: Vercel project settings → Git → Production Branch = `staging`, by a Vercel project admin. Otherwise the "staging website" and the Alpha's backend run production code.
2. **Staging backend storage.**
   - The API stores identities, account sync, push tokens and watchlists, token-replay, Apple exchange records and price-alert requests in Vercel KV via `@vercel/kv` (`api/_lib/*-store.ts`, `kv-storage.ts`, `token-replay.ts`, `price-alert-request.ts`), with **unprefixed keys**. The store is selected only by the deployment's `KV_REST_API_*` env.
   - Isolation exists only if the staging project is bound to a **different** KV/Redis store than production. A shared store means staging writes production keys.
   - Needed: a project admin creates or attaches a separate staging store, and confirms in the Vercel Storage tab that the production store is not connected to the staging project. This may be a new paid resource, so it needs a billing decision.
3. **Staging server credentials.**
   - Recognition (`GEMINI_API_KEY`), Google/Apple OAuth clients, session signing secrets and push credentials.
   - Do not copy production secrets. Each needs its own staging credential, or the feature stays off on staging. Each needs owner approval: Google Cloud, Apple Developer, Expo push.
   - With no KV env, the KV client cannot connect, so those endpoints error rather than write anywhere. That is acceptable, but login and sync then do not work on the Alpha.
4. **EAS `preview` environment** (expo.dev → project → Environment variables → preview), by an Expo project admin:
   - `EXPO_PUBLIC_STAGING_API_ORIGIN` = the staging origin once 1–3 are done. Without it, `staging-alpha` builds fail by design.
   - The public Google client IDs that `app.config.js` requires for Android (`EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`, and the iOS id for iOS). These must be values whose redirect/package configuration is valid for the same Android package.
5. **OAuth redirect / app-link hosts.** Google and Apple web redirects are pinned to `holohunter.dicoge.com` (`authStrategy.ts`, `app.config.js` `EXPO_PUBLIC_APPLE_ANDROID_APP_LINK_HOST`). Staging login needs its own authorized redirect URIs. Changing them is an OAuth console action for the owner.
6. **Play track.**
   - The Alpha AAB uses the same package and signing as production (required for the same Play listing), and the remote versionCode counter is shared with production builds.
   - Uploading is manual. Confirm the closed-testing track name before any automated submit is ever added.
7. **Data freshness on staging.** `ci.yml` ignores `data/**`-only pushes (existing behaviour). A staging commit that changes only data gets no CI run, so the Alpha guard refuses it until a CI-triggering commit sits on top (see open question 2).

## Existing staging-branch work (preserved, not merged here)

- **Divergence.** `origin/staging` (`c547a4b0`) has 11 commits not on main: DIC-1189 staging isolation scaffolding from 2026-08-25 to 28. That includes `api/_lib/kv-namespace.ts`, `api/_lib/env-guard.ts`, `api/_lib/push-staging-guard.ts`, `src/config/appEnv.ts`, `StagingBanner`, payment and session env guards, a Vercel staging setup workflow, and tests. Main has 467 commits not on staging.
- **Status.** None of it is on main. This change neither resets nor rewrites it.
- **Reconciliation.** Getting staging current requires a reviewed `main → staging` merge with conflict resolution (ci.yml, vercel.json, package.json and the api/_lib stores all changed on both sides).
- **Server-side namespace guards.** The scaffolding's KV namespace and env guards are the existing candidate for server-side stage protection. They are not ported here, because porting is a large cross-cutting change and a key prefix alone is not storage isolation (see platform step 2).

## Open questions

1. Should `eas-build.yml` also refuse `submit=true` for `profile=production`? Today that path submits to the Play **production** track with `releaseStatus: completed` (pinned on purpose by `test-eas-submit-production-track.mjs`). The new flow never uses it; it is left unchanged here.
2. How should data-only staging commits get CI proof? Options: (a) allow the ci.yml recovery `workflow_dispatch` on the exact staging tip (deploy stays main-only); (b) drop `paths-ignore` for staging via a separate workflow file; (c) keep it as is and require a non-data commit on top.
3. Should staging-alpha builds read the EAS `preview` environment, as committed, or a dedicated custom EAS environment (e.g. `staging`), if the plan supports one?
4. Should the DIC-1189 staging scaffolding be reconciled into main as the server-side guard, or retired in favour of separate staging KV/credentials only?
