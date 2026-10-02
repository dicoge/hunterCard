#!/usr/bin/env node
/**
 * test-scheduler-launcher.mjs — DIC-1167 (QA 7f47b457): the deployed scheduler
 * entry point never executes the resident checkout's scheduler.
 *
 * Runs the REAL `scripts/scheduler-launch.sh` against throwaway real git
 * repositories: an origin, and a resident clone that is stale (behind origin)
 * AND dirty (locally modified scheduler, untracked residue) — the 2026-10-02
 * production shape. Origin's committed scheduler is a stub that records where
 * and how it was run, so every case proves WHICH bytes executed:
 *
 *  A  installed launcher == origin's: origin's committed scheduler runs from a
 *     fresh bootstrap worktree detached at the fetched origin SHA, with
 *     HUNTERCARD_FORCE_ISOLATED=1, leaked stage-2/child flags stripped, and
 *     node_modules anchors resolving to the resident install; the bootstrap is
 *     removed afterwards and the resident (HEAD, index, working tree) is
 *     byte-identical.
 *  B  the scheduler's exit status is propagated verbatim.
 *  C  a drifted installed launcher re-executes origin's committed launcher
 *     (and cleans up its staged copy).
 *  D  origin without a committed launcher → fail closed, nothing runs.
 *  E  fetch failure → fail closed, nothing runs.
 *  F  resident node_modules lacking an anchor → fail closed, bootstrap removed.
 *  G  a re-executed launcher that still differs from origin → fail closed.
 *  H  a bootstrap leaked more than a day ago is removed; a fresh one is kept.
 *  I  (CR 11164f31) a HUNTERCARD_REMOTE_REF override naming an older tag,
 *     branch or SHA that still carries this exact launcher → fail closed,
 *     its stale scheduler never runs.
 *  J  a local tag / branch named origin/main pointing at that stale commit
 *     cannot shadow the fetched remote-tracking ref.
 *  K  a resident whose remote.origin.fetch is missing (so a plain fetch would
 *     not move origin/main) and whose origin/main is stale still runs the
 *     commit the fetch returned.
 *
 * Run: node scripts/test-scheduler-launcher.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_LAUNCHER = path.join(__dirname, 'scheduler-launch.sh');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Origin's committed scheduler: records its identity and environment, then
// exits with $STUB_RC. The resident's dirty copy records "resident" instead.
const stubScheduler = (who) => `#!/bin/bash
cd "$(dirname "$0")/.."
{
  echo "who=${who}"
  echo "pwd=$(pwd -P)"
  echo "head=$(git rev-parse HEAD)"
  echo "blob=$(git hash-object --no-filters scripts/local-scrape-and-push.sh)"
  echo "force=\${HUNTERCARD_FORCE_ISOLATED:-}"
  echo "stage2=\${HUNTERCARD_FORCE_ISOLATED_STAGE2:-}"
  echo "nonce=\${HUNTERCARD_STAGE2_NONCE:-}"
  echo "reexec=\${HUNTERCARD_LAUNCHER_REEXEC:-}"
  echo "remote_ref=\${HUNTERCARD_REMOTE_REF:-}"
  if [ -f node_modules/puppeteer/package.json ] && [ -f node_modules/cheerio/package.json ]; then echo "anchors=ok"; else echo "anchors=missing"; fi
  echo "nm=$(cd node_modules && pwd -P)"
} >> "$TRACE_FILE"
exit "\${STUB_RC:-0}"
`;

function commitAll(repo, msg) {
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg);
}

function makeSandbox({ launcherOnOrigin = true, anchors = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hc-launcher-')));
  const home = path.join(root, 'home');
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(home);
  fs.mkdirSync(tmp);
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const resident = path.join(root, 'resident');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, seed);
  git(seed, 'checkout', '-q', '-b', 'main');
  fs.mkdirSync(path.join(seed, 'scripts'));
  fs.mkdirSync(path.join(seed, 'node_modules/expo-camera'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'node_modules/expo-camera/shell.js'), '// tracked shell\n');
  fs.writeFileSync(path.join(seed, 'scripts/local-scrape-and-push.sh'), stubScheduler('stale-origin'), { mode: 0o755 });
  commitAll(seed, 'v1');
  git(seed, 'push', '-q', 'origin', 'main');
  git(root, 'clone', '-q', origin, resident);
  // Origin advances past the resident (v2 = current main).
  fs.writeFileSync(path.join(seed, 'scripts/local-scrape-and-push.sh'), stubScheduler('origin'), { mode: 0o755 });
  if (launcherOnOrigin) fs.copyFileSync(REAL_LAUNCHER, path.join(seed, 'scripts/scheduler-launch.sh'));
  commitAll(seed, 'v2');
  git(seed, 'push', '-q', 'origin', 'main');
  const v2 = git(seed, 'rev-parse', 'HEAD');
  // An older side commit that carries the CURRENT launcher bytes (so every blob
  // proof passes against it) but a stale scheduler — published as a branch and
  // a tag, the shape a stale HUNTERCARD_REMOTE_REF override would name.
  git(seed, 'checkout', '-q', '-b', 'stale', 'HEAD~1');
  fs.writeFileSync(path.join(seed, 'scripts/local-scrape-and-push.sh'), stubScheduler('stale-ref'), { mode: 0o755 });
  fs.copyFileSync(REAL_LAUNCHER, path.join(seed, 'scripts/scheduler-launch.sh'));
  commitAll(seed, 'stale');
  const stale = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'tag', 'stale-tag');
  git(seed, 'push', '-q', 'origin', 'stale', 'stale-tag');
  git(seed, 'checkout', '-q', 'main');
  git(resident, 'fetch', '-q', '--tags', origin, '+refs/heads/stale:refs/remotes/origin/stale');
  // The resident is dirty: locally modified scheduler + untracked residue.
  fs.writeFileSync(path.join(resident, 'scripts/local-scrape-and-push.sh'), stubScheduler('resident'), { mode: 0o755 });
  fs.writeFileSync(path.join(resident, 'notes.md'), 'personal residue\n');
  if (anchors) {
    for (const pkg of ['puppeteer', 'cheerio']) {
      fs.mkdirSync(path.join(resident, 'node_modules', pkg), { recursive: true });
      fs.writeFileSync(path.join(resident, 'node_modules', pkg, 'package.json'), `{"name":"${pkg}"}\n`);
    }
  }
  const bin = path.join(home, '.hermes/bin');
  fs.mkdirSync(bin, { recursive: true });
  const installed = path.join(bin, 'huntercard-scheduler-launch.sh');
  fs.copyFileSync(REAL_LAUNCHER, installed);
  return { root, home, tmp, origin, resident, installed, v2, stale, trace: path.join(root, 'trace.txt') };
}

function run(sb, { launcher = sb.installed, env = {} } = {}) {
  const res = spawnSync('bash', [launcher], {
    encoding: 'utf-8',
    env: {
      PATH: process.env.PATH,
      HOME: sb.home,
      TMPDIR: sb.tmp,
      HUNTERCARD_RESIDENT_DIR: sb.resident,
      TRACE_FILE: sb.trace,
      ...env,
    },
  });
  const trace = fs.existsSync(sb.trace) ? fs.readFileSync(sb.trace, 'utf-8') : '';
  const logDir = path.join(sb.home, '.hermes/logs');
  const log = fs.existsSync(logDir)
    ? fs.readdirSync(logDir).map((f) => fs.readFileSync(path.join(logDir, f), 'utf-8')).join('')
    : '';
  const kv = Object.fromEntries(trace.split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { status: res.status, stderr: res.stderr, trace, kv, log };
}

// Resident immutability: HEAD, branch, index bytes and every working-tree file.
function residentFingerprint(dir) {
  const h = createHash('sha256');
  h.update(git(dir, 'rev-parse', 'HEAD'));
  h.update(git(dir, 'symbolic-ref', 'HEAD'));
  h.update(fs.readFileSync(path.join(dir, '.git/index')));
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (d === dir && e.name === '.git') continue;
      const p = path.join(d, e.name);
      h.update(path.relative(dir, p));
      if (e.isDirectory()) walk(p);
      else h.update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}

function bootstraps(sb) {
  const parent = path.join(sb.home, '.hermes/scheduler');
  return fs.existsSync(parent) ? fs.readdirSync(parent) : [];
}

function assertNothingRan(r, sb, reason) {
  assert.equal(r.status, 1, `expected fail-closed exit 1 (${reason}); stderr=${r.stderr}`);
  assert.equal(r.trace, '', `no scheduler may run (${reason})`);
  assert.match(r.log, /HUNTERCARD_SCRAPE_STATUS=FAILED/);
  assert.deepEqual(bootstraps(sb).filter((n) => n.startsWith('huntercard-bootstrap.')), [], 'bootstrap must not survive');
}

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('A: origin committed scheduler runs from a fresh bootstrap; resident untouched', () => {
  const sb = makeSandbox();
  const before = residentFingerprint(sb.resident);
  const r = run(sb, { env: { HUNTERCARD_FORCE_ISOLATED_STAGE2: '1', HUNTERCARD_STAGE2_NONCE: 'leaked', HUNTERCARD_LAUNCHER_REEXEC: '1' } });
  assert.equal(r.status, 0, r.stderr + r.log);
  assert.equal(r.kv.who, 'origin', 'must run origin/main\'s committed scheduler, not the resident copy');
  assert.equal(r.kv.head, sb.v2);
  assert.equal(r.kv.blob, git(sb.origin, 'rev-parse', `${sb.v2}:scripts/local-scrape-and-push.sh`));
  assert.ok(r.kv.pwd.startsWith(path.join(sb.home, '.hermes/scheduler/huntercard-bootstrap.')), r.kv.pwd);
  assert.equal(r.kv.force, '1');
  assert.equal(r.kv.stage2, '');
  assert.equal(r.kv.nonce, '');
  assert.equal(r.kv.reexec, '');
  assert.equal(r.kv.remote_ref, 'refs/remotes/origin/main', 'the scheduler resolves the unambiguous fetched ref');
  assert.equal(r.kv.anchors, 'ok');
  assert.equal(r.kv.nm, fs.realpathSync(path.join(sb.resident, 'node_modules')));
  assert.equal(residentFingerprint(sb.resident), before, 'resident HEAD/index/working tree must be byte-identical');
  assert.deepEqual(bootstraps(sb), [], 'bootstrap removed after the run');
  assert.ok(!git(sb.resident, 'worktree', 'list').includes('huntercard-bootstrap.'), 'bootstrap registration pruned');
  assert.match(r.log, new RegExp(`origin/main ${sb.v2}`));
  assert.match(r.log, /not executed/);
});

test('B: scheduler exit status is propagated', () => {
  const sb = makeSandbox();
  const r = run(sb, { env: { STUB_RC: '7' } });
  assert.equal(r.status, 7);
  assert.equal(r.kv.who, 'origin');
  assert.match(r.log, /scheduler exited 7/);
  assert.deepEqual(bootstraps(sb), []);
});

test('C: drifted installed launcher re-executes origin\'s launcher', () => {
  const sb = makeSandbox();
  fs.appendFileSync(sb.installed, '# local drift\n');
  const before = residentFingerprint(sb.resident);
  const r = run(sb);
  assert.equal(r.status, 0, r.stderr + r.log);
  assert.match(r.log, /drifted from .* re-executing origin's launcher/);
  assert.equal(r.kv.who, 'origin');
  assert.equal(r.kv.reexec, '', 'launcher re-exec flag must not leak into the scheduler');
  assert.deepEqual(fs.readdirSync(sb.tmp).filter((n) => n.startsWith('huntercard-scheduler-launch.')), [], 'staged origin launcher removed');
  assert.equal(residentFingerprint(sb.resident), before);
});

test('D: origin without a committed launcher fails closed', () => {
  const sb = makeSandbox({ launcherOnOrigin: false });
  const r = run(sb);
  assertNothingRan(r, sb, 'no launcher on origin');
  assert.match(r.log, /has no committed scripts\/scheduler-launch\.sh/);
});

test('E: fetch failure fails closed', () => {
  const sb = makeSandbox();
  fs.renameSync(sb.origin, `${sb.origin}.gone`);
  const r = run(sb);
  assertNothingRan(r, sb, 'fetch failure');
  assert.match(r.log, /git fetch origin main failed/);
});

test('F: missing resident dependency anchor fails closed and removes the bootstrap', () => {
  const sb = makeSandbox({ anchors: false });
  const r = run(sb);
  assertNothingRan(r, sb, 'missing anchors');
  assert.match(r.log, /missing dependency anchor puppeteer\/package\.json/);
  assert.ok(!git(sb.resident, 'worktree', 'list').includes('huntercard-bootstrap.'));
});

test('G: a re-executed launcher that still differs from origin fails closed', () => {
  const sb = makeSandbox();
  fs.appendFileSync(sb.installed, '# local drift\n');
  // The leaked flag is stripped only AFTER a successful identity proof, so a
  // drifted copy claiming to be the re-exec must fail rather than loop.
  const r = spawnSync('bash', [sb.installed], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH, HOME: sb.home, TMPDIR: sb.tmp, HUNTERCARD_RESIDENT_DIR: sb.resident, TRACE_FILE: sb.trace, HUNTERCARD_LAUNCHER_REEXEC: '1' },
  });
  const log = fs.readdirSync(path.join(sb.home, '.hermes/logs')).map((f) => fs.readFileSync(path.join(sb.home, '.hermes/logs', f), 'utf-8')).join('');
  assert.equal(r.status, 1);
  assert.ok(!fs.existsSync(sb.trace));
  assert.match(log, /re-executed launcher .* is still not/);
});

test('H: a bootstrap leaked over a day ago is removed, a fresh one kept', () => {
  const sb = makeSandbox();
  const parent = path.join(sb.home, '.hermes/scheduler');
  const leaked = path.join(parent, 'huntercard-bootstrap.leaked');
  git(sb.resident, 'worktree', 'add', '-q', '--detach', leaked, 'HEAD');
  const old = new Date(Date.now() - 2 * 86400 * 1000);
  fs.utimesSync(leaked, old, old);
  const fresh = path.join(parent, 'huntercard-bootstrap.fresh');
  fs.mkdirSync(fresh);
  const r = run(sb);
  assert.equal(r.status, 0, r.stderr + r.log);
  assert.ok(!fs.existsSync(leaked), 'leaked bootstrap removed');
  assert.ok(!git(sb.resident, 'worktree', 'list').includes('huntercard-bootstrap.leaked'));
  assert.ok(fs.existsSync(fresh), 'a bootstrap younger than a day may belong to a live run');
});

test('I: a stale HUNTERCARD_REMOTE_REF override fails closed and never runs the stale scheduler', () => {
  for (const ref of ['stale-tag', 'origin/stale', 'stale-sha']) {
    const sb = makeSandbox();
    const before = residentFingerprint(sb.resident);
    const r = run(sb, { env: { HUNTERCARD_REMOTE_REF: ref === 'stale-sha' ? sb.stale : ref } });
    assertNothingRan(r, sb, `stale override ${ref}`);
    assert.doesNotMatch(r.trace, /stale-ref/);
    assert.match(r.log, /HUNTERCARD_REMOTE_REF=.* is refused/);
    assert.equal(residentFingerprint(sb.resident), before);
  }
});

test('J: a local tag or branch named origin/main cannot shadow the fetched ref', () => {
  for (const shadow of ['refs/tags/origin/main', 'refs/heads/origin/main']) {
    const sb = makeSandbox();
    git(sb.resident, 'update-ref', shadow, sb.stale);
    const r = run(sb);
    assert.equal(r.status, 0, r.stderr + r.log);
    assert.equal(r.kv.who, 'origin', `${shadow} must not select the stale scheduler`);
    assert.equal(r.kv.head, sb.v2);
  }
});

test('K: a missing fetch refspec and a stale origin/main still run the commit the fetch returned', () => {
  const sb = makeSandbox();
  git(sb.resident, 'config', '--unset-all', 'remote.origin.fetch');
  git(sb.resident, 'update-ref', 'refs/remotes/origin/main', sb.stale);
  const r = run(sb);
  assert.equal(r.status, 0, r.stderr + r.log);
  assert.equal(r.kv.who, 'origin');
  assert.equal(r.kv.head, sb.v2);
  assert.equal(git(sb.resident, 'rev-parse', 'refs/remotes/origin/main'), sb.v2);
});

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n    ${err.stack.split('\n').slice(0, 4).join('\n    ')}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} scheduler launcher cases passed`);
process.exit(failed ? 1 : 0);
