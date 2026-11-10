#!/usr/bin/env node
/**
 * Offline fixtures for scripts/ci/android-sdk-guard.mjs (2026-11-07, review R1 N2/N3).
 *
 * The guard replaced `yes | sdkmanager --licenses … || true` + sdkmanager installs. It must
 * only READ a pre-installed SDK and fail closed. Every case builds a throwaway SDK tree in
 * os.tmpdir(); nothing touches a real SDK, sdkmanager, Gradle or the network.
 *
 * Terms are SYNTHETIC: each fixture package.xml carries license text "abc" and a fixture
 * policy authorizes its SHA-1 oracle a9993e364706816aba3e25717850c26c9cd0d89d (the FIPS
 * 180 "abc" test vector), so no Google license text is committed. The genuine positive is
 * the later read-only guard run on the owner's real Mac SDK.
 *
 *   real policy: exactly the one locally evidenced hash, with provenance; no pending flag.
 *   positive: exact packages bound to the authorized terms (also via &#97;, CDATA, padding).
 *   negative (exit 2): missing root · unresolvable versions · missing package.xml · path not
 *   the exact package · new requirement · missing tool · accepted file missing / empty /
 *   extra hash / lacking the package hash · changed terms text · other license id ·
 *   DOCTYPE/ENTITY · unknown entity · two uses-license · duplicate license id.
 *   static: guard imports only node:fs/path/url/crypto, runs no process, no network, no
 *   writes; workflows have no sdkmanager / --licenses / downloads; the guard step runs
 *   BEFORE the executable gradlew line and nothing at step or job level can mask its exit
 *   status — proven against mutated workflow text.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runGuard, GuardRefusal, resolveBuildVersions, sha1Hex, decodeXmlText, parsePackageXml,
} from './ci/android-sdk-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const GUARD = path.join(__dirname, 'ci/android-sdk-guard.mjs');
const realPolicy = JSON.parse(fs.readFileSync(path.join(__dirname, 'ci/android-sdk-policy.json'), 'utf8'));

const EVIDENCED_HASH = '24333f8a63b6825ea9c5514f83c2829b004d1fee';
const ABC = 'abc';
const ABC_SHA1 = 'a9993e364706816aba3e25717850c26c9cd0d89d'; // independent oracle (FIPS 180 test vector)
const OTHER_HASH = 'da39a3ee5e6b4b0d3255bfef95601890afd80709'; // SHA-1(""), used only as an opaque listed hash

/** Fixture policy: the real package/profile rules, synthetic terms. */
const policy = clone(realPolicy);
policy.licenses = { 'android-sdk-license': { authorizedHashes: [ABC_SHA1] } };

let passed = 0;
const tmpRoots = [];
function clone(v) { return JSON.parse(JSON.stringify(v)); }
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}
function tmp(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `sdk-guard-${tag}-`));
  tmpRoots.push(d);
  return d;
}
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const VERSIONS = { compileSdk: '36', buildTools: '36.0.0', ndkVersion: '27.1.12297006' };
const RELEASE_PKGS = ['platforms;android-36', 'build-tools;36.0.0', 'ndk;27.1.12297006', 'platform-tools', 'cmake;3.22.1'];
const RELEASE_TOOLS = ['build-tools/36.0.0/aapt'];

function makeProject(versions = VERSIONS, { gradleProps = '' } = {}) {
  const root = tmp('project');
  write(path.join(root, 'node_modules/react-native/gradle/libs.versions.toml'), [
    '[versions]', 'minSdk = "24"', `compileSdk = "${versions.compileSdk}"`, 'targetSdk = "36"',
    `buildTools = "${versions.buildTools}"`, `ndkVersion = "${versions.ndkVersion}"`, '',
  ].join('\n'));
  if (gradleProps) write(path.join(root, 'android/gradle.properties'), gradleProps);
  return root;
}

