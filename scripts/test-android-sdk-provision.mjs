#!/usr/bin/env node
/**
 * OFFLINE tests for scripts/ci/android-sdk-provision.mjs (2026-11-08, PR #284 CI provisioning).
 *
 * Fake transport + fake installer only: no real sdkmanager, no network, no compiler. Every SDK is a
 * throwaway tree in os.tmpdir(). Synthetic terms "abc" (FIPS 180 SHA-1 oracle a9993e36…) stand in
 * for the Google text; the REAL policy is used to prove unknown terms stop before the installer.
 *
 *   positive: exact packages, exact args (stable channel, stdin closed), minimal env, licence
 *             state unchanged, already-present → no fetch / no install.
 *   negatives: context (platform / Actions / self-hosted / event / branch / fork / event file),
 *             SDK root hazards (symlink root, env mismatch, sdkmanager outside root, ndk/ symlink,
 *             partial install), metadata (HTTP redirect / wrong URL, DOCTYPE, duplicate package,
 *             revision, preview, dependencies, channel, licence id, licence ambiguity / entity /
 *             unknown hash, linux archive count / arch / url / checksum), accepted file (missing,
 *             extra hash, lacking the hash), installer (non-zero, declined prompt, licence write).
 *   wiring:   exactly one reviewed invocation, PR #284-only condition, before the unchanged
 *             unconditional guard, no other workflow — plus mutation controls.
 *
 * Run: node scripts/test-android-sdk-provision.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  provision, validateMetadata, httpsTransport, ProvisionRefusal, PACKAGES, METADATA_URL, ALLOWED_BRANCH,
} from './ci/android-sdk-provision.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const REAL_POLICY = JSON.parse(fs.readFileSync(path.join(__dirname, 'ci/android-sdk-policy.json'), 'utf8'));
const ABC_SHA1 = 'a9993e364706816aba3e25717850c26c9cd0d89d';
const POLICY = { ...JSON.parse(JSON.stringify(REAL_POLICY)), licenses: { 'android-sdk-license': { authorizedHashes: [ABC_SHA1] } } };

let passed = 0;
const tmpRoots = [];
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };
const tmp = (tag) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `sdk-provision-${tag}-`))); tmpRoots.push(d); return d; };
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const refusesAsync = async (p, re) => {
  await assert.rejects(p, (e) => e instanceof ProvisionRefusal && re.test(e.message), `expected refusal ${re}`);
};

function sdk({ accepted = ABC_SHA1 } = {}) {
  const root = tmp('sdk');
  write(path.join(root, 'cmdline-tools/latest/bin/sdkmanager'), '#!/bin/sh\nexit 99\n');
  fs.mkdirSync(path.join(root, 'licenses'), { recursive: true });
  if (accepted != null) write(path.join(root, 'licenses/android-sdk-license'), `\n${accepted}`);
  return root;
}
function eventFile(over = {}) {
  const f = path.join(tmp('event'), 'event.json');
  write(f, JSON.stringify({ pull_request: { head: { ref: ALLOWED_BRANCH, repo: { full_name: 'dicoge/holohunter' }, ...over } } }));
  return f;
}
function env(sdkRoot, over = {}) {
  return {
    GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_HEAD_REF: ALLOWED_BRANCH, GITHUB_REPOSITORY: 'dicoge/holohunter', GITHUB_EVENT_PATH: eventFile(),
    ANDROID_SDK_ROOT: sdkRoot, ANDROID_HOME: sdkRoot, PATH: '/usr/bin:/bin', JAVA_HOME: '/opt/java',
    GITHUB_TOKEN: 'must-not-reach-installer', ...over,
  };
}
const pkgXml = (id) => `<?xml version="1.0" encoding="UTF-8"?><ns2:repository xmlns:ns2="x"><license id="android-sdk-license" type="text">abc</license><localPackage path="${id}" obsolete="false"><uses-license ref="android-sdk-license"/></localPackage></ns2:repository>`;

/** Synthetic metadata in the shape of the official repository2-3.xml. */
function metadata({ license = 'abc', extraTop = '', pkg = {} } = {}) {
  const remote = (p) => {
    const o = pkg[p.id] || {};
    const r = o.revision || p.revision;
    const archive = (os, extra = '') => `<archive><complete><size>12345</size>${(os === 'linux' && o.checksum) || `<checksum type="sha1">${'0'.repeat(40)}</checksum>`}<url>${o.url || `${p.id.replace(';', '-')}-${os}.zip`}</url></complete><host-os>${os}</host-os>${extra}</archive>`;
    return `<remotePackage path="${p.id}">
<type-details/><revision><major>${r.major}</major><minor>${r.minor}</minor><micro>${r.micro}</micro>${o.preview ? '<preview>1</preview>' : ''}</revision>
<display-name>${p.id}</display-name>
<uses-license ref="${o.licenseRef || 'android-sdk-license'}"/>
${o.dependencies ? '<dependencies><dependency path="patcher;v4"/></dependencies>' : ''}
<channelRef ref="${o.channel || 'channel-0'}"/>
<archives>${archive('macosx')}${o.noLinux ? '' : archive('linux', o.arch ? `<host-arch>${o.arch}</host-arch>` : '')}${o.twoLinux ? archive('linux') : ''}${archive('windows')}</archives>
</remotePackage>${o.duplicate ? `<remotePackage path="${p.id}"><revision><major>9</major></revision></remotePackage>` : ''}`;
  };
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sdk:sdk-repository xmlns:sdk="http://schemas.android.com/sdk/android/repo/repository2/03">
<license id="android-sdk-license" type="text">${license}</license>${extraTop}
<channel id="channel-0">stable</channel><channel id="channel-1">beta</channel>
${PACKAGES.map(remote).join('\n')}
</sdk:sdk-repository>
`;
}
const transportOf = (body, { status = 200, url = METADATA_URL } = {}) => {
  const t = async (u) => { t.calls.push(u); return { status, url, body }; };
  t.calls = [];
  return t;
};
/** Fake installer that installs the requested packages (or misbehaves). */
function installer(sdkRoot, { status = 0, install = true, touchLicense = false } = {}) {
  const f = async (bin, args, childEnv) => {
    f.calls.push({ bin, args, env: childEnv });
    if (touchLicense) fs.appendFileSync(path.join(sdkRoot, 'licenses/android-sdk-license'), '\nffffffffffffffffffffffffffffffffffffffff');
    if (install) for (const id of args.filter((a) => !a.startsWith('--'))) write(path.join(sdkRoot, ...id.split(';'), 'package.xml'), pkgXml(id));
    return { status };
  };
  f.calls = [];
  return f;
}
const quiet = () => {};
const run = (root, over = {}) => provision({ env: env(root, over.env), platform: over.platform || 'linux', sdkRoot: root, policy: over.policy || POLICY, transport: over.transport || transportOf(metadata()), runInstaller: over.runInstaller || installer(root), log: quiet });

try {
  console.log('── positive ──');
  {
    const root = sdk();
    const inst = installer(root);
    const t = transportOf(metadata());
    const before = fs.readFileSync(path.join(root, 'licenses/android-sdk-license'), 'utf8');
    const r = await provision({ env: env(root), platform: 'linux', sdkRoot: root, policy: POLICY, transport: t, runInstaller: inst, log: quiet });
    assert.deepEqual(r.installed, ['ndk;27.1.12297006', 'cmake;3.22.1']);
    assert.deepEqual(t.calls, [METADATA_URL], 'exactly one fetch of the pinned official URL');
    assert.equal(inst.calls.length, 1);
    assert.equal(inst.calls[0].bin, path.join(root, 'cmdline-tools/latest/bin/sdkmanager'), 'the preinstalled sdkmanager');
    assert.deepEqual(inst.calls[0].args, [`--sdk_root=${root}`, '--channel=0', '--install', 'ndk;27.1.12297006', 'cmake;3.22.1'], 'exact packages, stable channel, no --licenses');
    assert.deepEqual(Object.keys(inst.calls[0].env).sort(), ['JAVA_HOME', 'PATH'], 'minimal installer env (no token / credentials / Android env)');
    assert.equal(fs.readFileSync(path.join(root, 'licenses/android-sdk-license'), 'utf8'), before, 'accepted terms untouched');
    assert.equal(r.licenseHash, ABC_SHA1);
    // already present → nothing fetched or installed
    const t2 = transportOf(metadata());
    const inst2 = installer(root);
    const r2 = await provision({ env: env(root), platform: 'linux', sdkRoot: root, policy: POLICY, transport: t2, runInstaller: inst2, log: quiet });
    assert.deepEqual(r2.installed, []);
    assert.equal(t2.calls.length + inst2.calls.length, 0);
    // only the missing one
    const root3 = sdk();
    write(path.join(root3, 'cmake/3.22.1/package.xml'), pkgXml('cmake;3.22.1'));
    const inst3 = installer(root3);
    await provision({ env: env(root3), platform: 'linux', sdkRoot: root3, policy: POLICY, transport: transportOf(metadata()), runInstaller: inst3, log: quiet });
    assert.deepEqual(inst3.calls[0].args.slice(-1), ['ndk;27.1.12297006']);
    ok('exact two packages, stable channel, minimal env, licence state unchanged; present → no fetch/install; only missing installed');
  }

  console.log('── unknown / new terms stop BEFORE the installer ──');
  {
    const root = sdk();
    const inst = installer(root);
    await refusesAsync(run(root, { policy: REAL_POLICY, runInstaller: inst }), /not authorized by the policy \(new \/ changed terms — STOP\)/);
    await refusesAsync(run(root, { transport: transportOf(metadata({ license: 'abcd' })), runInstaller: inst }), /not authorized/);
    await refusesAsync(run(sdk({ accepted: 'da39a3ee5e6b4b0d3255bfef95601890afd80709' }), { policy: { ...POLICY, licenses: { 'android-sdk-license': { authorizedHashes: [ABC_SHA1, 'da39a3ee5e6b4b0d3255bfef95601890afd80709'] } } } }), /not already accepted on this runner/);
    await refusesAsync(run(sdk({ accepted: `${ABC_SHA1}\n0123456789abcdef0123456789abcdef01234567` })), /unreviewed hash/);
    await refusesAsync(run(sdk({ accepted: null })), /missing: terms were never accepted/);
    assert.equal(inst.calls.length, 0, 'installer never invoked');
    ok('real policy (24333 only) vs other terms, changed text, hash not already accepted, extra accepted hash, no accepted file → STOP, no install');
  }

  console.log('── metadata refusals ──');
  {
    const cases = [
      [metadata({ extraTop: '<!DOCTYPE x [<!ENTITY e "y">]>' }), /DOCTYPE/],
      ['<root/>', /not an SDK repository/],
      [metadata({ pkg: { 'ndk;27.1.12297006': { duplicate: true } } }), /exactly one remotePackage ndk/],
      [metadata({ pkg: { 'cmake;3.22.1': { revision: { major: '3', minor: '22', micro: '2' } } } }), /revision micro/],
      [metadata({ pkg: { 'ndk;27.1.12297006': { preview: true } } }), /preview/],
      [metadata({ pkg: { 'cmake;3.22.1': { dependencies: true } } }), /dependencies/],
      [metadata({ pkg: { 'ndk;27.1.12297006': { channel: 'channel-3' } } }), /not the stable channel-0/],
      [metadata({ pkg: { 'ndk;27.1.12297006': { licenseRef: 'android-sdk-preview-license' } } }), /policy does not authorize/],
      [metadata({ extraTop: '<license id="android-sdk-license" type="text">abc</license>' }), /exactly one <license/],
      [metadata({ license: '&unknown;' }), /licence text refused/],
      [metadata({ pkg: { 'ndk;27.1.12297006': { noLinux: true } } }), /exactly one linux archive, found 0/],
      [metadata({ pkg: { 'ndk;27.1.12297006': { twoLinux: true } } }), /exactly one linux archive, found 2/],
      [metadata({ pkg: { 'cmake;3.22.1': { arch: 'aarch64' } } }), /arch aarch64/],
      [metadata({ pkg: { 'cmake;3.22.1': { url: 'https://evil.example/x.zip' } } }), /bare \.zip name/],
      [metadata({ pkg: { 'cmake;3.22.1': { url: '../x.zip' } } }), /bare \.zip name/],
      [metadata({ pkg: { 'ndk;27.1.12297006': { checksum: '<checksum type="md5">00</checksum>' } } }), /checksum invalid \(md5\)/],
      [metadata({ pkg: { 'cmake;3.22.1': { checksum: '<checksum type="sha1">xyz</checksum>' } } }), /checksum invalid \(sha1\)/],
    ];
    for (const [xml, re] of cases) assert.throws(() => validateMetadata(xml, POLICY), (e) => e instanceof ProvisionRefusal && re.test(e.message), String(re));
    const root = sdk();
    const inst = installer(root);
    await refusesAsync(run(root, { transport: transportOf(metadata(), { status: 302 }), runInstaller: inst }), /HTTP 200/);
    await refusesAsync(run(root, { transport: transportOf(metadata(), { url: 'https://dl.google.com/android/repository/repository2-1.xml' }), runInstaller: inst }), /pinned URL/);
    await assert.rejects(httpsTransport('http://dl.google.com/android/repository/repository2-3.xml'), /refusing/);
    await assert.rejects(httpsTransport('https://evil.example/repository2-3.xml'), /refusing/);
    assert.equal(inst.calls.length, 0);
    ok(`${cases.length} malformed / ambiguous / unreviewed metadata shapes + redirect / wrong URL / http / foreign host refused before install`);
  }

  console.log('── context + SDK-root hazards ──');
  {
    const root = sdk();
    await refusesAsync(run(root, { platform: 'darwin' }), /only an ephemeral Linux/);
    await refusesAsync(run(root, { env: { GITHUB_ACTIONS: undefined } }), /not running in GitHub Actions/);
    await refusesAsync(run(root, { env: { RUNNER_ENVIRONMENT: 'self-hosted' } }), /only an ephemeral GitHub-hosted runner/);
    await refusesAsync(run(root, { env: { RUNNER_OS: 'macOS' } }), /RUNNER_OS=macOS/);
    await refusesAsync(run(root, { env: { GITHUB_EVENT_NAME: 'push' } }), /pull_request only/);
    await refusesAsync(run(root, { env: { GITHUB_HEAD_REF: 'main' } }), /only fix\/last-known-price-20261107/);
    await refusesAsync(run(root, { env: { GITHUB_EVENT_PATH: eventFile({ repo: { full_name: 'someone/fork' } }) } }), /fork or other branch/);
    await refusesAsync(run(root, { env: { GITHUB_EVENT_PATH: path.join(root, 'nope.json') } }), /GITHUB_EVENT_PATH unreadable/);
    await refusesAsync(run(root, { env: { ANDROID_HOME: '/opt/other-sdk' } }), /differs from the fixed SDK root/);
    const link = path.join(tmp('link'), 'sdk');
    fs.symlinkSync(root, link);
    await refusesAsync(provision({ env: env(link), platform: 'linux', sdkRoot: link, policy: POLICY, transport: transportOf(metadata()), runInstaller: installer(root), log: quiet }), /real directory/);
    const outside = sdk();
    fs.rmSync(path.join(outside, 'cmdline-tools'), { recursive: true });
    fs.mkdirSync(path.join(outside, 'cmdline-tools/latest/bin'), { recursive: true });
    const foreign = path.join(tmp('foreign'), 'sdkmanager');
    write(foreign, '#!/bin/sh\n');
    fs.symlinkSync(foreign, path.join(outside, 'cmdline-tools/latest/bin/sdkmanager'));
    await refusesAsync(run(outside), /sdkmanager resolves outside the SDK root/);
    const noMgr = sdk();
    fs.rmSync(path.join(noMgr, 'cmdline-tools'), { recursive: true });
    await refusesAsync(run(noMgr), /preinstalled sdkmanager missing/);
    const ndkLink = sdk();
    fs.symlinkSync(tmp('elsewhere'), path.join(ndkLink, 'ndk'));
    await refusesAsync(run(ndkLink), /ndk\/ is a symlink/);
    const partial = sdk();
    fs.mkdirSync(path.join(partial, 'ndk/27.1.12297006'), { recursive: true });
    await refusesAsync(run(partial), /partial \/ malformed install is not overwritten/);
    ok('non-Linux / non-Actions / self-hosted / non-PR / other branch / fork / no event file / env mismatch / symlinked root / sdkmanager outside root / missing sdkmanager / ndk symlink / partial install → refused');
  }

  console.log('── installer outcomes ──');
  {
    let root = sdk();
    await refusesAsync(run(root, { runInstaller: installer(root, { status: 1 }) }), /sdkmanager exited 1/);
    root = sdk();
    await refusesAsync(run(root, { runInstaller: installer(root, { install: false }) }), /not installed: ndk;27\.1\.12297006, cmake;3\.22\.1/);
    root = sdk();
    await refusesAsync(run(root, { runInstaller: installer(root, { touchLicense: true }) }), /accepted-licence state CHANGED/);
    ok('non-zero exit, declined prompt (nothing installed), any licence-file change → STOP');
  }

  console.log('── static: helper never accepts terms; guard unchanged + read-only ──');
  {
    const src = fs.readFileSync(path.join(__dirname, 'ci/android-sdk-provision.mjs'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /--licenses|\byes\b|writeFileSync|appendFileSync|rmSync|unlinkSync|renameSync|copyFileSync|chmodSync/, 'no licence acceptance and no file writes');
    assert.match(code, /stdio: \['ignore', 'inherit', 'inherit'\]/, 'installer stdin closed');
    assert.match(code, /shell: false/);
    assert.match(code, /from '\.\/android-sdk-guard\.mjs'/, 'reuses the guard XML decoding / hashing');
    const guard = fs.readFileSync(path.join(__dirname, 'ci/android-sdk-guard.mjs'), 'utf8');
    assert.doesNotMatch(guard, /child_process|node:https?|writeFileSync|appendFileSync/, 'guard stays read-only');
    assert.deepEqual(REAL_POLICY.licenses['android-sdk-license'].authorizedHashes, ['24333f8a63b6825ea9c5514f83c2829b004d1fee'], 'policy hash unchanged');
    for (const p of PACKAGES) assert.ok(REAL_POLICY.authorizedPackages.includes(p.id), `${p.id} already authorized by policy`);
    assert.equal(METADATA_URL, 'https://dl.google.com/android/repository/repository2-3.xml');
    assert.match(code, /if \(process\.argv\.length > 2\)/, 'CLI rejects any argument (no URL / package / path input)');
    assert.match(code, /'--channel=0', '--install', \.\.\.todo\.map\(\(p\) => p\.id\)/, 'install args are only the fixed missing ids');
    assert.doesNotMatch(code, /process\.env\.[A-Z_]*(URL|PACKAGE|SDK)/, 'no env-supplied URL / package / SDK path');
    ok('no --licenses / yes / file writes; stdin closed; CLI takes no args; guard read-only; policy hash + packages unchanged; URL pinned');
  }

  console.log('── wiring: exactly one reviewed invocation ──');
  {
    const PROVISION_IF = "${{ github.event_name == 'pull_request' && github.head_ref == 'fix/last-known-price-20261107' && github.event.pull_request.head.repo.full_name == github.repository }}";
    // The helper itself (not this offline test, which Validate runs via npm run test:android-sdk-provision).
    const HELPER_RE = /ci\/android-sdk-provision\.mjs/;
    function provisionWiringProblems(ciText, others) {
      const p = [];
      let wf;
      try { wf = parseYaml(ciText); } catch (e) { return [`yaml ${e.message}`]; }
      const hits = [];
      for (const [jobId, job] of Object.entries(wf.jobs || {})) {
        (job.steps || []).forEach((s, i) => { if (HELPER_RE.test(String(s.run || '') + String(s.uses || ''))) hits.push({ jobId, i, s }); });
      }
      if (hits.length !== 1) return [`expected exactly one provisioning step, found ${hits.length}`];
      const { jobId, i, s } = hits[0];
      if (jobId !== 'release-apk-postpackage-guard') p.push(`provisioning in job ${jobId}`);
      if (String(s.run).trim() !== 'set -euo pipefail\nnode scripts/ci/android-sdk-provision.mjs') p.push('provisioning run must be exactly the fixed no-argument helper');
      if (s.if !== PROVISION_IF) p.push(`provisioning condition must be exactly the PR 284 same-repo branch: ${s.if}`);
      if ('continue-on-error' in s || 'shell' in s || s.env) p.push('provisioning step must not mask failures, override the shell or inject env');
      const steps = wf.jobs['release-apk-postpackage-guard'].steps;
      const gi = steps.findIndex((x) => /android-sdk-guard\.mjs --profile release/.test(String(x.run || '')));
      const wi = steps.findIndex((x) => /\.\/gradlew app:assembleRelease -Pandroid\.builder\.sdkDownload=false/.test(String(x.run || '')));
      const ji = steps.findIndex((x) => String(x.uses || '').startsWith('actions/setup-java@'));
      if (!(ji < i && i < gi && gi < wi)) p.push('order must be Java → provisioning → unchanged guard → gradlew (sdkDownload=false)');
      if (gi >= 0 && Object.hasOwn(steps[gi], 'if')) p.push('the guard must stay unconditional');
      for (const [name, text] of others) if (HELPER_RE.test(text)) p.push(`${name} must not provision`);
      return p;
    }
    const ci = fs.readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8');
    const others = fs.readdirSync(path.join(REPO, '.github/workflows')).filter((f) => f !== 'ci.yml')
      .map((f) => [f, fs.readFileSync(path.join(REPO, '.github/workflows', f), 'utf8')]);
    assert.deepEqual(provisionWiringProblems(ci, others), []);
    const rep = (from, to) => { assert.ok(ci.includes(from), `anchor ${from.slice(0, 50)}`); return ci.replace(from, to); };
    const runLine = '          node scripts/ci/android-sdk-provision.mjs\n';
    const mutants = {
      'condition removed': [rep(`        if: ${PROVISION_IF}\n`, ''), /condition must be exactly/],
      'any branch': [rep(" && github.head_ref == 'fix/last-known-price-20261107'", ''), /condition must be exactly/],
      'fork allowed': [rep(' && github.event.pull_request.head.repo.full_name == github.repository', ''), /condition must be exactly/],
      'argument added': [rep(runLine, '          node scripts/ci/android-sdk-provision.mjs https://evil.example/repo.xml\n'), /fixed no-argument helper/],
      'failure ignored': [rep(runLine, '          node scripts/ci/android-sdk-provision.mjs || true\n'), /fixed no-argument helper/],
      'continue-on-error': [rep(`        if: ${PROVISION_IF}\n`, `        if: ${PROVISION_IF}\n        continue-on-error: true\n`), /must not mask failures/],
      'guard made conditional': [rep("      - name: Verify pre-installed Android SDK (fail-closed; no install, no license acceptance)\n", `      - name: Verify pre-installed Android SDK (fail-closed; no install, no license acceptance)\n        if: \${{ github.event_name == 'push' }}\n`), /guard must stay unconditional/],
    };
    // provisioning moved AFTER the guard
    {
      const start = ci.indexOf('      - name: Provision exactly NDK');
      const end = ci.indexOf('      # 2026-11-07: this guard never installs');
      const block = ci.slice(start, end);
      const without = ci.slice(0, start) + ci.slice(end);
      mutants['provisioning after guard'] = [without.replace('      - name: Assemble release APK\n', `${block}      - name: Assemble release APK\n`), /order must be/];
    }
    for (const [name, [text, re]] of Object.entries(mutants)) {
      const probs = provisionWiringProblems(text, others);
      assert.ok(probs.some((x) => re.test(x)), `wiring mutation "${name}" must be caught by ${re}; got ${probs.join(' | ')}`);
    }
    const otherProbs = provisionWiringProblems(ci, [...others, ['eas-build.yml', 'run: node scripts/ci/android-sdk-provision.mjs']]);
    assert.ok(otherProbs.some((x) => /eas-build\.yml must not provision/.test(x)), 'another workflow provisioning is caught');
    ok(`one reviewed PR-284-only invocation before the unconditional guard; ${Object.keys(mutants).length + 1} wiring mutations caught`);
  }
} finally {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
}
console.log(`android-sdk-provision (offline): ${passed} checks passed`);
