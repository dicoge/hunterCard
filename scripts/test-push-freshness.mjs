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
import fs from 'node:fs';
import {
  isFresh, parseRestoreSince, assertFreshDatabase, selectTrendAlerts, MAX_FEED_AGE_MS,
  freshPriceSnapshot, oldestPricedRowTimestamps,
} from './lib/push-freshness.mjs';
const { adaptDatabase } = await import('../src/utils/deckCardData.ts');
const { priceAlertKey } = await import('../src/utils/priceAlerts.ts');

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

// ── per-price freshness (PM finding 2026-10-16: global lastUpdated today, yet 72 priced
//    rows still dated 2026-08-25) — real catalog rows, controlled timestamps ──────────
{
  const DB = JSON.parse(fs.readFileSync(new URL('../public/data/database.json', import.meta.url), 'utf8')).cards;
  const at = (id, ts) => ({ ...DB[id], timestamp: ts });
  // hBD24-008: two priced rows (an ent07 reprint row + the hPR row); hBD24-014: one row.
  const rows = [
    at('hBD24-008_ent07', ago(24 * 52)),            // preserved from August
    at('hBD24-008_hPR_P_hBD24-008_P', ago(1)),      // scraped today
    at('hBD24-014_hPR_P_hBD24-014_P', ago(1)),      // scraped today
  ];
  const db = { lastUpdated: ago(1), cards: rows };
  const { priceRecords } = adaptDatabase(rows);
  const oldest = oldestPricedRowTimestamps(rows);
  const versionsOf = (n) => priceRecords.filter((r) => r.cardNumber === n).map((r) => r.version);

  await test('global database current, watched exact printing\'s price from a stale row → ZERO prices posted', () => {
    assertFreshDatabase(db, NOW);   // the old database-level check alone would let it through
    const watched = versionsOf('hBD24-008').map((printing) => ({ cardNumber: 'hBD24-008', printing }));
    assert.ok(watched.length >= 1, `printings of hBD24-008: ${watched.map((w) => w.printing)}`);
    const r = freshPriceSnapshot({ watched, priceRecords, now: NOW, keyOf: priceAlertKey, oldestPricedRowByNumber: oldest });
    assert.deepEqual(r.prices, [], 'no notification from a number with a stale priced row');
    assert.equal(r.stale, watched.length);
  });
  await test('a stale exact printing never takes a fresh sibling printing\'s price (exact key only)', () => {
    const r = freshPriceSnapshot({ watched: [{ cardNumber: 'hBD24-008', printing: 'NO_SUCH_PRINTING' }], priceRecords, now: NOW, keyOf: priceAlertKey, oldestPricedRowByNumber: oldest });
    assert.deepEqual(r.prices, []);
    assert.equal(r.unpriced, 1);
  });
  await test('positive control: an exact printing whose rows are all current is posted with its own price', () => {
    const [printing] = versionsOf('hBD24-014');
    const r = freshPriceSnapshot({ watched: [{ cardNumber: 'hBD24-014', printing }], priceRecords, now: NOW, keyOf: priceAlertKey, oldestPricedRowByNumber: oldest });
    assert.equal(r.prices.length, 1);
    assert.equal(r.prices[0].price, priceRecords.find((x) => x.cardNumber === 'hBD24-014' && x.version === printing).price);
  });
  await test('restoration start after the price time → not posted', () => {
    const [printing] = versionsOf('hBD24-014');
    const r = freshPriceSnapshot({ watched: [{ cardNumber: 'hBD24-014', printing }], priceRecords, now: NOW, notBefore: NOW - 600_000, keyOf: priceAlertKey, oldestPricedRowByNumber: oldest });
    assert.deepEqual(r.prices, []);
  });
  await test('trend message: a preserved (stale) price is not shown as 現價', () => {
    const r = selectTrendAlerts({
      watchlist: { t: ['x-1', 'x-2'] },
      findCard: (n) => (n === 'x-1' ? { name: 'A', sellPrice: 500, timestamp: ago(24 * 52) } : { name: 'B', sellPrice: 700, timestamp: ago(1) }),
      findTrend: () => ({ score: 0.9, dataPoints: 5, lastUpdated: ago(1) }),
      now: NOW,
    });
    assert.match(r.alerts[0].body, /價格未定/);
    assert.match(r.alerts[1].body, /¥700/);
  });
}

