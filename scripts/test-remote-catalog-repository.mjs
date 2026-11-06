#!/usr/bin/env node
/**
 * Remote native catalog — repository behaviour (2026-11-06).
 *
 * Executes the REAL src/services/catalog/catalogRepository.ts over an in-memory
 * file system and a scripted fetch. Faults (timeouts, refusals, bad hashes,
 * forbidden fields, partial writes, low disk, corrupt files, out-of-order and
 * concurrent refreshes) are injected; nothing touches the real disk or network.
 * URLs are the real production URLs — the repository has no origin override, so a
 * request for any other URL would fail the route lookup below.
 *
 * These are deterministic unit checks of the shared logic. They are NOT evidence
 * of Android file behaviour or real HTTPS; that needs native acceptance.
 *
 * Run: node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *        --import ./scripts/register-ts.mjs scripts/test-remote-catalog-repository.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createCatalogRepository } from '../src/services/catalog/catalogRepository.ts';
import { PRODUCTION_ORIGIN } from '../src/config/apiOrigin.ts';
import { buildNativeCatalogRelease } from './lib/native-catalog-publish.mjs';

const MANIFEST_URL = `${PRODUCTION_ORIGIN}/data/catalog/manifest.json`;
const sha256 = async (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const sha256Sync = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

// ── fakes ────────────────────────────────────────────────────────────────────
function makeFs() {
  const files = new Map();
  const faults = { writeFail: null, free: 10 ** 12 };
  const fs = {
    files,
    faults,
    async readText(p) { return files.has(p) ? files.get(p) : null; },
    async writeText(p, t) {
      if (faults.writeFail && faults.writeFail.test(p)) throw new Error('ENOSPC: no space left on device (injected)');
      files.set(p, t);
    },
    async move(from, to) {
      let moved = false;
      for (const k of [...files.keys()]) {
        if (k === from || k.startsWith(`${from}/`)) {
          const nk = to + k.slice(from.length);
          if (files.has(nk)) throw new Error('EEXIST (fake)');
          files.set(nk, files.get(k));
          files.delete(k);
          moved = true;
        }
      }
      if (!moved) throw new Error('ENOENT (fake)');
    },
    async remove(p) { for (const k of [...files.keys()]) if (k === p || k.startsWith(`${p}/`)) files.delete(k); },
    async ensureDir() {},
    async list(p) {
      const names = new Set();
      for (const k of files.keys()) if (k.startsWith(`${p}/`)) names.add(k.slice(p.length + 1).split('/')[0]);
      return [...names].sort();
    },
    async freeBytes() { return faults.free; },
  };
  return fs;
}

function resp(status, text, { headers = { 'content-type': 'application/json' }, url, redirected = false } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    redirected,
    headers: { get: (n) => headers[n.toLowerCase()] ?? null },
    text: async () => text,
  };
}

function makeNet() {
  const routes = new Map();
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const handler = routes.get(url);
    if (!handler) return resp(404, 'not found', { headers: { 'content-type': 'text/plain' } });
    return handler(url);
  };
  return { routes, calls, fetch };
}

// ── synthetic catalogs ───────────────────────────────────────────────────────
const card = (id, series, price = 100) => ({
  id,
  cardNumber: id.split('_')[0],
  name: `name-${id}`,
  series,
  sellPrice: price,
  prices: [{ name: `listing-${id}`, sellPrice: price, rarity: 'C', imageUrl: `https://card.yuyu-tei.jp/hocg/100_140/${series.toLowerCase()}/1.jpg` }],
});
function catalogDb(observedAt, extra = []) {
  const cards = {};
  for (const c of [card('hBP01-001_hBP01', 'hBP01'), card('hSD01-001_hSD01', 'hSD01'), ...extra]) cards[c.id] = c;
  return { lastUpdated: observedAt, totalCards: Object.keys(cards).length, source: 'synthetic', cards };
}
const NAMES = { hBP01: 'ブルーミングレディアンス', hSD01: 'スタートデッキ' };

/** Build a release WITHOUT sanitization (lets a test publish a hostile asset). */
function rawRelease(db, names, sequence, { publishedAt = new Date(sequence).toISOString(), mutate } = {}) {
  const dbText = JSON.stringify(db);
  const namesText = JSON.stringify(names);
  const dbSha = sha256Sync(dbText);
  const nSha = sha256Sync(namesText);
  const manifest = {
    format: 'holohunter-native-catalog',
    schemaVersion: 1,
    minClientSchema: 1,
    revision: `r-${dbSha.slice(0, 16)}-${nSha.slice(0, 8)}`,
    sequence,
    publishedAt,
    dataObservedAt: db.lastUpdated,
    cardCount: Object.keys(db.cards).length,
    assets: {
      database: { path: `/data/catalog/v1/database.${dbSha}.json`, bytes: Buffer.byteLength(dbText), sha256: dbSha },
      seriesNames: { path: `/data/catalog/v1/series-names.${nSha}.json`, bytes: Buffer.byteLength(namesText), sha256: nSha },
    },
  };
  mutate?.(manifest);
  return { manifest, manifestText: JSON.stringify(manifest), dbText, namesText };
}

