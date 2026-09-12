#!/usr/bin/env node
/**
 * test-web-export-artifact.mjs — end-to-end mutation-sensitive regression
 * for the CONFIGURED Vercel build sequence (DIC-1140 blocker #3 + DIC-1401).
 *
 * The original bug: `vercel.json` chained
 *   expo export --platform web && fix-html.js && copy-assets.js && …
 * so `dist/data/database.json` is written by fix-html.js (sanitised) and then
 * — until this test landed — byte-copied over by copy-assets.js (raw), leaking
 * `_rawPricesArchive` and errata text. This regression plays back the actual
 * configured post-export chain against a tempdir dist and audits the final
 * on-disk artifact.
 *
 * DIC-1401 round-4 moved the literal buildCommand into the controlled
 * entrypoint `scripts/ci/vercel-build.sh` so `vercel.json` stays under Vercel's
 * 256-character schema limit. This test's contract therefore has four layers:
 *
 *   1. CONFIG CONTRACT  — vercel.json's buildCommand must point at the
 *      controlled entrypoint (`bash scripts/ci/vercel-build.sh`) and stay
 *      <= 256 chars (Vercel rejects longer). Prevents a silent revert to the
 *      oversized inline command.
 *   2. ENTRYPOINT CONTRACT — vercel-build.sh must fail-closed (guard the
 *      lane env vars) and chain every required step in order: branch guard,
 *      deployment-data gate, expo export, write-build-version, fix-html,
 *      copy-assets, assetlinks. Nothing may be dropped.
 *   3. MUTATION CASES — statically remove each required step from a mutated
 *      entrypoint and confirm the analyzer fails, so no future PR can drop a
 *      step without a red CI.
 *   4. ARTIFACT AUDIT — play back fix-html + copy-assets (read from the real
 *      entrypoint, not hard-coded) and assert the shipped database.json.
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
const BUILD_ENTRYPOINT = path.join(repoRoot, 'scripts', 'ci', 'vercel-build.sh');

// Vercel schema hard cap — anything longer is rejected at config validation.
const VERCEL_BUILD_COMMAND_MAX_CHARS = 256;
// The controlled entrypoint vercel.json must point at.
const EXPECTED_ENTRYPOINT_CMD = 'bash scripts/ci/vercel-build.sh';

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

// ---------------------------------------------------------------------------
// Layer 1: config contract — vercel.json points at the controlled entrypoint.
// ---------------------------------------------------------------------------

function readVercelConfig() {
  return JSON.parse(fs.readFileSync(VERCEL_JSON, 'utf-8'));
}

function checkConfigContract() {
  const cfg = readVercelConfig();
  const cmd = String(cfg.buildCommand || '').trim();
  eq(cmd, EXPECTED_ENTRYPOINT_CMD, `vercel.json buildCommand points at the controlled entrypoint (${EXPECTED_ENTRYPOINT_CMD})`);
  eq(cmd.length <= VERCEL_BUILD_COMMAND_MAX_CHARS, true,
    `vercel.json buildCommand is within Vercel's ${VERCEL_BUILD_COMMAND_MAX_CHARS}-char schema limit (actual ${cmd.length})`);
  return cmd;
}

// ---------------------------------------------------------------------------
// Layer 2: entrypoint contract — vercel-build.sh fail-closes + chains every
// required step. This is the source of truth the artifact audit reads from.
// ---------------------------------------------------------------------------

/**
 * Required steps, checked in order. Each entry has a unique marker regex that
 * must appear in the entrypoint source and a human-readable description used
 * in failure/mutation messages.
 */
const REQUIRED_STEPS = [
  { name: 'branch-guard',        marker: /\bvercel-branch-guard\.sh\b/,                                  desc: 'branch guard (main/staging lane isolation)' },
  { name: 'deployment-data',     marker: /\btest:deployment-data\b|\bverify-deployment-data\.mjs\b/,     desc: 'deployment-data gate (refuses to publish a regressed catalog)' },
  { name: 'expo-export',         marker: /\bexpo\s+export\b/,                                            desc: 'expo web export' },
  { name: 'write-build-version', marker: /\bwrite-build-version\.mjs\b/,                                 desc: 'write-build-version (release-parity evidence)' },
  { name: 'fix-html',            marker: /\bfix-html\.js\b/,                                             desc: 'fix-html (sanitises database.json)' },
  { name: 'copy-assets',         marker: /\bcopy-assets\.js\b/,                                          desc: 'copy-assets (must run AFTER fix-html)' },
  { name: 'assetlinks',          marker: /\bgenerate-assetlinks\.mjs\b/,                                 desc: 'assetlinks generator' },
];

// Fix-html MUST run before copy-assets, otherwise copy-assets overwrites the
// sanitized database with the raw canonical bytes (the DIC-1140 regression).
const FIX_HTML_STEP = 'fix-html';
const COPY_ASSETS_STEP = 'copy-assets';

