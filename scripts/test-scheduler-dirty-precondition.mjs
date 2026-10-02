#!/usr/bin/env node
/**
 * test-scheduler-dirty-precondition.mjs — DIC-1219 CR follow-up, extended for
 * DIC-1321.
 *
 * Runs the REAL `scripts/local-scrape-and-push.sh` inside a throwaway real git
 * repository and asserts:
 *
 *  DIC-1219 (in-place fail-closed): when the resident checkout is dirty in a
 *  scraper-managed path, the pipeline must NOT pull / mutate / stage it and
 *  must leave the residue files untouched on-disk.
 *
 *  DIC-1321 (isolated worktree handoff): a dirty worktree no longer permanently
 *  deadlocks the scheduler. Instead of aborting with no output, the pipeline
 *  routes the build into an isolated throwaway git worktree pinned to the
 *  remote HEAD, and pushes the artifact to a dedicated `bot/scrape/...` branch —
 *  the user's dirty local files are never deleted or overwritten.
 *
 *  DIC-1321 (coverage / change-budget gates): a build whose priced-cardNumber
 *  coverage collapses below the floors must FAIL the scheduler (exit non-zero)
 *  so the cron reports failure instead of pushing a 0-priced snapshot and
 *  printing Done.
 *
 *  DIC-1472 (isolated dependency readiness): the repo TRACKS a tiny
 *  node_modules shell (four expo-camera build files), so `git worktree add`
 *  materialises a node_modules DIRECTORY in every throwaway worktree while
 *  puppeteer/cheerio are absent. The scheduler must prove readiness via real
 *  anchors, replace ONLY the disposable worktree's incomplete shell with an
 *  absolute symlink to the resident install, verify the resulting target, and
 *  fail closed BEFORE pipeline mutation when provisioning cannot be proven.
 *  The sandbox mirrors the tracked shell, and the build-database shim refuses
 *  to "build" unless the anchors resolve in its cwd — reverting the fix turns
 *  every isolated-route case red with the same module-not-found shape as the
 *  real 2026-09-18 failure.
 *
 *  DIC-1472 Mac-Codex CR P1 (cases N/O/P + fingerprint): every guard branch of
 *  ensureIsolatedDeps() is now driven end-to-end on BOTH isolated routes —
 *  alias-refusal (via a probed kernel-symlink-budget alias, Case N), shell
 *  removal failure in both liar shapes (Case O), and anchors vanishing after a
 *  genuine symlink (Case P). Each fail case asserts the branch-specific
 *  reason, the HUNTERCARD_SCRAPE_STATUS=FAILED marker, and that no
 *  scrape/build/stage/commit/push ever ran. Resident immutability is proven by
 *  a deterministic recursive fingerprint of the COMPLETE sandbox resident
 *  node_modules tree (type/mode/target/size/sha256 per entry), replacing the
 *  earlier two-anchor snapshot, on the successful runs (Cases H/I/J) and the
 *  fail-closed ones where the resident must survive untouched.
 *
 * Shell shims for `node`, `npm` and a few git subcommands trace their
 * invocations to a log so we can assert ordering + that the resident checkout
 * was not mutated.
 *
 * Run: node scripts/test-scheduler-dirty-precondition.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_PIPELINE = path.join(__dirname, 'local-scrape-and-push.sh');
const REAL_GIT = execSync('command -v git', { encoding: 'utf-8' }).trim();
const REAL_NODE = execSync('command -v node', { encoding: 'utf-8' }).trim();

function writeShim(bin, name, body) {
  fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
}

// DIC-1472: the four git-TRACKED expo-camera shell files (mirrors production's
// `git ls-files node_modules`), and the real dependency anchors the scheduler
// verifies before trusting a worktree's node_modules.
const TRACKED_SHELL_FILES = [
  'useWebQRScanner.d.ts',
  'useWebQRScanner.d.ts.map',
  'useWebQRScanner.js',
  'useWebQRScanner.js.map',
];
const DEP_ANCHOR_PACKAGES = ['puppeteer', 'cheerio'];

// A real-node helper (placed OUTSIDE the shimmed bin/ so node invocations from
// the pipeline that must produce real output — the priced-cardNumber count for
// the coverage gate — bypass the shim). Counts unique priced cardNumbers in the
// db file given as argv[2].
const COUNT_HELPER = `
const d = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const s = new Set();
for (const c of Object.values(d.cards || {})) if (Number.isFinite(c.sellPrice) && c.sellPrice > 0) s.add(c.cardNumber);
process.stdout.write(String(s.size));
`;

/**
 * Materialise a sandbox: a bare remote repo + a cloned resident checkout that
 * contains the real pipeline script. The sandbox's PATH intercepts `node` /
 * `npm` invocations plus a few git subcommands that would otherwise touch the
 * network / write commits — every intercepted call appends to a trace so the
 * caller can assert whether the pipeline reached the mutation/staging steps.
 */
function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dic1321-precond-'));
  const bin = path.join(dir, 'bin');
  const remote = path.join(dir, 'remote.git');
  const repo = path.join(dir, 'repo');
  const trace = path.join(dir, 'trace.log');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(remote, { recursive: true });
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'data'), { recursive: true });
  fs.writeFileSync(trace, '');

  // Real bare remote + committed baseline so `git worktree add origin/main`
  // and push-to-branch both work realistically.
  execSync(`${REAL_GIT} init -q --bare -b main ${remote}`);
  execSync(`${REAL_GIT} init -q -b main ${repo}`);
  execSync(`${REAL_GIT} config user.email test@example.com`, { cwd: repo });
  execSync(`${REAL_GIT} config user.name test`, { cwd: repo });
  fs.writeFileSync(path.join(repo, '.gitkeep'), '');
  // DIC-1472: mirror production's dependency layout exactly. node_modules/ is
  // gitignored, but a tiny expo-camera shell (four build files) is force-added
  // and TRACKED — so every fresh worktree checkout materialises a node_modules
  // DIRECTORY that contains no real dependency.
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  const trackedShellDir = path.join(repo, 'node_modules', 'expo-camera', 'build', 'web');
  fs.mkdirSync(trackedShellDir, { recursive: true });
  for (const f of TRACKED_SHELL_FILES) {
    fs.writeFileSync(path.join(trackedShellDir, f), '// tracked expo-camera stub\n');
  }
  // A committed database.json baseline so the coverage gate has a previous
  // priced count to compare against.
  fs.mkdirSync(path.join(repo, 'data'), { recursive: true });
  const baseline = {
    lastUpdated: '2026-01-01T00:00:00.000Z',
    totalCards: 3,
    cards: {
      'hSMP-001_hSMP_C': { id: 'hSMP-001_hSMP_C', cardNumber: 'hSMP-001', sourceProduct: 'hSMP', rarity: 'C', sellPrice: 500 },
      'hSMP-002_hSMP_C': { id: 'hSMP-002_hSMP_C', cardNumber: 'hSMP-002', sourceProduct: 'hSMP', rarity: 'C', sellPrice: 600 },
      'hSMP-003_hSMP_C': { id: 'hSMP-003_hSMP_C', cardNumber: 'hSMP-003', sourceProduct: 'hSMP', rarity: 'C', sellPrice: null },
    },
  };
  fs.writeFileSync(path.join(repo, 'data', 'database.json'), `${JSON.stringify(baseline)}\n`);
  fs.writeFileSync(path.join(repo, 'scripts', 'local-scrape-and-push.sh'), fs.readFileSync(REAL_PIPELINE));
  fs.chmodSync(path.join(repo, 'scripts', 'local-scrape-and-push.sh'), 0o755);
  // Commit placeholder files for every scraper-managed path so the isolated
  // pipeline's `git add $EXISTING_DATA` (which references data/images/,
  // data/official/, public/data/database.json, docs/audits/..., etc.) NEVER
  // fails on a missing pathspec. In production all these paths exist in the
  // repo; the sandbox baseline must mirror that, or git add is atomic-fail and
  // no real artifact commit is ever created — which is exactly the no-op
  // condition Case F guards against, but which must NOT be the state of the
  // happy-path cases B/C.
  const managedPlaceholders = [
    'data/images/.gitkeep',
    'data/official/.gitkeep',
    'data/price-history/placeholder.json',
    'data/yt-subscribers/placeholder.json',
    'data/news-sentiment/placeholder.json',
    'data/trends/placeholder.json',
    'data/buy-prices/placeholder.json',
    'data/series-names.json',
    'data/yt-stats-history.json',
    'public/data/database.json',
    'docs/audits/official-catalog-audit.json',
    'docs/audits/official-production-lag-state.json',
  ];
  for (const rel of managedPlaceholders) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    // DIC-1334: public/data/database.json is the native asset whose
    // priced-cardNumber set must exactly match data/database.json (the
    // canonical/native parity gate added on this PR). A generic `{}`
    // placeholder here would always MISMATCH the canonical baseline (which
    // has 2 priced cardNumbers), tripping the parity gate even on the
    // untouched happy path. Seed it as a mirror of the canonical baseline so
    // the committed starting state already satisfies parity.
    fs.writeFileSync(abs, rel === 'public/data/database.json' ? `${JSON.stringify(baseline)}\n` : '{}');
  }
  execSync(`${REAL_GIT} add -A`, { cwd: repo });
  execSync(`${REAL_GIT} add -f node_modules/expo-camera`, { cwd: repo });
  execSync(`${REAL_GIT} -c commit.gpgsign=false commit -q -m baseline`, { cwd: repo });
  execSync(`${REAL_GIT} remote add origin ${remote}`, { cwd: repo });
  execSync(`${REAL_GIT} push -q origin main`, { cwd: repo });

  // DIC-1472: the RESIDENT checkout has a real (untracked, gitignored) npm
  // install; the readiness anchors the scheduler verifies live here.
  for (const pkg of DEP_ANCHOR_PACKAGES) {
    const pkgDir = path.join(repo, 'node_modules', pkg);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), `{"name":"${pkg}","version":"0.0.0-sandbox"}\n`);
  }

  // Node shim: trace every invocation and exit 0. The coverage-gate / prev-
  // count invocations (market marker `console.log(s.size)`) are delegated to
  // the REAL node helper so the gate reads the real priced-cardNumber count
  // from the db file. The build-database invocation rewrites the resident db to
  // a HEALTHY 2-priced snapshot (baseline had 2 priced -> coverage holds).
  // DIC-1334's canonical/native parityOk() gate also runs an inline `node -e`
  // script (marker `MISMATCH`) that must execute for real — otherwise the
  // shim swallows it, stdout is empty, and parityOk always fails closed even
  // when the committed public/data/database.json genuinely mirrors canonical.
  writeShim(bin, 'node', `#!/bin/bash
echo "node $* [cwd=$(pwd)]" >> "$TRACE_FILE"
if [[ " $* " == *"MISMATCH"* ]]; then
  exec ${REAL_NODE} "$@"
fi
if [[ " $* " == *"console.log(s.size)"* ]]; then
  # Coverage gate / prev-count call: first positional arg after -e is the db path.
  dbPath=""
  for a in "$@"; do
    if [[ "$a" == *.json ]]; then dbPath="$a"; break; fi
  done
  [ -n "$dbPath" ] && [ -f "$dbPath" ] && ${REAL_NODE} "$COUNT_HELPER_PATH" "$dbPath"
  exit 0
fi
if [[ " $* " == *"build-database.js"* ]]; then
  # DIC-1472 mutation sensor: the real build imports puppeteer + cheerio. A
  # worktree whose node_modules is only the tracked expo-camera shell (no
  # resident symlink) must fail here exactly like the real module-not-found.
  if [ ! -f "$(pwd)/node_modules/puppeteer/package.json" ] || [ ! -f "$(pwd)/node_modules/cheerio/package.json" ]; then
    echo "node build-database MODULE_NOT_FOUND (dependency anchors absent in $(pwd))" >> "$TRACE_FILE"
    exit 1
  fi
  cat > "$(pwd)/data/database.json" <<'EOF'
{"lastUpdated":"2026-01-02T00:00:00.000Z","totalCards":3,"cards":{"hSMP-001_hSMP_C":{"id":"hSMP-001_hSMP_C","cardNumber":"hSMP-001","sourceProduct":"hSMP","rarity":"C","sellPrice":500},"hSMP-002_hSMP_C":{"id":"hSMP-002_hSMP_C","cardNumber":"hSMP-002","sourceProduct":"hSMP","rarity":"C","sellPrice":600},"hSMP-003_hSMP_C":{"id":"hSMP-003_hSMP_C","cardNumber":"hSMP-003","sourceProduct":"hSMP","rarity":"C","sellPrice":null}}}
EOF
fi
exit 0
`);
  // Write the real-node count helper outside bin/ (so it bypasses the shim)
  // and expose its path to the shim via env.
  fs.writeFileSync(path.join(dir, 'count.js'), COUNT_HELPER);
  fs.writeFileSync(path.join(dir, 'node.shim.env'), '');
  writeShim(bin, 'npm', `#!/bin/bash
echo "npm $*" >> "$TRACE_FILE"
exit 0
`);

  // git wrapper: intercept every push (with or without a `-C <dir>` prefix),
  // trace and no-op it so NO real push ever hits a remote — pushes must be
  // asserted by their exact refspec, never executed. `FAIL_PUSH` lets a test
  // force a specific refspec to fail so we can prove fail-closed handoff.
  // `worktree` and everything else hit the REAL git so the dirty / isolated
  // classifiers run over the sandbox tree and the isolated worktree is
  // genuinely materialised.
  writeShim(bin, 'git', `#!/bin/bash
echo "git $*" >> "$TRACE_FILE"
# DIC-1167 (CR bced44d5): ADVANCE_ON_FETCH_N=<n> runs ADVANCE_HOOK (a real,
# untraced push from another clone) just before the n-th fetch, so origin
# can advance between the stage-1 and stage-2 fetches.
if [ "$1" = "fetch" ] && [ -n "$ADVANCE_ON_FETCH_N" ]; then
  n=$(( $(cat "$FETCH_COUNT_FILE" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$FETCH_COUNT_FILE"
  [ "$n" = "$ADVANCE_ON_FETCH_N" ] && bash "$ADVANCE_HOOK"
fi
if [[ "$*" == *" push "* ]] || [[ "$*" == "push "* ]]; then
  [ -n "$FAIL_PUSH" ] && [[ "$*" == *"$FAIL_PUSH"* ]] && exit 1
  exit 0
fi
case "$1" in
  commit)        exit 0 ;;
  worktree)      shift; exec ${REAL_GIT} worktree "$@" ;;
esac
exec ${REAL_GIT} "$@"
`);

  return { dir, bin, remote, repo, trace };
}

