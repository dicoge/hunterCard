#!/usr/bin/env node
/**
 * test-last-known-buy-pipeline-e2e.mjs — the REAL daily order, end to end (2026-11-07):
 *
 *   build-database.js  →  merge-buy-prices.js   (local-scrape-and-push.sh order)
 *
 * PR 2834252d46f dropped proven buy quotes: the rebuild erased the per-variant buy tuple and
 * the merge cleared every variant without a fresh source match (Torecolo 403 / stale / missing
 * file). This drives both real CLIs and checks on the written artifact:
 *
 *   build 1   no variant ships a current buy claim; X's exact variant holds its previous
 *             buy evidence (buyLastKnown); X (dropped from the sell scrape) is sellQuoteRetained.
 *   merge 1   fresh quote for X's variant (observed this run) → tuple with its own source/time,
 *             no retained flag; every other variant: verified last-known, retained.
 *   build 2 → merge 2   source files MISSING → X keeps merge 1's exact tuple, retained;
 *             NO buy history record changes anywhere; no holder ships.
 *   merge 3   corrupt source file → byte-identical buy state to merge 2 (repeated missing).
 *   gate      after merges 1–4 the REAL CI gate (test-buy-price-regen-deterministic.mjs) runs on
 *             the artifact with that merge's source dir and must pass in run-proof mode (N5).
 *   merge 4   a NEW observation of the same value → fresh again, retained cleared, earlier
 *             history records unchanged.
 *   public    the Store MVP / native projection of the final artifact has no buy field at all,
 *             and the full web projection has no internal holder.
 *
 * Prior-source path (review N1, the PR283 card-level-only shape), control card Y — an existing
 * own-set identity whose every buy field is removed from the working previous artifact, so its
 * only evidence is the PRE-SCRAPE cache the builder sees:
 *   build 1 captures it (`buyPriorSource`, never a claim) → merge 1's PARTIAL file omits Y →
 *   card-level retained with exact key / version / shop / own time → build 2 sees only the
 *   partial cache yet carries the card holder → merge 2 / 3 (missing, corrupt) still retained.
 *
 * Isolation (same contract as test-last-known-price-builder-e2e.mjs): every file the build or
 * merge may write is snapshotted byte-for-byte and restored in `finally`, new files removed,
 * and a self-check proves the worktree is byte-identical afterwards. No network: both child
 * processes get a preload that makes http/https/fetch fail. Every buy cache the children read
 * lives in os.tmpdir() (HUNTERCARD_BUY_PRICES_DIR); data/buy-prices is never read by the
 * children and never written. data/database.json is rewritten (Y control) and restored.
 *
 * Run: node scripts/test-last-known-buy-pipeline-e2e.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classifyExactPrintPayload } from './lib/price-regression-gate.mjs';
import { historyFilenameFor } from './lib/preserve-market-fields.js';
import {
  classifyVariant, isKnownRarityCode, isOwnSetPrinting, isPremiumRarityCode, normalizeRarityCode,
} from './lib/variant-key.js';
import { sanitizeDatabase, stripInternalAuditDatabase } from './lib/store-mvp-sanitize.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..');
const dataDir = path.join(repo, 'data');
const dbPath = path.join(dataDir, 'database.json');
const publicDbPath = path.join(repo, 'public/data/database.json');
const historyDir = path.join(dataDir, 'price-history');
const imagesDir = path.join(dataDir, 'images');
const buyDirReal = path.join(dataDir, 'buy-prices');

const iso = (ms) => new Date(ms).toISOString();
const localDay = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ── snapshot everything a build / merge may write ────────────────────────
const originalDb = fs.readFileSync(dbPath, 'utf8');
const preRunBytes = new Map();
const snap = (p) => { if (fs.existsSync(p) && fs.statSync(p).isFile()) preRunBytes.set(p, fs.readFileSync(p)); };
snap(dbPath);
snap(publicDbPath);
for (const f of fs.readdirSync(dataDir)) snap(path.join(dataDir, f));
for (const f of fs.readdirSync(historyDir)) snap(path.join(historyDir, f));
if (fs.existsSync(buyDirReal)) for (const f of fs.readdirSync(buyDirReal)) snap(path.join(buyDirReal, f));
const dataTopBefore = new Set(fs.readdirSync(dataDir));
const historyBefore = new Set(fs.readdirSync(historyDir));
const imagesBefore = fs.existsSync(imagesDir) ? new Set(fs.readdirSync(imagesDir)) : null;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'last-known-buy-e2e-'));
const noNetwork = path.join(tmp, 'no-network.mjs');
fs.writeFileSync(noNetwork, `
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
const blocked = (target) => {
  const req = new EventEmitter();
  req.end = () => req; req.destroy = () => req; req.setTimeout = () => req; req.write = () => true;
  setTimeout(() => req.emit('error', new Error('network disabled in last-known buy e2e: ' + String(target).slice(0, 80))), 25);
  return req;
};
for (const m of [http, https]) { m.get = blocked; m.request = blocked; }
globalThis.fetch = async () => { throw new Error('network disabled in last-known buy e2e'); };
`);

function child(args, env, label) {
  const res = spawnSync(process.execPath, ['--import', pathToFileURL(noNetwork).href, ...args], {
    cwd: repo,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 256 * 1024 * 1024,
  });
  assert.equal(res.status, 0, `${label} must succeed\nSTDOUT tail:\n${(res.stdout || '').slice(-4000)}\nSTDERR tail:\n${(res.stderr || '').slice(-4000)}`);
  return res;
}
function runBuild(fixture, label, buyCacheDir) {
  const fixturePath = path.join(tmp, `${label}.json`);
  fs.writeFileSync(fixturePath, JSON.stringify(fixture));
  // buyCacheDir = the source cache "on disk" when the builder runs (before the buy scrapes).
  return child(['scripts/build-database.js'], { HUNTERCARD_YUYU_FIXTURE_PATH: fixturePath, HUNTERCARD_BUY_PRICES_DIR: buyCacheDir }, label);
}
function sourceDir(files, label) {
  const dir = fs.mkdtempSync(path.join(tmp, `${label}-buy-`));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}
function runMerge(files, runStartedAtMs, label) {
  const dir = sourceDir(files, label);
  const res = child(['scripts/merge-buy-prices.js'], {
    HUNTERCARD_BUY_PRICES_DIR: dir,
    HUNTERCARD_RUN_STARTED_AT: String(Math.floor(runStartedAtMs / 1000)),
  }, label);
  return { res, dir };
}
const readCards = () => JSON.parse(fs.readFileSync(dbPath, 'utf8')).cards;
/**
 * Review N5: the REAL CI byte-identity gate on the artifact the real builder + merge just wrote,
 * with that merge's own source dir (read-only; the gate writes nothing).
 */
