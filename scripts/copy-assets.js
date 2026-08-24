/**
 * copy-assets.js — Build 時複製圖片與靜態頁面到 dist/
 *
 * 在 Vercel build 流程中執行，確保靜態資源可以被 App 存取
 * 注意：此專案使用 "type": "module"，必須用 import 語法
 *
 * DIC-1140 blocker #3: this script MUST NOT copy `data/database.json` — that
 * file is the sanitizing writer's exclusive output (scripts/fix-html.js
 * routes it through `copyDatabaseFile → stripInternalAuditDatabase`, which
 * removes `_rawPricesArchive` and the DIC-1139 errata history). Copying the
 * raw canonical source here overwrote the sanitized artifact with the
 * pre-strip bytes, leaking `_rawPricesArchive` on every card and errata
 * labels on 28. `series-names.json` and `character-names-zh.json` are still
 * copied verbatim because they carry no internal-audit fields.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = process.env.DIST_DIR || path.join(PROJECT_DIR, 'dist');
const DB_DEST = path.join(DIST_DIR, 'data', 'database.json');

console.log('[copy-assets] Copying assets to dist/...');

// DIC-1140 belt-and-braces: refuse to run if the sanitizing writer hasn't
// produced dist/data/database.json yet. A run that would leave the wire
// without a database is a silent regression; failing fast here forces the
// operator to fix the ordering rather than ship a broken artifact.
if (!fs.existsSync(DB_DEST)) {
  throw new Error(
    '[copy-assets] Refusing to run: dist/data/database.json is missing. ' +
      'scripts/fix-html.js must run first to produce the sanitized artifact. ' +
      'Check vercel.json build sequence.',
  );
}

// Copy series-names.json
const seriesDbSource = path.join(PROJECT_DIR, 'data', 'series-names.json');
const seriesDbDest = path.join(DIST_DIR, 'data', 'series-names.json');

if (fs.existsSync(seriesDbSource)) {
  fs.mkdirSync(path.dirname(seriesDbDest), { recursive: true });
  fs.copyFileSync(seriesDbSource, seriesDbDest);
  console.log(`  ✅ series-names.json → dist/data/series-names.json`);
} else {
  console.log(`  ⚠️  series-names.json not found, skipping`);
}

// Copy character-names-zh.json
const zhDbSource = path.join(PROJECT_DIR, 'data', 'character-names-zh.json');
const zhDbDest = path.join(DIST_DIR, 'data', 'character-names-zh.json');

if (fs.existsSync(zhDbSource)) {
  fs.mkdirSync(path.dirname(zhDbDest), { recursive: true });
  fs.copyFileSync(zhDbSource, zhDbDest);
  console.log(`  ✅ character-names-zh.json → dist/data/character-names-zh.json`);
} else {
  console.log(`  ⚠️  character-names-zh.json not found, skipping`);
}

// Copy static HTML pages (privacy / support) so /privacy and /support rewrites resolve
const HTML_PAGES = ['privacy.html', 'support.html', 'pricing.html', 'terms.html'];
HTML_PAGES.forEach((file) => {
  const src = path.join(PROJECT_DIR, 'public', file);
  const dest = path.join(DIST_DIR, file);
  if (fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    console.log(`  ✅ ${file} → dist/${file}`);
  } else {
    console.log(`  ⚠️  public/${file} not found, skipping`);
  }
});

// Copy images
const imagesSource = path.join(PROJECT_DIR, 'data', 'images');
const imagesDest = path.join(DIST_DIR, 'images');

if (fs.existsSync(imagesSource)) {
  fs.mkdirSync(imagesDest, { recursive: true });

  const files = fs.readdirSync(imagesSource);
  let count = 0;
  files.forEach(file => {
    const srcPath = path.join(imagesSource, file);
    const dstPath = path.join(imagesDest, file);
    if (fs.statSync(srcPath).isFile()) {
      fs.copyFileSync(srcPath, dstPath);
      count++;
    }
  });
  console.log(`  ✅ ${count} images → dist/images/`);
} else {
  console.log(`  ⚠️  data/images/ not found, skipping`);
}

// Copy trends (per-card trend JSON + index.json)
// 前端 fetch '/data/trends/index.json' 與 '/data/trends/{cardId}.json'
const trendsSource = path.join(PROJECT_DIR, 'data', 'trends');
const trendsDest = path.join(DIST_DIR, 'data', 'trends');

if (fs.existsSync(trendsSource)) {
  fs.cpSync(trendsSource, trendsDest, { recursive: true });
  const trendCount = fs.readdirSync(trendsDest).length;
  console.log(`  ✅ ${trendCount} trend files → dist/data/trends/`);
} else {
  console.log(`  ⚠️  data/trends/ not found, skipping`);
}

console.log('[copy-assets] Done!');