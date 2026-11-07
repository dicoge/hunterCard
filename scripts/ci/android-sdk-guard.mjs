#!/usr/bin/env node
/**
 * android-sdk-guard.mjs — fail-closed, offline check of the PRE-INSTALLED Android SDK
 * (2026-11-07; replaces `yes | sdkmanager --licenses … || true` + sdkmanager installs).
 *
 * CI must never install SDK packages and never accept license terms on anyone's behalf.
 * This guard only READS files (node:fs) and hashes text (node:crypto). It never runs
 * sdkmanager, Gradle or any network call, never resolves XML entities or DTDs, and never
 * writes into the SDK. It exits non-zero when:
 *   1. the SDK root is missing;
 *   2. a required package version cannot be resolved from the build's own lock/config
 *      (react-native's libs.versions.toml, android/gradle.properties, android/build.gradle);
 *   3. a required package is not in the policy's authorizedPackages (a NEW requirement);
 *   4. a required package's `package.xml` is missing, malformed or ambiguous, or its
 *      `<localPackage path>` is not exactly the required package id (exact version binding);
 *   5. the package's single `<uses-license ref>` names a license id the policy does not
 *      authorize, or the referenced `<license id>` text (entity-decoded, trimmed) has a
 *      SHA-1 that is not an authorized hash for that id (UNKNOWN / CHANGED terms);
 *   6. that hash is not present in the SDK's own accepted `licenses/<id>` file, or that
 *      file is missing / empty / carries any hash the policy does not list;
 *   7. a required tool binary is missing.
 *
 * Gradle auto-provisioning is disabled separately on the gradlew command line
 * (-Pandroid.builder.sdkDownload=false).
 *
 * Usage:
 *   node scripts/ci/android-sdk-guard.mjs --profile release|debug|apksigner
 *     [--sdk-root DIR] [--policy FILE] [--project-root DIR]
 * Exit codes: 0 ok · 1 usage / unreadable input · 2 guard refusal.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLICY = path.join(__dirname, 'android-sdk-policy.json');

export class GuardRefusal extends Error {}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Java-properties style `key=value` lines → object (comments / blanks ignored). */
export function parseProperties(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#') || s.startsWith('!')) continue;
    const m = /^([^=:\s]+)\s*[=:]\s*(.*)$/.exec(s);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/**
 * The Android SDK versions the build will actually use, in Gradle's precedence:
 * android/gradle.properties (expo-build-properties overrides) → android/build.gradle
 * literal fallbacks → react-native's own libs.versions.toml. Unresolved → refusal.
 */
export function resolveBuildVersions(projectRoot) {
  const toml = readText(path.join(projectRoot, 'node_modules/react-native/gradle/libs.versions.toml')) || '';
  const props = parseProperties(readText(path.join(projectRoot, 'android/gradle.properties')) || '');
  const gradle = readText(path.join(projectRoot, 'android/build.gradle')) || '';
  const fromToml = (key) => {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm').exec(toml);
    return m ? m[1] : null;
  };
  const fromGradle = (re) => {
    const m = re.exec(gradle);
    return m ? m[1] : null;
  };
  const pick = (...values) => values.find((v) => typeof v === 'string' && v.trim() !== '') ?? null;
  const compileSdk = pick(
    props['android.compileSdkVersion'],
    fromGradle(/compileSdkVersion\s*=\s*(?:Integer\.parseInt\()?\s*(?:findProperty\(\s*['"]android\.compileSdkVersion['"]\s*\)\s*\?:\s*)?['"]?(\d+)['"]?/),
    fromToml('compileSdk'),
  );
  const buildTools = pick(
    props['android.buildToolsVersion'],
    fromGradle(/buildToolsVersion\s*=\s*(?:findProperty\(\s*['"]android\.buildToolsVersion['"]\s*\)\s*\?:\s*)?['"]([\d.]+)['"]/),
    fromToml('buildTools'),
  );
  const ndkVersion = pick(
    props['android.ndkVersion'],
    fromGradle(/ndkVersion\s*=\s*['"]([\d.]+)['"]/),
    fromToml('ndkVersion'),
  );
  const missing = [
    ['compileSdk', compileSdk], ['buildTools', buildTools], ['ndkVersion', ndkVersion],
  ].filter(([, v]) => v == null).map(([k]) => k);
  if (missing.length > 0) {
    throw new GuardRefusal(
      `cannot resolve ${missing.join(', ')} from node_modules/react-native/gradle/libs.versions.toml, `
      + 'android/gradle.properties or android/build.gradle (run after `npm ci` and prebuild); refusing to guess',
    );
  }
  if (!/^\d+$/.test(compileSdk) || !/^\d+(\.\d+)*$/.test(buildTools) || !/^\d+(\.\d+)*$/.test(ndkVersion)) {
    throw new GuardRefusal(`malformed SDK versions: compileSdk=${compileSdk} buildTools=${buildTools} ndkVersion=${ndkVersion}`);
  }
  return { compileSdk, buildTools, ndkVersion };
}

export function requiredPackages(policy, profileName, versions) {
  const profile = policy?.profiles?.[profileName];
  if (!profile) throw new GuardRefusal(`unknown profile "${profileName}"`);
  const pkgs = [];
  if (profile.resolveFromBuild) {
    pkgs.push(`platforms;android-${versions.compileSdk}`, `build-tools;${versions.buildTools}`, `ndk;${versions.ndkVersion}`);
  }
  for (const p of profile.extraPackages || []) pkgs.push(p);
  return [...new Set(pkgs)];
}

// ── package.xml license binding (no XML library, no entity / DTD resolution) ──

const XML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Decode XML character data: the 5 predefined entities, numeric references, CDATA. Anything else → throw. */
export function decodeXmlText(raw) {
  let out = '';
  let rest = String(raw);
  while (rest.length > 0) {
    const cdata = rest.indexOf('<![CDATA[');
    const chunk = cdata >= 0 ? rest.slice(0, cdata) : rest;
    if (/</.test(chunk)) throw new Error('markup inside license text');
    out += chunk.replace(/&([^;\s&]*);?/g, (whole, name) => {
      if (!whole.endsWith(';')) throw new Error(`unterminated entity "${whole}"`);
      if (Object.hasOwn(XML_ENTITIES, name)) return XML_ENTITIES[name];
      const num = /^#(?:x([0-9a-fA-F]+)|([0-9]+))$/.exec(name);
      if (num) {
        const cp = num[1] != null ? parseInt(num[1], 16) : parseInt(num[2], 10);
        if (!Number.isFinite(cp) || cp > 0x10ffff) throw new Error(`invalid character reference "${whole}"`);
        return String.fromCodePoint(cp);
      }
      throw new Error(`unknown entity "${whole}" (entities are never resolved)`);
    });
    if (cdata < 0) break;
    const end = rest.indexOf(']]>', cdata + 9);
    if (end < 0) throw new Error('unterminated CDATA');
    out += rest.slice(cdata + 9, end);
    rest = rest.slice(end + 3);
  }
  return out;
}

const attr = (attrs, name) => {
  const all = [...String(attrs).matchAll(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'g'))];
  return all.length === 1 ? all[0][1] : all.length === 0 ? null : undefined; // undefined = duplicated
};

export function sha1Hex(text) {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

/**
 * Parse one installed package's package.xml. Returns { path, licenseRef, licenseHash } or
 * throws with the exact reason. The license hash is SHA-1 of the entity-decoded, trimmed
 * `<license>` text (2026-11-07 read-only evidence: raw and trimmed hashes are identical for
 * all six locally installed packages).
 */
export function parsePackageXml(xml) {
  const text = String(xml);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('DOCTYPE / ENTITY declarations are refused (no external entities)');
  const local = [...text.matchAll(/<localPackage\b([^>]*)>/g)];
  if (local.length !== 1) throw new Error(`expected exactly one <localPackage>, found ${local.length}`);
  const pkgPath = attr(local[0][1], 'path');
  if (!pkgPath) throw new Error('<localPackage> has no single path attribute');
  const localEnd = text.indexOf('</localPackage>', local[0].index);
  if (localEnd < 0) throw new Error('unterminated <localPackage>');
  const localBody = text.slice(local[0].index, localEnd);
  const uses = [...localBody.matchAll(/<uses-license\b([^>]*?)\/?>/g)];
  if (uses.length !== 1) throw new Error(`expected exactly one <uses-license>, found ${uses.length}`);
  const licenseRef = attr(uses[0][1], 'ref');
  if (!licenseRef) throw new Error('<uses-license> has no single ref attribute');
  const defs = [...text.matchAll(/<license\b([^>]*)>([\s\S]*?)<\/license>/g)]
    .filter((m) => attr(m[1], 'id') === licenseRef);
  if (defs.length !== 1) throw new Error(`expected exactly one <license id="${licenseRef}">, found ${defs.length}`);
  const decoded = decodeXmlText(defs[0][2]).trim();
  if (decoded === '') throw new Error(`<license id="${licenseRef}"> text is empty`);
  return { path: pkgPath, licenseRef, licenseHash: sha1Hex(decoded) };
}

/** Accepted-terms file hashes, or a problem string. Must exist, be non-empty, and list ONLY authorized hashes. */
function acceptedHashes(sdkRoot, policy, licenseId) {
  const authorized = new Set((policy?.licenses?.[licenseId]?.authorizedHashes || []).map((h) => String(h).toLowerCase()));
  if (authorized.size === 0) return { problem: `license "${licenseId}": no authorized hashes in policy` };
  const file = path.join(sdkRoot, 'licenses', licenseId);
  const text = readText(file);
  if (text == null) return { problem: `license "${licenseId}": ${file} missing (terms not pre-accepted on this machine)` };
  const hashes = text.split(/\s+/).map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (hashes.length === 0) return { problem: `license "${licenseId}": accepted file is empty` };
  const unknown = hashes.filter((h) => !authorized.has(h));
  if (unknown.length > 0) {
    return { problem: `license "${licenseId}": accepted file carries unreviewed hash(es) ${unknown.join(', ')} — not covered by the evidenced policy` };
  }
  return { hashes: new Set(hashes), authorized };
}

/** Verify one required package (exact id + license binding). Returns a problem string or null. */
export function checkPackage(sdkRoot, policy, pkg) {
  const dir = path.join(sdkRoot, ...pkg.split(';'));
  const xml = readText(path.join(dir, 'package.xml'));
  if (xml == null) return `${pkg}: not installed (${path.join(dir, 'package.xml')} missing)`;
  let parsed;
  try {
    parsed = parsePackageXml(xml);
  } catch (err) {
    return `${pkg}: package.xml refused — ${err.message}`;
  }
  if (parsed.path !== pkg) return `${pkg}: package.xml declares "${parsed.path}", not the exact required package`;
  if (!policy?.licenses?.[parsed.licenseRef]) return `${pkg}: uses license "${parsed.licenseRef}", which the policy does not authorize`;
  const acc = acceptedHashes(sdkRoot, policy, parsed.licenseRef);
  if (acc.problem) return `${pkg}: ${acc.problem}`;
  if (!acc.authorized.has(parsed.licenseHash)) {
    return `${pkg}: "${parsed.licenseRef}" terms text hashes to ${parsed.licenseHash}, which is not an evidenced/authorized hash (new or changed terms)`;
  }
  if (!acc.hashes.has(parsed.licenseHash)) {
    return `${pkg}: terms ${parsed.licenseHash} are not in the existing accepted licenses/${parsed.licenseRef} file`;
  }
  if (pkg.startsWith('platforms;android-') && !fs.existsSync(path.join(dir, 'android.jar'))) return `${pkg}: android.jar missing`;
  return null;
}

/** Pure entry point (tests call this directly). Throws GuardRefusal on any problem. */
export function runGuard({ sdkRoot, policy, profile, projectRoot }) {
  if (!sdkRoot || !fs.existsSync(sdkRoot) || !fs.statSync(sdkRoot).isDirectory()) {
    throw new GuardRefusal(`Android SDK root not found: ${sdkRoot || '(ANDROID_HOME / ANDROID_SDK_ROOT unset)'}`);
  }
  const prof = policy?.profiles?.[profile];
  if (!prof) throw new GuardRefusal(`unknown profile "${profile}"`);
  const versions = prof.resolveFromBuild ? resolveBuildVersions(projectRoot) : null;
  const pkgs = requiredPackages(policy, profile, versions);
  const authorized = new Set(policy.authorizedPackages || []);
  const problems = [];
  for (const pkg of pkgs) {
    if (!authorized.has(pkg)) {
      problems.push(`${pkg}: required by the build but NOT in authorizedPackages (new requirement; nothing is installed or accepted)`);
      continue;
    }
    const p = checkPackage(sdkRoot, policy, pkg);
    if (p) problems.push(p);
  }
  for (const tpl of prof.requiredTools || []) {
    const rel = tpl.replace('{buildTools}', versions ? versions.buildTools : '');
    let ok = false;
    try {
      ok = fs.statSync(path.join(sdkRoot, rel)).isFile();
    } catch { /* missing */ }
    if (!ok) problems.push(`tool missing: ${rel}`);
  }
  if (problems.length > 0) throw new GuardRefusal(problems.join('\n'));
  return { packages: pkgs, versions };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const v = argv[i + 1];
    if (v == null || v.startsWith('--')) throw new Error(`missing value for ${a}`);
    out[a.slice(2)] = v;
    i += 1;
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let args;
  let policy;
  try {
    args = parseArgs(process.argv.slice(2));
    if (!args.profile) throw new Error('--profile is required (release | debug | apksigner)');
    policy = JSON.parse(fs.readFileSync(args.policy || DEFAULT_POLICY, 'utf8'));
  } catch (err) {
    console.error(`[android-sdk-guard] ${err.message}`);
    process.exit(1);
  }
  const sdkRoot = args['sdk-root'] || process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';
  try {
    const { packages, versions } = runGuard({
      sdkRoot, policy, profile: args.profile, projectRoot: args['project-root'] || process.cwd(),
    });
    if (versions) console.log(`[android-sdk-guard] resolved compileSdk=${versions.compileSdk} buildTools=${versions.buildTools} ndk=${versions.ndkVersion}`);
    console.log(`[android-sdk-guard] OK — pre-installed, exact, license-bound to evidenced terms: ${packages.join(', ')} (SDK ${sdkRoot}; nothing installed, no terms accepted)`);
  } catch (err) {
    if (err instanceof GuardRefusal) {
      console.error(`[android-sdk-guard] REFUSED (fail closed; nothing was installed or accepted):\n${err.message}`);
      process.exit(2);
    }
    console.error(`[android-sdk-guard] ${err.stack || err.message}`);
    process.exit(1);
  }
}