function serve(net, rel, { dbText = rel.dbText, namesText = rel.namesText, dbHeaders, manifestOpts } = {}) {
  net.routes.set(MANIFEST_URL, () => resp(200, rel.manifestText, manifestOpts));
  net.routes.set(`${PRODUCTION_ORIGIN}${rel.manifest.assets.database.path}`, () => resp(200, dbText, dbHeaders ? { headers: dbHeaders } : undefined));
  net.routes.set(`${PRODUCTION_ORIGIN}${rel.manifest.assets.seriesNames.path}`, () => resp(200, namesText));
}

const BUNDLED_DB = catalogDb('2026-10-01T00:00:00.000Z');
const BUNDLED = { database: BUNDLED_DB, seriesNames: NAMES };
const OBS_A = '2026-11-02T12:00:00.000Z';
const OBS_B = '2026-11-05T12:10:54.218Z';
// Next dataset: a brand-new supported card in a brand-new series.
const DB_A = catalogDb(OBS_A, [card('hBP99-001_hBP99', 'hBP99', 480)]);
const NAMES_A = { ...NAMES, hBP99: 'シンセティックパック' };
const DB_B = catalogDb(OBS_B, [card('hBP99-001_hBP99', 'hBP99', 520), card('hBP99-002_hBP99', 'hBP99', 90)]);