function indexOfStep(lines, stepName) {
  const step = REQUIRED_STEPS.find((s) => s.name === stepName);
  return lines.findIndex((line) => step.marker.test(line));
}

/**
 * Analyze the entrypoint source and return the ordered list of required step
 * names actually present, plus whether the ordering invariant holds.
 * Pure function so it can be run against mutations.
 */
export function analyzeEntrypoint(source) {
  const lines = source.split('\n');
  const present = REQUIRED_STEPS
    .filter((s) => lines.some((line) => s.marker.test(line)))
    .map((s) => s.name);

  const fixIdx = indexOfStep(lines, FIX_HTML_STEP);
  const copyIdx = indexOfStep(lines, COPY_ASSETS_STEP);
  const ordered = fixIdx >= 0 && copyIdx > fixIdx;

  // Fail-closed: the entrypoint must explicitly reject unset lane env vars
  // (EXPECTED_VERCEL_BRANCH / EXPO_PUBLIC_STORE_MVP) before running the build.
  const failClosedEnv = source.includes('-n "${EXPECTED_VERCEL_BRANCH:-}"')
    && source.includes('-n "${EXPO_PUBLIC_STORE_MVP:-}"');

  return { present, ordered, failClosedEnv };
}

function assertEntrypointContract(src, label) {
  const { present } = analyzeEntrypoint(src);
  for (const step of REQUIRED_STEPS) {
    eq(present.includes(step.name), true, `${label}: chain includes ${step.name} (${step.desc})`);
  }
  eq(indexOfStep(src.split('\n'), FIX_HTML_STEP) < indexOfStep(src.split('\n'), COPY_ASSETS_STEP), true,
    `${label}: fix-html runs BEFORE copy-assets (sanitizer must not be overwritten)`);
  eq(analyzeEntrypoint(src).failClosedEnv, true,
    `${label}: entrypoint fail-closes when EXPECTED_VERCEL_BRANCH / EXPO_PUBLIC_STORE_MVP are unset`);
}

// ---------------------------------------------------------------------------
// Layer 3: mutation cases — removing ANY required step must fail the contract.
// ---------------------------------------------------------------------------

function runMutationCase(stepToRemove) {
  const original = fs.readFileSync(BUILD_ENTRYPOINT, 'utf-8');
  // Remove the whole line(s) carrying this step's marker. This isolates the
  // removed step so the analyzer must report it as missing.
  const marker = REQUIRED_STEPS.find((s) => s.name === stepToRemove).marker;
  const lines = original.split('\n').filter((line) => !marker.test(line));
  const mutated = lines.join('\n');

  const { present, ordered } = analyzeEntrypoint(mutated);
  const removedCleared = !present.includes(stepToRemove);

  // The contract MUST fail when a required step vanishes. Removing any REQUIRED
  // step shrinks `present`, and removing either fix-html or copy-assets also
  // breaks the ordering invariant the artifact audit relies on. Only if the
  // removal left every required step present AND ordered intact would a
  // mutation have slipped through — which must never happen for a member of
  // REQUIRED_STEPS.
  const missingAnyRequired = REQUIRED_STEPS.some((s) => !present.includes(s.name));
  const contractBroken = missingAnyRequired || !ordered;
  const mutationCaught = removedCleared && contractBroken;

  if (mutationCaught) {
    ok(`mutation: dropping ${stepToRemove} (${REQUIRED_STEPS.find((s) => s.name === stepToRemove).desc}) fails the entrypoint contract`);
  } else {
    fail(`mutation: dropping ${stepToRemove} did not fail the entrypoint contract ` +
      `(removedCleared=${removedCleared} missingAnyRequired=${missingAnyRequired} ordered=${ordered})`);
  }
}

// ---------------------------------------------------------------------------
// Layer 4: artifact audit — play back fix-html + copy-assets from the real
// entrypoint (not hard-coded) and audit the shipped database.json.
// ---------------------------------------------------------------------------

/**
 * Read the ordered dist-touching scripts from vercel-build.sh (the actual
 * entrypoint), so the playback stays anchored to the real pipeline. We only
 * exercise the scripts that touch dist/data (fix-html + copy-assets);
 * assetlinks / write-build-version don't touch the database artifact.
 */
function readChainScriptsFromEntrypoint() {
  const src = fs.readFileSync(BUILD_ENTRYPOINT, 'utf-8');
  const scripts = [];
  const re = /(?:^|\n)\s*(?:node\s+)?(scripts\/[\w./-]+\.(?:js|mjs))/g;
  let m;
  while ((m = re.exec(src)) !== null) scripts.push(m[1]);
  return scripts;
}

/**
 * Set up a tempdir dist/ shaped like Expo's real web export would produce it,
 * so fix-html.js has something to read.
 */
