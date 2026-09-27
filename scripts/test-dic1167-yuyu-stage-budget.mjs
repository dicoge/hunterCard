#!/usr/bin/env node
// DIC-1167 (2026-09-24 P0): a hung/crashed yuyu price stage must NEVER block
// official-catalog publication. The daily run hung inside an unbounded
// browser operation after the hSD09 crash-relaunch; the external 600s
// supervisor killed the build (exit 124) and a fully-scraped official
// catalog was discarded. These tests pin the wall-clock-budget contract on
// the inline build-database yuyu loop:
//   (a) a series whose scrape never resolves cannot stall the stage — the
//       budget expires, the stage RESOLVES with partial prices, the hung
//       series contributes nothing (unknown printings stay null downstream);
//   (b) a series whose crash retry fails again is abandoned after exactly
//       one retry and the NEXT series still runs on a fresh browser
//       (hSD09 must not block hSD10+);
//   (c) stage-budget exhaustion also skips the HTTP fetch fallback (which
//       has no per-request abort) instead of reintroducing the stall;
//   (d) a failed browser relaunch abandons the remaining series with the
//       partial prices already collected — never an unbounded wait;
//   (f) a NON-crash per-series error (navigation TimeoutError) that skips a
//       series also marks the scrape truncated, and so does a failed series
//       in the HTTP fetch fallback (CR 6797d0aa);
//   (e) end-to-end: a real `node scripts/build-database.js` run with a
//       fault-injected forever-hanging yuyu stage still exits 0 within budget,
//       publishes the full official catalog, and preserves previously
//       proven exact-print prices (no sibling/cross-printing fallback —
//       preservation flows through the existing DIC-1321/DIC-1204 gates).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { scrapeYuyuPrices, scrapeAllWithFetch, LAUNCH_OPTS } from './build-database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const fakeBrowser = () => ({ close: async () => {}, process: () => null });
const cardsFor = (num) => [{
  cardNum: num, sellPrice: 100, rarity: 'OSR', name: 'x',
  yuyuImage: '', imageVersion: '', imageCid: '',
}];
const fetchStub = () => async () => ({ prices: {}, fetchedCards: 0, seriesFetched: 0 });

// ─── (0) CDP-level bounds are wired into LAUNCH_OPTS ────────────────────────
{
  assert.ok(
    Number.isFinite(LAUNCH_OPTS.protocolTimeout) && LAUNCH_OPTS.protocolTimeout > 0,
    'LAUNCH_OPTS.protocolTimeout must bound every CDP call (page.evaluate is not covered by page timeouts)',
  );
  assert.ok(
    Number.isFinite(LAUNCH_OPTS.timeout) && LAUNCH_OPTS.timeout > 0,
    'LAUNCH_OPTS.timeout must bound puppeteer.launch browser start',
  );
  console.log('✅ (0) LAUNCH_OPTS carries protocolTimeout + launch timeout');
}

// ─── (a) hung series resolves within budget, contributes nothing ────────────
{
  let launches = 0;
  const t0 = Date.now();
  const result = await scrapeYuyuPrices({
    launchBrowserFn: async () => { launches++; return fakeBrowser(); },
    scrapeSeriesPageFn: (browser, url) =>
      url.endsWith('/hang') ? new Promise(() => {}) : Promise.resolve(cardsFor('hBP01-001')),
    seriesPages: [
      { name: 'hangSeries', url: '/hang' },
      { name: 'okSeries', url: '/ok' },
    ],
    sleepFn: async () => {},
    fetchAllFn: fetchStub(),
    seriesBudgetMs: 120,
    stageBudgetMs: 10_000,
    launchBudgetMs: 1_000,
  });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5_000, `hung series must resolve within budget (took ${elapsed}ms)`);
  assert.equal(result.truncated, true, 'hung series must mark the scrape truncated (partial preservation downstream)');
  assert.deepEqual(Object.keys(result.prices), ['hBP01-001'],
    'the hung series must contribute NOTHING — its unknown printings stay null, never guessed');
  assert.equal(result.totalCards, 1);
  assert.equal(launches, 2, 'a hung series relaunches the browser so the next series gets a live one');
  console.log('✅ (a) hung series cannot stall the stage; partial prices resolve');
}

