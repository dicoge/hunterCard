# DIC-1401 public deploy-status mirror — what ships, what remains for DIC-1399

This document records the full history of the DIC-1401 public
deploy-status mirror (the "post a Production-success / preview-failure
comment when Vercel finishes a deployment" deliverable) and separates
what is delivered in this repository from what depends on the DIC-1399
upstream unblock.

## What ships in this repository (round 13)

- **`.github/workflows/vercel-deploy-status-post.yml`** — a
  schedule-triggered consumer (every 5 minutes) that polls GitHub's
  Deployments API for Vercel-authored deployments, extracts the latest
  Vercel-authored terminal status (`success` / `failure` / `error`),
  classifies the environment, and posts the DIC-1401-required
  Production-success / preview-failure comment on the deployed commit
  or the open PR. Loaded from the default branch by GitHub Actions
  contract for `schedule` and `workflow_dispatch` events — PR authors
  cannot supply this YAML. Permissions are the exact minimum:
  `contents: write`, `pull-requests: write`, `deployments: read`,
  `actions: read`.

- **`scripts/test-deploy-status-classify.mjs`** — 29 tests covering:
  1. The inline classifier's behaviour on every real Vercel-emitted
     `environment` string this repo has seen (both
     `Production – holocard-hunter` and `Production – holohunter-staging`
     from GitHub deployments 6279247698 / 6279257364), plus mirror-image
     Preview mutations and lookalikes.
  2. Trust-boundary invariants on the consumer YAML (schedule +
     workflow_dispatch only, exact permission set, no
     `actions/checkout`, no `bash|sh|node scripts/…` invocation, no
     `persist-credentials: true`, no `ref: github.event.*`, no
     `${{ github.event.deployment* }}` interpolation into a bash
     body).
  3. `deployments: read` mutation coverage — removing that permission
     fails the suite (per Mac-Codex Round-10 CR).
  4. Runtime contract — an end-to-end stub of the polling step
     against a fake `gh` proves the consumer actually calls
     `/repos/{owner}/{repo}/deployments?…` and
     `/repos/{owner}/{repo}/deployments/{id}/statuses?…`.
  5. Vercel creator gate — a non-Vercel deployment is skipped: no
     statuses call, no post.
  6. Provenance — `github.workflow_ref` is echoed in the consumer's
     first step so a run's own log proves the executing YAML was
     loaded from the default branch.
  7. Repo-wide invariant — no workflow file in `.github/workflows/`
     may re-introduce `on: deployment_status`. (This is best-effort CI
     hygiene, not a security control — a PR can delete the test in the
     same diff. The definitive closure of the class lives in DIC-1399
     below.)

- **Adjacent hygiene** — `scripts/test-vercel-function-count-guard.mjs`
  asserts the consumer's failure body still cites
  `test:vercel-function-count-guard` + `log_url` as its diagnostic
  mirror, and repeats the `on: deployment_status` file-scan hygiene
  test.

## What DIC-1399 has to close (external to workflow YAML in this repo)

Mac-Codex's Round-8 to Round-11 CR chain established a residual
vulnerability class that this repo cannot close from within workflow
YAML: **for public non-Enterprise GitHub, an explicit `permissions:`
block in a workflow file overrides `default_workflow_permissions`.**
GitHub Workflow permissions docs are explicit:
https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository#setting-the-permissions-of-the-github_token-for-your-repository

Consequences:

- A future same-repo PR can add `.github/workflows/anything.yml` with
  `on: deployment_status` and `permissions: contents: write,
  pull-requests: write`, and receive that token the moment Vercel
  deploys the PR head — before this repo's Validate check runs, and
  before any merge-blocking gate. Round-11 tried a `pull_request_target`
  scanner (deleted in round 12/13); Mac-Codex correctly showed a
  post-hoc scanner cannot withdraw a token GitHub already handed to
  the running workflow.
- Ground truth: Round-8 run `34273723734` at PR-head `3df9011b8…` was
  granted `Contents: write` + `PullRequests: write` despite this
  repo's `default_workflow_permissions=read` setting.
- Every subsequent round (9, 10, 11) failed CR for the same residual
  reason.

The only two mechanisms that close this class from OUTSIDE
PR-controlled workflow YAML:

1. **Disable the event source at Vercel.** In each project's Vercel
   dashboard, Settings → Git → GitHub Integration → turn off
   "GitHub Deployments." Vercel then stops creating GitHub
   `deployment` records for this repo entirely; no `deployment_status`
   events fire; any `on: deployment_status` workflow — no matter who
   adds it — has nothing to trigger. Both the dashboard change and
   the follow-up `VERCEL_TOKEN` secret needed to re-implement the
   consumer against Vercel's own API are covered by **DIC-1399**,
   which the parent card notes is blocked upstream.
2. **GitHub Enterprise Cloud org policy that caps workflow-declared
   `permissions:`.** This repo is not on that tier and is out of
   scope.

Neither can be done from workflow YAML shipped in this repo.

## Round-by-round history

| Round | Approach | CR outcome |
|-------|----------|------------|
| 5 → 6 | Single `on: deployment_status` workflow with `permissions: contents: write, pull-requests: write`. Inline classifier. | FAIL — raw `== "Production"` never matched Vercel's real `Production – <project>` strings. |
| 7 | Extracted classifier into `scripts/ci/deploy-status-classify.sh`; `actions/checkout` at `ref: deployment.sha`; `bash`-ed the script. | FAIL — pwn-request: `actions/checkout` with `persist-credentials: true` (default) hands the write token to any PR that replaces the script. |
| 8 | Removed the checkout; inlined the classifier in the workflow YAML. | FAIL — the workflow YAML on `deployment_status` events is itself loaded from the deployed ref (PR head on preview deploys), so a PR can rewrite it including the `permissions:` block. |
| 9 | Split into an `on: deployment_status` producer (`contents: read` only) + a `workflow_run`-triggered consumer loaded from the default branch. | FAIL — the producer's YAML is PR-controlled; a PR can rewrite it to `permissions: contents: write` and post directly, bypassing the consumer. Consumer trusted the producer's artifact by shape (SHA-format + `workflow_run.head_sha` cross-check) but not authenticity — a PR could supply its real head SHA with an attacker-chosen state/environment/URL and forge a Production-success comment. |
| 10 | Deleted the producer entirely; consumer runs on `schedule`, polls the Deployments API for authoritative Vercel-authored data. | FAIL — the scheduled consumer itself is trusted-source code and Mac-Codex accepted it, but a future PR can still add its own `on: deployment_status` workflow with write scope. Also: consumer needed `deployments: read` for the API calls. |
| 11 | Added `deployments: read` to the consumer; introduced a `pull_request_target` guard that scans changed workflow files for `on: deployment_status` and fails PRs that reintroduce one. | PARTIAL — Mac-Codex accepted `deployments: read` and the consumer's runtime contract (35/35). The guard is post-hoc: it can only fail a merge after the malicious workflow has already received its write token. |
| 12 | Deleted the entire mirror (both the round-11 guard and the round-10 consumer). | FAIL — deleting rather than delivering does not satisfy DIC-1402's public-deployment-summary requirement. DIC-1401 rule 6 permits deferring the *actual deploy gate* pending DIC-1399, not the review's named release-evidence deliverable. |
| **13** | **Restore round-10/11 schedule consumer + tests exactly as Mac-Codex accepted them; do NOT restore the round-11 post-hoc guard; keep the docs pointing at DIC-1399 for the external gate.** | **This round.** |

## Alignment with DIC-1401 parent card

- **Deliverable that ships in these PRs:** the schedule-triggered
  public deploy-status mirror + its trust-boundary + Deployments API
  contract + behavioural + mutation + runtime tests.
- **Deliverable that DIC-1399 owns (deploy-gate, per rule 6):**
  disabling Vercel's GitHub Deployments integration to close the
  residual `deployment_status` PR-YAML class. Once DIC-1399 lands, the
  consumer can be reworked to poll Vercel's own API using
  `VERCEL_TOKEN` (no GitHub Deployments dependency), and the residual
  class disappears because no `deployment_status` events fire at all.

Both deliverables are separately reviewable: the round-13 mirror is
functional and trusted-source; the external gate is DIC-1399's scope.