function runRegenGate(buyDir, label) {
  const res = spawnSync(process.execPath, ['scripts/test-buy-price-regen-deterministic.mjs'], {
    cwd: repo, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, HUNTERCARD_BUY_PRICES_DIR: buyDir },
  });
  assert.equal(res.status, 0, `${label}: the merge artifact must be a fixed point of test:buy-price-regen\n${(res.stderr || res.stdout || '').slice(-3000)}`);
  assert.match(res.stdout, /mode=run-proof/, `${label}: the gate reproduced the merge from its run proof`);
}
const historyFile = (id) => path.join(historyDir, historyFilenameFor(id));
const readHistory = (id) => { try { return JSON.parse(fs.readFileSync(historyFile(id), 'utf8')); } catch { return null; } };
const allBuyHistories = (cards) => JSON.stringify(Object.fromEntries(Object.entries(cards).map(([id, c]) => [id, c.buyPriceHistory ?? null])));
const holders = (cards) => Object.values(cards).reduce((n, c) => n + (c.prices || []).filter((p) => p && 'buyLastKnown' in p).length, 0);
const tupleOf = (p) => ({ buyPrice: p?.buyPrice, buyPriceVersion: p?.buyPriceVersion, buyPriceSource: p?.buyPriceSource, buyPriceTimestamp: p?.buyPriceTimestamp, buyPriceRetained: p?.buyPriceRetained });