// ─── (b) crash-retry-exhausted series is abandoned; next series still runs ──
{
  let launches = 0;
  const attempts = [];
  const result = await scrapeYuyuPrices({
    launchBrowserFn: async () => { launches++; return fakeBrowser(); },
    scrapeSeriesPageFn: async (browser, url) => {
      attempts.push(url.slice(url.lastIndexOf('/')));
      if (url.endsWith('/crashy')) {
        throw new Error('Protocol error (Runtime.callFunctionOn): Target closed');
      }
      return cardsFor('hSD10-001');
    },
    seriesPages: [
      { name: 'hSD09', url: '/crashy' },
      { name: 'hSD10', url: '/ok' },
    ],
    sleepFn: async () => {},
    fetchAllFn: fetchStub(),
    seriesBudgetMs: 500,
    stageBudgetMs: 10_000,
    launchBudgetMs: 500,
  });
  assert.deepEqual(attempts, ['/crashy', '/crashy', '/ok'],
    'crashed series gets exactly one retry, then the loop moves on (hSD09 must not block hSD10+)');
  assert.equal(launches, 3, 'initial launch + crash relaunch + retry-failure relaunch for the next series');
  assert.equal(result.truncated, true, 'an abandoned series marks the scrape truncated');
  assert.deepEqual(Object.keys(result.prices), ['hSD10-001']);
  console.log('✅ (b) crash-retry-exhausted series abandoned after one retry; next series unblocked');
}

// ─── (c) stage-budget exhaustion also skips the HTTP fetch fallback ─────────
{
  let fetchCalled = false;
  const result = await scrapeYuyuPrices({
    launchBrowserFn: async () => fakeBrowser(),
    scrapeSeriesPageFn: () => new Promise(() => {}),
    seriesPages: [
      { name: 's1', url: '/a' },
      { name: 's2', url: '/b' },
      { name: 's3', url: '/c' },
    ],
    sleepFn: async () => {},
    fetchAllFn: async () => { fetchCalled = true; return { prices: {}, fetchedCards: 0 }; },
    seriesBudgetMs: 80,
    stageBudgetMs: 150,
    launchBudgetMs: 500,
  });
  assert.equal(result.truncated, true);
  assert.equal(fetchCalled, false,
    'an exhausted stage budget must not start the unbounded HTTP fetch fallback');
  assert.equal(result.totalCards, 0);
  console.log('✅ (c) exhausted stage budget skips the fetch fallback');
}

// ─── (d) failed relaunch abandons remaining series with partial prices ──────
{
  let launches = 0;
  const attempted = [];
  const result = await scrapeYuyuPrices({
    launchBrowserFn: async () => {
      launches++;
      if (launches > 1) throw new Error('spawn chrome ENOENT');
      return fakeBrowser();
    },
    scrapeSeriesPageFn: async (browser, url) => {
      attempted.push(url.slice(url.lastIndexOf('/')));
      if (url.endsWith('/ok1')) return cardsFor('hBP01-001');
      return new Promise(() => {});
    },
    seriesPages: [
      { name: 'ok1', url: '/ok1' },
      { name: 'hang', url: '/hang' },
      { name: 'never', url: '/never' },
    ],
    sleepFn: async () => {},
    fetchAllFn: fetchStub(),
    seriesBudgetMs: 100,
    stageBudgetMs: 10_000,
    launchBudgetMs: 200,
  });
  assert.deepEqual(attempted, ['/ok1', '/hang'],
    'after a failed relaunch the remaining series are abandoned, not waited on');
  assert.equal(result.truncated, true);
  assert.deepEqual(Object.keys(result.prices), ['hBP01-001'],
    'partial prices collected before the failure survive');
  console.log('✅ (d) failed relaunch abandons remaining series with partial prices');
}

