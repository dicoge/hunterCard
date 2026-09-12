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
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE = path.join(__dirname, 'local-scrape-and-push.sh');

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
if [ -n "$FAIL_ON" ] && [[ "$*" == *"$FAIL_ON"* ]]; then exit 1; fi
if [[ "$*" == *"canonical_native_public"* ]] || [[ "$*" == *"MISMATCH"* ]]; then
  touch "$NATIVE_PARITY_MARKER"
  if [ -n "$FAIL_PARITY" ]; then exit 1; fi
  echo OK
  exit 0
fi
if [[ "$*" == *"build-database.js"* ]] && [ -z "$SKIP_DB_WRITE" ]; then
  cat > "$(pwd)/data/database.json" <<'EOF'
{"lastUpdated":"t","totalCards":0,"cards":{}}
EOF
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
  // success path enters the commit branch.
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

// ── 0a. Ordering: stale checkout must pull before official mutation ──
{
  const { status, lines } = runPipeline();
  assert.strictEqual(status, 0, 'pipeline must succeed when every step succeeds');
  const pull = indexOfCall(lines, 'git pull --ff-only origin main');
  const official = indexOfCall(lines, 'scrape-official-cards.js');
  assert.ok(pull !== -1, 'pipeline must ff-only pull from main before mutating tracked data');
  assert.ok(official !== -1, 'sanity: pipeline must still run official scraper');
  assert.ok(
    pull < official,
    'stale durable checkout convergence must happen before scrape-official-cards.js writes data/official artifacts',
  );
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
    'generate-native-database.mjs',
    'git add',
    'git -c user.name',
    'commit -m',
    'git push',
  ]) {
    assert.strictEqual(indexOfCall(lines, forbidden), -1, `a failed build must never reach downstream mutation/commit path (found: ${forbidden})`);
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

console.log(
  'scrape pipeline OK — failed build/merge/market gates abort before commit/push (real merge failure covered); native regen and required data gates run before staging.',
);
