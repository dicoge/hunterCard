#!/usr/bin/env node
/**
 * android-sdk-provision.mjs — install EXACTLY `ndk;27.1.12297006` and `cmake;3.22.1` on an
 * ephemeral GitHub-hosted Linux runner for the PR #284 branch or an ordinary push to main of this
 * repository (ci.yml / build-android.yml only; 2026-11-10 follow-up), ONLY after proving from the
 * official repository metadata that these packages are bound to terms the repository already
 * evidences and the runner has already accepted (2026-11-08; owner-approved for these two
 * packages on ephemeral CI only).
 *
 * It never accepts terms: no `--licenses`, no `yes`, stdin closed (a licence prompt reads EOF and
 * the install is refused), no write / removal / rewrite under licenses/ (state snapshotted before
 * and after; any change stops). No arguments are accepted (no URLs, packages, channels or SDK
 * paths). Afterwards the UNCHANGED read-only guard (scripts/ci/android-sdk-guard.mjs) runs in its
 * own step and re-validates every package.xml, tool and licence binding before Gradle.
 *
 * Pre-install checks (any failure → exit 2, nothing installed):
 *   - context: Linux, GITHUB_ACTIONS=true, RUNNER_ENVIRONMENT=github-hosted, and EITHER a
 *     pull_request event from THIS repository on branch fix/last-known-price-20261107 (or, PR #287
 *     repair R2, a daily data branch matching exactly bot/scrape/YYYY-MM-DD with a real date, same
 *     repository, base main — env head == event head; or, 2026-11-11, exactly PR #288 from
 *     fix/price-hints-20261110 into main: number 288 in GITHUB_REF and the event, same-repo head
 *     and base), OR a push
 *     event to refs/heads/main of THIS repository (no head ref, not a fork) whose workflow is
 *     ci.yml or build-android.yml at refs/heads/main. Any other event (workflow_dispatch, schedule,
 *     pull_request_target, …), ref, tag, branch, fork or workflow is refused;
 *   - SDK root: the hosted runner's fixed path, a real directory (no symlink), env (if set) equal
 *     to it; sdkmanager, licenses/, ndk/, cmake/ resolve inside it;
 *   - metadata: the one pinned official URL over HTTPS, host pinned, no redirect, size capped;
 *     no DOCTYPE/ENTITY; exactly one remotePackage per identity; exact revision; stable channel;
 *     no preview; no dependencies; exactly one Linux archive (bare .zip name + checksum);
 *     exactly one referenced <license>, canonicalized EXACTLY as sdkmanager does (see
 *     officialLicenseText) and its SHA-1 ∈ policy authorizedHashes AND ∈ the runner's existing
 *     accepted licenses/<id> file (which holds only authorized hashes);
 *   - runner evidence (logged before any fetch/install; non-sensitive): the preinstalled
 *     cmdline-tools source.properties revision/path and every hash token already in licenses/.
 *
 * Usage (CI only): node scripts/ci/android-sdk-provision.mjs
 * Exit: 0 ok (installed, or already present) · 2 refusal · 1 unexpected error.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeXmlText, sha1Hex, parsePackageXml } from './android-sdk-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The only packages this helper may ever install, with their exact revisions. */
