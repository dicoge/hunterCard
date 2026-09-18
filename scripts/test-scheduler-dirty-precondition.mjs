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
 * Shell shims for `node`, `npm` and a few git subcommands trace their
 * invocations to a log so we can assert ordering + that the resident checkout
 * was not mutated.
 *
 * Run: node scripts/test-scheduler-dirty-precondition.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
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

function runSandbox(sandbox, extraEnv = {}) {
  const { bin, repo, trace, dir } = sandbox;
  const result = spawnSync('bash', [path.join(repo, 'scripts', 'local-scrape-and-push.sh')], {
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

// Snapshot the resident checkout's mutable identity before a run so
// assertResidentUntouched can prove immutability afterwards.
function takeResidentSnapshot(sandbox) {
  return {
    head: execSync(`${REAL_GIT} rev-parse HEAD`, { cwd: sandbox.repo, encoding: 'utf-8' }).trim(),
    anchors: Object.fromEntries(DEP_ANCHOR_PACKAGES.map((pkg) => {
      const p = path.join(sandbox.repo, 'node_modules', pkg, 'package.json');
      return [pkg, fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null];
    })),
  };
}

function assertResidentUntouched(sandbox, snapshot) {
  const headAfter = execSync(`${REAL_GIT} rev-parse HEAD`, { cwd: sandbox.repo, encoding: 'utf-8' }).trim();
  assert.equal(headAfter, snapshot.head, 'resident HEAD must not move');
  assert.ok(
    !fs.lstatSync(path.join(sandbox.repo, 'node_modules')).isSymbolicLink(),
    'resident node_modules must remain a real directory, never be replaced by a link',
  );
  for (const f of TRACKED_SHELL_FILES) {
    assert.ok(
      fs.existsSync(path.join(sandbox.repo, 'node_modules', 'expo-camera', 'build', 'web', f)),
      `tracked shell file node_modules/expo-camera/build/web/${f} must remain in the resident checkout`,
    );
  }
  for (const [pkg, bytes] of Object.entries(snapshot.anchors)) {
    if (bytes === null) continue;
    assert.equal(
      fs.readFileSync(path.join(sandbox.repo, 'node_modules', pkg, 'package.json'), 'utf-8'),
      bytes,
      `resident anchor node_modules/${pkg}/package.json must stay byte-identical`,
    );
  }
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
  try {
    const { status, lines, log } = runSandbox(sandbox, forced ? { HUNTERCARD_FORCE_ISOLATED: '1' } : {});
    const route = forced ? 'forced-isolated' : 'dirty-isolated';
    assert.equal(status, 1, `${route}: missing resident anchor must fail the scheduler; got ${status}\n${log}`);
    assert.match(log, /missing required anchor puppeteer\/package\.json/, `${route}: log must name the missing anchor`);
    assert.match(log, /HUNTERCARD_SCRAPE_STATUS=FAILED/, `${route}: cron must observe the FAILED marker`);
    assert.equal(someTraced(lines, 'scrape-official-cards.js'), false, `${route}: must fail BEFORE any scraper runs`);
    assert.equal(someTraced(lines, 'build-database.js'), false, `${route}: must fail BEFORE the build runs`);
    assert.equal(someTraced(lines, 'push origin'), false, `${route}: must not push anything`);
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
  try {
    const { status, lines, log } = runSandbox(sandbox);
    assert.equal(status, 1, `failed symlink creation must fail the scheduler; got ${status}\n${log}`);
    assert.ok(someTraced(lines, 'ln -s'), 'sanity: the symlink attempt must actually have been made');
    assert.match(log, /could not create node_modules symlink/, 'log must carry the symlink-failure reason');
    assert.match(log, /HUNTERCARD_SCRAPE_STATUS=FAILED/, 'cron must observe the FAILED marker');
    assert.equal(someTraced(lines, 'build-database.js'), false, 'must fail BEFORE the build runs');
    assert.equal(someTraced(lines, 'push origin'), false, 'must not push anything');
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
  try {
    const { status, lines, log } = runSandbox(sandbox, { DECOY_DIR: decoy });
    assert.equal(status, 1, `unsafe symlink target must fail the scheduler; got ${status}\n${log}`);
    assert.match(log, /unsafe target, failing closed/, 'log must carry the unsafe-target reason');
    assert.match(log, /HUNTERCARD_SCRAPE_STATUS=FAILED/, 'cron must observe the FAILED marker');
    assert.equal(someTraced(lines, 'build-database.js'), false, 'must never build on an unverified dependency target');
    assert.equal(someTraced(lines, 'push origin'), false, 'must not push anything');
  } finally {
    cleanup(sandbox);
  }
}

console.log('DIC-1219/DIC-1321/DIC-1334/DIC-1472 scheduler dirty-precondition + coverage-gate + no-op + parity + isolated-deps regression checks passed');
