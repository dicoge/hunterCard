#!/usr/bin/env node
/**
 * test-scheduler-dirty-precondition.mjs — DIC-1219 CR follow-up.
 *
 * Runs the REAL `scripts/local-scrape-and-push.sh` inside a throwaway real
 * git repository and asserts the precondition check rejects ALL residue in
 * scraper-managed paths — tracked, staged AND untracked — BEFORE `git pull`,
 * any scraper mutation, or the commit path. Mac-Codex CR flagged: the old
 * `git diff --quiet` precondition only saw tracked staged/unstaged edits, so
 * a stale untracked `data/price-history/*.json` from a failed manual run
 * slipped through and the later broad `git add data/price-history/*.json`
 * glob bundled it into the automated `chore: update database` commit.
 *
 * Every scenario uses a real `git` binary so `git status --porcelain` really
 * classifies each file as it would in production. Shell shims for `node`,
 * `npm` and a few `git subcommand`s (pull / commit / push) trace their
 * invocations to a log so we can assert the pipeline aborted BEFORE reaching
 * them — that is the mutation-sensitive fail-closed proof.
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

/**
 * Materialise a sandbox with a real, initialised git repo containing the real
 * pipeline script. The sandbox's PATH intercepts `node` / `npm` invocations
 * plus a few git subcommands that would otherwise touch the network / write
 * commits — every intercepted call appends to a trace so the caller can assert
 * whether the pipeline reached the mutation/staging steps.
 */
function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dic1219-precond-'));
  const bin = path.join(dir, 'bin');
  const repo = path.join(dir, 'repo');
  const trace = path.join(dir, 'trace.log');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'data'), { recursive: true });
  fs.writeFileSync(trace, '');

  // Real git repo with an initial commit — `git status --porcelain` is only
  // meaningful once HEAD exists.
  execSync(`${REAL_GIT} init -q -b main`, { cwd: repo });
  execSync(`${REAL_GIT} config user.email test@example.com`, { cwd: repo });
  execSync(`${REAL_GIT} config user.name test`, { cwd: repo });
  fs.writeFileSync(path.join(repo, '.gitkeep'), '');
  execSync(`${REAL_GIT} add .gitkeep`, { cwd: repo });
  execSync(`${REAL_GIT} -c commit.gpgsign=false commit -q -m init`, { cwd: repo });

  fs.copyFileSync(REAL_PIPELINE, path.join(repo, 'scripts', 'local-scrape-and-push.sh'));
  fs.chmodSync(path.join(repo, 'scripts', 'local-scrape-and-push.sh'), 0o755);

  // node / npm shims: trace and exit 0. If the precondition is bypassed the
  // pipeline will call these; each entry in the trace proves a mutation
  // happened that the precondition failed to stop.
  fs.writeFileSync(
    path.join(bin, 'node'),
    `#!/bin/bash
echo "node $*" >> "$TRACE_FILE"
exit 0
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, 'npm'),
    `#!/bin/bash
echo "npm $*" >> "$TRACE_FILE"
exit 0
`,
    { mode: 0o755 },
  );

  // git wrapper: intercept just the network / commit subcommands so the
  // pipeline never talks to a remote nor writes real commits, but let every
  // other subcommand hit the REAL git so `git status --porcelain` runs its
  // real classifier over the sandbox tree.
  fs.writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/bash
echo "git $*" >> "$TRACE_FILE"
case "$1" in
  pull|push) exit 0 ;;
  commit)    exit 0 ;;
esac
exec ${REAL_GIT} "$@"
`,
    { mode: 0o755 },
  );

  return { dir, bin, repo, trace };
}

function runSandbox(sandbox) {
  const { bin, repo, trace } = sandbox;
  const result = spawnSync('bash', [path.join(repo, 'scripts', 'local-scrape-and-push.sh')], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: sandbox.dir,
      TRACE_FILE: trace,
      HUNTERCARD_LOCK_FILE: path.join(sandbox.dir, 'scrape.lock'),
    },
    encoding: 'utf-8',
  });
  const lines = fs.readFileSync(trace, 'utf-8').split('\n').filter(Boolean);
  return { status: result.status, lines };
}

function cleanup(sandbox) {
  fs.rmSync(sandbox.dir, { recursive: true, force: true });
}

const someTraced = (lines, needle) => lines.some((l) => l.includes(needle));

// ─── Case A: clean worktree — pipeline reaches the pull + scraper steps ─────
{
  const sandbox = makeSandbox();
  try {
    const { status, lines } = runSandbox(sandbox);
    assert.equal(status, 0, `clean worktree must exit 0; got ${status}`);
    assert.ok(someTraced(lines, 'git pull'), 'clean worktree must reach git pull');
    assert.ok(someTraced(lines, 'node build-database.js'), 'clean worktree must reach build-database.js');
  } finally {
    cleanup(sandbox);
  }
}

