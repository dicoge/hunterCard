#!/usr/bin/env node
/**
 * test-last-known-price-builder-e2e.mjs — behavioural proof on the REAL builder
 * (2026-11-07 last-known price, independent review R3 + R1).
 *
 * Drives `scripts/build-database.js` twice with a HEALTHY yuyu fixture (every previously
 * priced card number scraped except one, so coverage stays above the DIC-1321 90% floor
 * and the run is not "partial") and checks on the written artifacts:
 *
 *   Build 1
 *     P  dropped proven listing (its card number is absent from the scrape): keeps its
 *        exact sellPrice AND its original timestamp; its durable price-history file gains
 *        NO record (in particular none dated today) — although P's timestamp is inside the
 *        DIC-1229 7-day window, i.e. exactly the row the pre-fix Step 5 stamped as "today".
 *     Q  R1 shape: the scrape MATCHED Q's exact printing but the listing carries no
 *        positive price (sellPrice 0) while stamped with this run's time. Q keeps its
 *        previous proven price, and its shipped timestamp is the PREVIOUS payload's time,
 *        never the fresh scrape time; no durable record is added.
 *     R  co-scraped fresh listing of an exact printing: shipped with the fixture's time and
 *        its durable history DOES gain today's record (the fix does not suppress fresh rows).
 *        (review B1) Q ships its preserved POSITIVE listings with the value — not the
 *        matched unpriced entry — so headline and variants agree and the bundle stays proven.
 *   Build 2 (stale → new cycle)
 *     P  the source quotes P again (new price): fresh value + new time, and today's record
 *        is written now; P's earlier durable records are unchanged.
 *     Q  still matched-but-unpriced (second missing cycle): value, original time, listings
 *        and durable history all conserved; the build passes DIC-1482 with no rejection.
 *
 * Fixture day state (2026-11-10, PR #287 CI 42826781972): P / Q / R are selected on row quality
 * with any `today` record ignored, then today's record (durable file) and today's key (in-memory
 * priceHistory) are removed for those three rows only, inside the snapshot below. Without that, a
 * data artifact built on the same UTC day (every fresh printing already holds a today record) left
 * 0 eligible rows, and the builder's same-date dedupe would make R's / P-build-2's "today record
 * written" proofs vacuous. Preconditions, a selection regression (today present / absent) and a
 * detector negative control are asserted before the builds.
 *
 * Isolation: the run touches the REAL data/ tree of THIS worktree (same contract as
 * test-dic1334-final-artifact-collapse.mjs / test-market-field-preservation.mjs): every
 * file the builder may write is snapshotted byte-for-byte first and restored in `finally`,
 * new files are removed, and a self-check proves the worktree is byte-identical afterwards.
 * No network: the child process gets a preload that makes http/https/fetch fail
 * asynchronously (so the builder's image download cleans up after itself), and any new
 * data/images file is removed as well. Nothing is committed. Run only in a dedicated worktree.
 *
 * Run: node scripts/test-last-known-price-builder-e2e.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classifyExactPrintPayload } from './lib/price-regression-gate.mjs';
import { historyFilenameFor } from './lib/preserve-market-fields.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..');
const dataDir = path.join(repo, 'data');
const dbPath = path.join(dataDir, 'database.json');
const publicDbPath = path.join(repo, 'public/data/database.json');
const historyDir = path.join(dataDir, 'price-history');
const imagesDir = path.join(dataDir, 'images');

const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const utcToday = () => new Date().toISOString().split('T')[0];

// ── snapshot everything a build may write ────────────────────────────────
const originalDb = fs.readFileSync(dbPath, 'utf8');
const preRunBytes = new Map();
const snap = (p) => { if (fs.existsSync(p) && fs.statSync(p).isFile()) preRunBytes.set(p, fs.readFileSync(p)); };
snap(dbPath);
snap(publicDbPath);
for (const f of fs.readdirSync(dataDir)) snap(path.join(dataDir, f)); // top-level data files (scrape-log, rejections, …)
for (const f of fs.readdirSync(historyDir)) snap(path.join(historyDir, f));
const dataTopBefore = new Set(fs.readdirSync(dataDir));
const historyBefore = new Set(fs.readdirSync(historyDir));
const imagesBefore = fs.existsSync(imagesDir) ? new Set(fs.readdirSync(imagesDir)) : null;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'last-known-builder-'));
const noNetwork = path.join(tmp, 'no-network.mjs');
fs.writeFileSync(noNetwork, `
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
const blocked = (target) => {
  const req = new EventEmitter();
  req.end = () => req; req.destroy = () => req; req.setTimeout = () => req; req.write = () => true;
  // Asynchronous, after the caller's write stream opened, so its own error path unlinks it.
  setTimeout(() => req.emit('error', new Error('network disabled in last-known builder e2e: ' + String(target).slice(0, 80))), 25);
  return req;
};
for (const m of [http, https]) { m.get = blocked; m.request = blocked; }
globalThis.fetch = async () => { throw new Error('network disabled in last-known builder e2e'); };
`);

const historyFile = (id) => path.join(historyDir, historyFilenameFor(id));
const readHistory = (id) => { try { return JSON.parse(fs.readFileSync(historyFile(id), 'utf8')); } catch { return null; } };
const fileBytes = (p) => (fs.existsSync(p) ? fs.readFileSync(p) : null);
const sameBytes = (a, b) => (a === null && b === null) || (a !== null && b !== null && a.equals(b));

function runBuild(fixture, label) {
  const fixturePath = path.join(tmp, `${label}.json`);
  fs.writeFileSync(fixturePath, JSON.stringify(fixture));
  const res = spawnSync(process.execPath, ['--import', pathToFileURL(noNetwork).href, 'scripts/build-database.js'], {
    cwd: repo,
    env: { ...process.env, HUNTERCARD_YUYU_FIXTURE_PATH: fixturePath },
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 256 * 1024 * 1024,
  });
  assert.equal(res.status, 0, `${label}: build-database must succeed\nSTDOUT tail:\n${(res.stdout || '').slice(-4000)}\nSTDERR tail:\n${(res.stderr || '').slice(-4000)}`);
  return res;
}

const hasDate = (h, date) => Array.isArray(h?.records) && h.records.some((r) => r.date === date);

function groupByNumber(cardsMap) {
  const rowsByNumber = new Map();
  for (const c of Object.values(cardsMap)) {
    if (!c?.cardNumber) continue;
    if (!rowsByNumber.has(c.cardNumber)) rowsByNumber.set(c.cardNumber, []);
    rowsByNumber.get(c.cardNumber).push(c);
  }
  return rowsByNumber;
}

/**
 * P / Q / R candidates: single-row, origin-product, exact-print-proven, priced. A `today` record
 * (durable file) or `today` key (in-memory priceHistory) is IGNORED here — it is fixture day state,
 * removed for the three selected rows by isolateToday — so the selection is the same whether the
 * artifact was built today or on an earlier day.
 */