/** Shape of an installed sdkmanager package.xml (namespaces trimmed to what the guard reads). */
function packageXml(pkg, { text = ABC, ref = 'android-sdk-license', licenseId = ref, path: p = pkg, extraLocal = '', prolog = '', extraTop = '' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${prolog}
<ns2:repository xmlns:ns2="http://schemas.android.com/repository/android/common/02">
<license id="${licenseId}" type="text">${text}</license>${extraTop}
<localPackage path="${p}" obsolete="false"><display-name>fixture</display-name><uses-license ref="${ref}"/>${extraLocal}</localPackage>
</ns2:repository>
`;
}

function makeSdk({ pkgs = RELEASE_PKGS, accepted = `\n${ABC_SHA1}\n`, tools = RELEASE_TOOLS, xml = {} } = {}) {
  const sdk = tmp('sdk');
  for (const pkg of pkgs) {
    const dir = path.join(sdk, ...pkg.split(';'));
    write(path.join(dir, 'package.xml'), typeof xml[pkg] === 'string' ? xml[pkg] : packageXml(pkg, xml[pkg] || {}));
    if (pkg.startsWith('platforms;')) write(path.join(dir, 'android.jar'), '');
  }
  for (const t of tools) write(path.join(sdk, t), '#!/bin/sh\n');
  if (accepted != null) write(path.join(sdk, 'licenses/android-sdk-license'), accepted);
  return sdk;
}

function snapshotTree(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${path.relative(dir, p)}:${fs.readFileSync(p, 'utf8')}`);
    }
  };
  walk(dir);
  return out.sort().join('\n');
}

function cli(args, env = {}) {
  return spawnSync(process.execPath, [GUARD, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env }, timeout: 30000 });
}
const refuses = (fn, re) => assert.throws(fn, (err) => err instanceof GuardRefusal && re.test(err.message), `expected refusal ${re}`);
const release = (sdk, project = makeProject(), pol = policy) => runGuard({ sdkRoot: sdk, policy: pol, profile: 'release', projectRoot: project });

