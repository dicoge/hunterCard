/**
 * Release-parity evidence endpoint (DIC-1401).
 *
 * This is the ONLY authoritative source for "what commit is this Web
 * deployment actually serving". `scripts/ci/release-parity.mjs` (and its
 * `release-parity-check` workflow) reads this endpoint to compare a Web
 * deployment's SHA against a mobile production build's source SHA and to
 * report an explicit synced / not-synced / unknown status — never a
 * guessed or assumed match.
 *
 * `VERCEL_GIT_COMMIT_SHA` / `VERCEL_GIT_COMMIT_REF` / `VERCEL_ENV` are Vercel
 * System Environment Variables, populated automatically on every Vercel
 * build; nothing here reads or echoes a secret.
 */
import { toNodeHandler } from './_lib/node-adapter';
import { resolveAppEnv } from '../src/config/appEnv';

export const config = { runtime: 'nodejs' };
export const maxDuration = 10;

async function webHandler(_req: Request): Promise<Response> {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || null;
  const ref = process.env.VERCEL_GIT_COMMIT_REF || null;
  const vercelEnv = process.env.VERCEL_ENV || null;

  return new Response(
    JSON.stringify({
      sha,
      ref,
      vercelEnv,
      // Lenient resolver on purpose: this endpoint is diagnostic evidence,
      // never a gate — an unresolved lane must still report (as
      // "production", the fail-closed default), not 500.
      appEnv: resolveAppEnv(),
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Evidence must always reflect the current deployment — never
        // stale-served from a CDN/browser cache.
        'Cache-Control': 'no-store',
      },
    },
  );
}

export default toNodeHandler(webHandler);
