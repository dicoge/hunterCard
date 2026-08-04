/**
 * Regression guard for DIC-886: production /api/* must never be swallowed by the
 * SPA catch-all rewrite (/(.*) -> /index.html).
 *
 * Background: PR #74 moved the auth endpoints to a DYNAMIC serverless route
 * (api/auth/[action].ts). Vercel resolves exact-path function files inside the
 * `handle: filesystem` phase (before user rewrites) but resolves DYNAMIC function
 * routes in a later phase — AFTER the vercel.json `rewrites`. A blanket catch-all
 * `/(.*)` -> `/index.html` therefore matches `/api/auth/me` first and returns the
 * SPA HTML instead of the function's JSON. The fix is a catch-all that structurally
 * refuses to match `/api/*` (negative lookahead), so those paths always fall
 * through to function resolution.
 *
 * This test asserts that invariant against vercel.json so the regression cannot
 * silently return. It is intentionally dependency-free; the source->RegExp
 * translation below is a conservative subset of Vercel's path-to-regexp that is
 * exact for the literal + explicit-regex-group patterns this project uses.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const vercelPath = path.join(__dirname, '..', 'vercel.json');

const config = JSON.parse(fs.readFileSync(vercelPath, 'utf-8'));
const rewrites = Array.isArray(config.rewrites) ? config.rewrites : [];

// Translate a vercel.json rewrite `source` into an anchored RegExp. The project
// only uses plain literal segments and explicit regex groups like `(.*)` /
// `((?!api/).*)`, which are already valid inside a JS RegExp, so we anchor the
// source as-is with an optional trailing slash (Vercel tolerates trailing `/`).
function sourceToRegExp(source) {
  return new RegExp('^' + source + '/?$');
}

function firstMatch(pathname) {
  for (const rule of rewrites) {
    if (sourceToRegExp(rule.source).test(pathname)) return rule;
  }
  return null;
}

const failures = [];
function check(cond, message) {
  if (!cond) failures.push(message);
}

// Every API path we ship. None may resolve to the SPA HTML.
const apiPaths = [
  '/api/auth/me',
  '/api/auth/login',
  '/api/auth/link',
  '/api/auth/unlink',
  '/api/auth/delete-account',
  '/api/auth/apple/register',
  '/api/hello',
  '/api/search',
  '/api/recognize-card',
  '/api/get-image',
  '/api/image',
  '/api/push/register',
  '/api/push/notify',
  '/api/push/watchlist',
  '/api/cron/update-db',
];

// Core invariant: no rewrite that targets /index.html may match any /api/* path.
const spaRewrites = rewrites.filter((r) => r.destination === '/index.html');
check(
  spaRewrites.length > 0,
  'Expected at least one SPA catch-all rewrite whose destination is /index.html',
);

for (const p of apiPaths) {
  for (const r of spaRewrites) {
    check(
      !sourceToRegExp(r.source).test(p),
      `API path ${p} is matched by SPA catch-all "${r.source}" -> ${r.destination} (would return HTML instead of the serverless function)`,
    );
  }
  // Stronger first-match check: the winning rewrite for an API path must never
  // rewrite it into the SPA.
  const winner = firstMatch(p);
  check(
    !winner || winner.destination !== '/index.html',
    `API path ${p} resolves to SPA via first-match rewrite ${winner ? `"${winner.source}" -> ${winner.destination}` : ''}`,
  );
}

// SPA (non-API) paths must still be served index.html so client routing works.
const spaPaths = ['/', '/index.html', '/cards', '/settings/profile', '/scan'];
for (const p of spaPaths) {
  const winner = firstMatch(p);
  check(
    winner && winner.destination === '/index.html',
    `SPA path ${p} did not resolve to /index.html (got ${winner ? winner.destination : 'no match'})`,
  );
}

// Preserve the privacy/support rewrites required by DIC-651.
check(
  firstMatch('/privacy')?.destination === '/privacy.html',
  '/privacy must rewrite to /privacy.html',
);
check(
  firstMatch('/support')?.destination === '/support.html',
  '/support must rewrite to /support.html',
);

if (failures.length > 0) {
  console.error('❌ vercel.json API routing regression:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}

console.log('✅ vercel.json API routing guard passed (' + apiPaths.length + ' API paths never resolve to SPA HTML).');
