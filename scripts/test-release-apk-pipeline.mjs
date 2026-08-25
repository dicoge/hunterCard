#!/usr/bin/env node
/**
 * Release-APK pipeline invariants (DIC-1193).
 *
 * The failure this guards against: a DEBUG APK, or a preview/staging-content
 * APK, being handed to a tester as the "正式內容測試包". Three artifacts look
 * alike on disk and only the pipeline tells them apart, so the pipeline is
 * asserted here rather than trusted.
 *
 * Three layers, because the first two alone were shown to be defeatable
 * (CR DIC-1193):
 *
 *   1. Configuration — eas.json `production-apk` must resolve to production
 *      content with EAS-managed release signing, differing from the store
 *      profile ONLY in distribution and Android container.
 *   2. Wiring — each gate must exist as an ENABLED workflow step whose own body
 *      invokes the gate script, with no `|| true` / `&& false` /
 *      `continue-on-error` neutering it, and with its `uses:` pinned.
 *   3. Behaviour — the gate scripts are executed against real inputs (a real
 *      git repo for the ref guard, stubbed curl/apksigner for the verifier) and
 *      asserted on EXIT STATUS. Text assertions cannot see `&& false` inside a
 *      command; this layer can.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const easJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));
const easBuildWorkflow = fs.readFileSync(
  path.join(ROOT, '.github/workflows/eas-build.yml'),
  'utf8',
);
const androidWorkflow = fs.readFileSync(
  path.join(ROOT, '.github/workflows/build-android.yml'),
  'utf8',
);

const RELEASE_APK_PROFILE = 'production-apk';
const RELEASE_APK_ONLY = "${{ inputs.profile == 'production-apk' }}";

const SCRIPTS = {
  refGuard: 'scripts/ci/release-ref-guard.sh',
  usageGuard: 'scripts/ci/release-apk-usage-guard.sh',
  buildStatus: 'scripts/ci/release-apk-build-status.sh',
  verify: 'scripts/ci/release-apk-verify.sh',
};

// ---------------------------------------------------------------- helpers

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function merge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] =
      isPlainObject(value) && isPlainObject(base[key]) ? merge(base[key], value) : value;
  }
  return out;
}

// EAS resolves `extends` by merging the parent profile under the child.
function resolveProfile(name, seen = new Set()) {
  assert.ok(!seen.has(name), `circular extends chain at profile "${name}"`);
  seen.add(name);
  const profile = easJson.build?.[name];
  assert.ok(profile, `eas.json build profile "${name}" is missing`);
  const { extends: parent, ...rest } = profile;
  return parent ? merge(resolveProfile(parent, seen), rest) : { ...rest };
}

function flatten(value, prefix = '') {
  const out = {};
  for (const [key, inner] of Object.entries(value ?? {})) {
    const label = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(inner)) Object.assign(out, flatten(inner, label));
    else out[label] = JSON.stringify(inner);
  }
  return out;
}

/**
 * Steps are read from the PARSED YAML document, not from the raw text. Earlier
 * rounds asserted on text and were defeated three times over — first by `if:
 * false`, then by neutering tokens inside a step body, then by a trailing
 * comment or a quoted key (`gates:  # split out`, `"defaults":`). Whatever the
 * spelling, GitHub reads the parsed document, so the assertions read it too.
 */
function stepsOf(job) {
  return (job?.steps ?? []).map((step) => {
    assert.ok(step && typeof step === 'object', 'every workflow step must be a mapping');
    return {
    name: step.name ?? `<${step.uses ?? 'unnamed'}>`,
    if: step.if == null ? null : String(step.if).trim(),
    uses: step.uses ?? null,
    run: typeof step.run === 'string',
    shell: step.shell ?? null,
    command: typeof step.run === 'string' ? step.run.trim() : null,
    env: step.env ? Object.fromEntries(Object.entries(step.env).map(([k, v]) => [k, String(v).trim()])) : null,
    raw: step,
    };
  });
}

function jobsOf(workflow) {
  const doc = parseYaml(workflow);
  assert.ok(doc?.jobs, 'workflow must declare jobs');
  return doc;
}

const easBuildDoc = jobsOf(easBuildWorkflow);
const androidDoc = jobsOf(androidWorkflow);

// The job that actually produces the artifact is the job the gates must live
// in; naming it by hand would just move the assumption somewhere else.
/**
 * Any `eas build` invocation, however it is wrapped. Matching only at line start
 * left `sh -c "eas build …"` unbound (CR DIC-1193 round 3) — and that string IS
 * part of the document, so "out of scope" was never a defensible answer for it.
 * The cost is that a string merely mentioning the command reads as an
 * invocation; that fails closed and is the right side to err on for a release
 * gate.
 */