export const PACKAGES = Object.freeze([
  Object.freeze({ id: 'ndk;27.1.12297006', revision: { major: '27', minor: '1', micro: '12297006' } }),
  Object.freeze({ id: 'cmake;3.22.1', revision: { major: '3', minor: '22', micro: '1' } }),
]);
/** Official Google SDK repository metadata (schema 2-3, the one current sdkmanager reads). */
export const METADATA_URL = 'https://dl.google.com/android/repository/repository2-3.xml';
export const METADATA_HOST = 'dl.google.com';
export const METADATA_MAX_BYTES = 32 * 1024 * 1024;
export const HOSTED_SDK_ROOT = '/usr/local/lib/android/sdk';
export const ALLOWED_BRANCH = 'fix/last-known-price-20261107';
/**
 * 2026-11-10 (PR #287 repair R2; standing owner CI exception for these SAME two packages): the
 * daily data handoff family `bot/scrape/YYYY-MM-DD` that local-scrape-and-push.sh pushes
 * (`${ISOLATED_BRANCH_PREFIX}/$(date +%Y-%m-%d)`). Anchored, whole-ref match of a REAL calendar date
 * (2020–2099); same repository; base must be main. Not a prefix grant: `bot/scrape/x`,
 * `bot/scrape/2026-11-10-x`, `bot/scrape/2026-02-30`, forks, other bases are refused. This is the
 * recurring daily CI root cause only — no other package, term, workflow or access is added.
 */
export const DAILY_DATA_BRANCH_RE = /^bot\/scrape\/(20[2-9]\d)-(\d{2})-(\d{2})$/;
export function isDailyDataBranch(ref) {
  const m = typeof ref === 'string' ? DAILY_DATA_BRANCH_RE.exec(ref) : null;
  if (!m) return false;
  const [y, mo, d] = m.slice(1).map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}
/**
 * 2026-11-11 (PR #288, user-prioritised corrected test build; standing owner CI exception for these
 * SAME two packages, no new term): EXACTLY the same-repository pull request #288 from
 * `fix/price-hints-20261110` into main. All of the following must hold, in env AND in the event
 * payload: head ref == this branch, PR number == 288 (`GITHUB_REF` refs/pull/288/merge, event
 * `number` and `pull_request.number`), base main of this repository, head repository == this
 * repository. Any other branch / number / base / repo / fork / event is refused.
 */
export const PR288_BRANCH = 'fix/price-hints-20261110';
export const PR288_NUMBER = 288;
const PR288_MERGE_REF = `refs/pull/${PR288_NUMBER}/merge`;
const isAllowedPrBranch = (ref) => ref === ALLOWED_BRANCH || ref === PR288_BRANCH || isDailyDataBranch(ref);
export const ALLOWED_PUSH_REF = 'refs/heads/main';
/** The only workflows (on main) whose push run may provision (2026-11-10 follow-up). */
export const ALLOWED_PUSH_WORKFLOWS = Object.freeze(['.github/workflows/ci.yml', '.github/workflows/build-android.yml']);
export const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;

export class ProvisionRefusal extends Error {}
const refuse = (msg) => { throw new ProvisionRefusal(msg); };

