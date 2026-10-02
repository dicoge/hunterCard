#!/usr/bin/env node
/**
 * test-scrape-pipeline-failfast.mjs — DIC-989 pipeline control-flow invariants.
 *
 * Runs the REAL scripts/local-scrape-and-push.sh in a throwaway tree, so the
 * ordering and failure semantics are proven behaviourally rather than by reading
 * the source.
 *
 *   1. Fail-fast — when merge-buy-prices.js (the final writer of
 *      data/database.json) exits non-zero, the pipeline must abort BEFORE the
 *      native generator and before any git add/commit/push. Masking it with
 *      `|| echo` let a partial merge be committed as a stale canonical+native pair.
 *   2. Required gate — after all data/native mutations and BEFORE staging,
 *      the pipeline must run test:market-fields and native --check so a database
 *      that CI would reject cannot be committed/pushed by the scheduler.
 *   3. Ordering — on the success path the native asset must be regenerated AFTER
 *      the buy-price merge and BEFORE the required gate/staging, so both files
 *      are committed atomically from the same canonical bytes.
 *   4. Real failure contract (DIC-998) — cases 1/2 drive control flow with a node
 *      shim, which cannot catch merge-buy-prices.js swallowing its own fatal error
 *      and exiting 0. This case runs the REAL merge-buy-prices.js under the REAL
 *      node against malformed canonical JSON and proves the real pipeline stops
 *      before native generation, staging, commit and push.
 *
 * Run: node scripts/test-scrape-pipeline-failfast.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE = path.join(__dirname, 'local-scrape-and-push.sh');
// DIC-1167 (2026-09-30): the scheduler proves it runs the committed script by
// comparing `git hash-object` of itself with `git rev-parse <rev>:<script>`.
// The shimmed git has no object store, so both resolve to this git blob id of
// the sandboxed (= committed) script.
const pipelineBytes = fs.readFileSync(PIPELINE);
const SCRIPT_BLOB = createHash('sha1')
  .update(`blob ${pipelineBytes.length}\0`)
  .update(pipelineBytes)
  .digest('hex');

/**
 * Materialize a sandbox containing the real pipeline script plus `node`/`git`
 * shims that append every invocation to a trace file. `failOn` makes the node
 * or npm shim exit non-zero for the command containing that substring.
 */
