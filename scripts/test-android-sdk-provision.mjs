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
 *   main push (2026-11-10): push to refs/heads/main of this repository from ci.yml / build-android.yml
 *             only; other refs / tags / forks / dispatch / schedule / other workflows refused; the
 *             terms proof is unchanged (unknown / unaccepted terms STOP before the installer).
 *   daily data family (2026-11-10, PR #287 R2): same-repo bot/scrape/YYYY-MM-DD (anchored, real
 *             calendar date) → main only; malformed / invalid-date / prefix / suffix refs, other or
 *             mismatched base, forks, env/event head mismatch, pull_request_target / dispatch /
 *             schedule refused; a daily ref is no push grant; PR 284 and push paths unchanged.
 *   normalization (2026-11-08): the official AOSP TrimStringAdapter port against hand-derived
 *             vectors (Java ASCII \s / trim, NBSP, VT, U+2028, tabs, lone vs paragraph LF) with
 *             wrong-port mutants; formatted text → same canonical hash accepted, while wording /
 *             paragraph / NBSP / entity / licence-ref / raw-trim-only / unknown-hash changes STOP
 *             before the fake installer; runner tool-version + accepted-hash evidence logged first.
 *
 * Run: node scripts/test-android-sdk-provision.mjs
 *      HH_SDK_REPOSITORY_XML=<saved official repository2-3.xml> node scripts/test-android-sdk-provision.mjs
 *        (adds the real-metadata positive: must yield 24333 under the unchanged policy; no network)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { createHash } from 'node:crypto';
import {
  provision, validateMetadata, httpsTransport, ProvisionRefusal, PACKAGES, METADATA_URL, ALLOWED_BRANCH, isDailyDataBranch,
  officialTrimStringAdapter, officialLicenseText,
} from './ci/android-sdk-provision.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const REAL_POLICY = JSON.parse(fs.readFileSync(path.join(__dirname, 'ci/android-sdk-policy.json'), 'utf8'));
const ABC_SHA1 = 'a9993e364706816aba3e25717850c26c9cd0d89d';
// Independent of the helper / guard hashing code (node:crypto directly).
const sha1 = (s) => createHash('sha1').update(s, 'utf8').digest('hex');
const POLICY = { ...JSON.parse(JSON.stringify(REAL_POLICY)), licenses: { 'android-sdk-license': { authorizedHashes: [ABC_SHA1] } } };

let passed = 0;
const tmpRoots = [];
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };
const tmp = (tag) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `sdk-provision-${tag}-`))); tmpRoots.push(d); return d; };
const write = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const refusesAsync = async (p, re) => {
  await assert.rejects(p, (e) => e instanceof ProvisionRefusal && re.test(e.message), `expected refusal ${re}`);
};