const INVOKES_EAS_BUILD = (value) =>
  typeof value === 'string' && /(^|[^\w.-])eas\s+build\b/.test(value);

const BUILD_JOBS = Object.entries(easBuildDoc.jobs).filter(([, job]) =>
  (job.steps ?? []).some((step) => INVOKES_EAS_BUILD(step.run)),
);
assert.equal(
  BUILD_JOBS.length,
  1,
  `eas-build.yml must contain exactly one job that runs \`eas build\` — a second one would produce artifacts that the gates in the first job never see (found: ${BUILD_JOBS.map(([n]) => n).join(', ') || 'none'})`,
);
const BUILD_JOB = BUILD_JOBS[0];

const easBuildSteps = stepsOf(BUILD_JOB[1]);
const androidSteps = Object.values(androidDoc.jobs).flatMap((job) => stepsOf(job));

function stepNamed(steps, name, workflowName) {
  const found = steps.filter((s) => s.name === name);
  assert.equal(
    found.length,
    1,
    `${workflowName} must contain exactly one step named "${name}" — it is a release gate, not decoration (found ${found.length})`,
  );
  return found[0];
}

function run(script, { args = [], env = {}, cwd = ROOT } = {}) {
  const result = spawnSync('bash', [path.join(ROOT, script), ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function git(cwd, ...args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

const tempDirs = [];
function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dic1193-${label}-`));
  tempDirs.push(dir);
  return dir;
}

// ------------------------------------------------- layer 1: configuration

function testReleaseApkProfileExists() {
  const raw = easJson.build?.[RELEASE_APK_PROFILE];
  assert.ok(
    raw,
    `eas.json must define a "${RELEASE_APK_PROFILE}" build profile — it is the only source of a tester-installable production-content APK`,
  );
  assert.equal(
    raw.extends,
    'production',
    'production-apk must extend the production profile so environment/env can never drift from the store build',
  );
}

function testReleaseApkUsesManagedReleaseSigning() {
  const raw = easJson.build?.[RELEASE_APK_PROFILE];
  // Pinned explicitly, not inherited from the EAS default: a profile switched
  // to `local` would take a keystore from the build machine, which is exactly
  // how a debug-signed "release" APK gets produced.
  assert.equal(
    raw.credentialsSource,
    'remote',
    'production-apk must pin credentialsSource: "remote" (EAS-managed release signing)',
  );
  assert.equal(
    resolveProfile(RELEASE_APK_PROFILE).credentialsSource,
    'remote',
    'the resolved production-apk profile must use EAS-managed release signing',
  );
  assert.equal(
    resolveProfile('production').credentialsSource,
    'remote',
    'the store profile must also pin EAS-managed signing, so the two profiles stay comparable',
  );
}

function testReleaseApkDiffersFromStoreOnlyInContainer() {
  const apk = flatten(resolveProfile(RELEASE_APK_PROFILE));
  const store = flatten(resolveProfile('production'));
  const allowed = new Set(['distribution', 'android.buildType']);
  const differing = [...new Set([...Object.keys(apk), ...Object.keys(store)])].filter(
    (key) => apk[key] !== store[key],
  );
  assert.deepEqual(
    differing.sort(),
    [...allowed].sort(),
    `production-apk may differ from production ONLY in ${[...allowed].join(' and ')} — anything else means the sideload APK is not the same app as the store build (differs in: ${differing.join(', ')})`,
  );
  assert.equal(apk.distribution, '"internal"');
  assert.equal(apk['android.buildType'], '"apk"');
  assert.equal(store.distribution, '"store"');
  assert.equal(store['android.buildType'], '"app-bundle"');
  assert.equal(
    resolveProfile(RELEASE_APK_PROFILE).environment,
    'production',
    'production-apk must build against the production EAS environment',
  );
  assert.equal(
    resolveProfile(RELEASE_APK_PROFILE).env?.EXPO_PUBLIC_STORE_MVP,
    '1',
    'production-apk must keep the Store MVP release flag on so advanced surfaces stay hidden',
  );
  assert.notEqual(
    resolveProfile(RELEASE_APK_PROFILE).developmentClient,
    true,
    'production-apk must not be a development-client build',
  );
  assert.equal(
    easJson.submit?.[RELEASE_APK_PROFILE],
    undefined,
    'production-apk must have no submit profile — Play Internal Testing takes the production AAB, never this APK',
  );
  assert.equal(
    resolveProfile('preview').environment,
    'preview',
    'preview must stay on the preview environment — it is deliberately NOT the production-content channel',
  );
}

// ------------------------------------------------------- layer 2: wiring

function testWorkflowOffersTheReleaseApkProfile() {
  const profileInput = easBuildWorkflow.match(
    /profile:\s*\n[\s\S]*?options:\s*\n((?:\s*-\s*\S+\n)+)/,
  );
  assert.ok(profileInput, 'eas-build.yml must expose a `profile` choice input');
  const options = profileInput[1]
    .split('\n')
    .map((line) => line.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean);
  assert.ok(
    options.includes(RELEASE_APK_PROFILE),
    `eas-build.yml profile input must offer "${RELEASE_APK_PROFILE}" (got ${options.join(', ')})`,
  );
}

function testGateStepsAreEnabledAndInvokeTheirGuards() {
  const gates = [
    {
      name: 'Guard release builds to main or a release tag',
      if: "${{ inputs.profile == 'production' || inputs.profile == 'production-apk' }}",
      mustInvoke: SCRIPTS.refGuard,
      command: `bash ${SCRIPTS.refGuard}`,
      env: { PROFILE: '${{ inputs.profile }}' },
    },
    {
      name: 'Guard production-apk usage',
      if: RELEASE_APK_ONLY,
      mustInvoke: SCRIPTS.usageGuard,
      command: `bash ${SCRIPTS.usageGuard}`,
      env: { PLATFORM: '${{ inputs.platform }}', SUBMIT: '${{ inputs.submit }}' },
    },
    {
      name: 'EAS Build (production APK, wait for artifact)',
      if: RELEASE_APK_ONLY,
      mustInvoke: SCRIPTS.buildStatus,
      command: [
        'set -euo pipefail',
        'eas build \\',
        '  --platform android \\',
        '  --profile production-apk \\',
        '  --non-interactive \\',
        '  --json \\',
        '  --wait > eas-build-raw.json',
        `bash ${SCRIPTS.buildStatus} eas-build-raw.json eas-build.json`,
      ].join('\n'),
    },
    {
      name: 'Verify signature and record build provenance',
      if: RELEASE_APK_ONLY,
      mustInvoke: SCRIPTS.verify,
      command: `bash ${SCRIPTS.verify} eas-build.json holohunter-production.apk`,
    },
    { name: 'Setup Java', if: RELEASE_APK_ONLY, uses: 'actions/setup-java@v4' },
    // Tool provisioning, not a gate: `sdkmanager --licenses` is allowed its
    // customary `|| true` because a missing apksigner makes the verify step
    // below fail closed anyway (command not found → non-zero exit).
    { name: 'Install Android build-tools (apksigner)', if: RELEASE_APK_ONLY, mayTolerate: true },
    {
      name: 'Upload production APK + provenance',
      if: RELEASE_APK_ONLY,
      uses: 'actions/upload-artifact@v4',
    },
  ];

  for (const gate of gates) {
    const step = stepNamed(easBuildSteps, gate.name, 'eas-build.yml');
    assert.equal(
      step.if,
      gate.if,
      `"${gate.name}" must run for every production-apk build — its condition is now ${step.if}`,
    );
    if (gate.uses) {
      assert.equal(
        step.uses,
        gate.uses,
        `"${gate.name}" must use ${gate.uses} — swapping the action silently changes what the step does`,
      );
    }
    if (gate.mustInvoke) {
      assert.ok(
        (step.command ?? '').includes(gate.mustInvoke),
        `"${gate.name}" must invoke ${gate.mustInvoke}; its behaviour is asserted by executing that script`,
      );
    }
    // Pinned verbatim: the gate scripts are what the behaviour tests execute,
    // so the step must run exactly them — no `|| echo`, no trailing `exit 0`,
    // no `set +e`, no `if ! guard; then` inversion.
    if (gate.command) {
      assert.equal(
        step.command,
        gate.command,
        `"${gate.name}" must run exactly:\n${gate.command}\n\n…but runs:\n${step.command}`,
      );
    }
    // `shell: cat {0}` (or python, or anything else) means the pinned command
    // is never executed as shell, so its exit status stops mattering — the
    // gate is disabled without touching a single character of the command.
    assert.equal(
      step.shell,
      null,
      `"${gate.name}" must not override the shell (got shell: ${step.shell}) — the default bash is what makes its exit status a gate`,
    );
    // A renamed env key feeds the guard an empty value while every other
    // assertion still passes.
    if (gate.env) {
      assert.deepEqual(
        step.env,
        gate.env,
        `"${gate.name}" must pass exactly ${JSON.stringify(gate.env)} to its guard script — got ${JSON.stringify(step.env)}`,
      );
    }
    // A gate whose failure is swallowed is not a gate.
    if (!gate.mayTolerate) {
      assert.ok(
        !/\|\|\s*(true|:)\b/.test(step.command ?? ''),
        `"${gate.name}" swallows failures with a "||" fallback: ${step.command}`,
      );
      assert.ok(
        !/&&\s*false\b/.test(step.command ?? ''),
        `"${gate.name}" is short-circuited with "&& false": ${step.command}`,
      );
    }
    assert.ok(
      step.raw['continue-on-error'] !== true,
      `"${gate.name}" must not set continue-on-error: true — a release gate has to be able to fail the run`,
    );
  }

  const checkout = stepNamed(easBuildSteps, 'Checkout code', 'eas-build.yml');
  assert.equal(checkout.uses, 'actions/checkout@v4');
  assert.equal(
    checkout.raw.with?.['fetch-depth'],
    0,
    'the checkout needs full history (fetch-depth: 0) for the release-tag containment check',
  );

  const buildStep = stepNamed(
    easBuildSteps,
    'EAS Build (production APK, wait for artifact)',
    'eas-build.yml',
  );
  assert.match(buildStep.command, /--wait/, 'the production APK build must wait for the artifact');
  assert.ok(
    !buildStep.command.includes('--no-wait'),
    'the production APK build must not use --no-wait — its signature cannot be verified otherwise',
  );

  const upload = stepNamed(easBuildSteps, 'Upload production APK + provenance', 'eas-build.yml');
  for (const artifact of [
    'holohunter-production.apk',
    'build-provenance.json',
    'apksigner-verify.txt',
  ]) {
    assert.ok(
      String(upload.raw.with?.path ?? '').includes(artifact),
      `the release artifact must include ${artifact}`,
    );
  }

  for (const [workflowName, steps] of [
    ['eas-build.yml', easBuildSteps],
    ['build-android.yml', androidSteps],
  ]) {
    for (const step of steps) {
      assert.ok(
        !/^\$\{\{\s*false\s*\}\}$|^'?false'?$/.test(step.if ?? ''),
        `${workflowName} step "${step.name}" is switched off with if: ${step.if}`,
      );
    }
  }
}

/**
 * Per-step assertions only bind steps whose exit status can stop the build.
 * Two workflow-level edits sidestep them: moving the guards into a job that the
 * build job does not wait for, and overriding the shell so no `run:` exit
 * status gates anything. Both are read off the parsed document, so a trailing
 * comment or a quoted key cannot hide them.
 */
function testWorkflowStructureCannotBypassGates() {
  const [buildJobName, buildJob] = BUILD_JOB;
  const gateNames = [
    'Guard release builds to main or a release tag',
    'Guard production-apk usage',
    'Verify signature and record build provenance',
  ];
  const jobOf = (stepName) =>
    Object.entries(easBuildDoc.jobs)
      .filter(([, job]) => (job.steps ?? []).some((step) => step.name === stepName))
      .map(([name]) => name);
  for (const gate of gateNames) {
    assert.deepEqual(
      jobOf(gate),
      [buildJobName],
      `"${gate}" must live in the "${buildJobName}" job that runs eas build — a gate in another job does not block the build unless that job is awaited`,
    );
  }

  // Other jobs may exist (a downstream notifier, say) — what matters is that no
  // gate lives in one, which the membership check above already enforces. They
  // still may not carry defaults that would change how a run step is executed.
  for (const [name, job] of Object.entries(easBuildDoc.jobs)) {
    if (name === buildJobName) continue;
    assert.equal(job.defaults, undefined, `job "${name}" must not set defaults`);
  }

  assert.equal(
    easBuildDoc.defaults,
    undefined,
    'eas-build.yml must not declare workflow-level defaults — defaults.run.shell disables every gate at once',
  );
  assert.equal(
    buildJob.defaults,
    undefined,
    `job "${buildJobName}" must not declare defaults — defaults.run.shell disables every gate at once`,
  );
  assert.equal(
    buildJob['continue-on-error'],
    undefined,
    `job "${buildJobName}" must not set continue-on-error`,
  );
  for (const step of easBuildSteps) {
    assert.equal(
      step.shell,
      null,
      `eas-build.yml step "${step.name}" overrides the shell (shell: ${step.shell}); gates rely on the default bash exit status`,
    );
  }
}

/**
 * Every YAML under `.github/` — workflows, composite actions, reusable
 * workflows — is scanned for an `eas build` invocation in ANY string value, so a
 * wrapped call (`sh -c "eas build …"`), a composite action whose action.yml does
 * the build, or a second workflow file cannot produce a production APK outside
 * the gated job (CR DIC-1193 round 3, PM directive).
 */
function* yamlFilesUnder(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* yamlFilesUnder(full);
    else if (/\.ya?ml$/.test(entry.name)) yield full;
  }
}

function* stringsIn(node) {
  if (typeof node === 'string') yield node;
  else if (Array.isArray(node)) for (const item of node) yield* stringsIn(item);
  else if (node && typeof node === 'object') for (const value of Object.values(node)) yield* stringsIn(value);
}

function testOnlyTheGatedJobBuilds() {
  const githubDir = path.join(ROOT, '.github');
  const gatedFile = path.join(githubDir, 'workflows/eas-build.yml');
  const offenders = [];
  for (const file of yamlFilesUnder(githubDir)) {
    if (file === gatedFile) continue;
    const doc = parseYaml(fs.readFileSync(file, 'utf8'));
    for (const value of stringsIn(doc)) {
      if (INVOKES_EAS_BUILD(value)) {
        offenders.push(`${path.relative(ROOT, file)}: ${value.trim().slice(0, 60)}`);
        break;
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `only .github/workflows/eas-build.yml may invoke \`eas build\` — the release gates live there and cannot police another file (found: ${offenders.join(' | ')})`,
  );

  // Inside the gated workflow, every build invocation — wrapped or not — must
  // sit in the one job the gates belong to.
  const [buildJobName] = BUILD_JOB;
  for (const [jobName, job] of Object.entries(easBuildDoc.jobs)) {
    for (const step of job.steps ?? []) {
      for (const value of stringsIn(step)) {
        if (!INVOKES_EAS_BUILD(value)) continue;
        assert.equal(
          jobName,
          buildJobName,
          `job "${jobName}" invokes eas build outside the gated job "${buildJobName}": ${value.trim().slice(0, 60)}`,
        );
      }
    }
  }
}

/**
 * The usage guard compares SUBMIT against the exact string GitHub renders for a
 * boolean input. If the input were redeclared as a free-form string, an operator
 * could type anything, and `if: ${{ inputs.submit }}` treats every non-empty
 * string as true — so the input's declared type is part of the gate.
 */
function testWorkflowInputSchema() {
  const dispatch = easBuildDoc.on?.workflow_dispatch ?? easBuildDoc[true]?.workflow_dispatch;
  assert.ok(dispatch?.inputs, 'eas-build.yml must expose workflow_dispatch inputs');
  const submit = dispatch.inputs.submit;
  assert.ok(submit, 'eas-build.yml must declare a `submit` input');
  assert.equal(submit.type, 'boolean', '`submit` must be a boolean input, not a free-form string');
  assert.equal(submit.required, true, '`submit` must be required');
  assert.equal(submit.default, false, '`submit` must default to false');
  const platform = dispatch.inputs.platform;
  assert.equal(platform?.type, 'choice', '`platform` must be a choice input');
  assert.deepEqual(
    platform.options,
    ['ios', 'android', 'all'],
    '`platform` options are part of the usage guard contract',
  );
  const profile = dispatch.inputs.profile;
  assert.equal(profile?.type, 'choice', '`profile` must be a choice input');
  assert.ok(
    profile.options.includes(RELEASE_APK_PROFILE),
    `profile input must offer ${RELEASE_APK_PROFILE}`,
  );
}

function testGuardsRunBeforeAnythingIsBuilt() {
  const index = (name) => easBuildSteps.findIndex((s) => s.name === name);
  const lastGuard = Math.max(
    index('Guard release builds to main or a release tag'),
    index('Guard production-apk usage'),
  );
  const firstBuild = Math.min(
    ...['Setup EAS', 'EAS Build', 'EAS Build (production APK, wait for artifact)']
      .map(index)
      .filter((i) => i >= 0),
  );
  assert.ok(
    lastGuard >= 0 && lastGuard < firstBuild,
    'both release guards must run before any EAS setup/build step, so a bad ref fails immediately instead of after a build',
  );

  const chain = [
    'EAS Build (production APK, wait for artifact)',
    'Setup Java',
    'Install Android build-tools (apksigner)',
    'Verify signature and record build provenance',
    'Upload production APK + provenance',
  ];
  for (let i = 1; i < chain.length; i += 1) {
    assert.ok(
      index(chain[i - 1]) >= 0 && index(chain[i - 1]) < index(chain[i]),
      `eas-build.yml step order is wrong: "${chain[i - 1]}" must come before "${chain[i]}"`,
    );
  }
}

function testDebugApkWorkflowIsLabelledDebugOnly() {
  assert.match(
    androidWorkflow,
    /^name:.*DEBUG-ONLY/m,
    'the assembleDebug workflow name must say DEBUG-ONLY',
  );
  const upload = stepNamed(androidSteps, 'Upload APK as artifact', 'build-android.yml');
  assert.equal(
    upload.raw.with?.name,
    'holohunter-DEBUG-ONLY-apk',
    'the assembleDebug artifact name must say DEBUG-ONLY',
  );
  assert.equal(upload.uses, 'actions/upload-artifact@v4');
  stepNamed(androidSteps, 'Label artifact as debug-only', 'build-android.yml');
  assert.match(
    androidWorkflow,
    /assembleDebug/,
    'the DEBUG-ONLY label must stay truthful: this workflow builds the debug variant',
  );
}

// ---------------------------------------------------- layer 3: behaviour

function testRefGuardBehaviour() {
  const dir = tempDir('ref');
  const origin = path.join(dir, 'origin');
  fs.mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(origin, 'a.txt'), 'a');
  git(origin, 'add', '.');
  git(origin, 'commit', '-qm', 'first');
  const mainSha = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'tag', 'v1.0.0');
  git(origin, 'checkout', '-q', '-b', 'side');
  fs.writeFileSync(path.join(origin, 'b.txt'), 'b');
  git(origin, 'add', '.');
  git(origin, 'commit', '-qm', 'side');
  const sideSha = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'tag', 'v9.9.9');
  git(origin, 'checkout', '-q', 'main');

  const clone = path.join(dir, 'clone');
  git(dir, 'clone', '-q', origin, clone);

  const cases = [
    ['refs/heads/main', mainSha, 0, /ref OK: main/],
    ['refs/heads/feature/x', mainSha, 1, /may only be built from 'main'/],
    ['refs/pull/152/merge', mainSha, 1, /may only be built from 'main'/],
    ['refs/heads/mainline', mainSha, 1, /may only be built from 'main'/],
    ['refs/heads/main-hack', mainSha, 1, /may only be built from 'main'/],
    ['refs/tags/v1.0.0', mainSha, 0, /contained in main/],
    ['refs/tags/v9.9.9', sideSha, 1, /is not contained in main/],
    // Provenance must name an immutable commit even on an allowed ref.
    ['refs/heads/main', '', 1, /full 40-character commit SHA/],
    ['refs/heads/main', 'abc123', 1, /full 40-character commit SHA/],
    ['refs/heads/main', mainSha.slice(0, 12), 1, /full 40-character commit SHA/],
    ['refs/heads/main', mainSha.toUpperCase(), 1, /full 40-character commit SHA/],
    ['refs/heads/main', 'refs/heads/main', 1, /full 40-character commit SHA/],
    ['', mainSha, 1, /GITHUB_REF is empty/],
  ];
  for (const [ref, sha, expected, message] of cases) {
    const result = run(SCRIPTS.refGuard, {
      cwd: clone,
      env: { GITHUB_REF: ref, GITHUB_SHA: sha, PROFILE: RELEASE_APK_PROFILE },
    });
    assert.equal(
      result.code,
      expected,
      `release-ref-guard.sh for ${ref} expected exit ${expected}, got ${result.code}: ${result.out}`,
    );
    assert.match(result.out, message, `unexpected output for ${ref}: ${result.out}`);
    if (expected === 1) assert.match(result.out, /::error::/);
  }
}