// ─── (d2) crash + failed relaunch also marks the scrape truncated ───────────
// CR 355dac61: the hang path set truncated before relaunching, but the crash
// path did not — after ≥50 prices a crash whose relaunch failed returned
// truncated:false, so the unvisited series skipped partial-scrape
// preservation downstream.
{
  let launches = 0;
  const attempted = [];
  const sixty = Array.from({ length: 60 }, (_, i) => cardsFor(`hBP01-${String(i + 1).padStart(3, '0')}`)[0]);
  const result = await scrapeYuyuPrices({
    launchBrowserFn: async () => {
      launches++;
      if (launches > 1) throw new Error('spawn chrome ENOENT');
      return fakeBrowser();
    },
    scrapeSeriesPageFn: async (browser, url) => {
      attempted.push(url.slice(url.lastIndexOf('/')));
      if (url.endsWith('/crash')) throw new Error('Protocol error (Runtime.callFunctionOn): Target closed');
      return sixty;
    },
    seriesPages: [
      { name: 'ok1', url: '/ok1' },
      { name: 'crash', url: '/crash' },
      { name: 'never', url: '/never' },
    ],
    sleepFn: async () => {},
    fetchAllFn: async () => { throw new Error('fetch fallback must not run with ≥50 cards'); },
    seriesBudgetMs: 500,
    stageBudgetMs: 10_000,
    launchBudgetMs: 200,
  });
  assert.equal(launches, 2, 'initial launch + one failed crash relaunch');
  assert.deepEqual(attempted, ['/ok1', '/crash'],
    'after a failed crash relaunch the crashed series is not retried and remaining series are abandoned');
  assert.equal(result.truncated, true,
    'a crash whose relaunch fails must mark the scrape truncated (partial preservation downstream)');
  assert.equal(result.totalCards, 60);
  assert.equal(Object.keys(result.prices).length, 60, 'partial prices collected before the crash survive');
  console.log('✅ (d2) crash + failed relaunch marks the scrape truncated with partial prices');
}

// ─── (f) non-crash series error marks the scrape truncated ──────────────────
// CR 6797d0aa: a puppeteer navigation TimeoutError is neither a wall-clock
// budget expiry nor a browser crash, so it fell into the plain "log and
// continue" branch — after ≥50 prices the skipped series returned
// truncated:false and its rows bypassed partial-scrape preservation.
{
  let launches = 0;
  const attempted = [];
  const sixty = Array.from({ length: 60 }, (_, i) => cardsFor(`hBP01-${String(i + 1).padStart(3, '0')}`)[0]);
  const result = await scrapeYuyuPrices({
    launchBrowserFn: async () => { launches++; return fakeBrowser(); },
    scrapeSeriesPageFn: async (browser, url) => {
      attempted.push(url.slice(url.lastIndexOf('/')));
      if (url.endsWith('/timeout')) {
        const e = new Error('Navigation timeout of 45000 ms exceeded');
        e.name = 'TimeoutError';
        throw e;
      }
      if (url.endsWith('/ok2')) return cardsFor('hSD10-001');
      return sixty;
    },
    seriesPages: [
      { name: 'ok1', url: '/ok1' },
      { name: 'timeoutSeries', url: '/timeout' },
      { name: 'ok2', url: '/ok2' },
    ],
    sleepFn: async () => {},
    fetchAllFn: async () => { throw new Error('fetch fallback must not run with ≥50 cards'); },
    seriesBudgetMs: 500,
    stageBudgetMs: 10_000,
    launchBudgetMs: 200,
  });
  assert.deepEqual(attempted, ['/ok1', '/timeout', '/ok2'],
    'a non-crash series error skips only that series; the loop continues');
  assert.equal(launches, 1, 'a non-crash error leaves the live browser in place (no relaunch)');
  assert.equal(result.truncated, true,
    'a series skipped on a non-crash error must mark the scrape truncated (partial preservation downstream)');
  assert.equal(result.totalCards, 61);
  assert.equal(result.prices['hSD10-001']?.length, 1, 'series after the failed one still contribute');
  console.log('✅ (f) non-crash series error (navigation timeout) marks the scrape truncated');
}