// The scheduler writes its log to $HOME/.hermes/logs/huntercard-scrape-<date>.log.
// HOME is pinned to the sandbox dir, so the log lands there. The script computes
// the date itself with `date +%Y%m%d`; we resolve the same path so consumers can
// assert on the exact cron log (not just the shell exit code / push trace).
function schedulerLogPath(sandbox) {
  const ymd = execSync('date +%Y%m%d', { encoding: 'utf-8' }).trim();
  return path.join(sandbox.dir, '.hermes', 'logs', `huntercard-scrape-${ymd}.log`);
}

function runSandbox(sandbox, extraEnv = {}, scriptPath = null) {
  const { bin, repo, trace, dir } = sandbox;
  const result = spawnSync('bash', [scriptPath ?? path.join(repo, 'scripts', 'local-scrape-and-push.sh')], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: sandbox.dir,
      TRACE_FILE: trace,
      COUNT_HELPER_PATH: path.join(dir, 'count.js'),
      HUNTERCARD_ISOLATED_DIR: path.join(sandbox.dir, 'iso'),
      HUNTERCARD_LOCK_FILE: path.join(sandbox.dir, 'scrape.lock'),
      ...extraEnv,
    },
    encoding: 'utf-8',
  });
  const lines = fs.readFileSync(trace, 'utf-8').split('\n').filter(Boolean);
  const logPath = schedulerLogPath(sandbox);
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
  return { status: result.status, lines, log };
}

function cleanup(sandbox) {
  fs.rmSync(sandbox.dir, { recursive: true, force: true });
}

const someTraced = (lines, needle) => lines.some((l) => l.includes(needle));

// DIC-1472 helpers ───────────────────────────────────────────────────────────

// Deterministic recursive fingerprint of the COMPLETE resident node_modules
// tree — every entry's relative path, lstat type, permission bits, symlink
// target, and (for regular files) size + sha256 of the bytes, in sorted walk
// order. This replaces the earlier two-anchor snapshot (Mac-Codex CR P1): a
// run that mutates ANY resident dependency byte, adds or deletes ANY entry,
// or swaps a file for a link — not just one that rewrites the two anchor
// package.jsons — must change the fingerprint. Timestamps are deliberately
// excluded: merely reading resident files during a run is not mutation.
function residentTreeFingerprint(sandbox) {
  const root = path.join(sandbox.repo, 'node_modules');
  const entries = [];
  const walk = (rel) => {
    const abs = rel ? path.join(root, rel) : root;
    const st = fs.lstatSync(abs);
    const mode = (st.mode & 0o7777).toString(8);
    if (st.isSymbolicLink()) {
      entries.push(`${rel || '.'} link ${fs.readlinkSync(abs)}`);
    } else if (st.isDirectory()) {
      entries.push(`${rel || '.'} dir ${mode}`);
      for (const name of fs.readdirSync(abs).sort()) walk(rel ? `${rel}/${name}` : name);
    } else {
      const sha = createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
      entries.push(`${rel || '.'} file ${mode} ${st.size} ${sha}`);
    }
  };
  walk('');
  return entries.join('\n');
}

// Snapshot the resident checkout's mutable identity before a run so
// assertResidentUntouched can prove immutability afterwards.
function takeResidentSnapshot(sandbox) {
  return {
    head: execSync(`${REAL_GIT} rev-parse HEAD`, { cwd: sandbox.repo, encoding: 'utf-8' }).trim(),
    fingerprint: residentTreeFingerprint(sandbox),
  };
}

function assertResidentUntouched(sandbox, snapshot) {
  const headAfter = execSync(`${REAL_GIT} rev-parse HEAD`, { cwd: sandbox.repo, encoding: 'utf-8' }).trim();
  assert.equal(headAfter, snapshot.head, 'resident HEAD must not move');
  assert.ok(
    !fs.lstatSync(path.join(sandbox.repo, 'node_modules')).isSymbolicLink(),
    'resident node_modules must remain a real directory, never be replaced by a link',
  );
  assert.equal(
    residentTreeFingerprint(sandbox),
    snapshot.fingerprint,
    'resident node_modules recursive fingerprint must be byte-identical after the run (no entry added, removed, rewritten, re-moded, or re-linked)',
  );
}

// Shared fail-closed contract for every dependency-provisioning failure
// (Mac-Codex CR P1): the scheduler must exit 1, its own log must carry BOTH
// the exact branch-specific reason and the HUNTERCARD_SCRAPE_STATUS=FAILED
// marker the cron watches, and the trace must show that no scraper ran, the
// build never started, and nothing was staged, committed, or pushed.
function assertFailedClosedNoMutation(route, { status, lines, log }, reasonRe) {
  assert.equal(status, 1, `${route}: provisioning failure must fail the scheduler; got ${status}\n${log}`);
  assert.match(log, reasonRe, `${route}: scheduler log must carry the exact fail-closed reason ${reasonRe}`);
  assert.match(log, /HUNTERCARD_SCRAPE_STATUS=FAILED/, `${route}: cron must observe the FAILED marker`);
  assert.equal(someTraced(lines, 'scrape-official-cards.js'), false, `${route}: must fail BEFORE any scraper runs`);
  assert.equal(someTraced(lines, 'build-database.js'), false, `${route}: must fail BEFORE the build runs`);
  assert.equal(
    lines.some((l) => /^git (-C \S+ )?(-c \S+ )*add /.test(l)),
    false,
    `${route}: must not stage anything`,
  );
  assert.equal(someTraced(lines, ' commit '), false, `${route}: must not commit anything`);
  assert.equal(someTraced(lines, 'push origin'), false, `${route}: must not push anything`);
}

// Case N machinery: the alias-refusal guard compares inodes (`-ef`), and any
// plain aliased node_modules that exposes the resident anchors would take the
// already-ready branch before the guard. The ONE deterministic filesystem
// state that reaches the guard end-to-end is the kernel's per-resolution
// symlink budget (SYMLOOP_MAX: 32 on macOS, 40 on Linux — probed here, never
// hard-coded): a chain of exactly <budget> links ending at the resident
// install resolves for `-e` / `-ef` (the guard sees the resident inode), while
// each anchor's own symlinked package.json costs one more link, so the
// readiness probe deterministically fails with ELOOP. Requires the caller to
// have converted the resident anchors to per-package symlinks first.
function buildAliasChain(sandbox) {
  const target = path.join(sandbox.repo, 'node_modules');
  const chainDir = path.join(sandbox.dir, 'alias-chain');
  fs.mkdirSync(chainDir, { recursive: true });
  // Every chain hop uses a RELATIVE target (c(i) -> c(i-1) in the same dir,
  // c1 -> ../repo/node_modules): an absolute target would re-traverse any
  // symlinked path-prefix component on every hop (macOS tmpdirs live under
  // /var -> private/var), which changes the per-hop cost and breaks the
  // budget arithmetic. With relative targets each hop costs exactly one link,
  // so the probed maximum n satisfies prefix-cost + n = kernel budget for
  // whatever the prefix costs, and one extra link is ALWAYS over the budget.
  const links = [];
  let budget = 0;
  for (let i = 1; i <= 64; i += 1) {
    const link = path.join(chainDir, `c${i}`);
    fs.symlinkSync(i === 1 ? path.relative(chainDir, target) : `c${i - 1}`, link);
    links.push(link);
    try {
      fs.statSync(link); // prefix cost + exactly i chain links
      budget = i;
    } catch {
      break;
    }
  }
  assert.ok(budget >= 4 && budget < 64, `kernel symlink-budget probe out of expected range: ${budget}`);
  const atBudget = links[budget - 1];
  // Sanity for the exact asymmetry Case N relies on: at the budget boundary
  // the DIRECTORY resolves but the symlinked anchor beneath it does not,
  // while the resident anchor resolves directly.
  fs.statSync(atBudget);
  assert.throws(
    () => fs.statSync(path.join(atBudget, 'puppeteer', 'package.json')),
    'sanity: anchor resolution through a budget-exact chain must exceed the kernel symlink budget',
  );
  fs.statSync(path.join(target, 'puppeteer', 'package.json'));
  // The scheduler-side `ln -s` of the worktree's node_modules adds one
  // traversal, so hand back a RELATIVE target one link BELOW the budget:
  // iso node_modules -> ../alias-chain/c(budget-1) makes resolving the
  // directory cost exactly the budget while every anchor probe exceeds it.
  return path.relative(path.join(sandbox.dir, 'iso'), links[budget - 2]);
}

// node_modules must NEVER be staged or committed: no traced `git add` may
// mention it, and every isolated artifact commit (unreachable in the shared
// object store after the throwaway worktree is removed — the handoff push is
// shimmed) must carry only scraper-managed paths.
function assertNoNodeModulesStagedOrCommitted(sandbox, lines) {
  for (const l of lines.filter((x) => /^git (-C \S+ )?(-c \S+ )*add /.test(x))) {
    assert.ok(!l.includes('node_modules'), `node_modules must never be staged; traced: ${l}`);
  }
  const unreachable = execSync(`${REAL_GIT} fsck --unreachable --no-reflogs`, { cwd: sandbox.repo, encoding: 'utf-8' })
    .split('\n')
    .filter((l) => l.startsWith('unreachable commit '))
    .map((l) => l.trim().split(/\s+/)[2]);
  assert.ok(
    unreachable.length >= 1,
    'expected the isolated artifact commit to exist in the object store (unreachable after worktree removal)',
  );
  for (const sha of unreachable) {
    const files = execSync(`${REAL_GIT} show --name-only --format= ${sha}`, { cwd: sandbox.repo, encoding: 'utf-8' })
      .split('\n')
      .filter(Boolean);
    assert.ok(
      files.every((f) => !f.startsWith('node_modules')),
      `artifact commit ${sha} must not contain node_modules paths; got:\n${files.join('\n')}`,
    );
    assert.ok(files.includes('data/database.json'), `artifact commit ${sha} must carry the managed db artifact`);
  }
}

// ─── Case A: clean worktree — in-place pipeline reaches pull + the scraper ──
{
  const sandbox = makeSandbox();
  try {
    const { status, lines } = runSandbox(sandbox);
    assert.equal(status, 0, `clean worktree must exit 0; got ${status}`);
    assert.ok(someTraced(lines, 'git pull'), 'clean worktree must reach git pull');
    assert.ok(someTraced(lines, 'build-database.js'), 'clean worktree must reach build-database.js');
  } finally {
    cleanup(sandbox);
  }
}