function runPipeline({ failOn = null, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dic989-pipeline-'));
  const bin = path.join(dir, 'bin');
  const repo = path.join(dir, 'repo');
  const trace = path.join(dir, 'trace.log');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  // Mirror the optional data paths the pipeline probes before staging; under
  // `set -e` a missing one would abort the run before the commit branch.
  for (const d of ['data', 'data/yt-subscribers', 'data/news-sentiment', 'data/trends']) {
    fs.mkdirSync(path.join(repo, d), { recursive: true });
  }
  // DIC-1472: the scheduler proves dependency readiness via real anchors
  // (puppeteer/cheerio package.json), not `-d node_modules`. Seed the anchors
  // so the forced-isolated cases pass the readiness contract: the `worktree
  // add` shim below copies this repo wholesale, so the ephemeral copy is
  // anchor-complete and takes the already-ready branch.
  for (const pkg of ['puppeteer', 'cheerio']) {
    fs.mkdirSync(path.join(repo, 'node_modules', pkg), { recursive: true });
    fs.writeFileSync(path.join(repo, 'node_modules', pkg, 'package.json'), `{"name":"${pkg}","version":"0.0.0-sandbox"}\n`);
  }
  fs.writeFileSync(path.join(repo, 'data', 'yt-stats-history.json'), '{}\n');
  fs.writeFileSync(trace, '');

  fs.copyFileSync(PIPELINE, path.join(repo, 'scripts', 'local-scrape-and-push.sh'));

  // node shim: trace the invocation, optionally fail for one target script.
  // DIC-1321: a "successful" build must actually emit data/database.json,
  // otherwise the missing-output coverage gate (which must FAIL, never skip)
  // would trip the success path. Write a minimal healthy db on success; the
  // FAIL_ON case exits 1 first so it still models a build that never produced
  // output.
  fs.writeFileSync(
    path.join(bin, 'node'),
    `#!/bin/bash
echo "node $*" >> "$TRACE_FILE"
# DIC-1167 (2026-09-29): record the run-budget env handed to build-database and
# model a slow build / hung news step so signal concurrency is observable.
if [[ "$*" == *"build-database.js"* ]]; then
  echo "BUILD_ENV stage=$HUNTERCARD_YUYU_STAGE_BUDGET_MS launch=$HUNTERCARD_YUYU_LAUNCH_BUDGET_MS seed=$HUNTERCARD_YUYU_ROTATION_SEED" >> "$TRACE_FILE"
  if [ -n "$BUILD_SLEEP" ]; then sleep "$BUILD_SLEEP"; fi
  echo "BUILD_FINISHED" >> "$TRACE_FILE"
fi
# CR 9e78edfc: "trap" models a writer still flushing its output after TERM,
# "ignore" one that ignores TERM entirely (only KILL stops it).
if [[ "$*" == *"scrape-news-sentiment.js"* ]] && [ "$SIGNALS_HANG" = "trap" ]; then
  trap 'sleep 1; echo "{\"torn\":1}" > data/yt-stats-history.json; echo WRITER_EXIT >> "$TRACE_FILE"; exit 0' TERM
  while :; do sleep 0.1; done
fi
if [[ "$*" == *"scrape-news-sentiment.js"* ]] && [ "$SIGNALS_HANG" = "ignore" ]; then trap '' TERM; exec sleep 30; fi
if [[ "$*" == *"scrape-news-sentiment.js"* ]] && [ -n "$SIGNALS_HANG" ]; then exec sleep 30; fi
if [ -n "$FAIL_ON" ] && [[ "$*" == *"$FAIL_ON"* ]]; then
  if [[ "$*" == *"build-database.js"* ]] && [ -n "$BUILD_DIC1334_COLLAPSE" ]; then
    echo "[DIC-1334] final canonical artifact collapsed priced-cardNumber coverage: scraped 1219 priced cardNumbers but final artifact only has 424 (< 50% floor 609). A transformation discarded yuyu price data; refusing to ship."
  fi
  exit 1
fi
if [[ "$*" == *"canonical_native_public"* ]] || [[ "$*" == *"MISMATCH"* ]]; then
  touch "$NATIVE_PARITY_MARKER"
  if [ -n "$FAIL_PARITY" ]; then exit 1; fi
  echo OK
  exit 0
fi
if { [[ "$*" == *"build-database.js"* ]] || [[ "$*" == *"sync-official-catalog-to-database.mjs"* ]]; } && [ -z "$SKIP_DB_WRITE" ]; then
  cat > "$(pwd)/data/database.json" <<'EOF'
{"lastUpdated":"t","totalCards":0,"cards":{}}
EOF
fi
if [[ "$*" == *"generate-native-database.mjs"* ]]; then
  mkdir -p "$(pwd)/public/data"
  cp "$(pwd)/data/database.json" "$(pwd)/public/data/database.json"
fi
exit 0
`,
    { mode: 0o755 },
  );

  // public/data/database.json must exist for the parity gate to parse it.
  fs.mkdirSync(path.join(repo, 'public', 'data'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'public', 'data', 'database.json'), '{"lastUpdated":"t","totalCards":0,"cards":{}}\n');

  fs.writeFileSync(
    path.join(bin, 'npm'),
    `#!/bin/bash
echo "npm $*" >> "$TRACE_FILE"
if [ -n "$FAIL_ON" ] && [[ "$*" == *"$FAIL_ON"* ]]; then exit 1; fi
exit 0
`,
    { mode: 0o755 },
  );

  // git shim: trace the invocation. `diff --stat` must print something so the
  // success path enters the commit branch (unless NO_CHANGES models a no-op
  // scrape). DIC-1461 additions:
  //   - `fetch` fails when FAIL_FETCH is set (pre-mutation fetch guard);
  //   - `rev-parse` resolves to a deterministic SHA that CHANGES once a
  //     commit has been traced, so the forced-isolated no-op detection
  //     (start SHA == end SHA) can be exercised both ways;
  //   - `worktree add` materialises the "worktree" by copying the sandbox
  //     repo, so stage 1 can re-execute the copied script;
  //   - `commit` drops a marker consumed by rev-parse.
  fs.writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/bash
echo "git $*" >> "$TRACE_FILE"
args=("$@")
while [ "\${args[0]}" = "-c" ] || [ "\${args[0]}" = "-C" ]; do args=("\${args[@]:2}"); done
cmd="\${args[0]}"
if [ "$cmd" = "fetch" ] && [ -n "$FAIL_FETCH" ]; then exit 1; fi
if [ "$cmd" = "hash-object" ]; then echo "$SCRIPT_BLOB"; exit 0; fi
if [ "$cmd" = "rev-parse" ] && [[ "$*" == *":scripts/local-scrape-and-push.sh"* ]]; then echo "$SCRIPT_BLOB"; exit 0; fi
# DIC-1167 (CR bced44d5): stage 2 proves it runs in stage 1's attested linked
# worktree. The copied "worktree" gets its own private git dir under the
# shared common dir and a detached HEAD; the resident is the main tree.
inWorktree=""
[ "$(pwd -P)" = "$(cd "$HUNTERCARD_ISOLATED_DIR" 2>/dev/null && pwd -P)" ] && inWorktree=1
if [ "$cmd" = "rev-parse" ] && [ "\${args[1]}" = "--show-toplevel" ]; then pwd -P; exit 0; fi
if [ "$cmd" = "rev-parse" ] && [ "\${args[1]}" = "--git-common-dir" ]; then mkdir -p "$FAKE_GIT_DIR"; echo "$FAKE_GIT_DIR"; exit 0; fi
if [ "$cmd" = "rev-parse" ] && [ "\${args[1]}" = "--absolute-git-dir" ]; then
  gd="$FAKE_GIT_DIR"; [ -n "$inWorktree" ] && gd="$FAKE_GIT_DIR/worktrees/forced"
  mkdir -p "$gd"; echo "$gd"; exit 0
fi
if [ "$cmd" = "symbolic-ref" ]; then [ -n "$inWorktree" ] && exit 1; echo refs/heads/main; exit 0; fi
if [ "$cmd" = "rev-parse" ]; then
  if [ -f "$COMMIT_MARKER" ]; then echo "feedfeedfeedfeedfeedfeedfeedfeedfeedfeed"; else echo "0123456789abcdef0123456789abcdef01234567"; fi
  exit 0
fi
if [ "$cmd" = "worktree" ]; then
  if [ "\${args[1]}" = "add" ]; then
    dest=""
    for a in "\${args[@]:2}"; do
      case "$a" in --*) ;; *) if [ -z "$dest" ]; then dest="$a"; else break; fi ;; esac
    done
    rm -rf "$dest"
    cp -R "$SANDBOX_REPO" "$dest"
  fi
  if [ "\${args[1]}" = "remove" ]; then rm -rf "\${args[\${#args[@]}-1]}"; fi
  exit 0
