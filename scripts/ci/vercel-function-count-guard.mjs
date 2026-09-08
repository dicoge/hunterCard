#!/usr/bin/env node
/**
 * Vercel serverless-function count guard (DIC-1401 CR round 2).
 *
 * Why this exists: PR #186 used `api/version.ts` as the release-parity web
 * SHA source. The two Vercel Hobby projects (holocard-hunter, holohunter-
 * staging) had been green with 12 serverless functions per deployment; adding
 * that api route as the 13th made BOTH deployments fail, with no public way
 * for a credential-less reviewer to learn that from the check status alone
 * (GitHub only surfaces "Deployment has failed"). Vercel's documented Hobby
 * cap is 12 serverless functions per deployment
 * (https://vercel.com/docs/functions/runtimes#functions-created-per-deployment).
 *
 * This guard makes that class of failure PUBLIC and ACTIONABLE on the PR: it
 * runs in the GitHub Validate job (no Vercel credentials needed), counts the
 * Node-runtime `api/*` route files that Vercel deploys as individual
 * serverless functions, and fails with a message stating exactly how many
 * functions exist and what the cap is — so a reviewer never again needs
 * dashboard access to diagnose "why did the deployments go red".
 *
 * It intentionally counts ONLY Node-runtime routes: on Vercel, each api route
 * file deploys as one serverless function, and the Node runtime is the one
 * this repo's routes use. Edge-runtime routes (image.ts, recognize-card.ts)
 * are a separate runtime/limit and are excluded.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Vercel Hobby plan: at most 12 serverless functions per deployment.
 * Double-check this against the actual Vercel plan before raising it.
 */
export const VERCEL_HOBBY_SERVERLESS_FUNCTION_LIMIT = 12;

/**
 * @param {string[]} routeFiles absolute or relative paths of api/*.ts files
 * @returns {{ node: string[], edge: string[], missingRuntime: string[], count: number }}
 */
export function classifyRouteRuntimes(routeFiles) {
  const node = [];
  const edge = [];
  const missingRuntime = [];
  for (const file of routeFiles) {
    const source = fs.readFileSync(file, 'utf-8');
    const runtime = source.match(/runtime:\s*['"](edge|nodejs)['"]/)?.[1];
    if (runtime === 'edge') {
      edge.push(file);
    } else if (runtime === 'nodejs') {
      node.push(file);
    } else {
      missingRuntime.push(file);
    }
  }
  return { node, edge, missingRuntime, count: node.length };
}

/**
 * Pure check over a classified result — all routes MUST declare a runtime
 * (fail-closed: an undeclared route is a latent 14th function) and the Node
 * count must not exceed the Hobby cap.
 * @returns {{ ok: boolean, reasons: string[], nodeCount: number, limit: number }}
 */
export function evaluateFunctionCount(classified, limit = VERCEL_HOBBY_SERVERLESS_FUNCTION_LIMIT) {
  const reasons = [];
  for (const file of classified.missingRuntime) {
    reasons.push(
      `${path.relative(ROOT, file)} declares no runtime; it must export config.runtime 'nodejs' or 'edge' so Vercel's function count is known`,
    );
  }
  if (classified.count > limit) {
    reasons.push(
      `${classified.count} Node-runtime api/* routes exceed the Vercel Hobby per-deployment serverless-function cap of ${limit}. The deployment would fail (both holocard-hunter and holohunter-staging previously broke exactly this way). Replace any new api route with a build-time static artifact (see scripts/ci/write-build-version.mjs) before adding more functions.`,
    );
  }
  return { ok: reasons.length === 0, reasons, nodeCount: classified.count, limit };
}

export function collectApiRouteFiles(apiDir) {
  const out = [];
  for (const entry of fs.readdirSync(apiDir, { withFileTypes: true })) {
    const full = path.join(apiDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '_lib') out.push(...collectApiRouteFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function main() {
  const apiDir = path.join(ROOT, 'api');
  const classified = classifyRouteRuntimes(collectApiRouteFiles(apiDir));
  const result = evaluateFunctionCount(classified);

  console.log(
    `vercel-function-count-guard: ${result.nodeCount} Node-runtime api/* functions (cap ${result.limit}); ` +
      `${classified.edge.length} edge-runtime, ${classified.missingRuntime.length} undeclared`,
  );
  if (result.reasons.length > 0) {
    console.error('❌ Vercel serverless-function count guard FAIL:');
    for (const r of result.reasons) console.error(`  - ${r}`);
    process.exit(1);
  }
  console.log('✅ Vercel serverless-function count guard passed (within the documented Hobby cap).');
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();