// ─── Case B: untracked residue under data/price-history/ — DIC-1321 ─────────
// The scheduler must NOT mutate the resident dirty files, but must hand the
// build off to an isolated worktree (no longer a permanent deadlock). The
// residue file must remain untouched on-disk.
{
  const sandbox = makeSandbox();
  const residue = path.join(sandbox.repo, 'data', 'price-history', 'hFOO-001_hBAR_C.json');
  fs.mkdirSync(path.dirname(residue), { recursive: true });
  fs.writeFileSync(residue, JSON.stringify({ cardId: 'user-private', records: [] }));
  try {
    const { status, lines } = runSandbox(sandbox);
    // DIC-1321: dirty no longer aborts with "no output" — it routes to an
    // isolated worktree handoff. Exit 0 is the happy handoff completion.
    assert.equal(status, 0, `dirty worktree isolated handoff should complete cleanly; got ${status}`);
    // Resident checkout must NOT be mutated: pull must not run in the resident
    // repo, and no node scraper may run in the resident tree.
    assert.equal(someTraced(lines, 'git pull'), false, 'dirty resident must not run git pull');
    // The isolated path calls git worktree add (traced) and pushes ONLY the
    // auditable bot/scrape/<date> artifact branch — it must never push HEAD:main
    // from dirty-tree isolation (Mac-Codex CR DIC-1326: exact refspec, not a
    // generic "some push occurred").
    assert.ok(someTraced(lines, 'git worktree'), 'dirty path must create an isolated worktree');
    assert.ok(someTraced(lines, 'HEAD:refs/heads/bot/scrape'), 'isolated handoff must push the bot/scrape artifact branch');
    assert.equal(
      someTraced(lines, 'HEAD:main'),
      false,
      'dirty-tree isolated path must NEVER push HEAD:main',
    );
    // The residue file must still exist untouched.
    assert.ok(fs.existsSync(residue), 'residue file must remain untouched on-disk');
    const stillUntracked = execSync(`${REAL_GIT} status --porcelain -- data/price-history`, { cwd: sandbox.repo, encoding: 'utf-8' });
    assert.ok(stillUntracked.includes('?? data/price-history/'), `residue must still be untracked; got: ${stillUntracked}`);
  } finally {
    cleanup(sandbox);
  }
}

// ─── Case C: staged residue — resident stays untouched, isolated handoff ────
{
  const sandbox = makeSandbox();
  const residue = path.join(sandbox.repo, 'data', 'price-history', 'hSTAGED-001_hFOO_C.json');
  fs.mkdirSync(path.dirname(residue), { recursive: true });
  fs.writeFileSync(residue, '{}');
  execSync(`${REAL_GIT} add data/price-history/hSTAGED-001_hFOO_C.json`, { cwd: sandbox.repo });
  try {
    const { status, lines } = runSandbox(sandbox);
    assert.equal(status, 0, `staged residue isolated handoff; got ${status}`);
    assert.equal(someTraced(lines, 'git pull'), false, 'staged residue must not run pull on resident');
    assert.ok(someTraced(lines, 'git worktree'), 'staged residue must use isolated worktree');
    const stillStaged = execSync(`${REAL_GIT} status --porcelain -- data/price-history`, { cwd: sandbox.repo, encoding: 'utf-8' });
    assert.ok(stillStaged.includes('A  data/price-history/'), `residue must still be staged; got: ${stillStaged}`);
  } finally {
    cleanup(sandbox);
  }
}

// ─── Case D: clean worktree but COLLAPSED build coverage — DIC-1321 gate ────
// Force the simulated build to produce 0 priced cardNumbers (a full collapse)
// and assert the scheduler exits non-zero (cron never reports success / never
// pushes a 0-priced snapshot).
{
  const sandbox = makeSandbox();
  // Override the node shim so build-database produces 0 priced cardNumbers
  // (a full collapse), while the coverage-gate count still reads the real db.
  writeShim(sandbox.bin, 'node', `#!/bin/bash
echo "node $*" >> "$TRACE_FILE"
if [[ " $* " == *"MISMATCH"* ]]; then
  exec ${REAL_NODE} "$@"
fi
if [[ " $* " == *"console.log(s.size)"* ]]; then
  dbPath=""
  for a in "$@"; do
    if [[ "$a" == *.json ]]; then dbPath="$a"; break; fi
  done
  [ -n "$dbPath" ] && [ -f "$dbPath" ] && ${REAL_NODE} "$COUNT_HELPER_PATH" "$dbPath"
  exit 0
fi
if [[ " $* " == *"build-database.js"* ]]; then
  cat > "$(pwd)/data/database.json" <<'EOF'
{"lastUpdated":"2026-01-02T00:00:00.000Z","totalCards":3,"cards":{"hSMP-001_hSMP_C":{"id":"hSMP-001_hSMP_C","cardNumber":"hSMP-001","sourceProduct":"hSMP","rarity":"C","sellPrice":null},"hSMP-002_hSMP_C":{"id":"hSMP-002_hSMP_C","cardNumber":"hSMP-002","sourceProduct":"hSMP","rarity":"C","sellPrice":null},"hSMP-003_hSMP_C":{"id":"hSMP-003_hSMP_C","cardNumber":"hSMP-003","sourceProduct":"hSMP","rarity":"C","sellPrice":null}}}
EOF
fi
exit 0
`);
  try {
    const { status } = runSandbox(sandbox);
    // 2 priced -> 0 priced is a 100% collapse: the coverage/change-budget gate
    // must fail the scheduler so the cron reports failure (non-zero exit).
    assert.equal(status, 1, `coverage collapse must fail the scheduler; got ${status}`);
  } finally {
    cleanup(sandbox);
  }
}

// ─── Case E: red-before-green (Mac-Codex CR DIC-1326): a failed isolated
//        artifact-branch handoff push must FAIL CLOSED — never "Done"/exit 0 ──
{
  const sandbox = makeSandbox();
  const residue = path.join(sandbox.repo, 'data', 'price-history', 'hFOO-002_hBAR_C.json');
  fs.mkdirSync(path.dirname(residue), { recursive: true });
  fs.writeFileSync(residue, '{}');
  try {
    const { status, lines } = runSandbox(sandbox, { FAIL_PUSH: 'HEAD:refs/heads/bot/scrape' });
    assert.equal(
      status,
      1,
      `a failed isolated handoff push must fail the scheduler (fail-closed), not exit 0; got ${status}`,
    );
    assert.equal(
      someTraced(lines, 'HEAD:main'),
      false,
      'isolated path must never fall back to pushing HEAD:main even when the handoff fails',
    );
    assert.ok(
      someTraced(lines, 'HEAD:refs/heads/bot/scrape'),
      'sanity: the isolated handoff push must actually be attempted so we can prove it fails closed',
    );
  } finally {
    cleanup(sandbox);
  }
}

// ─── Case F: red-before-green no-op (Mac-Codex CR DIC-1328): dirty worktree
//        where the pipeline produces IDENTICAL data to the baseline (no data
//        change → runPipeline skips commit → isolated worktree HEAD is unchanged
//        from the starting SHA). The scheduler MUST exit 1, report FAILED, and
//        NEVER push the unchanged origin/main baseline to bot/scrape/<date>.
{
  const sandbox = makeSandbox();
  const residue = path.join(sandbox.repo, 'data', 'price-history', 'hFOO-003_hBAR_C.json');
  fs.mkdirSync(path.dirname(residue), { recursive: true });
  fs.writeFileSync(residue, '{}');
  // Override the node shim so build-database produces EXACTLY the same data as
  // the committed baseline — no diff, no commit, no artifact change.
  writeShim(sandbox.bin, 'node', `#!/bin/bash
echo "node $*" >> "$TRACE_FILE"
if [[ " $* " == *"MISMATCH"* ]]; then
  exec ${REAL_NODE} "$@"
fi
if [[ " $* " == *"console.log(s.size)"* ]]; then
  dbPath=""
  for a in "$@"; do
    if [[ "$a" == *.json ]]; then dbPath="$a"; break; fi
  done
  [ -n "$dbPath" ] && [ -f "$dbPath" ] && ${REAL_NODE} "$COUNT_HELPER_PATH" "$dbPath"
  exit 0
fi
if [[ " $* " == *"build-database.js"* ]]; then
  cat > "$(pwd)/data/database.json" <<'EOF'
{"lastUpdated":"2026-01-01T00:00:00.000Z","totalCards":3,"cards":{"hSMP-001_hSMP_C":{"id":"hSMP-001_hSMP_C","cardNumber":"hSMP-001","sourceProduct":"hSMP","rarity":"C","sellPrice":500},"hSMP-002_hSMP_C":{"id":"hSMP-002_hSMP_C","cardNumber":"hSMP-002","sourceProduct":"hSMP","rarity":"C","sellPrice":600},"hSMP-003_hSMP_C":{"id":"hSMP-003_hSMP_C","cardNumber":"hSMP-003","sourceProduct":"hSMP","rarity":"C","sellPrice":null}}}
EOF
fi
exit 0
`);
  try {
    const { status, lines, log } = runSandbox(sandbox);
    // Pipeline was a no-op: identical data → no commit → scheduler must fail.
    assert.equal(
      status,
      1,
      `no-op dirty-worktree pipeline must fail (exit 1) — must never push unchanged baseline; got ${status}`,
    );
    // The cron must observe the exact FAILED marker in the scheduler's own log,
    // not just a non-zero shell exit. A mutation that drops the marker (or
    // flips the script to "Done") must fail this case (Mac-Codex CR DIC-1329).
    assert.match(
      log,
      /HUNTERCARD_SCRAPE_STATUS=FAILED/,
      'no-op dirty-worktree pipeline must record HUNTERCARD_SCRAPE_STATUS=FAILED in the scheduler log, not report success',
    );
    // Must NEVER push to bot/scrape or HEAD:main when there is no artifact.
    assert.equal(
      someTraced(lines, 'HEAD:refs/heads/bot/scrape'),
      false,
      'no-op pipeline must not push an unchanged baseline to bot/scrape',
    );
    assert.equal(
      someTraced(lines, 'HEAD:main'),
      false,
      'no-op pipeline must never push HEAD:main',
    );
  } finally {
    cleanup(sandbox);
  }
}

// ─── Case G: stale registered isolated worktree — DIC-1167 2026-09-14 ───────
// A supervised timeout can leave /tmp/huntercard-scrape-worktree registered in
// .git/worktrees while its checkout/gitdir is gone. The dirty-resident handoff
// must prune/remove that stale registration before `git worktree add`, or the
// scheduler fails before scraping/building/pushing.
{
  const sandbox = makeSandbox();
  const staleIso = path.join(sandbox.dir, 'iso');
  const residue = path.join(sandbox.repo, 'data', 'price-history', 'hSTALE-001_hFOO_C.json');
  fs.mkdirSync(path.dirname(residue), { recursive: true });
  fs.writeFileSync(residue, '{}');
  execSync(`${REAL_GIT} worktree add --detach ${staleIso} HEAD >/dev/null`, { cwd: sandbox.repo });
  fs.rmSync(staleIso, { recursive: true, force: true });
  const redBeforeGreen = spawnSync(REAL_GIT, ['-C', sandbox.repo, 'worktree', 'add', '--detach', staleIso, 'HEAD'], {
    encoding: 'utf-8',
  });
  assert.notEqual(redBeforeGreen.status, 0, 'sanity: stale registered missing worktree must make raw git worktree add fail');
  assert.match(
    `${redBeforeGreen.stdout}\n${redBeforeGreen.stderr}`,
    /missing but already registered worktree/,
    'sanity: raw failure must be the stale-registration defect this regression covers',
  );

  try {
    const { status, lines, log } = runSandbox(sandbox, { HUNTERCARD_ISOLATED_DIR: staleIso });
    assert.equal(status, 0, `stale registered isolated worktree must self-recover and complete; got ${status}\n${log}`);
    assert.ok(someTraced(lines, 'git worktree prune'), 'scheduler must prune stale worktree registrations before retrying add');
    assert.ok(someTraced(lines, 'git worktree add'), 'scheduler must still create a fresh isolated worktree after pruning');
    assert.ok(someTraced(lines, 'HEAD:refs/heads/bot/scrape'), 'recovered isolated handoff must push the bot/scrape artifact branch');
    assert.equal(someTraced(lines, 'HEAD:main'), false, 'recovered isolated path must never push HEAD:main');
  } finally {
    cleanup(sandbox);
  }
}

// ─── Case G: clean worktree but DIVERGENT native asset — DIC-1334 gate ──────
// (mutation-sensitive regression: this must fail before the CI-harness fix in
// this PR — the parityOk() `node -e` invocation was silently swallowed by the
// node shim, so the gate never really ran real parity checks under test — and
// must pass after it, proving the harness now genuinely exercises parityOk().)
// Seed a committed public/data/database.json that has already gone stale
// relative to the canonical baseline (missing one previously-priced
// cardNumber), then let build-database rebuild the SAME 2-priced canonical as
// every other happy-path case. The canonical/native parity gate must detect
// the divergence and fail closed — never push a divergent pair.
{
  const sandbox = makeSandbox();
  const staleNative = {
    lastUpdated: '2026-01-01T00:00:00.000Z',
    totalCards: 3,
    cards: {
      'hSMP-001_hSMP_C': { id: 'hSMP-001_hSMP_C', cardNumber: 'hSMP-001', sourceProduct: 'hSMP', rarity: 'C', sellPrice: 500 },
      // hSMP-002 (priced 600 in canonical) is missing here — a stale/drifted
      // native export that never picked up the second priced card.
      'hSMP-003_hSMP_C': { id: 'hSMP-003_hSMP_C', cardNumber: 'hSMP-003', sourceProduct: 'hSMP', rarity: 'C', sellPrice: null },
    },
  };
  fs.writeFileSync(path.join(sandbox.repo, 'public', 'data', 'database.json'), `${JSON.stringify(staleNative)}\n`);
  // Commit the drift so the worktree stays clean (in-place dispatch path) —
  // this case targets the parity gate, not the dirty-worktree handoff.
  execSync(`${REAL_GIT} add public/data/database.json`, { cwd: sandbox.repo });
  execSync(`${REAL_GIT} -c commit.gpgsign=false commit -q -m "stale native drift"`, { cwd: sandbox.repo });
  execSync(`${REAL_GIT} push -q origin main`, { cwd: sandbox.repo });
  try {
    const { status, lines, log } = runSandbox(sandbox);
    assert.equal(
      status,
      1,
      `divergent canonical/native parity must fail the scheduler (fail-closed), not exit 0; got ${status}`,
    );
    assert.match(
      log,
      /canonical\/native parity gate FAILED/,
      'divergent parity must record the parity-gate FAILED reason in the scheduler log',
    );
    assert.equal(someTraced(lines, 'HEAD:main'), false, 'divergent parity must never push HEAD:main');
    assert.equal(someTraced(lines, 'HEAD:refs/heads/bot/scrape'), false, 'divergent parity must never push an isolated artifact branch either');
  } finally {
    cleanup(sandbox);
  }
}