let passed = false;
try {
  const base = JSON.parse(originalDb);
  const cards = base.cards || {};
  const rowsByNumber = new Map();
  for (const c of Object.values(cards)) {
    if (!c?.cardNumber) continue;
    if (!rowsByNumber.has(c.cardNumber)) rowsByNumber.set(c.cardNumber, []);
    rowsByNumber.get(c.cardNumber).push(c);
  }

  // X: a single-row, origin-product, exact-print-proven priced printing (so dropping it from
  // the sell scrape preserves its own prices[] labels) with one uniquely-labelled variant that
  // carries a complete committed buy tuple whose version equals the label's own class.
  let X = null;
  let XV = null;
  for (const [num, rows] of rowsByNumber) {
    if (rows.length !== 1) continue;
    const r = rows[0];
    if (!(Number.isFinite(r.sellPrice) && r.sellPrice > 0)) continue;
    const m = /^([A-Za-z]+[0-9]+)-\d+$/.exec(num);
    const product = String(r.sourceProduct || '');
    if (!m || !/^h(BP|SD|EB)\d+$/i.test(product) || product.toLowerCase() !== m[1].toLowerCase()) continue;
    if (!classifyExactPrintPayload(r).proven) continue;
    // The DIC-1204 seed step back-fills a durable sell file from in-memory dates it lacks;
    // pick a row already consistent so "sell history untouched" isolates the buy pipeline.
    const fileDates = new Set((readHistory(r.id)?.records || []).map((x) => x.date));
    if (Object.keys(r.priceHistory || {}).some((d) => !fileDates.has(d))) continue;
    const labels = (r.prices || []).map((p) => p?.name);
    const v = (r.prices || []).find((p) => p && p.buyPrice > 0 && typeof p.buyPriceVersion === 'string'
      && ['torecolo', 'fullahead', 'yuyu'].includes(p.buyPriceSource) && Number.isFinite(Date.parse(p.buyPriceTimestamp))
      && labels.filter((l) => l === p.name).length === 1
      && classifyVariant(p.name).token === (p.buyPriceVersion === 'BASE' ? '' : p.buyPriceVersion));
    if (!v) continue;
    X = r;
    XV = v;
    break;
  }
  assert.ok(X && XV, 'committed data must contain a single-row proven printing with an exact-version buy tuple');

  // Y (review N1, the 42 PR283 card-level-only shape) — a HERMETIC control built from an
  // existing identity, not from an accidental committed shape: any single-row, own-set,
  // known base-rarity printing (its card representative takes the bare listing) whose
  // listings never carry its own rarity code (which would make bare ambiguous). Every buy
  // field of Y is then removed from the working "previous" artifact (card scalar, card holder,
  // every variant tuple / holder, history), so NO tuple or holder can carry anything: the only
  // evidence anywhere is the pre-scrape cache handed to the real builder, and every cache the
  // children read is a temp dir (the committed cache is never consulted).
  const Y = Object.values(cards).find((c) => c && c.id !== X.id && c.cardNumber && c.cardNumber !== X.cardNumber && c.rarity
    && isKnownRarityCode(normalizeRarityCode(c.rarity)) && !isPremiumRarityCode(normalizeRarityCode(c.rarity))
    && isOwnSetPrinting(c.cardNumber, c.series)
    && !(c.prices || []).some((p) => p && classifyVariant(p.name).token === normalizeRarityCode(c.rarity))
    && (rowsByNumber.get(c.cardNumber) || []).length === 1);
  assert.ok(Y, 'committed data must contain a single-row own-set base-rarity identity to build the Y control from');
  {
    const working = JSON.parse(originalDb);
    const wy = working.cards[Y.id];
    for (const f of ['buyPrice', 'buyPriceRetained', 'buyLastKnown', 'buyPriorSource', 'buyPriceHistory']) delete wy[f];
    for (const p of wy.prices || []) {
      if (!p || typeof p !== 'object') continue;
      for (const f of ['buyPrice', 'buyPriceVersion', 'buyPriceSource', 'buyPriceTimestamp', 'buyPriceRetained', 'buyLastKnown']) delete p[f];
    }
    fs.writeFileSync(dbPath, `${JSON.stringify(working, null, 2)}\n`); // restored byte-for-byte in finally
  }
  const TY = iso(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const priorCache = sourceDir({ 'fullahead-prices.json': { [Y.cardNumber]: { buyPrice: 77, rarity: null, timestamp: TY } } }, 'prior-cache');
  const yHolder = { price: 77, version: 'BASE', source: 'fullahead', timestamp: TY, sourceKey: Y.cardNumber };
  const label = XV.name;
  const token = XV.buyPriceVersion === 'BASE' ? '' : XV.buyPriceVersion;
  const sourceKey = token === '' ? X.cardNumber : `${X.cardNumber}-${token}`;
  const xVariant = (cs) => (cs[X.id]?.prices || []).find((p) => p?.name === label);

  // Healthy sell fixture (same shape as the builder e2e) with X rotated out of the source.
  const NOW1 = iso(Date.now());
  const fixture = { prices: {}, totalCards: 0, seriesWithPrices: 1, pricingUnavailable: false };
  const listing = (row, price, timestamp) => {
    const prod = String(row.sourceProduct || row.series || '').toLowerCase();
    return {
      sellPrice: price, rarity: row.rarity || '', name: row.name || row.cardNumber,
      yuyuImage: `https://card.yuyu-tei.jp/hocg/100_140/${prod}/lastknownbuy.jpg`,
      imageVersion: prod, imageCid: 'lastknownbuy', sourceSeries: prod, timestamp,
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
  delete fixture.prices[X.cardNumber];
  fixture.totalCards = Object.keys(fixture.prices).length * 2;
  const xSellHistBefore = readHistory(X.id);

  // ── build 1 (the on-disk cache is the previous run's, still holding Y's quote) ──
  runBuild(fixture, 'build1', priorCache);
  const b1 = readCards();
  assert.deepEqual(b1[Y.id]?.buyPriorSource, [{ sourceKey: Y.cardNumber, token: '', price: 77, source: 'fullahead', timestamp: TY }],
    'Y: the builder captured the pre-scrape source cache as internal raw evidence');
  assert.equal(b1[Y.id]?.buyPrice, undefined, 'Y: captured evidence is never a claim');
  assert.ok((b1[Y.id]?.prices || []).every((p) => !p || (!('buyLastKnown' in p) && p.buyPrice == null)),
    'Y: no variant tuple / holder exists — the capture is the only carrier');
  assert.equal(b1[Y.id]?.buyLastKnown, undefined, 'Y: no card holder before the merge');
  const claims = Object.values(b1).reduce((n, c) => n + (c.prices || []).filter((p) => p && p.buyPrice != null).length, 0);
  assert.equal(claims, 0, 'a rebuilt artifact ships no current buy claim');
  assert.ok(Object.values(b1).every((c) => c.buyPrice === undefined), 'card-level buyPrice is never restored by the rebuild');
  assert.deepEqual(xVariant(b1)?.buyLastKnown, {
    price: XV.buyPrice, version: XV.buyPriceVersion, source: XV.buyPriceSource, timestamp: XV.buyPriceTimestamp,
  }, 'X: exact variant holds its previous evidence (value + version + source + time together)');
  assert.equal(b1[X.id].sellQuoteRetained, true, 'X: dropped from the sell scrape → explicit retained sell status');
  const histB1 = allBuyHistories(b1);
  console.log(`  ✓ build 1: no buy claim shipped; ${X.id} :: ${label} holds ¥${XV.buyPrice} ${XV.buyPriceVersion} ${XV.buyPriceSource} @ ${XV.buyPriceTimestamp}`);

  // ── merge 1: fresh quote for X's variant, observed this run ──
  const R1 = Date.now() - 60 * 1000;
  const T1 = iso(Date.now() - 30 * 1000);
  const PX = XV.buyPrice + 7;
  // The fresh scrape is PARTIAL: it rewrote the cache without Y's key.
  const { dir: partialCache } = runMerge({ 'torecolo-prices.json': { [sourceKey]: { buyPrice: PX, rarity: token || null, timestamp: T1 } } }, R1, 'merge1');
  const m1 = readCards();
  assert.equal(m1[Y.id].buyPrice, 77, 'Y: card-level quote restored from prior source evidence (no variant tuple existed)');
  assert.equal(m1[Y.id].buyPriceRetained, true, 'Y: explicitly retained, never fresh');
  assert.deepEqual(m1[Y.id].buyLastKnown, yHolder, 'Y: exact source key / version / shop / own observation time');
  assert.equal(m1[Y.id].buyPriorSource, undefined, 'Y: raw capture consumed');
  runRegenGate(partialCache, 'merge1'); // (iii) real build → fresh partial file → merge: fixed point of the CI gate
  assert.deepEqual(tupleOf(xVariant(m1)), { buyPrice: PX, buyPriceVersion: XV.buyPriceVersion, buyPriceSource: 'torecolo', buyPriceTimestamp: T1, buyPriceRetained: undefined },
    'X: the fresh quote wins with its own source and time, no retained flag');
  let retainedVariants = 0;
  for (const c of Object.values(m1)) {
    for (const p of c.prices || []) {
      if (!p || p.buyPrice == null || (c.id === X.id && p.name === label)) continue;
      assert.equal(p.buyPriceRetained, true, `${c.id} :: ${p.name}: not quoted this run → retained`);
      retainedVariants += 1;
    }
  }
  assert.equal(holders(m1), 0, 'no holder ships after the merge');
  for (const [id, c] of Object.entries(m1)) {
    if (id === X.id) continue;
    assert.equal(JSON.stringify(c.buyPriceHistory ?? null), JSON.stringify(JSON.parse(histB1)[id]), `${id}: a retained quote writes no history`);
  }
  console.log(`  ✓ merge 1: X fresh ¥${PX} @ ${T1}; ${retainedVariants} other variant quotes retained with their own source/time; no other history touched`);

  // ── build 2 → merge 2: missing source files ──
  runBuild(fixture, 'build2', partialCache); // the cache on disk no longer has Y's key
  const b2 = readCards();
  assert.deepEqual(xVariant(b2)?.buyLastKnown, { price: PX, version: XV.buyPriceVersion, source: 'torecolo', timestamp: T1 });
  assert.deepEqual(b2[Y.id]?.buyLastKnown, yHolder, 'Y: the card holder survives the full rebuild after the partial overwrite');
  assert.equal(b2[Y.id]?.buyPrice, undefined, 'Y: card scalar still never restored by the rebuild');
  const histB2 = allBuyHistories(b2);
  const R2 = Date.now() - 1000;
  const { dir: missingCache } = runMerge({}, R2, 'merge2-missing');
  const m2CardsBytes = JSON.stringify(readCards());
  const m2 = readCards();
  runRegenGate(missingCache, 'merge2-missing');
  assert.deepEqual(tupleOf(xVariant(m2)), { buyPrice: PX, buyPriceVersion: XV.buyPriceVersion, buyPriceSource: 'torecolo', buyPriceTimestamp: T1, buyPriceRetained: true },
    'X: same exact tuple, original source/time, explicitly retained (although only seconds old)');
  assert.equal(allBuyHistories(m2), histB2, 'missing sources write NO buy history record anywhere');
  assert.equal(m2[Y.id].buyPrice, 77);
  assert.deepEqual(m2[Y.id].buyLastKnown, yHolder, 'Y: second consecutive miss still retains the original evidence');
  assert.equal(holders(m2), 0);
  for (const c of Object.values(m2)) {
    for (const p of c.prices || []) if (p && p.buyPrice != null) assert.equal(p.buyPriceRetained, true, `${c.id} :: ${p.name}`);
    if (c.buyPrice != null) assert.equal(c.buyPriceRetained, true, `${c.id}: card-level buy price is retained, never presented as new`);
  }
  console.log('  ✓ build 2 + merge 2 (missing files): every shown buy quote is explicitly retained; no history change');

  // ── merge 3: corrupt source file (repeated missing) ──
  const { dir: corruptCache } = runMerge({ 'torecolo-prices.json': '{corrupt' }, Date.now() - 1000, 'merge3-corrupt');
  // Every merge records its OWN run proof (run start / clock / source digest), so only the buy
  // state is compared: a corrupt source is another missing run → byte-identical cards.
  assert.equal(JSON.stringify(readCards()), m2CardsBytes, 'a corrupt source is another missing run: byte-identical buy state');
  runRegenGate(corruptCache, 'merge3-corrupt');
  console.log('  ✓ merge 3 (corrupt file): buy state byte-identical to merge 2; artifact is a fixed point of the CI regen gate');

  // ── merge 4: a NEW observation of the same value ──
  const R4 = Date.now() - 1000;
  const T4 = iso(Date.now());
  const { dir: newCache } = runMerge({ 'torecolo-prices.json': { [sourceKey]: { buyPrice: PX, rarity: token || null, timestamp: T4 } } }, R4, 'merge4-new');
  const m4 = readCards();
  runRegenGate(newCache, 'merge4-new');
  assert.deepEqual(tupleOf(xVariant(m4)), { buyPrice: PX, buyPriceVersion: XV.buyPriceVersion, buyPriceSource: 'torecolo', buyPriceTimestamp: T4, buyPriceRetained: undefined },
    'X: a proven new observation is new again, with its own time; retained cleared');
  const before = m2[X.id].buyPriceHistory || {};
  const after = m4[X.id].buyPriceHistory || {};
  for (const [d, val] of Object.entries(before)) assert.equal(after[d], val, `X: earlier history ${d} unchanged`);
  const added = Object.keys(after).filter((d) => !Object.hasOwn(before, d));
  assert.ok(added.every((d) => d === localDay(Date.parse(T4))), `X: only the new observation's own date may be added (${added})`);
  assert.deepEqual(readHistory(X.id), xSellHistBefore, 'X: durable SELL history untouched by the buy pipeline');

  // ── public projection of the final artifact ──
  const pubText = JSON.stringify(sanitizeDatabase(JSON.parse(fs.readFileSync(dbPath, 'utf8'))));
  assert.ok(!/"buyPrice|"buyLastKnown|"buyPriorSource/.test(pubText), 'Store MVP / native projection carries no buy field or holder at any depth');
  const fullText = JSON.stringify(stripInternalAuditDatabase(JSON.parse(fs.readFileSync(dbPath, 'utf8'))));
  assert.ok(!/"buyLastKnown|"buyPriorSource/.test(fullText), 'full web projection carries no internal holder');
  console.log(`  ✓ merge 4 (new observation): fresh @ ${T4}; earlier history unchanged; public projection has no buy field`);

  console.log('✓ last-known buy pipeline e2e passed');
  passed = true;
} finally {
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
