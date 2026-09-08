#!/usr/bin/env node
/**
 * Native-bundle origin regression gate (DIC-1245).
 *
 * The bug this guards against: a Production APK whose native executable code
 * still hardcodes `holocard-hunter.vercel.app` as the API host. That alias is
 * NOT the canonical production origin (`holohunter.dicoge.com`) and does not
 * serve the current KV-backed auth / recognition / push endpoints, so any
 * fallback into it silently drops the user's session, alerts, and scan
 * results. versionCode 6 shipped in exactly this state (see the DIC-1245 bundle
 * audit).
 *
 * The invariant this test enforces:
 *
 *   No executable source path that ends up in the native / edge bundle may
 *   contain the literal string `holocard-hunter.vercel.app`. The canonical
 *   production origin `holohunter.dicoge.com` must be reached via the shared
 *   `PRODUCTION_ORIGIN` constant in `src/config/apiOrigin.ts`.
 *
 * We scan file bodies directly rather than the exported bundle because:
 *   • the exported bundle is bit-identical to the source strings (Metro does
 *     not rewrite hostnames), so a source-level scan is a superset of a bundle
 *     scan and finishes in <1s instead of >30s;
 *   • auth/register/notify hosts live in several places (native services, the
 *     edge database URL, cron scripts), and any of them regressing is a P0.
 *
 * Historical documentation, CI workflow files (Vercel setup, not shipped),
 * `.env.example` comments, and this test itself are explicitly allowed to
 * mention the old hostname. Anything else is a hard fail.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Match the URL form (`https://holocard-hunter.vercel.app…`) rather than the
// bare hostname: comments and negative assertions in other tests legitimately
// name the old alias to explain WHY it's forbidden, and only a real URL string
// literal can reach a runtime fetch. Anything a bundle would ship carries the
// scheme, so this catches every executable regression while leaving prose alone.
const FORBIDDEN_URL_RE = /https?:\/\/holocard-hunter\.vercel\.app/;
const FORBIDDEN = 'holocard-hunter.vercel.app';
const CANONICAL = 'holohunter.dicoge.com';

// Directories to scan. Deliberately narrow: these are the paths whose file
// bodies end up in an executable — the native Expo bundle (`src/`, `app.*`,
// `index.ts`), the Vercel edge / node functions (`api/`), or the operational
// scripts that run against production KV (`scripts/`).
const SCAN_DIRS = ['src', 'api', 'scripts'];
const SCAN_ROOT_FILES = ['app.config.js', 'app.base.json', 'index.ts'];

// Extensions treated as "executable" for the purposes of this gate. HTML lives
// in public/ (web-only, and the DIC-1157 test already covers it); JSON assets
// under data/ are scraper output not committed source.
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json']);

// Files that are explicitly allowed to mention the old hostname. Only add to
// this list when the mention CANNOT reach a production bundle — historical
// docs, CI workflow snippets that curl the old alias for smoke-checks, this
// test itself, and the `.env.example` comment that documents a variable name.
const ALLOWLIST = new Set([
  path.join('scripts', 'test-native-bundle-origin.mjs'),
]);

/** Recursively yield every file under `dir` whose extension is in CODE_EXT. */
function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (CODE_EXT.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

const files = [];
for (const dir of SCAN_DIRS) {
  const abs = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  files.push(...walk(abs));
}
for (const rel of SCAN_ROOT_FILES) {
  const abs = path.join(REPO_ROOT, rel);
  if (fs.existsSync(abs)) files.push(abs);
}

const offenders = [];
for (const file of files) {
  const rel = path.relative(REPO_ROOT, file);
  if (ALLOWLIST.has(rel)) continue;
  const body = fs.readFileSync(file, 'utf8');
  if (FORBIDDEN_URL_RE.test(body)) {
    const lines = body.split('\n');
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      if (FORBIDDEN_URL_RE.test(lines[i])) hits.push(`  ${rel}:${i + 1}  ${lines[i].trim()}`);
    }
    if (hits.length > 0) offenders.push({ rel, hits });
  }
}

if (offenders.length > 0) {
  const summary = offenders
    .map((o) => `${o.rel}:\n${o.hits.join('\n')}`)
    .join('\n\n');
  assert.fail(
    `DIC-1245 regression: ${FORBIDDEN} found in executable source paths.\n` +
    `Production native bundles must resolve to ${CANONICAL} via PRODUCTION_ORIGIN\n` +
    `(src/config/apiOrigin.ts). The old vercel.app alias does not host the current\n` +
    `KV-backed auth / recognition / push endpoints and silently breaks the APK.\n\n` +
    `Offending occurrences:\n${summary}`,
  );
}

// Positive assertion: the canonical origin MUST be present in the shared
// constants module, so this gate is not silently a no-op if the module is
// deleted or emptied.
const apiOriginPath = path.join(REPO_ROOT, 'src', 'config', 'apiOrigin.ts');
assert.ok(fs.existsSync(apiOriginPath), 'src/config/apiOrigin.ts must exist as the single source of PRODUCTION_ORIGIN');
const apiOriginBody = fs.readFileSync(apiOriginPath, 'utf8');
assert.ok(
  apiOriginBody.includes(`'https://${CANONICAL}'`) || apiOriginBody.includes(`"https://${CANONICAL}"`),
  `src/config/apiOrigin.ts must export PRODUCTION_ORIGIN = 'https://${CANONICAL}'`,
);
assert.ok(
  /export\s+const\s+PRODUCTION_ORIGIN\b/.test(apiOriginBody),
  'src/config/apiOrigin.ts must export a PRODUCTION_ORIGIN constant',
);

console.log(`✓ Scanned ${files.length} files across ${SCAN_DIRS.join(', ')} + root config. Zero ${FORBIDDEN} occurrences in executable paths.`);
console.log(`✓ Canonical PRODUCTION_ORIGIN = https://${CANONICAL} pinned in src/config/apiOrigin.ts.`);