// ─── Case H (DIC-1472): forced-isolated two-stage bootstrap must PROVISION
// dependencies via the anchor contract. `git worktree add` materialises the
// TRACKED node_modules shell, so directory existence is a lie; the scheduler
// must replace only that disposable shell with an absolute symlink to the
// resident install, run stage 2 inside the worktree pinned to the CURRENT
// origin/main SHA, and hand off via the fully-qualified dated refspec.
// Mutation sensor: the build shim exits 1 unless both anchors resolve in its
// cwd, so reverting ensureIsolatedDeps() turns this red with the same
// module-not-found shape as the real 2026-09-18 forced-isolated failure.
{
  const sandbox = makeSandbox();
  const isoDir = path.join(sandbox.dir, 'iso');
  const remoteHead = execSync(`${REAL_GIT} rev-parse origin/main`, { cwd: sandbox.repo, encoding: 'utf-8' }).trim();
  const snapshot = takeResidentSnapshot(sandbox);
  try {
    const { status, lines, log } = runSandbox(sandbox, { HUNTERCARD_FORCE_ISOLATED: '1' });
    assert.equal(status, 0, `forced-isolated bootstrap over the tracked shell must complete; got ${status}\n${log}`);
    // Stage 1 pinned the ephemeral worktree to the freshly fetched origin SHA.
    assert.ok(
      someTraced(lines, `git worktree add --detach ${isoDir} ${remoteHead}`),
      'stage 1 must create the ephemeral worktree at the CURRENT origin/main SHA',
    );
    // The incomplete tracked shell was replaced with the resident symlink and
    // the resulting target re-verified.
    assert.match(log, /replacing with absolute symlink to resident install/, 'deps helper must replace the tracked shell');
    assert.match(log, /✅ deps: isolated node_modules -> /, 'deps helper must verify the final link target + anchors');
    // Two-stage execution: the pipeline build ran INSIDE the ephemeral
    // worktree (stage 2 = the worktree's own copy of the script), never in
    // the resident checkout.
    const buildLine = lines.find((l) => l.includes('build-database.js'));
    assert.ok(
      buildLine && buildLine.includes(`[cwd=${isoDir}`),
      `stage 2 build must execute inside the ephemeral worktree; got: ${buildLine}`,
    );
    assert.match(log, /Done \(forced-isolated bootstrap\)/, 'stage 1 must only report Done after stage 2 succeeded');
    // Fully-qualified dated handoff refspec; never HEAD:main.
    const today = execSync('date +%Y-%m-%d', { encoding: 'utf-8' }).trim();
    assert.ok(
      someTraced(lines, `push origin HEAD:refs/heads/bot/scrape/${today}`),
      'forced-isolated handoff must push the fully-qualified dated bot/scrape refspec',
    );
    assert.equal(someTraced(lines, 'HEAD:main'), false, 'forced-isolated path must never push HEAD:main');
    assertNoNodeModulesStagedOrCommitted(sandbox, lines);
    assertResidentUntouched(sandbox, snapshot);
  } finally {
    cleanup(sandbox);
  }
}

// ─── Case I (DIC-1472): dirty-isolated route — tracked-shell replacement.
// Same contract as Case H on the dirty-resident handoff route: the worktree's
// checked-out shell is replaced by the resident symlink, the build runs in
// the worktree, resident files (tracked shell + untracked real install +
// residue) stay byte-identical, and node_modules is never staged/committed.
{
  const sandbox = makeSandbox();
  const isoDir = path.join(sandbox.dir, 'iso');
  const residue = path.join(sandbox.repo, 'data', 'price-history', 'hDIC1472-001_hFOO_C.json');
  fs.mkdirSync(path.dirname(residue), { recursive: true });
  fs.writeFileSync(residue, '{"cardId":"user-private"}');
  const snapshot = takeResidentSnapshot(sandbox);
  try {
    const { status, lines, log } = runSandbox(sandbox);
    assert.equal(status, 0, `dirty-isolated handoff over the tracked shell must complete; got ${status}\n${log}`);
    assert.match(log, /replacing with absolute symlink to resident install/, 'deps helper must replace the tracked shell');
    assert.match(log, /✅ deps: isolated node_modules -> /, 'deps helper must verify the final link target + anchors');
    const buildLine = lines.find((l) => l.includes('build-database.js'));
    assert.ok(
      buildLine && buildLine.includes(`[cwd=${isoDir}`),
      `pipeline build must execute inside the isolated worktree; got: ${buildLine}`,
    );
    const today = execSync('date +%Y-%m-%d', { encoding: 'utf-8' }).trim();
    assert.ok(
      someTraced(lines, `push origin HEAD:refs/heads/bot/scrape/${today}`),
      'dirty-isolated handoff must push the fully-qualified dated bot/scrape refspec',
    );
    assert.equal(someTraced(lines, 'HEAD:main'), false, 'dirty-isolated path must never push HEAD:main');
    assertNoNodeModulesStagedOrCommitted(sandbox, lines);
    assertResidentUntouched(sandbox, snapshot);
    assert.equal(fs.readFileSync(residue, 'utf-8'), '{"cardId":"user-private"}', 'residue must stay byte-identical');
  } finally {
    cleanup(sandbox);
  }
}

// ─── Case J (DIC-1472): already-ready dependencies are kept untouched.
// When the worktree checkout itself satisfies every anchor (here: the anchor
// files are committed, so `git worktree add` materialises a complete tree),
// the helper must take the ready branch — no shell removal, no symlink — and
// the pipeline must still complete. A helper that blindly replaces ready
// deps (or re-links over them) logs the replacement line and turns this red.
{
  const sandbox = makeSandbox();
  execSync(
    `${REAL_GIT} add -f ${DEP_ANCHOR_PACKAGES.map((p) => `node_modules/${p}/package.json`).join(' ')}`,
    { cwd: sandbox.repo },
  );
  execSync(`${REAL_GIT} -c commit.gpgsign=false commit -q -m "tracked complete deps"`, { cwd: sandbox.repo });
  execSync(`${REAL_GIT} push -q origin main`, { cwd: sandbox.repo });
  const residue = path.join(sandbox.repo, 'data', 'price-history', 'hDIC1472-002_hFOO_C.json');
  fs.mkdirSync(path.dirname(residue), { recursive: true });
  fs.writeFileSync(residue, '{}');
  const snapshot = takeResidentSnapshot(sandbox);
  try {
    const { status, lines, log } = runSandbox(sandbox);
    assert.equal(status, 0, `already-ready worktree deps must pass straight through; got ${status}\n${log}`);
    assert.match(log, /already satisfies required anchors/, 'deps helper must report the ready branch');
    assert.doesNotMatch(
      log,
      /replacing with absolute symlink to resident install/,
      'ready deps must NOT be removed or replaced',
    );
    assert.ok(someTraced(lines, 'HEAD:refs/heads/bot/scrape'), 'ready-deps handoff must still push the artifact branch');
    assertResidentUntouched(sandbox, snapshot);
  } finally {
    cleanup(sandbox);
  }
}

// ─── Case K (DIC-1472): missing resident anchor must fail closed BEFORE any
// pipeline mutation, on BOTH isolated routes. The worktree shell is
// incomplete AND the resident install lacks puppeteer — there is nothing safe
// to link, so the scheduler must exit 1 with the FAILED marker, without
// running any scraper/build step and without pushing anything.
for (const forced of [false, true]) {
  const sandbox = makeSandbox();
  fs.rmSync(path.join(sandbox.repo, 'node_modules', 'puppeteer'), { recursive: true, force: true });
  if (!forced) {
    const residue = path.join(sandbox.repo, 'data', 'price-history', 'hDIC1472-003_hFOO_C.json');
    fs.mkdirSync(path.dirname(residue), { recursive: true });
    fs.writeFileSync(residue, '{}');
  }
  const snapshot = takeResidentSnapshot(sandbox);
  try {
    const res = runSandbox(sandbox, forced ? { HUNTERCARD_FORCE_ISOLATED: '1' } : {});
    const route = forced ? 'forced-isolated' : 'dirty-isolated';
    assertFailedClosedNoMutation(route, res, /missing required anchor puppeteer\/package\.json/);
    assertResidentUntouched(sandbox, snapshot);
  } finally {
    cleanup(sandbox);
  }
}

// ─── Case L (DIC-1472): symlink creation failure must fail closed. The shell
// was removed but `ln -s` fails — the scheduler must exit 1 before any
// pipeline mutation instead of running with a half-provisioned worktree.
{
  const sandbox = makeSandbox();
  writeShim(sandbox.bin, 'ln', `#!/bin/bash
echo "ln $*" >> "$TRACE_FILE"
exit 1
`);
  const residue = path.join(sandbox.repo, 'data', 'price-history', 'hDIC1472-004_hFOO_C.json');
  fs.mkdirSync(path.dirname(residue), { recursive: true });
  fs.writeFileSync(residue, '{}');
  const snapshot = takeResidentSnapshot(sandbox);
  try {
    const res = runSandbox(sandbox);
    assert.ok(someTraced(res.lines, 'ln -s'), 'sanity: the symlink attempt must actually have been made');
    assertFailedClosedNoMutation('dirty-isolated', res, /could not create node_modules symlink/);
    assertResidentUntouched(sandbox, snapshot);
  } finally {
    cleanup(sandbox);
  }
}

// ─── Case M (DIC-1472): unsafe symlink target must fail closed. The link
// lands somewhere OTHER than the resident install (here: a decoy that even
// carries valid anchors, so only the resolved-target verification — not the
// anchor check — can catch it). The scheduler must refuse to build on it.
{
  const sandbox = makeSandbox();
  const decoy = path.join(sandbox.dir, 'decoy-node_modules');
  for (const pkg of DEP_ANCHOR_PACKAGES) {
    fs.mkdirSync(path.join(decoy, pkg), { recursive: true });
    fs.writeFileSync(path.join(decoy, pkg, 'package.json'), `{"name":"${pkg}","version":"0.0.0-decoy"}\n`);
  }
  writeShim(sandbox.bin, 'ln', `#!/bin/bash
echo "ln $*" >> "$TRACE_FILE"
for a in "$@"; do link="$a"; done
exec /bin/ln -s "$DECOY_DIR" "$link"
`);
  const residue = path.join(sandbox.repo, 'data', 'price-history', 'hDIC1472-005_hFOO_C.json');
  fs.mkdirSync(path.dirname(residue), { recursive: true });
  fs.writeFileSync(residue, '{}');
  const snapshot = takeResidentSnapshot(sandbox);
  try {
    const res = runSandbox(sandbox, { DECOY_DIR: decoy });
    assertFailedClosedNoMutation('dirty-isolated', res, /unsafe target, failing closed/);
    assertResidentUntouched(sandbox, snapshot);
  } finally {
    cleanup(sandbox);
  }
}

