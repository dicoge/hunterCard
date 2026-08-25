#!/usr/bin/env node
/**
 * Release-APK pipeline invariants (DIC-1193).
 *
 * The failure this guards against: a DEBUG APK, or a preview/staging-content
 * APK, being handed to a tester as the "正式內容測試包". Three artifacts look
 * alike on disk and only the pipeline configuration tells them apart, so the
 * configuration is asserted here rather than trusted:
 *
 *   eas.json `production-apk`  — production environment/env, release-signed,
 *                                internal distribution, APK container.
 *   eas-build.yml              — that profile may only be cut from main / a
 *                                release tag, is never submitted to a store,
 *                                and its artifact is signature-verified with
 *                                provenance recorded before it can be shared.
 *   build-android.yml          — assembleDebug output is labelled DEBUG-ONLY.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// Minimal GitHub-workflow step reader. Substring-matching the raw YAML would
// pass while a guard sits behind `if: false` or is commented out entirely, so
// the guards are asserted as *enabled steps*, not as text that exists somewhere
// in the file. Steps are `      - name: X` with their keys indented under them.
function parseSteps(workflow) {
  const steps = [];
  let current = null;
  // Anchored at the real step indent so a `- name:` line inside a heredoc or
  // any other block scalar cannot forge a step.
  const STEP_INDENT = 6;
  for (const line of workflow.split('\n')) {
    const start = line.match(new RegExp(`^( {${STEP_INDENT}})- name:\\s*(.+?)\\s*$`));
    if (start) {
      current = { name: start[2], indent: start[1].length, if: null, uses: null, run: false };
      steps.push(current);
      continue;
    }
    if (!current) continue;
    const key = line.match(/^(\s*)(if|uses|run):\s*(.*)$/);
    if (!key) continue;
    if (key[1].length !== current.indent + 2) continue;
    if (key[2] === 'if') current.if = key[3].trim();
    if (key[2] === 'uses') current.uses = key[3].trim();
    if (key[2] === 'run') current.run = true;
  }
  return steps;
}

const easBuildSteps = parseSteps(easBuildWorkflow);
const androidSteps = parseSteps(androidWorkflow);

const RELEASE_APK_ONLY = "${{ inputs.profile == 'production-apk' }}";

function stepNamed(steps, name, workflowName) {
  const found = steps.find((s) => s.name === name);
  assert.ok(found, `${workflowName} must keep the step "${name}" — it is a release gate, not decoration`);
  return found;
}

function testReleaseApkProfileExists() {
  assert.ok(
    easJson.build?.[RELEASE_APK_PROFILE],
    `eas.json must define a "${RELEASE_APK_PROFILE}" build profile — it is the only source of a tester-installable production-content APK`,
  );
}

function testReleaseApkShipsProductionContent() {
  const apk = resolveProfile(RELEASE_APK_PROFILE);
  const production = resolveProfile('production');

  assert.equal(
    apk.environment,
    'production',
    'production-apk must build against the production EAS environment — a preview/staging environment would ship non-production content',
  );
  assert.deepEqual(
    apk.env ?? {},
    production.env ?? {},
    'production-apk env must match production exactly, otherwise the APK and the store build are different apps',
  );
  assert.equal(
    apk.env?.EXPO_PUBLIC_STORE_MVP,
    '1',
    'production-apk must keep the Store MVP release flag on so advanced surfaces stay hidden',
  );
}

function testReleaseApkIsAnInternallyDistributedApk() {
  const apk = resolveProfile(RELEASE_APK_PROFILE);
  assert.equal(apk.android?.buildType, 'apk', 'production-apk must produce an APK, not an AAB');
  assert.equal(
    apk.distribution,
    'internal',
    'production-apk is a sideload artifact — it must use internal distribution',
  );
  assert.notEqual(
    apk.developmentClient,
    true,
    'production-apk must not be a development-client build',
  );
  const gradleCommand = apk.android?.gradleCommand ?? '';
  assert.ok(
    !/debug/i.test(gradleCommand),
    `production-apk must not override the Gradle command to a debug build (got "${gradleCommand}")`,
  );
  assert.equal(
    easJson.submit?.[RELEASE_APK_PROFILE],
    undefined,
    'production-apk must have no submit profile — Play Internal Testing takes the production AAB, never this APK',
  );
}

function testStoreProfileStillShipsAnAab() {
  const production = resolveProfile('production');
  assert.equal(production.distribution, 'store');
  assert.equal(
    production.android?.buildType,
    'app-bundle',
    'the store profile must keep producing an AAB for Play Internal Testing',
  );
  assert.equal(
    resolveProfile('preview').environment,
    'preview',
    'preview must stay on the preview environment — it is deliberately NOT the production-content channel',
  );
}

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

function testWorkflowGuardsTheReleaseRef() {
  assert.match(
    easBuildWorkflow,
    /refs\/heads\/main\)/,
    'eas-build.yml must allow release builds from main',
  );
  assert.match(
    easBuildWorkflow,
    /refs\/tags\/v\*\)/,
    'eas-build.yml must allow release builds from a v* release tag',
  );
  assert.match(
    easBuildWorkflow,
    /merge-base --is-ancestor/,
    'a release tag must be proven to be contained in main before it can be built',
  );
  assert.match(
    easBuildWorkflow,
    /fetch-depth:\s*0/,
    'the checkout needs full history for the release-ref containment check',
  );
}

function testWorkflowNeverSubmitsTheApk() {
  assert.match(
    easBuildWorkflow,
    /production-apk cannot be submitted/,
    'eas-build.yml must refuse submit=true for the production-apk profile',
  );
  assert.match(
    easBuildWorkflow,
    /production-apk is Android-only/,
    'eas-build.yml must refuse non-Android platforms for the production-apk profile',
  );
}

function testWorkflowVerifiesSignatureAndProvenance() {
  assert.match(
    easBuildWorkflow,
    /apksigner verify --verbose --print-certs/,
    'the production APK must be signature-verified in CI',
  );
  assert.match(
    easBuildWorkflow,
    /CN=Android Debug/,
    'CI must reject an APK signed with the Android debug certificate',
  );
  assert.match(easBuildWorkflow, /sha256sum/, 'CI must record the APK SHA-256');
  assert.match(
    easBuildWorkflow,
    /build-provenance\.json/,
    'CI must emit a provenance record for the release APK',
  );
  for (const field of ['appVersion', 'versionCode', 'buildId', 'commit', 'apkSha256']) {
    assert.ok(
      easBuildWorkflow.includes(`--arg ${field}`),
      `provenance record must carry "${field}"`,
    );
  }
  const apkBuildStep = easBuildWorkflow.match(
    /EAS Build \(production APK[\s\S]*?eas build[\s\S]*?\n\n/,
  );
  assert.ok(apkBuildStep, 'eas-build.yml must have a dedicated production APK build step');
  assert.match(
    apkBuildStep[0],
    /--wait/,
    'the production APK build must wait for the artifact — its signature and SHA-256 cannot be verified otherwise',
  );
  assert.ok(
    !apkBuildStep[0].includes('--no-wait'),
    'the production APK build must not use --no-wait',
  );
}

function testDebugApkWorkflowIsLabelledDebugOnly() {
  assert.match(
    androidWorkflow,
    /^name:.*DEBUG-ONLY/m,
    'the assembleDebug workflow name must say DEBUG-ONLY',
  );
  assert.match(
    androidWorkflow,
    /name:\s*holohunter-DEBUG-ONLY-apk/,
    'the assembleDebug artifact name must say DEBUG-ONLY',
  );
  assert.match(
    androidWorkflow,
    /assembleDebug/,
    'the DEBUG-ONLY label must stay truthful: this workflow builds the debug variant',
  );
}

function testReleaseGateStepsAreEnabled() {
  const gates = [
    [
      'Guard release builds to main or a release tag',
      "${{ inputs.profile == 'production' || inputs.profile == 'production-apk' }}",
    ],
    ['Guard production-apk usage', RELEASE_APK_ONLY],
    ['EAS Build (production APK, wait for artifact)', RELEASE_APK_ONLY],
    ['Setup Java', RELEASE_APK_ONLY],
    ['Install Android build-tools (apksigner)', RELEASE_APK_ONLY],
    ['Verify signature and record build provenance', RELEASE_APK_ONLY],
    ['Upload production APK + provenance', RELEASE_APK_ONLY],
  ];
  for (const [name, expectedIf] of gates) {
    const step = stepNamed(easBuildSteps, name, 'eas-build.yml');
    if (expectedIf) {
      assert.equal(
        step.if,
        expectedIf,
        `"${name}" must run for every production-apk build — its condition is now ${step.if}`,
      );
    }
  }
  const refGuard = stepNamed(
    easBuildSteps,
    'Guard release builds to main or a release tag',
    'eas-build.yml',
  );
  assert.match(
    refGuard.if ?? '',
    /production-apk/,
    'the release-ref guard must apply to production-apk builds',
  );
  assert.match(
    refGuard.if ?? '',
    /'production'/,
    'the release-ref guard must also apply to store builds',
  );
  stepNamed(androidSteps, 'Label artifact as debug-only', 'build-android.yml');

  for (const [workflowName, steps] of [
    ['eas-build.yml', easBuildSteps],
    ['build-android.yml', androidSteps],
  ]) {
    for (const step of steps) {
      assert.ok(
        !/^\$\{\{\s*false\s*\}\}$|^false$/.test(step.if ?? ''),
        `${workflowName} step "${step.name}" is switched off with if: ${step.if}`,
      );
    }
  }
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

  // apksigner and sdkmanager are JVM tools: the pinned JDK has to land first,
  // and the signature check has to come after the tool that performs it.
  const chain = [
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

const tests = [
  testReleaseApkProfileExists,
  testReleaseApkShipsProductionContent,
  testReleaseApkIsAnInternallyDistributedApk,
  testStoreProfileStillShipsAnAab,
  testWorkflowOffersTheReleaseApkProfile,
  testWorkflowGuardsTheReleaseRef,
  testWorkflowNeverSubmitsTheApk,
  testWorkflowVerifiesSignatureAndProvenance,
  testReleaseGateStepsAreEnabled,
  testGuardsRunBeforeAnythingIsBuilt,
  testDebugApkWorkflowIsLabelledDebugOnly,
];

for (const test of tests) {
  test();
  console.log(`✓ ${test.name}`);
}
console.log(`\n${tests.length} release-apk-pipeline tests passed`);
