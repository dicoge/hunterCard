# DIC-1401 public deploy-status mirror — deferred pending DIC-1399

This document records why the DIC-1401 public deploy-status mirror
(the "post a Production-success / preview-failure comment when Vercel
finishes a deployment" deliverable) is **not implemented in this
repository** and what has to change upstream before it can be.

## What was tried, and why each round failed

| Round | Approach | Blocker |
|-------|----------|---------|
| 5 → 6 | Single `on: deployment_status` workflow with `permissions: contents: write`, `pull-requests: write`. Inline classifier. | Vercel emits `Production – <project>` (U+2013 en-dash); the raw `== "Production"` compare never matched. |
| 7 | Extracted classifier into `scripts/ci/deploy-status-classify.sh`, checked out the deployed SHA, `bash`-ed it. | `actions/checkout` at `ref: ${{ github.event.deployment.sha }}` with `persist-credentials: true` = pwn-request: any PR can replace the script and steal the write token. |
| 8 | Removed the checkout; inlined the classifier in the workflow YAML. | The workflow YAML on `deployment_status` events is itself loaded from the **deployed ref** (PR head on preview deploys), so a PR can rewrite the whole file — including its `permissions:` block — and receive whatever token it requests. GitHub records confirmed this on run `34273723734` at `3df9011b8…`: `Contents: write` + `PullRequests: write`. |
| 9 | Split into an `on: deployment_status` producer (`contents: read` only) + a `workflow_run`-triggered consumer loaded from the default branch. | The producer's YAML is PR-controlled; a PR can rewrite it to `permissions: contents: write` and post fake summaries directly, bypassing the consumer. The consumer trusted the producer's artifact by shape (SHA-format + `workflow_run.head_sha` cross-check) but not by authenticity — a PR could supply its real head SHA with an attacker-chosen state/environment/URL and forge a "Production deployment succeeded" comment through the trusted write path. |
| 10 | Deleted the producer entirely; consumer runs on `schedule`, polls the Deployments API for authoritative Vercel-authored data. | The scheduled consumer itself is trusted-source code, but the residual vulnerability class remains: **any future PR can add `.github/workflows/anything.yml` with `on: deployment_status` and `permissions: contents: write, pull-requests: write`, and receive that token the moment Vercel deploys the PR** — no code we ship in workflow YAML can prevent this. |
| 11 | Added a `pull_request_target` guard (loaded from the base branch, YAML the PR cannot edit) that scans changed workflow files for `on: deployment_status` and fails the PR. | Post-hoc: the malicious workflow can start and receive its write token concurrent with (or before) the guard completes. Failing the PR merge does not withdraw a token GitHub already handed to the running workflow. Mac-Codex Round-11 CR: "A post-hoc optional check is not an equivalent control." |

## The residual class this repo cannot close

For public non-Enterprise GitHub repositories, there is **no
platform-level knob** that caps what the top-level `permissions:` block
in a workflow YAML file may request.

- `default_workflow_permissions=read` (this repo's current setting) only
  sets the DEFAULT; an explicit `permissions:` block in a workflow file
  overrides it — GitHub Workflow permissions docs are explicit:
  https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository#setting-the-permissions-of-the-github_token-for-your-repository
- "Require approval for fork PR workflows" applies to fork PRs; our
  automation branches are same-repo, so it does not gate them.
- Branch protection / rulesets restrict merges, not workflow execution
  on the PR head.
- Only GitHub Enterprise Cloud has organization-level policy that
  caps workflow-declared permissions:
  https://docs.github.com/en/enterprise-cloud@latest/admin/enforcing-policies/enforcing-policies-for-your-enterprise/enforcing-policies-for-github-actions-in-your-enterprise

Given this, the residual class is: **any collaborator with permission
to push a branch and open a PR can add an `on: deployment_status`
workflow that grants itself `contents: write` / `pull-requests: write`
and receive that token on the first Vercel deploy of their PR head.**

## The two paths to close it

Either of these closes the class from **outside** PR-controlled
workflow YAML. Both require access this repo does not have today:

1. **Disable the event source at Vercel.** In the Vercel dashboard,
   under Project → Settings → Git → GitHub Integration, turn off
   "GitHub Deployments" (Vercel then stops creating GitHub
   `deployment` records for this repo, and no `deployment_status`
   events fire — any `on: deployment_status` workflow, no matter who
   adds it, has nothing to trigger). The consumer would then need to
   poll Vercel's own API directly using `VERCEL_TOKEN`. Both the
   dashboard change and `VERCEL_TOKEN` are covered by **DIC-1399**
   (blocked upstream — DIC-1401's parent card notes DIC-1399 owns the
   Vercel dashboard/secret surface for this project).

2. **Move to GitHub Enterprise Cloud with a workflow-permissions
   policy that caps `permissions: contents: write` for
   `pull_request_target` / `deployment_status` triggers.** This is not
   this repo's tier and is out of scope.

## What ships in this repository today (round 12)

- **No workflow file in `.github/workflows/`** subscribes to
  `deployment_status` or `deployment`. The round-10
  `vercel-deploy-status-post.yml` (schedule-triggered consumer) and
  the round-11 `guard-deploy-status-triggers.yml`
  (`pull_request_target` guard) are both **deleted**.
- **Best-effort CI hygiene**: `scripts/test-vercel-function-count-guard.mjs`
  contains a small test that scans every workflow file for
  `on: deployment_status` in a trigger position and fails Validate if
  a future PR reintroduces one. This is NOT a security control (a PR
  can delete the test in the same diff) — it exists to make an
  accidental addition loud in code review.
- **All prior functional DIC-1401 deliverables remain intact**:
  branch-guard bound to trusted project identity
  (`scripts/ci/vercel-branch-guard.sh` + `vercel-project-registry.tsv`);
  `EXPO_PUBLIC_STORE_MVP` define guard + lane self-declaration in each
  branch's `vercel.json`; SHA-parity contract; function-count cap;
  EAS provenance; preview-reproduction; release-APK pipeline. None of
  these have any `deployment_status` dependency.

## What has to happen to un-block the mirror

Owner action on `dicoge/hunterCard`:

1. Complete DIC-1399. This delivers Vercel dashboard access + a
   `VERCEL_TOKEN` repo secret.
2. In the Vercel dashboard, disable "GitHub Deployments" for both
   `holocard-hunter` and `holohunter-staging` projects.
3. Re-implement the mirror as a schedule-triggered workflow that
   polls Vercel's own API (`GET
   https://api.vercel.com/v6/deployments?projectId=...&teamId=...`)
   with `VERCEL_TOKEN`, filtering to terminal Vercel deployment
   statuses, and posting the same failure / Production-success
   summaries this repo previously drafted.
4. Verify by exact-head CR that no repo workflow subscribes to
   `deployment_status`, and that the API poller uses only Vercel-side
   authoritative data (no GitHub Deployments API dependency).

## Alignment with the DIC-1401 spec

DIC-1401's parent card explicitly permits deferring deploy-related
items when DIC-1399 blocks them:

> 6. 實際 staging deploy 受 DIC-1399 阻塞時，本卡仍完成可獨立完成的
>    branch/CI PR，並把部署 gate 留為 blocked，不要求使用者現在提供 secrets。

Translation: "When actual staging deploy is blocked by DIC-1399, this
card still completes the independently-doable branch/CI PR, and
leaves the deploy gate as blocked — do not require the user to
provide secrets now."

The public deploy-status mirror is one such deploy-gated deliverable.
The rest of DIC-1401 — branch-guard identity binding, define guard,
parity contract, function-count guard, EAS provenance,
preview-reproduction, release-APK pipeline — ships in these PRs
independently and correctly.
