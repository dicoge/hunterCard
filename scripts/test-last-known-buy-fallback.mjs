#!/usr/bin/env node
/**
 * Review N4 (2026-11-07): the DIC-1334 official-only fallback (local-scrape-and-push.sh
 * `officialCatalogFallback`) runs NO buy scrape. The data/buy-prices/*.json it finds were
 * observed by an EARLIER run, so after its sync step every shown buy quote must be RETAINED
 * (buyPriceRetained, original source / time) and buy history must not change — even when the
 * cache is only hours old (inside the 18h window).
 *
 *   1. wiring: the fallback's buy step, read from the real shell function, is merge-buy-prices.js
 *      (never regen-buy-alignment.mjs), after the sync; HUNTERCARD_RUN_STARTED_AT is exported
 *      before the fallback can run (run-start provenance).
 *   2. real path: hermetic sandbox → the real sync CLI → the exact buy command extracted in (1),
 *      with the run start the shell would export → every buy quote retained with its own
 *      source/time, buyPriceHistory byte-identical for every card, no holder left in variants,
 *      reprint row unpriced.
 *   3. negative control: the same sandbox with the OLD wiring (regen-buy-alignment.mjs) must
 *      FAIL the same predicate (it presents the cache as fresh and writes history).
 *   4. positive control (genuine fresh meaning preserved): a cache observed AFTER the run start
 *      is fresh through the same merge — no retained flag, history at its observation date.
 *
 * Fixtures only (no network, no real data/): card numbers / ids follow the DIC-1511 fixture.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { printingId } from './lib/printing-identity.js';
import { historyDateKey } from './merge-buy-prices.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHELL = fs.readFileSync(path.join(__dirname, 'local-scrape-and-push.sh'), 'utf8');
let passed = 0;
const check = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

// ── 1. wiring + run-start provenance, from the real shell text ─────────────
const fnStart = SHELL.indexOf('officialCatalogFallback() {');
assert.ok(fnStart >= 0, 'officialCatalogFallback must exist');
const fnEnd = SHELL.indexOf('\n}\n', fnStart);
const body = SHELL.slice(fnStart, fnEnd);
const steps = [...body.matchAll(/^\s*if ! (node scripts\/[^\s>]+)/gm)].map((m) => m[1]);
assert.deepEqual(steps.slice(0, 2), ['node scripts/sync-official-catalog-to-database.mjs', 'node scripts/merge-buy-prices.js'],
  `fallback must run sync then the run-proof buy merge; got ${steps.join(' → ')}`);
assert.ok(!steps.some((s) => s.includes('regen-buy-alignment')), 'fallback must not run regen-buy-alignment.mjs');
const BUY_STEP = steps[1].replace(/^node /, '');
const exportAt = SHELL.indexOf('export HUNTERCARD_RUN_STARTED_AT');
const callAt = SHELL.search(/^\s*(if !\s*)?officialCatalogFallback\s+"/m);
assert.ok(exportAt >= 0 && callAt > exportAt, 'HUNTERCARD_RUN_STARTED_AT is exported before officialCatalogFallback can be called');
check(`wiring: fallback = ${steps.slice(0, 2).join(' → ')}; run start exported before the fallback`);

// ── fixture sandbox ────────────────────────────────────────────────────────
const official = (cardNumber, sourceProduct, rarity, suffix, name) => ({
  cardNumber, name, cardType: 'ホロメン', color: 'white', rarity, expansion: sourceProduct, sourceProduct,
  sourceProductName: sourceProduct,
  imageUrl: `https://hololive-official-cardgame.com/wp-content/images/cardlist/${sourceProduct}/${suffix}.png`,
});
const HR = official('hBP01-024', 'hBP07', 'HR', 'hBP01-024_HR', 'ベスティア・ゼータ');
const C = official('hBP01-024', 'hBP07', 'C', 'hBP01-024_02_C', 'ベスティア・ゼータ');
const U = official('hBP09-105', 'hBP09', 'U', 'hBP09-105_U', 'かなたそ');
const [HR_ID, C_ID, U_ID] = [printingId(HR), printingId(C), printingId(U)];
// Review N6: the merge runs in Asia/Taipei. The retained cache observation is fixed in the
// 16:00–23:59Z window (2026-11-06T17:30Z = Taipei 2026-11-07), and history already holds that
// real observation under its TAIPEI date — later than the UTC snapshot date regen would use.
const CHILD_TZ = 'Asia/Taipei';
const RETAINED_OBS = '2026-11-06T17:30:00.000Z';
const TAIPEI_DAY = '2026-11-07';
const HISTORY = {
  [HR_ID]: { '2026-09-27': 1600, '2026-10-03': 1600, [TAIPEI_DAY]: 1600 },
  [U_ID]: { '2026-09-27': 5 },
};

function makeSandbox(cacheTs) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'n4-fallback-'));
  fs.cpSync(path.join(REPO_ROOT, 'scripts'), path.join(sandbox, 'scripts'), { recursive: true });
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(sandbox, 'node_modules'));
  fs.symlinkSync(path.join(REPO_ROOT, 'package.json'), path.join(sandbox, 'package.json'));
  const data = path.join(sandbox, 'data');
  const json = (rel, v) => {
    fs.mkdirSync(path.dirname(path.join(data, rel)), { recursive: true });
    fs.writeFileSync(path.join(data, rel), `${JSON.stringify(v, null, 2)}\n`);
  };
  fs.mkdirSync(path.join(data, 'images'), { recursive: true });
  json('character-names-zh.json', { 'ベスティア・ゼータ': '貝絲緹亞·澤塔', 'かなたそ': '天音彼方' });
  json('effects-jp.json', {});
  json('effects-zh.json', {});
  json('official/_meta.json', { seriesStats: [{ code: 'hBP07', expectedCount: 2, ingestedCount: 2 }, { code: 'hBP09', expectedCount: 1, ingestedCount: 1 }] });
  json('official/hBP07.json', [HR, C]);
  json('official/hBP09.json', [U]);
  const row = (card, extra) => ({
    id: printingId(card), cardNumber: card.cardNumber, name: card.name, rarity: card.rarity, series: card.sourceProduct,
    sourceProduct: card.sourceProduct, sellPrice: null, prices: [], officialImage: card.imageUrl, localImage: '', nameZh: 'x', ...extra,
  });
  json('database.json', {
    lastUpdated: '2026-10-03T12:08:30.745Z', totalCards: 3,
    cards: {
      [HR_ID]: row(HR, { buyPrice: 1600, buyPriceHistory: HISTORY[HR_ID] }),
      [C_ID]: row(C, {}),
      [U_ID]: row(U, { buyPrice: 5, buyPriceHistory: HISTORY[U_ID] }),
    },
  });
  // The previous run's buy cache (no scrape in this path). Observed `cacheTs` — hours ago,
  // INSIDE the 18h window, so only run-start provenance can tell it is not this run's.
  json('buy-prices/fullahead-prices.json', {
    'hBP01-024-HR': { buyPrice: 1600, rarity: 'HR', timestamp: cacheTs },
    'hBP09-105': { buyPrice: 5, rarity: null, timestamp: cacheTs },
  });
  json('buy-prices/torecolo-prices.json', {});
  json('buy-prices/yuyu-prices.json', {});
  return sandbox;
}

function run(sandbox, script, env) {
  const res = spawnSync(process.execPath, [script], {
    cwd: sandbox, encoding: 'utf8', timeout: 120000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TZ: CHILD_TZ, ...env },
  });
  assert.equal(res.status, 0, `${script} failed:\n${(res.stderr || res.stdout || '').slice(-1500)}`);
  return res;
}
const readCards = (sandbox) => JSON.parse(fs.readFileSync(path.join(sandbox, 'data/database.json'), 'utf8')).cards;

/** The N4 predicate: violations of "nothing observed this run → retained, history untouched". */
function retainedOnlyViolations(cards, cacheTs) {
  const v = [];
  for (const [id, c] of Object.entries(cards)) {
    const want = HISTORY[id] ?? null;
    const got = c.buyPriceHistory ?? null;
    for (const d of Object.keys(want || {})) {
      if (!got || !Object.hasOwn(got, d)) v.push(`${id}: real history record ${d} REMOVED`);
      else if (got[d] !== want[d]) v.push(`${id}: real history record ${d} REWRITTEN ${want[d]}→${got[d]}`);
    }
    for (const d of Object.keys(got || {})) {
      if (!want || !Object.hasOwn(want, d)) v.push(`${id}: history record ${d} ADDED without an observation this run`);
    }
    if (JSON.stringify(got) !== JSON.stringify(want)) v.push(`${id}: buyPriceHistory changed ${JSON.stringify(got)}`);
    if (c.buyPrice != null) {
      if (c.buyPriceRetained !== true) v.push(`${id}: card buy ${c.buyPrice} shown as NEW`);
      else if (c.buyLastKnown?.timestamp !== cacheTs || c.buyLastKnown?.source !== 'fullahead') v.push(`${id}: retained without its original source/time`);
    }
    for (const p of c.prices || []) {
      if (p && p.buyPrice != null && p.buyPriceRetained !== true) v.push(`${id} :: ${p.name}: variant buy shown as NEW`);
      if (p && 'buyLastKnown' in p) v.push(`${id} :: ${p.name}: holder left in variant`);
    }
    if ('buyPriorSource' in c) v.push(`${id}: raw capture left behind`);
    if (c.sellQuoteRetained === false) v.push(`${id}: sell status claims a new quote in a no-scrape path`);
  }
  return v;
}

