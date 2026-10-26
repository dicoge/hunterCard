#!/usr/bin/env node
/**
 * Test-first release flow: staging Alpha isolation (offline).
 *
 * Pins three things:
 *   1. Ref/profile isolation. `staging-alpha` is the only profile that may
 *      build a store AAB off main, and scripts/ci/staging-alpha-ref-guard.sh
 *      admits it only at the freshly fetched staging tip that contains main,
 *      has a successful ci.yml staging run (push, or the staging validation
 *      dispatch that can never deploy), and is not submitted. The production
 *      guard still refuses staging. Exercised against a local bare git remote
 *      and a fake `gh`; nothing leaves the machine.
 *   2. Stage -> production API leak controls. A staging build resolves every
 *      native API origin to the configured staging origin, refuses production
 *      hosts (including through EXPO_PUBLIC_API_BASE_URL), and fails closed
 *      when unconfigured; the account-sync client is driven with a mocked
 *      fetch to prove no request reaches production. Production builds
 *      (stage unset) resolve exactly as before.
 *   3. app.config.js fails the build on a bad stage config and agrees with
 *      src/config/apiOrigin.ts on every input in the matrix.
 *
 * Run: npm run test:staging-alpha-flow
 */
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

let checks = 0;
async function check(label, fn) {
  await fn();
  checks += 1;
  process.stdout.write(`  ok  ${label}\n`);
}

const PROD = 'https://holohunter.dicoge.com';
const STAGING = 'https://holohunter-staging.vercel.app';
// The retired production alias, as a bare host. The negative cases below build
// its URL at runtime because scripts/test-native-bundle-origin.mjs forbids the
// alias in URL form anywhere under scripts/, and that guard stays as it is.
const LEGACY_ALIAS_HOST = 'holocard-hunter.vercel.app';
const LEGACY_ALIAS = `https://${LEGACY_ALIAS_HOST}`;

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  const restore = () => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
  let result;
  try {
    result = fn();
  } catch (err) {
    restore();
    throw err;
  }
  if (result && typeof result.then === 'function') return result.finally(restore);
  restore();
  return result;
}

// ── 1. eas.json / workflows ────────────────────────────────────────────────
const eas = JSON.parse(read('eas.json'));

await check('eas.json staging-alpha is a store AAB on the staging stage, outside the production EAS environment', () => {
  const p = eas.build['staging-alpha'];
  assert.ok(p, 'eas.json must define build.staging-alpha');
  assert.equal(p.extends, 'production', 'staging-alpha extends production so the artifact (store AAB, remote signing) matches what Play receives');
  assert.ok(p.environment && p.environment !== 'production', 'staging-alpha must not read the production EAS environment');
  assert.equal(p.env?.EXPO_PUBLIC_APP_STAGE, 'staging');
  assert.equal(p.env?.EXPO_PUBLIC_STORE_MVP, '1');
  assert.equal(eas.build.production.env?.EXPO_PUBLIC_APP_STAGE, undefined, 'production must stay on the default (production) stage');
  for (const [name, profile] of Object.entries(eas.build)) {
    assert.equal(profile.env?.EXPO_PUBLIC_STAGING_API_ORIGIN, undefined, `${name}: the staging origin is platform configuration, not committed; an unset origin must fail the build`);
  }
  assert.equal(eas.submit['staging-alpha'], undefined, 'staging-alpha has no submit profile — the AAB is uploaded to the Alpha track by hand');
  assert.equal(eas.submit.production.android.track, 'production', 'submit.production is unchanged');
});

const easBuild = parseYaml(read('.github/workflows/eas-build.yml'));
const easJob = easBuild.jobs.build;
const stepByName = (name) => easJob.steps.find((s) => s.name === name);

await check('eas-build.yml offers staging-alpha behind its own guard and leaves the production guard untouched', () => {
  assert.ok(easBuild.on.workflow_dispatch.inputs.profile.options.includes('staging-alpha'));
  const prodGuard = stepByName('Guard release builds to main or a release tag');
  assert.equal(prodGuard.if, "${{ inputs.profile == 'production' || inputs.profile == 'production-apk' }}");
  assert.equal(prodGuard.run, 'bash scripts/ci/release-ref-guard.sh');
  const stagingGuard = stepByName('Guard staging Alpha builds to the CI-verified staging tip');
  assert.ok(stagingGuard, 'staging guard step must exist');
  assert.equal(stagingGuard.if, "${{ inputs.profile == 'staging-alpha' }}");
  assert.equal(stagingGuard.run, 'bash scripts/ci/staging-alpha-ref-guard.sh');
  assert.equal(stagingGuard.env.SUBMIT, '${{ inputs.submit }}');
  assert.equal(stagingGuard.env.PROFILE, '${{ inputs.profile }}');
  const idx = (s) => easJob.steps.indexOf(s);
  const build = stepByName('EAS Build');
  assert.ok(idx(stagingGuard) < idx(build), 'the staging guard must run before eas build');
  assert.ok(idx(stagingGuard) < idx(stepByName('EAS Submit')), 'the staging guard must run before any submit');
});

