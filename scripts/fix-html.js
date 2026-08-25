/**
 * Post-build script: injects PWA meta tags into Expo's generated index.html
 * and copies public assets to dist/
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { copyDatabaseFile, resolveStoreMvpFromEnv } from './lib/store-mvp-sanitize.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '../dist');
const publicDir = path.join(__dirname, '../public');

// Store MVP web exports must fail closed: the shipped database.json is sanitized
// so forbidden advanced fields never reach the client (CR DIC-913 #1). Full web
// production (env off/unset) copies the database byte-identically.
const STORE_MVP = resolveStoreMvpFromEnv();

// DIC-1189: staging-only HTML head injections. Mirrors the fail-closed rule in
// src/config/appEnv.ts — only APP_ENV / EXPO_PUBLIC_APP_ENV literally equal to
// 'staging' (case-insensitive, trimmed) enables the injections; anything else
// (unset, unknown, mistyped, or literally 'production') leaves the HTML
// byte-identical to what shipped before. `VERCEL_GIT_COMMIT_SHA` is set by
// Vercel per deployment.
function resolveAppEnvForHtml() {
  const raw = String(
    process.env.APP_ENV || process.env.EXPO_PUBLIC_APP_ENV || '',
  )
    .trim()
    .toLowerCase();
  return raw === 'staging' ? 'staging' : 'production';
}
const IS_STAGING_HTML = resolveAppEnvForHtml() === 'staging';
const STAGING_SHA_HTML = String(
  process.env.EXPO_PUBLIC_STAGING_SHA || process.env.VERCEL_GIT_COMMIT_SHA || '',
)
  .trim()
  .slice(0, 12);

// Read the generated index.html
const htmlPath = path.join(distDir, 'index.html');
let html = fs.readFileSync(htmlPath, 'utf-8');

// Copy manifest.json to dist
fs.copyFileSync(
  path.join(publicDir, 'manifest.json'),
  path.join(distDir, 'manifest.json')
);

// Add type="module" to all bundle script tags (fixes import.meta outside module error)
html = html.replace(
  /<script\s+src="(\/_expo\/static\/js\/web\/.*?)"\s+defer><\/script>/g,
  '<script type="module" src="$1" defer></script>'
);

// DIC-1189: inject staging-only <meta> tags before either the early "manifest
// already present" exit or the PWA-injection fallthrough. Robots noindex,
// nofollow keeps the staging URL out of Google/Bing; the app-env and
// staging-sha metas make the environment auditable via a plain `curl -sI …`
// and let the client-side StagingBanner surface the deployed SHA. Idempotent
// via the `name="app-env"` fingerprint. Production builds skip this entirely
// so the emitted HTML is byte-identical to what shipped before.
if (IS_STAGING_HTML && !html.includes('name="app-env"')) {
  const stagingHead =
    '\n    <meta name="robots" content="noindex,nofollow" />' +
    '\n    <meta name="googlebot" content="noindex,nofollow" />' +
    '\n    <meta name="app-env" content="staging" />' +
    `\n    <meta name="staging-sha" content="${STAGING_SHA_HTML || 'unknown'}" />`;
  html = html.replace('</head>', `${stagingHead}\n  </head>`);
  console.log(`  ✅ staging <meta> injected (sha=${STAGING_SHA_HTML || 'unknown'})`);
} else if (IS_STAGING_HTML) {
  console.log('  ✅ staging <meta> already present, skipping re-injection');
}

// DIC-1140 blocker #3: the sanitizing database copy MUST run on every branch.
// Previously this call lived inside the "manifest already present" branch and
// wasn't reached when Expo's index.html lacked <manifest>. Even when it did
// run, scripts/copy-assets.js later byte-copied the RAW data/database.json on
// top of the sanitized artifact — so `_rawPricesArchive` leaked to every card
// and 28 cards carried errata labels in the shipped bytes. Hoisting the
// sanitize call above the branch AND deleting the database copy from
// copy-assets.js makes fix-html.js the SOLE producer of
// dist/data/database.json; copy-assets.js now fails closed if that file is
// missing at run time.
{
  const dbSource = path.join(__dirname, '..', 'data', 'database.json');
  const dbDest = path.join(distDir, 'data', 'database.json');
  if (fs.existsSync(dbSource)) {
    const { sanitized } = copyDatabaseFile(dbSource, dbDest, STORE_MVP);
    console.log(
      `  ✅ database.json → dist/data/database.json (${sanitized ? 'Store MVP sanitized' : 'internal-audit stripped'})`,
    );
  } else {
    console.log('  ⚠️ database.json not found, skipping');
  }
  const seriesDbSource = path.join(__dirname, '..', 'data', 'series-names.json');
  const seriesDbDest = path.join(distDir, 'data', 'series-names.json');
  if (fs.existsSync(seriesDbSource)) {
    fs.mkdirSync(path.dirname(seriesDbDest), { recursive: true });
    fs.copyFileSync(seriesDbSource, seriesDbDest);
    console.log('  ✅ series-names.json → dist/data/series-names.json');
  } else {
    console.log('  ⚠️ series-names.json not found, skipping');
  }
}

// If manifest link already exists (public/index.html has it), skip re-adding
if (html.includes('manifest')) {
  console.log('PWA meta tags already present, skipping injection.');
  // Save the HTML (type=module fix applied above)
  fs.writeFileSync(htmlPath, html, 'utf-8');
  console.log('Script tags fixed (type=module added).');
  process.exit(0);
}

// Inject PWA meta tags and Apple-specific tags before </head>
const pwaTags = `
    <!-- PWA -->
    <link rel="manifest" href="/manifest.json" />
    <meta name="theme-color" content="#ffffff" />
    
    <!-- iOS Safari PWA meta tags -->
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="apple-mobile-web-app-title" content="HoloHunter" />
    <link rel="apple-touch-icon" href="/favicon.ico" />
  `;

html = html.replace('</head>', pwaTags + '\n  </head>');
fs.writeFileSync(htmlPath, html, 'utf-8');
console.log('PWA meta tags injected into dist/index.html');
