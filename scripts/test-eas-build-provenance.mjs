#!/usr/bin/env node
/**
 * EAS production-build provenance invariants (DIC-1401 CR round 2).
 *
 * The release-parity contract proves "mobile production and Web Production
 * are at the same commit" from an immutable mobile source SHA. The gap this
 * test closes: only `production-apk` produced `build-provenance.json`; the
 * `production` profile (the formal AAB / iOS archive) ran `--no-wait` and
 * recorded nothing, so its source SHA was unverifiable and a parity check
 * could pass on a hand-typed value.
 *
 * Three layers, mirroring test-release-apk-pipeline.mjs:
 *   1. Configuration — eas-build.yml must wire record-eas-build-provenance.sh
 *      (and an artifact upload) into every non-production-apk EAS build, so
 *      the production AAB path emits the same evidence shape as the APK.
 *   2. Behaviour — record-eas-build-provenance.sh is executed against real
 *      fixtures and asserted on EXIT STATUS and emitted JSON: the immutable
 *      40-char commit must survive, tied to a real EAS build id, with a
 *      gitCommitHash alias for compatibility.
 *   3. Contract — the release-parity-check workflow's mobile-source-sha input
 *      description must reference the provenance file's commit fields.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const recorder = 'scripts/ci/record-eas-build-provenance.sh';
const easBuildWorkflow = fs.readFileSync(
  path.join(ROOT, '.github/workflows/eas-build.yml'),
  'utf8',
);
const parityWorkflow = fs.readFileSync(
  path.join(ROOT, '.github/workflows/release-parity-check.yml'),
  'utf8',
);

const SHA = '9e96afd3b9c1df6f4204eb02dd195c51c70def05';
const BUILD_ID = 'f1e2d3c4b5a6978877665544';

function runRecorder(fixtureJson, envOverrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'provenance-test-'));
  const raw = path.join(tmp, 'eas-build-raw.json');
  fs.writeFileSync(raw, JSON.stringify(fixtureJson));
  const env = {
    ...process.env,
    GITHUB_SHA: SHA,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'dicoge/hunterCard',
    GITHUB_RUN_ID: '4242',
  };
  Object.assign(env, envOverrides);
  const result = spawnSync('bash', [path.join(ROOT, recorder), raw, 'production'], {
    cwd: tmp,
    env,
    encoding: 'utf-8',
  });
  const provenancePath = path.join(tmp, 'build-provenance.json');
  const provenance = result.status === 0 && fs.existsSync(provenancePath)
    ? JSON.parse(fs.readFileSync(provenancePath, 'utf-8'))
    : null;
  return { code: result.status, out: result.stdout + result.stderr, provenance };
}

// ------------------------------------------------------ configuration wiring

test('eas-build.yml: every non-production-apk EAS build invokes record-eas-build-provenance.sh', () => {
  const invocations = easBuildWorkflow.match(/record-eas-build-provenance\.sh/g) || [];
  assert.ok(invocations.length >= 1, 'record-eas-build-provenance.sh must be wired into eas-build.yml');
  // The invocation must be guarded by the SAME condition that routes the
  // `production` AAB/IPA (non-APK) path, and the APK path must keep its own
  // existing provenance (release-apk-verify.sh) untouched.
  assert.match(easBuildWorkflow, /profile != 'production-apk'/);
  assert.match(easBuildWorkflow, /release-apk-verify\.sh/);
});

test('eas-build.yml: production AAB provenance is uploaded as an artifact (not silently discarded)', () => {
  assert.match(easBuildWorkflow, /Upload EAS build provenance/);
  assert.match(easBuildWorkflow, /build-provenance\.json/);
});

// ------------------------------------------------------------- behaviour

test('recorder: writes build-provenance.json with immutable 40-char commit + EAS build id', () => {
  const r = runRecorder([{ id: BUILD_ID, status: 'in-queue', platform: 'android' }]);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.provenance, 'no build-provenance.json written');
  assert.equal(r.provenance.commit, SHA);
  assert.equal(r.provenance.gitCommitHash, SHA);
  assert.equal(r.provenance.buildId, BUILD_ID);
  assert.equal(r.provenance.profile, 'production');
  assert.equal(r.provenance.ref, 'refs/heads/main');
  assert.match(r.provenance.workflowRun, /actions\/runs\/4242/);
});

test('recorder: prefers the EAS-cli-reported gitCommitHash when present, else falls back to GITHUB_SHA', () => {
  const r = runRecorder([{ id: BUILD_ID, gitCommitHash: 'c547a4b05e44a40b51fa1af1f81083a527aa9971' }]);
  assert.equal(r.code, 0, r.out);
  // The immutable checkout SHA remains the authoritative commit field; the
  // alias prefers the EAS-reported hash when the build already resolved it.
  assert.equal(r.provenance.commit, SHA);
  assert.equal(r.provenance.gitCommitHash, 'c547a4b05e44a40b51fa1af1f81083a527aa9971');
});

test('recorder: FAILS CLOSED without a full 40-char GITHUB_SHA (no provenance, non-zero exit)', () => {
  const r = runRecorder([{ id: BUILD_ID }], { GITHUB_SHA: 'short' });
  assert.notEqual(r.code, 0);
  assert.equal(r.provenance, null);
  assert.match(r.out, /40-character commit/);
});

test('recorder: FAILS CLOSED when eas build --json reports no build id', () => {
  const r = runRecorder([{ status: 'in-queue' }]);
  assert.notEqual(r.code, 0);
  assert.equal(r.provenance, null);
  assert.match(r.out, /no build id/);
});

// ---------------------------------------------------------------- contract

test('release-parity-check.yml: mobile-source-sha input description points at the provenance commit field', () => {
  assert.match(parityWorkflow, /build-provenance\.json \.commit/);
  assert.match(parityWorkflow, /gitCommitHash/);
});

console.log(`\neas-build-provenance: ${passed} tests passed`);