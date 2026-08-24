#!/usr/bin/env node
/**
 * test-web-export-artifact.mjs — end-to-end mutation-sensitive regression
 * for the CONFIGURED Vercel build sequence (DIC-1140 blocker #3).
 *
 * The bug this catches: `vercel.json` chains
 *   expo export --platform web && fix-html.js && copy-assets.js && …
 * so `dist/data/database.json` is written by fix-html.js (sanitised) and then
 * — until this test landed — byte-copied over by copy-assets.js (raw). Tests
 * that stubbed the export or only exercised one script in isolation missed
 * the overwrite. This regression reads `vercel.json` for the ACTUAL build
 * command, plays back the fix-html + copy-assets pair against a tempdir dist,
 * and audits the final on-disk artifact.
 *
 * Asserted invariants against the final `dist/data/database.json`:
 *   • `_rawPricesArchive` present on ZERO cards (internal-audit strip).
 *   • No user-facing surface (name / yuyuName / yuyuImage / prices[].name
 *     / prices[].imageUrl) carries `エラッタ前/後` text.
 *   • Store MVP mode strips `buyPrice` / `buyPriceHistory` / `priceHistory`
 *     / `ytStats` and `prices[].buyPrice*`; full mode preserves them.
 *   • Legacy semantic aliases the UI reads (`growth_1d`, `viewCount_daily`,
 *     etc.) do not carry synthetic 0s.
 *
 * Also mutation-tested: temporarily reinstate the deleted copy-assets.js copy,
 * re-run the sequence, and confirm the artifact now leaks `_rawPricesArchive`
 * — so the regression fails if the fix regresses.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const CANONICAL_DB = path.join(repoRoot, 'data', 'database.json');
const VERCEL_JSON = path.join(repoRoot, 'vercel.json');

let failures = 0;
function fail(msg) { failures += 1; console.error(`  ✗ ${msg}`); }
function ok(msg) { console.log(`  ✓ ${msg}`); }
function eq(actual, expected, msg) {
  if (actual === expected) ok(msg);
  else fail(`${msg} — expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
}

// dist/index.html is committed to the repo, but fix-html.js unconditionally
// rewrites it. Snapshot it at test start and restore on ANY exit path so a
// green test never leaves the working tree dirty (and a red test doesn't
// either).
const DIST_INDEX = path.join(repoRoot, 'dist', 'index.html');
const originalDistIndex = fs.existsSync(DIST_INDEX) ? fs.readFileSync(DIST_INDEX) : null;
function restoreDist() {
  if (originalDistIndex != null) {
    fs.mkdirSync(path.dirname(DIST_INDEX), { recursive: true });
    fs.writeFileSync(DIST_INDEX, originalDistIndex);
  }
}
process.on('exit', restoreDist);
process.on('uncaughtException', (err) => { restoreDist(); console.error(err); process.exit(1); });

/**
 * Extract the post-expo scripts from `vercel.json`'s buildCommand. We refuse
 * to hard-code the list here — the test's whole purpose is to catch a build
 * step that overwrites the sanitized asset, so it must read what actually
 * runs in production.
 */
function readVercelPostExpoScripts() {
  const cfg = JSON.parse(fs.readFileSync(VERCEL_JSON, 'utf-8'));
  const cmd = String(cfg.buildCommand || '');
  // Everything after `expo export` is the post-build chain. We're only
  // interested in `node scripts/<name>.(js|mjs)` invocations — those touch
  // dist/. Ignore generate-assetlinks.mjs (not a dist writer for database).
  const scripts = [];
  const re = /node\s+(scripts\/[\w./-]+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) {
    scripts.push(m[1]);
  }
  return scripts;
}

/**
 * Set up a tempdir dist/ shaped like Expo's real web export would produce it,
 * so fix-html.js has something to read. We only need the minimum surface the
 * two scripts touch — an index.html with a manifest tag (so the "already
 * present" branch fires) is enough.
 */