await check('eas-build.yml token is explicit and read-only', () => {
  assert.deepEqual(easJob.permissions, { contents: 'read', actions: 'read' });
  assert.equal(easBuild.permissions, undefined, 'no workflow-level permissions widening');
});

await check('ci.yml runs on staging pushes while deploy stays dispatch-only', () => {
  const ci = parseYaml(read('.github/workflows/ci.yml'));
  assert.deepEqual(ci.on.push.branches, ['main', 'staging']);
  const deploy = ci.jobs['deploy-production'];
  assert.match(deploy.if, /github\.event_name == 'workflow_dispatch'/);
  assert.match(deploy.if, /inputs\.deploy_production/);
});

// ── 2. Guard behaviour against a local remote ──────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-alpha-guard-'));
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
  const mainSha = commit('main 1');
  git(work, 'push', '--quiet', 'origin', 'main');
  git(work, 'checkout', '--quiet', '-b', 'staging');
  const stagingOld = commit('staging feature 1');
  const stagingTip = commit('staging feature 2');
  git(work, 'push', '--quiet', 'origin', 'staging');

  // Fake gh: records its arguments and prints FAKE_GH_OUT (or exits FAKE_GH_EXIT).
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  const ghLog = path.join(tmp, 'gh-args.log');
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${ghLog}"\n[ -n "$FAKE_GH_EXIT" ] && exit "$FAKE_GH_EXIT"\nprintf '%s\\n' "$FAKE_GH_OUT"\n`, { mode: 0o755 });

  const guard = (script, env) => spawnSync('bash', [path.join(ROOT, 'scripts/ci', script)], {
    cwd: work,
    env: { ...gitEnv, PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: 'owner/repo', ...env },
    encoding: 'utf8',
  });
  const ok = { GITHUB_REF: 'refs/heads/staging', GITHUB_SHA: stagingTip, PROFILE: 'staging-alpha', SUBMIT: 'false', FAKE_GH_OUT: '1' };
  const expectExit = (label, env, code, script = 'staging-alpha-ref-guard.sh') => {
    const r = guard(script, env);
    assert.equal(r.status, code, `${label}: expected exit ${code}, got ${r.status}\n${r.stdout}${r.stderr}`);
  };

  await check('staging guard admits the CI-green staging tip that contains main, and queries exactly that SHA', () => {
    fs.rmSync(ghLog, { force: true });
    expectExit('happy path', ok, 0);
    const args = fs.readFileSync(ghLog, 'utf8');
    assert.match(args, new RegExp(`head_sha=${stagingTip}&branch=staging&per_page=100`));
    // Only a push run or the staging validation dispatch of ci.yml counts.
    assert.ok(args.includes('(.event == "push" or .event == "workflow_dispatch")'), 'run filter must accept only push / staging validation dispatch');
    assert.ok(args.includes(`.head_sha == "${stagingTip}"`) && args.includes('.head_branch == "staging"'));
    assert.ok(args.includes('.conclusion == "success"') && args.includes('.path == ".github/workflows/ci.yml"'));
    assert.ok(!args.includes('pull_request'), 'PR runs must never count as staging CI proof');
    assert.match(args, /actions\/workflows\/ci\.yml\/runs/);
  });

  await check('staging guard refuses any submit value other than exactly "false"', () => {
    for (const submit of ['true', '', 'yes', '1', 'False']) expectExit(`submit=${submit}`, { ...ok, SUBMIT: submit }, 1);
  });

  await check('staging guard refuses other profiles, refs and malformed SHAs', () => {
    expectExit('profile production', { ...ok, PROFILE: 'production' }, 1);
    for (const ref of ['refs/heads/main', 'refs/heads/feature/x', 'refs/tags/v1.0.0', 'refs/heads/staging2', '']) {
      expectExit(`ref ${ref}`, { ...ok, GITHUB_REF: ref }, 1);
    }
    expectExit('short sha', { ...ok, GITHUB_SHA: stagingTip.slice(0, 12) }, 1);
  });

  await check('staging guard refuses a stale staging commit', () => {
    expectExit('stale', { ...ok, GITHUB_SHA: stagingOld }, 1);
  });

  await check('staging guard refuses without proof of a green CI run', () => {
    expectExit('zero runs', { ...ok, FAKE_GH_OUT: '0' }, 1);
    expectExit('garbage', { ...ok, FAKE_GH_OUT: 'null' }, 1);
    expectExit('gh error', { ...ok, FAKE_GH_EXIT: '1' }, 1);
  });

  await check('staging guard refuses a staging tip that does not contain the latest main', () => {
    git(work, 'checkout', '--quiet', 'main');
    commit('main hotfix not yet in staging');
    git(work, 'push', '--quiet', 'origin', 'main');
    expectExit('main ahead of staging', ok, 1);
  });

  await check('production guard still refuses staging for production and production-apk', () => {
    for (const profile of ['production', 'production-apk']) {
      expectExit(`release-ref-guard ${profile}`, { GITHUB_REF: 'refs/heads/staging', GITHUB_SHA: stagingTip, PROFILE: profile }, 1, 'release-ref-guard.sh');
    }
  });
  void mainSha;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── 3. Stage -> production API leak controls ───────────────────────────────