fi
if [ "$cmd" = "commit" ]; then touch "$COMMIT_MARKER"; exit 0; fi
# CR 367fad3a: model a signals restore that does not take. "dirty" = checkout
# fails and the output still differs from HEAD; "status" = the postcondition
# cannot be read; "unmatched" = checkout fails (path absent from HEAD) yet
# nothing is left to commit.
if [ -n "$RESTORE_FAIL" ] && [[ "$*" == *"data/yt-stats-history.json"* || "$*" == *"data/news-sentiment"* ]]; then
  if [ "$cmd" = "checkout" ]; then echo "error: pathspec did not match" >&2; exit 1; fi
  if [ "$cmd" = "status" ] && [ "$RESTORE_FAIL" = "dirty" ]; then echo " M data/yt-stats-history.json"; exit 0; fi
  if [ "$cmd" = "status" ] && [ "$RESTORE_FAIL" = "status" ]; then echo "fatal: index file corrupt" >&2; exit 128; fi
fi
if [ "$cmd" = "diff" ] && [[ "$*" == *"--stat"* ]] && [ -z "$NO_CHANGES" ]; then echo " data/database.json | 2 +-"; fi
if [ "$cmd" = "diff" ]; then exit 0; fi
exit 0
`,
    { mode: 0o755 },
  );

  const result = spawnSync('bash', [path.join(repo, 'scripts', 'local-scrape-and-push.sh')], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      TRACE_FILE: trace,
      FAIL_ON: failOn ?? '',
      NATIVE_PARITY_MARKER: path.join(dir, 'native-parity-invoked'),
      FAIL_PARITY: env.FAIL_PARITY ?? '',
      // DIC-1321: allow the red-before-green missing-output gate test to tell
      // the build-database shim to emit NO output.
      SKIP_DB_WRITE: env.SKIP_DB_WRITE ?? '',
      BUILD_DIC1334_COLLAPSE: env.BUILD_DIC1334_COLLAPSE ?? '',
      // DIC-1461: pre-mutation fetch guard + forced-isolated bootstrap knobs.
      FAIL_FETCH: env.FAIL_FETCH ?? '',
      NO_CHANGES: env.NO_CHANGES ?? '',
      COMMIT_MARKER: path.join(dir, 'commit-marker'),
      SCRIPT_BLOB,
      SANDBOX_REPO: repo,
      FAKE_GIT_DIR: path.join(dir, 'fake-git'),
      HUNTERCARD_FORCE_ISOLATED: env.HUNTERCARD_FORCE_ISOLATED ?? '',
      HUNTERCARD_ISOLATED_DIR: path.join(dir, 'forced-worktree'),
      // Never touch the real cron lock at /tmp/huntercard-scrape.lock.
      HUNTERCARD_LOCK_FILE: path.join(dir, 'scrape.lock'),
      // DIC-1167 (2026-09-29): run-budget knobs (never inherited from the caller).
      HUNTERCARD_RUN_STARTED_AT: env.HUNTERCARD_RUN_STARTED_AT ?? '',
      HUNTERCARD_RUN_BUDGET_SECONDS: env.HUNTERCARD_RUN_BUDGET_SECONDS ?? '',
      HUNTERCARD_POST_PRICE_RESERVE_SECONDS: env.HUNTERCARD_POST_PRICE_RESERVE_SECONDS ?? '',
      HUNTERCARD_POST_SIGNALS_RESERVE_SECONDS: env.HUNTERCARD_POST_SIGNALS_RESERVE_SECONDS ?? '',
      HUNTERCARD_YUYU_STAGE_BUDGET_MS: '',
      HUNTERCARD_YUYU_LAUNCH_BUDGET_MS: '',
      HUNTERCARD_YUYU_ROTATION_SEED: '',
      BUILD_SLEEP: env.BUILD_SLEEP ?? '',
      SIGNALS_HANG: env.SIGNALS_HANG ?? '',
      RESTORE_FAIL: env.RESTORE_FAIL ?? '',
      HUNTERCARD_SIGNALS_KILL_GRACE_SECONDS: env.HUNTERCARD_SIGNALS_KILL_GRACE_SECONDS ?? '',
    },
    encoding: 'utf-8',
  });

  const lines = fs.readFileSync(trace, 'utf-8').split('\n').filter(Boolean);
  const logDir = path.join(dir, '.hermes', 'logs');
  const log = fs.existsSync(logDir) ? fs.readdirSync(logDir).map((f) => fs.readFileSync(path.join(logDir, f), 'utf-8')).join('') : '';
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: result.status, lines, log };
}

const indexOfCall = (lines, needle) => lines.findIndex((l) => l.includes(needle));

/** Canonical bytes the real merge cannot parse. */
const MALFORMED_DB = '{ "cards": { truncated mid-write';

/**
 * Every script the pipeline invokes. Only merge-buy-prices.js runs for real here;
 * the rest are inert stubs so the surrounding steps neither scrape nor mutate.
 * generate-native-database.mjs records its invocation so we can prove it never runs.
 */
const PIPELINE_STUBS = [
  'scrape-official-cards.js', 'scrape-yt-stats.js', 'scrape-news-sentiment.js',
  'build-database.js', 'scrape-yt-subscribers.js', 'trend-analysis.js',
  'send-push-alerts.js', 'scrape-torecolo-buy.js', 'scrape-fullahead-buy.js',
  'generate-native-database.mjs',
];

/**
 * Same pipeline, but with the REAL node binary and the REAL merge-buy-prices.js
 * (plus its lib/) against malformed canonical JSON. A node shim can only model the
 * exit code we WISH the merger returned; this executes its actual contract.
 */
function runPipelineWithRealMerge() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dic989-realmerge-'));
  const bin = path.join(dir, 'bin');
  const repo = path.join(dir, 'repo');
  const trace = path.join(dir, 'trace.log');
  const nativeMarker = path.join(dir, 'native-invoked');
  const repoScripts = path.join(repo, 'scripts');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(repoScripts, { recursive: true });
  for (const d of ['data/buy-prices', 'data/yt-subscribers', 'data/news-sentiment', 'data/trends']) {
    fs.mkdirSync(path.join(repo, d), { recursive: true });
  }
  fs.writeFileSync(trace, '');

  fs.copyFileSync(PIPELINE, path.join(repoScripts, 'local-scrape-and-push.sh'));
  // The real merger and the module graph it imports.
  fs.copyFileSync(path.join(__dirname, 'merge-buy-prices.js'), path.join(repoScripts, 'merge-buy-prices.js'));
  fs.cpSync(path.join(__dirname, 'lib'), path.join(repoScripts, 'lib'), { recursive: true });

  for (const stub of PIPELINE_STUBS) {
    fs.writeFileSync(path.join(repoScripts, stub), 'process.exit(0);\n');
  }
  fs.writeFileSync(
    path.join(bin, 'npm'),
    `#!/bin/bash