function setup({ fs = makeFs(), net = makeNet(), clock = { t: 1_000_000 }, extra = {} } = {}) {
  const changes = [];
  const repo = createCatalogRepository({
    bundled: BUNDLED,
    platform: { fs, fetch: net.fetch, sha256 },
    minCardCount: 1,
    now: () => clock.t,
    timeouts: { manifestMs: 40, assetMs: 40, restoreWaitMs: 500 },
    policy: { minCheckIntervalMs: 60_000, backoffBaseMs: 1000, backoffMaxMs: 3_600_000, diskMarginBytes: 1024 },
    onChange: (s) => changes.push(s.revision),
    ...extra,
  });
  return { repo, fs, net, clock, changes };
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('── remote native catalog: repository ──');

await test('no platform (Node/tsc default): bundled only, refresh is unsupported and never fetches', async () => {
  const repo = createCatalogRepository({ bundled: BUNDLED, platform: null });
  await repo.ready();
  const snap = await repo.loadSnapshot();
  assert.equal(snap.revision, 'bundled');
  assert.equal(snap.database, BUNDLED_DB, 'the bundled object itself is served');
  assert.equal((await repo.refresh({ force: true })).status, 'unsupported');
});

await test('a new card in a new series is committed in the same client, with one change notification', async () => {
  const { repo, fs, net, changes } = setup();
  const relA = rawRelease(DB_A, NAMES_A, 100);
  serve(net, relA);
  const r = await repo.refresh();
  assert.equal(r.status, 'updated');
  const snap = repo.getSnapshot();
  assert.equal(snap.revision, relA.manifest.revision);
  assert.ok(snap.database.cards['hBP99-001_hBP99'], 'new supported card present');
  assert.equal(snap.seriesNames.hBP99, 'シンセティックパック', 'new series name present in the SAME revision');
  assert.equal(snap.dataObservedAt, OBS_A, 'observation time is the data\'s own, not the fetch time');
  assert.deepEqual(changes, [relA.manifest.revision]);
  assert.ok(fs.files.has(`revisions/${relA.manifest.revision}/database.json`));
  assert.ok([...fs.files.keys()].every((k) => !k.startsWith('staging/')), 'staging is cleaned after commit');
});

await test('restart offline restores the verified last-known-good revision; a failed check keeps it', async () => {
  const s1 = setup();
  const relA = rawRelease(DB_A, NAMES_A, 100);
  serve(s1.net, relA);
  await s1.repo.refresh();
  const offline = makeNet();
  offline.fetch = async () => { throw new TypeError('Network request failed'); };
  const s2 = setup({ fs: s1.fs, net: offline });
  const snap = await s2.repo.loadSnapshot();
  assert.equal(snap.revision, relA.manifest.revision, 'restored after process restart');
  assert.ok(snap.database.cards['hBP99-001_hBP99']);
  const r = await s2.repo.refresh();
  assert.equal(r.status, 'failed');
  assert.equal(s2.repo.getSnapshot().revision, relA.manifest.revision);
});

await test('first launch offline: bundled catalog, bounded backoff, a later attempt is allowed', async () => {
  const net = makeNet();
  net.fetch = async (url) => { net.calls.push(url); throw new TypeError('offline'); };
  const { repo, clock } = setup({ net });
  assert.equal((await repo.refresh()).status, 'failed');
  assert.equal(repo.getSnapshot().revision, 'bundled');
  assert.equal((await repo.refresh()).status, 'skipped', 'backoff: no immediate retry');
  clock.t += 1001;
  assert.equal((await repo.refresh()).status, 'failed', 'retried after the backoff');
  assert.equal(net.calls.length, 2);
});

await test('manifest timeout is bounded and leaves the catalog unchanged', async () => {
  const net = makeNet();
  net.routes.set(MANIFEST_URL, () => new Promise(() => {}));
  const { repo } = setup({ net });
  const started = Date.now();
  const r = await repo.refresh();
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /timeout/);
  assert.ok(Date.now() - started < 2000, 'returns promptly');
  assert.equal(repo.getSnapshot().revision, 'bundled');
});

await test('explicit refusal (403) is never retried in this process, even when forced', async () => {
  const net = makeNet();
  net.routes.set(MANIFEST_URL, () => resp(403, 'forbidden', { headers: { 'content-type': 'text/plain' } }));
  const { repo, clock } = setup({ net });
  assert.equal((await repo.refresh()).status, 'refused');
  clock.t += 10 ** 9;
  assert.equal((await repo.refresh({ force: true })).status, 'refused');
  assert.equal(net.calls.length, 1, 'no second request after an explicit refusal');
  assert.equal(repo.getStatus().refused, true);
});

await test('5xx backs off exponentially; 404 (not published) backs off to the maximum', async () => {
  const net = makeNet();
  net.routes.set(MANIFEST_URL, () => resp(503, 'busy'));
  const { repo, clock } = setup({ net });
  assert.equal((await repo.refresh()).status, 'failed');
  clock.t += 1001;
  assert.equal((await repo.refresh()).status, 'failed');
  clock.t += 1001;
  assert.equal((await repo.refresh()).status, 'skipped', 'second failure doubles the delay');
  net.routes.delete(MANIFEST_URL);
  clock.t += 5000;
  assert.equal((await repo.refresh()).status, 'failed');
  clock.t += 60_000;
  assert.equal((await repo.refresh()).status, 'skipped', '404 waits the maximum backoff');
});