// ── context ─────────────────────────────────────────────────────────────────────
export function assertContext({ env, platform, readFile = (f) => fs.readFileSync(f, 'utf8') }) {
  if (platform !== 'linux') refuse(`platform ${platform}: only an ephemeral Linux Actions runner`);
  if (env.GITHUB_ACTIONS !== 'true') refuse('not running in GitHub Actions');
  if (env.RUNNER_ENVIRONMENT !== 'github-hosted') refuse(`RUNNER_ENVIRONMENT=${env.RUNNER_ENVIRONMENT}: only an ephemeral GitHub-hosted runner`);
  if (env.RUNNER_OS !== 'Linux') refuse(`RUNNER_OS=${env.RUNNER_OS}`);
  const ev = env.GITHUB_EVENT_NAME;
  if (ev !== 'pull_request' && ev !== 'push') refuse(`event ${ev}: pull_request (PR 284 branch) or push to main only`);
  if (ev === 'pull_request' && !isAllowedPrBranch(env.GITHUB_HEAD_REF)) refuse(`branch ${env.GITHUB_HEAD_REF}: only ${ALLOWED_BRANCH} or bot/scrape/YYYY-MM-DD (or ${PR288_BRANCH} as PR #${PR288_NUMBER})`);
  if (ev === 'pull_request' && isDailyDataBranch(env.GITHUB_HEAD_REF) && env.GITHUB_BASE_REF !== 'main') {
    refuse(`base ${env.GITHUB_BASE_REF}: a daily data branch may provision only for a pull request into main`);
  }
  if (ev === 'pull_request' && env.GITHUB_HEAD_REF === PR288_BRANCH) {
    if (env.GITHUB_BASE_REF !== 'main') refuse(`base ${env.GITHUB_BASE_REF}: ${PR288_BRANCH} may provision only as PR #${PR288_NUMBER} into main`);
    if (env.GITHUB_REF !== PR288_MERGE_REF) refuse(`ref ${env.GITHUB_REF}: ${PR288_BRANCH} may provision only as PR #${PR288_NUMBER} (${PR288_MERGE_REF})`);
  }
  if (ev === 'push') {
    if (env.GITHUB_REF !== ALLOWED_PUSH_REF) refuse(`push ref ${env.GITHUB_REF}: only ${ALLOWED_PUSH_REF}`);
    if (env.GITHUB_HEAD_REF) refuse('push event must not carry a head ref');
    if (!ALLOWED_PUSH_WORKFLOWS.some((w) => env.GITHUB_WORKFLOW_REF === `${env.GITHUB_REPOSITORY}/${w}@${ALLOWED_PUSH_REF}`)) {
      refuse(`workflow ${env.GITHUB_WORKFLOW_REF}: only ci.yml / build-android.yml on main`);
    }
  }
  let event;
  try {
    event = JSON.parse(readFile(env.GITHUB_EVENT_PATH));
  } catch {
    refuse('GITHUB_EVENT_PATH unreadable');
  }
  if (ev === 'pull_request') {
    const head = event?.pull_request?.head;
    if (!head || !isAllowedPrBranch(head.ref) || head.ref !== env.GITHUB_HEAD_REF || head.repo?.full_name !== env.GITHUB_REPOSITORY) {
      refuse('pull request head is not this repository\'s allowed branch (fork or other branch)');
    }
    const base = event?.pull_request?.base;
    if (isDailyDataBranch(head.ref) && (base?.ref !== 'main' || base?.ref !== env.GITHUB_BASE_REF || base?.repo?.full_name !== env.GITHUB_REPOSITORY)) {
      refuse('pull request base is not this repository\'s main for the daily data branch');
    }
    if (head.ref === PR288_BRANCH) {
      const pr = event.pull_request;
      if (pr.number !== PR288_NUMBER || event.number !== PR288_NUMBER
          || base?.ref !== 'main' || base?.ref !== env.GITHUB_BASE_REF || base?.repo?.full_name !== env.GITHUB_REPOSITORY) {
        refuse(`pull request is not this repository's PR #${PR288_NUMBER} from ${PR288_BRANCH} into main`);
      }
    }
  } else if (event?.ref !== ALLOWED_PUSH_REF || event?.repository?.full_name !== env.GITHUB_REPOSITORY || event?.repository?.fork === true) {
    refuse('push event is not this repository\'s main');
  }
}

// ── SDK root / path hazards ─────────────────────────────────────────────────────
function realInside(root, p, label) {
  let real;
  try { real = fs.realpathSync(p); } catch { return null; }
  if (real !== root && !real.startsWith(`${root}${path.sep}`)) refuse(`${label} resolves outside the SDK root (${real})`);
  return real;
}