function testUsageGuardBehaviour() {
  // Allowlist: only the exact approved pair passes. Empty and unrecognised
  // values must fail closed — GitHub renders a non-boolean input as a non-empty
  // string, which the later `if: ${{ inputs.submit }}` step treats as TRUE, so a
  // guard that only rejected the literal 'true' let a submitting run through.
  const cases = [
    ['android', 'false', 0],
    ['android', '', 1],
    ['android', 'true', 1],
    ['android', 'yes', 1],
    ['android', '1', 1],
    ['android', '0', 1],
    ['android', 'no', 1],
    ['android', 'FALSE', 1],
    ['android', 'False', 1],
    ['android', ' false', 1],
    ['ios', 'false', 1],
    ['ios', 'true', 1],
    ['all', 'false', 1],
    ['', 'false', 1],
    ['Android', 'false', 1],
  ];
  for (const [platform, submit, expected] of cases) {
    const result = run(SCRIPTS.usageGuard, {
      env: { PLATFORM: platform, SUBMIT: submit },
    });
    assert.equal(
      result.code,
      expected,
      `release-apk-usage-guard.sh for platform='${platform}' submit='${submit}' expected exit ${expected}, got ${result.code}: ${result.out}`,
    );
    if (expected === 1) assert.match(result.out, /::error::/);
  }
}

