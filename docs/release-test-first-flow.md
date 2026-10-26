# Test-first release flow (staging → Closed Alpha → production)

**Target flow:**
- New features and data land on `staging` first, where every commit is validated by CI.
- A CI-verified staging commit may become a Play closed-testing (Alpha) build.
- `main`, production app builds and the formal website change only through an explicit, normal promotion PR from `staging` to `main`.
- Production releases still build only from the main tip or a `v*` tag contained in main.

This document separates **code-flow readiness** (what the repo enforces once these files are on the right branch) from **platform/data readiness** (settings only platform owners can apply).

**Isolation:** the repo does **not** provide or claim a separate staging backend or full isolation. It only refuses to run when the configuration it can check is missing or conflicting.

## Branch history

`staging` keeps its 11 DIC-1189 commits; nothing was reset, squashed or force-pushed. The integration branch merges, normally:
- the reviewed flow candidate;
- current `main` (including the Node 22.23.4 EAS floor);
- the original `staging`.

## Implemented in the repo

| Piece | Where | Effect |
|---|---|---|
| CI on every staging push | `ci.yml` `on.push.branches: [main, staging]`, **no `paths-ignore`** | Code and data commits pushed by a person or an authorized app run Validate and the APK guard. `deploy-production` is unchanged. |
| Staging validation dispatch | `ci.yml` `workflow_dispatch` on ref `staging` (preflight) | For staging tips with no push run (see "Automation limits" below). The **preflight** admits it only when `deploy_production` is exactly `false`, `expected_sha` is a 40-hex SHA equal to the dispatched commit and to the **live** `origin/staging` tip (re-fetched), and `origin/main` is contained. The run then executes the full Validate + APK guard and never deploys. `deploy-production` needs the preflight, its gate is unchanged, and its callee re-proves the main tip. The `main` recovery path is unchanged: exact live main tip only. |
| Stage promotion proof | `ci.yml` job "Stage promotion proof" → `scripts/ci/stage-promotion-proof.sh` | Never skipped. A **PR into `main`** passes only if its head is this repo's `staging` at the live tip, contains `origin/main`, and has a completed successful `ci.yml` run of that exact SHA on staging: a **push** run or a **staging validation dispatch**. PR runs never count. Other events are a no-op; unknown events fail. Read-only token. |
| Staging Alpha guard | `scripts/ci/staging-alpha-ref-guard.sh` | `staging-alpha` only with `submit=false`, at the fresh staging tip, with main contained and the same successful push-or-validation run. |
| Data bots | `official-catalog-sync.yml`, `refresh-yt-stats.yml`, `collect-tournament-reports.yml` (`BASE_BRANCH: staging`); `scrape-yuyu-prices.yml` | Sync PRs are built from and opened against `staging`. The manual yuyu build pushes `staging` and no longer fires the deploy hook. Gates are unchanged. |
| Local scheduler | `scripts/local-scrape-and-push.sh`, `scripts/scheduler-launch.sh` | Fetch, worktree baseline, in-place pull and push, self-attestation and the launcher's code source are now `origin/staging`. The in-place route pushes `HEAD:staging`; the dirty and forced routes hand off on `bot/scrape/<date>`. A `HUNTERCARD_REMOTE_REF` naming `main` is refused. It **no longer runs `send-push-alerts.js` or `send:price-alerts`**, and unsets production-lane variables (`KV_REST_API_*`, `KV_URL`, `PUSH_NOTIFY_*`, `EXPO_ACCESS_TOKEN`, `VERCEL_DEPLOY_HOOK`, `VERCEL_TOKEN`) before any step. Data, provenance, freshness and coverage gates and the dirty-tree isolation are unchanged. |
| `staging-alpha` EAS profile | `eas.json` | Store AAB extending `production` (inherits Node 22.23.4), `environment: preview`, `EXPO_PUBLIC_APP_STAGE=staging`, `EXPO_PUBLIC_APP_ENV=staging`, Store MVP on, no submit profile. |
| Production guards | `release-ref-guard.sh`, `release-apk-usage-guard.sh`, `submit.production` | Unchanged. |
| Stage flags | `apiOrigin.ts` `resolveClientStage`, `app.config.js` `resolveBuildStage`, `appEnv.ts` | An unknown value, or `staging` next to an explicit `production` in `EXPO_PUBLIC_APP_STAGE` / `EXPO_PUBLIC_APP_ENV` / `APP_ENV`, fails closed. Staging builds need a non-production `EXPO_PUBLIC_STAGING_API_ORIGIN`. Server: `resolveAppEnvStrict()` throws on an unset or unknown `APP_ENV`. |
| Server lane guards (DIC-1189) and store binding | `kv-namespace.ts`, `env-guard.ts`, `session.ts`, `internal-auth.ts`, `push-staging-guard.ts` | `nsKey()` on every key. Staging requires the recorded `STAGING_KV_STORE_HOST` ≠ `PRODUCTION_KV_STORE_HOST` when a store is configured. Staging-only secrets have no production fallback. The payment env must match the lane. |
| Offline tests | `test:staging-first-isolation`, `test:staging-alpha-flow`, `test:dic1189-staging-isolation`, scheduler suites | All in CI Validate. |

