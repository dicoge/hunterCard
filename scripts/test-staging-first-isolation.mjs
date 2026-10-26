#!/usr/bin/env node
/**
 * Test-first flow: staging-first isolation (offline).
 *
 *   1. Workflow wiring: every staging push (code and data) runs CI; the
 *      stage-promotion proof job always runs, read-only, never skipped; data
 *      bots target staging and no longer push to or deploy from main.
 *   2. Promotion proof behaviour (scripts/ci/stage-promotion-proof.sh) against
 *      a local bare git remote and a fake `gh`: only the live, CI-green staging
 *      tip that contains main may be promoted into main.
 *   3. Staging store binding (api/_lib/kv-namespace.ts): with a KV store
 *      configured, staging refuses KV access unless the store host is the
 *      recorded staging store and differs from the recorded production store.
 *      Production keys are unchanged.
 *   4. Stage flag reconciliation: EXPO_PUBLIC_APP_STAGE / EXPO_PUBLIC_APP_ENV
 *      (and APP_ENV at build time) must agree; conflicts and unknown values
 *      fail closed in the runtime resolver and in app.config.js.
 *
 * Nothing here touches the network. Run: npm run test:staging-first-isolation
 */
if (!process.env.APP_ENV) process.env.APP_ENV = 'production';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const yaml = (rel) => parseYaml(read(rel));