function testBuildStatusBehaviour() {
  const dir = tempDir('status');
  const raw = path.join(dir, 'raw.json');
  const out = path.join(dir, 'out.json');
  const cases = [
    ['[{"id":"b1","status":"FINISHED"}]', 0],
    ['{"id":"b1","status":"FINISHED"}', 0],
    ['[]', 1],
    ['[{"id":"b1","status":"ERRORED"}]', 1],
    ['[{"id":"b1","status":"CANCELED"}]', 1],
  ];
  for (const [json, expected] of cases) {
    fs.rmSync(out, { force: true });
    fs.writeFileSync(raw, json);
    const result = run(SCRIPTS.buildStatus, { args: [raw, out] });
    assert.equal(
      result.code,
      expected,
      `release-apk-build-status.sh for ${json} expected exit ${expected}, got ${result.code}: ${result.out}`,
    );
    if (expected === 0) {
      const normalised = JSON.parse(fs.readFileSync(out, 'utf8'));
      assert.equal(
        normalised.status,
        'FINISHED',
        'the normalised build JSON must be a single object regardless of the CLI response shape',
      );
    } else {
      assert.match(result.out, /::error::/);
    }
  }
}

const GOOD_CERTS = [
  'Verifies',
  'Verified using v2 scheme (APK Signature Scheme v2): true',
  'Number of signers: 1',
  'Signer #1 certificate DN: CN=HoloHunter, O=Expo, C=US',
  'Signer #1 certificate SHA-256 digest: 1122aabb',
  '',
].join('\n');