// ─── Case N (DIC-1472 CR P1): alias-refusal. ensureIsolatedDeps() must REFUSE
// to remove the isolated node_modules when it is `-ef` the resident install —
// removing a true alias would destroy the resident dependency tree. Any plain
// alias that exposes the resident anchors takes the already-ready branch
// before the guard, so this case drives the guard through the one
// deterministic state that reaches it (see buildAliasChain): a budget-exact
// symlink chain to the resident install plus per-package symlinked anchors —
// `-e`/`-ef` see the resident inode while every anchor probe fails with
// ELOOP, exactly the not-ready-but-aliased race the guard defends against.
// Mutation sensor: delete the guard and the run degenerates to
// remove-link → relink → re-verify, which SUCCEEDS (exit 0 + bot/scrape
// push) — turning the fail-closed assertions below red.
for (const forced of [false, true]) {
  const sandbox = makeSandbox();
  const route = forced ? 'forced-isolated' : 'dirty-isolated';
  // Per-package symlinked anchors (mirrors symlink-provisioned resident
  // installs): resolving each anchor costs one extra link.
  for (const pkg of DEP_ANCHOR_PACKAGES) {
    const pkgDir = path.join(sandbox.repo, 'node_modules', pkg);
    fs.renameSync(path.join(pkgDir, 'package.json'), path.join(pkgDir, 'package.real.json'));
    fs.symlinkSync('package.real.json', path.join(pkgDir, 'package.json'));
  }
  const chainTarget = buildAliasChain(sandbox);
  // git shim with a post-`worktree add` hook: swap the fresh worktree's
  // checked-out tracked shell for the budget-exact alias chain BEFORE
  // ensureIsolatedDeps sees it. Everything else matches the default shim.
  writeShim(sandbox.bin, 'git', `#!/bin/bash
echo "git $*" >> "$TRACE_FILE"
if [[ "$*" == *" push "* ]] || [[ "$*" == "push "* ]]; then
  exit 0
fi
case "$1" in
  commit) exit 0 ;;
  worktree)
    shift
    ${REAL_GIT} worktree "$@"
    rc=$?
    if [ "$rc" -eq 0 ] && [ "$1" = "add" ] && [ -n "$ALIAS_CHAIN_TARGET" ] && [ -d "$HUNTERCARD_ISOLATED_DIR" ]; then
      /bin/rm -rf "$HUNTERCARD_ISOLATED_DIR/node_modules"
      /bin/ln -s "$ALIAS_CHAIN_TARGET" "$HUNTERCARD_ISOLATED_DIR/node_modules"
    fi
    exit "$rc"
    ;;
esac
exec ${REAL_GIT} "$@"
`);
  if (!forced) {
    const residue = path.join(sandbox.repo, 'data', 'price-history', 'hDIC1472-006_hFOO_C.json');
    fs.mkdirSync(path.dirname(residue), { recursive: true });
    fs.writeFileSync(residue, '{}');
  }
  const snapshot = takeResidentSnapshot(sandbox);
  try {
    const res = runSandbox(sandbox, {
      ALIAS_CHAIN_TARGET: chainTarget,
      ...(forced ? { HUNTERCARD_FORCE_ISOLATED: '1' } : {}),
    });
    assertFailedClosedNoMutation(route, res, /aliases the resident install; refusing to remove it/);
    assert.match(
      res.log,
      /worktree dependencies could not be provisioned/,
      `${route}: dispatch must abandon the run after the refusal`,
    );
    // The entire point of the refusal: the resident install survives
    // byte-identical (no rm ever ran against the aliased path).
    assertResidentUntouched(sandbox, snapshot);
  } finally {
    cleanup(sandbox);
  }
}

// ─── Case O (DIC-1472 CR P1): shell-removal failure must fail closed, on both
// routes and in both liar shapes: an `rm` that exits non-zero, and the nastier
// `rm` that exits 0 while LEAVING the path in place — only the post-removal
// `[ -e ]`/`[ -L ]` re-check catches the second one. The shim intercepts ONLY
// the removal of the worktree's node_modules; every other rm (lock file,
// stale-worktree cleanup) passes through so the rest of the scheduler is real.
// Mutation sensor: the branch-specific reason regex — weaken either the `!
// rm` check or the post-removal re-check and the failure shape shifts to a
// later branch (symlink-creation), turning the reason assertion red.
for (const forced of [false, true]) {
  for (const mode of ['fail', 'lie']) {
    const sandbox = makeSandbox();
    const route = `${forced ? 'forced-isolated' : 'dirty-isolated'} (rm ${mode}s)`;
    writeShim(sandbox.bin, 'rm', `#!/bin/bash
echo "rm $*" >> "$TRACE_FILE"
for a in "$@"; do
  case "$a" in
    */node_modules)
      if [ "$RM_SHIM_MODE" = "lie" ]; then exit 0; fi
      exit 1
      ;;
  esac
done
exec /bin/rm "$@"
`);
    if (!forced) {
      const residue = path.join(sandbox.repo, 'data', 'price-history', 'hDIC1472-007_hFOO_C.json');
      fs.mkdirSync(path.dirname(residue), { recursive: true });
      fs.writeFileSync(residue, '{}');
    }
    const snapshot = takeResidentSnapshot(sandbox);
    try {
      const res = runSandbox(sandbox, {
        RM_SHIM_MODE: mode,
        ...(forced ? { HUNTERCARD_FORCE_ISOLATED: '1' } : {}),
      });
      assert.ok(
        res.lines.some((l) => l.startsWith('rm ') && l.includes('node_modules')),
        `${route}: sanity — the shell-removal attempt must actually have been made`,
      );
      assertFailedClosedNoMutation(route, res, /could not remove incomplete node_modules shell/);
      assertResidentUntouched(sandbox, snapshot);
    } finally {
      cleanup(sandbox);
    }
  }
}

// ─── Case P (DIC-1472 CR P1): anchors missing AFTER the symlink must fail
// closed, on both routes. The `ln` shim creates the genuine symlink to the
// resident install and then drops a resident anchor — simulating the resident
// install being mutated concurrently with provisioning. The resolved-target
// verification PASSES (the link really points at the resident install); only
// the final anchor re-verify can catch this shape, so deleting that re-check
// lets the pipeline build against a half-vanished dependency tree.
// Mutation sensor: without the final depAnchorsOk re-check the run proceeds
// into the build (the build shim then dies module-not-found mid-pipeline
// instead of failing closed pre-mutation), flipping the reason and the
// no-build assertions red.
for (const forced of [false, true]) {
  const sandbox = makeSandbox();
  const route = forced ? 'forced-isolated' : 'dirty-isolated';
  writeShim(sandbox.bin, 'ln', `#!/bin/bash
echo "ln $*" >> "$TRACE_FILE"
/bin/ln "$@" || exit $?
/bin/rm -f "$RESIDENT_ANCHOR_TO_DROP"
exit 0
`);
  if (!forced) {
    const residue = path.join(sandbox.repo, 'data', 'price-history', 'hDIC1472-008_hFOO_C.json');
    fs.mkdirSync(path.dirname(residue), { recursive: true });
    fs.writeFileSync(residue, '{}');
  }
  try {
    const res = runSandbox(sandbox, {
      RESIDENT_ANCHOR_TO_DROP: path.join(sandbox.repo, 'node_modules', 'puppeteer', 'package.json'),
      ...(forced ? { HUNTERCARD_FORCE_ISOLATED: '1' } : {}),
    });
    // Sanity: provisioning genuinely got past removal + linking + target
    // verification — only the final anchor re-verify may be the stopper.
    assert.match(res.log, /replacing with absolute symlink to resident install/, `${route}: the shell replacement must have started`);
    assert.doesNotMatch(res.log, /unsafe target/, `${route}: the resolved-target check must have PASSED (the link is genuine)`);
    assertFailedClosedNoMutation(route, res, /required anchors still absent after symlinking resident node_modules; failing closed/);
    // No resident-fingerprint assertion here: this case deliberately deletes a
    // resident anchor (via the shim) to simulate the concurrent mutation.
  } finally {
    cleanup(sandbox);
  }
}

// ─── DIC-1167 (CR 028f6a19) clean-path / origin-freshness fail-closed ──────
// The in-place clean route builds from, commits on and pushes HEAD:main from
// the RESIDENT HEAD. Cases Q–V drive the real script against the real sandbox
// remote (fetch / pull are real git; only push + commit are shimmed) to prove:
// a failed fast-forward, a resident HEAD that is not the fetched origin/main,
// a rejected in-place push and a failed pre-mutation fetch all exit 1 with the
// FAILED marker before (or instead of) publication, and that both routes use
// the freshly fetched origin/main rather than a stale local cache.

// Advance the sandbox remote from an independent clone, leaving the resident's
// cached origin/main stale. Returns the new remote main SHA.
function advanceRemote(sandbox, label) {
  const other = path.join(sandbox.dir, `other-${label}`);
  execSync(`${REAL_GIT} clone -q ${sandbox.remote} ${other}`);
  execSync(`${REAL_GIT} config user.email other@example.com`, { cwd: other });
  execSync(`${REAL_GIT} config user.name other`, { cwd: other });
  fs.writeFileSync(path.join(other, `remote-${label}.txt`), `${label}\n`);
  execSync(`${REAL_GIT} add remote-${label}.txt`, { cwd: other });
  execSync(`${REAL_GIT} -c commit.gpgsign=false commit -q -m "remote ${label}"`, { cwd: other });
  execSync(`${REAL_GIT} push -q origin main`, { cwd: other });
  return execSync(`${REAL_GIT} rev-parse HEAD`, { cwd: other, encoding: 'utf-8' }).trim();
}

// Commit a non-managed file on the resident WITHOUT pushing (keeps the
// scraper-managed paths clean, so dispatch takes the in-place route).
function commitLocalOnly(sandbox, label) {
  fs.writeFileSync(path.join(sandbox.repo, `local-${label}.txt`), `${label}\n`);
  execSync(`${REAL_GIT} add local-${label}.txt`, { cwd: sandbox.repo });
  execSync(`${REAL_GIT} -c commit.gpgsign=false commit -q -m "local ${label}"`, { cwd: sandbox.repo });
  return execSync(`${REAL_GIT} rev-parse HEAD`, { cwd: sandbox.repo, encoding: 'utf-8' }).trim();
}

function assertCleanPathFailedClosed(route, result, reasonRe) {
  assertFailedClosedNoMutation(route, result, reasonRe);
  assert.doesNotMatch(result.log, /✅ Pushed|✅ Done/, `${route}: must never report Pushed/Done`);
  assert.doesNotMatch(result.log, /non-fatal\); continuing with current HEAD/, `${route}: ff failure must not be downgraded to non-fatal`);
}

// ─── Case Q: clean resident DIVERGED from origin/main — ff-only fails ───────
{
  const sandbox = makeSandbox();
  try {
    const localSha = commitLocalOnly(sandbox, 'q');
    advanceRemote(sandbox, 'q');
    const result = runSandbox(sandbox);
    assertCleanPathFailedClosed(
      'Q diverged clean resident',
      result,
      /git pull --ff-only origin main failed on the clean resident checkout; refusing to build\/push/,
    );
    const headAfter = execSync(`${REAL_GIT} rev-parse HEAD`, { cwd: sandbox.repo, encoding: 'utf-8' }).trim();
    assert.equal(headAfter, localSha, 'Q: resident HEAD must stay at its own commit (no merge, no reset)');
  } finally {
    cleanup(sandbox);
  }
}

// ─── Case R: clean resident AHEAD of origin/main (unpushed local commit).
// --ff-only succeeds ("Already up to date"), but building + pushing HEAD:main
// would publish an unreviewed local commit — must fail closed.
{
  const sandbox = makeSandbox();
  try {
    commitLocalOnly(sandbox, 'r');
    const result = runSandbox(sandbox);
    assert.ok(someTraced(result.lines, 'git pull --ff-only origin main'), 'R: sanity — the fast-forward was attempted');
    assertCleanPathFailedClosed(
      'R ahead clean resident',
      result,
      /resident HEAD \([0-9a-f]{40}\) is not the fetched origin\/main \([0-9a-f]{40}\) after fast-forward/,
    );
  } finally {
    cleanup(sandbox);
  }
}

// ─── Case S: clean resident with a STALE origin/main cache (remote advanced).
// The real fetch + ff-only must move the resident to the NEW remote head
// before the build, and the run then publishes normally.
{
  const sandbox = makeSandbox();
  try {
    const staleCached = execSync(`${REAL_GIT} rev-parse origin/main`, { cwd: sandbox.repo, encoding: 'utf-8' }).trim();
    const newRemote = advanceRemote(sandbox, 's');
    assert.notEqual(newRemote, staleCached, 'S: sanity — remote advanced past the resident cache');
    const { status, lines, log } = runSandbox(sandbox);
    assert.equal(status, 0, `S: fast-forwardable stale resident must complete; got ${status}\n${log}`);
    // The artifact commit (`git -c … commit` reaches real git) must sit
    // directly on the freshly fetched remote head, not the stale cache.
    const artifactParent = execSync(`${REAL_GIT} rev-parse HEAD^`, { cwd: sandbox.repo, encoding: 'utf-8' }).trim();
    assert.equal(artifactParent, newRemote, 'S: artifact must be built on the fast-forwarded origin/main, not the stale cache');
    const pull = lines.findIndex((l) => l.includes('git pull --ff-only origin main'));
    const build = lines.findIndex((l) => l.includes('build-database.js'));
    assert.ok(pull !== -1 && build !== -1 && pull < build, 'S: fast-forward must precede the build');
    assert.ok(someTraced(lines, 'push origin HEAD:main'), 'S: in-place route publishes HEAD:main');
    assert.match(log, /✅ Done/, 'S: healthy run reports Done');
  } finally {
    cleanup(sandbox);
  }
}

// ─── Case T: in-place HEAD:main push REJECTED — must fail, never "Pushed". ──
// Previously `push HEAD:main || push HEAD` then unconditionally "✅ Pushed" +
// "✅ Done": a rejected publication was reported as success.
{
  const sandbox = makeSandbox();
  try {
    const { status, lines, log } = runSandbox(sandbox, { FAIL_PUSH: 'HEAD:main' });
    assert.equal(status, 1, `T: rejected in-place push must fail the scheduler; got ${status}\n${log}`);
    assert.match(log, /git push origin HEAD:main FAILED; artifact not published/, 'T: exact push-failure reason');
    assert.match(log, /HUNTERCARD_SCRAPE_STATUS=FAILED/, 'T: cron must observe the FAILED marker');
    assert.doesNotMatch(log, /✅ Pushed|✅ Done/, 'T: must never report Pushed/Done after a rejected push');
    assert.equal(
      lines.some((l) => /push origin HEAD$/.test(l)),
      false,
      'T: must not fall back to pushing an unqualified HEAD ref',
    );
  } finally {
    cleanup(sandbox);
  }
}