echo "npm $*" >> "$TRACE_FILE"
exit 0
`,
    { mode: 0o755 },
  );

  // A fresh buy-price source, otherwise the merger no-ops before ever reading
  // canonical and the failure path is never reached.
  fs.writeFileSync(
    path.join(repo, 'data/buy-prices/torecolo-prices.json'),
    JSON.stringify({ 'hBP04-005': { buyPrice: 1200, rarity: null, timestamp: new Date().toISOString() } }),
  );
  fs.writeFileSync(path.join(repo, 'data/database.json'), MALFORMED_DB);
  fs.writeFileSync(path.join(repo, 'data/yt-stats-history.json'), '{}\n');

  // git alone is shimmed: the sandbox is not a repo, and this is how we observe
  // whether staging/commit/push were ever attempted.
  fs.writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/bash
echo "git $*" >> "$TRACE_FILE"
if [ "$1" = "diff" ] && [[ "$*" == *"--stat"* ]]; then echo " data/database.json | 2 +-"; fi
if [ "$1" = "diff" ]; then exit 0; fi
exit 0
`,
    { mode: 0o755 },
  );

  const result = spawnSync('bash', [path.join(repoScripts, 'local-scrape-and-push.sh')], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      TRACE_FILE: trace,
      NATIVE_MARKER: nativeMarker,
      HUNTERCARD_LOCK_FILE: path.join(dir, 'scrape.lock'),
    },
    encoding: 'utf-8',
  });

  const out = {
    status: result.status,
    lines: fs.readFileSync(trace, 'utf-8').split('\n').filter(Boolean),
    dbBytes: fs.readFileSync(path.join(repo, 'data/database.json'), 'utf-8'),
    nativeInvoked: fs.existsSync(nativeMarker),
  };
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

// ── 0a. Ordering: stale checkout must fetch + pull before official mutation ──
{
  const { status, lines } = runPipeline();
  assert.strictEqual(status, 0, 'pipeline must succeed when every step succeeds');
  const fetch = indexOfCall(lines, 'git fetch --write-fetch-head origin +refs/heads/main:refs/remotes/origin/main');
  const pull = indexOfCall(lines, 'git pull --ff-only origin main');
  const official = indexOfCall(lines, 'scrape-official-cards.js');
  assert.ok(fetch !== -1, 'pipeline must refresh origin/main before resolving the isolated-worktree baseline');
  assert.ok(pull !== -1, 'pipeline must ff-only pull from main before mutating tracked data');
  assert.ok(official !== -1, 'sanity: pipeline must still run official scraper');
  assert.ok(
    fetch < official && pull < official,
    'stale durable checkout convergence (fetch + pull) must happen before scrape-official-cards.js writes data/official artifacts',
  );
  const revParse = indexOfCall(lines, 'git rev-parse --verify --quiet refs/remotes/origin/main^{commit}');
  assert.ok(revParse !== -1 && fetch < revParse, 'remote head must be resolved AFTER the refresh fetch');
}

// ── 0aa. Fail-fast: a fetch failure must not fall through to a stale origin/main ──
{
  const { status, lines } = runPipeline({ env: { FAIL_FETCH: '1' } });
  assert.notStrictEqual(status, 0, 'pipeline must exit non-zero when the pre-mutation origin/main refresh fails');
  assert.ok(indexOfCall(lines, 'git fetch --write-fetch-head origin +refs/heads/main:refs/remotes/origin/main') !== -1, 'sanity: pipeline must attempt the pre-mutation fetch');
  for (const forbidden of ['scrape-official-cards.js', 'git worktree add', 'git add', 'commit -m', 'git push']) {
    assert.strictEqual(
      indexOfCall(lines, forbidden),
      -1,
      `a failed pre-mutation fetch must never reach mutation (found: ${forbidden})`,
    );
  }
}

// ── 0f. DIC-1461 forced-isolated bootstrap: success path ──
{
  const { status, lines } = runPipeline({ env: { HUNTERCARD_FORCE_ISOLATED: '1' } });
  assert.strictEqual(status, 0, `forced-isolated bootstrap must succeed when every step succeeds\ntrace:\n${lines.join('\n')}`);
  const fetch = indexOfCall(lines, 'git fetch --write-fetch-head origin +refs/heads/main:refs/remotes/origin/main');
  const worktreeAdd = indexOfCall(lines, 'git worktree add --detach');
  const official = indexOfCall(lines, 'scrape-official-cards.js');
  const handoffPush = lines.findIndex((l) => l.includes('git push origin HEAD:refs/heads/bot/scrape/'));
  assert.ok(fetch !== -1, 'stage 1 must refresh origin/main first');
  assert.ok(worktreeAdd !== -1, 'stage 1 must create the ephemeral worktree');
  assert.ok(official !== -1, 'stage 2 must run the pipeline (official scraper reached)');
  assert.ok(handoffPush !== -1, 'stage 2 must push the artifact to the auditable bot/scrape/<date> handoff branch');
  assert.ok(
    fetch < worktreeAdd && worktreeAdd < official && official < handoffPush,
    'forced-isolated ordering must be fetch → worktree → pipeline → handoff push',
  );
  // The cardinal rule: a forced-isolated run must NEVER push HEAD:main and
  // must never ff-pull the resident checkout.
  assert.strictEqual(indexOfCall(lines, 'push origin HEAD:main'), -1, 'forced-isolated must never push HEAD:main');
  assert.strictEqual(indexOfCall(lines, 'git pull --ff-only origin main'), -1, 'forced-isolated must never pull the resident checkout');
}