/**
 * An instant with UTC hour 16–23 (its Asia/Taipei date is the next day), at most ~16.5 h before
 * now (inside the 18 h fresh window) and at least 2 min in the past — for ANY wall clock.
 */
function crossingFreshInstant(nowMs = Date.now()) {
  const t = new Date(nowMs - 2 * 60e3);
  if (t.getUTCHours() >= 16) return t.getTime();
  return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() - 1, 23, 30, 0);
}

const sandboxes = [];
try {
  const runStartSec = Math.floor(Date.now() / 1000) - 60;
  const CACHE_TS = new Date((runStartSec - 3 * 3600) * 1000).toISOString(); // 3h before run start

  // ── 2. real path: sync CLI → the exact extracted buy step ──
  {
    const sb = makeSandbox(CACHE_TS);
    sandboxes.push(sb);
    run(sb, 'scripts/sync-official-catalog-to-database.mjs', {});
    const synced = readCards(sb);
    assert.ok(Array.isArray(synced[HR_ID].buyPriorSource) && synced[U_ID].buyPriorSource, 'sync captured the on-disk cache as prior evidence');
    run(sb, BUY_STEP, { HUNTERCARD_RUN_STARTED_AT: String(runStartSec) });
    const cards = readCards(sb);
    assert.deepEqual(retainedOnlyViolations(cards, CACHE_TS), []);
    assert.equal(cards[HR_ID].buyPrice, 1600);
    assert.deepEqual(cards[HR_ID].buyLastKnown, { price: 1600, version: 'HR', source: 'fullahead', timestamp: CACHE_TS, sourceKey: 'hBP01-024-HR' });
    assert.equal(cards[U_ID].buyPrice, 5);
    assert.equal(cards[U_ID].buyPriceRetained, true);
    assert.equal(cards[C_ID].buyPrice, undefined, 'reprint C row never takes the bare listing');
    check('real sync → fallback buy step: quotes 3h old (inside 18h) are RETAINED with original source/time; history byte-identical');
  }

  // ── 2b. N6: fixed UTC/Taipei-crossing observation, children pinned to Asia/Taipei ──
  {
    assert.equal(historyDateKey(Date.parse(RETAINED_OBS), CHILD_TZ), TAIPEI_DAY, 'fixture premise: 17:30Z is the next Taipei day');
    assert.equal(RETAINED_OBS.slice(0, 10) < TAIPEI_DAY, true, 'fixture premise: the UTC date is earlier than the Taipei date');
    const sb = makeSandbox(RETAINED_OBS);
    sandboxes.push(sb);
    run(sb, 'scripts/sync-official-catalog-to-database.mjs', {});
    run(sb, BUY_STEP, { HUNTERCARD_RUN_STARTED_AT: String(runStartSec) });
    const cards = readCards(sb);
    assert.deepEqual(retainedOnlyViolations(cards, RETAINED_OBS), []);
    assert.equal(cards[HR_ID].buyPriceHistory[TAIPEI_DAY], 1600, `the real Taipei-dated record ${TAIPEI_DAY} is kept byte-identical`);
    check(`TZ=${CHILD_TZ}: observation ${RETAINED_OBS} retained; its Taipei-dated record ${TAIPEI_DAY} untouched (no prune, no snapshot-date record)`);
  }

  // ── 3. negative control: the OLD wiring fails the same predicate — adds AND removes ──
  {
    const sb = makeSandbox(RETAINED_OBS);
    sandboxes.push(sb);
    run(sb, 'scripts/sync-official-catalog-to-database.mjs', {});
    run(sb, 'scripts/regen-buy-alignment.mjs', { HUNTERCARD_RUN_STARTED_AT: String(runStartSec) });
    const violations = retainedOnlyViolations(readCards(sb), RETAINED_OBS);
    assert.ok(violations.some((x) => /shown as NEW/.test(x)), `old regen wiring must be caught presenting the cache as new: ${violations.join('; ')}`);
    assert.ok(violations.some((x) => /ADDED without an observation/.test(x)), `old regen wiring must be caught adding a snapshot-date record: ${violations.join('; ')}`);
    assert.ok(violations.some((x) => x.includes(`${HR_ID}: real history record ${TAIPEI_DAY} REMOVED`)),
      `old regen wiring must be caught DELETING the later Taipei-dated real record: ${violations.join('; ')}`);
    check(`negative control: regen-buy-alignment.mjs in the fallback is caught presenting the cache as new, adding ${RETAINED_OBS.slice(0, 10)} and removing ${TAIPEI_DAY} (${violations.length} violations)`);
  }

  // ── 4. positive control: a quote genuinely observed THIS run is still fresh, at its Taipei date ──
  // N6-fresh: the observation is pinned in the UTC 16:00–23:59 window inside the 18 h fresh
  // window at ANY wall clock; the expected key is an independent UTC+8 oracle (Asia/Taipei has
  // no DST), asserted to differ from the UTC date — the production helper is not the oracle.
  {
    const tFresh = crossingFreshInstant();
    const freshTs = new Date(tFresh).toISOString();
    const utcDay = freshTs.slice(0, 10);
    const taipeiDay = new Date(tFresh + 8 * 3600e3).toISOString().slice(0, 10);
    assert.ok(new Date(tFresh).getUTCHours() >= 16 && Date.now() - tFresh <= 17 * 3600e3 && tFresh < Date.now(), 'fixture premise: UTC 16–23h, inside 18h, in the past');
    assert.notEqual(taipeiDay, utcDay, 'fixture premise: Taipei date ≠ UTC date');
    const freshRunStartSec = Math.floor((tFresh - 60e3) / 1000); // run started just before the observation
    const sb = makeSandbox(freshTs);
    sandboxes.push(sb);
    run(sb, 'scripts/sync-official-catalog-to-database.mjs', {});
    run(sb, BUY_STEP, { HUNTERCARD_RUN_STARTED_AT: String(freshRunStartSec) });
    const cards = readCards(sb);
    assert.equal(cards[HR_ID].buyPrice, 1600);
    assert.equal(cards[HR_ID].buyPriceRetained, undefined, 'observed after the run start → fresh, no retained flag');
    assert.equal(cards[HR_ID].buyLastKnown, undefined);
    const added = Object.keys(cards[HR_ID].buyPriceHistory).filter((d) => !Object.hasOwn(HISTORY[HR_ID], d));
    if (Object.hasOwn(HISTORY[HR_ID], taipeiDay)) {
      assert.deepEqual(added, [], 'the Taipei observation date already holds a real record → nothing added, nothing rewritten');
    } else {
      assert.deepEqual(added, [taipeiDay], `exactly one record, at the observation's Taipei date ${taipeiDay} (oracle), not the UTC date ${utcDay}`);
      assert.equal(cards[HR_ID].buyPriceHistory[taipeiDay], 1600);
    }
    assert.ok(!Object.hasOwn(cards[HR_ID].buyPriceHistory, utcDay) || Object.hasOwn(HISTORY[HR_ID], utcDay), `no record at the UTC date ${utcDay}`);
    for (const [d, val] of Object.entries(HISTORY[HR_ID])) assert.equal(cards[HR_ID].buyPriceHistory[d], val, `earlier record ${d} untouched`);
    check(`positive control: a quote observed after the run start stays FRESH; record at Taipei ${taipeiDay}, not UTC ${utcDay} (fresh meaning preserved)`);
  }
} finally {
  for (const sb of sandboxes) fs.rmSync(sb, { recursive: true, force: true });
}
console.log(`last-known buy fallback (N4): ${passed} checks passed`);
