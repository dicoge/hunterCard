#!/usr/bin/env node
/**
 * Reproduce the exact configured Vercel build in public CI (DIC-1401).
 *
 * Vercel's own preview/production failures have no public log line a
 * credential-less reviewer can read. This script runs the LITERAL
 * `vercel.json` buildCommand (nothing hard-coded) in a `preview` environment
 * and asserts the release-parity evidence artifact (`dist/version.json`) was
 * produced for the exact commit under test — so a failure in the configured
 * build sequence (guard, deployment-data gate, expo export, post-processors)
 * fails visibly and reproducibly in GitHub CI BEFORE Vercel reports it.
 *
 * The `VERCEL_ENV=preview` setting deliberately mirrors what Vercel passes to
 * Preview builds (the branch guard must not gate previews), which is also the
 * mode the currently-failing PR deployments use. Production-ref semantics are
 * covered separately by `test:vercel-branch-guard`.
 *
 * Env (as on a Vercel Preview build):
 *   VERCEL_GIT_COMMIT_SHA — immutable commit the deployment is built from.
 *   VERCEL_GIT_COMMIT_REF — ref/branch name (used for parity evidence only).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Test seam: allow a hermetic temp root instead of the repo (mutation tests
// must not touch the working tree's dist/).
const ROOT = path.resolve(
  process.env.REPRODUCE_VERCEL_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
);

function main() {
  const configPath = process.argv[2] || path.join(ROOT, 'vercel.json');
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  const buildCommand = config.buildCommand;
  if (typeof buildCommand !== 'string' || buildCommand.trim() === '') {
    console.error(`reproduce-vercel-build: ${configPath} has no buildCommand to reproduce`);
    process.exit(1);
  }

  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  const ref = process.env.VERCEL_GIT_COMMIT_REF || '<unset>';

  console.log(`reproduce-vercel-build: running configured buildCommand (VERCEL_ENV=preview, ref=${ref}, sha=${sha})`);
  console.log(`  $ ${buildCommand}`);

  const result = spawnSync('/bin/bash', ['-e', '-o', 'pipefail', '-c', buildCommand], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      VERCEL_ENV: 'preview',
      VERCEL_GIT_COMMIT_SHA: sha || '',
      VERCEL_GIT_COMMIT_REF: ref || '',
      // Resolve `expo` / `node`-adjacent commands like `npm run` does: the
      // project's own node_modules/.bin must win over any global CLI (a stale
      // global expo-cli otherwise shadows the local expo and the reproduction
      // fails for the wrong reason). Vercel's build image resolves the same
      // way.
      PATH: [path.join(ROOT, 'node_modules', '.bin'), process.env.PATH].filter(Boolean).join(path.delimiter),
    },
  });

  if (result.error) {
    console.error(`reproduce-vercel-build: failed to run buildCommand: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`reproduce-vercel-build: configured Vercel buildCommand FAILED (exit ${result.status}) — this exact command is what Vercel runs per deployment.`);
    process.exit(result.status || 1);
  }

  const versionPath = path.join(ROOT, 'dist', 'version.json');
  if (!existsSync(versionPath)) {
    console.error('reproduce-vercel-build: buildCommand exited 0 but dist/version.json was NOT produced — release-parity evidence is missing from the configured build.');
    process.exit(1);
  }
  const version = JSON.parse(readFileSync(versionPath, 'utf-8'));
  if (sha && version.sha !== sha) {
    console.error(`reproduce-vercel-build: dist/version.json records sha=${version.sha}, expected ${sha}. The parity evidence does not match the commit under test. Params: ${Object.keys(version).map((k) => `${k}=${version[k]}`).join(', ')}`);
    process.exit(1);
  }

  console.log(`reproduce-vercel-build: ✅ configured Vercel buildCommand reproduced (exit 0); dist/version.json sha=${version.sha} ref=${version.ref} vercelEnv=${version.vercelEnv}`);
}

main();