function selectRows(rowsByNumber, readHistoryFn, today) {
  const eligible = [];
  const rejected = {};
  let withTodayRecord = 0;
  const reject = (why) => { rejected[why] = (rejected[why] || 0) + 1; };
  for (const [num, rows] of rowsByNumber) {
    if (rows.length !== 1) { reject('multi-row'); continue; }
    const r = rows[0];
    if (!(Number.isFinite(r.sellPrice) && r.sellPrice > 0)) { reject('unpriced'); continue; }
    const m = /^([A-Za-z]+[0-9]+)-\d+$/.exec(num);
    const product = String(r.sourceProduct || '');
    if (!m || !/^h(BP|SD|EB)\d+$/i.test(product) || product.toLowerCase() !== m[1].toLowerCase()) { reject('not-origin-product'); continue; }
    if (!/^[A-Z]{1,4}$/.test(String(r.rarity || ''))) { reject('rarity'); continue; }
    if (!classifyExactPrintPayload(r).proven) { reject('not-proven'); continue; }
    const h = readHistoryFn(r.id);
    const recs = (Array.isArray(h?.records) ? h.records : []).filter((x) => x.date !== today);
    // the builder's own anomaly filter (median of the records that remain) would skip P's build-2 quote
    const prices = recs.map((x) => x.price).filter((p) => p && p > 0).sort((a, b) => a - b);
    const median = prices.length >= 3 ? prices[Math.floor(prices.length / 2)] : null;
    if (median && r.sellPrice + 10 > median * 5) { reject('anomaly'); continue; }
    // Preservation re-derives the top-level price from the row's own listings; pick rows
    // whose shipped price IS that derivation so the assertion measures only this change.
    const listed = (r.prices || []).map((e) => e?.sellPrice).filter((p) => Number.isFinite(p) && p > 0);
    if (listed.length > 0 && Math.min(...listed) !== r.sellPrice) { reject('listing-derivation'); continue; }
    // The DIC-1204 seed step legitimately back-fills a durable file from in-memory history
    // dates it lacks; pick rows already consistent so "file untouched" isolates Step 5.
    const fileDates = new Set(recs.map((x) => x.date));
    if (Object.keys(r.priceHistory || {}).some((d) => d !== today && !fileDates.has(d))) { reject('seed-backfill'); continue; }
    if (hasDate(h, today) || Object.hasOwn(r.priceHistory || {}, today)) withTodayRecord += 1;
    eligible.push(r);
  }
  return { eligible, rejected, withTodayRecord };
}