// ── 0g. DIC-1461 forced-isolated: fetch failure fails closed before any worktree ──
{
  const { status, lines } = runPipeline({ env: { HUNTERCARD_FORCE_ISOLATED: '1', FAIL_FETCH: '1' } });
  assert.notStrictEqual(status, 0, 'forced-isolated bootstrap must fail when the origin refresh fails');
  for (const forbidden of ['git worktree add', 'scrape-official-cards.js', 'git push']) {
    assert.strictEqual(
      indexOfCall(lines, forbidden),
      -1,
      `a failed forced-isolated fetch must never reach ${forbidden}`,
    );
  }
}

// ── 0h. DIC-1461 forced-isolated: a no-op pipeline must never push the baseline ──
{
  const { status, lines } = runPipeline({ env: { HUNTERCARD_FORCE_ISOLATED: '1', NO_CHANGES: '1' } });
  assert.notStrictEqual(status, 0, 'forced-isolated no-op (no data changes → no commit) must fail, never hand off the unchanged baseline');
  assert.ok(indexOfCall(lines, 'scrape-official-cards.js') !== -1, 'sanity: stage 2 pipeline ran');
  assert.strictEqual(
    lines.findIndex((l) => l.includes('git push')),
    -1,
    'a no-op forced-isolated run must never push anything',
  );
}

// ── 0i. DIC-1461 forced-isolated: a failed stage-2 build fails the bootstrap, no push ──
{
  const { status, lines } = runPipeline({ env: { HUNTERCARD_FORCE_ISOLATED: '1' }, failOn: 'build-database.js' });
  assert.notStrictEqual(status, 0, 'forced-isolated bootstrap must propagate a stage-2 build failure');
  assert.ok(indexOfCall(lines, 'build-database.js') !== -1, 'sanity: stage 2 reached build-database');
  for (const forbidden of ['commit -m', 'git push']) {
    assert.strictEqual(
      indexOfCall(lines, forbidden),
      -1,
      `a failed forced-isolated build must never reach ${forbidden}`,
    );
  }
}

// ── 0. Fail-fast: a failed canonical build must never be masked ──
{
  const { status, lines } = runPipeline({ failOn: 'build-database.js' });

  assert.notStrictEqual(
    status,
    0,
    'pipeline must exit non-zero when build-database.js fails required-field/translation validation',
  );
  assert.ok(
    indexOfCall(lines, 'build-database.js') !== -1,
    'sanity: the pipeline must actually invoke build-database.js',
  );
  for (const forbidden of [
    'scrape-yt-subscribers.js',
    'trend-analysis.js',
    'send-push-alerts.js',
    'merge-buy-prices.js',
    'git add',
    'git -c user.name',
    'commit -m',
    'git push',
  ]) {
    assert.strictEqual(indexOfCall(lines, forbidden), -1, `a failed build must never reach downstream mutation/commit path (found: ${forbidden})`);
  }
  assert.ok(indexOfCall(lines, 'sync-official-catalog-to-database.mjs') === -1, 'a non-DIC-1334 build failure must not enter the official-only fallback');
}

// ── 0c. DIC-1167 recovery: a DIC-1334 sell-price transform collapse must not
//        block official catalog publication ──
{
  const { status, lines } = runPipeline({
    failOn: 'build-database.js',
    env: { BUILD_DIC1334_COLLAPSE: '1' },
  });

  assert.strictEqual(
    status,
    0,
    'pipeline must recover a DIC-1334 yuyu sell-price transformation collapse through the official-only catalog fallback',
  );
  for (const required of [
    'build-database.js',
    'sync-official-catalog-to-database.mjs',
    'regen-buy-alignment.mjs',
    'generate-native-database.mjs',
    'test-official-catalog-sync.mjs',
    'verify-official-catalog-completeness.mjs',
    'git add',
    'commit -m',
    'git push',
  ]) {
    assert.ok(indexOfCall(lines, required) !== -1, `official-only fallback must reach ${required}`);
  }
}

// ── 0b. Red-before-green (DIC-1321): a build that "succeeds" but emits NO
//        data/database.json must FAIL the coverage gate, never report success ──
{
  const { status, lines } = runPipeline({ env: { SKIP_DB_WRITE: '1' } });

  assert.notStrictEqual(
    status,
    0,
    'pipeline must exit non-zero when build-database.js succeeds but produces NO data/database.json — missing output must not be treated as success',
  );
  assert.ok(
    indexOfCall(lines, 'build-database.js') !== -1,
    'sanity: the pipeline must actually invoke build-database.js',
  );
  // The coverage gate's own message lands in the cron LOG_FILE (not the shim
  // TRACE_FILE), so gate-reach is proven by status != 0 plus the downstream
  // commit steps never being traced: the missing-output refusal happened before
  // staging. Commit steps must never be reached.
  for (const forbidden of ['git add', 'commit -m', 'git push']) {
    assert.strictEqual(
      indexOfCall(lines, forbidden),
      -1,
      `missing-output failure must never reach downstream mutation/commit path (found: ${forbidden})`,
    );
  }
}