const DEBUG_CERTS = [
  'Verifies',
  'Signer #1 certificate DN: CN=Android Debug, O=Android, C=US',
  'Signer #1 certificate SHA-256 digest: deadbeef',
  '',
].join('\n');

const DRIFTED_CERTS = ['Verifies', 'Number of signers: 1', ''].join('\n');

// A real full commit SHA: provenance that cannot name an immutable commit is
// refused, so the fixtures have to be honest about it too (CR DIC-1193 round 3).
const FULL_SHA = '81985ef2ba6440e1921a12583d7067b7c6b1d212';
const GITHUB_ENV_BASE = {
  GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: FULL_SHA,
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'dicoge/hunterCard',
  GITHUB_RUN_ID: '42',
};

function verifySandbox() {
  const dir = tempDir('verify');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'curl'),
    '#!/bin/bash\nout=""\nwhile [ $# -gt 0 ]; do [ "$1" = "-o" ] && { out="$2"; shift; }; shift; done\nprintf "fake apk" > "$out"\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, 'apksigner'),
    '#!/bin/bash\ncat "$FAKE_CERTS"\nexit "${FAKE_APKSIGNER_EXIT:-0}"\n',
    { mode: 0o755 },
  );
  return { dir, bin };
}

function testVerifyBehaviour() {
  const { dir, bin } = verifySandbox();
  const certFiles = {
    good: path.join(dir, 'good.txt'),
    debug: path.join(dir, 'debug.txt'),
    drift: path.join(dir, 'drift.txt'),
  };
  fs.writeFileSync(certFiles.good, GOOD_CERTS);
  fs.writeFileSync(certFiles.debug, DEBUG_CERTS);
  fs.writeFileSync(certFiles.drift, DRIFTED_CERTS);

  const complete = {
    id: 'build-1',
    status: 'FINISHED',
    appVersion: '1.4.2',
    appBuildVersion: '57',
    artifacts: { applicationArchiveUrl: 'https://expo.dev/artifacts/fake.apk' },
  };

  const cases = [
    ['happy path', complete, certFiles.good, 0, null],
    [
      'missing versionCode',
      { ...complete, appBuildVersion: undefined },
      certFiles.good,
      1,
      /carried no VERSION_CODE/,
    ],
    [
      'null appVersion',
      { ...complete, appVersion: null },
      certFiles.good,
      1,
      /carried no APP_VERSION/,
    ],
    ['missing build id', { ...complete, id: undefined }, certFiles.good, 1, /carried no BUILD_ID/],
    [
      'no artifact url',
      { ...complete, artifacts: {} },
      certFiles.good,
      1,
      /reported no application archive URL/,
    ],
    ['debug certificate', complete, certFiles.debug, 1, /Android DEBUG certificate/],
    ['apksigner format drift', complete, certFiles.drift, 1, /Could not read the signer/],
    [
      'short commit SHA',
      complete,
      certFiles.good,
      1,
      /full 40-character commit SHA/,
      { GITHUB_SHA: 'abc123def456' },
    ],
    [
      'blank commit SHA',
      complete,
      certFiles.good,
      1,
      /full 40-character commit SHA/,
      { GITHUB_SHA: '' },
    ],
    [
      'uppercase (non-canonical) SHA',
      complete,
      certFiles.good,
      1,
      /full 40-character commit SHA/,
      { GITHUB_SHA: FULL_SHA.toUpperCase() },
    ],
    [
      'ref-only, no SHA',
      complete,
      certFiles.good,
      1,
      /full 40-character commit SHA/,
      { GITHUB_SHA: 'refs/heads/main' },
    ],
    ['blank ref', complete, certFiles.good, 1, /GITHUB_REF is empty/, { GITHUB_REF: '' }],
    [
      'blank workflow run id',
      complete,
      certFiles.good,
      1,
      /GITHUB_RUN_ID is empty/,
      { GITHUB_RUN_ID: '' },
    ],
    [
      'blank repository',
      complete,
      certFiles.good,
      1,
      /GITHUB_REPOSITORY is empty/,
      { GITHUB_REPOSITORY: '' },
    ],
  ];

  for (const [label, buildJson, certs, expected, message, githubEnv] of cases) {
    const work = fs.mkdtempSync(path.join(dir, 'case-'));
    const jsonPath = path.join(work, 'eas-build.json');
    fs.writeFileSync(jsonPath, JSON.stringify(buildJson));
    const summary = path.join(work, 'summary.md');
    const provenance = path.join(work, 'build-provenance.json');
    const result = run(SCRIPTS.verify, {
      cwd: work,
      args: [jsonPath, path.join(work, 'app.apk')],
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_CERTS: certs,
        PROVENANCE: provenance,
        VERIFY_LOG: path.join(work, 'apksigner-verify.txt'),
        ...GITHUB_ENV_BASE,
        ...(githubEnv ?? {}),
        GITHUB_STEP_SUMMARY: summary,
      },
    });
    assert.equal(
      result.code,
      expected,
      `release-apk-verify.sh "${label}" expected exit ${expected}, got ${result.code}: ${result.out}`,
    );
    if (expected === 0) {
      const record = JSON.parse(fs.readFileSync(provenance, 'utf8'));
      for (const [field, value] of Object.entries({
        profile: 'production-apk',
        commit: FULL_SHA,
        buildId: 'build-1',
        appVersion: '1.4.2',
        versionCode: '57',
        signerDn: 'CN=HoloHunter, O=Expo, C=US',
      })) {
        assert.equal(record[field], value, `provenance.${field} should be ${value}`);
      }
      assert.match(
        record.apkSha256,
        /^[0-9a-f]{64}$/,
        'provenance must carry a real SHA-256 of the downloaded APK',
      );
      assert.match(fs.readFileSync(summary, 'utf8'), /APK SHA-256/);
    } else {
      assert.match(result.out, /::error::/, `"${label}" must annotate the failure`);
      assert.match(result.out, message);
      assert.equal(
        fs.existsSync(provenance),
        false,
        `"${label}" must not leave a build-provenance.json behind — a rejected build has no delivery record`,
      );
      assert.equal(
        fs.existsSync(summary),
        false,
        `"${label}" must not write a job summary for a rejected build`,
      );
    }
  }
}