// ─── Case U: dirty route with a STALE origin/main cache — the isolated
// worktree must be pinned to the freshly FETCHED remote head, not the cache. ─
{
  const sandbox = makeSandbox();
  const isoDir = path.join(sandbox.dir, 'iso');
  const residue = path.join(sandbox.repo, 'data', 'price-history', 'hSTALE-001_hFOO_C.json');
  fs.mkdirSync(path.dirname(residue), { recursive: true });
  fs.writeFileSync(residue, '{}');
  try {
    const staleCached = execSync(`${REAL_GIT} rev-parse origin/main`, { cwd: sandbox.repo, encoding: 'utf-8' }).trim();
    const newRemote = advanceRemote(sandbox, 'u');
    const { status, lines, log } = runSandbox(sandbox);
    assert.equal(status, 0, `U: dirty isolated handoff must complete; got ${status}\n${log}`);
    const fetch = lines.findIndex((l) => l.includes('git fetch origin main'));
    const add = lines.findIndex((l) => l.includes(`git worktree add --detach ${isoDir} `));
    assert.ok(fetch !== -1 && add !== -1 && fetch < add, 'U: fetch must precede the isolated worktree creation');
    assert.ok(
      someTraced(lines, `git worktree add --detach ${isoDir} ${newRemote}`),
      'U: isolated worktree must be created at the freshly fetched origin/main',
    );
    assert.equal(
      someTraced(lines, `git worktree add --detach ${isoDir} ${staleCached}`),
      false,
      'U: isolated worktree must NEVER be created at the stale cached origin/main',
    );
    assert.equal(someTraced(lines, 'git pull'), false, 'U: dirty resident must not be pulled');
  } finally {
    cleanup(sandbox);
  }
}

// ─── Case V: pre-mutation fetch failure (remote unreachable) fails closed on
// BOTH the clean and the dirty route — no stale-cache fallthrough. ──────────
for (const dirty of [false, true]) {
  const sandbox = makeSandbox();
  const route = dirty ? 'V dirty route' : 'V clean route';
  if (dirty) {
    const residue = path.join(sandbox.repo, 'data', 'price-history', 'hNOFETCH-001_hFOO_C.json');
    fs.mkdirSync(path.dirname(residue), { recursive: true });
    fs.writeFileSync(residue, '{}');
  }
  execSync(`${REAL_GIT} remote set-url origin ${path.join(sandbox.dir, 'missing-remote.git')}`, { cwd: sandbox.repo });
  try {
    const result = runSandbox(sandbox);
    assertCleanPathFailedClosed(route, result, /git fetch origin main failed before scheduler mutation/);
    assert.equal(someTraced(result.lines, 'git worktree add'), false, `${route}: no worktree from a stale cache`);
    assert.equal(someTraced(result.lines, 'git pull'), false, `${route}: no pull after a failed fetch`);
  } finally {
    cleanup(sandbox);
  }
}

// ─── DIC-1167 (2026-09-30) stale resident orchestration ─────────────────────
// The cron invokes the RESIDENT script, and bash keeps the function
// definitions it parsed from that file for the whole run. On 09-30 a
// 225-commit-stale resident built origin/main's data through its OWN
// runPipeline (no run budget, no fail-closed push). These cases mark each
// copy of the script's runPipeline with a trace so the harness can see WHOSE
// orchestration actually ran.

const RUN_PIPELINE_ANCHOR = 'runPipeline() {\n  local dir="$1"\n';

// markedScript(label): the real script whose runPipeline traces
// `RUNPIPELINE_FROM <label>` first thing.
function markedScript(label) {
  const src = fs.readFileSync(REAL_PIPELINE, 'utf-8');
  assert.ok(src.includes(RUN_PIPELINE_ANCHOR), 'harness: runPipeline anchor must exist in the real script');
  return src.replace(
    RUN_PIPELINE_ANCHOR,
    `runPipeline() {\n  echo "RUNPIPELINE_FROM ${label}" >> "$TRACE_FILE"\n  local dir="$1"\n`,
  );
}

const residentScriptPath = (sandbox) => path.join(sandbox.repo, 'scripts', 'local-scrape-and-push.sh');

// Commit + push a script variant from the resident (resident HEAD == origin).
function commitScriptOnResident(sandbox, label) {
  fs.writeFileSync(residentScriptPath(sandbox), markedScript(label));
  execSync(`${REAL_GIT} add scripts/local-scrape-and-push.sh`, { cwd: sandbox.repo });
  execSync(`${REAL_GIT} -c commit.gpgsign=false commit -q -m "script ${label}"`, { cwd: sandbox.repo });
  execSync(`${REAL_GIT} push -q origin main`, { cwd: sandbox.repo });
}

// Advance origin with a script variant from an independent clone, leaving the
// resident (and its running copy) one commit behind.
function advanceRemoteScript(sandbox, label) {
  const other = path.join(sandbox.dir, `other-script-${label}`);
  execSync(`${REAL_GIT} clone -q ${sandbox.remote} ${other}`);
  execSync(`${REAL_GIT} config user.email other@example.com`, { cwd: other });
  execSync(`${REAL_GIT} config user.name other`, { cwd: other });
  fs.writeFileSync(path.join(other, 'scripts', 'local-scrape-and-push.sh'), markedScript(label));
  execSync(`${REAL_GIT} add scripts/local-scrape-and-push.sh`, { cwd: other });
  execSync(`${REAL_GIT} -c commit.gpgsign=false commit -q -m "remote script ${label}"`, { cwd: other });
  execSync(`${REAL_GIT} push -q origin main`, { cwd: other });
  return execSync(`${REAL_GIT} rev-parse HEAD`, { cwd: other, encoding: 'utf-8' }).trim();
}

const pipelineOwnersOrBuild = (lines, isoDir) =>
  lines.some((l) => l.includes('build-database.js') && l.includes(`[cwd=${isoDir}]`));

const pipelineOwners = (lines) =>
  lines.filter((l) => l.startsWith('RUNPIPELINE_FROM ')).map((l) => l.slice('RUNPIPELINE_FROM '.length));