// ─── Case B: untracked residue under data/price-history/ — the specific ─────
//     class the CR flagged: leftover from a failed manual run that the broad
//     `git add data/price-history/*.json` glob would silently stage.
{
  const sandbox = makeSandbox();
  const residue = path.join(sandbox.repo, 'data', 'price-history', 'hFOO-001_hBAR_C_hFOO-001_C.json');
  fs.mkdirSync(path.dirname(residue), { recursive: true });
  fs.writeFileSync(residue, JSON.stringify({ cardId: 'stale', records: [{ date: '2000-01-01', price: 1 }] }));
  try {
    const { status, lines } = runSandbox(sandbox);
    assert.equal(status, 1, `untracked residue must fail-closed with exit 1; got ${status}`);
    // Pull / any node scraper / commit / push MUST NOT run.
    assert.equal(someTraced(lines, 'git pull'), false, 'git pull must not run when residue is present');
    assert.equal(someTraced(lines, 'node '), false, 'no node script may run when residue is present');
    assert.equal(someTraced(lines, 'npm '), false, 'no npm script may run when residue is present');
    assert.equal(someTraced(lines, 'git commit'), false, 'no commit may be created');
    assert.equal(someTraced(lines, 'git push'), false, 'no push may happen');
    // The residue file must still exist untouched — the pipeline must not
    // move / delete / stage it as a "cleanup".
    assert.ok(fs.existsSync(residue), 'residue file must remain untouched on-disk');
    const stillUntracked = execSync(`${REAL_GIT} status --porcelain -- data/price-history`, { cwd: sandbox.repo, encoding: 'utf-8' });
    assert.ok(stillUntracked.includes('?? data/price-history/'), `residue must still be untracked; got: ${stillUntracked}`);
  } finally {
    cleanup(sandbox);
  }
}

// ─── Case C: staged residue (added but not committed) — same fail-closed ────
{
  const sandbox = makeSandbox();
  const residue = path.join(sandbox.repo, 'data', 'price-history', 'hSTAGED-001_hFOO_C_hSTAGED-001_C.json');
  fs.mkdirSync(path.dirname(residue), { recursive: true });
  fs.writeFileSync(residue, '{}');
  execSync(`${REAL_GIT} add data/price-history/hSTAGED-001_hFOO_C_hSTAGED-001_C.json`, { cwd: sandbox.repo });
  try {
    const { status, lines } = runSandbox(sandbox);
    assert.equal(status, 1, `staged residue must fail-closed with exit 1; got ${status}`);
    assert.equal(someTraced(lines, 'git pull'), false, 'staged residue must not reach pull');
    assert.equal(someTraced(lines, 'node '), false, 'staged residue must not reach any node script');
  } finally {
    cleanup(sandbox);
  }
}

// ─── Case D: tracked-but-modified residue on data/database.json — same ─────
{
  const sandbox = makeSandbox();
  const dbFile = path.join(sandbox.repo, 'data', 'database.json');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  fs.writeFileSync(dbFile, '{}');
  execSync(`${REAL_GIT} add data/database.json`, { cwd: sandbox.repo });
  execSync(`${REAL_GIT} -c commit.gpgsign=false commit -q -m seed`, { cwd: sandbox.repo });
  fs.writeFileSync(dbFile, '{"dirty":true}'); // tracked & modified
  try {
    const { status, lines } = runSandbox(sandbox);
    assert.equal(status, 1, `tracked modification must fail-closed with exit 1; got ${status}`);
    assert.equal(someTraced(lines, 'git pull'), false, 'tracked modification must not reach pull');
  } finally {
    cleanup(sandbox);
  }
}

// ─── Case E: untracked file OUTSIDE scraper-managed paths — pipeline runs ──
//     Ambient noise in the worktree (editor swap file at the repo root, an
//     unrelated tmp directory) must not fail-close the scheduler — only paths
//     the scraper will mutate matter.
{
  const sandbox = makeSandbox();
  fs.writeFileSync(path.join(sandbox.repo, 'ambient.txt'), 'ambient noise');
  fs.mkdirSync(path.join(sandbox.repo, 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(sandbox.repo, 'tmp', 'scratch.json'), '{}');
  try {
    const { status, lines } = runSandbox(sandbox);
    assert.equal(status, 0, `ambient untracked noise outside scraper paths must not fail-close; got ${status}`);
    assert.ok(someTraced(lines, 'git pull'), 'ambient noise must not block pull');
    assert.ok(someTraced(lines, 'node build-database.js'), 'ambient noise must not block scraper');
  } finally {
    cleanup(sandbox);
  }
}

console.log('DIC-1219 scheduler dirty-precondition (tracked / staged / untracked residue) regression checks passed');