function testVerifyRejectsAFailedApksigner() {
  const { dir, bin } = verifySandbox();
  const certs = path.join(dir, 'good.txt');
  fs.writeFileSync(certs, GOOD_CERTS);
  const work = fs.mkdtempSync(path.join(dir, 'failcase-'));
  const jsonPath = path.join(work, 'eas-build.json');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify({
      id: 'b',
      status: 'FINISHED',
      appVersion: '1.0.0',
      appBuildVersion: '9',
      artifacts: { applicationArchiveUrl: 'https://expo.dev/artifacts/fake.apk' },
    }),
  );
  const provenance = path.join(work, 'build-provenance.json');
  const result = run(SCRIPTS.verify, {
    cwd: work,
    args: [jsonPath, path.join(work, 'app.apk')],
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_CERTS: certs,
      FAKE_APKSIGNER_EXIT: '1',
      PROVENANCE: provenance,
      VERIFY_LOG: path.join(work, 'apksigner-verify.txt'),
      ...GITHUB_ENV_BASE,
    },
  });
  assert.equal(
    result.code,
    1,
    `a failing apksigner must fail the run, got exit ${result.code}: ${result.out}`,
  );
  assert.equal(fs.existsSync(provenance), false);
}

const tests = [
  testReleaseApkProfileExists,
  testReleaseApkUsesManagedReleaseSigning,
  testReleaseApkDiffersFromStoreOnlyInContainer,
  testWorkflowOffersTheReleaseApkProfile,
  testGateStepsAreEnabledAndInvokeTheirGuards,
  testWorkflowStructureCannotBypassGates,
  testOnlyTheGatedJobBuilds,
  testWorkflowInputSchema,
  testGuardsRunBeforeAnythingIsBuilt,
  testDebugApkWorkflowIsLabelledDebugOnly,
  testRefGuardBehaviour,
  testUsageGuardBehaviour,
  testBuildStatusBehaviour,
  testVerifyBehaviour,
  testVerifyRejectsAFailedApksigner,
];

try {
  for (const test of tests) {
    test();
    console.log(`✓ ${test.name}`);
  }
  console.log(`\n${tests.length} release-apk-pipeline tests passed`);
} finally {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
}