// ─── (f2) fetch-fallback series failure marks the scrape truncated ──────────
{
  const fetched = [];
  const sixtyFetch = Array.from({ length: 60 }, (_, i) => cardsFor(`hBP02-${String(i + 1).padStart(3, '0')}`)[0]);
  const fetchResult = await scrapeAllWithFetch({
    seriesPages: [
      { name: 'ok1', url: '/ok1' },
      { name: 'waf', url: '/waf' },
    ],
    sleepFn: async () => {},
    scrapeSeriesPageWithFetchFn: async (url) => {
      fetched.push(url.slice(url.lastIndexOf('/')));
      if (url.endsWith('/waf')) throw new Error(`HTTP 403 for ${url}`);
      return sixtyFetch;
    },
  });
  assert.deepEqual(fetched, ['/ok1', '/waf']);
  assert.equal(fetchResult.truncated, true, 'a failed fetch series marks the fetch result truncated');
  assert.equal(fetchResult.fetchedCards, 60);

  const clean = await scrapeAllWithFetch({
    seriesPages: [{ name: 'ok1', url: '/ok1' }],
    sleepFn: async () => {},
    scrapeSeriesPageWithFetchFn: async () => sixtyFetch,
  });
  assert.equal(clean.truncated, false, 'a fully successful fetch is not truncated');

  // The flag must propagate through scrapeYuyuPrices when the puppeteer
  // path yields < 50 cards and the fetch fallback runs.
  const result = await scrapeYuyuPrices({
    launchBrowserFn: async () => fakeBrowser(),
    scrapeSeriesPageFn: async () => [],
    seriesPages: [{ name: 'empty', url: '/empty' }],
    sleepFn: async () => {},
    fetchAllFn: async () => fetchResult,
    seriesBudgetMs: 500,
    stageBudgetMs: 10_000,
    launchBudgetMs: 200,
  });
  assert.equal(result.totalCards, 60);
  assert.equal(result.truncated, true,
    'a truncated fetch fallback must mark the whole yuyu scrape truncated');

  const cleanResult = await scrapeYuyuPrices({
    launchBrowserFn: async () => fakeBrowser(),
    scrapeSeriesPageFn: async () => [],
    seriesPages: [{ name: 'empty', url: '/empty' }],
    sleepFn: async () => {},
    fetchAllFn: async () => clean,
    seriesBudgetMs: 500,
    stageBudgetMs: 10_000,
    launchBudgetMs: 200,
  });
  assert.equal(cleanResult.truncated, false,
    'an empty-but-successful puppeteer series plus a complete fetch fallback is not truncated');
  console.log('✅ (f2) fetch-fallback series failure marks the scrape truncated');
}