// ─── Case W: dirty route with a STALE/MODIFIED resident script — the
// pipeline must run origin's committed orchestration from the isolated
// worktree, never the resident's function definitions. ────────────────────
{
  const sandbox = makeSandbox();
  const isoDir = path.join(sandbox.dir, 'iso');
  try {
    commitScriptOnResident(sandbox, 'ORIGIN');
    fs.writeFileSync(residentScriptPath(sandbox), markedScript('RESIDENT'));
    const residue = path.join(sandbox.repo, 'data', 'price-history', 'hW-001_hFOO_C.json');
    fs.writeFileSync(residue, '{}');
    const { status, lines, log } = runSandbox(sandbox);
    assert.equal(status, 0, `W: dirty isolated handoff must complete; got ${status}\n${log}`);
    assert.deepEqual(pipelineOwners(lines), ['ORIGIN'], `W: exactly origin's runPipeline must run, never the resident's\n${lines.join('\n')}`);
    assert.match(log, /resident script .* differs from origin\/main .*the pipeline runs origin's copy/, 'W: the stale resident must be reported');
    assert.ok(
      lines.some((l) => l.includes('build-database.js') && l.includes(`[cwd=${isoDir}]`)),
      'W: the build must run inside the isolated worktree',
    );
    assert.ok(someTraced(lines, 'HEAD:refs/heads/bot/scrape/'), 'W: handoff goes to bot/scrape/<date>');
    assert.equal(someTraced(lines, 'HEAD:main'), false, 'W: dirty route must never push HEAD:main');
    assert.match(log, /✅ Done \(isolated handoff\)/, 'W: stage 2 reports the isolated handoff');
    assert.match(log, /✅ Done \(isolated bootstrap\)/, 'W: stage 1 reports Done only after stage 2');
    assert.equal(fs.readFileSync(residue, 'utf-8'), '{}', 'W: resident residue must stay untouched');
    assert.equal(fs.readFileSync(residentScriptPath(sandbox), 'utf-8'), markedScript('RESIDENT'), 'W: resident script must stay untouched');
  } finally {
    cleanup(sandbox);
  }
}

// ─── Case X: clean in-place route where the fast-forward UPDATES the script —
// the run must re-execute origin's copy instead of the definitions it parsed
// before the pull, and publish exactly once. ───────────────────────────────
{
  const sandbox = makeSandbox();
  try {
    commitScriptOnResident(sandbox, 'OLD');
    const newRemote = advanceRemoteScript(sandbox, 'NEW');
    const { status, lines, log } = runSandbox(sandbox);
    assert.equal(status, 0, `X: fast-forwarded in-place run must complete via the updated script; got ${status}\n${log}`);
    assert.deepEqual(pipelineOwners(lines), ['NEW'], `X: only the pulled script's runPipeline may run\n${lines.join('\n')}`);
    assert.match(log, /fast-forward updated scripts\/local-scrape-and-push\.sh .*re-executing origin\/main's copy/, 'X: the re-exec must be logged');
    assert.equal(lines.filter((l) => l.includes('push origin HEAD:main')).length, 1, 'X: the artifact is published exactly once');
    const artifactParent = execSync(`${REAL_GIT} rev-parse HEAD^`, { cwd: sandbox.repo, encoding: 'utf-8' }).trim();
    assert.equal(artifactParent, newRemote, 'X: artifact sits on the fetched origin/main');
  } finally {
    cleanup(sandbox);
  }
}

// ─── Case Y: clean in-place route with a LOCALLY MODIFIED resident script —
// neither the running copy nor the on-disk one is origin's, so the run must
// fail closed before any scrape/build/commit/push. ──────────────────────────
{
  const sandbox = makeSandbox();
  try {
    fs.writeFileSync(residentScriptPath(sandbox), markedScript('LOCAL'));
    const result = runSandbox(sandbox);
    assertCleanPathFailedClosed(
      'Y locally modified resident script',
      result,
      /is not origin\/main's committed scripts\/local-scrape-and-push\.sh .*refusing in-place build\/push with stale or locally modified orchestration/,
    );
    assert.deepEqual(pipelineOwners(result.lines), [], 'Y: no runPipeline may run');
  } finally {
    cleanup(sandbox);
  }
}

// ─── Case Z: a re-executed run that STILL is not origin's script (or a
// leaked HUNTERCARD_SELF_REEXEC) must fail closed, never re-exec again. ────
{
  const sandbox = makeSandbox();
  try {
    commitScriptOnResident(sandbox, 'OLD');
    advanceRemoteScript(sandbox, 'NEW');
    const result = runSandbox(sandbox, { HUNTERCARD_SELF_REEXEC: '1' });
    assertCleanPathFailedClosed(
      'Z re-exec guard',
      result,
      /refusing in-place build\/push with stale or locally modified orchestration/,
    );
    assert.deepEqual(pipelineOwners(result.lines), [], 'Z: no runPipeline may run');
    assert.doesNotMatch(result.log, /re-executing origin\/main's copy/, 'Z: must not re-execute a second time');
  } finally {
    cleanup(sandbox);
  }
}

// ─── Case AA: HUNTERCARD_FORCE_ISOLATED_STAGE2 leaked into a resident run whose
// script is not its HEAD's committed copy — stage 2 must refuse. ────────────
{
  const sandbox = makeSandbox();
  try {
    fs.writeFileSync(residentScriptPath(sandbox), markedScript('LEAKED'));
    const result = runSandbox(sandbox, { HUNTERCARD_FORCE_ISOLATED_STAGE2: '1' });
    assertFailedClosedNoMutation(
      'AA leaked stage-2 flag',
      result,
      /forced-isolated stage 2: running script .* is not the committed scripts\/local-scrape-and-push\.sh at worktree HEAD [0-9a-f]{40}; refusing stale orchestration/,
    );
    assert.deepEqual(pipelineOwners(result.lines), [], 'AA: no runPipeline may run');
  } finally {
    cleanup(sandbox);
  }
}

// ─── DIC-1167 (CR bced44d5): a stage-2 process whose script DOES match its
// own HEAD must still prove it is stage 1's ephemeral worktree at the freshly
// fetched origin/main. A clean (even current) resident, a linked worktree on
// a branch, or a detached linked worktree without stage 1's one-time
// attestation must all refuse before any scrape/build/commit/push. ─────────

function assertStage2Refused(route, sandbox, snapshot, result, reasonRe) {
  assertFailedClosedNoMutation(route, result, reasonRe);
  assert.deepEqual(pipelineOwners(result.lines), [], `${route}: no runPipeline may run`);
  assert.equal(someTraced(result.lines, 'git worktree add'), false, `${route}: stage 2 never bootstraps`);
  assert.doesNotMatch(result.log, /✅ Done/, `${route}: must never report Done`);
  assertResidentUntouched(sandbox, snapshot);
  assert.equal(
    execSync(`${REAL_GIT} status --porcelain`, { cwd: sandbox.repo, encoding: 'utf-8' }),
    '',
    `${route}: the clean resident must stay clean`,
  );
}

// ─── Case BB: clean resident (script == HEAD's == origin's) with leaked
// stage-2 env — bare flag, then forged worktree/expected-head/nonce. ────────
{
  const variants = [
    ['BB(a) bare leaked flag', () => ({}), /forced-isolated stage 2: checkout \S+ is not the stage-1 ephemeral worktree \(unset\)/],
    [
      'BB(b) forged stage-2 env on the main working tree',
      (sandbox, head) => ({ HUNTERCARD_STAGE2_WORKTREE: sandbox.repo, HUNTERCARD_STAGE2_EXPECTED_HEAD: head, HUNTERCARD_STAGE2_NONCE: 'f'.repeat(32) }),
      /forced-isolated stage 2: checkout \S+ is a main working tree, not a linked ephemeral worktree/,
    ],
  ];
  for (const [route, env, reasonRe] of variants) {
    const sandbox = makeSandbox();
    try {
      commitScriptOnResident(sandbox, 'RESIDENT');
      const head = execSync(`${REAL_GIT} rev-parse HEAD`, { cwd: sandbox.repo, encoding: 'utf-8' }).trim();
      assert.equal(head, execSync(`${REAL_GIT} rev-parse origin/main`, { cwd: sandbox.repo, encoding: 'utf-8' }).trim(), `${route}: sanity — resident is current`);
      const snapshot = takeResidentSnapshot(sandbox);
      const result = runSandbox(sandbox, { HUNTERCARD_FORCE_ISOLATED_STAGE2: '1', ...env(sandbox, head) });
      assert.doesNotMatch(result.log, /is not the committed scripts\/local-scrape-and-push\.sh/, `${route}: sanity — the script check passes`);
      assertStage2Refused(route, sandbox, snapshot, result, reasonRe);
      assert.equal(someTraced(result.lines, 'git pull'), false, `${route}: the resident must not be pulled`);
    } finally {
      cleanup(sandbox);
    }
  }
}

// ─── Case BB (linked worktrees): a checkout that IS a linked worktree at
// origin/main but was not created+attested by THIS stage 1 — on a branch, or
// detached with a missing or foreign attestation — must refuse. ────────────
{
  const variants = [
    ['BB(c) linked worktree on a branch', 'branch', null, /HEAD attached to a branch, not stage 1's detached origin snapshot/],
    ['BB(d) detached linked worktree without attestation', 'detached', null, /no matching stage-1 attestation in \S+ \(leaked flag, replayed nonce/],
    ['BB(e) detached linked worktree with a foreign attestation', 'detached', 'a'.repeat(32), /no matching stage-1 attestation in \S+ \(leaked flag, replayed nonce/],
  ];
  for (const [route, mode, foreignNonce, reasonRe] of variants) {
    const sandbox = makeSandbox();
    const leakDir = path.join(sandbox.dir, 'leaked-wt');
    try {
      commitScriptOnResident(sandbox, 'RESIDENT');
      const head = execSync(`${REAL_GIT} rev-parse HEAD`, { cwd: sandbox.repo, encoding: 'utf-8' }).trim();
      execSync(
        mode === 'branch'
          ? `${REAL_GIT} worktree add -q -b leaked ${leakDir} ${head}`
          : `${REAL_GIT} worktree add -q --detach ${leakDir} ${head}`,
        { cwd: sandbox.repo },
      );
      const leakGitDir = execSync(`${REAL_GIT} rev-parse --absolute-git-dir`, { cwd: leakDir, encoding: 'utf-8' }).trim();
      if (foreignNonce) fs.writeFileSync(path.join(leakGitDir, 'huntercard-stage2-attestation'), `${foreignNonce}\n`);
      const snapshot = takeResidentSnapshot(sandbox);
      const result = runSandbox(
        sandbox,
        {
          HUNTERCARD_FORCE_ISOLATED_STAGE2: '1',
          HUNTERCARD_STAGE2_WORKTREE: leakDir,
          HUNTERCARD_STAGE2_EXPECTED_HEAD: head,
          HUNTERCARD_STAGE2_NONCE: 'b'.repeat(32),
        },
        path.join(leakDir, 'scripts', 'local-scrape-and-push.sh'),
      );
      assertStage2Refused(route, sandbox, snapshot, result, reasonRe);
      assert.equal(
        execSync(`${REAL_GIT} rev-parse HEAD`, { cwd: leakDir, encoding: 'utf-8' }).trim(),
        head,
        `${route}: the leaked worktree must not gain a commit`,
      );
      if (foreignNonce) {
        assert.equal(
          fs.readFileSync(path.join(leakGitDir, 'huntercard-stage2-attestation'), 'utf-8'),
          `${foreignNonce}\n`,
          `${route}: a non-matching attestation must not be consumed`,
        );
      }
    } finally {
      cleanup(sandbox);
    }
  }
}

// ─── Case CC: origin/main ADVANCES between the stage-1 fetch (worktree
// pinned) and the stage-2 fetch — stage 2 must refuse the stale snapshot,
// never build or hand it off, and stage 1 must report failure. ────────────
for (const [route, extraEnv, residue] of [
  ['CC forced route', { HUNTERCARD_FORCE_ISOLATED: '1' }, false],
  ['CC dirty route', {}, true],
]) {
  const sandbox = makeSandbox();
  const isoDir = path.join(sandbox.dir, 'iso');
  try {
    if (residue) {
      fs.writeFileSync(path.join(sandbox.repo, 'data', 'price-history', 'hCC-001_hFOO_C.json'), '{}');
    }
    const pinned = execSync(`${REAL_GIT} rev-parse HEAD`, { cwd: sandbox.repo, encoding: 'utf-8' }).trim();
    const other = path.join(sandbox.dir, 'other-cc');
    execSync(`${REAL_GIT} clone -q ${sandbox.remote} ${other}`);
    fs.writeFileSync(path.join(other, 'remote-cc.txt'), 'cc\n');
    execSync(`${REAL_GIT} add remote-cc.txt`, { cwd: other });
    execSync(`${REAL_GIT} -c user.email=o@example.com -c user.name=o -c commit.gpgsign=false commit -q -m "remote cc"`, { cwd: other });
    const advanced = execSync(`${REAL_GIT} rev-parse HEAD`, { cwd: other, encoding: 'utf-8' }).trim();
    const hook = path.join(sandbox.dir, 'advance-hook.sh');
    fs.writeFileSync(hook, `${REAL_GIT} -C ${other} push -q origin main\n`);
    const snapshot = takeResidentSnapshot(sandbox);
    const result = runSandbox(sandbox, {
      ...extraEnv,
      ADVANCE_ON_FETCH_N: '2',
      ADVANCE_HOOK: hook,
      FETCH_COUNT_FILE: path.join(sandbox.dir, 'fetch-count'),
    });
    const label = residue ? 'isolated' : 'forced-isolated';
    assertFailedClosedNoMutation(
      route,
      result,
      new RegExp(`${label} stage 2: worktree HEAD ${pinned} is not the freshly fetched origin/main ${advanced} \\(stage 1 pinned ${pinned}\\); refusing stale orchestration`),
    );
    assert.ok(someTraced(result.lines, `git worktree add --detach ${isoDir} ${pinned}`), `${route}: stage 1 pinned the pre-advance head`);
    assert.equal(result.lines.filter((l) => l.startsWith('git fetch origin main')).length, 2, `${route}: both stages fetched`);
    assert.deepEqual(pipelineOwners(result.lines), [], `${route}: no runPipeline may run`);
    assert.equal(someTraced(result.lines, 'bot/scrape/'), false, `${route}: no bot/scrape handoff`);
    assert.match(result.log, new RegExp(`${label} stage 2 failed — cron reports failure`), `${route}: stage 1 propagates the refusal`);
    assert.doesNotMatch(result.log, /✅ Done/, `${route}: must never report Done`);
    assertResidentUntouched(sandbox, snapshot);
    assert.equal(fs.existsSync(isoDir), false, `${route}: stage 1 removes the ephemeral worktree`);
  } finally {
    cleanup(sandbox);
  }
}

// ─── DIC-1167 (CR cb2b3b13): a delegated child (stage 2 / in-place re-exec)
// that finds its lock already present used to log "already running" and
// exit 0; its parent took that 0 as a completed handoff and logged Done. A
// stage-2 process killed before its EXIT trap leaves exactly that lock, so
// every later run "succeeded" without scraping or pushing. Now:
//   - a parent clears an ORPHANED child lock (owner pid not running) before
//     spawning, and refuses (fails closed) while the owner is still alive;
//   - a delegated child never skips on a lock collision — it fails closed;
//   - a parent reports Done only on the child's per-run nonce receipt, never
//     on a bare exit 0. ──────────────────────────────────────────────────────

// procStartTime(pid): the script's normalized `ps -o lstart` for <pid>.
function procStartTime(pid) {
  return execSync(`ps -o lstart= -p ${pid}`, { env: { ...process.env, LC_ALL: 'C' } })
    .toString().replace(/\s+/g, ' ').trim();
}
const reEsc = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// DD(a/b): an orphaned stage-2 lock (killed run; no pid, or a dead pid) is
// cleared by stage 1 and the run completes its real handoff, on both routes.
// DD(f/g) (pid reuse): the killed owner's pid now belongs to an unrelated LIVE
// process (here: this node test runner) — with a recorded start time that no
// longer matches, or a legacy lock with no start time whose live pid is not
// this scraper. That lock is still an orphan: cleared, never kept forever.
for (const [route, extraEnv, residue, ownerPid] of [
  ['DD(a) forced route, orphaned stage-2 lock without owner pid', { HUNTERCARD_FORCE_ISOLATED: '1' }, false, null],
  ['DD(b) dirty route, orphaned stage-2 lock with a dead owner pid', {}, true, 'dead'],
  ['DD(f) forced route, owner pid reused by a live process (start time differs)', { HUNTERCARD_FORCE_ISOLATED: '1' }, false, 'reused'],
  ['DD(f) dirty route, owner pid reused by a live process (start time differs)', {}, true, 'reused'],
  ['DD(g) forced route, legacy lock (no start time) whose pid is reused by a non-scraper', { HUNTERCARD_FORCE_ISOLATED: '1' }, false, 'reused-legacy'],
]) {
  const sandbox = makeSandbox();
  const isoDir = path.join(sandbox.dir, 'iso');
  const lock = path.join(sandbox.dir, 'scrape.lock');
  const staleLock = `${lock}.stage2`;
  try {
    if (residue) fs.writeFileSync(path.join(sandbox.repo, 'data', 'price-history', 'hDD-001_hFOO_C.json'), '{}');
    fs.mkdirSync(staleLock);
    let recorded = 'unrecorded';
    let reasonRe = `owner pid ${recorded} not running`;
    if (ownerPid === 'dead') {
      const exited = spawnSync('bash', ['-c', 'echo $$']);
      recorded = exited.stdout.toString().trim();
      fs.writeFileSync(path.join(staleLock, 'pid'), `${recorded}\n`);
      reasonRe = `owner pid ${recorded} not running`;
    } else if (ownerPid === 'reused') {
      recorded = String(process.pid);
      fs.writeFileSync(path.join(staleLock, 'pid'), `${recorded}\n`);
      fs.writeFileSync(path.join(staleLock, 'start'), 'Thu Jan  1 00:00:00 1970\n');
      reasonRe = `owner pid ${recorded} was reused: recorded start 'Thu Jan  1 00:00:00 1970', live process started '${reEsc(procStartTime(process.pid))}'`;
    } else if (ownerPid === 'reused-legacy') {
      recorded = String(process.pid);
      fs.writeFileSync(path.join(staleLock, 'pid'), `${recorded}\n`);
      reasonRe = `owner pid ${recorded} was reused: no recorded start time and the live process is not this scraper`;
    }
    const snapshot = takeResidentSnapshot(sandbox);
    const { status, lines, log } = runSandbox(sandbox, extraEnv);
    const label = residue ? 'isolated' : 'forced-isolated';
    assert.equal(status, 0, `${route}: an orphaned child lock must not block or fake the run; got ${status}\n${log}`);
    assert.match(log, new RegExp(`removing orphaned child lock ${reEsc(staleLock)} \\(${reasonRe}\\)`), `${route}: the orphan must be reported`);
    assert.doesNotMatch(log, /is held by live pid/, `${route}: a dead or reused owner pid is never treated as a live owner`);
    assert.doesNotMatch(log, /already running, skipping/, `${route}: stage 2 must not skip`);
    assert.equal(pipelineOwnersOrBuild(lines, isoDir), true, `${route}: the build must actually run in the isolated worktree`);
    assert.ok(someTraced(lines, 'HEAD:refs/heads/bot/scrape/'), `${route}: the handoff must actually be pushed`);
    assert.match(log, new RegExp(`✅ Done \\(${label} handoff\\)`), `${route}: stage 2 completes`);
    assert.match(log, new RegExp(`${label} stage 2 receipt verified`), `${route}: stage 1 verified the stage-2 receipt`);
    assert.match(log, new RegExp(`✅ Done \\(${label} bootstrap\\)`), `${route}: stage 1 reports Done after the receipt`);
    assert.equal(fs.existsSync(staleLock), false, `${route}: no stage-2 lock remains`);
    assert.equal(fs.existsSync(lock), false, `${route}: no primary lock remains`);
    assertResidentUntouched(sandbox, snapshot);
  } finally {
    cleanup(sandbox);
  }
}

// DD(c): a stage-2 lock whose recorded owner is ALIVE — the same process: its
// recorded start time matches, or (legacy lock, no start time) it is still
// running this scraper — is never stolen; stage 1 fails closed before the
// child runs and leaves that lock in place. CR 4d3610a7: that live stage 2
// may still be working in the isolated worktree, so stage 1 must fail BEFORE
// it prunes/removes or (re)creates any worktree — a registered checkout at
// the isolated path survives untouched, and no worktree is ever created.
for (const [route, legacy, existingWorktree] of [
  ['DD(c) live stage-2 lock owner (start time matches)', false, false],
  ['DD(c) live stage-2 lock owner (legacy lock, live scraper command)', true, false],
  ['DD(c) live stage-2 lock owner + its live isolated worktree (start time matches)', false, true],
  ['DD(c) live stage-2 lock owner + its live isolated worktree (legacy lock)', true, true],
]) {
  const sandbox = makeSandbox();
  const isoDir = path.join(sandbox.dir, 'iso');
  const marker = path.join(isoDir, 'live-stage2-in-progress');
  const staleLock = path.join(sandbox.dir, 'scrape.lock.stage2');
  // A live stand-in owner whose command line names this scraper. `; :` keeps
  // bash from exec'ing sleep, so the pid keeps that command line.
  const owner = spawn('bash', ['-c', 'sleep 120; :', 'local-scrape-and-push.sh'], { stdio: 'ignore' });
  try {
    if (existingWorktree) {
      execSync(`${REAL_GIT} worktree add --detach ${isoDir} HEAD >/dev/null 2>&1`, { cwd: sandbox.repo });
      fs.writeFileSync(marker, 'stage 2 work in progress\n');
    }
    fs.mkdirSync(staleLock);
    fs.writeFileSync(path.join(staleLock, 'pid'), `${owner.pid}\n`);
    const startRecorded = legacy ? null : `${procStartTime(owner.pid)}\n`;
    if (startRecorded) fs.writeFileSync(path.join(staleLock, 'start'), startRecorded);
    const snapshot = takeResidentSnapshot(sandbox);
    const result = runSandbox(sandbox, { HUNTERCARD_FORCE_ISOLATED: '1' });
    assertFailedClosedNoMutation(
      route,
      result,
      new RegExp(`child lock \\S+scrape\\.lock\\.stage2 is held by live pid ${owner.pid} \\(${legacy ? 'no recorded start time; running [^)]*local-scrape-and-push' : 'started [^)]+'}[^)]*\\); refusing to start a second delegated run`),
    );
    assert.deepEqual(pipelineOwners(result.lines), [], `${route}: no runPipeline may run`);
    assert.doesNotMatch(result.log, /✅ Done/, `${route}: must never report Done`);
    assert.doesNotMatch(result.log, /removing orphaned child lock/, `${route}: a live owner is never treated as an orphan`);
    assert.doesNotMatch(result.log, /removing stale isolated worktree/, `${route}: a live stage 2's worktree is never treated as stale`);
    assert.equal(someTraced(result.lines, 'git worktree'), false, `${route}: no worktree may be pruned, removed or added`);
    assert.equal(someTraced(result.lines, 'git fetch'), false, `${route}: fails before any other work`);
    assert.equal(fs.readFileSync(path.join(staleLock, 'pid'), 'utf-8'), `${owner.pid}\n`, `${route}: a live owner's lock must not be removed`);
    if (startRecorded) assert.equal(fs.readFileSync(path.join(staleLock, 'start'), 'utf-8'), startRecorded, `${route}: the owner's start time is kept`);
    if (existingWorktree) {
      assert.ok(fs.existsSync(marker), `${route}: the live stage 2's checkout must not be removed`);
      assert.equal(fs.readFileSync(marker, 'utf-8'), 'stage 2 work in progress\n', `${route}: the live stage 2's checkout must survive untouched`);
      const registered = execSync(`${REAL_GIT} worktree list --porcelain`, { cwd: sandbox.repo, encoding: 'utf-8' });
      assert.ok(
        registered.includes(`worktree ${isoDir}\n`) || registered.includes(`worktree ${fs.realpathSync(isoDir)}\n`),
        `${route}: the live stage 2's worktree must stay registered\n${registered}`,
      );
    } else {
      assert.equal(fs.existsSync(isoDir), false, `${route}: no ephemeral worktree is created`);
    }
    assertResidentUntouched(sandbox, snapshot);
  } finally {
    owner.kill('SIGKILL');
    cleanup(sandbox);
  }
}

// DD(h) (CR 4d3610a7): a live delegated child is detected before ANY work on
// every route — a live re-exec child runs in the resident checkout, so the
// clean in-place route must not fetch/fast-forward under it either; nor may a
// clean run start a second pipeline beside a live stage 2.
for (const [route, suffix, extraEnv] of [
  ['DD(h) clean in-place route, live re-exec lock owner', 'reexec', {}],
  ['DD(h) clean in-place route, live stage-2 lock owner', 'stage2', {}],
  ['DD(h) forced route, live re-exec lock owner', 'reexec', { HUNTERCARD_FORCE_ISOLATED: '1' }],
]) {
  const sandbox = makeSandbox();
  const isoDir = path.join(sandbox.dir, 'iso');
  const liveLock = path.join(sandbox.dir, `scrape.lock.${suffix}`);
  const owner = spawn('bash', ['-c', 'sleep 120; :', 'local-scrape-and-push.sh'], { stdio: 'ignore' });
  try {
    fs.mkdirSync(liveLock);
    fs.writeFileSync(path.join(liveLock, 'pid'), `${owner.pid}\n`);
    fs.writeFileSync(path.join(liveLock, 'start'), `${procStartTime(owner.pid)}\n`);
    const snapshot = takeResidentSnapshot(sandbox);
    const result = runSandbox(sandbox, extraEnv);
    assertFailedClosedNoMutation(
      route,
      result,
      new RegExp(`child lock \\S+scrape\\.lock\\.${suffix} is held by live pid ${owner.pid} \\(started [^)]+\\); refusing to start a second delegated run`),
    );
    assert.deepEqual(pipelineOwners(result.lines), [], `${route}: no runPipeline may run`);
    assert.doesNotMatch(result.log, /✅ Done/, `${route}: must never report Done`);
    assert.equal(someTraced(result.lines, 'git fetch'), false, `${route}: fails before fetching`);
    assert.equal(someTraced(result.lines, 'git pull'), false, `${route}: never fast-forwards under a live child`);
    assert.equal(someTraced(result.lines, 'git worktree'), false, `${route}: no worktree may be pruned, removed or added`);
    assert.equal(fs.existsSync(isoDir), false, `${route}: no ephemeral worktree is created`);
    assert.equal(fs.readFileSync(path.join(liveLock, 'pid'), 'utf-8'), `${owner.pid}\n`, `${route}: a live owner's lock must not be removed`);
    assert.equal(fs.existsSync(path.join(sandbox.dir, 'scrape.lock')), false, `${route}: the primary lock is released`);
    assertResidentUntouched(sandbox, snapshot);
  } finally {
    owner.kill('SIGKILL');
    cleanup(sandbox);
  }
}

// DD(d): a delegated child that collides with its lock fails closed (exit 1,
// FAILED) instead of the top-level "already running" exit 0 — for both the
// stage-2 and the in-place re-exec roles — and never removes the lock.
for (const [route, env, roleRe] of [
  ['DD(d) stage-2 lock collision', { HUNTERCARD_FORCE_ISOLATED_STAGE2: '1' }, /stage 2 lock \S+ already exists \(owner pid unrecorded\); a delegated child never skips/],
  ['DD(d) re-exec lock collision', { HUNTERCARD_SELF_REEXEC: '1' }, /re-executed run lock \S+ already exists \(owner pid unrecorded\); a delegated child never skips/],
]) {
  const sandbox = makeSandbox();
  const lock = path.join(sandbox.dir, 'child.lock');
  try {
    fs.mkdirSync(lock);
    const result = runSandbox(sandbox, { ...env, HUNTERCARD_LOCK_FILE: lock });
    assertFailedClosedNoMutation(route, result, roleRe);
    assert.doesNotMatch(result.log, /already running, skipping/, `${route}: a child never takes the skip path`);
    assert.equal(someTraced(result.lines, 'git fetch'), false, `${route}: fails before any other work`);
    assert.equal(fs.existsSync(lock), true, `${route}: a colliding child must not remove a lock it does not own`);
  } finally {
    cleanup(sandbox);
  }
}

// DD(e): a child that exits 0 WITHOUT doing its work (the exact shape of the
// old "already running" skip, or any premature success) must not be taken
// as a completed run by its parent — stage 1 on the forced route, and the
// in-place parent after a fast-forward re-exec.
function scriptWithInjectedLine(afterAnchor, line) {
  const src = fs.readFileSync(REAL_PIPELINE, 'utf-8');
  assert.ok(src.includes(afterAnchor), `harness: anchor must exist: ${afterAnchor}`);
  return src.replace(afterAnchor, `${afterAnchor}\n${line}`);
}
function advanceRemoteWith(sandbox, tag, content) {
  const other = path.join(sandbox.dir, `other-dd-${tag}`);
  execSync(`${REAL_GIT} clone -q ${sandbox.remote} ${other}`);
  fs.writeFileSync(path.join(other, 'scripts', 'local-scrape-and-push.sh'), content);
  execSync(`${REAL_GIT} add scripts/local-scrape-and-push.sh`, { cwd: other });
  execSync(`${REAL_GIT} -c user.email=o@example.com -c user.name=o -c commit.gpgsign=false commit -q -m "remote dd ${tag}"`, { cwd: other });
  execSync(`${REAL_GIT} push -q origin main`, { cwd: other });
}
for (const [route, extraEnv, anchor, failRe] of [
  [
    'DD(e) forced stage 2 exits 0 without a receipt',
    { HUNTERCARD_FORCE_ISOLATED: '1' },
    'if [ "${HUNTERCARD_FORCE_ISOLATED_STAGE2:-}" = "1" ]; then',
    /forced-isolated stage 2 exited 0 without this run's completion receipt[^\n]*; never Done on a bare exit status \(cron fails\)/,
  ],
  [
    'DD(e) in-place re-exec exits 0 without a receipt',
    {},
    '# In-place clean path.',
    /re-executed origin\/main script exited 0 without this run's completion receipt; never Done on a bare exit status \(cron fails\)/,
  ],
]) {
  const sandbox = makeSandbox();
  const isoDir = path.join(sandbox.dir, 'iso');
  try {
    const premature = anchor.startsWith('#')
      ? '[ "${HUNTERCARD_SELF_REEXEC:-}" = "1" ] && exit 0'
      : '  exit 0';
    advanceRemoteWith(sandbox, 'premature', scriptWithInjectedLine(anchor, premature));
    const snapshot = takeResidentSnapshot(sandbox);
    const { status, lines, log } = runSandbox(sandbox, extraEnv);
    assert.equal(status, 1, `${route}: must fail; got ${status}\n${log}`);
    assert.match(log, failRe, `${route}: exact receipt failure`);
    assert.match(log, /HUNTERCARD_SCRAPE_STATUS=FAILED/, `${route}: cron must observe FAILED`);
    assert.doesNotMatch(log, /✅ Done/, `${route}: must never report Done`);
    assert.equal(someTraced(lines, 'build-database.js'), false, `${route}: sanity — the child did no work`);
    assert.equal(someTraced(lines, 'push origin'), false, `${route}: nothing was pushed`);
    assert.equal(fs.existsSync(isoDir), false, `${route}: no ephemeral worktree remains`);
    if (!anchor.startsWith('#')) assertResidentUntouched(sandbox, snapshot);
  } finally {
    cleanup(sandbox);
  }
}

console.log('DIC-1219/DIC-1321/DIC-1334/DIC-1472(+CR-P1 alias/removal/post-link + resident fingerprint)/DIC-1167(CR 028f6a19 clean-path ff/ahead/push + fetch freshness; 09-30 origin-only orchestration W–AA; CR bced44d5 stage-2 attestation + freshness BB–CC; CR cb2b3b13 child lock + receipt DD; pid-reuse owner identity DD(c/f/g); CR 4d3610a7 live child lock before any work DD(c/h)) scheduler dirty-precondition + coverage-gate + no-op + parity + isolated-deps regression checks passed');