export function assertSdkRoot(sdkRoot, env) {
  for (const k of ['ANDROID_SDK_ROOT', 'ANDROID_HOME']) {
    if (env[k] && path.resolve(env[k]) !== sdkRoot) refuse(`${k}=${env[k]} differs from the fixed SDK root ${sdkRoot}`);
  }
  let st;
  try { st = fs.lstatSync(sdkRoot); } catch { refuse(`SDK root ${sdkRoot} missing`); }
  if (st.isSymbolicLink() || !st.isDirectory()) refuse(`SDK root ${sdkRoot} must be a real directory`);
  if (fs.realpathSync(sdkRoot) !== sdkRoot) refuse('SDK root is not canonical');
  const sdkmanager = path.join(sdkRoot, 'cmdline-tools/latest/bin/sdkmanager');
  if (!realInside(sdkRoot, sdkmanager, 'sdkmanager')) refuse('preinstalled sdkmanager missing (nothing is downloaded)');
  if (!realInside(sdkRoot, path.join(sdkRoot, 'licenses'), 'licenses/')) refuse('licenses/ missing');
  for (const dir of ['ndk', 'cmake']) {
    const p = path.join(sdkRoot, dir);
    if (fs.existsSync(p)) {
      if (fs.lstatSync(p).isSymbolicLink()) refuse(`${dir}/ is a symlink`);
      realInside(sdkRoot, p, `${dir}/`);
    }
  }
  return sdkmanager;
}

/** Which fixed packages still need installing (an existing exact package.xml means none). */
export function missingPackages(sdkRoot) {
  const out = [];
  for (const pkg of PACKAGES) {
    const dir = path.join(sdkRoot, ...pkg.id.split(';'));
    if (!fs.existsSync(dir)) { out.push(pkg); continue; }
    if (fs.lstatSync(dir).isSymbolicLink()) refuse(`${pkg.id}: package directory is a symlink`);
    realInside(sdkRoot, dir, pkg.id);
    let parsed;
    try {
      parsed = parsePackageXml(fs.readFileSync(path.join(dir, 'package.xml'), 'utf8'));
    } catch (err) {
      refuse(`${pkg.id}: an existing partial / malformed install is not overwritten (${err.message})`);
    }
    if (parsed.path !== pkg.id) refuse(`${pkg.id}: existing directory declares ${parsed.path}`);
  }
  return out;
}

// ── runner evidence (read-only; hex hashes, versions and file names only) ───────
/**
 * Preinstalled cmdline-tools version evidence for the CI log (read-only, never blocks: the host
 * reads it after CI; sdkmanager's own licence check + closed stdin + the guard are the gates).
 */
export function cmdlineToolsVersion(sdkRoot) {
  const p = path.join(sdkRoot, 'cmdline-tools/latest/source.properties');
  let text;
  try {
    if (!realInside(sdkRoot, p, 'cmdline-tools source.properties')) return { revision: 'unknown', path: 'unknown' };
    text = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if (err instanceof ProvisionRefusal) throw err;
    return { revision: 'unknown', path: 'unknown' };
  }
  const props = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(Pkg\.Revision|Pkg\.Path)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) props[m[1]] = m[2];
  }
  const safe = (v) => (v && /^[A-Za-z0-9.;_ -]{1,64}$/.test(v) ? v : 'unknown');
  return { revision: safe(props['Pkg.Revision']), path: safe(props['Pkg.Path']) };
}