try {
  console.log('── real policy: evidenced terms only ──');
  check('policy authorizes exactly the locally evidenced hash, with read-only provenance; no unverified or pending entries', () => {
    assert.deepEqual(Object.keys(realPolicy.licenses), ['android-sdk-license']);
    assert.deepEqual(realPolicy.licenses['android-sdk-license'].authorizedHashes, [EVIDENCED_HASH]);
    const prov = realPolicy.licenses['android-sdk-license'].provenance;
    assert.ok(prov && /read-only/.test(prov.kind) && /acceptedHashCount 1/.test(prov.acceptedFile) && /package\.xml/.test(prov.packageBinding));
    const text = JSON.stringify(realPolicy);
    for (const h of ['d56f5187479451eabf01fb78af6dfcb131a6481e', '8933bad161af4178b1185d1a37fbf41ea5269c55']) {
      assert.ok(!text.includes(h), `unevidenced hash ${h} must not be authorized`);
    }
    assert.ok(!('reviewStatus' in realPolicy) && !/pending-owner/.test(text), 'no pending flag pretending to be authority');
  });
  check('SHA-1 oracle: guard hash of "abc" equals the FIPS 180 vector (node:crypto, no dependency)', () => {
    assert.equal(sha1Hex(ABC), ABC_SHA1);
    assert.equal(decodeXmlText('&#97;b&#x63;'), 'abc');
    assert.equal(decodeXmlText('<![CDATA[a]]>b&amp;c'), 'ab&c');
  });

  console.log('── positive ──');
  check('exact packages bound to authorized + accepted terms → OK; versions from the RN lock; SDK untouched', () => {
    const project = makeProject();
    const sdk = makeSdk();
    const before = snapshotTree(sdk);
    const r = release(sdk, project);
    assert.deepEqual(r.versions, VERSIONS);
    assert.deepEqual(new Set(r.packages), new Set(RELEASE_PKGS));
    assert.equal(snapshotTree(sdk), before, 'the guard must not write into the SDK');
    const policyFile = path.join(tmp('policy'), 'policy.json');
    write(policyFile, JSON.stringify(policy));
    const res = cli(['--profile', 'release', '--sdk-root', sdk, '--project-root', project, '--policy', policyFile]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /nothing installed, no terms accepted/);
    assert.equal(snapshotTree(sdk), before);
  });
  check('terms text via numeric reference / CDATA / surrounding whitespace hashes to the same terms', () => {
    for (const text of ['&#97;bc', '<![CDATA[abc]]>', '\n  abc \n']) {
      release(makeSdk({ xml: { 'platform-tools': { text } } }));
    }
  });
  check('apksigner profile: build-tools;35.0.0 + apksigner → OK (no project needed)', () => {
    const sdk = makeSdk({ pkgs: ['build-tools;35.0.0'], tools: ['build-tools/35.0.0/apksigner'] });
    runGuard({ sdkRoot: sdk, policy, profile: 'apksigner' });
  });
  check('android/gradle.properties override wins over the RN lock (Gradle precedence)', () => {
    const project = makeProject(VERSIONS, { gradleProps: 'android.compileSdkVersion=35\nandroid.buildToolsVersion=35.0.0\n' });
    assert.deepEqual(resolveBuildVersions(project), { compileSdk: '35', buildTools: '35.0.0', ndkVersion: '27.1.12297006' });
  });

  console.log('── negative (fail closed) ──');
  check('missing SDK root / ANDROID_HOME unset → exit 2', () => {
    const res = cli(['--profile', 'release', '--sdk-root', path.join(os.tmpdir(), 'no-such-sdk-xyz'), '--project-root', makeProject()]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /SDK root not found/);
    assert.equal(cli(['--profile', 'apksigner']).status, 2);
  });
  check('versions not resolvable → refuse, never guess', () => {
    refuses(() => release(makeSdk(), tmp('empty')), /cannot resolve compileSdk, buildTools, ndkVersion/);
  });
  check('missing package.xml (package not installed)', () => {
    refuses(() => release(makeSdk({ pkgs: RELEASE_PKGS.filter((p) => !p.startsWith('ndk;')) })), /ndk;27\.1\.12297006: not installed/);
  });
  check('package.xml path is not the exact required package (other version in the directory)', () => {
    refuses(() => release(makeSdk({ xml: { 'build-tools;36.0.0': { path: 'build-tools;36.0.1' } } })), /declares "build-tools;36\.0\.1"/);
  });
  check('NEW package requirement (compileSdk 37) → not authorized → refuse even if installed', () => {
    const sdk = makeSdk({ pkgs: [...RELEASE_PKGS, 'platforms;android-37'] });
    refuses(() => release(sdk, makeProject({ ...VERSIONS, compileSdk: '37' })), /platforms;android-37: required by the build but NOT in authorizedPackages/);
  });
  check('missing tool (aapt / apksigner)', () => {
    refuses(() => release(makeSdk({ tools: [] })), /tool missing: build-tools\/36\.0\.0\/aapt/);
    refuses(() => runGuard({ sdkRoot: makeSdk({ pkgs: ['build-tools;35.0.0'], tools: [] }), policy, profile: 'apksigner' }), /apksigner/);
  });
  check('accepted licenses file missing / empty → refuse, and nothing is created', () => {
    const sdk = makeSdk({ accepted: null });
    refuses(() => release(sdk), /android-sdk-license.*missing/);
    assert.equal(fs.existsSync(path.join(sdk, 'licenses')), false, 'the guard must not create a license file');
    refuses(() => release(makeSdk({ accepted: '\n\n' })), /accepted file is empty/);
  });
  check('accepted file carries an extra / new hash → refuse (unknown terms never treated as accepted)', () => {
    refuses(() => release(makeSdk({ accepted: `${ABC_SHA1}\n0123456789abcdef0123456789abcdef01234567\n` })), /unreviewed hash\(es\) 0123456789abcdef/);
  });
  check('package terms hash authorized but NOT in the existing accepted file → refuse', () => {
    const pol = clone(policy);
    pol.licenses['android-sdk-license'].authorizedHashes = [ABC_SHA1, OTHER_HASH];
    refuses(() => release(makeSdk({ accepted: `${OTHER_HASH}\n` }), makeProject(), pol), /not in the existing accepted licenses\/android-sdk-license file/);
  });
  check('changed terms text (new hash) under the same license id → refuse', () => {
    refuses(() => release(makeSdk({ xml: { 'cmake;3.22.1': { text: 'abcd' } } })), /cmake;3\.22\.1: "android-sdk-license" terms text hashes to [0-9a-f]{40}, which is not an evidenced/);
  });
  check('package bound to another / unknown license id → refuse', () => {
    refuses(() => release(makeSdk({ xml: { 'ndk;27.1.12297006': { ref: 'android-sdk-preview-license' } } })), /uses license "android-sdk-preview-license"/);
  });
  check('malformed / ambiguous / entity-bearing package.xml → refuse (no entity or DTD resolution)', () => {
    const cases = [
      [{ prolog: '<!DOCTYPE r [<!ENTITY t SYSTEM "http://example.invalid/t">]>' }, /DOCTYPE \/ ENTITY/],
      [{ text: '&t;' }, /unknown entity "&t;"/],
      [{ text: 'a & b' }, /unterminated entity/],
      [{ extraLocal: '<uses-license ref="android-sdk-license"/>' }, /exactly one <uses-license>, found 2/],
      [{ extraTop: '<license id="android-sdk-license" type="text">abc</license>' }, /exactly one <license id="android-sdk-license">, found 2/],
      [{ text: '   ' }, /text is empty/],
    ];
    for (const [over, re] of cases) refuses(() => release(makeSdk({ xml: { 'platform-tools': over } })), re);
    refuses(() => release(makeSdk({ xml: { 'platform-tools': '<localPackage path="platform-tools"></localPackage>' } })), /exactly one <uses-license>|exactly one <license/);
    assert.throws(() => parsePackageXml('<x/>'), /exactly one <localPackage>/);
  });
  check('unknown profile → refuse', () => {
    refuses(() => runGuard({ sdkRoot: makeSdk(), policy, profile: 'nightly', projectRoot: makeProject() }), /unknown profile/);
  });

  console.log('── static: no installs, no license acceptance, no network ──');
  check('guard source: only node:fs/path/url/crypto, no process, no network, no writes', () => {
    const src = fs.readFileSync(GUARD, 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    assert.deepEqual(imports.sort(), ['node:crypto', 'node:fs', 'node:path', 'node:url'].sort());
    for (const banned of [/child_process/, /\bspawn\w*\(/, /\b(execSync|execFile|execFileSync)\(/, /\bfetch\(/, /node:https?/, /node:net/, /writeFileSync|mkdirSync|appendFileSync|copyFileSync|rmSync|unlinkSync/]) {
      assert.ok(!banned.test(src), `guard must not use ${banned}`);
    }
  });

  // N3: wiring analysis on EXECUTABLE lines and step/job blocks (comments never count).
  const isComment = (l) => /^\s*#/.test(l);
  function analyzeGuardWiring(text, { guardNeedle, gradlewNeedle = null, allowedIf = [] }) {
    const lines = text.split('\n');
    const problems = [];
    const gi = lines.findIndex((l) => !isComment(l) && l.includes(guardNeedle));
    if (gi < 0) return ['guard is not invoked on an executable line'];
    if (gradlewNeedle) {
      const wi = lines.findIndex((l) => /^\s*\.\/gradlew\s/.test(l) && l.includes(gradlewNeedle));
      if (wi < 0) problems.push('no executable gradlew line');
      else if (wi < gi) problems.push('gradlew runs before the guard');
      else if (!lines[wi].includes('-Pandroid.builder.sdkDownload=false')) problems.push('gradlew may auto-provision the SDK');
    }
    let start = gi;
    while (start >= 0 && !/^\s*- (name|uses):/.test(lines[start])) start -= 1;
    if (start < 0) return [...problems, 'guard is not inside a step'];
    const indent = /^(\s*)-/.exec(lines[start])[1].length;
    let end = gi + 1;
    while (end < lines.length) {
      const l = lines[end];
      if (l.trim() !== '' && !isComment(l)) {
        const lead = /^(\s*)/.exec(l)[1].length;
        if (lead < indent || (lead === indent && /^\s*-\s/.test(l))) break;
      }
      end += 1;
    }
    const step = lines.slice(start, end).filter((l) => !isComment(l));
    if (step.some((l) => /^\s*continue-on-error:\s*(true|\$\{\{)/.test(l))) problems.push('step continue-on-error');
    const ifLine = step.find((l) => /^\s*if:/.test(l));
    if (ifLine && !allowedIf.includes(ifLine.replace(/^\s*if:\s*/, '').trim())) problems.push(`step condition ${ifLine.trim()}`);
    if (step.some((l) => /\|\|\s*(true|:|exit\s+0)\b|;\s*true\s*$|\bset\s+\+e\b|\|\|\s*echo\b/.test(l))) problems.push('step script ignores a failure');
    if (step.some((l) => /^\s*shell:/.test(l))) problems.push('step overrides the shell');
    let job = gi;
    while (job >= 0 && !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[job])) job -= 1;
    if (job >= 0) {
      let stepsAt = job + 1;
      while (stepsAt < lines.length && !/^ {4}steps:/.test(lines[stepsAt])) stepsAt += 1;
      if (lines.slice(job, stepsAt).some((l) => !isComment(l) && /^ {4}continue-on-error:\s*(true|\$\{\{)/.test(l))) problems.push('job continue-on-error');
    }
    return problems;
  }
  const WIRING = [
    ['ci.yml', { guardNeedle: 'android-sdk-guard.mjs --profile release', gradlewNeedle: 'app:assembleRelease' }],
    ['build-android.yml', { guardNeedle: 'android-sdk-guard.mjs --profile debug', gradlewNeedle: 'assembleDebug' }],
    ['eas-build.yml', { guardNeedle: 'android-sdk-guard.mjs --profile apksigner', allowedIf: ["${{ inputs.profile == 'production-apk' }}"] }],
  ];
  const wf = (name) => fs.readFileSync(path.join(REPO, '.github/workflows', name), 'utf8');

  check('workflows: no sdkmanager / --licenses / SDK download / setup-android / `yes |`', () => {
    for (const [name] of WIRING) {
      const code = wf(name).split('\n').filter((l) => !isComment(l)).join('\n');
      assert.ok(!/sdkmanager/.test(code), `${name} must not run sdkmanager`);
      assert.ok(!/--licenses/.test(code), `${name} must not accept licenses`);
      assert.ok(!/commandlinetools-linux|dl\.google\.com\/android/.test(code), `${name} must not download SDK tools`);
      assert.ok(!/android-actions\/setup-android/.test(code), `${name} must not use a setup action that auto-accepts`);
      assert.ok(!/accept-android-sdk-licenses|yes \|/.test(code), `${name} must not pipe "yes" into anything`);
    }
  });
  check('real workflows: guard runs before the EXECUTABLE gradlew line; nothing masks its exit status', () => {
    for (const [name, opts] of WIRING) {
      assert.deepEqual(analyzeGuardWiring(wf(name), opts), [], name);
    }
    // The comment that mentions `./gradlew app:assembleRelease` precedes the guard; it must not count.
    const ci = wf('ci.yml');
    assert.ok(ci.split('\n').some((l) => isComment(l) && l.includes('./gradlew app:assembleRelease')), 'fixture premise: a comment names gradlew');
  });
  check('mutation sensitivity: every masking / reordering of the guard is caught', () => {
    const ci = wf('ci.yml');
    const lines = ci.split('\n');
    const gi = lines.findIndex((l) => !isComment(l) && l.includes('android-sdk-guard.mjs --profile release'));
    let si = gi;
    while (!/^\s*- name:/.test(lines[si])) si -= 1;
    const stepIndent = /^(\s*)-/.exec(lines[si])[1];
    const at = (i, insert) => [...lines.slice(0, i), insert, ...lines.slice(i)].join('\n');
    const jobLine = lines.findIndex((l) => /^ {2}release-apk-postpackage-guard:\s*$/.test(l));
    assert.ok(jobLine >= 0, 'fixture premise: the release job exists');
    const wi = lines.findIndex((l) => /^\s*\.\/gradlew\s/.test(l) && l.includes('app:assembleRelease'));
    const moved = [...lines];
    const [guardLine] = moved.splice(gi, 1);
    moved.splice(wi, 0, guardLine); // after removal the gradlew line shifted up by one → guard now after it
    const mutants = {
      'step continue-on-error: true': at(si + 1, `${stepIndent}  continue-on-error: true`),
      'step continue-on-error expression': at(si + 1, `${stepIndent}  continue-on-error: \${{ true }}`),
      'job continue-on-error: true': at(jobLine + 1, '    continue-on-error: true'),
      'guard || true': lines.map((l, i) => (i === gi ? `${l} || true` : l)).join('\n'),
      'guard || echo': lines.map((l, i) => (i === gi ? `${l} || echo skipped` : l)).join('\n'),
      'set +e before the guard': at(gi, `${/^(\s*)/.exec(lines[gi])[1]}set +e`),
      'step skipped by condition': at(si + 1, `${stepIndent}  if: false`),
      'shell override': at(si + 1, `${stepIndent}  shell: cat {0}`),
      'guard moved after gradlew': moved.join('\n'),
      'gradlew without sdkDownload=false': lines.map((l, i) => (i === wi ? l.replace(' -Pandroid.builder.sdkDownload=false', '') : l)).join('\n'),
      'guard only in a comment': lines.map((l, i) => (i === gi ? l.replace(/^(\s*)/, '$1# ') : l)).join('\n'),
    };
    for (const [name, text] of Object.entries(mutants)) {
      const problems = analyzeGuardWiring(text, WIRING[0][1]);
      assert.ok(problems.length > 0, `mutation "${name}" must be caught`);
    }
  });
} finally {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
}

console.log(`android-sdk-guard: ${passed} checks passed`);