// ─── (e) E2E: real build with a hung price stage exits 0 within budget ──────
// Sandbox layout mirrors the DIC-1229 scheduler-entrypoint suite: scripts/
// COPIED (import.meta.url resolves symlinks, which would point DATA_DIR at
// the real repo), node_modules/package.json symlinked, read-only data inputs
// symlinked, the two databases build-database overwrites copied in.
{
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dic1167-hang-'));
  const repo = path.join(sandbox, 'repo');
  fs.mkdirSync(path.join(repo, 'data', 'price-history'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'data', 'buy-prices'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'public', 'data'), { recursive: true });

  try {
    fs.cpSync(path.join(REPO_ROOT, 'scripts'), path.join(repo, 'scripts'), { recursive: true });
    fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(repo, 'node_modules'));
    fs.symlinkSync(path.join(REPO_ROOT, 'package.json'), path.join(repo, 'package.json'));
    for (const entry of [
      'official', 'images',
      'series-names.json', 'yt-members.json', 'yt-stats-history.json',
      'bloom-levels.json', 'effects-jp.json', 'effects-zh.json',
      'character-names-zh.json', 'deck-rules.json',
    ]) {
      const src = path.join(REPO_ROOT, 'data', entry);
      if (fs.existsSync(src)) fs.symlinkSync(src, path.join(repo, 'data', entry));
    }
    fs.copyFileSync(path.join(REPO_ROOT, 'data', 'database.json'), path.join(repo, 'data', 'database.json'));
    fs.copyFileSync(path.join(REPO_ROOT, 'public', 'data', 'database.json'), path.join(repo, 'public', 'data', 'database.json'));

    const countPriced = (dbPath) => Object.values(JSON.parse(fs.readFileSync(dbPath, 'utf-8')).cards)
      .filter((c) => Number.isFinite(c?.sellPrice) && c.sellPrice > 0).length;
    const countCards = (dbPath) => Object.keys(JSON.parse(fs.readFileSync(dbPath, 'utf-8')).cards).length;
    const beforePriced = countPriced(path.join(repo, 'data', 'database.json'));
    const beforeCards = countCards(path.join(repo, 'data', 'database.json'));

    const t0 = Date.now();
    const run = spawnSync(process.execPath, ['scripts/build-database.js'], {
      cwd: repo,
      env: {
        ...process.env,
        HUNTERCARD_DIC1167_FAULT_HANG_YUYU: '1',
        HUNTERCARD_YUYU_STAGE_BUDGET_MS: '3000',
        HUNTERCARD_YUYU_SERIES_BUDGET_MS: '1000',
        HUNTERCARD_YUYU_LAUNCH_BUDGET_MS: '1000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const elapsed = Date.now() - t0;
    const stdout = run.stdout?.toString() || '';
    const stderr = run.stderr?.toString() || '';
    // Budget-expiry diagnostics go through console.warn/console.error →
    // stderr; the scheduler log tee captures both, so assert on the union.
    const output = stdout + stderr;

    assert.equal(run.status, 0,
      `a hung price stage must still publish the official catalog (exit 0, no 124). ` +
      `status=${run.status} signal=${run.signal} stderr tail: ${stderr.slice(-2000)}`);
    assert.match(output, /HUNTERCARD_DIC1167_FAULT_HANG_YUYU=1/,
      'fault-injection hook must log loudly on entry');
    assert.match(output, /exceeded its 1000ms wall-clock budget|yuyu stage wall-clock budget \(3000ms\) exhausted/,
      'the budget expiry must be visible in the scheduler log');
    assert.match(output, /Skipping HTTP fetch fallback/,
      'the exhausted budget must also skip the unbounded fetch fallback');
    assert.ok(elapsed < 240_000, `build must finish well inside the 600s supervision wall (took ${elapsed}ms)`);

    const afterPriced = countPriced(path.join(repo, 'data', 'database.json'));
    const afterCards = countCards(path.join(repo, 'data', 'database.json'));
    assert.ok(afterCards >= beforeCards,
      `official catalog must publish in full (before=${beforeCards}, after=${afterCards})`);
    assert.ok(afterPriced >= Math.floor(beforePriced * 0.95),
      `previously proven exact-print prices must be preserved, not nulled ` +
      `(before=${beforePriced}, after=${afterPriced})`);
    console.log(`✅ (e) E2E hung-stage build exited 0 in ${(elapsed / 1000).toFixed(1)}s; catalog ${afterCards} rows, priced ${afterPriced}/${beforePriced} preserved`);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

console.log('✅ DIC-1167 yuyu stage wall-clock budget tests passed');
