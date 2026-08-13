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
 *   2. Ordering — on the success path the native asset must be regenerated AFTER
 *      the buy-price merge and BEFORE staging, so both files are committed
 *      atomically from the same canonical bytes.
 *   3. Real failure contract (DIC-998) — cases 1/2 drive control flow with a node
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
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE = path.join(__dirname, 'local-scrape-and-push.sh');

/**
 * Materialize a sandbox containing the real pipeline script plus `node`/`git`
 * shims that append every invocation to a trace file. `failOn` makes the node
 * shim exit non-zero for the script whose name contains that substring.
 */
function runPipeline({ failOn = null } = {}) {
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
  fs.writeFileSync(path.join(repo, 'data', 'yt-stats-history.json'), '{}\n');
  fs.writeFileSync(trace, '');

  fs.copyFileSync(PIPELINE, path.join(repo, 'scripts', 'local-scrape-and-push.sh'));

  // node shim: trace the invocation, optionally fail for one target script.
  fs.writeFileSync(
    path.join(bin, 'node'),
    `#!/bin/bash
echo "node $*" >> "$TRACE_FILE"
if [ -n "$FAIL_ON" ] && [[ "$*" == *"$FAIL_ON"* ]]; then exit 1; fi
exit 0
`,
    { mode: 0o755 },
  );

  // git shim: trace the invocation. `diff --stat` must print something so the
  // success path enters the commit branch.
  fs.writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/bash
echo "git $*" >> "$TRACE_FILE"
if [ "$1" = "diff" ]; then echo " data/database.json | 2 +-"; fi
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
      // Never touch the real cron lock at /tmp/huntercard-scrape.lock.
      HUNTERCARD_LOCK_FILE: path.join(dir, 'scrape.lock'),
    },
    encoding: 'utf-8',
  });

  const lines = fs.readFileSync(trace, 'utf-8').split('\n').filter(Boolean);
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: result.status, lines };
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
    path.join(repoScripts, 'generate-native-database.mjs'),
    `import fs from 'node:fs';\nfs.writeFileSync(process.env.NATIVE_MARKER, 'invoked');\n`,
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
if [ "$1" = "diff" ]; then echo " data/database.json | 2 +-"; fi
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

// ── 2. Ordering: native regen after the final canonical mutation, before staging ──
{
  const { status, lines } = runPipeline();

  assert.strictEqual(status, 0, 'pipeline must succeed when every step succeeds');

  const merge = indexOfCall(lines, 'merge-buy-prices.js');
  const native = indexOfCall(lines, 'generate-native-database.mjs');
  const add = indexOfCall(lines, 'git add');
  const commit = indexOfCall(lines, 'commit -m');
  const push = indexOfCall(lines, 'git push');

  for (const [name, idx] of [['merge-buy-prices', merge], ['generate-native-database', native], ['git add', add], ['git commit', commit], ['git push', push]]) {
    assert.ok(idx !== -1, `sanity: pipeline must invoke ${name}`);
  }
  assert.ok(
    merge < native,
    'native asset must be regenerated AFTER merge-buy-prices.js, the final writer of data/database.json (otherwise the committed native asset is stale — DIC-916 --check fails)',
  );
  assert.ok(
    native < add && add < commit && commit < push,
    'native regeneration must precede staging so canonical + native are committed atomically in one commit',
  );
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

console.log(
  'scrape pipeline OK — failed buy-price merge aborts before native generation and the commit path (proven with both a shim and the REAL merge-buy-prices.js on malformed canonical JSON); native regen runs after the final canonical mutation and before staging.',
);