/** Every licenses/ entry with its 40-hex tokens, each marked against the policy (logged; never changed). */
export function observeAcceptedState(sdkRoot, policy) {
  const dir = path.join(sdkRoot, 'licenses');
  return fs.readdirSync(dir).sort().map((name) => {
    const st = fs.lstatSync(path.join(dir, name));
    if (!st.isFile()) return { name, type: st.isSymbolicLink() ? 'symlink' : 'other', hashes: [], otherTokens: 0 };
    const tokens = fs.readFileSync(path.join(dir, name), 'utf8').split(/\s+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
    const known = new Set((policy?.licenses?.[name]?.authorizedHashes || []).map((h) => String(h).toLowerCase()));
    const hashes = tokens.filter((t) => /^[0-9a-f]{40}$/.test(t)).map((h) => ({ hash: h, authorized: known.has(h) }));
    return { name, type: 'file', hashes, otherTokens: tokens.length - hashes.length };
  });
}

// ── accepted-terms state ────────────────────────────────────────────────────────
export function snapshotLicenses(sdkRoot) {
  const dir = path.join(sdkRoot, 'licenses');
  return fs.readdirSync(dir).sort().map((name) => {
    const p = path.join(dir, name);
    const st = fs.lstatSync(p);
    return `${name}|${st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : 'other'}|${st.isFile() ? createHash('sha256').update(fs.readFileSync(p)).digest('hex') : ''}`;
  }).join('\n');
}

function acceptedHashes(sdkRoot, licenseId) {
  const p = path.join(sdkRoot, 'licenses', licenseId);
  if (fs.lstatSync(path.dirname(p)).isSymbolicLink()) refuse('licenses/ is a symlink');
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch { refuse(`licenses/${licenseId} missing: terms were never accepted on this runner (not accepted here)`); }
  return text.split(/\s+/).map((h) => h.trim().toLowerCase()).filter(Boolean);
}

// ── official metadata ───────────────────────────────────────────────────────────
/** Default transport: one HTTPS GET of the pinned URL; no redirect, size capped. */
export function httpsTransport(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname !== METADATA_HOST) { reject(new ProvisionRefusal(`refusing ${url}`)); return; }
    const req = https.get(u, { headers: { 'User-Agent': 'holohunter-ci-sdk-provision' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new ProvisionRefusal(`metadata HTTP ${res.statusCode}${res.headers.location ? ' (redirect refused)' : ''}`)); return; }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > METADATA_MAX_BYTES) { req.destroy(new ProvisionRefusal('metadata exceeds size cap')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: 200, url, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(120000, () => req.destroy(new ProvisionRefusal('metadata request timed out')));
    req.on('error', reject);
  });
}

const one = (re, text, what) => {
  const all = [...text.matchAll(re)];
  if (all.length !== 1) refuse(`metadata: expected exactly one ${what}, found ${all.length}`);
  return all[0];
};
const attr = (attrs, name) => {
  const all = [...String(attrs).matchAll(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'g'))];
  return all.length === 1 ? all[0][1] : null;
};
const tag = (body, name) => {
  const all = [...body.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, 'g'))];
  return all.length === 1 ? all[0][1].trim() : null;
};

// ── official licence canonicalization ───────────────────────────────────────────
// sdkmanager does NOT hash the raw (trimmed) XML text. In Android SDK Command-line Tools
// (22.0 verified by static javap of tools.repository.jar: LicenseType.value carries
// @XmlJavaTypeAdapter(TrimStringAdapter.class)) the parsed text first passes through the AOSP
// adapter, unchanged since 2015:
// https://android.googlesource.com/platform/tools/base/+/refs/heads/mirror-goog-studio-main/repository/src/main/java/com/android/repository/impl/meta/TrimStringAdapter.java
//   v.replaceAll("(?<=\\s)[ \t]*", "")      remove spaces/tabs preceded by whitespace
//    .replaceAll("(?<!\n)\n(?!\n)", " ")    lone newline → space (blank lines kept)
//    .replaceAll(" +", " ")                 collapse spaces
//    .trim()                                Java trim
// License.getLicenseHash() is the SHA-1 of that value. This is a literal port, NOT a generic
// whitespace collapse: Java's default \s is ASCII [ \t\n\x0B\f\r] (JS \s also matches NBSP etc.),
// tabs not preceded by whitespace survive, paragraph breaks survive, and Java String.trim()
// strips code units <= U+0020 only.
export function officialTrimStringAdapter(v) {
  return String(v)
    .replace(/(?<=[ \t\n\x0B\f\r])[ \t]*/g, '')
    .replace(/(?<!\n)\n(?!\n)/g, ' ')
    .replace(/ +/g, ' ')
    .replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '');
}

/**
 * The value sdkmanager hashes for a <license> element body: XML 1.0 §2.11 end-of-line handling
 * (the parser turns CRLF / lone CR in the document into LF; a &#13; reference stays CR), the
 * guard's strict decodeXmlText (5 predefined entities, numeric refs, CDATA; anything else
 * throws), then the official adapter. Also returns the raw decoded+trimmed form for provenance only.
 */