const apiOrigin = await import(path.join(ROOT, 'src/config/apiOrigin.ts'));
const { resolveApiBase } = await import(path.join(ROOT, 'src/services/authStrategy.ts'));
const appConfig = require(path.join(ROOT, 'app.config.js'));

const ORIGIN_MATRIX = [
  [undefined, undefined, PROD],
  ['', STAGING, PROD],
  ['production', undefined, PROD],
  [' Production ', STAGING, PROD],
  ['staging', STAGING, STAGING],
  ['staging', `${STAGING}/`, STAGING],
  ['staging', undefined, null],
  ['staging', '', null],
  ['staging', PROD, null],
  ['staging', 'https://HOLOHUNTER.DICOGE.COM', null],
  ['staging', LEGACY_ALIAS, null],
  ['staging', 'https://holocard-hunter-abc123-dicoge.vercel.app', null],
  ['staging', 'http://holohunter-staging.vercel.app', null],
  ['staging', `${STAGING}/api`, null],
  ['staging', `${STAGING}?x=1`, null],
  ['staging', ` ${STAGING}`, null],
  ['staging', 'https://user:pw@holohunter-staging.vercel.app', null],
  ['staging', 'holohunter-staging.vercel.app', null],
  ['stage', STAGING, null],
  ['prod', undefined, null],
];

await check('native origin resolver: production unchanged, staging only to a non-production https origin, otherwise null', () => {
  for (const [stage, stagingOrigin, expected] of ORIGIN_MATRIX) {
    assert.equal(apiOrigin.resolveNativeApiOrigin({ stage, stagingOrigin }), expected, `stage=${stage} origin=${stagingOrigin}`);
  }
});

await check('app.config.js stage gate agrees with the runtime resolver on every case', () => {
  for (const [stage, stagingOrigin, expected] of ORIGIN_MATRIX) {
    const env = { EXPO_PUBLIC_APP_STAGE: stage, EXPO_PUBLIC_STAGING_API_ORIGIN: stagingOrigin };
    if (expected === null) {
      assert.throws(() => appConfig.resolveBuildStage(env), `stage=${stage} origin=${stagingOrigin} must fail the build`);
    } else {
      assert.equal(appConfig.resolveBuildStage(env).apiOrigin, expected, `stage=${stage} origin=${stagingOrigin}`);
    }
  }
  for (const host of apiOrigin.PRODUCTION_HOSTS) assert.ok(appConfig.isProductionApiHost(host));
  assert.ok(apiOrigin.PRODUCTION_HOSTS.includes(LEGACY_ALIAS_HOST), 'the legacy alias must stay classified as a production host');
});

await check('nativeApiOrigin reads the build env and throws instead of falling back to production', () => {
  withEnv({ EXPO_PUBLIC_APP_STAGE: undefined, EXPO_PUBLIC_STAGING_API_ORIGIN: undefined }, () => {
    assert.equal(apiOrigin.nativeApiOrigin(), PROD);
  });
  withEnv({ EXPO_PUBLIC_APP_STAGE: 'staging', EXPO_PUBLIC_STAGING_API_ORIGIN: STAGING }, () => {
    assert.equal(apiOrigin.nativeApiOrigin(), STAGING);
  });
  for (const origin of [undefined, PROD]) {
    withEnv({ EXPO_PUBLIC_APP_STAGE: 'staging', EXPO_PUBLIC_STAGING_API_ORIGIN: origin }, () => {
      assert.throws(() => apiOrigin.nativeApiOrigin(), apiOrigin.StageApiOriginError);
    });
  }
});