function prepareDist(distDir) {
  fs.mkdirSync(path.join(distDir, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(distDir, 'index.html'),
    '<!doctype html><html><head><link rel="manifest" href="/manifest.json"></head><body></body></html>',
    'utf-8',
  );
}

function runConfiguredSequence({ storeMvp }) {
  const distDir = path.join(repoRoot, 'dist');
  fs.rmSync(distDir, { recursive: true, force: true });
  prepareDist(distDir);

  const env = { ...process.env };
  // DIC-1380: unset EXPO_PUBLIC_STORE_MVP now resolves fail-closed on Web
  // Production too, so the "full mode" audit must set the explicit opt-out
  // ('0') that Web Develop / Staging / local `expo start --web` use to keep
  // advanced surfaces visible. Never leave it unset here — that would test the
  // Store MVP artifact under the "full" label.
  env.EXPO_PUBLIC_STORE_MVP = storeMvp ? '1' : '0';

  const scripts = readChainScriptsFromEntrypoint();
  const RELEVANT = new Set(['scripts/fix-html.js', 'scripts/copy-assets.js']);
  const chain = scripts.filter((s) => RELEVANT.has(s));

  assert.ok(chain.includes('scripts/fix-html.js'), 'entrypoint must chain scripts/fix-html.js');
  assert.ok(chain.includes('scripts/copy-assets.js'), 'entrypoint must chain scripts/copy-assets.js');

  // Ordering invariant: sanitizer runs first, copier second.
  assert.ok(chain.indexOf('scripts/fix-html.js') < chain.indexOf('scripts/copy-assets.js'),
    'entrypoint must run scripts/fix-html.js BEFORE scripts/copy-assets.js');

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

// ---------------------------------------------------------------------------
// Run everything
// ---------------------------------------------------------------------------

console.log('── Layer 1: vercel.json config contract ──');
checkConfigContract();

console.log('\n── Layer 2: entrypoint (vercel-build.sh) contract ──');
const entrypointSource = fs.readFileSync(BUILD_ENTRYPOINT, 'utf-8');
assertEntrypointContract(entrypointSource, 'real entrypoint');

console.log('\n── Layer 3: mutation cases (dropping each required step must fail) ──');
for (const step of REQUIRED_STEPS) {
  runMutationCase(step.name);
}

console.log('\n── Layer 4: Full mode: play back the real post-export chain ──');
{
  const artifact = runConfiguredSequence({ storeMvp: false });
  auditArtifact('full', artifact, { storeMvp: false });
}

console.log('\n── Layer 4: Store MVP mode: play back with EXPO_PUBLIC_STORE_MVP=1 ──');
{
  const artifact = runConfiguredSequence({ storeMvp: true });
  auditArtifact('store-mvp', artifact, { storeMvp: true });
}

console.log('\n── Layer 4: mutation sensitivity: reinstating the deleted copy in copy-assets.js MUST break the audit ──');
{
  const distDir = path.join(repoRoot, 'dist');
  fs.rmSync(distDir, { recursive: true, force: true });
  prepareDist(distDir);
  const env = { ...process.env };
  // Same DIC-1380 note as runConfiguredSequence: `full mode` uses the explicit
  // opt-out. Leaving it unset would run fix-html.js under the Store MVP
  // profile and the mutation harness would collapse to the wrong baseline.
  env.EXPO_PUBLIC_STORE_MVP = '0';
  execFileSync('node', [path.join(repoRoot, 'scripts/fix-html.js')], { cwd: repoRoot, env, stdio: 'pipe' });
  fs.copyFileSync(CANONICAL_DB, path.join(distDir, 'data', 'database.json'));
  const artifact = JSON.parse(fs.readFileSync(path.join(distDir, 'data', 'database.json'), 'utf-8'));
  let regressed = false;
  for (const c of Object.values(artifact.cards || {})) {
    if (Object.prototype.hasOwnProperty.call(c, '_rawPricesArchive')) { regressed = true; break; }
  }
  eq(regressed, true, 'mutation: replaying the deleted overwrite reproduces _rawPricesArchive leak (audit is sensitive to it)');
}

// Clean up dist so the caller ends with a fresh sanitized artifact.
{
  const distDir = path.join(repoRoot, 'dist');
  fs.rmSync(distDir, { recursive: true, force: true });
  prepareDist(distDir);
  const env = { ...process.env };
  // DIC-1380 fail-closed default: pin the explicit opt-out so the cleanup
  // rebuild leaves the caller with the full-fields artifact it expects.
  env.EXPO_PUBLIC_STORE_MVP = '0';
  execFileSync('node', [path.join(repoRoot, 'scripts/fix-html.js')], { cwd: repoRoot, env, stdio: 'pipe' });
  execFileSync('node', [path.join(repoRoot, 'scripts/copy-assets.js')], { cwd: repoRoot, env, stdio: 'pipe' });
}

console.log(failures === 0 ? '\n✅ configured web-export artifact regression pass.' : `\n❌ ${failures} assertion(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