## Automation limits (factual)

- **`GITHUB_TOKEN` pushes start no workflow.** The manual yuyu build's push to `staging`, or a bot auto-merge, produces **no push CI run**. Such a tip has no proof until a maintainer dispatches **CI** on `staging` with `expected_sha=<that tip>` and `deploy_production=false`, using existing maintainer `gh`/UI access (no new token or permission). Bot PRs into staging merged by a person do trigger push CI.
- **Schedules use the default branch.** GitHub runs `schedule:` workflows from the **default branch's** files. Until these files are on the default branch, the scheduled bots keep their current `main` targets.
- **The local scheduler runs the installed launcher.** That launcher re-executes the committed launcher of the ref it fetches, and the installed copy today fetches `main`. The staging retarget becomes active only after the launcher from this change is installed (`git show origin/staging:scripts/scheduler-launch.sh > ~/.hermes/bin/huntercard-scheduler-launch.sh`), or once main carries it. Until then the old timer behaves as before and should be paused if main must stop receiving direct data. The coordinator inspects that. The resident checkout must track `staging` for the in-place route; otherwise it fails closed.
- **Production price and push alerts stop.** They are no longer sent from the scheduler. Restoring them needs a separate production-lane job that reads promoted production data; that is a product decision.

## Operator flow

1. **Land work on staging.** Use PRs into `staging`; bots open theirs there. CI runs on PR and push. For a bot-pushed tip with no run, dispatch CI on staging (validation only).
2. **Keep staging current.** Merge `main` into `staging` normally whenever main moves.
3. **Alpha (optional).** Dispatch EAS Build on `staging` with `profile=staging-alpha`, `submit=false`, then upload to Closed testing by hand.
4. **Promote.** Open a PR `staging → main`; "Stage promotion proof" must pass.
5. **After merge.** Production builds and the formal website follow the existing exact-SHA flow.

## Platform and data readiness

| Status | Item |
|---|---|
| **Saved by the coordinator via normal UI, not yet active** | On Vercel `holohunter-staging` (Production environment), these non-secret vars: `APP_ENV=staging`, `EXPO_PUBLIC_APP_ENV=staging`, `EXPO_PUBLIC_APP_STAGE=staging`, `EXPO_PUBLIC_STAGING_API_ORIGIN`, `SITE_URL` and `EXPO_PUBLIC_SITE_URL` = `https://holohunter-staging.vercel.app`. **Not redeployed; Production Branch not switched; no store or secrets connected.** |

Remaining steps, none performed by the author:
1. **P2: require the check on main.** Require "Stage promotion proof" on `main` and restrict direct pushes and admin bypass (repo admin). Until then **nothing is enforced**.
2. **P1: production lane, before any promotion.**
   - **`APP_ENV`:** set `APP_ENV=production` on `holocard-hunter`.
   - **Payment variables, checked by name and class only (never by value):** with `APP_ENV=production`, every KV-touching endpoint runs `assertPaymentEnv()` at import. Every set Stripe/RevenueCat credential must be a **live-class** key; any test-class or unknown prefix throws. The vars are `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `REVENUECAT_SECRET_KEY`, `EXPO_PUBLIC_REVENUECAT_IOS_KEY` and `EXPO_PUBLIC_REVENUECAT_ANDROID_KEY`. The sentinels must be `STRIPE_MODE=live`, `REVENUECAT_ENVIRONMENT=production` and `STRIPE_WEBHOOK_LIVEMODE=true`, or unset.
   - **Consequence:** a mismatch fails auth, sync and push closed for every user.
   - **Optional (F4):** a post-promotion production smoke of one session verify and one push register.
3. **P4: staging project order.**
   - Keep the stage vars and an explicit `SITE_URL`/`EXPO_PUBLIC_SITE_URL` set (already saved) **before** switching Production Branch `main → staging`. Otherwise staging serves an unattributed build: no banner, no noindex. Without an explicit site URL, the default `test.holohunter.dicoge.com` depends on DNS from the do-not-run setup workflow.
   - The formal project stays on `main`.
   - Read back the branch and deployed SHA of both projects.
4. **Separate staging store** (owner approval, possible billing). Attach it only to staging, confirm the production store is not connected, and record both store hosts. Until then staging KV access refuses or cannot connect.
5. **Staging-only credentials** (session, push-notify, OAuth and redirects, recognition), each with owner approval. Never copy production values.
6. **EAS `preview` env** for `staging-alpha` (staging origin, public Google client IDs).
7. **Scheduler activation:** install the staging launcher and point the resident checkout at `staging`, or pause the old timer (coordinator).
8. **Never dispatch** `dic1189-staging-vercel-setup.yml` or `dic910-vercel-setup.yml`. They probe or write production KV, DNS and secrets.

## Known limits

- **Proof reports only:** the promotion proof enforces nothing until it is required on main.
- **Store binding trusts its record:** it relies on owner-recorded hostnames and cannot detect a wrong record.
- **Raw KV scripts:** `send-price-alerts.mjs` and `send-push-alerts.js` use raw production KV REST without `nsKey()`. They are production-lane only and are no longer invoked by the staging scheduler.
- **Real export test:** `test:bundle-cleanness-full` performs a real `expo export` with local dependencies.
