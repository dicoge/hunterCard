#!/usr/bin/env node
// DIC-1430 → DIC-1481 — local browser verification of the Production
// Collection route contract.
//
// Re-runs the Mac-OpenClaw Production QA probe (run 16c25a62-af71-4571-99c8-
// bc8e7a5878cd) against a LOCAL web export built with the Production release
// profile (no EXPO_PUBLIC_STORE_MVP define → fail-closed Store MVP ON).
//
// DIC-1481 superseded the DIC-1430-era fail-closed expectation this script
// used to assert (controls absent, route unregistered — the state CR run
// 037b339f enforced): the corrected new-interface release contract keeps the
// Collection route registered and reachable in EVERY release profile. So the
// passing state is now: fresh guest → 我的 renders ALL THREE of
// `me-segment-collection` / `me-search-field` / `me-view-all`, clicking the
// segment really arrives at `collection-shell`, and the still-restricted
// surfaces (watchlist / trends segments) stay absent. A dead control, an
// unreachable Collection route, and a resurfaced restricted segment all fail.
//
//   node scripts/verify-dic1430-collection-nav-e2e.mjs
//
// Scope note: the app mounts no React Navigation `linking` config, so there is
// no URL-addressable deep link to exercise here. The programmatic navigate()
// and nested deep-link vectors are covered against the real navigator by
// scripts/test-dic1430-me-collection-nav.mjs, which also runs the positive
// non-Store-MVP profile this single-build probe cannot reach.
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
  // Seed one owned printing BEFORE the app boots so 檢視全部's own precondition
  // (the guest owns at least one card) is satisfied. Without it, asserting that
  // control's absence would pass for the wrong reason — the empty-state branch
  // would be hiding it regardless of the release flag. Only `collection` is
  // written: zustand/persist merges the persisted slice over the store
  // defaults, so nothing else about the guest is fabricated.
  await page.evaluateOnNewDocument((payload) => {
    window.localStorage.setItem('hunterCard-decks', payload);
  }, JSON.stringify({ state: { collection: { 'hBP01-024|PARALLEL/HR': 2 } }, version: 3 }));
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

const { page, consoleErrors, pageErrors, networkErrors } = await freshGuestOnMe('production');

// Confirm the PRODUCTION profile really is in effect: the flag-gated sibling
// segments must be absent. Otherwise this build proves nothing about Production
// — a non-Store-MVP export would render everything and "pass" nothing.
const storeMvpFingerprint = {
  watchlistSegment: await present(page, 'me-segment-watchlist'),
  trendsSegment: await present(page, 'me-segment-trends'),
};
// Proof the ownership seed landed: with zero owned rows, 檢視全部 is hidden by
// the empty state and its absence below would be meaningless.
const ownedRows = await present(page, 'me-owned-row');

await page.screenshot({ path: path.join(OUT, '03-me-production-profile.png'), fullPage: true });

const controls = {};
for (const [label, testID] of [
  ['segment', 'me-segment-collection'],
  ['search', 'me-search-field'],
  ['viewAll', 'me-view-all'],
]) {
  controls[label] = { testID, ...(await countVisible(page, testID)) };
}

// DIC-1481: the segment must ARRIVE. Click it and require collection-shell.
let collectionShell = { count: 0, visible: false, box: null };
if (controls.segment.count === 1) {
  await (await page.$('[data-testid="me-segment-collection"]')).click();
  try {
    await page.waitForSelector('[data-testid="collection-shell"]', { timeout: TIMEOUT });
  } catch { /* absence is asserted below */ }
  collectionShell = await countVisible(page, 'collection-shell');
}

const failures = [];
if (storeMvpFingerprint.watchlistSegment !== 0) failures.push('build is not the Store MVP profile (watchlist segment rendered)');
if (storeMvpFingerprint.trendsSegment !== 0) failures.push('restricted 趨勢 segment resurfaced under Store MVP');
if (ownedRows < 1) failures.push('ownership seed did not land — 檢視全部 presence would prove nothing');
for (const [label, c] of Object.entries(controls)) {
  if (c.count !== 1 || !c.visible) failures.push(`${label} (${c.testID}) must render visibly in every profile (DIC-1481)`);
}
if (collectionShell.count !== 1) failures.push('collection-shell did not mount — the Collection route is unreachable (DIC-1481 release blocker)');
const failed = failures.length > 0;

await page.screenshot({ path: path.join(OUT, `04-${failed ? 'fail' : 'pass'}-production-me.png`), fullPage: true });
console.log(`[production] controls=${Object.values(controls).map((c) => c.count).join('/')} ` +
  `collectionShell=${collectionShell.count} ownedRows=${ownedRows} ` +
  `storeMvpGatedSiblings=${storeMvpFingerprint.watchlistSegment + storeMvpFingerprint.trendsSegment}`);
await page.close();

const report = {
  milestone: 'DIC-1481 Production Collection route registration contract',
  origin: ORIGIN,
  source: 'local web export (dist/) built with no EXPO_PUBLIC_STORE_MVP define → Store MVP ON',
  contract: 'all three 我的 Collection controls render and arrive at collection-shell; watchlist/trends segments stay fail-closed',
  viewport: { width: 390, height: 844 },
  capturedAt: new Date().toISOString(),
  results: { controls, collectionShell, ownedRows, storeMvpFingerprint, consoleErrors, pageErrors, networkErrors },
  failures,
  verdict: failed ? 'FAIL' : 'PASS',
};
fs.writeFileSync(path.join(OUT, 'probe-result.json'), `${JSON.stringify(report, null, 2)}\n`);

await browser.close();
server.close();

assert.equal(report.results.storeMvpFingerprint.watchlistSegment, 0, 'build is not the Store MVP profile');
assert.equal(report.results.storeMvpFingerprint.trendsSegment, 0, 'restricted 趨勢 segment must stay hidden under Store MVP');
assert.ok(report.results.ownedRows >= 1, 'ownership seed did not land — 檢視全部 presence would prove nothing');
for (const [label, c] of Object.entries(report.results.controls)) {
  assert.equal(c.count, 1, `${label}: must render in every profile (DIC-1481)`);
}
assert.equal(report.results.collectionShell.count, 1, 'collection-shell must mount — Collection route reachable under Store MVP (DIC-1481)');

console.log(`\n${failed ? '❌' : '✅'} DIC-1481 local browser verification at 390×844: ${report.verdict}`);
process.exitCode = failed ? 1 : 0;
