#!/usr/bin/env node
/**
 * v41 push restoration gate (scripts/lib/push-freshness.mjs) — offline.
 *
 *  • rules: stale / future / pre-restoration data never counts; existing criteria kept
 *  • the REAL feeder scripts, run against local mock KV + notify servers with fake
 *    values (no real secret, no device, no Expo): with the repo's current data
 *    (database 2026-10-13, trends 2026-10-03) they send NOTHING and do not even read
 *    the watchlist — the dormant backlog cannot go out on restoration.
 * Per-recipient cooldown isolation is pinned by test:push-backend (notify), and the
 * desired-price arm state by test:price-alert-run; both are unchanged.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import {
  isFresh, parseRestoreSince, assertFreshDatabase, selectTrendAlerts, MAX_FEED_AGE_MS,
} from './lib/push-freshness.mjs';

let passed = 0;
async function test(label, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (err) { process.exitCode = 1; console.error(`  ✗ ${label} — ${err.message}`); }
}
const NOW = Date.parse('2026-10-17T00:00:00Z');
const ago = (h) => new Date(NOW - h * 3600_000).toISOString();

await test('fresh = parsed, within 36 h, not in the future, not before the restoration start', () => {
  assert.equal(isFresh(ago(1), NOW), true);
  assert.equal(isFresh(ago(35), NOW), true);
  assert.equal(isFresh(ago(37), NOW), false);
  assert.equal(isFresh(new Date(NOW + 3600_000).toISOString(), NOW), false, 'future timestamp');
  assert.equal(isFresh('yesterday', NOW), false);
  assert.equal(isFresh(undefined, NOW), false);
  assert.equal(isFresh(ago(2), NOW, { notBefore: NOW - 3600_000 }), false, 'before restoration');
  assert.equal(MAX_FEED_AGE_MS, 36 * 3600_000);
});

await test('PUSH_RESTORE_SINCE: empty = none, malformed fails closed', () => {
  assert.equal(parseRestoreSince(undefined), null);
  assert.equal(parseRestoreSince(''), null);
  assert.equal(parseRestoreSince('2026-10-17T00:00:00Z'), NOW);
  assert.throws(() => parseRestoreSince('soon'));
});

await test('a stale price database stops the run (both feeds)', () => {
  assert.throws(() => assertFreshDatabase({ lastUpdated: ago(72) }, NOW), /not current/);
  assert.throws(() => assertFreshDatabase({}, NOW), /not current/);
  assertFreshDatabase({ lastUpdated: ago(2) }, NOW);
});

const cards = { 'hBP01-001': { name: 'A', sellPrice: 100 }, 'hBP01-002': { name: 'B', sellPrice: 200 }, 'hBP01-003': { name: 'C' }, 'hBP01-004': { name: 'D' } };
const trends = {
  'hBP01-001': { score: 0.8, dataPoints: 5, lastUpdated: ago(2) },     // current + eligible
  'hBP01-002': { score: 0.9, dataPoints: 9, lastUpdated: ago(24 * 13) }, // dormant backlog
  'hBP01-003': { score: 0.5, dataPoints: 9, lastUpdated: ago(1) },     // below threshold
  'hBP01-004': { score: 0.9, dataPoints: 2, lastUpdated: ago(1) },     // too few points
};
const select = (watchlist, notBefore = null) => selectTrendAlerts({
  watchlist, findCard: (n) => cards[n], findTrend: (_c, n) => trends[n], now: NOW, notBefore,
});

await test('trend alerts: only current AND eligible (existing 0.6 / 3-point criteria unchanged)', () => {
  const r = select({ tokA: ['hBP01-001', 'hBP01-002', 'hBP01-003', 'hBP01-004'] });
  assert.deepEqual(r.alerts.map((a) => a.cardNumber), ['hBP01-001']);
  assert.equal(r.stale, 1, 'the 13-day-old trend is held back');
  assert.equal(r.notEligible, 2);
  assert.match(r.alerts[0].title, /入手時機！A ▲\+80%/);
});

await test('duplicate watchers: one candidate per card (notify fans out per recipient with its own cooldown)', () => {
  const r = select({ tokA: ['hBP01-001'], tokB: ['hBP01-001', 'hBP01-001'] });
  assert.equal(r.alerts.length, 1);
});

await test('restoration start: a trend computed before it is not sent', () => {
  const r = select({ tokA: ['hBP01-001'] }, NOW - 3600_000);
  assert.equal(r.alerts.length, 0);
  assert.equal(r.stale, 1);
});

// ── the real feeder scripts, offline ──────────────────────────────────────────
function mockServer() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url.includes('smembers') ? { result: ['ExponentPushToken[x]'] } : { result: [] }));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, hits, url: `http://127.0.0.1:${server.address().port}` })));
}
function runFeeder(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => resolve({ code, out }));
  });
}

const mock = await mockServer();
try {
  const fakeEnv = {
    PUSH_NOTIFY_SECRET: 'test-only-not-a-secret',
    KV_REST_API_URL: mock.url,
    KV_REST_API_TOKEN: 'test-only',
    PUSH_NOTIFY_URL: `${mock.url}/api/push/notify`,
    PUSH_PRICE_ALERT_URL: `${mock.url}/api/push/price-alert-run`,
  };
  await test('watchlist feeder on the repo\'s current (stale) data: exits without reading KV or calling notify', async () => {
    const r = await runFeeder(['scripts/send-push-alerts.js'], fakeEnv);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /price data not current/);
    assert.deepEqual(mock.hits, [], `no request at all, got ${mock.hits.join(', ')}`);
  });
  await test('desired-price feeder on the repo\'s current (stale) data: exits without reading KV or posting prices', async () => {
    const r = await runFeeder(['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', './scripts/register-ts.mjs', 'scripts/send-price-alerts.mjs'], fakeEnv);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /price data not current/);
    assert.deepEqual(mock.hits, []);
  });
} finally {
  mock.server.close();
}

if ((process.exitCode ?? 0) === 0) console.log(`\n✅ push-freshness: ${passed} checks passed`);
else console.error('\n❌ push-freshness failed');