for (const [label, mutateServe, reasonRe] of [
  ['wrong hash (same length, one byte changed)', (rel) => ({ dbText: rel.dbText.replace('name-hBP01', 'name-hBP0X') }), /hash or size/],
  ['truncated asset', (rel) => ({ dbText: rel.dbText.slice(0, -7) }), /hash or size/],
  ['declared oversize asset', () => ({ dbHeaders: { 'content-type': 'application/json', 'content-length': String(10 ** 9) } }), /oversize/],
  ['HTML fallback instead of JSON', () => ({ dbHeaders: { 'content-type': 'text/html' } }), /not json/],
]) {
  await test(`rejects ${label}; nothing persisted, catalog unchanged`, async () => {
    const { repo, fs, net, changes } = setup();
    const relA = rawRelease(DB_A, NAMES_A, 100);
    serve(net, relA, mutateServe(relA));
    const r = await repo.refresh();
    assert.equal(r.status, 'failed');
    assert.match(r.reason, reasonRe);
    assert.equal(repo.getSnapshot().revision, 'bundled');
    assert.deepEqual(changes, []);
    assert.equal([...fs.files.keys()].filter((k) => k.startsWith('revisions/') || k.startsWith('pointer')).length, 0);
  });
}

for (const [label, mutate, reasonRe] of [
  ['unsupported schemaVersion', (m) => { m.schemaVersion = 2; }, /schemaVersion/],
  ['a manifest that needs a newer client', (m) => { m.minClientSchema = 2; }, /newer client/],
  ['an asset on another origin', (m) => { m.assets.database.path = 'https://evil.example/data/catalog/v1/x.json'; }, /path/],
  ['a path whose name differs from its sha256', (m) => { m.assets.database.path = `/data/catalog/v1/database.${'0'.repeat(64)}.json`; }, /path/],
  ['a revision that does not match its assets', (m) => { m.revision = 'r-0000000000000000-00000000'; }, /revision/],
  ['an implausible size', (m) => { m.assets.database.bytes = 64 * 1024 * 1024; }, /size/],
]) {
  await test(`rejects a manifest with ${label}`, async () => {
    const { repo, net } = setup();
    const rel = rawRelease(DB_A, NAMES_A, 100, { mutate });
    serve(net, rel);
    const r = await repo.refresh();
    assert.equal(r.status, 'failed');
    assert.match(r.reason, reasonRe);
    assert.equal(net.calls.length, 1, 'no asset requested after a rejected manifest');
  });
}

await test('rejects invalid manifest JSON and a redirect to another origin', async () => {
  const s1 = setup();
  s1.net.routes.set(MANIFEST_URL, () => resp(200, '{"format":'));
  assert.match((await s1.repo.refresh()).reason, /invalid JSON/);
  const s2 = setup();
  const rel = rawRelease(DB_A, NAMES_A, 100);
  serve(s2.net, rel, { manifestOpts: { url: 'https://evil.example/data/catalog/manifest.json' } });
  assert.match((await s2.repo.refresh()).reason, /redirected/);
  const s3 = setup();
  serve(s3.net, rel, { manifestOpts: { redirected: true, url: MANIFEST_URL } });
  assert.match((await s3.repo.refresh()).reason, /redirected/);
});

for (const [label, hostile] of [
  ['card.priceHistory', (db) => { db.cards['hBP01-001_hBP01'].priceHistory = { '2026-11-01': 100 }; }],
  ['card.buyPrice', (db) => { db.cards['hBP01-001_hBP01'].buyPrice = 50; }],
  ['card.ytStats', (db) => { db.cards['hBP01-001_hBP01'].ytStats = { subs: 1 }; }],
  ['card._rawPricesArchive', (db) => { db.cards['hBP01-001_hBP01']._rawPricesArchive = []; }],
  ['prices[].buyPriceSource', (db) => { db.cards['hBP01-001_hBP01'].prices[0].buyPriceSource = 'shop'; }],
]) {
  await test(`a hash-consistent asset carrying ${label} is rejected, not stripped`, async () => {
    const { repo, fs, net } = setup();
    const db = structuredClone(DB_A);
    hostile(db);
    serve(net, rawRelease(db, NAMES_A, 100));
    const r = await repo.refresh();
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /rejected/);
    assert.equal(repo.getSnapshot().revision, 'bundled');
    assert.equal([...fs.files.keys()].filter((k) => !k.startsWith('staging/')).length, 0, 'nothing persisted');
  });
}