export function officialLicenseText(rawBody) {
  const decoded = decodeXmlText(String(rawBody).replace(/\r\n?/g, '\n'));
  return { canonical: officialTrimStringAdapter(decoded), rawTrimmed: decoded.trim() };
}

/**
 * Validate the metadata for the two fixed packages. Returns
 * { licenseId, licenseHash, rawTrimHash, archives: { [id]: { url, size, checksum } } } or throws.
 */
export function validateMetadata(xml, policy) {
  const text = String(xml);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) refuse('metadata: DOCTYPE / ENTITY declarations are refused');
  if (!/<(?:\w+:)?sdk-repository\b/.test(text)) refuse('metadata: not an SDK repository document');
  const channels = new Map([...text.matchAll(/<channel\b([^>]*)>([^<]*)<\/channel>/g)].map((m) => [attr(m[1], 'id'), m[2].trim()]));
  const archives = {};
  let licenseId = null;
  for (const pkg of PACKAGES) {
    const m = one(new RegExp(`<remotePackage\\b[^>]*\\bpath="${pkg.id.replace(/[.;]/g, (c) => `\\${c}`)}"[^>]*>([\\s\\S]*?)</remotePackage>`, 'g'), text, `remotePackage ${pkg.id}`);
    const body = m[1];
    if (/<remotePackage\b/.test(body)) refuse(`metadata: nested remotePackage in ${pkg.id}`);
    const rev = one(/<revision>([\s\S]*?)<\/revision>/g, body, `${pkg.id} revision`)[1];
    for (const k of ['major', 'minor', 'micro']) {
      if (tag(rev, k) !== pkg.revision[k]) refuse(`metadata: ${pkg.id} revision ${k}=${tag(rev, k)} ≠ ${pkg.revision[k]}`);
    }
    if (/<preview>/.test(rev)) refuse(`metadata: ${pkg.id} is a preview revision`);
    if (/<dependencies\b/.test(body)) refuse(`metadata: ${pkg.id} declares dependencies (not reviewed)`);
    const chan = [...body.matchAll(/<channelRef\b([^>]*)\/?>/g)];
    if (chan.length > 1) refuse(`metadata: ${pkg.id} has ${chan.length} channelRef`);
    const chanId = chan.length ? attr(chan[0][1], 'ref') : 'channel-0';
    if (chanId !== 'channel-0' || (channels.has('channel-0') && channels.get('channel-0') !== 'stable')) refuse(`metadata: ${pkg.id} channel ${chanId} is not the stable channel-0`);
    const uses = one(/<uses-license\b([^>]*?)\/?>/g, body, `${pkg.id} uses-license`);
    const ref = attr(uses[1], 'ref');
    if (!ref || !(policy.licenses && policy.licenses[ref])) refuse(`metadata: ${pkg.id} uses licence "${ref}", which the policy does not authorize`);
    if (licenseId && ref !== licenseId) refuse('metadata: the two packages use different licences');
    licenseId = ref;
    const linux = [...body.matchAll(/<archive>([\s\S]*?)<\/archive>/g)].map((a) => a[1]).filter((a) => tag(a, 'host-os') === 'linux');
    if (linux.length !== 1) refuse(`metadata: ${pkg.id} needs exactly one linux archive, found ${linux.length}`);
    const a = linux[0];
    const arch = tag(a, 'host-arch');
    if (arch !== null && arch !== 'x64') refuse(`metadata: ${pkg.id} linux archive arch ${arch}`);
    const complete = one(/<complete>([\s\S]*?)<\/complete>/g, a, `${pkg.id} complete archive`)[1];
    const url = tag(complete, 'url');
    const size = tag(complete, 'size');
    const ck = one(/<checksum\b([^>]*)>([^<]*)<\/checksum>/g, complete, `${pkg.id} checksum`);
    const ckType = attr(ck[1], 'type');
    const checksum = ck[2].trim().toLowerCase();
    if (!url || !/^[A-Za-z0-9._-]+\.zip$/.test(url)) refuse(`metadata: ${pkg.id} archive url must be a bare .zip name, got ${url}`);
    if (!size || !/^\d+$/.test(size)) refuse(`metadata: ${pkg.id} archive size invalid`);
    const okCk = (ckType === null || ckType === 'sha1') ? /^[0-9a-f]{40}$/.test(checksum) : ckType === 'sha256' && /^[0-9a-f]{64}$/.test(checksum);
    if (!okCk) refuse(`metadata: ${pkg.id} archive checksum invalid (${ckType || 'sha1'})`);
    archives[pkg.id] = { url, size: Number(size), checksum, checksumType: ckType || 'sha1' };
  }
  const lic = [...text.matchAll(/<license\b([^>]*)>([\s\S]*?)<\/license>/g)].filter((m) => attr(m[1], 'id') === licenseId);
  if (lic.length !== 1) refuse(`metadata: expected exactly one <license id="${licenseId}">, found ${lic.length}`);
  let text2;
  try { text2 = officialLicenseText(lic[0][2]); } catch (err) { refuse(`metadata: licence text refused — ${err.message}`); }
  if (!text2.canonical) refuse('metadata: licence text is empty');
  const licenseHash = sha1Hex(text2.canonical);
  const rawTrimHash = sha1Hex(text2.rawTrimmed);
  const authorized = (policy.licenses[licenseId].authorizedHashes || []).map((h) => String(h).toLowerCase());
  if (!authorized.includes(licenseHash)) refuse(`metadata: "${licenseId}" terms hash ${licenseHash} (official TrimStringAdapter form; raw-trim ${rawTrimHash}) is not authorized by the policy (new / changed terms — STOP)`);
  return { licenseId, licenseHash, rawTrimHash, archives };
}

