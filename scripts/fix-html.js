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

// If manifest link already exists (public/index.html has it), skip re-adding
if (html.includes('manifest')) {
  console.log('PWA meta tags already present, skipping injection.');

  // Save the HTML (type=module fix applied above)
  fs.writeFileSync(htmlPath, html, 'utf-8');

  // Also copy database.json (needed by frontend search) — sanitized under Store MVP.
  const dbSource = path.join(__dirname, '..', 'data', 'database.json');
  const dbDest = path.join(distDir, 'data', 'database.json');
  if (fs.existsSync(dbSource)) {
    const { sanitized } = copyDatabaseFile(dbSource, dbDest, STORE_MVP);
    console.log(`  ✅ database.json → dist/data/database.json${sanitized ? ' (Store MVP sanitized)' : ''}`);
  } else {
    console.log('  ⚠️ database.json not found, skipping');
  }

  // Also copy series-names.json (needed by series search)
  const seriesDbSource = path.join(__dirname, '..', 'data', 'series-names.json');
  const seriesDbDest = path.join(distDir, 'data', 'series-names.json');
  if (fs.existsSync(seriesDbSource)) {
    fs.mkdirSync(path.dirname(seriesDbDest), { recursive: true });
    fs.copyFileSync(seriesDbSource, seriesDbDest);
    console.log('  ✅ series-names.json → dist/data/series-names.json');
  } else {
    console.log('  ⚠️ series-names.json not found, skipping');
  }

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