// ── 1. Fail-fast: a failed buy-price merge must never reach the commit path ──
{
  const { status, lines } = runPipeline({ failOn: 'merge-buy-prices.js' });

  assert.notStrictEqual(
    status,
    0,
    'pipeline must exit non-zero when merge-buy-prices.js fails (failure is currently masked, so partial data reaches the commit)',
  );
  assert.ok(
    indexOfCall(lines, 'merge-buy-prices.js') !== -1,
    'sanity: the pipeline must actually invoke merge-buy-prices.js',
  );
  assert.strictEqual(
    indexOfCall(lines, 'generate-native-database.mjs'),
    -1,
    'native asset must NOT be regenerated after a failed buy-price merge (it would be derived from partial canonical bytes)',
  );
  for (const forbidden of ['git add', 'git -c user.name', 'commit -m', 'git push']) {
    assert.strictEqual(
      indexOfCall(lines, forbidden),
      -1,
      `a failed buy-price merge must never reach the commit path (found: ${forbidden})`,
    );
  }
}

// ── 2. Ordering: native regen after the final canonical mutation, before gates/staging ──
{
  const { status, lines } = runPipeline();

  assert.strictEqual(status, 0, 'pipeline must succeed when every step succeeds');

  const merge = indexOfCall(lines, 'merge-buy-prices.js');
  const native = indexOfCall(lines, 'generate-native-database.mjs');
  const marketGate = indexOfCall(lines, 'npm run test:market-fields');
  const officialCompletenessGate = indexOfCall(lines, 'verify-official-catalog-completeness.mjs');
  // DIC-1249: buy-price provenance drift (buyPriceTimestamp lagging the source
  // by a day while values match) was invisible to test:market-fields + native
  // --check. Both buy-price gates must run inside the pre-push window so the
  // same class of drift can never be committed by the scheduler again.
  const buyPriceGate = indexOfCall(lines, 'npm run test:buy-price');
  const buyPriceRegenGate = indexOfCall(lines, 'npm run test:buy-price-regen');
  const nativeCheck = lines.findIndex((l) => l.includes('generate-native-database.mjs --check'));
  const add = indexOfCall(lines, 'git add');
  const commit = indexOfCall(lines, 'commit -m');
  const push = indexOfCall(lines, 'git push');

  for (const [name, idx] of [
    ['merge-buy-prices', merge],
    ['generate-native-database', native],
    ['official catalog completeness gate', officialCompletenessGate],
    ['test:market-fields gate', marketGate],
    ['test:buy-price gate', buyPriceGate],
    ['test:buy-price-regen gate', buyPriceRegenGate],
    ['native --check gate', nativeCheck],
    ['git add', add],
    ['git commit', commit],
    ['git push', push],
  ]) {
    assert.ok(idx !== -1, `sanity: pipeline must invoke ${name}`);
  }
  assert.ok(
    merge < native,
    'native asset must be regenerated AFTER merge-buy-prices.js, the final writer of data/database.json (otherwise the committed native asset is stale — DIC-916 --check fails)',
  );
  assert.ok(
    native < marketGate &&
      native < officialCompletenessGate &&
      officialCompletenessGate < marketGate &&
      marketGate < buyPriceGate &&
      buyPriceGate < buyPriceRegenGate &&
      buyPriceRegenGate < nativeCheck &&
      nativeCheck < add &&
      add < commit &&
      commit < push,
    'required data gates must run after final native regeneration and before staging/commit/push',
  );
}

// ── 2d. DIC-1334: canonical/public/native parity gate must run inside the
//       pre-push window, and a parity divergence must fail the pipeline before
//       any commit ──
{
  // Success path: parity gate is reached and does not block.
  const success = runPipeline();
  assert.strictEqual(success.status, 0, 'pipeline must succeed when parity matches');
  // The marker path is inside the sandbox dir which runPipeline cleans up; the
  // important observable is that the parity gate did not abort the success path
  // (status 0) and that the node shim received a parity invocation.
  assert.ok(
    success.lines.some((l) => l.includes('MISMATCH')),
    'sanity: parity-gate node invocation must be traced',
  );

  // Fail path: parity divergence forces non-zero exit before commit/push.
  const fail = runPipeline({ env: { FAIL_PARITY: '1' } });
  assert.notStrictEqual(
    fail.status,
    0,
    'pipeline must exit non-zero when canonical/native parity diverges (DIC-1334)',
  );
  for (const forbidden of ['git add', 'git -c user.name', 'commit -m', 'git push']) {
    assert.strictEqual(
      indexOfCall(fail.lines, forbidden),
      -1,
      `a parity failure must never reach the commit path (found: ${forbidden})`,
    );
  }
}

// ── 2e. Fail-fast: official catalog completeness failure must abort before commit ──
{
  const { status, lines } = runPipeline({ failOn: 'verify-official-catalog-completeness.mjs' });

  assert.notStrictEqual(
    status,
    0,
    'pipeline must exit non-zero when all-product official catalog completeness fails before commit/push',
  );
  assert.ok(
    indexOfCall(lines, 'verify-official-catalog-completeness.mjs') !== -1,
    'sanity: pipeline must actually invoke the official catalog completeness gate',
  );
  for (const forbidden of ['npm run test:market-fields', 'npm run test:buy-price', 'git add', 'git -c user.name', 'commit -m', 'git push']) {
    assert.strictEqual(
      indexOfCall(lines, forbidden),
      -1,
      `an official catalog completeness failure must never reach downstream gates/commit path (found: ${forbidden})`,
    );
  }
}