await check('auth API base: production unchanged; staging ignores a production override and never falls back to production', () => {
  withEnv({ EXPO_PUBLIC_APP_STAGE: undefined, EXPO_PUBLIC_STAGING_API_ORIGIN: undefined }, () => {
    assert.equal(resolveApiBase({ platformOS: 'android' }), `${PROD}/api`);
    assert.equal(resolveApiBase({ platformOS: 'android', envOverride: `${PROD}/api` }), `${PROD}/api`);
  });
  withEnv({ EXPO_PUBLIC_APP_STAGE: 'staging', EXPO_PUBLIC_STAGING_API_ORIGIN: STAGING }, () => {
    assert.equal(resolveApiBase({ platformOS: 'android' }), `${STAGING}/api`);
    assert.equal(resolveApiBase({ platformOS: 'ios', envOverride: `${PROD}/api` }), `${STAGING}/api`);
    assert.equal(resolveApiBase({ platformOS: 'android', envOverride: `${LEGACY_ALIAS}/api` }), `${STAGING}/api`);
    assert.equal(resolveApiBase({ platformOS: 'web', webOrigin: STAGING }), `${STAGING}/api`);
  });
  withEnv({ EXPO_PUBLIC_APP_STAGE: 'staging', EXPO_PUBLIC_STAGING_API_ORIGIN: undefined }, () => {
    assert.throws(() => resolveApiBase({ platformOS: 'android' }), apiOrigin.StageApiOriginError);
    assert.throws(() => resolveApiBase({ platformOS: 'android', envOverride: `${PROD}/api` }), apiOrigin.StageApiOriginError);
  });
});

await check('account sync (mocked fetch, native path): staging never reaches a production host', async () => {
  assert.equal(globalThis.window, undefined, 'native path: no window');
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ snapshot: null }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const client = await import(path.join(ROOT, 'src/services/accountSyncClient.ts'));
    await withEnv({ EXPO_PUBLIC_APP_STAGE: 'staging', EXPO_PUBLIC_STAGING_API_ORIGIN: undefined }, async () => {
      await assert.rejects(client.pullAccountSnapshot('session-token'));
    });
    assert.deepEqual(calls, [], 'an unconfigured staging build must not issue any request');
    await withEnv({ EXPO_PUBLIC_APP_STAGE: 'staging', EXPO_PUBLIC_STAGING_API_ORIGIN: PROD }, async () => {
      await assert.rejects(client.pullAccountSnapshot('session-token'));
    });
    assert.deepEqual(calls, [], 'a staging build pointed at production must not issue any request');
    await withEnv({ EXPO_PUBLIC_APP_STAGE: 'staging', EXPO_PUBLIC_STAGING_API_ORIGIN: STAGING }, async () => {
      await client.pullAccountSnapshot('session-token');
    });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].startsWith(`${STAGING}/`), `staging request went to ${calls[0]}`);
    await withEnv({ EXPO_PUBLIC_APP_STAGE: undefined, EXPO_PUBLIC_STAGING_API_ORIGIN: undefined }, async () => {
      await client.pullAccountSnapshot('session-token');
    });
    assert.ok(calls[1].startsWith(`${PROD}/`), `production request went to ${calls[1]}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check('no native client falls back to PRODUCTION_ORIGIN directly', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js)$/.test(e.name)) {
        const rel = path.relative(ROOT, full);
        if (rel === path.join('src', 'config', 'apiOrigin.ts')) continue;
        const body = fs.readFileSync(full, 'utf8');
        if (/\bPRODUCTION_ORIGIN\b/.test(body)) offenders.push(rel);
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  assert.deepEqual(offenders, [path.join('src', 'services', 'authStrategy.ts')], 'only authStrategy may name PRODUCTION_ORIGIN (its stage-gated default)');
  const auth = read('src/services/authStrategy.ts');
  assert.match(auth, /return stagingBuild \? `\$\{nativeApiOrigin\(\)\}\/api` : DEFAULT_NATIVE_API_BASE;/);
  for (const rel of ['src/services/pushNotificationService.ts', 'src/services/accountSyncClient.ts', 'src/services/auth/index.ts', 'src/services/cardRecognition.ts']) {
    assert.match(read(rel), /nativeApiOrigin\(\)/, `${rel} must resolve its native origin through nativeApiOrigin()`);
  }
});

console.log(`✓ staging Alpha flow: ${checks} checks passed`);