// ── the real feeder scripts, offline, on CONTROLLED data (never the repo's own data,
//    whose age changes with every refresh) ─────────────────────────────────────────
const tmpDir = fs.mkdtempSync(`${(await import('node:os')).tmpdir()}/push-fresh-`);
const nowIso = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const DBROWS = JSON.parse(fs.readFileSync(new URL('../public/data/database.json', import.meta.url), 'utf8')).cards;
const staleDbPath = `${tmpDir}/stale.json`;
fs.writeFileSync(staleDbPath, JSON.stringify({ lastUpdated: nowIso(24 * 13), cards: { [DBROWS['hBD24-014_hPR_P_hBD24-014_P'].id]: DBROWS['hBD24-014_hPR_P_hBD24-014_P'] } }));
const freshDbStaleRowPath = `${tmpDir}/fresh-stale-row.json`;
const rowStale = { ...DBROWS['hBD24-014_hPR_P_hBD24-014_P'], timestamp: nowIso(24 * 52) };
fs.writeFileSync(freshDbStaleRowPath, JSON.stringify({ lastUpdated: nowIso(1), cards: { [rowStale.id]: rowStale } }));
const watchedPrinting = adaptDatabase([rowStale]).priceRecords[0]?.version;

function mockServer() {
  const hits = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      hits.push(`${req.method} ${decodeURIComponent(req.url)}`);
      const u = decodeURIComponent(req.url);
      let result = [];
      if (u.includes('smembers/push:price-alert-tokens') || u.includes('smembers/push:watchlist-tokens')) result = ['ExponentPushToken[qa]'];
      else if (u.includes('hgetall/push:price-alerts:')) result = ['k', JSON.stringify({ cardNumber: 'hBD24-014', printing: watchedPrinting, lowerPrice: null, upperPrice: 1 })];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(u.startsWith('/api/push/') ? { ok: true, sent: 0 } : { result }));
    });
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
const TS = ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', './scripts/register-ts.mjs'];

const mock = await mockServer();
try {
  const env = (db) => ({
    PUSH_NOTIFY_SECRET: 'test-only-not-a-secret',
    KV_REST_API_URL: mock.url,
    KV_REST_API_TOKEN: 'test-only',
    PUSH_NOTIFY_URL: `${mock.url}/api/push/notify`,
    PUSH_PRICE_ALERT_URL: `${mock.url}/api/push/price-alert-run`,
    PUSH_DATABASE_PATH: db,
    PUSH_TRENDS_DIR: tmpDir,
  });
  await test('watchlist feeder on a 13-day-old database: exits without reading KV or calling notify', async () => {
    mock.hits.length = 0;
    const r = await runFeeder(['scripts/send-push-alerts.js'], env(staleDbPath));
    assert.notEqual(r.code, 0);
    assert.match(r.out, /price data not current/);
    assert.deepEqual(mock.hits, []);
  });
  await test('desired-price feeder on a 13-day-old database: exits without reading KV or posting prices', async () => {
    mock.hits.length = 0;
    const r = await runFeeder([...TS, 'scripts/send-price-alerts.mjs'], env(staleDbPath));
    assert.notEqual(r.code, 0);
    assert.match(r.out, /price data not current/);
    assert.deepEqual(mock.hits, []);
  });
  await test('desired-price feeder, database current but the watched printing\'s price row is from August: reads the watch list, posts NOTHING', async () => {
    assert.ok(watchedPrinting, 'fixture printing');
    mock.hits.length = 0;
    const r = await runFeeder([...TS, 'scripts/send-price-alerts.mjs'], env(freshDbStaleRowPath));
    assert.equal(r.code, 0, r.out);
    assert.ok(mock.hits.some((h) => h.includes('hgetall/push:price-alerts:')), 'watch list was read');
    assert.ok(!mock.hits.some((h) => h.includes('/api/push/price-alert-run')), `no price posted: ${mock.hits.join(', ')}`);
    assert.match(r.out, /none with a current price/);
  });
} finally {
  mock.server.close();
}

if ((process.exitCode ?? 0) === 0) console.log(`\n✅ push-freshness: ${passed} checks passed`);
else console.error('\n❌ push-freshness failed');