// ── 2b. Fail-fast: CI market-field failure must never reach the commit path ──
{
  const { status, lines } = runPipeline({ failOn: 'test:market-fields' });

  assert.notStrictEqual(
    status,
    0,
    'pipeline must exit non-zero when test:market-fields fails before commit/push',
  );
  assert.ok(
    indexOfCall(lines, 'npm run test:market-fields') !== -1,
    'sanity: pipeline must actually invoke the market-field gate',
  );
  assert.strictEqual(
    lines.findIndex((l) => l.includes('generate-native-database.mjs --check')),
    -1,
    'native --check must not run after a failed market-field gate',
  );
  for (const forbidden of ['git add', 'git -c user.name', 'commit -m', 'git push']) {
    assert.strictEqual(
      indexOfCall(lines, forbidden),
      -1,
      `a failed market-field gate must never reach the commit path (found: ${forbidden})`,
    );
  }
}

// ── 2c. Fail-fast: buy-price gates must abort before commit (DIC-1249) ──
for (const gate of ['test:buy-price', 'test:buy-price-regen']) {
  const { status, lines } = runPipeline({ failOn: gate });

  assert.notStrictEqual(
    status,
    0,
    `pipeline must exit non-zero when ${gate} fails before commit/push`,
  );
  assert.ok(
    indexOfCall(lines, `npm run ${gate}`) !== -1,
    `sanity: pipeline must actually invoke the ${gate} gate`,
  );
  for (const forbidden of ['git add', 'git -c user.name', 'commit -m', 'git push']) {
    assert.strictEqual(
      indexOfCall(lines, forbidden),
      -1,
      `a failed ${gate} gate must never reach the commit path (found: ${forbidden})`,
    );
  }
}

// ── 3. Real failure contract: the actual merge-buy-prices.js, no node shim ──
{
  const { status, lines, dbBytes, nativeInvoked } = runPipelineWithRealMerge();

  assert.notStrictEqual(
    status,
    0,
    'pipeline must exit non-zero when the REAL merge-buy-prices.js hits malformed canonical JSON (it caught the error and exited 0, so the shell guard never fired)',
  );
  assert.strictEqual(
    nativeInvoked,
    false,
    'native generator must NOT run after a real merge failure — it would regenerate the shipped asset from unusable canonical bytes',
  );
  for (const forbidden of ['git add', 'git -c user.name', 'commit -m', 'git push']) {
    assert.strictEqual(
      indexOfCall(lines, forbidden),
      -1,
      `a real merge failure must never reach the commit path (found: ${forbidden})`,
    );
  }
  assert.strictEqual(
    dbBytes,
    MALFORMED_DB,
    'a failed merge must leave data/database.json untouched rather than half-written',
  );
}