// ── installer ───────────────────────────────────────────────────────────────────
/** Default installer: the preinstalled sdkmanager, exact packages, stable channel, stdin closed. */
export function spawnInstaller(sdkmanager, args, env) {
  return new Promise((resolve) => {
    const child = spawn(sdkmanager, args, { stdio: ['ignore', 'inherit', 'inherit'], env, shell: false });
    const timer = setTimeout(() => child.kill('SIGKILL'), INSTALL_TIMEOUT_MS);
    child.on('error', (err) => { clearTimeout(timer); resolve({ status: null, error: err.message }); });
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ status: code, signal }); });
  });
}

const INSTALLER_ENV_KEYS = ['PATH', 'JAVA_HOME', 'HOME', 'LANG', 'TMPDIR'];

/** Pure entry point (tests inject env / platform / sdkRoot / transport / runInstaller). */
export async function provision({
  env = process.env, platform = process.platform, sdkRoot = HOSTED_SDK_ROOT, policy,
  transport = httpsTransport, runInstaller = spawnInstaller, readFile, log = console.log,
} = {}) {
  assertContext({ env, platform, ...(readFile ? { readFile } : {}) });
  const sdkmanager = assertSdkRoot(sdkRoot, env);
  const tools = cmdlineToolsVersion(sdkRoot);
  log(`[sdk-provision] preinstalled cmdline-tools Pkg.Revision=${tools.revision} Pkg.Path=${tools.path} (official TrimStringAdapter licence form statically verified on 22.0; sdkmanager itself still decides — any prompt reads closed stdin and fails)`);
  for (const f of observeAcceptedState(sdkRoot, policy)) {
    log(`[sdk-provision] runner licenses/${f.name} (${f.type}, ${f.hashes.length} hash(es)): ${f.hashes.map((h) => `${h.hash}${h.authorized ? ' [policy-authorized]' : ' [not in policy]'}`).join(', ') || '(no hash tokens)'}${f.otherTokens ? `; ${f.otherTokens} non-hash token(s)` : ''}`);
  }
  const todo = missingPackages(sdkRoot);
  if (todo.length === 0) {
    log('[sdk-provision] both fixed packages already present; nothing installed (the guard re-validates them)');
    return { installed: [], cmdlineTools: tools };
  }
  const res = await transport(METADATA_URL);
  if (!res || res.status !== 200 || res.url !== METADATA_URL) refuse('metadata transport did not return the pinned URL with HTTP 200');
  const meta = validateMetadata(res.body, policy);
  const accepted = acceptedHashes(sdkRoot, meta.licenseId);
  const authorized = new Set(policy.licenses[meta.licenseId].authorizedHashes.map((h) => String(h).toLowerCase()));
  const unknown = accepted.filter((h) => !authorized.has(h));
  if (unknown.length) refuse(`licenses/${meta.licenseId} already carries unreviewed hash(es) ${unknown.join(', ')}`);
  if (!accepted.includes(meta.licenseHash)) refuse(`terms ${meta.licenseHash} are not already accepted on this runner; nothing is accepted here — STOP`);
  const metaSha = createHash('sha256').update(res.body).digest('hex');
  log(`[sdk-provision] metadata ${METADATA_URL} sha256=${metaSha}; terms ${meta.licenseId}=${meta.licenseHash} (official TrimStringAdapter form = what sdkmanager hashes; authorized + already accepted). Provenance only: raw decoded+trimmed XML text SHA-1 ${meta.rawTrimHash} is NOT the SDK fingerprint and is never authorized`);
  for (const pkg of todo) log(`[sdk-provision] ${pkg.id}: linux archive ${meta.archives[pkg.id].url} size=${meta.archives[pkg.id].size} ${meta.archives[pkg.id].checksumType}=${meta.archives[pkg.id].checksum}`);

  const before = snapshotLicenses(sdkRoot);
  const installerEnv = Object.fromEntries(INSTALLER_ENV_KEYS.filter((k) => env[k] != null).map((k) => [k, env[k]]));
  const args = [`--sdk_root=${sdkRoot}`, '--channel=0', '--install', ...todo.map((p) => p.id)];
  const run = await runInstaller(sdkmanager, args, installerEnv);
  const after = snapshotLicenses(sdkRoot);
  if (after !== before) refuse('accepted-licence state CHANGED during install — STOP (nothing may be accepted)');
  if (run.status !== 0) refuse(`sdkmanager exited ${run.status ?? run.signal ?? run.error}; install refused`);
  const stillMissing = missingPackages(sdkRoot);
  if (stillMissing.length) refuse(`not installed: ${stillMissing.map((p) => p.id).join(', ')} (e.g. a licence prompt was declined)`);
  log(`[sdk-provision] installed ${todo.map((p) => p.id).join(', ')}; licence state unchanged`);
  return { installed: todo.map((p) => p.id), metadataSha256: metaSha, licenseHash: meta.licenseHash, rawTrimHash: meta.rawTrimHash, cmdlineTools: tools };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv.length > 2) {
    console.error('[sdk-provision] no arguments are accepted (fixed packages, URL and SDK root)');
    process.exit(1);
  }
  let policy;
  try {
    policy = JSON.parse(fs.readFileSync(path.join(__dirname, 'android-sdk-policy.json'), 'utf8'));
  } catch (err) {
    console.error(`[sdk-provision] ${err.message}`);
    process.exit(1);
  }
  try {
    await provision({ policy });
  } catch (err) {
    if (err instanceof ProvisionRefusal) {
      console.error(`[sdk-provision] REFUSED (fail closed; no terms accepted):\n${err.message}`);
      process.exit(2);
    }
    console.error(`[sdk-provision] ${err.stack || err.message}`);
    process.exit(1);
  }
}
