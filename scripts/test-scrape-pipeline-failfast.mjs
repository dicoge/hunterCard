#!/usr/bin/env node
/**
 * test-scrape-pipeline-failfast.mjs — DIC-989 pipeline control-flow invariants.
 *
 * Runs the REAL scripts/local-scrape-and-push.sh in a throwaway tree with `node`
 * and `git` replaced by tracing shims, so the ordering and failure semantics are
 * proven behaviourally rather than by reading the source.
 *
 *   1. Fail-fast — when merge-buy-prices.js (the final writer of
 *      data/database.json) exits non-zero, the pipeline must abort BEFORE the
 *      native generator and before any git add/commit/push. Masking it with
 *      `|| echo` let a partial merge be committed as a stale canonical+native pair.
 *   2. Ordering — on the success path the native asset must be regenerated AFTER
 *      the buy-price merge and BEFORE staging, so both files are committed
 *      atomically from the same canonical bytes.
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

console.log(
  'scrape pipeline OK — failed buy-price merge aborts before native generation and the commit path; native regen runs after the final canonical mutation and before staging.',
);