// ── 5. DIC-1167 (2026-09-29): run budget sizes the yuyu stage; signals run beside the build ──
{
  const startedAt = Date.now();
  const { status, lines } = runPipeline({
    env: { BUILD_SLEEP: '2', HUNTERCARD_RUN_BUDGET_SECONDS: '300', HUNTERCARD_POST_PRICE_RESERVE_SECONDS: '100' },
  });
  assert.strictEqual(status, 0, 'pipeline must succeed with the run budget in place');
  const envLine = lines.find((l) => l.startsWith('BUILD_ENV '));
  assert.ok(envLine, 'build-database must receive the run-budget env');
  const [, stage, launch, seed] = envLine.match(/stage=(\d+) launch=(\d+) seed=(\d+)/) ?? [];
  assert.ok(Number(stage) <= 200000 && Number(stage) >= 180000, `yuyu stage budget must be (300s budget - elapsed - 100s reserve), got ${envLine}`);
  assert.strictEqual(Number(launch), 45000, 'launch budget keeps its default when below the stage budget');
  assert.strictEqual(Number(seed), Math.floor(startedAt / 86400000), 'rotation seed is the UTC day number');

  const yt = indexOfCall(lines, 'scrape-yt-stats.js');
  const news = indexOfCall(lines, 'scrape-news-sentiment.js');
  const buildDone = lines.indexOf('BUILD_FINISHED');
  const refresh = indexOfCall(lines, 'refresh-yt-stats.mjs');
  const native = indexOfCall(lines, 'generate-native-database.mjs');
  assert.ok(yt !== -1 && news !== -1 && buildDone !== -1 && refresh !== -1, `signals/build/refresh must all run: ${lines.join(' | ')}`);
  assert.ok(yt < news, 'YT stats must still run before news sentiment (both write yt-stats-history.json)');
  assert.ok(news < buildDone, 'YT stats and news must run concurrently with build-database, not before/after it');
  assert.ok(buildDone < refresh && refresh < native, 'ytStats must be re-merged after the build and before native generation');
  assert.ok(refresh < indexOfCall(lines, 'scrape-yt-subscribers.js'), 'ytStats re-merge precedes downstream steps');
}
{
  // Budget already spent (e.g. slow official scrape) and a hung news step: the
  // yuyu stage gets the 1s floor, the hung signal is killed, and the run still
  // completes through every fail-closed gate instead of being killed from outside.
  const t0 = Date.now();
  const { status, lines, log } = runPipeline({
    env: { SIGNALS_HANG: '1', HUNTERCARD_RUN_STARTED_AT: String(Math.floor(Date.now() / 1000) - 1000) },
  });
  const elapsed = Date.now() - t0;
  assert.strictEqual(status, 0, `a killed signals job is non-fatal: ${log.slice(-800)}`);
  assert.ok(elapsed < 20000, `hung signals must be bounded by the run budget, took ${elapsed}ms`);
  assert.match(lines.find((l) => l.startsWith('BUILD_ENV ')) ?? '', /stage=1000 launch=1000 /, 'exhausted run budget floors the yuyu stage and clamps launch to it');
  assert.match(log, /exceeded the run budget; killed, all writers exited, restoring/, 'overrun must be logged');
  assert.match(log, /outputs restored to HEAD \(non-fatal\)/, 'a verified restore is non-fatal');
  for (const restored of ['git checkout -- data/yt-stats-history.json', 'git checkout -- data/news-sentiment', 'git clean -fq -- data/yt-stats-history.json data/news-sentiment', 'git status --porcelain --untracked-files=all -- data/yt-stats-history.json data/news-sentiment']) {
    assert.ok(indexOfCall(lines, restored) !== -1, `overrun outputs must be restored (${restored})`);
  }
  for (const required of ['refresh-yt-stats.mjs', 'generate-native-database.mjs --check', 'npm run test:market-fields', 'commit -m']) {
    assert.ok(indexOfCall(lines, required) !== -1, `run must still reach ${required}`);
  }
}
{
  // CR 9e78edfc: a writer that is still flushing yt-stats-history.json when
  // TERM lands must have exited before its outputs are restored — otherwise
  // its late write survives the restore and reaches the commit.
  const { status, lines, log } = runPipeline({
    env: { SIGNALS_HANG: 'trap', HUNTERCARD_RUN_STARTED_AT: String(Math.floor(Date.now() / 1000) - 1000) },
  });
  assert.strictEqual(status, 0, `a killed signals job is non-fatal: ${log.slice(-800)}`);
  const writerExit = lines.indexOf('WRITER_EXIT');
  const restore = indexOfCall(lines, 'git checkout -- data/yt-stats-history.json');
  assert.ok(writerExit !== -1, `the TERM-handling writer must be signalled: ${lines.join(' | ')}`);
  assert.ok(restore > writerExit, `outputs must be restored only after the writer exited: ${lines.join(' | ')}`);
  assert.ok(indexOfCall(lines, 'commit -m') > restore, 'commit follows the restore');
}
{
  // CR 9e78edfc: a writer that ignores TERM is KILLed after the grace period
  // and awaited before the restore; the run stays bounded and non-fatal.
  const t0 = Date.now();
  const { status, lines, log } = runPipeline({
    env: {
      SIGNALS_HANG: 'ignore',
      HUNTERCARD_SIGNALS_KILL_GRACE_SECONDS: '1',
      HUNTERCARD_RUN_STARTED_AT: String(Math.floor(Date.now() / 1000) - 1000),
    },
  });
  const elapsed = Date.now() - t0;
  assert.strictEqual(status, 0, `a KILLed signals job is non-fatal: ${log.slice(-800)}`);
  assert.ok(elapsed < 20000, `a TERM-ignoring writer must be KILLed after the grace, took ${elapsed}ms`);
  assert.match(log, /killed, all writers exited, restoring/, 'restore only after the whole group is gone');
  assert.ok(indexOfCall(lines, 'git checkout -- data/yt-stats-history.json') !== -1, 'outputs restored after KILL');
}
{
  // CR 367fad3a: a restore that does not take (checkout error swallowed, file
  // still torn) or cannot be verified must fail closed before any downstream
  // mutation, staging, commit or push.
  for (const mode of ['dirty', 'status']) {
    const { status, lines, log } = runPipeline({
      env: { SIGNALS_HANG: '1', RESTORE_FAIL: mode, HUNTERCARD_RUN_STARTED_AT: String(Math.floor(Date.now() / 1000) - 1000) },
    });
    assert.notStrictEqual(status, 0, `unverified signals restore (${mode}) must fail the run: ${log.slice(-800)}`);
    assert.match(log, mode === 'dirty' ? /still differ from HEAD after restore/ : /could not verify the killed signals outputs/, `fail-closed reason logged (${mode})`);
    assert.match(log, /signals join failed closed/, `runPipeline stops at the join (${mode})`);
    for (const forbidden of ['refresh-yt-stats.mjs', 'merge-buy-prices.js', 'generate-native-database.mjs', 'git add', 'commit -m', ' push ']) {
      assert.strictEqual(indexOfCall(lines, forbidden), -1, `${forbidden} must not run after an unverified restore (${mode}): ${lines.join(' | ')}`);
    }
  }
}
{
  // CR 367fad3a: a checkout error for a path absent from HEAD is harmless when
  // the postcondition proves nothing is left to commit.
  const { status, lines, log } = runPipeline({
    env: { SIGNALS_HANG: '1', RESTORE_FAIL: 'unmatched', HUNTERCARD_RUN_STARTED_AT: String(Math.floor(Date.now() / 1000) - 1000) },
  });
  assert.strictEqual(status, 0, `a verified-clean restore stays non-fatal: ${log.slice(-800)}`);
  assert.match(log, /restore: git checkout -- data\/yt-stats-history.json failed/, 'the checkout error is logged, not hidden');
  assert.ok(indexOfCall(lines, 'commit -m') !== -1, 'run still commits once the restore is verified');
}
{
  // A leaked start from another day is not this run's clock.
  const { status, lines } = runPipeline({ env: { HUNTERCARD_RUN_STARTED_AT: '1' } });
  assert.strictEqual(status, 0);
  const [, stage] = (lines.find((l) => l.startsWith('BUILD_ENV ')) ?? '').match(/stage=(\d+)/) ?? [];
  assert.ok(Number(stage) >= 445000 && Number(stage) <= 450000, `stale start ignored: 540s default budget - 90s reserve, got ${stage}`);
}

console.log(
  'scrape pipeline OK — failed build/merge/market gates abort before commit/push (real merge failure covered); native regen and required data gates run before staging.',
);