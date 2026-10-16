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
  freshPriceSnapshot,
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

// ── per-price freshness + exact price-time provenance (PM findings 2026-10-16: 72 rows
//    still from 2026-08-25; adaptCardNumber stamped every printing with the
//    representative row's date, e.g. hBP01-048 PARALLEL ¥980 from August looked current) ─
{
  const OLD = ago(24 * 52), NEW = ago(1);
  const rows = [
    { id: 'hBP01-048_hPR_P', cardNumber: 'hBP01-048', name: '風真いろは', type: 'Holomen', rarity: 'P', series: 'hPR', timestamp: OLD,
      prices: [{ name: '風真いろは(パラレル)', sellPrice: 980, rarity: 'P' }] },
    { id: 'hBP01-048_hBP01_C', cardNumber: 'hBP01-048', name: '風真いろは', type: 'Holomen', rarity: 'C', series: 'hBP01', timestamp: NEW,
      prices: [{ name: '風真いろは', sellPrice: 30, rarity: 'C' }] },
    { id: 'hBP01-049_hBP01_C', cardNumber: 'hBP01-049', name: '風真いろは', type: 'Holomen', rarity: 'C', series: 'hBP01',
      prices: [{ name: '風真いろは', sellPrice: 40, rarity: 'C' }] },   // no timestamp at all
  ];
  const { priceRecords } = adaptDatabase(rows);
  const rec = (n, price) => priceRecords.find((r) => r.cardNumber === n && r.price === price);

  await test('adapter provenance: old parallel keeps its OLD time, fresh base its own fresh time (different prices)', () => {
    assert.ok(rec('hBP01-048', 980) && rec('hBP01-048', 30), `records: ${JSON.stringify(priceRecords)}`);
    assert.equal(rec('hBP01-048', 980).timestamp, OLD, 'the August parallel is not restamped with the base row date');
    assert.equal(rec('hBP01-048', 30).timestamp, NEW);
    assert.notEqual(rec('hBP01-048', 980).version, rec('hBP01-048', 30).version);
  });
  await test('adapter provenance: a price whose row has no timestamp stays unknown (\'\'), never restamped current', () => {
    assert.equal(rec('hBP01-049', 40).timestamp, '');
  });
  const watched = [
    { cardNumber: 'hBP01-048', printing: rec('hBP01-048', 980).version },
    { cardNumber: 'hBP01-048', printing: rec('hBP01-048', 30).version },
    { cardNumber: 'hBP01-049', printing: rec('hBP01-049', 40).version },
  ];
  await test('database current overall: only the fresh base is posted, with ITS price; the old parallel and the unknown-time price are not', () => {
    assertFreshDatabase({ lastUpdated: NEW }, NOW);
    const r = freshPriceSnapshot({ watched, priceRecords, now: NOW, keyOf: priceAlertKey });
    assert.deepEqual(r.prices.map((p) => [p.printing, p.price]), [[rec('hBP01-048', 30).version, 30]]);
    assert.equal(r.stale, 2);
  });
  await test('a watched printing without its own record never takes a sibling printing\'s price', () => {
    const r = freshPriceSnapshot({ watched: [{ cardNumber: 'hBP01-048', printing: 'NO_SUCH_PRINTING' }], priceRecords, now: NOW, keyOf: priceAlertKey });
    assert.deepEqual(r.prices, []);
    assert.equal(r.unpriced, 1);
  });
  await test('restoration start after the fresh base time → nothing posted', () => {
    const r = freshPriceSnapshot({ watched, priceRecords, now: NOW, notBefore: NOW - 600_000, keyOf: priceAlertKey });
    assert.deepEqual(r.prices, []);
  });
  await test('trend message: a preserved (stale) price is not shown as 現價', () => {
    const r = selectTrendAlerts({
      watchlist: { t: ['x-1', 'x-2'] },
      findCard: (n) => (n === 'x-1' ? { name: 'A', sellPrice: 500, timestamp: OLD } : { name: 'B', sellPrice: 700, timestamp: NEW }),
      findTrend: () => ({ score: 0.9, dataPoints: 5, lastUpdated: NEW }),
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
