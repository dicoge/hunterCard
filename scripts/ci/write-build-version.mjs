#!/usr/bin/env node
/**
 * Write build-time release-parity evidence for the Web deployment (DIC-1401).
 *
 * Release parity ("is the commit live on Web Production the same commit mobile
 * Production was built from?") needs an authoritative "what am I serving" value
 * that does NOT add a Vercel serverless function. An api/* route counts as one
 * function per deployment (Hobby plan cap: 12) — PR #186 broke the two Vercel
 * projects by adding api/version.ts as the 13th. This script instead writes a
 * STATIC `dist/version.json` during the build: it is served from the output
 * directory like any other static asset, so it costs zero functions while
 * still carrying the exact commit/ref/env of the deployment that produced it.
 *
 * It is safe to run anywhere (local, CI, Vercel): unset system env vars are
 * written as null, and the script exits 0 regardless, because this file is a
 * debugging/evidence aid — the release-parity workflow treats nulls as
 * "unknown", never as "synced". Only Vercel supplies VERCEL_GIT_COMMIT_SHA /
 * VERCEL_GIT_COMMIT_REF / VERCEL_ENV; nothing here reads or echoes a secret.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = pathOfRepoRoot();

function pathOfRepoRoot() {
  const here = fileURLToPath(import.meta.url);
  // <root>/scripts/ci/write-build-version.mjs  ->  <root>
  return join(here, '..', '..', '..');
}

function main() {
  const distDir = join(ROOT, 'dist');
  mkdirSync(distDir, { recursive: true });

  const version = {
    sha: process.env.VERCEL_GIT_COMMIT_SHA || null,
    ref: process.env.VERCEL_GIT_COMMIT_REF || null,
    vercelEnv: process.env.VERCEL_ENV || null,
  };

  writeFileSync(
    join(distDir, 'version.json'),
    `${JSON.stringify(version, null, 2)}\n`,
    'utf-8',
  );

  // The deployment SHA is the value the release-parity workflow compares
  // against the mobile build's source SHA, so surface it in the log for a
  // human who is inspecting a build without a Vercel dashboard.
  // eslint-disable-next-line no-console
  console.log(
    `write-build-version: wrote dist/version.json sha=${version.sha} ref=${version.ref} vercelEnv=${version.vercelEnv}`,
  );
}

main();