await test('partial write (injected ENOSPC while staging) keeps the previous revision, now and after restart', async () => {
  const s1 = setup();
  const relA = rawRelease(DB_A, NAMES_A, 100);
  serve(s1.net, relA);
  await s1.repo.refresh();
  const relB = rawRelease(DB_B, NAMES_A, 200);
  serve(s1.net, relB);
  s1.fs.faults.writeFail = /^staging\/.*series-names\.json$/;
  s1.clock.t += 10 ** 7;
  const r = await s1.repo.refresh();
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /write failed/);
  assert.equal(s1.repo.getSnapshot().revision, relA.manifest.revision);
  assert.ok([...s1.fs.files.keys()].every((k) => !k.startsWith('staging/')), 'staging cleaned');
  const s2 = setup({ fs: s1.fs });
  assert.equal((await s2.repo.loadSnapshot()).revision, relA.manifest.revision, 'restart still on A');
});

await test('low disk is detected before downloading the large asset', async () => {
  const { repo, fs, net } = setup();
  const relA = rawRelease(DB_A, NAMES_A, 100);
  serve(net, relA);
  fs.faults.free = 500;
  const r = await repo.refresh();
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /low disk/);
  assert.deepEqual(net.calls, [MANIFEST_URL], 'only the small manifest was fetched');
});

await test('a failed pointer commit leaves memory and disk on the old revision', async () => {
  const s1 = setup();
  const relA = rawRelease(DB_A, NAMES_A, 100);
  serve(s1.net, relA);
  s1.fs.faults.writeFail = /^pointer-/;
  const r = await s1.repo.refresh();
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /commit failed/);
  assert.equal(s1.repo.getSnapshot().revision, 'bundled');
  s1.fs.faults.writeFail = null;
  const s2 = setup({ fs: s1.fs });
  assert.equal((await s2.repo.loadSnapshot()).revision, 'bundled', 'uncommitted files are never used');
});

await test('a corrupt active revision falls back to previous-good on restart, then the same publish re-downloads', async () => {
  const s1 = setup();
  const relA = rawRelease(DB_A, NAMES_A, 100);
  const relB = rawRelease(DB_B, NAMES_A, 200);
  serve(s1.net, relA);
  await s1.repo.refresh();
  serve(s1.net, relB);
  s1.clock.t += 10 ** 7;
  assert.equal((await s1.repo.refresh()).status, 'updated');
  const bPath = `revisions/${relB.manifest.revision}/database.json`;
  s1.fs.files.set(bPath, s1.fs.files.get(bPath).replace('"hBP99-002', '"hBP99-00X'));
  const s2 = setup({ fs: s1.fs, net: s1.net });
  const restored = await s2.repo.loadSnapshot();
  assert.equal(restored.revision, relA.manifest.revision, 'previous-good used, never the corrupt bytes');
  assert.equal((await s2.repo.refresh()).status, 'updated', 'the corrupt publish is fetched again');
  assert.equal(s2.repo.getSnapshot().revision, relB.manifest.revision);
});

await test('concurrent refreshes share one request (single-flight)', async () => {
  const { repo, net } = setup();
  serve(net, rawRelease(DB_A, NAMES_A, 100));
  const p1 = repo.refresh();
  const p2 = repo.refresh({ force: true });
  assert.equal(p1, p2, 'the same in-flight promise');
  await p1;
  assert.equal(net.calls.filter((u) => u === MANIFEST_URL).length, 1);
});

await test('an older (out-of-order / replayed) manifest never replaces a newer revision', async () => {
  const { repo, net, clock, changes } = setup();
  const relB = rawRelease(DB_B, NAMES_A, 200);
  serve(net, relB);
  await repo.refresh();
  const relA = rawRelease(DB_A, NAMES_A, 150);
  serve(net, relA);
  clock.t += 10 ** 7;
  assert.equal((await repo.refresh()).status, 'unchanged');
  assert.equal(repo.getSnapshot().revision, relB.manifest.revision);
  assert.deepEqual(changes, [relB.manifest.revision]);
  assert.ok(!net.calls.some((u) => u.includes(relA.manifest.assets.database.sha256)), 'stale assets not even downloaded');
});

