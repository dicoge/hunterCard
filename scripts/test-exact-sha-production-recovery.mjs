#!/usr/bin/env node
/**
 * DIC-1430 CI/CD recovery — exact-main manual CI + exact-SHA Production deploy.
 *
 * The incident this guards against: PR #193 merged as `defa9592…` with a tree
 * identical to the approved head `781db3fa…`, but GitHub emitted no PushEvent
 * for that merge. No Actions run and no check suite fired, so no Vercel
 * Production deployment was ever created and Production stayed on pre-merge
 * code while `main` moved. The cause of the missing event is UNKNOWN — which
 * is exactly why the recovery path has to be durable, manual, and fail-closed
 * rather than a one-off hand-run of the API.
 *
 * Two workflow contracts are pinned here:
 *
 *   * `.github/workflows/ci.yml` — keeps its existing push(main) /
 *     pull_request(main, staging) behaviour, and gains a
 *     `workflow_dispatch.expected_sha` recovery entry point. A preflight job
 *     that ALWAYS runs proves the dispatch is aimed at the exact current tip
 *     of main (input shape, ref, `github.sha`, and a LIVE `git ls-remote`),
 *     and both real jobs hang off it. Preflight must never carry a job-level
 *     `if:` — a skipped `needs` dependency silently skips its dependants, so
 *     an event-gated preflight would turn every normal push/PR run into a
 *     green no-op. That trap is the single most dangerous way this recovery
 *     could make CI worse than it already is, so it is asserted directly.
 *
 *   * `.github/workflows/holohunter-exact-sha-deploy.yml` — a dispatch-only
 *     Production deploy that builds the EXACT commit it was handed. It must
 *     resolve the Vercel project by name (the `VERCEL_PROJECT_ID` secret is
 *     known-stale, see dic910-vercel-setup.yml), derive `repoId` at runtime,
 *     and create a fresh deployment with an explicit github `gitSource`
 *     carrying `expected_sha`.
 *
 * The deny-list below matters as much as the require-list. Every banned
 * pattern is a way to produce a GREEN "deployed" run that shipped something
 * other than the requested commit:
 *
 *   - `deploymentId` / `withLatestCommit` — redeploy-from-an-existing-build.
 *     dic910-vercel-setup.yml does exactly this, and it rebuilds whatever
 *     that old deployment pointed at, not the SHA you asked for. This suite
 *     used to strip every `.deploymentId` in the file before applying the
 *     ban, so that the alias proof could read the field back — a blanket
 *     exemption that would equally have hidden a property write or a
 *     serialized request field. The alias proof now lives in
 *     scripts/ci/verify-alias-binding.mjs, so the workflow has no honest
 *     reason to name the field at all and the ban needs no exemption. The
 *     Create Deployment body is inspected additionally and specifically, by
 *     EXECUTING its builder and scanning the JSON it actually emits.
 *   - latest-production lookup (`/v6/deployments?…target=production`) — the
 *     input SHA is never consulted; you redeploy the current Production.
 *   - deploy hook — fires a build of the branch tip, which during a recovery
 *     is precisely the thing whose state you cannot trust.
 *   - env / domain / DNS mutations — outside the blast radius of a deploy,
 *     and the incident scope explicitly forbids touching them.
 *
 * Deny-list checks run against EXECUTABLE lines only (comment lines stripped),
 * so the workflows can name the banned patterns in prose to explain the ban
 * without tripping their own guard.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WF_DIR = path.join(ROOT, '.github', 'workflows');
const CI_PATH = path.join(WF_DIR, 'ci.yml');
const DEPLOY_PATH = path.join(WF_DIR, 'holohunter-exact-sha-deploy.yml');
const ALIAS_HELPER_PATH = path.join(ROOT, 'scripts', 'ci', 'verify-alias-binding.mjs');

const CANONICAL_HOST = 'holohunter.dicoge.com';
const VERCEL_PROJECT_NAME = 'holocard-hunter';
const NPM_SCRIPT = 'test:exact-sha-production-recovery';
const ALIAS_NPM_SCRIPT = 'test:alias-binding-validator';

let passed = 0;
function check(label, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

function readWorkflow(abs) {
  if (!fs.existsSync(abs)) return null;
  const raw = fs.readFileSync(abs, 'utf8');
  return { raw, parsed: parseYaml(raw), active: executableLines(raw) };
}

/** Strip whole-line `#` comments so deny-list checks only see runnable YAML. */
function executableLines(raw) {
  return raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

/** `on:` is a YAML 1.1 boolean key; some parsers hand it back as `true`. */
function triggers(parsed) {
  return parsed?.on ?? parsed?.true ?? null;
}

function countMatches(text, re) {
  return [...text.matchAll(re)].length;
}

// ─────────────────────────────────────────────────────────────────────────
// Part 1 — ci.yml: existing behaviour preserved + exact-main manual recovery
// ─────────────────────────────────────────────────────────────────────────
const ci = readWorkflow(CI_PATH);
check('ci.yml exists on disk', ci !== null);

if (ci) {
  const on = triggers(ci.parsed);
  check('ci.yml declares triggers', !!on);

  // ── Existing push/PR semantics must survive untouched ────────────────
  check(
    'ci.yml keeps push trigger on main (existing behaviour preserved)',
    Array.isArray(on?.push?.branches) && on.push.branches.includes('main'),
    `got ${JSON.stringify(on?.push)}`,
  );
  check(
    'ci.yml keeps pull_request trigger on main + staging (DIC-1189 contract)',
    Array.isArray(on?.pull_request?.branches)
      && on.pull_request.branches.includes('main')
      && on.pull_request.branches.includes('staging'),
    `got ${JSON.stringify(on?.pull_request)}`,
  );

  // ── The new manual recovery entry point ──────────────────────────────
  const dispatch = on?.workflow_dispatch;
  check(
    'ci.yml adds a workflow_dispatch trigger for manual recovery',
    dispatch !== undefined && dispatch !== null,
  );
  const expectedShaInput = dispatch?.inputs?.expected_sha;
  check(
    'ci.yml workflow_dispatch declares an expected_sha input',
    !!expectedShaInput,
    `got ${JSON.stringify(dispatch?.inputs)}`,
  );
  check(
    'ci.yml expected_sha input is a REQUIRED string',
    expectedShaInput?.required === true && expectedShaInput?.type === 'string',
    `got required=${expectedShaInput?.required} type=${expectedShaInput?.type}`,
  );
  check(
    'ci.yml expected_sha input carries NO default (operator must state the SHA)',
    expectedShaInput !== undefined
      && !Object.prototype.hasOwnProperty.call(expectedShaInput ?? {}, 'default'),
    'a default would let an empty dispatch deploy something nobody named',
  );

  // ── Preflight job: always runs, fails closed on dispatch ─────────────
  const ciJobs = ci.parsed?.jobs ?? {};
  const preflightName = Object.keys(ciJobs).find((n) => /preflight/i.test(n));
  check(
    'ci.yml defines a preflight job',
    !!preflightName,
    `jobs present: ${Object.keys(ciJobs).join(', ')}`,
  );
  const preflight = preflightName ? ciJobs[preflightName] : null;

  // THE trap: a job-level `if:` that skips preflight on push/PR would skip
  // every job that `needs:` it. Preflight must be unconditional at the job
  // level and no-op INTERNALLY instead.
  check(
    'ci.yml preflight job has NO job-level `if:` (skipped-needs trap avoided)',
    preflight !== null && !Object.prototype.hasOwnProperty.call(preflight ?? {}, 'if'),
    'a skipped preflight silently skips validate + the APK guard, turning real CI green without running it',
  );
  const preflightRuns = (preflight?.steps ?? []).map((s) => s.run ?? '').join('\n');
  // The job is serialized whole so `env:` bindings count as "wired in" — the
  // run blocks deliberately read env vars rather than interpolating `${{ }}`
  // inline, which is the injection-safe idiom.
  const preflightJson = JSON.stringify(preflight ?? {});
  check(
    'ci.yml preflight explicitly no-ops and succeeds for non-dispatch events',
    /github\.event_name/.test(preflightJson) && /exit 0/.test(preflightRuns),
    'preflight must branch on the event and pass normal push/PR through with a success exit',
  );

  // ── Fail-closed conditions on the dispatch path ──────────────────────
  check(
    'ci.yml preflight validates expected_sha is a lowercase 40-hex SHA',
    /\[0-9a-f\]\{40\}|\[0-9a-f\]\{40,40\}/.test(preflightRuns),
    'a short or upper-case SHA must be rejected before anything runs',
  );
  check(
    'ci.yml preflight pins the dispatch ref to refs/heads/main',
    /refs\/heads\/main/.test(preflightRuns),
  );
  check(
    'ci.yml preflight requires github.sha to equal expected_sha',
    /github\.sha/.test(preflightJson)
      && /EXPECTED_SHA/.test(preflightRuns)
      && /!=/.test(preflightRuns),
    'the dispatched commit must be wired in AND actually compared',
  );
  check(
    'ci.yml preflight re-checks LIVE origin/main via git ls-remote',
    /git\s+ls-remote[^\n]*origin[^\n]*refs\/heads\/main/.test(preflightRuns),
    'the checked-out SHA alone can lag; the live remote tip is the authority',
  );

  // ── Both real jobs gate on preflight ─────────────────────────────────
  const validate = ciJobs.validate;
  const apkGuard = ciJobs['release-apk-postpackage-guard'];
  check('ci.yml still defines the validate job', !!validate);
  check('ci.yml still defines the release-apk-postpackage-guard job', !!apkGuard);

  const needsOf = (job) => {
    const n = job?.needs;
    if (!n) return [];
    return Array.isArray(n) ? n : [n];
  };
  check(
    'ci.yml validate depends on the preflight job',
    !!preflightName && needsOf(validate).includes(preflightName),
    `validate needs: ${JSON.stringify(validate?.needs)}`,
  );
  check(
    'ci.yml release-apk-postpackage-guard depends on the preflight job',
    !!preflightName && needsOf(apkGuard).includes(preflightName),
    `apk guard needs: ${JSON.stringify(apkGuard?.needs)}`,
  );

  // ── No existing CI step was weakened or dropped ──────────────────────
  const validateRuns = (validate?.steps ?? []).map((s) => s.run ?? '').join('\n');
  const PRESERVED_STEPS = [
    'npx tsc --noEmit',
    'npm run test:expo-native-compat',
    'npm run test:release-apk-pipeline',
    'npm run test:i18n',
    'npm run test:exact-print-favorite-identity',
    'npm run test:store-mvp-behavior',
    'node scripts/generate-native-database.mjs --check',
  ];
  for (const cmd of PRESERVED_STEPS) {
    check(`ci.yml validate still runs \`${cmd}\``, validateRuns.includes(cmd));
  }
  check(
    'ci.yml validate keeps its full step count (no silent step removal)',
    (validate?.steps ?? []).length >= 100,
    `validate has ${(validate?.steps ?? []).length} steps`,
  );
  check(
    'ci.yml release-apk-postpackage-guard still runs the real packaged-APK check',
    ((apkGuard?.steps ?? []).map((s) => s.run ?? '').join('\n')).includes(
      'npm run test:release-apk-postpackage',
    ),
  );

  // ── This very suite is wired into Validate ───────────────────────────
  check(
    `ci.yml validate runs \`npm run ${NPM_SCRIPT}\``,
    validateRuns.includes(`npm run ${NPM_SCRIPT}`),
    'the recovery contract must be enforced by CI, not only by hand',
  );
  check(
    `ci.yml validate runs \`npm run ${ALIAS_NPM_SCRIPT}\``,
    validateRuns.includes(`npm run ${ALIAS_NPM_SCRIPT}`),
    'the alias validator BEHAVIOUR must be executed by CI, not just described by structural checks',
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Part 1b — the registered-CI trampoline (DIC-1430 Actions registry recovery)
// ─────────────────────────────────────────────────────────────────────────
//
// The second incident. `holohunter-exact-sha-deploy.yml` is present on the
// default branch at a reviewed blob, actionlint 1.7.12 reports zero errors,
// and yet GitHub's Actions workflow registry never listed it: its filename
// endpoint returns 404 and it cannot be dispatched at all. A later real push
// CI on current main did not register it either. `ci.yml` IS registered and
// dispatches fine.
//
// So the registered workflow becomes the entry point and CALLS the reviewed
// production workflow as a LOCAL reusable workflow. The point of the design
// is that the production logic is invoked, never copied — a second transcript
// of the deploy shell living in ci.yml would be an unreviewed deploy path
// that none of Part 2's guarantees cover. That is asserted directly below.
//
// The gate is evaluated, not merely pattern-matched: the job's `if:` is
// parsed and run against hostile contexts (push/PR with the deploy flag
// forced true, each gate failed in turn), and then re-run against mutants of
// itself to prove the evaluation can actually fail.
const TRAMPOLINE_USES = './.github/workflows/holohunter-exact-sha-deploy.yml';
const DEPLOY_INPUT = 'deploy_production';
const GATES = ['preflight', 'validate', 'release-apk-postpackage-guard'];

if (ci) {
  const on = triggers(ci.parsed);
  const ciJobs = ci.parsed?.jobs ?? {};
  const dispatchInputs = on?.workflow_dispatch?.inputs ?? {};
  const deployInput = dispatchInputs[DEPLOY_INPUT];

  // ── Explicit deploy intent, off unless someone asks for it ───────────
  check(
    `ci.yml declares an explicit ${DEPLOY_INPUT} dispatch input`,
    !!deployInput,
    `dispatch inputs present: ${Object.keys(dispatchInputs).join(', ')}`,
  );
  check(
    `ci.yml ${DEPLOY_INPUT} is a boolean input`,
    deployInput?.type === 'boolean',
    `got type=${JSON.stringify(deployInput?.type)}`,
  );
  check(
    `ci.yml ${DEPLOY_INPUT} DEFAULTS TO FALSE`,
    deployInput?.default === false,
    'an omitted deploy intent must never be read as "deploy to Production"',
  );
  check(
    `ci.yml ${DEPLOY_INPUT} is not required`,
    deployInput?.required !== true,
    'an ordinary manual CI run must stay usable without opting into a deployment',
  );
  check(
    'ci.yml keeps expected_sha as the ONLY required dispatch input',
    Object.entries(dispatchInputs)
      .filter(([, v]) => v?.required === true)
      .map(([k]) => k)
      .join(',') === 'expected_sha',
    `required inputs: ${Object.entries(dispatchInputs)
      .filter(([, v]) => v?.required === true)
      .map(([k]) => k)
      .join(', ')}`,
  );

  // ── The trampoline job calls the reviewed workflow; it does not copy it ─
  const trampolineName = Object.keys(ciJobs).find(
    (n) => typeof ciJobs[n]?.uses === 'string'
      && ciJobs[n].uses.includes('holohunter-exact-sha-deploy'),
  );
  check(
    'ci.yml defines a job that INVOKES the production deploy workflow',
    !!trampolineName,
    `jobs present: ${Object.keys(ciJobs).join(', ')}`,
  );
  const tramp = trampolineName ? ciJobs[trampolineName] : null;

  check(
    'the trampoline calls the LOCAL reviewed workflow by repo-relative path',
    tramp?.uses === TRAMPOLINE_USES,
    `got uses=${JSON.stringify(tramp?.uses)}; a remote owner/repo@ref reference would run code this repo did not review`,
  );
  check(
    'the trampoline forwards expected_sha EXACTLY, unmodified',
    tramp?.with?.expected_sha === '${{ inputs.expected_sha }}',
    `got with.expected_sha=${JSON.stringify(tramp?.with?.expected_sha)}`,
  );
  check(
    'the trampoline passes expected_sha and nothing else',
    JSON.stringify(Object.keys(tramp?.with ?? {}).sort()) === JSON.stringify(['expected_sha']),
    `with keys: ${JSON.stringify(Object.keys(tramp?.with ?? {}))}`,
  );
  check(
    'the trampoline declares NO steps of its own (a caller, not a second deploy path)',
    tramp !== null && !Object.prototype.hasOwnProperty.call(tramp ?? {}, 'steps'),
    'inline steps beside `uses:` would be an unreviewed deployment path',
  );
  check(
    'the trampoline declares no runs-on (reusable-workflow callers do not need a runner)',
    tramp !== null && !Object.prototype.hasOwnProperty.call(tramp ?? {}, 'runs-on'),
  );

  // Only the two secrets the callee actually declares, passed explicitly.
  const trampSecrets = tramp?.secrets;
  check(
    'the trampoline passes secrets EXPLICITLY (not blanket `inherit`)',
    trampSecrets !== 'inherit' && typeof trampSecrets === 'object' && trampSecrets !== null,
    `got secrets=${JSON.stringify(trampSecrets)}; inherit hands the callee every secret in the repo`,
  );
  check(
    'the trampoline passes ONLY VERCEL_TOKEN + VERCEL_ORG_ID',
    JSON.stringify(Object.keys(trampSecrets ?? {}).sort())
      === JSON.stringify(['VERCEL_ORG_ID', 'VERCEL_TOKEN']),
    `secret keys: ${JSON.stringify(Object.keys(trampSecrets ?? {}))}`,
  );
  for (const name of ['VERCEL_TOKEN', 'VERCEL_ORG_ID']) {
    check(
      `the trampoline maps ${name} from the repository secret of the same name`,
      trampSecrets?.[name] === `\${{ secrets.${name} }}`,
      `got ${JSON.stringify(trampSecrets?.[name])}`,
    );
  }

  // ── The production logic must NOT have been transcribed into ci.yml ──
  const ciJobRuns = Object.values(ciJobs)
    .flatMap((j) => (j?.steps ?? []).map((s) => s?.run ?? ''))
    .join('\n');
  const NOT_IN_CI = [
    { name: 'the Vercel API', re: /api\.vercel\.com/ },
    { name: 'a deployment-creating POST', re: /-X\s+POST[\s\S]{0,200}deployments/ },
    { name: 'the Vercel bearer token', re: /--oauth2-bearer/ },
    { name: 'the canonical alias binding validator', re: /verify-alias-binding\.mjs/ },
  ];
  for (const { name, re } of NOT_IN_CI) {
    check(
      `ci.yml does NOT duplicate ${name} (the production workflow is invoked, not copied)`,
      !re.test(executableLines(ciJobRuns)),
      `matched ${re} in a ci.yml run block`,
    );
  }

  // ── The gate: parsed and EVALUATED against hostile contexts ──────────
  //
  // Adding a job-level `if:` REMOVES the implicit `success()` that `needs:`
  // would otherwise apply, so the three gate results have to be named
  // explicitly. Both halves are checked here: the event/intent gate and the
  // three result gates.
  const gateExpr = tramp?.if;
  check(
    'the trampoline declares a job-level `if:` gate',
    typeof gateExpr === 'string' && gateExpr.trim().length > 0,
    `got if=${JSON.stringify(gateExpr)}`,
  );

  const unwrap = (expr) => String(expr ?? '')
    .replace(/^\s*\$\{\{/, '')
    .replace(/\}\}\s*$/, '')
    .trim();
  const terms = (expr) => unwrap(expr).split('&&').map((t) => t.trim()).filter(Boolean);

  /**
   * Evaluate the `&&`-joined gate subset actually used here against a context.
   * An unsupported term shape resolves to `undefined` and therefore falsifies
   * the gate — so a shape this evaluator cannot read shows up as the
   * all-success case failing, never as a hostile case silently passing.
   */
  const evalGate = (expr, ctx) => {
    const resolve = (ref) => {
      const segs = ref
        .trim()
        .replace(/\['([^']+)'\]/g, '.$1')
        .replace(/\["([^"]+)"\]/g, '.$1')
        .split('.')
        .map((s) => s.trim())
        .filter(Boolean);
      let cur = ctx;
      for (const key of segs) {
        if (cur === null || typeof cur !== 'object' || !(key in cur)) return undefined;
        cur = cur[key];
      }
      return cur;
    };
    const list = terms(expr);
    if (list.length === 0) return false;
    for (const raw of list) {
      const term = raw.replace(/^\(+/, '').replace(/\)+$/, '').trim();
      const cmp = /^(.+?)\s*==\s*'([^']*)'$/.exec(term);
      if (cmp) {
        if (resolve(cmp[1]) !== cmp[2]) return false;
        continue;
      }
      if (resolve(term) !== true) return false;
    }
    return true;
  };

  // `deploy` is forced TRUE even in the push/PR contexts on purpose: that is
  // the hostile case, and it proves the EVENT term carries the weight rather
  // than the input merely happening to be absent outside a dispatch.
  const ctxOf = ({ event = 'workflow_dispatch', deploy = true, results = {} } = {}) => ({
    github: { event_name: event },
    event_name: event,
    inputs: { expected_sha: 'a'.repeat(40), [DEPLOY_INPUT]: deploy },
    needs: Object.fromEntries(GATES.map((g) => [g, { result: results[g] ?? 'success' }])),
  });

  check(
    'GATE: a manual dispatch with deploy intent and all three gates green DOES deploy',
    evalGate(gateExpr, ctxOf()) === true,
    'the gate must actually admit the one case it exists to allow',
  );
  for (const event of ['push', 'pull_request']) {
    check(
      `GATE: a ${event} event can NEVER deploy, even with the deploy flag forced true`,
      evalGate(gateExpr, ctxOf({ event })) === false,
      'ordinary push/PR behaviour must be unchanged',
    );
  }
  check(
    `GATE: a dispatch WITHOUT ${DEPLOY_INPUT} does not deploy`,
    evalGate(gateExpr, ctxOf({ deploy: false })) === false,
    'deploy intent must be explicit',
  );
  for (const gate of GATES) {
    for (const bad of ['failure', 'skipped', 'cancelled', '']) {
      check(
        `GATE: deploy is blocked when ${gate} is "${bad || '(empty)'}"`,
        evalGate(gateExpr, ctxOf({ results: { [gate]: bad } })) === false,
        'a non-successful gate must never be treated as a pass',
      );
    }
  }
  check(
    'the trampoline `needs:` all three gates',
    JSON.stringify(
      (Array.isArray(tramp?.needs) ? tramp.needs : [tramp?.needs].filter(Boolean)).sort(),
    ) === JSON.stringify([...GATES].sort()),
    `needs: ${JSON.stringify(tramp?.needs)}`,
  );

  // ── MUTATION PROOF: each removed term must break a distinct guarantee ──
  // A gate assertion is only worth having if deleting the thing it guards
  // makes it fail. Every mutant below drops exactly one term and must then
  // admit a context the real gate rejects.
  const dropTerm = (expr, re) => terms(expr).filter((t) => !re.test(t)).join(' && ');
  const mutate = (label, re, ctx) => {
    const mutant = dropTerm(gateExpr, re);
    check(
      `MUTATION: removing the ${label} term actually changes the gate`,
      terms(mutant).length === terms(gateExpr).length - 1,
      `expected one fewer term; got ${terms(mutant).length} vs ${terms(gateExpr).length}`,
    );
    check(
      `MUTATION: without the ${label} term the gate wrongly admits the blocked case`,
      evalGate(mutant, ctx) === true,
      'the assertion above would pass even with this protection deleted',
    );
  };
  mutate('event_name', /event_name/, ctxOf({ event: 'push' }));
  mutate(DEPLOY_INPUT, new RegExp(DEPLOY_INPUT), ctxOf({ deploy: false }));
  for (const gate of GATES) {
    mutate(
      `${gate} result`,
      new RegExp(gate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      ctxOf({ results: { [gate]: 'failure' } }),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Part 2 — holohunter-exact-sha-deploy.yml: exact-SHA Production recovery
// ─────────────────────────────────────────────────────────────────────────
const dep = readWorkflow(DEPLOY_PATH);
check('.github/workflows/holohunter-exact-sha-deploy.yml exists on disk', dep !== null);

if (dep) {
  const on = triggers(dep.parsed);

  // ── Manually dispatched OR called by name — nothing else ─────────────
  //
  // DIC-1430 registry recovery: GitHub never registered this file, so its own
  // dispatch endpoint 404s. It therefore also has to be reachable as a
  // reusable workflow called by the registered ci.yml. Both invocation modes
  // are deliberate; every OTHER trigger stays forbidden, because an
  // auto-firing Production deploy is exactly the failure this whole workflow
  // was written to prevent.
  const triggerNames = on ? Object.keys(on).sort() : [];
  check(
    'deploy workflow fires ONLY via workflow_dispatch + workflow_call (no push/PR/schedule auto-fire)',
    JSON.stringify(triggerNames) === JSON.stringify(['workflow_call', 'workflow_dispatch']),
    `triggers: ${JSON.stringify(triggerNames)}`,
  );
  for (const banned of ['push', 'pull_request', 'schedule', 'repository_dispatch', 'workflow_run']) {
    check(
      `deploy workflow declares NO ${banned} trigger`,
      !on || !Object.prototype.hasOwnProperty.call(on, banned),
      'Production must never deploy itself off an event',
    );
  }

  const input = on?.workflow_dispatch?.inputs?.expected_sha;
  check('deploy workflow declares an expected_sha input', !!input);
  check(
    'deploy workflow expected_sha is a REQUIRED string',
    input?.required === true && input?.type === 'string',
    `got required=${input?.required} type=${input?.type}`,
  );
  check(
    'deploy workflow expected_sha carries NO default',
    input !== undefined && !Object.prototype.hasOwnProperty.call(input ?? {}, 'default'),
  );

  // ── The reusable-invocation contract ─────────────────────────────────
  // The caller can only satisfy a contract the callee actually declares, so
  // the callee's declaration is pinned here and the caller's forwarding is
  // pinned in Part 1b. Both halves have to agree or the call fails closed at
  // the GitHub level.
  const callOn = on?.workflow_call;
  const callInput = callOn?.inputs?.expected_sha;
  check(
    'deploy workflow declares expected_sha for reusable invocation too',
    !!callInput,
    `workflow_call inputs: ${JSON.stringify(Object.keys(callOn?.inputs ?? {}))}`,
  );
  check(
    'deploy workflow workflow_call expected_sha is a REQUIRED string',
    callInput?.required === true && callInput?.type === 'string',
    `got required=${callInput?.required} type=${callInput?.type}`,
  );
  check(
    'deploy workflow workflow_call expected_sha carries NO default',
    callInput !== undefined
      && !Object.prototype.hasOwnProperty.call(callInput ?? {}, 'default'),
    'a default would let a caller deploy a commit nobody named',
  );
  check(
    'the dispatch and reusable expected_sha inputs are the same contract',
    JSON.stringify(input) === JSON.stringify(callInput),
    'the two invocation modes must not drift into different validation rules',
  );

  // Secrets are declared from what the job actually uses — the two the steps
  // reference — never guessed, and never more than that.
  const declaredCallSecrets = callOn?.secrets ?? {};
  const usedSecrets = [...new Set(
    [...dep.raw.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]),
  )].sort();
  check(
    'deploy workflow declares exactly the secrets it actually uses for reusable invocation',
    JSON.stringify(Object.keys(declaredCallSecrets).sort()) === JSON.stringify(usedSecrets),
    `declared: ${JSON.stringify(Object.keys(declaredCallSecrets).sort())} vs used: ${JSON.stringify(usedSecrets)}`,
  );
  check(
    'the declared reusable secrets are exactly VERCEL_TOKEN + VERCEL_ORG_ID',
    JSON.stringify(Object.keys(declaredCallSecrets).sort())
      === JSON.stringify(['VERCEL_ORG_ID', 'VERCEL_TOKEN']),
    `got ${JSON.stringify(Object.keys(declaredCallSecrets))}`,
  );
  for (const name of ['VERCEL_TOKEN', 'VERCEL_ORG_ID']) {
    check(
      `workflow_call declares ${name} as REQUIRED`,
      declaredCallSecrets?.[name]?.required === true,
      `got ${JSON.stringify(declaredCallSecrets?.[name])}; an optional secret would fail deep inside a Production deploy instead of at the call`,
    );
  }

  // ── Least privilege + bounded execution ──────────────────────────────
  const perms = dep.parsed?.permissions;
  check(
    'deploy workflow requests least GitHub permission (contents: read only)',
    perms && typeof perms === 'object' && !Array.isArray(perms)
      && Object.keys(perms).length === 1 && perms.contents === 'read',
    `got ${JSON.stringify(perms)}`,
  );

  const depJobs = dep.parsed?.jobs ?? {};
  const depJobNames = Object.keys(depJobs);
  check('deploy workflow defines at least one job', depJobNames.length >= 1);
  const job = depJobs[depJobNames[0]];
  check(
    'deploy job declares a bounded timeout-minutes',
    Number.isFinite(Number(job?.['timeout-minutes'])) && Number(job['timeout-minutes']) > 0,
    `got ${JSON.stringify(job?.['timeout-minutes'])}`,
  );

  const conc = dep.parsed?.concurrency ?? job?.concurrency;
  check(
    'deploy workflow declares a concurrency group',
    !!conc && (typeof conc === 'string' || typeof conc.group === 'string'),
    `got ${JSON.stringify(conc)}`,
  );
  check(
    'deploy concurrency does NOT cancel a deployment halfway (cancel-in-progress: false)',
    typeof conc === 'object' && conc?.['cancel-in-progress'] === false,
    'cancelling mid-deploy leaves Production in an unknown state',
  );

  // ── Exact-SHA proof before anything is created ───────────────────────
  const depRuns = (job?.steps ?? []).map((s) => s.run ?? '').join('\n');
  check(
    'deploy workflow validates expected_sha is a lowercase 40-hex SHA',
    /\[0-9a-f\]\{40\}/.test(depRuns),
  );
  check(
    'deploy workflow requires expected_sha == github.sha',
    /github\.sha/.test(dep.active),
  );
  check(
    'deploy workflow requires expected_sha == checked-out HEAD',
    /git\s+rev-parse\s+HEAD/.test(depRuns),
  );
  check(
    'deploy workflow requires expected_sha == live refs/heads/main',
    /git\s+ls-remote[^\n]*origin[^\n]*refs\/heads\/main/.test(depRuns),
  );

  // ── Secrets: only the two that already exist, never printed ──────────
  const secretRefs = [...dep.raw.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  const ALLOWED_SECRETS = new Set(['VERCEL_TOKEN', 'VERCEL_ORG_ID']);
  const disallowed = [...new Set(secretRefs)].filter((s) => !ALLOWED_SECRETS.has(s));
  check(
    'deploy workflow references ONLY VERCEL_TOKEN + VERCEL_ORG_ID',
    disallowed.length === 0,
    `disallowed secrets referenced: ${disallowed.join(', ')}`,
  );
  check(
    'deploy workflow does not trust the known-stale VERCEL_PROJECT_ID secret',
    !/secrets\.VERCEL_PROJECT_ID/.test(dep.raw),
  );
  check(
    'deploy workflow passes the token via curl --oauth2-bearer (never echoed into a header string)',
    /--oauth2-bearer/.test(depRuns),
  );

  // ── Project resolution by name + GitHub linkage + runtime repoId ─────
  check(
    `deploy workflow resolves the Vercel project by name "${VERCEL_PROJECT_NAME}"`,
    dep.active.includes(VERCEL_PROJECT_NAME) && /\/v9\/projects\//.test(depRuns),
  );
  check(
    'deploy workflow asserts the project is GitHub-linked',
    /link[\s\S]{0,200}github/i.test(depRuns),
  );
  check(
    'deploy workflow derives repoId at runtime (never hardcoded)',
    /repoId/.test(depRuns) && !/repoId["'\s:=]+\d{5,}/.test(dep.active),
  );

  // ── Fresh exact-SHA Production deployment ────────────────────────────
  check(
    'deploy workflow POSTs /v13/deployments with forceNew=1 + teamId',
    /\/v13\/deployments\?forceNew=1&teamId=/.test(depRuns),
  );
  check(
    'deploy workflow requests target: production',
    /"target"\s*:\s*"production"|target:\s*['"]production['"]/.test(depRuns),
  );
  check(
    'deploy workflow supplies an explicit github gitSource',
    /gitSource/.test(depRuns) && /"type"\s*:\s*"github"|type:\s*['"]github['"]/.test(depRuns),
  );
  check(
    'deploy workflow pins gitSource.ref to main',
    /"ref"\s*:\s*"main"|ref:\s*['"]main['"]/.test(depRuns),
  );
  check(
    'deploy workflow pins gitSource.sha to the expected SHA',
    /\bsha\s*:/.test(depRuns) && /EXPECTED_SHA/.test(depRuns),
  );
  check(
    'deploy workflow creates exactly ONE POST (a single fresh deployment)',
    countMatches(depRuns, /-X\s+POST/g) === 1,
    `found ${countMatches(depRuns, /-X\s+POST/g)} POST calls`,
  );

  // ── Bounded poll with hard failure states ────────────────────────────
  check(
    'deploy workflow polls the deployment state',
    /readyState|\bstate\b/.test(depRuns) && /\/v13\/deployments\//.test(depRuns),
  );
  check(
    'deploy workflow treats READY as the only success state',
    /READY/.test(depRuns),
  );
  check(
    'deploy workflow hard-fails on ERROR and CANCELED',
    /ERROR/.test(depRuns) && /CANCELED/.test(depRuns),
  );
  check(
    'deploy workflow bounds the poll with a max attempt/deadline and fails on timeout',
    /MAX_ATTEMPTS|max_attempts|DEADLINE|attempt\s*-?[lg]t|attempts?\s*[<>]/.test(depRuns)
      && /timed out|timeout/i.test(depRuns),
  );

  // ── Post-deploy provenance verification ──────────────────────────────
  check(
    'deploy workflow re-fetches the deployment with withGitRepoInfo=true',
    /withGitRepoInfo=true/.test(depRuns),
  );
  check(
    'deploy workflow verifies the finished deployment target is production',
    /target[\s\S]{0,120}production/.test(depRuns),
  );
  check(
    'deploy workflow verifies the deployed source SHA against gitSource.sha AND git commit metadata',
    /gitSource[\s\S]{0,200}sha/i.test(depRuns)
      && /githubCommitSha|gitRepo|commit/i.test(depRuns),
    'the v13 response shape varies; both the gitSource and the authoritative commit metadata must be consulted',
  );
  check(
    'deploy workflow fails closed when NO source SHA field is present',
    /(missing|unable to (?:read|determine)|could not (?:read|determine))[\s\S]{0,120}sha/i.test(depRuns)
      || /sha[\s\S]{0,80}(missing|empty|not found)/i.test(depRuns),
    'a response with no SHA must be an error, never a silent pass',
  );

  // ── Canonical alias + live Production HTTP ───────────────────────────
  check(
    `deploy workflow requires the canonical alias ${CANONICAL_HOST}`,
    dep.active.includes(CANONICAL_HOST),
  );
  check(
    'deploy workflow retries the canonical root until HTTP 200',
    /200/.test(depRuns) && /http_code/.test(depRuns),
  );

  // ── Alias BINDING: the final Production linkage authority ────────────
  //
  // HTTP 200 on the canonical host proves only that *something* answers.
  // The deployment payload's `alias` array is a deployment-side claim, and a
  // concurrent Vercel/Git deployment can move the alias between that read
  // and the probe — the 200 is byte-identical either way. The run is only
  // allowed to report success once the ALIAS side confirms it points at this
  // run's DEPLOYMENT_ID, via the read-only
  // `GET /v4/aliases/{idOrAlias}` endpoint (its 200 response requires
  // `deploymentId` and mirrors it in `deployment.id`).
  const depSteps = job?.steps ?? [];
  // Comments are stripped per step for the same reason the deny-list strips
  // them: a step must be able to EXPLAIN a rule in prose without that prose
  // either satisfying the rule or tripping it. A `# ... exit 0 ...` comment
  // warning against short-circuiting must not read as a short-circuit.
  const stepRun = (s) => executableLines(s?.run ?? '');
  const stepIndex = (re) => depSteps.findIndex((s) => re.test(stepRun(s)));

  const httpProbeIdx = stepIndex(/http_code[\s\S]*CANONICAL_HOST/);
  const aliasBindIdx = stepIndex(/\/v4\/aliases\//);
  const aliasStep = aliasBindIdx >= 0 ? stepRun(depSteps[aliasBindIdx]) : '';
  const httpStep = httpProbeIdx >= 0 ? stepRun(depSteps[httpProbeIdx]) : '';
  const depActiveRuns = depSteps.map(stepRun).join('\n');

  check(
    'deploy workflow reads the canonical alias via GET /v4/aliases/{idOrAlias}?teamId=',
    /https:\/\/api\.vercel\.com\/v4\/aliases\/\$\{CANONICAL_HOST\}\?teamId=\$\{VERCEL_ORG_ID\}/
      .test(depActiveRuns),
    'the alias must be resolved from the alias side, at the exact documented read endpoint',
  );
  // ── The validator is a committed, EXECUTABLE module ──────────────────
  // It used to be a `node -e '…'` heredoc, which no test could run. That is
  // how a High-severity bug — a missing top-level `deploymentId` accepted
  // whenever the optional nested mirror matched — sat behind 89 green string
  // checks. Behaviour is now asserted by scripts/test-alias-binding-validator
  // .mjs against that same module; what belongs HERE is only the wiring.
  check(
    'alias binding validator exists as a committed module',
    fs.existsSync(ALIAS_HELPER_PATH),
    `expected ${path.relative(ROOT, ALIAS_HELPER_PATH)} on disk`,
  );
  check(
    'alias-binding step invokes the committed validator (not an inline heredoc)',
    aliasBindIdx >= 0 && /node\s+scripts\/ci\/verify-alias-binding\.mjs/.test(aliasStep),
    'an inline `node -e` validator cannot be executed by a test',
  );
  check(
    'alias-binding step hands the validator the response, the host AND the runtime DEPLOYMENT_ID',
    /\/tmp\/alias-binding\.json/.test(aliasStep)
      && /"\$CANONICAL_HOST"/.test(aliasStep)
      && /"\$DEPLOYMENT_ID"/.test(aliasStep),
    'the validator must be told which deployment this run actually created',
  );
  check(
    'alias-binding step keeps no inline node validator alongside it',
    aliasBindIdx >= 0 && !/node\s+-e/.test(aliasStep),
    'a second, untested copy of the decision would defeat the extraction',
  );

  // ── All three validator outcomes handled, and handled distinctly ─────
  // The step contains TWO case statements — one over the alias API's HTTP
  // `$code`, one over the validator's `$rc` — and their catch-all arms mean
  // opposite things: an unreadable HTTP response retries, an unrecognised
  // validator status must fail closed. So slice the `$rc` case first, then
  // slice arms within it; a neighbouring arm's `exit` must not be able to
  // satisfy or falsify the assertion about this one.
  const rcCase = (/case\s+"\$rc"\s+in\n([\s\S]*?)\n\s*esac/.exec(aliasStep) ?? [])[1] ?? '';
  check(
    'alias-binding step branches on the validator status in its own case block',
    rcCase.length > 0,
    'could not isolate `case "$rc" in … esac`',
  );
  const rcArm = (label) => {
    const m = new RegExp(`\\n?\\s*${label}\\)\\n([\\s\\S]*?);;`).exec(rcCase);
    return m ? m[1] : null;
  };
  const armSuccess = rcArm('0');
  const armRetry = rcArm('2');
  const armFatal = rcArm('1');
  const armUnknown = rcArm('\\*');

  check(
    'alias-binding step captures the validator exit code and branches on it',
    /rc=\$\?/.test(aliasStep) && /case\s+"\$rc"/.test(aliasStep),
  );
  check(
    'validator success (0) proves linkage and exits 0',
    armSuccess !== null && /exit 0/.test(armSuccess),
    `0) arm: ${JSON.stringify(armSuccess)}`,
  );
  check(
    'validator retryable (2) does NOT exit — it falls through to the bounded loop',
    armRetry !== null && !/\bexit\b/.test(armRetry),
    `a retryable propagation state must keep waiting, not abort; 2) arm: ${JSON.stringify(armRetry)}`,
  );
  check(
    'validator fatal (1) aborts immediately with exit 1',
    armFatal !== null && /exit 1/.test(armFatal),
    'a malformed or self-contradicting alias record cannot be repaired by waiting',
  );
  check(
    'an unexpected validator status fails closed',
    armUnknown !== null && /exit 1/.test(armUnknown),
    `*) arm: ${JSON.stringify(armUnknown)}`,
  );
  check(
    'alias-binding check runs AFTER the HTTP 200 probe and is the LAST step',
    httpProbeIdx >= 0
      && aliasBindIdx > httpProbeIdx
      && aliasBindIdx === depSteps.length - 1,
    `http probe at step ${httpProbeIdx}, alias binding at ${aliasBindIdx} of ${depSteps.length}`,
  );
  check(
    'HTTP 200 probe does not `exit 0` early (that would skip the binding check)',
    httpProbeIdx >= 0 && !/\bexit\s+0\b/.test(httpStep),
    'a success exit in the probe step makes a reachable older deployment look like a completed deploy',
  );
  check(
    'alias-binding check is bounded and hard-fails on timeout',
    /MAX_ATTEMPTS/.test(aliasStep)
      && /never resolved to (?:the )?deployment/i.test(aliasStep)
      && /exit 1/.test(aliasStep),
    'propagation may lag, but an unbounded or soft-failing wait proves nothing',
  );
  check(
    'alias-binding check retries transient HTTP states before failing',
    /sleep/.test(aliasStep) && /continue/.test(aliasStep) && /\*\)/.test(aliasStep),
    'an alias record that is not readable yet must retry, not decide instantly',
  );
  check(
    'alias-binding check hard-fails the documented explicit alias-API errors',
    /401/.test(aliasStep) && /403/.test(aliasStep) && /410/.test(aliasStep),
    'unauthorized/forbidden/gone cannot be fixed by waiting out the window',
  );

  // ── No API-controlled byte may reach the Actions log ─────────────────
  //
  // A GitHub Actions log honours ANSI control sequences and `::workflow
  // command::` lines. Echoing a response body into it is therefore log
  // forgery and terminal manipulation carried out on behalf of whatever
  // answered the request — the Vercel alias API, or anything able to answer
  // for it. The rule this section enforces is absolute: response bodies are
  // parsed and compared, never printed, and no value lifted out of one is
  // interpolated into a diagnostic either.
  //
  // This is not hypothetical. The step used to `cat /tmp/alias-binding.json`
  // on an explicit 4xx, and the validator used to interpolate the JSON parse
  // exception, `error.code`, and both deployment ids. A record carrying
  // `"\u001b[2J::error::INJECTED"` survived into the log unchanged.
  const RAW_BODY_PRINTS = [
    { name: 'cat of the alias response file', re: /\bcat\b[^\n]*alias-binding\.json/ },
    { name: 'cat of any /tmp response file', re: /\bcat\b[^\n]*\/tmp\/\S*\.json/ },
    { name: 'echo of a response file via command substitution', re: /echo[^\n]*\$\(\s*cat\b/ },
    { name: 'tee of a response file into the log', re: /\btee\b[^\n]*\/tmp\/\S*\.json/ },
  ];
  const rawBodyPrintOffenders = (text) =>
    RAW_BODY_PRINTS.filter(({ re }) => re.test(text)).map(({ name }) => name);

  check(
    'the alias-binding step never prints the alias response body',
    rawBodyPrintOffenders(aliasStep).length === 0,
    `offending shapes: ${rawBodyPrintOffenders(aliasStep).join(', ')}`,
  );
  check(
    'NO step of the deploy workflow prints any response body',
    rawBodyPrintOffenders(depActiveRuns).length === 0,
    `offending shapes: ${rawBodyPrintOffenders(depActiveRuns).join(', ')}`,
  );
  check(
    'the deploy workflow never uploads a response file as an artifact',
    !/upload-artifact/.test(dep.active),
    'an artifact is just a slower way of publishing the same remote bytes',
  );

  // Shell diagnostics: every variable an `echo` puts in the log must be a
  // workflow constant, a bounded counter, or a value proven safe upstream.
  // `echo` lines that pipe or redirect are not log writes and are skipped.
  // `CANONICAL_HOST` and `VERCEL_PROJECT_NAME` are only admissible here
  // because they are literal constants in the job's own `env:` block — the
  // check below proves that, so neither can quietly become an expression or a
  // value lifted out of a response.
  const JOB_ENV_CONSTANTS = ['CANONICAL_HOST', 'VERCEL_PROJECT_NAME'];
  for (const name of JOB_ENV_CONSTANTS) {
    const value = job?.env?.[name];
    check(
      `${name} is a literal constant in the deploy job's env block`,
      typeof value === 'string' && value.length > 0 && !value.includes('${{'),
      `got ${JSON.stringify(value)}`,
    );
  }

  const ECHOED_VARS_ALLOWED = new Set([
    'attempt',              // bounded loop counter
    'MAX_ATTEMPTS',         // workflow constant
    'EXPECTED_SHA',         // operator input, already proven 40-hex and the tip of main
    'code',                 // curl's own %{http_code}, narrowed by the matched case arm
    'status',               // that same status reduced to three digits
    'rc',                   // the validator's exit code, an integer from $?
    'state',                // readyState reduced to an allowlisted token
    'DISPATCH_SHA',         // GitHub-supplied commit sha
    'head_sha',             // git rev-parse output
    'remote_sha',           // git ls-remote output
    ...JOB_ENV_CONSTANTS,   // literal env constants, proven literal above
  ]);
  const echoedVars = (text) => {
    const found = new Set();
    for (const line of text.split('\n')) {
      if (!/\becho\b/.test(line)) continue;
      if (/[|>]/.test(line)) continue; // piped/redirected: not a log write
      for (const m of line.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)) found.add(m[1]);
    }
    return [...found];
  };
  const echoed = echoedVars(depActiveRuns);
  const unexpectedEchoed = echoed.filter((v) => !ECHOED_VARS_ALLOWED.has(v));
  check(
    'every shell variable the deploy workflow echoes is a trusted, bounded value',
    unexpectedEchoed.length === 0,
    `unexpected echoed variables: ${unexpectedEchoed.join(', ')}`,
  );
  for (const apiDerived of ['DEPLOYMENT_ID', 'PROJECT_ID', 'REPO_ID']) {
    check(
      `the deploy workflow never echoes the API-derived ${apiDerived}`,
      !echoed.includes(apiDerived),
      'ids come out of a response body; the run is identified by EXPECTED_SHA instead',
    );
  }

  // Node diagnostics inside the workflow: same rule, different syntax.
  const ALLOWED_LOG_EXPRESSIONS = new Set([
    'field',    // a key of a local constant object, not response data
    'expected', // EXPECTED_SHA, already proven 40-hex
  ]);
  const consoleInterpolations = [
    ...depActiveRuns.matchAll(/console\.(?:log|error)\(\s*`([^`]*)`/g),
  ].flatMap((m) => [...m[1].matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1].trim()));
  const unexpectedLogged = consoleInterpolations.filter((e) => !ALLOWED_LOG_EXPRESSIONS.has(e));
  check(
    'every value interpolated into a workflow console diagnostic is a constant or the validated SHA',
    unexpectedLogged.length === 0,
    `unexpected interpolations: ${unexpectedLogged.join(', ')}`,
  );

  // A thrown parse error is an indirect body print: V8 quotes a slice of the
  // offending input back inside `err.message`.
  const parseSites = [...depActiveRuns.matchAll(/JSON\.parse\(/g)];
  const unguardedParses = parseSites.filter(
    (m) => !/try\s*\{[\s\S]{0,200}$/.test(depActiveRuns.slice(Math.max(0, m.index - 200), m.index)),
  );
  check(
    'every JSON.parse in the deploy workflow is guarded so no parse error can quote the payload',
    parseSites.length > 0 && unguardedParses.length === 0,
    `${unguardedParses.length} of ${parseSites.length} JSON.parse call(s) are unguarded`,
  );

  // Remote values that ARE echoed must be reduced to a bounded token first.
  const pollIdx = stepIndex(/readyState/);
  const pollStep = pollIdx >= 0 ? stepRun(depSteps[pollIdx]) : '';
  check(
    'the poll step reduces the remote readyState to an allowlisted token before echoing it',
    /\^\[A-Z_\]\{1,32\}\$/.test(pollStep) && /UNRECOGNISED/.test(pollStep),
    'readyState is response data; only a matched token may be printed',
  );
  check(
    'the alias-binding catch-all arm reduces the HTTP status to three digits before echoing it',
    /grep\s+-Eo\s+'\^\[0-9\]\{3\}\$'/.test(aliasStep),
    'the explicit 4xx arm is already narrowed by its pattern; the catch-all is not',
  );

  // API ids reaching GITHUB_ENV is a privileged sink, not just a log: an
  // unvalidated value containing a newline injects environment variables into
  // every later step.
  check(
    'every API-derived id clears a strict allowlist before it is written to GITHUB_ENV',
    /GITHUB_ENV/.test(depActiveRuns)
      && /\^\[A-Za-z0-9_-\]\{1,128\}\$/.test(depActiveRuns)
      && /\^\[0-9\]\{1,20\}\$/.test(depActiveRuns),
    'a newline in an unvalidated id would append arbitrary variables to the env file',
  );

  // ── The helper's own diagnostics must be fixed strings ───────────────
  // Comment lines are stripped first for the usual reason: the module has to
  // be able to EXPLAIN in prose that it no longer interpolates `err.message`
  // without that explanation tripping the check.
  const jsExecutableLines = (raw) =>
    raw
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');

  const helperRaw = fs.readFileSync(ALIAS_HELPER_PATH, 'utf8');
  const helperCode = jsExecutableLines(helperRaw);

  const HELPER_FORBIDDEN = [
    { name: 'the JSON parse / read exception', re: /\$\{[^}]*err[^}]*\}/i },
    { name: 'the caller-supplied host', re: /\$\{[^}]*\bhost\b[^}]*\}/ },
    { name: 'the response file path', re: /\$\{[^}]*jsonPath[^}]*\}/ },
    { name: 'the raw response body', re: /\$\{[^}]*\braw\b[^}]*\}/ },
    { name: 'any deployment id', re: /\$\{[^}]*(?:deploymentId|topLevel|nested)[^}]*\}/i },
    { name: 'the parsed record or its error code', re: /\$\{[^}]*record[^}]*\}/ },
    { name: 'a describe()-style value dump', re: /\$\{\s*describe\s*\(/ },
  ];
  for (const { name, re } of HELPER_FORBIDDEN) {
    check(
      `the alias validator never interpolates ${name} into a diagnostic`,
      !re.test(helperCode),
      `matched ${re} in executable helper source`,
    );
  }

  const HELPER_ALLOWED_INTERPOLATION =
    /^(?:line|sanitizeDiagnostic\(ALIAS_BINDING_MESSAGES\.[A-Z_]+\))$/;
  const helperInterpolations = [...helperCode.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1].trim());
  const badHelperInterpolations = helperInterpolations.filter(
    (e) => !HELPER_ALLOWED_INTERPOLATION.test(e),
  );
  check(
    'every value the alias validator interpolates is a sanitized entry of its fixed message table',
    badHelperInterpolations.length === 0,
    `unexpected interpolations: ${badHelperInterpolations.join(', ')}`,
  );
  check(
    'the alias validator keeps its message table frozen',
    /Object\.freeze\(/.test(helperCode) && /ALIAS_BINDING_MESSAGES/.test(helperCode),
    'a mutable table is a table a later edit can fill with response data',
  );
  check(
    'the alias validator sanitizes every line it prints',
    /function sanitizeDiagnostic/.test(helperCode)
      && (helperCode.match(/sanitizeDiagnostic\(/g) ?? []).length >= 4,
    'the final guard must sit on every emitting path, not just one',
  );

  // ── MUTATION PROOF for this section ──────────────────────────────────
  // These detectors are only worth having if they fire. Each is re-run
  // against the code shape it replaced, transcribed from commit 346d1863.
  const PRIOR_ALIAS_STEP = [
    'code=$(curl -sS -o /tmp/alias-binding.json -w \'%{http_code}\' \\',
    '  "https://api.vercel.com/v4/aliases/${CANONICAL_HOST}?teamId=${VERCEL_ORG_ID}" || true)',
    'echo "::error::Alias API returned HTTP ${code} for ${CANONICAL_HOST}."',
    'cat /tmp/alias-binding.json',
    'echo "attempt ${attempt}/${MAX_ATTEMPTS}: alias not bound to ${DEPLOYMENT_ID} yet."',
  ].join('\n');

  check(
    'MUTATION: the body-print detector catches the prior `cat /tmp/alias-binding.json`',
    rawBodyPrintOffenders(PRIOR_ALIAS_STEP).length > 0,
    'the detector cannot have caught the finding it was written for',
  );
  check(
    'MUTATION: the echoed-variable detector catches the prior ${DEPLOYMENT_ID} diagnostic',
    echoedVars(PRIOR_ALIAS_STEP).includes('DEPLOYMENT_ID'),
    'an API-derived id in an echo must be visible to this check',
  );

  const PRIOR_HELPER = [
    'return fatal(`Alias record for ${host} was not valid JSON: ${err.message}`);',
    'return fatal(`Alias API returned an error for ${host} (code=${code}).`);',
    'return retry(`${host} is bound to ${topLevel}, not this run deployment ${expectedDeploymentId}.`);',
    'console.error(`::error::Could not read the alias response at ${jsonPath}: ${err.message}`);',
  ].join('\n');

  const priorHelperOffences = HELPER_FORBIDDEN.filter(({ re }) => re.test(PRIOR_HELPER));
  check(
    'MUTATION: the helper-source detectors catch the prior interpolating diagnostics',
    priorHelperOffences.length >= 4,
    `only ${priorHelperOffences.length} detector(s) fired on the prior helper source`,
  );
  check(
    'MUTATION: the interpolation allowlist rejects the prior helper diagnostics',
    [...PRIOR_HELPER.matchAll(/\$\{([^}]*)\}/g)]
      .map((m) => m[1].trim())
      .some((e) => !HELPER_ALLOWED_INTERPOLATION.test(e)),
  );

  // ── HTTP probes must yield exactly ONE status code ───────────────────
  // `|| echo "000"` appends a SECOND line to a variable that already holds
  // curl's own `000` on connection failure, producing "000\n000" — a value
  // matching no arm of the comparison, so a hard network failure becomes a
  // silent spin instead of a reported one.
  check(
    'no HTTP probe uses `|| echo "000"` (a two-line code matches nothing)',
    !/\|\|\s*echo\s+["']?000/.test(depActiveRuns),
    'curl already reports 000 through -w; `|| true` keeps $code a single value',
  );
  check(
    'the canonical HTTP probe tolerates curl failure without fabricating a code',
    httpProbeIdx >= 0 && /\|\|\s*true/.test(httpStep),
  );
  check(
    'a failed canonical probe cannot surface as 200',
    httpProbeIdx >= 0
      && /\[\s*"\$code"\s*=\s*"200"\s*\]/.test(httpStep)
      && !/\|\|\s*echo\s+["']?200/.test(httpStep),
    'success must require an exact 200 reported by curl itself',
  );

  // ── The Create Deployment body, inspected where it is actually built ─
  // Scope is the point. The old suite stripped every `.deploymentId` in the
  // whole file before applying the ban — a blanket exemption that would have
  // hidden a property write or a serialized request field just as readily as
  // it permitted the alias proof. The ban is applied to the create step
  // SPECIFICALLY, and to the body it really produces, by running the builder.
  const createIdx = stepIndex(/-X\s+POST[\s\S]*\/v13\/deployments/);
  check(
    'deploy workflow has a locatable Create Deployment step',
    createIdx >= 0,
    'could not find the POST /v13/deployments step',
  );
  const createStep = createIdx >= 0 ? stepRun(depSteps[createIdx]) : '';
  check(
    'Create Deployment step never mentions deploymentId in ANY form',
    createIdx >= 0 && !/deploymentId/i.test(createStep),
    'an input, a property write, or a serialized field would each redeploy an existing build',
  );

  const builder = /body=\$\(node -e '([\s\S]*?)'\s*"\$VERCEL_PROJECT_NAME"/.exec(createStep);
  check(
    'Create Deployment body is built by an inspectable builder',
    !!builder,
    'could not extract the request-body builder from the create step',
  );
  if (builder) {
    const SAMPLE_SHA = 'a'.repeat(40);
    const built = spawnSync(
      process.execPath,
      ['-e', builder[1], VERCEL_PROJECT_NAME, 'prj_sample', '424242', SAMPLE_SHA],
      { encoding: 'utf8' },
    );
    check(
      'the request-body builder executes and emits output',
      built.status === 0,
      `exit ${built.status}: ${(built.stderr ?? '').trim().slice(0, 200)}`,
    );
    let payload = null;
    try {
      payload = JSON.parse(built.stdout);
    } catch (err) {
      check('the built request body parses as JSON', false, err.message);
    }
    if (payload) {
      const keys = Object.keys(payload).sort();
      check(
        'the serialized request body carries ONLY name/project/target/gitSource',
        JSON.stringify(keys) === JSON.stringify(['gitSource', 'name', 'project', 'target']),
        `body keys: ${JSON.stringify(keys)}`,
      );
      const BANNED_BODY_KEY = /^(deploymentId|withLatestCommit)$/i;
      const offending = [];
      (function walk(node, trail) {
        if (node === null || typeof node !== 'object') return;
        for (const [k, v] of Object.entries(node)) {
          if (BANNED_BODY_KEY.test(k)) offending.push([...trail, k].join('.'));
          walk(v, [...trail, k]);
        }
      })(payload, []);
      check(
        'no deploymentId / withLatestCommit is serialized at ANY depth of the request body',
        offending.length === 0,
        `found: ${offending.join(', ')}`,
      );
      check(
        'the built request body targets production',
        payload.target === 'production',
        `target=${JSON.stringify(payload.target)}`,
      );
      check(
        'the built request body pins the exact SHA via an explicit github gitSource',
        payload.gitSource?.type === 'github'
          && payload.gitSource?.ref === 'main'
          && payload.gitSource?.sha === SAMPLE_SHA,
        `gitSource=${JSON.stringify(payload.gitSource)}`,
      );
      check(
        'the built request body passes through the resolved project identity unchanged',
        payload.name === VERCEL_PROJECT_NAME && payload.project === 'prj_sample',
        `name=${JSON.stringify(payload.name)} project=${JSON.stringify(payload.project)}`,
      );
    }
  }

  // ── Deny-list: every way to green-light the wrong commit ─────────────
  // Applied to the workflow's executable lines with NO stripping. The alias
  // proof lives in scripts/ci/verify-alias-binding.mjs now, so the workflow
  // has no legitimate reason to name `deploymentId` at all — the ban can be
  // exact rather than carrying a blanket exemption.
  const FORBIDDEN = [
    { name: 'deploymentId as a request input (redeploy-from-existing-build)', re: /deploymentId/ },
    { name: 'alias assignment endpoint (POST /v2/deployments/{id}/aliases)', re: /deployments\/[^\s"']*\/aliases/ },
    { name: 'alias deletion endpoint (DELETE /v2/aliases/{aliasId})', re: /\/v2\/aliases\// },
    { name: 'withLatestCommit (branch tip, not the exact SHA)', re: /withLatestCommit/ },
    { name: 'latest-production deployment lookup', re: /\/v6\/deployments/ },
    { name: 'target=production query lookup (latest-prod clone)', re: /target=production/ },
    { name: 'Vercel deploy hook secret', re: /VERCEL_DEPLOY_HOOK/ },
    { name: 'deploy-hook integration endpoint', re: /\/v1\/integrations\/deploy/ },
    { name: 'project env mutation endpoint', re: /projects\/[^\s"']*\/env/ },
    { name: 'project domain mutation endpoint', re: /\/domains/ },
    { name: 'DNS record endpoint', re: /\/records/ },
    { name: 'HTTP DELETE', re: /-X\s+DELETE/ },
    { name: 'HTTP PATCH', re: /-X\s+PATCH/ },
    { name: 'HTTP PUT', re: /-X\s+PUT/ },
  ];
  for (const { name, re, text } of FORBIDDEN) {
    check(
      `deploy workflow does NOT use ${name}`,
      !re.test(text ?? dep.active),
      `matched ${re} on an executable line`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Part 3 — package.json wiring
// ─────────────────────────────────────────────────────────────────────────
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check(
    `package.json declares the ${NPM_SCRIPT} script`,
    typeof pkg.scripts?.[NPM_SCRIPT] === 'string'
      && pkg.scripts[NPM_SCRIPT].includes('test-exact-sha-production-recovery.mjs'),
    `got ${JSON.stringify(pkg.scripts?.[NPM_SCRIPT])}`,
  );
  check(
    `package.json declares the ${ALIAS_NPM_SCRIPT} script`,
    typeof pkg.scripts?.[ALIAS_NPM_SCRIPT] === 'string'
      && pkg.scripts[ALIAS_NPM_SCRIPT].includes('test-alias-binding-validator.mjs'),
    `got ${JSON.stringify(pkg.scripts?.[ALIAS_NPM_SCRIPT])}`,
  );
}

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ DIC-1430 exact-SHA CI/CD recovery contract: ${passed} checks passed`);
} else {
  console.error(`\n❌ DIC-1430 exact-SHA CI/CD recovery contract FAILED`);
}