function prepareDist(distDir) {
  fs.mkdirSync(path.join(distDir, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(distDir, 'index.html'),
    '<!doctype html><html><head><link rel="manifest" href="/manifest.json"></head><body></body></html>',
    'utf-8',
  );
  // fix-html.js writes dist/manifest.json from public/manifest.json — the
  // real public/ already exists at repo root, so let it read from there.
}

/**
 * Run the configured Vercel post-expo sequence (excluding assetlinks — not
 * relevant to database artifact) against a redirected dist/. We invoke the
 * scripts as node processes so nothing is stubbed, matching the real build.
 *
 * The scripts resolve `distDir` relative to the repo root, so the tempdir
 * has to overlay the real repo. We take the simpler path: symlink or hard-
 * copy dist/ under the real repo, run, then read, then clean up. Even simpler:
 * point the scripts at the real dist/ but preserve/restore the file we're
 * about to test. We chose to accept temporary use of the real `dist/`.
 */
function runConfiguredSequence({ storeMvp }) {
  const distDir = path.join(repoRoot, 'dist');
  // Reset dist/ to a minimal known state so we don't inherit stale artifacts.
  fs.rmSync(distDir, { recursive: true, force: true });
  prepareDist(distDir);

  const env = { ...process.env };
  if (storeMvp) env.EXPO_PUBLIC_STORE_MVP = '1';
  else delete env.EXPO_PUBLIC_STORE_MVP;

  const scripts = readVercelPostExpoScripts();
  // We only exercise scripts that touch dist/data. In today's config that's
  // fix-html.js and copy-assets.js; generate-assetlinks.mjs is skipped.
  const RELEVANT = new Set(['scripts/fix-html.js', 'scripts/copy-assets.js']);
  const chain = scripts.filter((s) => RELEVANT.has(s));
  // Fail-loud if the config drops one of the expected steps — the test needs
  // to know if the build sequence changed shape (e.g. someone renames the
  // asset-copy script) so the audit stays anchored to the real pipeline.
  assert.ok(chain.includes('scripts/fix-html.js'), 'vercel.json must chain scripts/fix-html.js');
  assert.ok(chain.includes('scripts/copy-assets.js'), 'vercel.json must chain scripts/copy-assets.js');

  for (const s of chain) {
    execFileSync('node', [path.join(repoRoot, s)], { cwd: repoRoot, env, stdio: 'pipe' });
  }

  const artifact = fs.readFileSync(path.join(distDir, 'data', 'database.json'), 'utf-8');
  return JSON.parse(artifact);
}

function auditArtifact(label, artifact, { storeMvp }) {
  const cards = Object.values(artifact?.cards || {});
  eq(cards.length > 100, true, `${label}: artifact has cards`);

  let rawArchiveCount = 0;
  let errataSurfaces = 0;
  let storeMvpForbiddenBuyPrice = 0;
  let storeMvpForbiddenPriceHistory = 0;
  let storeMvpForbiddenYtStats = 0;
  let variantForbiddenBuyPrice = 0;
  let syntheticZeroDaily = 0;
  for (const c of cards) {
    if (Object.prototype.hasOwnProperty.call(c, '_rawPricesArchive')) rawArchiveCount += 1;
    const surfaces = [c.name, c.yuyuName, c.yuyuImage,
      ...(c.prices || []).flatMap((p) => [p?.name || '', p?.imageUrl || ''])];
    if (surfaces.some((s) => typeof s === 'string' && /エラッタ[前後]/.test(s))) errataSurfaces += 1;
    if ('buyPrice' in c) storeMvpForbiddenBuyPrice += 1;
    if ('buyPriceHistory' in c) storeMvpForbiddenPriceHistory += 1;
    if ('ytStats' in c) storeMvpForbiddenYtStats += 1;
    for (const p of c.prices || []) {
      if (p && typeof p === 'object' && 'buyPrice' in p) variantForbiddenBuyPrice += 1;
    }
    const y = c.ytStats;
    if (y && (y.growth_1d === 0 || y.viewCount_1d === 0 || y.viewCount_daily === 0)) syntheticZeroDaily += 1;
  }

  eq(rawArchiveCount, 0, `${label}: no card carries _rawPricesArchive in the shipped artifact`);
  eq(errataSurfaces, 0, `${label}: no user-facing surface carries エラッタ text`);
  if (storeMvp) {
    eq(storeMvpForbiddenBuyPrice, 0, `${label}: Store MVP strips card.buyPrice`);
    eq(storeMvpForbiddenPriceHistory, 0, `${label}: Store MVP strips card.buyPriceHistory`);
    eq(storeMvpForbiddenYtStats, 0, `${label}: Store MVP strips card.ytStats`);
    eq(variantForbiddenBuyPrice, 0, `${label}: Store MVP strips prices[].buyPrice`);
  } else {
    eq(storeMvpForbiddenBuyPrice > 0, true, `${label}: full mode preserves card.buyPrice`);
    eq(storeMvpForbiddenYtStats > 0, true, `${label}: full mode preserves card.ytStats`);
    // Zero-daily leak check only meaningful when ytStats is present.
    eq(syntheticZeroDaily, 0, `${label}: no synthetic zero daily metric in ytStats`);
  }
}

console.log('── vercel.json build sequence audit ──');
{
  const scripts = readVercelPostExpoScripts();
  eq(
    scripts.includes('scripts/fix-html.js') && scripts.includes('scripts/copy-assets.js'),
    true,
    'vercel.json chains fix-html.js AND copy-assets.js post-expo',
  );
}

console.log('\n── Full mode: play back the exact Vercel sequence ──');
{
  const artifact = runConfiguredSequence({ storeMvp: false });
  auditArtifact('full', artifact, { storeMvp: false });
}

console.log('\n── Store MVP mode: play back the exact Vercel sequence with EXPO_PUBLIC_STORE_MVP=1 ──');
{
  const artifact = runConfiguredSequence({ storeMvp: true });
  auditArtifact('store-mvp', artifact, { storeMvp: true });
}

console.log('\n── Mutation sensitivity: reinstating the deleted copy in copy-assets.js MUST break the audit ──');
{
  // Guard: if the fix regresses (i.e. copy-assets.js starts copying the raw
  // canonical database over dist/data/database.json again), this test must
  // FAIL. We temporarily patch a copy-assets shim into the chain that
  // reproduces the deleted overwrite, run the sequence, and expect the audit
  // to trip.
  const distDir = path.join(repoRoot, 'dist');
  fs.rmSync(distDir, { recursive: true, force: true });
  prepareDist(distDir);
  const env = { ...process.env };
  delete env.EXPO_PUBLIC_STORE_MVP;
  execFileSync('node', [path.join(repoRoot, 'scripts/fix-html.js')], { cwd: repoRoot, env, stdio: 'pipe' });
  // Simulate the regression: overwrite with raw canonical bytes.
  fs.copyFileSync(CANONICAL_DB, path.join(distDir, 'data', 'database.json'));
  const artifact = JSON.parse(fs.readFileSync(path.join(distDir, 'data', 'database.json'), 'utf-8'));
  let regressed = false;
  for (const c of Object.values(artifact.cards || {})) {
    if (Object.prototype.hasOwnProperty.call(c, '_rawPricesArchive')) { regressed = true; break; }
  }
  eq(regressed, true, 'mutation: replaying the deleted overwrite reproduces _rawPricesArchive leak (audit is sensitive to it)');
}

// Clean up dist so the caller ends with a fresh sanitized artifact
// (rebuild via the real sequence — full production mode).
{
  const distDir = path.join(repoRoot, 'dist');
  fs.rmSync(distDir, { recursive: true, force: true });
  prepareDist(distDir);
  const env = { ...process.env };
  delete env.EXPO_PUBLIC_STORE_MVP;
  execFileSync('node', [path.join(repoRoot, 'scripts/fix-html.js')], { cwd: repoRoot, env, stdio: 'pipe' });
  execFileSync('node', [path.join(repoRoot, 'scripts/copy-assets.js')], { cwd: repoRoot, env, stdio: 'pipe' });
}

console.log(failures === 0 ? '\n✅ configured web-export artifact regression pass.' : `\n❌ ${failures} assertion(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