function sdk({ accepted = ABC_SHA1, tools = 'Pkg.Revision=22.0\nPkg.Path=cmdline-tools;22.0\nPkg.Desc=Android SDK Command-line Tools\n' } = {}) {
  const root = tmp('sdk');
  write(path.join(root, 'cmdline-tools/latest/bin/sdkmanager'), '#!/bin/sh\nexit 99\n');
  if (tools != null) write(path.join(root, 'cmdline-tools/latest/source.properties'), tools);
  fs.mkdirSync(path.join(root, 'licenses'), { recursive: true });
  if (accepted != null) write(path.join(root, 'licenses/android-sdk-license'), `\n${accepted}`);
  return root;
}
function eventFile(over = {}) {
  const f = path.join(tmp('event'), 'event.json');
  write(f, JSON.stringify({ pull_request: { head: { ref: ALLOWED_BRANCH, repo: { full_name: 'dicoge/holohunter' }, ...over } } }));
  return f;
}
function pushEventFile(over = {}) {
  const f = path.join(tmp('push-event'), 'event.json');
  write(f, JSON.stringify({ ref: 'refs/heads/main', repository: { full_name: 'dicoge/holohunter', fork: false }, ...over }));
  return f;
}
/** A push to main of this repository from ci.yml (the post-merge context of CI 42802314758). */
function pushEnv(sdkRoot, over = {}) {
  return env(sdkRoot, { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_HEAD_REF: '',
    GITHUB_WORKFLOW_REF: 'dicoge/holohunter/.github/workflows/ci.yml@refs/heads/main', GITHUB_EVENT_PATH: pushEventFile(), ...over });
}
/** PR #287 repair R2: a pull_request from a same-repo daily data branch bot/scrape/YYYY-MM-DD into main. */
const DATA_BRANCH = 'bot/scrape/2026-11-10';
function dataPrEnv(sdkRoot, over = {}, eventOver = {}, baseRef = 'main', branch = DATA_BRANCH) {
  const f = path.join(tmp('data-pr-event'), 'event.json');
  write(f, JSON.stringify({ pull_request: { head: { ref: branch, repo: { full_name: 'dicoge/holohunter' } },
    base: { ref: baseRef, repo: { full_name: 'dicoge/holohunter' } }, ...eventOver } }));
  return env(sdkRoot, { GITHUB_HEAD_REF: branch, GITHUB_BASE_REF: 'main', GITHUB_EVENT_PATH: f, ...over });
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
/** Independent licences/ snapshot (names + bytes), not the helper's own snapshot function. */
const snapshotOf = (root) => fs.readdirSync(path.join(root, 'licenses')).sort()
  .map((n) => `${n}=${fs.readFileSync(path.join(root, 'licenses', n), 'hex')}`).join('|');
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

  console.log('── official TrimStringAdapter port: hand-derived vectors (independent oracle) ──');
  // Each expected value was derived by hand from the AOSP rules (Java default \s = [ \t\n\x0B\f\r];
  // String.trim() strips code units <= U+0020), NOT by running the helper.
  const VECTORS = [
    ['a  b', 'a b'],                                   // repeated spaces collapse
    ['line one\nline two', 'line one line two'],       // lone LF → space
    ['para one.\n\npara two.', 'para one.\n\npara two.'], // blank paragraph preserved
    ['a\n\n\nb', 'a\n\n\nb'],                          // any LF run ≥ 2 preserved
    ['x\n   y', 'x y'],                                // indentation after LF removed, then LF → space
    ['use\tclause', 'use\tclause'],                    // tab NOT preceded by whitespace survives
    ['a \tb', 'a b'],                                  // tab preceded by space removed
    ['a\t\tb', 'a\tb'],                                // second tab preceded by tab removed
    ['a  b', 'a  b'],                        // NBSP is not Java \s: following space kept
    [' x ', ' x '],                // Java trim keeps NBSP
    [' x', ' x'],                            // Java trim keeps U+2028 (JS trim would not)
    ['a\u000B b', 'a\u000Bb'],                         // vertical tab IS Java \s: following space removed
    ['\u000Bx ', 'x'],                                 // Java trim strips VT and trailing space
    [' \n  lead\n', 'lead'],                           // leading/trailing layout
    ['a \n b', 'a b'],
    ['p1.\n \np2.', 'p1.\n\np2.'],                     // whitespace-only line becomes a blank paragraph
    ['x\r\n y', 'x\r y'],                              // adapter level: CR is \s, LF after CR is lone
  ];
  {
    for (const [input, expected] of VECTORS) assert.equal(officialTrimStringAdapter(input), expected, JSON.stringify(input));
    // Mutation controls: plausible-but-wrong ports must each fail at least one vector.
    const generic = (s) => s.replace(/\s+/g, ' ').trim();
    const MUTANTS = {
      'generic whitespace collapse': generic,
      'JS \\s in the lookbehind': (s) => s.replace(/(?<=\s)[ \t]*/g, '').replace(/(?<!\n)\n(?!\n)/g, ' ').replace(/ +/g, ' ').replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, ''),
      'JS String.trim': (s) => s.replace(/(?<=[ \t\n\x0B\f\r])[ \t]*/g, '').replace(/(?<!\n)\n(?!\n)/g, ' ').replace(/ +/g, ' ').trim(),
      'lone-LF rule dropped': (s) => s.replace(/(?<=[ \t\n\x0B\f\r])[ \t]*/g, '').replace(/ +/g, ' ').replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, ''),
      'every LF run → space': (s) => s.replace(/(?<=[ \t\n\x0B\f\r])[ \t]*/g, '').replace(/\n+/g, ' ').replace(/ +/g, ' ').replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, ''),
      'step 1 dropped': (s) => s.replace(/(?<!\n)\n(?!\n)/g, ' ').replace(/ +/g, ' ').replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, ''),
      'tabs collapsed too': (s) => s.replace(/(?<=[ \t\n\x0B\f\r])[ \t]*/g, '').replace(/(?<!\n)\n(?!\n)/g, ' ').replace(/[ \t]+/g, ' ').replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, ''),
      'raw trim only (old false preflight)': (s) => s.trim(),
    };
    for (const [name, fn] of Object.entries(MUTANTS)) {
      assert.ok(VECTORS.some(([i, e]) => fn(i) !== e), `mutant "${name}" must fail at least one vector`);
    }
    // XML layer: §2.11 end-of-line handling + the guard's strict decoder, then the adapter.
    const XML_VECTORS = [
      ['x\r\ny', 'x y'],                 // CRLF in the document → LF → lone → space
      ['x\ry', 'x y'],                   // lone CR → LF
      ['x&#13;\ny', 'x\r y'],            // a CR character reference is NOT end-of-line normalized
      ['a&amp;b  c', 'a&b c'],
      ['<![CDATA[ a  b ]]>', 'a b'],
    ];
    for (const [raw, expected] of XML_VECTORS) assert.equal(officialLicenseText(raw).canonical, expected, JSON.stringify(raw));
    assert.equal(officialLicenseText('  x\n   y \n').rawTrimmed, 'x\n   y', 'raw-trim form kept for provenance only');
    for (const bad of ['&nbsp;', 'a <b>x</b>', '&amp', '<![CDATA[x']) assert.throws(() => officialLicenseText(bad), Error, `malformed ${bad} refused`);
    ok(`${VECTORS.length} adapter + ${XML_VECTORS.length} XML vectors match the hand-derived oracle; ${Object.keys(MUTANTS).length} wrong ports each caught; malformed entities/markup/CDATA still refused`);
  }

  console.log('── formatted licence: same canonical terms accepted, substantive changes STOP before installer ──');
  {
    // RAW is CANON laid out the way repository XML wraps text (indentation, lone line breaks, a tab
    // after a line break, repeated spaces). CANON was derived by hand from the AOSP rules.
    const RAW = '\n  Terms and Conditions\n\n  This is the Android SDK\n  test agreement.   1. Introduction\n\tapplies.\n\n  2. Second clause.\n';
    const CANON = 'Terms and Conditions\n\nThis is the Android SDK test agreement. 1. Introduction applies.\n\n2. Second clause.';
    const CANON_SHA1 = sha1(CANON);
    const RAW_TRIM_SHA1 = sha1(RAW.trim());
    assert.notEqual(CANON_SHA1, RAW_TRIM_SHA1, 'fixture really exercises normalization');
    const FMT = { ...JSON.parse(JSON.stringify(REAL_POLICY)), licenses: { 'android-sdk-license': { authorizedHashes: [CANON_SHA1] } } };
    const fmtRun = (root, over = {}) => run(root, { policy: FMT, ...over });

    // positive (LF and CRLF documents), with runner evidence logged BEFORE the metadata fetch
    for (const doc of [RAW, RAW.replace(/\n/g, '\r\n')]) {
      const root = sdk({ accepted: CANON_SHA1 });
      write(path.join(root, 'licenses/android-sdk-preview-license'), `\n${'f'.repeat(40)}`);
      const logs = [];
      const t = async (u) => { logs.push(`FETCH ${u}`); return { status: 200, url: METADATA_URL, body: metadata({ license: doc }) }; };
      const inst = installer(root);
      const before = snapshotOf(root);
      const r = await provision({ env: env(root), platform: 'linux', sdkRoot: root, policy: FMT, transport: t, runInstaller: inst, log: (l) => logs.push(l) });
      assert.deepEqual(r.installed, ['ndk;27.1.12297006', 'cmake;3.22.1']);
      assert.equal(r.licenseHash, CANON_SHA1, 'canonical (adapter) hash is the authorized one');
      assert.equal(r.rawTrimHash, RAW_TRIM_SHA1, 'raw-trim provenance hash (CRLF is end-of-line normalized first)');
      assert.equal(snapshotOf(root), before, 'licences byte-identical');
      const all = logs.join('\n');
      const fetchAt = logs.findIndex((l) => l.startsWith('FETCH'));
      const toolsAt = logs.findIndex((l) => l.includes('cmdline-tools Pkg.Revision=22.0 Pkg.Path=cmdline-tools;22.0'));
      const acceptedAt = logs.findIndex((l) => l.includes(`runner licenses/android-sdk-license (file, 1 hash(es)): ${CANON_SHA1} [policy-authorized]`));
      assert.ok(toolsAt >= 0 && acceptedAt >= 0 && toolsAt < fetchAt && acceptedAt < fetchAt, 'tool version + existing accepted hashes logged before fetch');
      assert.ok(all.includes(`runner licenses/android-sdk-preview-license (file, 1 hash(es)): ${'f'.repeat(40)} [not in policy]`), 'other licence files observed, not used, not refused');
      assert.ok(all.includes(`android-sdk-license=${CANON_SHA1} (official TrimStringAdapter form`), 'canonical hash logged');
      assert.ok(all.includes(`raw decoded+trimmed XML text SHA-1 ${r.rawTrimHash} is NOT the SDK fingerprint`), 'raw-trim provenance logged');
      assert.ok(!all.includes('must-not-reach-installer') && !all.includes('GITHUB_TOKEN'), 'no env / token in logs');
      assert.equal(inst.calls.length, 1);
    }

    // substantive changes → STOP before the fake installer
    const generic = (s) => s.replace(/\s+/g, ' ').trim();
    const merged = RAW.replace('applies.\n\n  2.', 'applies.\n  2.');
    assert.equal(generic(merged), generic(RAW), 'a generic collapse could not tell a merged paragraph apart');
    const stops = [
      ['wording change', { license: RAW.replace('Second clause', 'Second clauses') }, FMT, /not authorized by the policy/],
      ['new paragraph', { license: `${RAW}\n  3. New clause.\n` }, FMT, /not authorized by the policy/],
      ['paragraph merged', { license: merged }, FMT, /not authorized by the policy/],
      ['NBSP inserted', { license: RAW.replace('Android SDK', 'Android SDK') }, FMT, /not authorized by the policy/],
      ['malformed entity', { license: `${RAW}&nbsp;` }, FMT, /licence text refused/],
      ['real policy (24333 only)', { license: RAW }, REAL_POLICY, /not authorized by the policy \(new \/ changed terms — STOP\)/],
      ['raw-trim hash authorized instead (old false preflight)', { license: RAW }, { ...FMT, licenses: { 'android-sdk-license': { authorizedHashes: [RAW_TRIM_SHA1] } } }, new RegExp(`raw-trim ${RAW_TRIM_SHA1}\\) is not authorized`)],
      ['one package changes licence ref', { license: RAW, pkg: { 'ndk;27.1.12297006': { licenseRef: 'android-sdk-preview-license' } } },
        { ...FMT, licenses: { 'android-sdk-license': { authorizedHashes: [CANON_SHA1] }, 'android-sdk-preview-license': { authorizedHashes: [CANON_SHA1] } } }, /different licences/],
      ['both packages change licence ref', { license: `${RAW}</license><license id="android-sdk-preview-license" type="text">${RAW}`, pkg: { 'ndk;27.1.12297006': { licenseRef: 'android-sdk-preview-license' }, 'cmake;3.22.1': { licenseRef: 'android-sdk-preview-license' } } },
        { ...FMT, licenses: { 'android-sdk-license': { authorizedHashes: [CANON_SHA1] }, 'android-sdk-preview-license': { authorizedHashes: [CANON_SHA1] } } }, /licenses\/android-sdk-preview-license missing/],
    ];
    for (const [name, meta, policy, re] of stops) {
      const root = sdk({ accepted: CANON_SHA1 });
      const inst = installer(root);
      await assert.rejects(fmtRun(root, { policy, transport: transportOf(metadata(meta)), runInstaller: inst }), (e) => e instanceof ProvisionRefusal && re.test(e.message), name);
      assert.equal(inst.calls.length, 0, `${name}: installer never invoked`);
    }
    ok(`LF + CRLF formatted text → canonical hash accepted with runner evidence logged first; ${stops.length} substantive / structural / ref / entity / unknown-hash changes STOP before install`);
  }

  console.log('── cmdline-tools version evidence (read-only; never invokes a tool) ──');
  {
    const cases = [
      [null, 'Pkg.Revision=unknown Pkg.Path=unknown'],
      ['Pkg.Desc=Android SDK Command-line Tools\n', 'Pkg.Revision=unknown Pkg.Path=unknown'],
      ['Pkg.Revision=$(curl evil)\nPkg.Path=cmdline-tools;latest\n', 'Pkg.Revision=unknown Pkg.Path=cmdline-tools;latest'],
      ['Pkg.Revision=16.0\r\nPkg.Path=cmdline-tools;16.0\r\n', 'Pkg.Revision=16.0 Pkg.Path=cmdline-tools;16.0'],
    ];
    for (const [props, expected] of cases) {
      const root = sdk({ tools: props });
      const logs = [];
      const r = await provision({ env: env(root), platform: 'linux', sdkRoot: root, policy: POLICY, transport: transportOf(metadata()), runInstaller: installer(root), log: (l) => logs.push(l) });
      assert.ok(logs.some((l) => l.includes(`cmdline-tools ${expected}`)), `logged ${expected}`);
      assert.equal(r.installed.length, 2, 'version evidence is observational (the sdkmanager licence check + closed stdin + guard are the gates)');
    }
    const root = sdk({ tools: null });
    const foreign = path.join(tmp('props'), 'source.properties');
    write(foreign, 'Pkg.Revision=22.0\n');
    fs.symlinkSync(foreign, path.join(root, 'cmdline-tools/latest/source.properties'));
    const inst = installer(root);
    await refusesAsync(run(root, { runInstaller: inst }), /source\.properties resolves outside the SDK root/);
    assert.equal(inst.calls.length, 0);
    ok('missing / incomplete / injected / CRLF source.properties logged safely; symlink outside root refused');
  }

  if (process.env.HH_SDK_REPOSITORY_XML) {
    console.log('── host-supplied saved official repository2-3.xml (read from disk; no network) ──');
    const meta = validateMetadata(fs.readFileSync(process.env.HH_SDK_REPOSITORY_XML, 'utf8'), REAL_POLICY);
    assert.equal(meta.licenseId, 'android-sdk-license');
    assert.equal(meta.licenseHash, '24333f8a63b6825ea9c5514f83c2829b004d1fee', 'official adapter form = policy 24333');
    assert.notEqual(meta.rawTrimHash, meta.licenseHash);
    for (const p of PACKAGES) assert.match(meta.archives[p.id].url, /^[A-Za-z0-9._-]+\.zip$/);
    console.log(`    rawTrim=${meta.rawTrimHash} canonical=${meta.licenseHash}`);
    for (const p of PACKAGES) console.log(`    ${p.id}: ${meta.archives[p.id].url} size=${meta.archives[p.id].size} ${meta.archives[p.id].checksumType}=${meta.archives[p.id].checksum}`);
    ok('real saved official metadata → 24333 under the unchanged policy; both linux archives valid');
  } else {
    console.log('  (skipped: set HH_SDK_REPOSITORY_XML=<saved repository2-3.xml> for the real-metadata positive)');
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
    await refusesAsync(run(root, { env: { GITHUB_EVENT_NAME: 'push' } }), /push ref undefined: only refs\/heads\/main/);
    await refusesAsync(run(root, { env: { GITHUB_EVENT_NAME: 'workflow_dispatch' } }), /pull_request \(PR 284 branch\) or push to main only/);
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

  console.log('── push to main (2026-11-10 follow-up): same terms proof, nothing broadened ──');
  {
    const runPush = (root, over = {}, extra = {}) => provision({ env: pushEnv(root, over), platform: 'linux', sdkRoot: root,
      policy: extra.policy || POLICY, transport: extra.transport || transportOf(metadata()), runInstaller: extra.runInstaller || installer(root), log: quiet });
    for (const wf of ['ci.yml', 'build-android.yml']) {
      const root = sdk();
      const inst = installer(root);
      const t = transportOf(metadata());
      const before = snapshotOf(root);
      const r = await runPush(root, { GITHUB_WORKFLOW_REF: `dicoge/holohunter/.github/workflows/${wf}@refs/heads/main` }, { transport: t, runInstaller: inst });
      assert.deepEqual(r.installed, ['ndk;27.1.12297006', 'cmake;3.22.1'], wf);
      assert.deepEqual(inst.calls[0].args, [`--sdk_root=${root}`, '--channel=0', '--install', 'ndk;27.1.12297006', 'cmake;3.22.1'], 'exact packages, no --licenses');
      assert.deepEqual(t.calls, [METADATA_URL], 'one fetch of the pinned official URL');
      assert.equal(snapshotOf(root), before, 'accepted terms untouched');
    }
    {
      // the terms proof is exactly the PR path's: new / unknown / unaccepted terms STOP before the installer
      const root = sdk();
      const inst = installer(root);
      await refusesAsync(runPush(root, {}, { runInstaller: inst, transport: transportOf(metadata({ license: 'abd' })) }), /not authorized by the policy/);
      const root2 = sdk({ accepted: null });
      const inst2 = installer(root2);
      await refusesAsync(runPush(root2, {}, { runInstaller: inst2 }), /never accepted on this runner/);
      const root3 = sdk({ accepted: `${ABC_SHA1}\nffffffffffffffffffffffffffffffffffffffff` });
      const inst3 = installer(root3);
      await refusesAsync(runPush(root3, {}, { runInstaller: inst3 }), /unreviewed hash/);
      const root4 = sdk();
      const inst4 = installer(root4);
      await refusesAsync(runPush(root4, {}, { policy: REAL_POLICY, runInstaller: inst4 }), /not authorized by the policy/);
      assert.equal(inst.calls.length + inst2.calls.length + inst3.calls.length + inst4.calls.length, 0, 'installer never reached');
    }
    const root = sdk();
    const inst = installer(root);
    const cases = [
      [{ GITHUB_REF: 'refs/heads/staging' }, /only refs\/heads\/main/],
      [{ GITHUB_REF: 'refs/heads/fix/last-known-price-20261107' }, /only refs\/heads\/main/],
      [{ GITHUB_REF: 'refs/tags/v1.0.0' }, /only refs\/heads\/main/],
      [{ GITHUB_REF: undefined }, /only refs\/heads\/main/],
      [{ GITHUB_HEAD_REF: 'fix/last-known-price-20261107' }, /must not carry a head ref/],
      [{ GITHUB_WORKFLOW_REF: 'dicoge/holohunter/.github/workflows/eas-build.yml@refs/heads/main' }, /only ci\.yml \/ build-android\.yml on main/],
      [{ GITHUB_WORKFLOW_REF: 'dicoge/holohunter/.github/workflows/ci.yml@refs/heads/staging' }, /only ci\.yml \/ build-android\.yml on main/],
      [{ GITHUB_WORKFLOW_REF: 'someone/fork/.github/workflows/ci.yml@refs/heads/main' }, /only ci\.yml \/ build-android\.yml on main/],
      [{ GITHUB_WORKFLOW_REF: undefined }, /only ci\.yml \/ build-android\.yml on main/],
      [{ GITHUB_EVENT_PATH: pushEventFile({ ref: 'refs/heads/other' }) }, /not this repository's main/],
      [{ GITHUB_EVENT_PATH: pushEventFile({ repository: { full_name: 'someone/fork' } }) }, /not this repository's main/],
      [{ GITHUB_EVENT_PATH: pushEventFile({ repository: { full_name: 'dicoge/holohunter', fork: true } }) }, /not this repository's main/],
      [{ GITHUB_EVENT_NAME: 'workflow_dispatch' }, /push to main only/],
      [{ GITHUB_EVENT_NAME: 'schedule' }, /push to main only/],
      [{ GITHUB_EVENT_NAME: 'pull_request_target' }, /push to main only/],
      [{ RUNNER_ENVIRONMENT: 'self-hosted' }, /only an ephemeral GitHub-hosted runner/],
    ];
    for (const [over, re] of cases) await refusesAsync(runPush(root, over, { runInstaller: inst }), re);
    assert.equal(inst.calls.length, 0);
    ok(`push to main from ci.yml / build-android.yml installs exactly the two packages under the unchanged terms proof; 4 terms STOPs; ${cases.length} broadened contexts refused`);
  }

  console.log('── daily data branch family (same-repo bot/scrape/YYYY-MM-DD → main only): same terms proof, nothing else generalized ──');
  {
    // anchored whole-ref family of REAL calendar dates; everything else is refused
    for (const ref of ['bot/scrape/2026-11-10', 'bot/scrape/2026-12-31', 'bot/scrape/2027-01-01', 'bot/scrape/2028-02-29']) {
      assert.equal(isDailyDataBranch(ref), true, ref);
    }
    const BAD_REFS = [
      'bot/scrape/2026-13-01', 'bot/scrape/2026-00-10', 'bot/scrape/2026-11-00', 'bot/scrape/2026-11-31', 'bot/scrape/2026-02-30',
      'bot/scrape/2027-02-29', 'bot/scrape/2026-1-10', 'bot/scrape/2026-11-1', 'bot/scrape/26-11-10', 'bot/scrape/1999-11-10',
      'bot/scrape/2026_11_10', 'bot/scrape/2026-11-10x', 'bot/scrape/2026-11-10-x', 'bot/scrape/2026-11-10/x', 'bot/scrape/2026-11-10\n',
      ' bot/scrape/2026-11-10', 'xbot/scrape/2026-11-10', 'refs/heads/bot/scrape/2026-11-10', 'Bot/scrape/2026-11-10', 'bot/scrapes/2026-11-10',
      'bot/scrape/', 'bot/scrape/x', 'bot/2026-11-10', '2026-11-10', '', undefined, null, ['bot/scrape/2026-11-10'],
    ];
    for (const ref of BAD_REFS) assert.equal(isDailyDataBranch(ref), false, JSON.stringify(ref));
    const runPr = (root, over = {}, eventOver = {}, baseRef = 'main', extra = {}) => provision({ env: dataPrEnv(root, over, eventOver, baseRef, extra.branch), platform: 'linux',
      sdkRoot: root, policy: extra.policy || POLICY, transport: extra.transport || transportOf(metadata()), runInstaller: extra.runInstaller || installer(root), log: quiet });
    for (const branch of ['bot/scrape/2026-11-10', 'bot/scrape/2026-11-11', 'bot/scrape/2027-01-01']) {
      const root = sdk();
      const inst = installer(root);
      const t = transportOf(metadata());
      const before = snapshotOf(root);
      const r = await runPr(root, {}, {}, 'main', { transport: t, runInstaller: inst, branch });
      assert.deepEqual(r.installed, ['ndk;27.1.12297006', 'cmake;3.22.1'], branch);
      assert.deepEqual(inst.calls[0].args, [`--sdk_root=${root}`, '--channel=0', '--install', 'ndk;27.1.12297006', 'cmake;3.22.1'], 'exact packages, no --licenses');
      assert.deepEqual(t.calls, [METADATA_URL]);
      assert.equal(snapshotOf(root), before, 'accepted terms untouched');
    }
    {
      // unknown / unaccepted terms STOP before the installer exactly as on every other path
      const r1 = sdk(); const i1 = installer(r1);
      await refusesAsync(runPr(r1, {}, {}, 'main', { runInstaller: i1, transport: transportOf(metadata({ license: 'abd' })) }), /not authorized by the policy/);
      const r2 = sdk({ accepted: null }); const i2 = installer(r2);
      await refusesAsync(runPr(r2, {}, {}, 'main', { runInstaller: i2 }), /never accepted on this runner/);
      const r3 = sdk(); const i3 = installer(r3);
      await refusesAsync(runPr(r3, {}, {}, 'main', { policy: REAL_POLICY, runInstaller: i3 }), /not authorized by the policy/);
      assert.equal(i1.calls.length + i2.calls.length + i3.calls.length, 0, 'installer never reached');
    }
    const root = sdk();
    const inst = installer(root);
    const ONLY = /only fix\/last-known-price-20261107 or bot\/scrape\/YYYY-MM-DD/;
    const BASE = /base is not this repository's main for the daily data branch/;
    const SAME_REPO = { full_name: 'dicoge/holohunter' };
    const cases = [
      // malformed / invalid-date / prefix / suffix refs, carried consistently by env AND event
      ...BAD_REFS.filter((r) => typeof r === 'string' && r !== '').map((branch) => [{}, {}, 'main', ONLY, branch]),
      // other base (env and event), missing env base, event base mismatch / other repo / missing
      [{ GITHUB_BASE_REF: 'staging' }, {}, 'staging', /may provision only for a pull request into main/],
      [{ GITHUB_BASE_REF: undefined }, {}, 'main', /may provision only for a pull request into main/],
      [{}, {}, 'staging', BASE],
      [{}, { base: { ref: 'main', repo: { full_name: 'someone/fork' } } }, 'main', BASE],
      [{}, { base: { ref: 'main' } }, 'main', BASE],
      [{}, { base: undefined }, 'main', BASE],
      // fork with the same branch name; env/event head mismatch (other valid date, PR 284 branch, malformed)
      [{}, { head: { ref: DATA_BRANCH, repo: { full_name: 'someone/fork' } } }, 'main', /fork or other branch/],
      [{}, { head: { ref: DATA_BRANCH } }, 'main', /fork or other branch/],
      [{}, { head: { ref: 'bot/scrape/2026-11-09', repo: SAME_REPO } }, 'main', /fork or other branch/],
      [{}, { head: { ref: ALLOWED_BRANCH, repo: SAME_REPO } }, 'main', /fork or other branch/],
      [{}, { head: { ref: 'bot/scrape/2026-11-10x', repo: SAME_REPO } }, 'main', /fork or other branch/],
      [{ GITHUB_HEAD_REF: 'bot/scrape/2026-11-09' }, {}, 'main', /fork or other branch/],
      // other events / runners
      [{ GITHUB_EVENT_NAME: 'pull_request_target' }, {}, 'main', /push to main only/],
      [{ GITHUB_EVENT_NAME: 'workflow_dispatch' }, {}, 'main', /push to main only/],
      [{ GITHUB_EVENT_NAME: 'schedule' }, {}, 'main', /push to main only/],
      [{ RUNNER_ENVIRONMENT: 'self-hosted' }, {}, 'main', /only an ephemeral GitHub-hosted runner/],
    ];
    for (const [over, eventOver, baseRef, re, branch] of cases) await refusesAsync(runPr(root, over, eventOver, baseRef, { runInstaller: inst, branch }), re);
    assert.equal(inst.calls.length, 0);
    // a daily ref is never a push grant: push paths keep requiring refs/heads/main from ci.yml / build-android.yml
    const rp = sdk();
    const ip = installer(rp);
    await refusesAsync(provision({ env: pushEnv(rp, { GITHUB_REF: `refs/heads/${DATA_BRANCH}` }), platform: 'linux', sdkRoot: rp, policy: POLICY,
      transport: transportOf(metadata()), runInstaller: ip, log: quiet }), /push ref refs\/heads\/bot\/scrape\/2026-11-10: only refs\/heads\/main/);
    assert.equal(ip.calls.length, 0);
    // the original PR 284 path is unchanged: no base-ref requirement was added there
    const r284 = sdk();
    const i284 = installer(r284);
    assert.deepEqual((await provision({ env: env(r284), platform: 'linux', sdkRoot: r284, policy: POLICY, transport: transportOf(metadata()), runInstaller: i284, log: quiet })).installed,
      ['ndk;27.1.12297006', 'cmake;3.22.1']);
    ok(`same-repo bot/scrape/YYYY-MM-DD (real dates) → main installs the same two packages under the unchanged terms proof; ${BAD_REFS.length} malformed refs rejected by the family; 3 terms STOPs; ${cases.length} other refs / bases / forks / head mismatches / events refused; daily ref not a push grant; PR 284 path unchanged`);
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

  console.log('── wiring: exactly the reviewed invocations (ci.yml PR 284 / push main; build-android.yml push main) ──');
  {
    const PR_IF = "github.event_name == 'pull_request' && github.head_ref == 'fix/last-known-price-20261107' && github.event.pull_request.head.repo.full_name == github.repository";
    const MAIN_IF = "github.event_name == 'push' && github.ref == 'refs/heads/main'";
    // PR #287 repair R2: the same-repo daily data family into main only. The expression is a prefilter
    // (no regex in Actions); the helper enforces the anchored bot/scrape/YYYY-MM-DD real-date family.
    const DATA_IF = "github.event_name == 'pull_request' && startsWith(github.head_ref, 'bot/scrape/') && github.base_ref == 'main' && github.event.pull_request.head.repo.full_name == github.repository";
    const CI_IF = `\${{ (${PR_IF}) || (${DATA_IF}) || (${MAIN_IF}) }}`;
    const DEBUG_IF = `\${{ ${MAIN_IF} }}`;
    const DEPLOY_IF = "github.event_name == 'workflow_dispatch' && inputs.deploy_production && needs.preflight.result == 'success' && needs.validate.result == 'success' && needs['release-apk-postpackage-guard'].result == 'success'";
    const RUN = 'set -euo pipefail\nnode scripts/ci/android-sdk-provision.mjs';
    // The helper itself (not this offline test, which Validate runs via npm run test:android-sdk-provision).
    const HELPER_RE = /ci\/android-sdk-provision\.mjs/;
    function provisionWiringProblems(ciText, debugText, others) {
      const p = [];
      const check = (text, file, wantJob, wantIf, guardRe, gradleRe) => {
        let wf;
        try { wf = parseYaml(text); } catch (e) { p.push(`${file}: yaml ${e.message}`); return null; }
        const hits = [];
        for (const [jobId, job] of Object.entries(wf.jobs || {})) {
          (job.steps || []).forEach((s, i) => { if (HELPER_RE.test(String(s.run || '') + String(s.uses || ''))) hits.push({ jobId, i, s }); });
        }
        if (hits.length !== 1) { p.push(`${file}: expected exactly one provisioning step, found ${hits.length}`); return wf; }
        const { jobId, i, s } = hits[0];
        if (jobId !== wantJob) p.push(`${file}: provisioning in job ${jobId}`);
        if (String(s.run).trim() !== RUN) p.push(`${file}: provisioning run must be exactly the fixed no-argument helper`);
        if (s.if !== wantIf) p.push(`${file}: provisioning condition must be exactly ${wantIf}: ${s.if}`);
        if ('continue-on-error' in s || 'shell' in s || s.env) p.push(`${file}: provisioning step must not mask failures, override the shell or inject env`);
        const steps = wf.jobs[wantJob]?.steps || [];
        const gi = steps.findIndex((x) => guardRe.test(String(x.run || '')));
        const wi = steps.findIndex((x) => gradleRe.test(String(x.run || '')));
        const ji = steps.findIndex((x) => String(x.uses || '').startsWith('actions/setup-java@'));
        if (!(ji >= 0 && ji < i && i < gi && gi < wi)) p.push(`${file}: order must be Java → provisioning → unchanged guard → gradlew (sdkDownload=false)`);
        if (gi >= 0 && Object.hasOwn(steps[gi], 'if')) p.push(`${file}: the guard must stay unconditional`);
        return wf;
      };
      const ci = check(ciText, 'ci.yml', 'release-apk-postpackage-guard', CI_IF,
        /android-sdk-guard\.mjs --profile release/, /\.\/gradlew app:assembleRelease -Pandroid\.builder\.sdkDownload=false/);
      const dbg = check(debugText, 'build-android.yml', 'build', DEBUG_IF,
        /android-sdk-guard\.mjs --profile debug/, /\.\/gradlew assembleDebug -Pandroid\.builder\.sdkDownload=false/);
      // nothing else widened: triggers and the dispatch-only Production deploy gate stay exactly as reviewed
      if (ci) {
        const on = ci.on || {};
        if (JSON.stringify(Object.keys(on)) !== JSON.stringify(['push', 'pull_request', 'workflow_dispatch'])
            || JSON.stringify(on.push?.branches) !== JSON.stringify(['main']) || JSON.stringify(on.pull_request?.branches) !== JSON.stringify(['main', 'staging'])
            || on.workflow_dispatch?.inputs?.deploy_production?.default !== false) p.push('ci.yml triggers changed');
        if (ci.jobs?.['deploy-production']?.if !== DEPLOY_IF) p.push('ci.yml Production deploy gate changed');
      }
      if (dbg) {
        const on = dbg.on || {};
        if (JSON.stringify(Object.keys(on)) !== JSON.stringify(['push', 'workflow_dispatch']) || JSON.stringify(on.push?.branches) !== JSON.stringify(['main'])) {
          p.push('build-android.yml triggers changed');
        }
      }
      for (const [name, text] of others) if (HELPER_RE.test(text)) p.push(`${name} must not provision`);
      return p;
    }
    const ci = fs.readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8');
    const debug = fs.readFileSync(path.join(REPO, '.github/workflows/build-android.yml'), 'utf8');
    const others = fs.readdirSync(path.join(REPO, '.github/workflows')).filter((f) => f !== 'ci.yml' && f !== 'build-android.yml')
      .map((f) => [f, fs.readFileSync(path.join(REPO, '.github/workflows', f), 'utf8')]);
    assert.deepEqual(provisionWiringProblems(ci, debug, others), []);
    const repIn = (src) => (from, to) => { assert.ok(src.includes(from), `anchor ${from.slice(0, 50)}`); return src.replace(from, to); };
    const rep = repIn(ci);
    const repD = repIn(debug);
    const runLine = '          node scripts/ci/android-sdk-provision.mjs\n';
    const move = (src, startMarker, endMarker, beforeMarker) => {
      const start = src.indexOf(startMarker);
      const end = src.indexOf(endMarker);
      assert.ok(start >= 0 && end > start, `anchors ${startMarker.slice(0, 40)}`);
      const block = src.slice(start, end);
      const without = src.slice(0, start) + src.slice(end);
      return without.replace(beforeMarker, `${block}${beforeMarker}`);
    };
    const mutants = {
      'ci condition removed': [rep(`        if: ${CI_IF}\n`, ''), debug, /ci\.yml: provisioning condition must be exactly/],
      'ci any PR branch': [rep(" && github.head_ref == 'fix/last-known-price-20261107'", ''), debug, /ci\.yml: provisioning condition/],
      'ci staging PR': [rep("github.head_ref == 'fix/last-known-price-20261107'", "github.base_ref == 'staging'"), debug, /ci\.yml: provisioning condition/],
      'ci fork allowed': [rep(' && github.event.pull_request.head.repo.full_name == github.repository', ''), debug, /ci\.yml: provisioning condition/],
      'ci data prefix generalized': [rep("startsWith(github.head_ref, 'bot/scrape/')", "startsWith(github.head_ref, 'bot/')"), debug, /ci\.yml: provisioning condition/],
      'ci data prefix unanchored': [rep("startsWith(github.head_ref, 'bot/scrape/')", "contains(github.head_ref, 'bot/scrape/')"), debug, /ci\.yml: provisioning condition/],
      'ci data prefix changed': [rep("startsWith(github.head_ref, 'bot/scrape/')", "startsWith(github.head_ref, 'bot/scrapes/')"), debug, /ci\.yml: provisioning condition/],
      'ci data branch any base': [rep(" && github.base_ref == 'main'", ''), debug, /ci\.yml: provisioning condition/],
      'ci data branch staging base': [rep("github.base_ref == 'main'", "github.base_ref == 'staging'"), debug, /ci\.yml: provisioning condition/],
      'ci data branch fork allowed': [rep("github.base_ref == 'main' && github.event.pull_request.head.repo.full_name == github.repository", "github.base_ref == 'main'"), debug, /ci\.yml: provisioning condition/],
      'ci any same-repo PR': [rep("startsWith(github.head_ref, 'bot/scrape/') && ", ''), debug, /ci\.yml: provisioning condition/],
      'ci data branch pull_request_target': [rep("(github.event_name == 'pull_request' && startsWith(", "(github.event_name == 'pull_request_target' && startsWith("), debug, /ci\.yml: provisioning condition/],
      'ci push any branch': [rep(" && github.ref == 'refs/heads/main') }}", ') }}'), debug, /ci\.yml: provisioning condition/],
      'ci dispatch added': [rep("github.ref == 'refs/heads/main') }}", "github.ref == 'refs/heads/main') || github.event_name == 'workflow_dispatch' }}"), debug, /ci\.yml: provisioning condition/],
      'ci argument added': [rep(runLine, '          node scripts/ci/android-sdk-provision.mjs https://evil.example/repo.xml\n'), debug, /fixed no-argument helper/],
      'ci failure ignored': [rep(runLine, '          node scripts/ci/android-sdk-provision.mjs || true\n'), debug, /fixed no-argument helper/],
      'ci continue-on-error': [rep(`        if: ${CI_IF}\n`, `        if: ${CI_IF}\n        continue-on-error: true\n`), debug, /must not mask failures/],
      'ci guard made conditional': [rep("      - name: Verify pre-installed Android SDK (fail-closed; no install, no license acceptance)\n", `      - name: Verify pre-installed Android SDK (fail-closed; no install, no license acceptance)\n        if: \${{ github.event_name == 'push' }}\n`), debug, /ci\.yml: the guard must stay unconditional/],
      'ci provisioning after guard': [move(ci, '      - name: Provision exactly NDK', '      # 2026-11-07: this guard never installs', '      - name: Assemble release APK\n'), debug, /ci\.yml: order must be/],
      'ci push trigger widened': [rep('    branches: [main]\n    paths-ignore:', '    branches: [main, staging]\n    paths-ignore:'), debug, /ci\.yml triggers changed/],
      'ci deploy gate widened': [rep("      github.event_name == 'workflow_dispatch'\n      && inputs.deploy_production\n", "      github.event_name != 'pull_request'\n"), debug, /Production deploy gate changed/],
      'ci deploy default on': [rep('        default: false', '        default: true'), debug, /ci\.yml triggers changed/],
      'debug condition removed': [ci, repD(`        if: ${DEBUG_IF}\n`, ''), /build-android\.yml: provisioning condition/],
      'debug dispatch added': [ci, repD(`        if: ${DEBUG_IF}\n`, "        if: ${{ github.event_name == 'push' || github.event_name == 'workflow_dispatch' }}\n"), /build-android\.yml: provisioning condition/],
      'debug push any branch': [ci, repD(`        if: ${DEBUG_IF}\n`, "        if: ${{ github.event_name == 'push' }}\n"), /build-android\.yml: provisioning condition/],
      'debug provisioning after guard': [ci, move(debug, '      # 2026-11-10 follow-up (push to main ONLY', '      # 2026-11-07: no SDK download', '      - name: Build Android debug APK\n'), /build-android\.yml: order must be/],
      'debug guard made conditional': [ci, repD("      - name: Verify pre-installed Android SDK (fail-closed; no install, no license acceptance)\n", `      - name: Verify pre-installed Android SDK (fail-closed; no install, no license acceptance)\n        if: \${{ github.event_name == 'push' }}\n`), /build-android\.yml: the guard must stay unconditional/],
      'debug trigger widened': [ci, repD('    branches: [main]\n', '    branches: [main, staging]\n'), /build-android\.yml triggers changed/],
      'debug argument added': [ci, repD(runLine, '          node scripts/ci/android-sdk-provision.mjs --channel=3\n'), /build-android\.yml: provisioning run must be exactly/],
    };
    for (const [name, [ciText, debugText, re]] of Object.entries(mutants)) {
      const probs = provisionWiringProblems(ciText, debugText, others);
      assert.ok(probs.some((x) => re.test(x)), `wiring mutation "${name}" must be caught by ${re}; got ${probs.join(' | ')}`);
    }
    const otherProbs = provisionWiringProblems(ci, debug, [...others, ['eas-build.yml', 'run: node scripts/ci/android-sdk-provision.mjs']]);
    assert.ok(otherProbs.some((x) => /eas-build\.yml must not provision/.test(x)), 'another workflow provisioning is caught');
    ok(`ci.yml (PR 284 | daily bot/scrape/* prefilter → main | push main) + build-android.yml (push main) invocations before the unconditional guards; triggers + deploy gate unchanged; ${Object.keys(mutants).length + 1} wiring mutations caught`);
  }
} finally {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
}
console.log(`android-sdk-provision (offline): ${passed} checks passed`);