let checks = 0;
async function check(label, fn) {
  await fn();
  checks += 1;
  process.stdout.write(`  ok  ${label}\n`);
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ── 1. Workflow wiring ─────────────────────────────────────────────────────
const ci = yaml('.github/workflows/ci.yml');

await check('ci.yml runs on every main and staging push, with no paths-ignore', () => {
  assert.deepEqual(ci.on.push.branches, ['main', 'staging']);
  assert.equal(ci.on.push['paths-ignore'], undefined, 'data-only staging commits must run CI too');
  assert.equal(ci.on.push.paths, undefined);
});

await check('stage-promotion-proof job: stable name, never skipped, read-only, runs the proof script', () => {
  const job = ci.jobs['stage-promotion-proof'];
  assert.ok(job, 'ci.yml must define the stage-promotion-proof job');
  assert.equal(job.name, 'Stage promotion proof');
  assert.equal(job.if, undefined, 'a job-level if would let the required check be skipped (skipped counts as passing)');
  assert.deepEqual(job.permissions, { contents: 'read', actions: 'read' });
  assert.equal(ci.permissions, undefined, 'no workflow-level permission widening');
  const step = job.steps.find((s) => s.run === 'bash scripts/ci/stage-promotion-proof.sh');
  assert.ok(step, 'the job must run scripts/ci/stage-promotion-proof.sh');
  assert.equal(step.env.EVENT_NAME, '${{ github.event_name }}');
  assert.equal(step.env.BASE_REF, '${{ github.base_ref }}');
  assert.equal(step.env.HEAD_REF, '${{ github.head_ref }}');
  assert.equal(step.env.HEAD_SHA, '${{ github.event.pull_request.head.sha }}');
  assert.equal(step.env.HEAD_REPO, '${{ github.event.pull_request.head.repo.full_name }}');
  const checkout = job.steps.find((s) => String(s.uses).startsWith('actions/checkout@'));
  assert.equal(Number(checkout?.with?.['fetch-depth']), 0, 'ancestry check needs full history');
});

await check('deploy-production stays workflow_dispatch-only behind the existing gates', () => {
  const deploy = ci.jobs['deploy-production'];
  assert.match(deploy.if, /github\.event_name == 'workflow_dispatch'/);
  assert.match(deploy.if, /inputs\.deploy_production/);
  for (const gate of ['preflight', 'validate', 'release-apk-postpackage-guard']) assert.ok(deploy.needs.includes(gate));
});

await check('CI Validate runs this suite and the DIC-1189 staging isolation suite', () => {
  const runs = ci.jobs.validate.steps.map((s) => s.run).filter(Boolean);
  assert.ok(runs.includes('npm run test:staging-first-isolation'));
  assert.ok(runs.includes('npm run test:dic1189-staging-isolation'));
  assert.ok(runs.includes('npm run test:staging-alpha-flow'));
});

await check('scheduled data bots open their PRs against staging, built from staging', () => {
  for (const file of ['official-catalog-sync.yml', 'refresh-yt-stats.yml', 'collect-tournament-reports.yml']) {
    const wf = yaml(`.github/workflows/${file}`);
    const base = Object.values(wf.jobs)[0].env?.BASE_BRANCH ?? wf.env?.BASE_BRANCH;
    assert.equal(base, 'staging', `${file} BASE_BRANCH`);
    const checkout = Object.values(wf.jobs)[0].steps.find((s) => String(s.uses).startsWith('actions/checkout@'));
    assert.equal(checkout.with.ref, '${{ env.BASE_BRANCH }}', `${file} checks out the base branch`);
  }
});

await check('manual yuyu build writes to staging only and no longer fires a deploy hook', () => {
  const raw = read('.github/workflows/scrape-yuyu-prices.yml');
  const wf = parseYaml(raw);
  const steps = wf.jobs['build-database'].steps;
  assert.equal(steps.find((s) => s.name === 'Checkout').with.ref, 'staging');
  const push = steps.find((s) => s.name === 'Commit and push if changed').run;
  assert.match(push, /git push origin HEAD:refs\/heads\/staging/);
  assert.doesNotMatch(raw, /git push origin main/);
  assert.doesNotMatch(raw, /VERCEL_DEPLOY_HOOK/);
});

await check('eas.json: staging-alpha sets both stage flags; production profiles set neither; Node floor inherited', () => {
  const eas = JSON.parse(read('eas.json'));
  const alpha = eas.build['staging-alpha'];
  assert.equal(alpha.env.EXPO_PUBLIC_APP_STAGE, 'staging');
  assert.equal(alpha.env.EXPO_PUBLIC_APP_ENV, 'staging');
  assert.equal(alpha.extends, 'production');
  assert.equal(alpha.node, undefined, 'staging-alpha inherits production.node');
  assert.equal(eas.build.production.node, '22.23.4');
  for (const name of ['production', 'production-apk', 'production-release', 'production-apk-release']) {
    const env = eas.build[name].env ?? {};
    assert.equal(env.EXPO_PUBLIC_APP_STAGE, undefined, `${name}`);
    assert.equal(env.EXPO_PUBLIC_APP_ENV, undefined, `${name}`);
  }
});

await check('vercel.json keeps the deployment-data gate and clears the Metro cache', () => {
  const cfg = JSON.parse(read('vercel.json'));
  assert.ok(cfg.buildCommand.startsWith('npm run test:deployment-data && expo export --platform web --clear && '));
});

// ── 2. Promotion proof behaviour ───────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-promotion-proof-'));
try {
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  };
  const git = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const origin = path.join(tmp, 'origin.git');
  const work = path.join(tmp, 'work');
  git(tmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
  git(tmp, 'init', '--quiet', '-b', 'main', work);
  git(work, 'remote', 'add', 'origin', origin);
  const commit = (msg) => { git(work, 'commit', '--quiet', '--allow-empty', '-m', msg); return git(work, 'rev-parse', 'HEAD'); };
  commit('main 1');
  git(work, 'push', '--quiet', 'origin', 'main');
  git(work, 'checkout', '--quiet', '-b', 'staging');
  const stagingOld = commit('staging feature');
  const stagingTip = commit('staging data refresh');
  git(work, 'push', '--quiet', 'origin', 'staging');

  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  const ghLog = path.join(tmp, 'gh-args.log');
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${ghLog}"\n[ -n "$FAKE_GH_EXIT" ] && exit "$FAKE_GH_EXIT"\nprintf '%s\\n' "$FAKE_GH_OUT"\n`, { mode: 0o755 });

  const proof = (env) => spawnSync('bash', [path.join(ROOT, 'scripts/ci/stage-promotion-proof.sh')], {
    cwd: work,
    env: { ...gitEnv, PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: 'owner/repo', ...env },
    encoding: 'utf8',
  });
  const ok = {
    EVENT_NAME: 'pull_request', BASE_REF: 'main', HEAD_REF: 'staging', HEAD_SHA: stagingTip,
    HEAD_REPO: 'owner/repo', FAKE_GH_OUT: '1',
  };
  const expectExit = (label, env, code) => {
    const r = proof(env);
    assert.equal(r.status, code, `${label}: expected exit ${code}, got ${r.status}\n${r.stdout}${r.stderr}`);
  };

  await check('proof admits a promotion PR of the live, CI-green staging tip that contains main', () => {
    fs.rmSync(ghLog, { force: true });
    expectExit('pull_request', ok, 0);
    expectExit('pull_request_target', { ...ok, EVENT_NAME: 'pull_request_target' }, 0);
    const args = fs.readFileSync(ghLog, 'utf8');
    assert.match(args, new RegExp(`actions/workflows/ci\\.yml/runs\\?head_sha=${stagingTip}&branch=staging&per_page=100`));
    assert.ok(args.includes('(.event == "push" or .event == "workflow_dispatch")'), 'run filter must accept only push / staging validation dispatch');
    assert.ok(args.includes(`.head_sha == "${stagingTip}"`) && args.includes('.head_branch == "staging"'));
    assert.ok(args.includes('.status == "completed"') && args.includes('.conclusion == "success"'));
    assert.ok(args.includes('.path == ".github/workflows/ci.yml"'));
    assert.ok(!args.includes('pull_request'), 'PR runs must never count as staging CI proof');
  });

  await check('proof is an explicit no-op for pushes, dispatches and PRs not into main (no CI lookup)', () => {
    fs.rmSync(ghLog, { force: true });
    expectExit('push', { EVENT_NAME: 'push', FAKE_GH_EXIT: '1' }, 0);
    expectExit('workflow_dispatch', { EVENT_NAME: 'workflow_dispatch', FAKE_GH_EXIT: '1' }, 0);
    expectExit('PR into staging', { ...ok, BASE_REF: 'staging', HEAD_REF: 'feature/x', FAKE_GH_EXIT: '1' }, 0);
    assert.equal(fs.existsSync(ghLog), false, 'no-op paths must not query CI');
  });

  await check('proof fails closed on unknown events', () => {
    for (const ev of ['merge_group', 'schedule', 'issue_comment', '']) expectExit(`event ${ev}`, { ...ok, EVENT_NAME: ev }, 1);
  });

  await check('proof refuses feature, bot, main and fork heads straight into main', () => {
    for (const head of ['feature/new-ui', 'bot/official-catalog-sync', 'bot/refresh-yt-stats', 'main', 'staging2', '']) {
      expectExit(`head ${head}`, { ...ok, HEAD_REF: head }, 1);
    }
    expectExit('fork', { ...ok, HEAD_REPO: 'someone/repo' }, 1);
    expectExit('empty head repo', { ...ok, HEAD_REPO: '' }, 1);
  });

  await check('proof refuses malformed and stale staging SHAs', () => {
    expectExit('short sha', { ...ok, HEAD_SHA: stagingTip.slice(0, 12) }, 1);
    expectExit('empty sha', { ...ok, HEAD_SHA: '' }, 1);
    expectExit('stale staging commit', { ...ok, HEAD_SHA: stagingOld }, 1);
  });

  await check('proof refuses without a completed successful staging push CI run', () => {
    expectExit('zero runs', { ...ok, FAKE_GH_OUT: '0' }, 1);
    expectExit('garbage', { ...ok, FAKE_GH_OUT: 'null' }, 1);
    expectExit('gh error', { ...ok, FAKE_GH_EXIT: '1' }, 1);
  });

  await check('proof refuses a staging tip that does not contain the latest main', () => {
    git(work, 'checkout', '--quiet', 'main');
    commit('main hotfix not on staging');
    git(work, 'push', '--quiet', 'origin', 'main');
    expectExit('main ahead', ok, 1);
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── 3. Staging store binding ───────────────────────────────────────────────
const ns = await import(path.join(ROOT, 'api/_lib/kv-namespace.ts'));
const STG = 'stg-kv.upstash.example';
const PRD = 'prd-kv.upstash.example';

await check('assertStagingStoreBinding accepts only the recorded staging store, distinct from production', () => {
  ns.assertStagingStoreBinding({});
  ns.assertStagingStoreBinding({ KV_REST_API_URL: `https://${STG}`, STAGING_KV_STORE_HOST: STG, PRODUCTION_KV_STORE_HOST: PRD });
  ns.assertStagingStoreBinding({ KV_URL: `rediss://default@${STG}:6379`, STAGING_KV_STORE_HOST: `${STG}:6379`, PRODUCTION_KV_STORE_HOST: PRD });
  const bad = [
    { KV_REST_API_URL: `https://${STG}` },
    { KV_REST_API_URL: `https://${STG}`, STAGING_KV_STORE_HOST: STG },
    { KV_REST_API_URL: `https://${STG}`, PRODUCTION_KV_STORE_HOST: PRD },
    { KV_REST_API_URL: `https://${PRD}`, STAGING_KV_STORE_HOST: STG, PRODUCTION_KV_STORE_HOST: PRD },
    { KV_REST_API_URL: `https://${PRD}`, STAGING_KV_STORE_HOST: PRD, PRODUCTION_KV_STORE_HOST: PRD },
    { KV_REST_API_URL: 'not a url', STAGING_KV_STORE_HOST: STG, PRODUCTION_KV_STORE_HOST: PRD },
  ];
  for (const env of bad) assert.throws(() => ns.assertStagingStoreBinding(env), ns.StagingStoreBindingError, JSON.stringify(env));
});

await check('nsKey: staging with an unproven store throws; proven store prefixes; production unchanged', () => {
  const clear = { STAGING_KV_STORE_HOST: undefined, PRODUCTION_KV_STORE_HOST: undefined, KV_URL: undefined, EXPO_PUBLIC_APP_ENV: undefined };
  withEnv({ ...clear, APP_ENV: 'staging', KV_REST_API_URL: `https://${PRD}` }, () => {
    assert.throws(() => ns.nsKey('auth:user:1'), ns.StagingStoreBindingError);
  });
  withEnv({ ...clear, APP_ENV: 'staging', KV_REST_API_URL: `https://${STG}`, STAGING_KV_STORE_HOST: STG, PRODUCTION_KV_STORE_HOST: PRD }, () => {
    assert.equal(ns.nsKey('auth:user:1'), 'staging:auth:user:1');
  });
  withEnv({ ...clear, APP_ENV: 'production', KV_REST_API_URL: `https://${PRD}` }, () => {
    assert.equal(ns.nsKey('auth:user:1'), 'auth:user:1');
  });
  withEnv({ ...clear, APP_ENV: undefined, KV_REST_API_URL: `https://${PRD}` }, () => {
    assert.throws(() => ns.nsKey('auth:user:1'));
  });
});

// ── 4. Stage flag reconciliation ───────────────────────────────────────────
const api = await import(path.join(ROOT, 'src/config/apiOrigin.ts'));
const appConfig = require(path.join(ROOT, 'app.config.js'));
const STAGING = 'https://holohunter-staging.vercel.app';

await check('resolveClientStage: either flag may name staging; conflicts and unknown values are null', () => {
  const cases = [
    [undefined, undefined, 'production'], ['', 'production', 'production'], ['production', undefined, 'production'],
    ['staging', undefined, 'staging'], [undefined, 'staging', 'staging'], ['staging', 'staging', 'staging'],
    ['staging', 'production', null], ['production', 'staging', null],
    ['prod', undefined, null], [undefined, 'stg', null], ['staging', 'test', null],
  ];
  for (const [stage, env, want] of cases) assert.equal(api.resolveClientStage(stage, env), want, `${stage}/${env}`);
  assert.equal(api.resolveNativeApiOrigin({ stage: undefined, appEnv: 'staging', stagingOrigin: STAGING }), STAGING);
  assert.equal(api.resolveNativeApiOrigin({ stage: undefined, appEnv: 'staging', stagingOrigin: undefined }), null);
  assert.equal(api.resolveNativeApiOrigin({ stage: 'production', appEnv: 'staging', stagingOrigin: STAGING }), null);
});

await check('nativeApiOrigin fails closed on conflicting or staging-without-origin client flags', () => {
  withEnv({ EXPO_PUBLIC_APP_STAGE: undefined, EXPO_PUBLIC_APP_ENV: 'staging', EXPO_PUBLIC_STAGING_API_ORIGIN: undefined }, () => {
    assert.throws(() => api.nativeApiOrigin(), api.StageApiOriginError);
  });
  withEnv({ EXPO_PUBLIC_APP_STAGE: 'production', EXPO_PUBLIC_APP_ENV: 'staging', EXPO_PUBLIC_STAGING_API_ORIGIN: STAGING }, () => {
    assert.throws(() => api.nativeApiOrigin(), api.StageApiOriginError);
  });
  withEnv({ EXPO_PUBLIC_APP_STAGE: undefined, EXPO_PUBLIC_APP_ENV: 'staging', EXPO_PUBLIC_STAGING_API_ORIGIN: STAGING }, () => {
    assert.equal(api.nativeApiOrigin(), STAGING);
  });
  withEnv({ EXPO_PUBLIC_APP_STAGE: undefined, EXPO_PUBLIC_APP_ENV: undefined, EXPO_PUBLIC_STAGING_API_ORIGIN: undefined }, () => {
    assert.equal(api.nativeApiOrigin(), api.PRODUCTION_ORIGIN);
  });
});

await check('app.config.js: all three stage flags must agree; staging needs a non-production origin', () => {
  const ok = (env) => appConfig.resolveBuildStage(env);
  assert.equal(ok({}).stage, 'production');
  assert.equal(ok({ APP_ENV: 'production' }).stage, 'production');
  assert.equal(ok({ APP_ENV: 'staging', EXPO_PUBLIC_APP_ENV: 'staging', EXPO_PUBLIC_STAGING_API_ORIGIN: STAGING }).apiOrigin, STAGING);
  assert.equal(ok({ EXPO_PUBLIC_APP_STAGE: 'staging', EXPO_PUBLIC_APP_ENV: 'staging', EXPO_PUBLIC_STAGING_API_ORIGIN: STAGING }).stage, 'staging');
  for (const env of [
    { APP_ENV: 'staging' },
    { EXPO_PUBLIC_APP_ENV: 'staging' },
    { APP_ENV: 'production', EXPO_PUBLIC_APP_ENV: 'staging', EXPO_PUBLIC_STAGING_API_ORIGIN: STAGING },
    { EXPO_PUBLIC_APP_STAGE: 'staging', APP_ENV: 'production', EXPO_PUBLIC_STAGING_API_ORIGIN: STAGING },
    { APP_ENV: 'prod' },
    { EXPO_PUBLIC_APP_ENV: 'staging ', EXPO_PUBLIC_APP_STAGE: 'Production', EXPO_PUBLIC_STAGING_API_ORIGIN: STAGING },
    { APP_ENV: 'staging', EXPO_PUBLIC_STAGING_API_ORIGIN: api.PRODUCTION_ORIGIN },
  ]) {
    assert.throws(() => ok(env), JSON.stringify(env));
  }
});

// ── 5. ci.yml preflight: staging validation dispatch + unchanged main recovery ─
// Executes the preflight step's own `run:` text from ci.yml against a local
// bare remote, so the tested logic is exactly what the workflow runs.
const preflightStep = ci.jobs.preflight.steps.find((s) => typeof s.run === 'string' && s.run.includes('workflow_dispatch'));
const ptmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-preflight-'));
try {
  assert.ok(preflightStep, 'ci.yml preflight must keep its dispatch gate step');
  assert.equal(preflightStep.env.DEPLOY_PRODUCTION, '${{ inputs.deploy_production }}');
  assert.equal(Number(ci.jobs.preflight.steps.find((s) => String(s.uses).startsWith('actions/checkout@')).with?.['fetch-depth']), 0);
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  };
  const git = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const origin = path.join(ptmp, 'origin.git');
  const work = path.join(ptmp, 'work');
  git(ptmp, 'init', '--quiet', '--bare', '-b', 'main', origin);
  git(ptmp, 'init', '--quiet', '-b', 'main', work);
  git(work, 'remote', 'add', 'origin', origin);
  const commit = (msg) => { git(work, 'commit', '--quiet', '--allow-empty', '-m', msg); return git(work, 'rev-parse', 'HEAD'); };
  const mainTip = commit('main 1');
  git(work, 'push', '--quiet', 'origin', 'main');
  git(work, 'checkout', '--quiet', '-b', 'staging');
  const stagingOld = commit('staging bot data push');
  const stagingTip = commit('staging bot data push 2');
  git(work, 'push', '--quiet', 'origin', 'staging');

  const runPreflight = (env) => spawnSync('bash', ['-c', preflightStep.run], { cwd: work, env: { ...gitEnv, ...env }, encoding: 'utf8' });
  const stagingOk = {
    EVENT_NAME: 'workflow_dispatch', DISPATCH_REF: 'refs/heads/staging',
    DISPATCH_SHA: stagingTip, EXPECTED_SHA: stagingTip, DEPLOY_PRODUCTION: 'false',
  };
  const expectExit = (label, env, code) => {
    const r = runPreflight(env);
    assert.equal(r.status, code, `${label}: expected exit ${code}, got ${r.status}\n${r.stdout}${r.stderr}`);
    return r;
  };

  await check('preflight admits a validation-only dispatch of the exact live staging tip that contains main', () => {
    const r = expectExit('staging validation', stagingOk, 0);
    assert.match(r.stdout, /validation only; never deployed/);
  });

  await check('preflight refuses any staging dispatch that does not say deploy_production=false exactly', () => {
    for (const v of ['true', '', 'False', 'TRUE', '0']) expectExit(`deploy=${v}`, { ...stagingOk, DEPLOY_PRODUCTION: v }, 1);
  });

  await check('preflight refuses missing, malformed, mismatched and stale staging SHAs', () => {
    expectExit('missing sha', { ...stagingOk, EXPECTED_SHA: '' }, 1);
    expectExit('short sha', { ...stagingOk, EXPECTED_SHA: stagingTip.slice(0, 12) }, 1);
    expectExit('uppercase sha', { ...stagingOk, EXPECTED_SHA: stagingTip.toUpperCase() }, 1);
    expectExit('expected != dispatched', { ...stagingOk, DISPATCH_SHA: stagingOld }, 1);
    expectExit('stale staging commit', { ...stagingOk, EXPECTED_SHA: stagingOld, DISPATCH_SHA: stagingOld }, 1);
  });

  await check('preflight refuses dispatches from any other ref', () => {
    for (const ref of ['refs/heads/feature/x', 'refs/heads/bot/official-catalog-sync', 'refs/tags/v1.0.0', 'refs/heads/staging2', '']) {
      expectExit(`ref ${ref}`, { ...stagingOk, DISPATCH_REF: ref }, 1);
    }
  });

  await check('preflight main recovery path is unchanged: exact live main tip only, deploy intent allowed there', () => {
    expectExit('main recovery', { EVENT_NAME: 'workflow_dispatch', DISPATCH_REF: 'refs/heads/main', DISPATCH_SHA: mainTip, EXPECTED_SHA: mainTip, DEPLOY_PRODUCTION: 'true' }, 0);
    expectExit('main with staging sha', { EVENT_NAME: 'workflow_dispatch', DISPATCH_REF: 'refs/heads/main', DISPATCH_SHA: stagingTip, EXPECTED_SHA: stagingTip, DEPLOY_PRODUCTION: 'false' }, 1);
    expectExit('push no-op', { EVENT_NAME: 'push', DISPATCH_REF: 'refs/heads/staging' }, 0);
  });

  await check('preflight refuses a staging tip that does not contain the latest main', () => {
    git(work, 'checkout', '--quiet', 'main');
    commit('main hotfix not on staging');
    git(work, 'push', '--quiet', 'origin', 'main');
    git(work, 'checkout', '--quiet', 'staging');
    expectExit('main ahead', stagingOk, 1);
  });
} finally {
  fs.rmSync(ptmp, { recursive: true, force: true });
}

// ── 6. Local scheduler: staging only, no production side effects ───────────
const codeLines = (rel) => read(rel).split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => !/^\s*#/.test(l));

await check('local scheduler and launcher never fetch, pull, push or attest against main', () => {
  for (const rel of ['scripts/local-scrape-and-push.sh', 'scripts/scheduler-launch.sh']) {
    const offenders = codeLines(rel).filter(([, l]) => /origin\/main|refs\/heads\/main|HEAD:main|origin main\b/.test(l));
    assert.deepEqual(offenders, [], `${rel} still references main: ${JSON.stringify(offenders)}`);
  }
  const pushes = codeLines('scripts/local-scrape-and-push.sh').filter(([, l]) => /\bgit push\b/.test(l));
  assert.ok(pushes.length >= 2, 'sanity: the scheduler still publishes its artifact');
  for (const [n, l] of pushes) {
    assert.match(l, /git push origin (HEAD:staging|"HEAD:refs\/heads\/\$ISOLATED_BRANCH")/, `push at line ${n} must target staging or the bot/scrape handoff: ${l.trim()}`);
  }
  for (const rel of ['scripts/local-scrape-and-push.sh', 'scripts/scheduler-launch.sh']) {
    const body = read(rel);
    assert.match(body, /case "\$\{HUNTERCARD_REMOTE_REF:-origin\/staging\}" in/);
    assert.match(body, /fetch --write-fetch-head origin "\+refs\/heads\/staging:/);
  }
});

await check('local scheduler sends no production alerts and drops production-lane credentials first', () => {
  const lines = codeLines('scripts/local-scrape-and-push.sh');
  const calls = lines.filter(([, l]) => /send-push-alerts|send:price-alerts|send-price-alerts|VERCEL_DEPLOY_HOOK.*curl|curl .*deploy/.test(l) && !/^\s*(unset|echo)/.test(l.trim()));
  assert.deepEqual(calls, [], `production alert/deploy calls remain: ${JSON.stringify(calls)}`);
  const body = read('scripts/local-scrape-and-push.sh');
  const unsetAt = body.search(/^unset KV_REST_API_URL /m);
  assert.ok(unsetAt > 0, 'the scheduler must unset production-lane credentials');
  const unsetBlock = body.slice(unsetAt, body.indexOf('\n\n', unsetAt));
  for (const name of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'KV_REST_API_READ_ONLY_TOKEN', 'KV_URL', 'PUSH_NOTIFY_SECRET', 'PUSH_NOTIFY_URL', 'EXPO_ACCESS_TOKEN', 'VERCEL_DEPLOY_HOOK', 'VERCEL_TOKEN']) {
    assert.ok(new RegExp(`\\b${name}\\b`).test(unsetBlock), `${name} must be unset`);
  }
  const firstAction = body.search(/^(LOCK_FILE=|git |node |npm )/m);
  assert.ok(firstAction === -1 || unsetAt < firstAction, 'credentials must be dropped before any git/node step');
});

console.log(`✓ staging-first isolation: ${checks} checks passed`);
