#!/usr/bin/env node
// DIC-1430 — local browser verification of the Production Collection P0.
//
// Mirrors the Mac-OpenClaw Production QA probe (run 16c25a62-af71-4571-99c8-
// bc8e7a5878cd) against a LOCAL web export built with the Production release
// profile (no EXPO_PUBLIC_STORE_MVP define → fail-closed Store MVP ON):
// fresh guest → 我的, then each real Collection entry point must mount
// `collection-shell`.
//
//   node scripts/verify-dic1430-collection-nav-e2e.mjs
//
// Serves ./dist itself (SPA fallback) so nothing external is required.
// Writes screenshots + probe-result.json into .hermes-artifacts/collection-nav-fix/.

import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(ROOT, '.hermes-artifacts', 'collection-nav-fix');
const PORT = Number(process.env.DIC1430_PORT || 4319);
const TIMEOUT = 60_000;

assert.ok(fs.existsSync(path.join(DIST, 'index.html')), `missing web export at ${DIST} — run "npm run build" first`);
fs.mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let filePath = path.join(DIST, urlPath);
  // Never serve outside dist.
  if (!filePath.startsWith(DIST)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html');
  // SPA fallback for extensionless client routes.
  if (!fs.existsSync(filePath) && !path.extname(filePath)) filePath = path.join(DIST, 'index.html');
  if (!fs.existsSync(filePath)) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});
await new Promise((resolve) => server.listen(PORT, resolve));
const ORIGIN = `http://localhost:${PORT}`;
console.log(`serving ${DIST} at ${ORIGIN}`);

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });

const countVisible = (page, testID) => page.evaluate((id) => {
  const nodes = [...document.querySelectorAll(`[data-testid="${id}"]`)];
  const node = nodes[0];
  const rect = node?.getBoundingClientRect();
  return {
    count: nodes.length,
    visible: !!rect && rect.width > 0 && rect.height > 0,
    box: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
  };
}, testID);

const present = (page, testID) => page.evaluate(
  (id) => document.querySelectorAll(`[data-testid="${id}"]`).length,
  testID,
);

async function freshGuestOnMe(label) {
  const page = await browser.newPage();
  const consoleErrors = []; const pageErrors = []; const networkErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('requestfailed', (r) => networkErrors.push(`${r.url()} ${r.failure()?.errorText}`));
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(ORIGIN, { waitUntil: 'networkidle2', timeout: TIMEOUT });

  // Fresh guest: the Landing's guest CTA enters the app without an account —
  // the same entry the Production QA probe used. Match the testID, not the
  // button label, so a copy change cannot silently break this verification.
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="landing-cta-guest"]')
      || !!document.querySelector('[data-testid="home-shell"]'),
    { timeout: TIMEOUT },
  );
  const guestCta = await page.$('[data-testid="landing-cta-guest"]');
  if (guestCta) await guestCta.click();
  await page.waitForSelector('[data-testid="home-shell"]', { timeout: TIMEOUT });

  // Into 我的 through the real bottom tab.
  await page.waitForSelector('[data-testid="shell-bottom-tab-me"]', { timeout: TIMEOUT });
  await (await page.$('[data-testid="shell-bottom-tab-me"]')).click();
  await page.waitForSelector('[data-testid="me-shell"]', { timeout: TIMEOUT });
  console.log(`[${label}] reached 我的`);
  return { page, consoleErrors, pageErrors, networkErrors };
}

const results = {};
let failed = false;

for (const [label, testID] of [['segment', 'me-segment-collection'], ['search', 'me-search-field']]) {
  const { page, consoleErrors, pageErrors, networkErrors } = await freshGuestOnMe(label);

  // Confirm the PRODUCTION profile really is in effect: the flag-gated
  // sibling segments must be absent (the single-segment row the QA
  // screenshot showed). Otherwise this build proves nothing about Production.
  const storeMvpFingerprint = {
    watchlistSegment: await present(page, 'me-segment-watchlist'),
    trendsSegment: await present(page, 'me-segment-trends'),
  };

  const before = await countVisible(page, testID);
  await page.screenshot({ path: path.join(OUT, `03-${label}-before-click.png`) });

  await (await page.$(`[data-testid="${testID}"]`)).click();
  let reached = true;
  try {
    await page.waitForSelector('[data-testid="collection-shell"]', { timeout: 15_000 });
  } catch { reached = false; }

  const collectionShell = await countVisible(page, 'collection-shell');
  await page.screenshot({ path: path.join(OUT, `04-${reached ? 'pass' : 'fail'}-after-${label}-click.png`) });

  results[label] = {
    testID, entryPoint: before, collectionReached: reached, collectionShell,
    storeMvpFingerprint, consoleErrors, pageErrors, networkErrors,
  };
  console.log(`[${label}] collectionReached=${reached} shellCount=${collectionShell.count} ` +
    `storeMvpGatedSiblings=${storeMvpFingerprint.watchlistSegment + storeMvpFingerprint.trendsSegment}`);
  if (!reached) failed = true;
  await page.close();
}

const report = {
  milestone: 'DIC-1430 Production Collection navigation P0 repair',
  origin: ORIGIN,
  source: 'local web export (dist/) built with no EXPO_PUBLIC_STORE_MVP define → Store MVP ON',
  viewport: { width: 390, height: 844 },
  capturedAt: new Date().toISOString(),
  results,
  verdict: failed ? 'FAIL' : 'PASS',
};
fs.writeFileSync(path.join(OUT, 'probe-result.json'), `${JSON.stringify(report, null, 2)}\n`);

await browser.close();
server.close();

for (const [label, r] of Object.entries(results)) {
  assert.equal(r.entryPoint.count, 1, `${label}: entry point must exist exactly once`);
  assert.equal(r.entryPoint.visible, true, `${label}: entry point must be visible`);
  assert.equal(r.storeMvpFingerprint.watchlistSegment, 0, `${label}: build is not the Store MVP profile`);
  assert.equal(r.collectionReached, true, `${label}: must mount collection-shell`);
  assert.ok(r.collectionShell.count >= 1, `${label}: collection-shell must be present`);
}

console.log(`\n${failed ? '❌' : '✅'} DIC-1430 local browser verification at 390×844: ${report.verdict}`);
process.exitCode = failed ? 1 : 0;