/** Remove today's record (durable file) and today's key (in-memory priceHistory) for ONE fixture row. */
function isolateToday(id, workingCard, today) {
  let removedFile = 0;
  let removedMemory = 0;
  const h = readHistory(id);
  if (hasDate(h, today)) {
    const kept = h.records.filter((r) => r.date !== today);
    removedFile = h.records.length - kept.length;
    fs.writeFileSync(historyFile(id), JSON.stringify({ ...h, records: kept }, null, 2));
  }
  if (workingCard.priceHistory && Object.hasOwn(workingCard.priceHistory, today)) {
    delete workingCard.priceHistory[today];
    removedMemory = 1;
  }
  return { removedFile, removedMemory };
}

let passed = false;
try {
  const base = JSON.parse(originalDb);
  const cards = base.cards || {};

  // Single-row, origin-product, exact-print-proven priced printings (no sibling can
  // interfere with the per-printing assertions).
  const rowsByNumber = groupByNumber(cards);
  const today0 = utcToday();

  // 2026-11-10 (PR #287 CI 42826781972): the old selection REJECTED every row whose durable file
  // already held a `today` record. A daily data PR built on the same UTC day carries exactly such
  // records for every freshly scraped printing (2026-11-10: 1954 files), so 0 rows were eligible.
  // A pre-existing today record is a FIXTURE-STATE problem, not a row-quality one: the builder's
  // Step 5 never adds a second record for a date it already has (`existingDates.has(today)`), so
  // R's / P-build-2's "today record written" proofs would be vacuous or impossible. Fix: select on
  // the row's quality with today's record IGNORED, then (inside the snapshot, restored in finally)
  // remove today's record from the selected P / Q / R only — durable file AND in-memory
  // priceHistory, so the DIC-1204 seed cannot re-add it — and assert that precondition.
  const sel = selectRows(rowsByNumber, readHistory, today0);
  assert.ok(sel.eligible.length >= 3,
    `need 3 single-row proven printings, found ${sel.eligible.length}; rejections ${JSON.stringify(sel.rejected)}`);
  console.log(`  · selection: ${sel.eligible.length} eligible; ${sel.withTodayRecord} of them already had a ${today0} record `
    + `(the pre-fix rule would have left ${sel.eligible.length - sel.withTodayRecord}); rejections ${JSON.stringify(sel.rejected)}`);
  const [P, Q, R] = sel.eligible;

  // Regression (no builder): the selection must not depend on whether today's records exist.
  {
    const ids = (s) => s.eligible.map((r) => r.id);
    const withToday = (id) => {
      const h = readHistory(id) || { records: [] };
      return { ...h, records: [...(h.records || []).filter((r) => r.date !== today0), { date: today0, price: 1, source: 'yuyu-tei' }] };
    };
    const withoutToday = (id) => {
      const h = readHistory(id);
      return h ? { ...h, records: (h.records || []).filter((r) => r.date !== today0) } : h;
    };
    assert.deepEqual(ids(selectRows(rowsByNumber, withToday, today0)), ids(sel), 'selection unchanged when EVERY row already has a today record (daily-PR state)');
    assert.deepEqual(ids(selectRows(rowsByNumber, withoutToday, today0)), ids(sel), 'selection unchanged when NO row has a today record');
    // the quality filters still bite (sanity negative controls on the real P row)
    const cheap = (id) => (id === P.id ? { records: ['2000-01-01', '2000-01-02', '2000-01-03'].map((date) => ({ date, price: 1 })) } : readHistory(id));
    const sA = selectRows(rowsByNumber, cheap, today0);
    assert.ok(!ids(sA).includes(P.id) && sA.rejected.anomaly >= 1, 'anomaly filter still rejects a row the builder would skip');
    const drifted = new Map(rowsByNumber);
    drifted.set(P.cardNumber, [{ ...P, priceHistory: { ...(P.priceHistory || {}), '2000-01-01': P.sellPrice } }]);
    const sB = selectRows(drifted, readHistory, today0);
    assert.ok(!ids(sB).includes(P.id) && sB.rejected['seed-backfill'] >= 1, 'seed-backfill filter still rejects a row the DIC-1204 seed would touch');
  }

  // Healthy fixture (same shape as test-dic1334-final-artifact-collapse.mjs): one listing
  // per previously priced card number, on its origin-product printing, at its own price.
  const NOW1 = iso(Date.now());
  const fixture = { prices: {}, totalCards: 0, seriesWithPrices: 1, pricingUnavailable: false };
  const listing = (row, price, timestamp) => {
    const product = String(row.sourceProduct || row.series || '').toLowerCase();
    return {
      sellPrice: price, rarity: row.rarity || '', name: row.name || row.cardNumber,
      yuyuImage: `https://card.yuyu-tei.jp/hocg/100_140/${product}/lastknown.jpg`,
      imageVersion: product, imageCid: 'lastknown', sourceSeries: product, timestamp,
    };
  };
  for (const [num, rows] of rowsByNumber) {
    const priced = rows.filter((c) => Number.isFinite(c.sellPrice) && c.sellPrice > 0);
    if (priced.length === 0) continue;
    const origin = priced.find((r) => {
      const prefix = String(r.cardNumber || '').match(/^([A-Za-z]+[0-9A-Za-z]*)-\d+/);
      return prefix && String(r.sourceProduct || r.series || '').toLowerCase() === prefix[1].toLowerCase();
    }) || priced[0];
    fixture.prices[num] = [listing(origin, origin.sellPrice, NOW1)];
  }
  delete fixture.prices[P.cardNumber];                              // P rotated out of the source
  fixture.prices[Q.cardNumber] = [listing(Q, 0, NOW1)];            // Q matched, no positive price
  fixture.totalCards = Object.keys(fixture.prices).length * 2;
  const prevCoverage = new Set(Object.values(cards).filter((c) => c.sellPrice > 0).map((c) => c.cardNumber)).size;
  assert.ok(Object.keys(fixture.prices).length >= prevCoverage * 0.9, 'fixture must be a HEALTHY (non-partial) scrape');

  // P inside the DIC-1229 window (the pre-fix Step 5 would stamp it today); Q older.
  const P_TS = iso(Date.now() - 2 * DAY);
  const Q_TS = iso(Date.now() - 10 * DAY);
  const working = JSON.parse(originalDb);
  working.cards[P.id].timestamp = P_TS;
  working.cards[Q.id].timestamp = Q_TS;
  // Controlled fixture day state for P / Q / R only (every history file and the db are already
  // snapshotted byte-for-byte above and restored in finally): no `today` record anywhere.
  const isolated = [P, Q, R].map((row) => isolateToday(row.id, working.cards[row.id], today0));
  fs.writeFileSync(dbPath, `${JSON.stringify(working, null, 2)}\n`);
  for (const row of [P, Q, R]) {
    assert.equal(hasDate(readHistory(row.id), today0), false, `precondition: ${row.id} durable file has no ${today0} record`);
    assert.equal(Object.hasOwn(working.cards[row.id].priceHistory || {}, today0), false, `precondition: ${row.id} in-memory priceHistory has no ${today0}`);
    const fileDates = new Set((readHistory(row.id)?.records || []).map((x) => x.date));
    assert.ok(Object.keys(working.cards[row.id].priceHistory || {}).every((d) => fileDates.has(d)), `precondition: ${row.id} seed step has nothing to back-fill`);
  }
  console.log(`  · today-isolated fixture rows: ${isolated.map((x, i) => `${'PQR'[i]}=${x.removedFile}f/${x.removedMemory}m`).join(' ')} (records / keys removed for ${today0})`);
  const pHistBefore = fileBytes(historyFile(P.id));
  const qHistBefore = fileBytes(historyFile(Q.id));
  const rHistBefore = readHistory(R.id);
  // Detector sensitivity (negative control for the "no today record" proof): the record the
  // pre-fix Step 5 would stamp on P is NOT deduplicated away (today's date is now absent), and the
  // builder rewrites any file it emits a record for — so either predicate below would trip.
  {
    const stamped = JSON.parse(pHistBefore.toString('utf8'));
    stamped.records.push({ date: today0, price: P.sellPrice, source: 'yuyu-tei', currency: 'JPY', cardId: P.id });
    assert.equal(hasDate(stamped, today0), true, 'negative control: an erroneous today stamp on P is detectable by date');
    assert.equal(sameBytes(Buffer.from(JSON.stringify(stamped, null, 2)), pHistBefore), false, 'negative control: …and by bytes');
  }

  // ── Build 1 ──
  const b1 = runBuild(fixture, 'build1-healthy');
  const today1 = utcToday();
  const out1 = JSON.parse(fs.readFileSync(dbPath, 'utf8')).cards;

  assert.equal(out1[P.id]?.sellPrice, P.sellPrice, 'P: dropped proven listing keeps its exact price');
  assert.equal(out1[P.id]?.timestamp, P_TS, 'P: original timestamp kept verbatim (not restamped)');
  assert.ok(sameBytes(fileBytes(historyFile(P.id)), pHistBefore), 'P: durable history untouched — no today record for a price the source did not quote');
  assert.equal(hasDate(readHistory(P.id), today0) || hasDate(readHistory(P.id), today1), false, 'P: no record dated today (fixture had none, builder added none)');
  assert.match(b1.stdout, /\[last-known\] Step 5 wrote no today record for (\d+) last-known/, 'builder reports last-known rows skipped at Step 5');

  assert.equal(out1[Q.id]?.sellPrice, Q.sellPrice, 'Q (R1): previous proven price kept');
  assert.equal(out1[Q.id]?.timestamp, Q_TS, 'Q (R1): shipped time is the preserved payload\'s, NOT this scrape\'s');
  assert.notEqual(out1[Q.id]?.timestamp, NOW1);
  assert.ok(sameBytes(fileBytes(historyFile(Q.id)), qHistBefore), 'Q (R1): no durable record added');
  assert.equal(hasDate(readHistory(Q.id), today0) || hasDate(readHistory(Q.id), today1), false, 'Q (R1): no record dated today');
  const positiveOf = (row) => (row?.prices || []).map((e) => e?.sellPrice).filter((p) => Number.isFinite(p) && p > 0);
  assert.ok(positiveOf(out1[Q.id]).length > 0, 'Q (B1): its preserved listings ship with the value (not the matched unpriced entry)');
  assert.equal(Math.min(...positiveOf(out1[Q.id])), Q.sellPrice, 'Q (B1): headline = cheapest preserved listing (headline and variants agree)');
  assert.equal(classifyExactPrintPayload(out1[Q.id]).proven, true, 'Q (B1): the shipped bundle stays exact-print proven for the next build');
  // Explicit "no new quote this run" (2026-11-07): stated by the writer for P (2 days old,
  // i.e. inside the 7-day window — age alone would have called it fresh) and Q; never for R.
  assert.equal(out1[P.id]?.sellQuoteRetained, true, 'P: retained status is explicit even though its quote is < 7 days old');
  assert.equal(out1[Q.id]?.sellQuoteRetained, true, 'Q: matched-but-unpriced → retained');
  assert.equal(out1[R.id]?.sellQuoteRetained, undefined, 'R: freshly priced this run → no retained flag');

  assert.equal(out1[R.id]?.sellPrice, R.sellPrice, 'R: fresh exact-printing quote');
  assert.equal(out1[R.id]?.timestamp, NOW1, 'R: carries its own (fixture) quote time');
  const rRecs = readHistory(R.id)?.records || [];
  assert.ok(rRecs.some((r) => (r.date === today0 || r.date === today1) && r.price === R.sellPrice),
    'R: a freshly scraped printing DOES get today\'s durable record');
  {
    // non-vacuous: the fixture had NO today record for R, so this one was written by build 1, and it
    // is the only addition (every earlier record kept)
    const rKey = (r) => JSON.stringify([r.date, r.price, r.source ?? null, r.sourceProduct ?? null]);
    const rBefore = new Set(((rHistBefore && rHistBefore.records) || []).map(rKey));
    const rAfter = new Set(rRecs.map(rKey));
    assert.ok([...rBefore].every((k) => rAfter.has(k)), 'R: every earlier durable record is unchanged');
    const rAdded = rRecs.filter((r) => !rBefore.has(rKey(r)));
    assert.deepEqual(rAdded.map((r) => r.price), [R.sellPrice], 'R: build 1 added exactly today\'s record');
    assert.ok([today0, today1].includes(rAdded[0].date), 'R: dated today');
  }
  console.log(`  ✓ build 1 (healthy): P kept ¥${P.sellPrice} @ ${P_TS} with no new record; Q kept ¥${Q.sellPrice} @ ${Q_TS} (not the scrape time); R recorded today`);

  // ── Build 2: the source quotes P again ──
  const NOW2 = iso(Date.now());
  const fixture2 = { ...fixture, prices: { ...fixture.prices, [P.cardNumber]: [listing(P, P.sellPrice + 10, NOW2)] } };
  fixture2.totalCards = Object.keys(fixture2.prices).length * 2;
  runBuild(fixture2, 'build2-recovered');
  const today2 = utcToday();
  const out2 = JSON.parse(fs.readFileSync(dbPath, 'utf8')).cards;
  assert.equal(out2[P.id]?.sellPrice, P.sellPrice + 10, 'P: the new verified quote wins');
  assert.equal(out2[P.id]?.timestamp, NOW2, 'P: and carries its own new time');
  assert.equal(out2[P.id]?.sellQuoteRetained, undefined, 'P: a new quote clears the retained status');
  assert.equal(out2[Q.id]?.sellQuoteRetained, true, 'Q: still no new quote → still retained');
  const pRecs = readHistory(P.id)?.records || [];
  assert.ok(pRecs.some((r) => [today0, today1, today2].includes(r.date) && r.price === P.sellPrice + 10),
    'P: once quoted again, today\'s record IS written');
  console.log(`  ✓ build 2 (recovered): P fresh ¥${P.sellPrice + 10} @ ${NOW2} with today's record`);

  // Q's listing is STILL matched-but-unpriced in build 2 (second missing cycle): the same
  // bundle must survive unchanged — value, original time, listings, and no durable record.
  assert.equal(out2[Q.id]?.sellPrice, Q.sellPrice, 'Q (B1, 2nd cycle): value conserved');
  assert.equal(out2[Q.id]?.timestamp, Q_TS, 'Q (B1, 2nd cycle): original time conserved');
  assert.equal(Math.min(...positiveOf(out2[Q.id])), Q.sellPrice, 'Q (B1, 2nd cycle): listings conserved, headline = variant');
  assert.ok(sameBytes(fileBytes(historyFile(Q.id)), qHistBefore), 'Q (B1, 2nd cycle): still no durable record');
  {
    const key = (r) => JSON.stringify([r.date, r.price, r.source ?? null, r.sourceProduct ?? null]);
    const before = (pHistBefore ? JSON.parse(pHistBefore.toString('utf8')).records : null) || [];
    const after = readHistory(P.id)?.records || [];
    const afterKeys = new Set(after.map(key));
    assert.ok(before.every((r) => afterKeys.has(key(r))), 'P: every earlier durable record is unchanged');
    const beforeKeys = new Set(before.map(key));
    const added = after.filter((r) => !beforeKeys.has(key(r)));
    assert.deepEqual(added.map((r) => r.price), [P.sellPrice + 10], 'P: build 2 added exactly the new quote\'s record');
    assert.ok([today0, today1, today2].includes(added[0].date), 'P: dated today');
  }
  console.log(`  ✓ build 2: Q's preserved bundle (¥${Q.sellPrice} @ ${Q_TS}) survived a second missing cycle`);

  console.log('✓ last-known price builder e2e passed');
  passed = true;
} finally {
  // Restore: remove files the builds created, then put back every snapshotted byte.
  for (const f of fs.readdirSync(historyDir)) {
    if (!historyBefore.has(f)) fs.rmSync(path.join(historyDir, f), { recursive: true, force: true });
  }
  for (const f of fs.readdirSync(dataDir)) {
    if (!dataTopBefore.has(f)) fs.rmSync(path.join(dataDir, f), { recursive: true, force: true });
  }
  if (imagesBefore) {
    for (const f of fs.readdirSync(imagesDir)) {
      if (!imagesBefore.has(f)) fs.rmSync(path.join(imagesDir, f), { force: true });
    }
  }
  for (const [p, bytes] of preRunBytes) fs.writeFileSync(p, bytes);
  fs.rmSync(tmp, { recursive: true, force: true });

  if (passed) {
    const dirty = [];
    for (const [p, bytes] of preRunBytes) if (!fs.existsSync(p) || !fs.readFileSync(p).equals(bytes)) dirty.push(p);
    for (const f of fs.readdirSync(historyDir)) if (!historyBefore.has(f)) dirty.push(`${f} (new)`);
    for (const f of fs.readdirSync(dataDir)) if (!dataTopBefore.has(f)) dirty.push(`data/${f} (new)`);
    if (imagesBefore) for (const f of fs.readdirSync(imagesDir)) if (!imagesBefore.has(f)) dirty.push(`images/${f} (new)`);
    assert.deepEqual(dirty, [], `worktree must be restored byte-for-byte; still differing: ${dirty.join(', ')}`);
    console.log('  ✓ worktree-hermetic: every touched file restored byte-for-byte, no new file left');
  }
}