await test('trusted rollback: a NEW sequence naming the retained previous content reuses it without download; observation time stays honest', async () => {
  const { repo, net, clock } = setup();
  const relA = rawRelease(DB_A, NAMES_A, 100);
  const relB = rawRelease(DB_B, NAMES_A, 200);
  serve(net, relA);
  await repo.refresh();
  serve(net, relB);
  clock.t += 10 ** 7;
  await repo.refresh();
  const rollback = rawRelease(DB_A, NAMES_A, 300, { publishedAt: '2026-11-06T09:00:00.000Z' });
  net.routes.clear();
  net.routes.set(MANIFEST_URL, () => resp(200, rollback.manifestText));
  net.calls.length = 0;
  clock.t += 10 ** 7;
  assert.equal((await repo.refresh()).status, 'updated');
  const snap = repo.getSnapshot();
  assert.equal(snap.revision, relA.manifest.revision);
  assert.equal(snap.sequence, 300);
  assert.equal(snap.dataObservedAt, OBS_A, 'older data keeps its older observation time');
  assert.equal(snap.publishedAt, '2026-11-06T09:00:00.000Z');
  assert.deepEqual(net.calls, [MANIFEST_URL], 'no asset download for retained content');
});

await test('a manifest naming exactly the bundled bytes switches revision without downloading', async () => {
  const { repo, net } = setup();
  const same = rawRelease(BUNDLED_DB, NAMES, 50);
  net.routes.set(MANIFEST_URL, () => resp(200, same.manifestText));
  assert.equal((await repo.refresh()).status, 'updated');
  const snap = repo.getSnapshot();
  assert.equal(snap.database, BUNDLED_DB, 'served from the bundle');
  assert.equal(snap.revision, same.manifest.revision);
  assert.deepEqual(net.calls, [MANIFEST_URL]);
});

await test('an unchanged publish is not downloaded again and later checks are throttled', async () => {
  const { repo, net, clock } = setup();
  serve(net, rawRelease(DB_A, NAMES_A, 100));
  await repo.refresh();
  const before = net.calls.length;
  assert.equal((await repo.refresh()).status, 'skipped', 'within the check interval');
  clock.t += 60_001;
  assert.equal((await repo.refresh()).status, 'unchanged');
  assert.equal(net.calls.length, before + 1, 'only the manifest');
});

await test('the publisher\'s real output is accepted by the client contract (sanitized, honest times)', async () => {
  const canonical = structuredClone(DB_A);
  canonical.cards['hBP01-001_hBP01'].priceHistory = { '2026-11-01': 100 };
  canonical.cards['hBP01-001_hBP01'].buyPrice = 30;
  canonical.cards['hBP01-001_hBP01']._rawPricesArchive = [];
  const release = buildNativeCatalogRelease({ canonical, seriesNames: NAMES_A, now: new Date('2026-11-06T10:00:00.000Z') });
  const { repo, net } = setup();
  net.routes.set(MANIFEST_URL, () => resp(200, JSON.stringify(release.manifest)));
  for (const a of release.assets) net.routes.set(`${PRODUCTION_ORIGIN}/${a.rel}`, () => resp(200, a.text));
  assert.equal((await repo.refresh()).status, 'updated');
  const c = repo.getSnapshot().database.cards['hBP01-001_hBP01'];
  assert.ok(!('priceHistory' in c) && !('buyPrice' in c) && !('_rawPricesArchive' in c), 'published asset is sanitized');
  assert.equal(repo.getSnapshot().dataObservedAt, OBS_A);
  assert.equal(repo.getSnapshot().publishedAt, '2026-11-06T10:00:00.000Z');
});

await test('a throwing change listener does not break the commit', async () => {
  const { repo, net } = setup({ extra: { onChange: () => { throw new Error('listener boom'); } } });
  serve(net, rawRelease(DB_A, NAMES_A, 100));
  assert.equal((await repo.refresh()).status, 'updated');
});

console.log(`\n✅ remote catalog repository: ${passed} checks passed`);
