#!/usr/bin/env node
/**
 * Review N5 (2026-11-07): artifacts committed by the merge must be FIXED POINTS of the CI
 * byte-identity gate (`scripts/test-buy-price-regen-deterministic.mjs`, run on every PR) — the
 * no-scrape paths commit RETAINED quotes whose cache entries are recent, and the old gate logic
 * (snapshot regen) would turn them back into "fresh".
 *
 * Hermetic sandbox (DIC-1511 fixture shape; no real data, no network). Merges run with
 * TZ=Asia/Taipei; the gate runs with TZ=UTC (zone independence of the recorded run proof).
 *
 *   (i)   sync → merge, NO run marker   (scheduled official-catalog-sync.yml)  → gate passes
 *   (ii)  sync → merge, run start       (DIC-1334 fallback; cache 3h old, <18h) → gate passes
 *   (iii) rebuild (captures the on-disk cache) → a FRESH partial, LOWER source file is written
 *         → merge with run start (normal daily order)                          → gate passes;
 *         lower fresh quote wins with its own time + Taipei-dated record, the omitted card is
 *         retained with its original source/time
 *   negative controls (each must FAIL):
 *     - the previous gate logic (snapshot regen) on (i) and (ii): bytes differ, retained flipped;
 *     - a genuinely NEWER and LOWER source quote written after (ii)'s merge: gate exits non-zero
 *       (the proof is bound to the source bytes and cannot mask a new source);
 *     - a tampered artifact (retained status removed) and a tampered proof (earlier run start):
 *       gate exits non-zero.
 *
 * The real-builder path (build-database.js → merge) runs the same gate in
 * scripts/test-last-known-buy-pipeline-e2e.mjs.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { printingId } from './lib/printing-identity.js';
import { snapshotInfo, regenerateBuyAlignment } from './regen-buy-alignment.mjs';
import {
  mergeBuyPricesInto, auditRetainedQuotes, notFreshBoundEvidence, buildBuyIndex,
} from './merge-buy-prices.js';

/**
 * N10: call the PRODUCTION audit (or a mutant module's) exactly as regen does for this artifact's
 * run proof, so each control can assert the precise rule that rejects it.
 */
function productionAudit(a, dir, mod = { auditRetainedQuotes, notFreshBoundEvidence, buildBuyIndex }) {
  const p = a.buyQuoteRun;
  const now = Date.parse(p.now);
  const rs = p.runStartedAt == null ? null : Date.parse(p.runStartedAt);
  const { log } = console;
  console.log = () => {};
  try {
    const freshByNum = rs == null ? new Map() : mod.buildBuyIndex(now, { dir, notBefore: rs });
    return mod.auditRetainedQuotes(a, mod.notFreshBoundEvidence(dir, now, rs), { now, runStartedAt: rs, freshByNum });
  } finally {
    console.log = log;
  }
}
const vkey = (id, slot) => `${id}\u0000${slot}`;

/** The real merge (same function as the CLI), with its log noise suppressed. */
function mergeQuiet(db, opts) {
  const { warn, log } = console;
  console.warn = () => {};
  console.log = () => {};
  try {
    return mergeBuyPricesInto(db, opts);
  } finally {
    console.warn = warn;
    console.log = log;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const MERGE_TZ = 'Asia/Taipei';
const GATE_TZ = 'UTC';
let passed = 0;
const check = (name) => { passed += 1; console.log(`  ✓ ${name}`); };

const official = (cardNumber, sourceProduct, rarity, suffix, name) => ({
  cardNumber, name, cardType: 'ホロメン', color: 'white', rarity, expansion: sourceProduct, sourceProduct,
  sourceProductName: sourceProduct,
  imageUrl: `https://hololive-official-cardgame.com/wp-content/images/cardlist/${sourceProduct}/${suffix}.png`,
});
const HR = official('hBP01-024', 'hBP07', 'HR', 'hBP01-024_HR', 'ベスティア・ゼータ');
const C = official('hBP01-024', 'hBP07', 'C', 'hBP01-024_02_C', 'ベスティア・ゼータ');
const U = official('hBP09-105', 'hBP09', 'U', 'hBP09-105_U', 'かなたそ');
const [HR_ID, C_ID, U_ID] = [printingId(HR), printingId(C), printingId(U)];

function makeSandbox(cache) {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'n5-fixed-point-'));
  fs.cpSync(path.join(REPO_ROOT, 'scripts'), path.join(sb, 'scripts'), { recursive: true });
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(sb, 'node_modules'));
  fs.symlinkSync(path.join(REPO_ROOT, 'package.json'), path.join(sb, 'package.json'));
  const json = (rel, v) => {
    const f = path.join(sb, 'data', rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`);
  };
  fs.mkdirSync(path.join(sb, 'data/images'), { recursive: true });
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
      [HR_ID]: row(HR, { buyPriceHistory: { '2026-09-27': 1600 } }),
      [C_ID]: row(C, {}),
      [U_ID]: row(U, { buyPriceHistory: { '2026-09-27': 5 } }),
    },
  });
  writeCache(sb, cache);
  return sb;
}
function writeCache(sb, entries) {
  const f = (rel, v) => fs.writeFileSync(path.join(sb, 'data/buy-prices', rel), `${JSON.stringify(v, null, 2)}\n`);
  fs.mkdirSync(path.join(sb, 'data/buy-prices'), { recursive: true });
  f('fullahead-prices.json', entries);
  f('torecolo-prices.json', {});
  f('yuyu-prices.json', {});
}
const cacheAt = (ts, { hr = 1600, u = 5 } = {}) => ({
  ...(hr != null ? { 'hBP01-024-HR': { buyPrice: hr, rarity: 'HR', timestamp: ts } } : {}),
  ...(u != null ? { 'hBP09-105': { buyPrice: u, rarity: null, timestamp: ts } } : {}),
});

function node(sb, script, env, tz = MERGE_TZ) {
  return spawnSync(process.execPath, [script], {
    cwd: sb, encoding: 'utf8', timeout: 120000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TZ: tz, ...env },
  });
}
function ok(sb, script, env) {
  const r = node(sb, script, env);
  assert.equal(r.status, 0, `${script} failed:\n${(r.stderr || r.stdout || '').slice(-1500)}`);
}
const GATE = 'scripts/test-buy-price-regen-deterministic.mjs';
const gate = (sb) => node(sb, GATE, {}, GATE_TZ);
const dbFile = (sb) => path.join(sb, 'data/database.json');
const readDb = (sb) => JSON.parse(fs.readFileSync(dbFile(sb), 'utf8'));

/** The previous (pre-N5) gate logic: snapshot regen of the committed bytes. */
function previousGateDiffers(sb) {
  const bytes = fs.readFileSync(dbFile(sb), 'utf8');
  const db = JSON.parse(bytes);
  const { ts, date } = snapshotInfo(path.join(sb, 'data/buy-prices'), undefined);
  regenerateBuyAlignment(db, { now: (ts || Date.now()) + 1000, date, buyDir: path.join(sb, 'data/buy-prices') });
  return { differs: `${JSON.stringify(db, null, 2)}\n` !== bytes, after: db };
}

/**
 * An instant with UTC hour 16–23 (so its Asia/Taipei date is the next day), at most ~16.5 h
 * before `nowMs` (inside the 18 h fresh window) and at least 2 min in the past — for ANY wall
 * clock: now-2min if that is already 16–23Z, else the previous UTC day's 23:30Z.
 */
function crossingFreshInstant(nowMs = Date.now()) {
  const t = new Date(nowMs - 2 * 60e3);
  if (t.getUTCHours() >= 16) return t.getTime();
  return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() - 1, 23, 30, 0);
}

const sandboxes = [];
try {
  const runStartSec = Math.floor(Date.now() / 1000) - 120;
  const OBS = new Date((runStartSec - 3 * 3600) * 1000).toISOString(); // previous run, 3h ago (<18h)

  // (i) scheduled official sync: sync → merge, no run marker
  const sbI = makeSandbox(cacheAt(OBS));
  sandboxes.push(sbI);
  ok(sbI, 'scripts/sync-official-catalog-to-database.mjs', {});
  ok(sbI, 'scripts/merge-buy-prices.js', {});
  {
    const db = readDb(sbI);
    assert.equal(db.cards[HR_ID].buyPriceRetained, true);
    assert.equal(db.buyQuoteRun.runStartedAt, null, 'no marker recorded honestly');
    const g = gate(sbI);
    assert.equal(g.status, 0, `gate must pass on the scheduled-sync artifact:\n${(g.stderr || g.stdout).slice(-1500)}`);
    assert.match(g.stdout, /mode=run-proof/);
    const prev = previousGateDiffers(sbI);
    assert.ok(prev.differs && prev.after.cards[HR_ID].buyPriceRetained !== true, 'negative control: the previous gate logic flips the retained quote to fresh');
    check('(i) sync → merge (no marker): retained artifact is a fixed point of the gate; previous gate logic fails it');
  }

  // (ii) DIC-1334 fallback: sync → merge with the exported run start
  const sbII = makeSandbox(cacheAt(OBS));
  sandboxes.push(sbII);
  ok(sbII, 'scripts/sync-official-catalog-to-database.mjs', {});
  ok(sbII, 'scripts/merge-buy-prices.js', { HUNTERCARD_RUN_STARTED_AT: String(runStartSec) });
  const retainedSnapshot = readDb(sbII);
  {
    assert.equal(retainedSnapshot.cards[HR_ID].buyPriceRetained, true);
    assert.equal(retainedSnapshot.cards[HR_ID].buyLastKnown.timestamp, OBS);
    const g = gate(sbII);
    assert.equal(g.status, 0, `gate must pass on the fallback artifact:\n${(g.stderr || g.stdout).slice(-1500)}`);
    assert.ok(previousGateDiffers(sbII).differs, 'negative control: previous gate logic fails the fallback artifact');
    check('(ii) sync → merge (run start; cache 3h old): fixed point; previous gate logic fails it');
  }

  // Negative: a genuinely NEWER and LOWER source quote after (ii)'s merge must not be masked.
  {
    const sb = makeSandbox(cacheAt(OBS));
    sandboxes.push(sb);
    fs.writeFileSync(dbFile(sb), `${JSON.stringify(retainedSnapshot, null, 2)}\n`);
    writeCache(sb, cacheAt(OBS));
    assert.equal(gate(sb).status, 0, 'premise: unchanged sources → fixed point');
    writeCache(sb, { ...cacheAt(OBS), 'hBP01-024-HR': { buyPrice: 1400, rarity: 'HR', timestamp: new Date().toISOString() } });
    const g = gate(sb);
    assert.notEqual(g.status, 0, 'a newer, lower source quote must make the gate fail (artifact is stale), never be masked by the proof');
    check('negative: a genuinely newer/lower source quote after the merge fails the gate');
  }

  // Negatives: tampered artifact / tampered proof.
  {
    const sb = makeSandbox(cacheAt(OBS));
    sandboxes.push(sb);
    const tampered = JSON.parse(JSON.stringify(retainedSnapshot));
    delete tampered.cards[HR_ID].buyPriceRetained; // a retained quote presented as new
    fs.writeFileSync(dbFile(sb), `${JSON.stringify(tampered, null, 2)}\n`);
    assert.notEqual(gate(sb).status, 0, 'a retained quote stripped of its status must fail the gate');
    const proofTampered = JSON.parse(JSON.stringify(retainedSnapshot));
    proofTampered.buyQuoteRun.runStartedAt = new Date(Date.parse(OBS) - 60000).toISOString(); // pretend the cache was this run's
    fs.writeFileSync(dbFile(sb), `${JSON.stringify(proofTampered, null, 2)}\n`);
    assert.notEqual(gate(sb).status, 0, 'a proof claiming an earlier run start must not certify retained quotes as consistent');
    check('negative: tampered retained status / tampered run proof fail the gate');
  }

  // (iii) normal daily order: rebuild captures the on-disk (previous) cache → a fresh PARTIAL,
  // LOWER file is written → merge with run start. N6-fresh: the fresh observation is pinned in
  // the UTC 16:00–23:59 window (its Taipei date is the NEXT day) at any test wall clock, and the
  // expected key comes from an independent UTC+8 oracle, not from the production helper.
  {
    const tFresh = crossingFreshInstant();
    const utcDay = new Date(tFresh).toISOString().slice(0, 10);
    const taipeiDay = new Date(tFresh + 8 * 3600e3).toISOString().slice(0, 10); // Asia/Taipei = UTC+8, no DST
    assert.ok(new Date(tFresh).getUTCHours() >= 16 && Date.now() - tFresh <= 17 * 3600e3 && tFresh < Date.now(), 'fixture premise: UTC 16–23h, inside 18h, in the past');
    assert.notEqual(taipeiDay, utcDay, 'fixture premise: the Taipei date differs from the UTC date');
    const OBS3 = new Date(tFresh - 3 * 3600e3).toISOString();
    const sb = makeSandbox(cacheAt(OBS3));
    sandboxes.push(sb);
    // previous run's artifact: its own merge with a run start after OBS3
    ok(sb, 'scripts/sync-official-catalog-to-database.mjs', {});
    ok(sb, 'scripts/merge-buy-prices.js', { HUNTERCARD_RUN_STARTED_AT: String(Math.floor((tFresh - 2 * 3600e3) / 1000)) });
    // this run: rebuild (carries holders, captures the on-disk cache) → scrape writes a partial,
    // lower file → merge with this run's start just before the fresh observation
    ok(sb, 'scripts/sync-official-catalog-to-database.mjs', {});
    const freshTs = new Date(tFresh).toISOString();
    writeCache(sb, cacheAt(freshTs, { hr: 1500, u: null })); // partial: U omitted; HR lower
    ok(sb, 'scripts/merge-buy-prices.js', { HUNTERCARD_RUN_STARTED_AT: String(Math.floor((tFresh - 60e3) / 1000)) });
    const db = readDb(sb);
    assert.equal(db.cards[HR_ID].buyPrice, 1500, 'lower fresh quote wins');
    assert.equal(db.cards[HR_ID].buyPriceRetained, undefined);
    assert.equal(db.cards[HR_ID].buyPriceHistory[taipeiDay], 1500, `fresh record at the observation's Taipei date ${taipeiDay} (oracle)`);
    assert.ok(!Object.hasOwn(db.cards[HR_ID].buyPriceHistory, utcDay), `no record at the UTC date ${utcDay}`);
    assert.equal(db.cards[HR_ID].buyPriceHistory['2026-09-27'], 1600, 'earlier real record untouched');
    assert.equal(db.cards[U_ID].buyPrice, 5);
    assert.equal(db.cards[U_ID].buyPriceRetained, true);
    assert.equal(db.cards[U_ID].buyLastKnown.timestamp, OBS3, 'omitted card retained with its original time');
    assert.deepEqual(db.cards[U_ID].buyPriceHistory, { '2026-09-27': 5 }, 'no record for the retained card');
    assert.equal(db.cards[C_ID].buyPrice, undefined, 'reprint stays unpriced');
    const g = gate(sb);
    assert.equal(g.status, 0, `gate must pass on the daily artifact:\n${(g.stderr || g.stdout).slice(-1500)}`);
    assert.match(g.stdout, /carried 1\)/, 'the omitted card is a carried (not source-covered) retained quote');
    check(`(iii) rebuild → fresh partial lower file → merge: fixed point; fresh record at Taipei ${taipeiDay}, not UTC ${utcDay} (gate in UTC, merge in Taipei)`);
  }

  // N7: retained quotes are bound to their evidence. Hermetic artifact from the real merge
  // (in-process, same function as the CLI) with a SOURCE-COVERED card holder + variant tuple
  // (HR, bound fullahead entry) and a CARRIED card holder (U, only in the earlier capture).
  {
    const runStartMs = Date.now() - 60e3;
    const OBSC = new Date(runStartMs - 3 * 3600e3).toISOString(); // bound source entry (previous run)
    const OLD = new Date(runStartMs - 30 * 3600e3).toISOString(); // earlier capture, not in the files
    const sb = makeSandbox(cacheAt(OBSC, { u: null }));
    sandboxes.push(sb);
    const art = {
      lastUpdated: '2026-11-07T00:00:00.000Z', totalCards: 3,
      cards: {
        // N9 fixtures: a plain (パラレル) variant beside the explicit パラレル/HR one (the merge
        // never gives it the claimed HR listing), and the reprint C row (never takes a listing).
        [HR_ID]: {
          id: HR_ID, cardNumber: 'hBP01-024', rarity: 'HR', series: 'hBP07', buyPriceHistory: { '2026-09-27': 1600 },
          prices: [{ name: 'ベスティア・ゼータ(パラレル/HR)', sellPrice: 9000 }, { name: 'ベスティア・ゼータ(パラレル)', sellPrice: 7000 }],
        },
        [C_ID]: { id: C_ID, cardNumber: 'hBP01-024', rarity: 'C', series: 'hBP07', prices: [] },
        [U_ID]: {
          id: U_ID, cardNumber: 'hBP09-105', rarity: 'U', series: 'hBP09', prices: [], buyPriceHistory: { '2026-09-27': 5 },
          buyPriorSource: [{ sourceKey: 'hBP09-105', token: '', price: 5, source: 'fullahead', timestamp: OLD }],
        },
      },
    };
    mergeQuiet(art, { now: Date.now(), runStartedAt: runStartMs, dir: path.join(sb, 'data/buy-prices') });
    assert.equal(art.cards[HR_ID].buyPriceRetained, true);
    assert.equal(art.cards[HR_ID].prices[0].buyPriceRetained, true);
    assert.deepEqual(art.cards[HR_ID].buyLastKnown, { price: 1600, version: 'HR', source: 'fullahead', timestamp: OBSC, sourceKey: 'hBP01-024-HR' });
    assert.deepEqual(art.cards[U_ID].buyLastKnown, { price: 5, version: 'BASE', source: 'fullahead', timestamp: OLD, sourceKey: 'hBP09-105' });
    assert.equal(art.cards[HR_ID].prices[1].buyPrice, undefined, 'premise: the plain parallel never takes the claimed HR listing');
    assert.equal(art.cards[C_ID].buyPrice, undefined, 'premise: the reprint C row takes nothing');
    const writeArt = (a) => fs.writeFileSync(dbFile(sb), `${JSON.stringify(a, null, 2)}\n`);
    writeArt(art);
    const pos = gate(sb);
    assert.equal(pos.status, 0, `valid covered + carried retained quotes are a fixed point:\n${(pos.stderr || pos.stdout).slice(-1500)}`);
    assert.match(pos.stdout, /source-covered 2, carried 1\)/, 'HR card + variant covered by bound evidence; U carried');
    check('N7 positive: source-covered (card + variant) and valid old carried (card) retained quotes pass the gate');

    const afterStart = new Date(runStartMs + 1000).toISOString();
    const mutants = {
      'card: retained price edited': (a) => { a.cards[HR_ID].buyPrice = 9999; a.cards[HR_ID].buyLastKnown.price = 9999; },
      'card: retained shop edited': (a) => { a.cards[HR_ID].buyLastKnown.source = 'torecolo'; },
      'card: retained time edited older': (a) => { a.cards[HR_ID].buyLastKnown.timestamp = new Date(Date.parse(OBSC) - 3600e3).toISOString(); },
      'card: retained time edited newer (still before run start)': (a) => { a.cards[HR_ID].buyLastKnown.timestamp = new Date(Date.parse(OBSC) + 1800e3).toISOString(); },
      'card: retained time at/after run start': (a) => { a.cards[HR_ID].buyLastKnown.timestamp = afterStart; },
      'card: source key edited': (a) => { a.cards[HR_ID].buyLastKnown.sourceKey = 'hBP01-024-SEC'; },
      'variant: retained price edited': (a) => { a.cards[HR_ID].prices[0].buyPrice = 9999; },
      'variant: retained shop edited': (a) => { a.cards[HR_ID].prices[0].buyPriceSource = 'yuyu'; },
      'variant: retained time edited older': (a) => { a.cards[HR_ID].prices[0].buyPriceTimestamp = new Date(Date.parse(OBSC) - 3600e3).toISOString(); },
      'variant: retained time edited newer (still before run start)': (a) => { a.cards[HR_ID].prices[0].buyPriceTimestamp = new Date(Date.parse(OBSC) + 1800e3).toISOString(); },
      'variant: retained time at/after run start': (a) => { a.cards[HR_ID].prices[0].buyPriceTimestamp = afterStart; },
      'carried card: price edited': (a) => { a.cards[U_ID].buyPrice = 7; a.cards[U_ID].buyLastKnown.price = 7; },
      'carried card: time at/after run start': (a) => { a.cards[U_ID].buyLastKnown.timestamp = afterStart; },
      'carried card: time edited (older)': (a) => { a.cards[U_ID].buyLastKnown.timestamp = new Date(Date.parse(OLD) - 3600e3).toISOString(); },
    };
    for (const [name, mutate] of Object.entries(mutants)) {
      const a = JSON.parse(JSON.stringify(art));
      mutate(a);
      writeArt(a);
      const g = gate(sb);
      assert.notEqual(g.status, 0, `N7 tamper "${name}" must make the real gate fail`);
    }
    writeArt(art);
    assert.equal(gate(sb).status, 0, 'restored artifact passes again');
    check(`N7 negatives: ${Object.keys(mutants).length} retained-quote edits (price / shop / time older / newer / after run start / source key; card, variant, carried) all fail the real gate`);

    // N8 / N9: CONSISTENT edits — the carry digest is recomputed with the exported production
    // audit, so the only thing that can reject them is the evidence / assignment rule itself.
    const dir = path.join(sb, 'data/buy-prices');
    const recomputeCarryDigest = (a) => {
      const p = a.buyQuoteRun;
      const now = Date.parse(p.now);
      const rs = p.runStartedAt == null ? null : Date.parse(p.runStartedAt);
      const freshByNum = rs == null ? new Map() : buildBuyIndex(now, { dir, notBefore: rs });
      a.buyQuoteRun.retainedCarryDigest = auditRetainedQuotes(a, notFreshBoundEvidence(dir, now, rs), { now, runStartedAt: rs, freshByNum }).carryDigest;
    };
    const hrHolder = art.cards[HR_ID].buyLastKnown;
    const hrTuple = art.cards[HR_ID].prices[0];
    const newer = new Date(Date.parse(OBSC) + 1800e3).toISOString(); // still before the run start
    const consistentMutants = {
      'N8 card: own-provider (fullahead) holder newer than its bound entry': (a) => { a.cards[HR_ID].buyLastKnown.timestamp = newer; },
      'N8 variant: own-provider tuple newer than its bound entry': (a) => { a.cards[HR_ID].prices[0].buyPriceTimestamp = newer; },
      'N8 card: covered holder rewritten to a sourceKey absent from the files': (a) => { a.cards[HR_ID].buyLastKnown.sourceKey = 'hBP01-024-ZZZ'; },
      'N8 card: absent sourceKey + newer time (own provider still quotes the token)': (a) => { a.cards[HR_ID].buyLastKnown.sourceKey = 'hBP01-024-ZZZ'; a.cards[HR_ID].buyLastKnown.timestamp = newer; },
      'N9a reprint C row given the HR holder': (a) => {
        Object.assign(a.cards[C_ID], { buyPrice: hrHolder.price, buyPriceRetained: true, buyLastKnown: { ...hrHolder } });
      },
      'N9b own-set base U row given a premium (HR) holder': (a) => {
        Object.assign(a.cards[U_ID], { buyPrice: 5, buyLastKnown: { price: 5, version: 'HR', source: 'fullahead', timestamp: OLD, sourceKey: 'hBP09-105-HR' } });
      },
      'N9d plain (パラレル) variant given a copy of the パラレル/HR tuple': (a) => {
        const { buyPrice, buyPriceVersion, buyPriceSource, buyPriceTimestamp } = hrTuple;
        Object.assign(a.cards[HR_ID].prices[1], { buyPrice, buyPriceVersion, buyPriceSource, buyPriceTimestamp, buyPriceRetained: true });
      },
    };
    // N10: the controls named after a rule must be rejected BY that rule (exact production reason).
    const expectedReasons = {
      'N9a reprint C row given the HR holder': { [vkey(C_ID, '#card')]: 'not-the-merge-assignment' },
      'N9b own-set base U row given a premium (HR) holder': { [vkey(U_ID, '#card')]: 'not-the-merge-assignment' },
      'N9d plain (パラレル) variant given a copy of the パラレル/HR tuple': { [vkey(HR_ID, 1)]: 'not-the-merge-assignment' },
      // Coherent edit: holder AND variant moved together, so the clone (N9) is self-consistent and
      // the judge would otherwise CARRY both — only the N8 own-provider rule rejects it.
      'N8 coherent: HR card holder AND HR variant tuple both moved newer (own provider still quotes HR)': {
        [vkey(HR_ID, '#card')]: 'newer-than-own-bound-entry',
        [vkey(HR_ID, 0)]: 'newer-than-own-bound-entry',
      },
    };
    consistentMutants['N8 coherent: HR card holder AND HR variant tuple both moved newer (own provider still quotes HR)'] = (a) => {
      a.cards[HR_ID].buyLastKnown.timestamp = newer;
      a.cards[HR_ID].prices[0].buyPriceTimestamp = newer;
    };
    for (const [name, mutate] of Object.entries(consistentMutants)) {
      const a = JSON.parse(JSON.stringify(art));
      mutate(a);
      recomputeCarryDigest(a);
      const audit = productionAudit(a, dir);
      assert.ok(audit.violations.size > 0, `consistent tamper "${name}": the production audit must report a violation`);
      for (const [k, why] of Object.entries(expectedReasons[name] || {})) {
        assert.equal(audit.violations.get(k), why, `consistent tamper "${name}": ${k.replace('\u0000', ' :: ')} must be rejected exactly as ${why}`);
      }
      writeArt(a);
      const g = gate(sb);
      assert.notEqual(g.status, 0, `consistent tamper "${name}" (digest recomputed) must make the real gate fail`);
    }

    // Optional hermetic mutation demonstration (N10): in a sandbox copy whose merge-buy-prices.js
    // has ONLY the N8 rule disabled, the coherent edit (digest recomputed by that mutant audit)
    // is accepted by the real gate — so the coherent control above is what protects N8.
    {
      const mut = makeSandbox(cacheAt(OBSC, { u: null }));
      sandboxes.push(mut);
      const file = path.join(mut, 'scripts/merge-buy-prices.js');
      const src = fs.readFileSync(file, 'utf8');
      const anchor = 'if (own.length && t > Math.max(';
      assert.ok(src.includes(anchor), 'mutation anchor: the N8 own-provider rule');
      fs.writeFileSync(file, src.replace(anchor, 'if (false && own.length && t > Math.max('));
      const mutMod = await import(`${pathToFileURL(file).href}?n8-disabled`);
      const mdir = path.join(mut, 'data/buy-prices');
      assert.equal(fs.readFileSync(path.join(mdir, 'fullahead-prices.json'), 'utf8'), fs.readFileSync(path.join(dir, 'fullahead-prices.json'), 'utf8'), 'premise: same bound bytes');
      const a = JSON.parse(JSON.stringify(art));
      a.cards[HR_ID].buyLastKnown.timestamp = newer;
      a.cards[HR_ID].prices[0].buyPriceTimestamp = newer;
      const mAudit = productionAudit(a, mdir, mutMod);
      assert.equal(mAudit.violations.size, 0, 'with N8 disabled, nothing else rejects the coherent edit (it is carried)');
      a.buyQuoteRun.retainedCarryDigest = mAudit.carryDigest;
      fs.writeFileSync(dbFile(mut), `${JSON.stringify(a, null, 2)}\n`);
      const g = gate(mut);
      assert.equal(g.status, 0, `with N8 disabled the real gate accepts the coherent edit (mutation is only caught by the N8 control):\n${(g.stderr || g.stdout).slice(-800)}`);
      check('N10 mutation demo: disabling only the N8 rule turns the coherent control green — the control isolates N8');
    }
    // the recompute helper itself must not break a valid artifact
    const same = JSON.parse(JSON.stringify(art));
    recomputeCarryDigest(same);
    assert.equal(same.buyQuoteRun.retainedCarryDigest, art.buyQuoteRun.retainedCarryDigest, 'premise: the recompute helper reproduces the merge digest');
    writeArt(art);
    assert.equal(gate(sb).status, 0, 'restored artifact passes again');
    check(`N8/N9 negatives: ${Object.keys(consistentMutants).length} consistent edits with a RECOMPUTED carry digest (own-provider newer card/variant, absent source key, reprint HR, base premium, plain-parallel copy) all fail the real gate`);
  }

  // N9c: own-set base row with a bare holder while its OWN-CODE listing is in the bound evidence
  // (bare is ambiguous → the merge refuses it; a consistent edit adding it must fail the gate).
  {
    const runStartMs = Date.now() - 60e3;
    const OBSC = new Date(runStartMs - 3 * 3600e3).toISOString();
    const OLD = new Date(runStartMs - 30 * 3600e3).toISOString();
    const sb = makeSandbox({ 'hBP09-105-U': { buyPrice: 9, rarity: 'U', timestamp: OBSC } });
    sandboxes.push(sb);
    const dir = path.join(sb, 'data/buy-prices');
    const art = {
      lastUpdated: '2026-11-07T00:00:00.000Z', totalCards: 1,
      cards: {
        [U_ID]: {
          id: U_ID, cardNumber: 'hBP09-105', rarity: 'U', series: 'hBP09', prices: [], buyPriceHistory: { '2026-09-27': 5 },
          buyPriorSource: [{ sourceKey: 'hBP09-105', token: '', price: 5, source: 'fullahead', timestamp: OLD }],
        },
      },
    };
    mergeQuiet(art, { now: Date.now(), runStartedAt: runStartMs, dir });
    assert.equal(art.cards[U_ID].buyPrice, undefined, 'premise: bare + own-code (U) evidence → the merge retains nothing');
    fs.writeFileSync(dbFile(sb), `${JSON.stringify(art, null, 2)}\n`);
    assert.equal(gate(sb).status, 0, 'premise: the merge artifact itself passes');
    const a = JSON.parse(JSON.stringify(art));
    Object.assign(a.cards[U_ID], { buyPrice: 5, buyPriceRetained: true, buyLastKnown: { price: 5, version: 'BASE', source: 'fullahead', timestamp: OLD, sourceKey: 'hBP09-105' } });
    const p = a.buyQuoteRun;
    a.buyQuoteRun.retainedCarryDigest = auditRetainedQuotes(a, notFreshBoundEvidence(dir, Date.parse(p.now), Date.parse(p.runStartedAt)), {
      now: Date.parse(p.now), runStartedAt: Date.parse(p.runStartedAt), freshByNum: buildBuyIndex(Date.parse(p.now), { dir, notBefore: Date.parse(p.runStartedAt) }),
    }).carryDigest;
    assert.equal(productionAudit(a, dir).violations.get(vkey(U_ID, '#card')), 'not-the-merge-assignment', 'N9c is rejected exactly by the merge-assignment rule');
    fs.writeFileSync(dbFile(sb), `${JSON.stringify(a, null, 2)}\n`);
    assert.notEqual(gate(sb).status, 0, 'N9c: a bare holder beside its own-code listing (digest recomputed) must make the real gate fail');
    check('N9c negative: own-set base row given a bare holder while its own-code listing is bound evidence fails the real gate (reason not-the-merge-assignment)');
  }

  // N10: card-only N8 control — an HR card with NO variant (nothing for N9 to cross-check), holder
  // moved newer while its own provider still quotes HR in the bound files, digest recomputed.
  {
    const runStartMs = Date.now() - 60e3;
    const OBSC = new Date(runStartMs - 3 * 3600e3).toISOString();
    const sb = makeSandbox(cacheAt(OBSC, { u: null }));
    sandboxes.push(sb);
    const dir = path.join(sb, 'data/buy-prices');
    const art = {
      lastUpdated: '2026-11-07T00:00:00.000Z', totalCards: 1,
      cards: { [HR_ID]: { id: HR_ID, cardNumber: 'hBP01-024', rarity: 'HR', series: 'hBP07', prices: [], buyPriceHistory: { '2026-09-27': 1600 } } },
    };
    mergeQuiet(art, { now: Date.now(), runStartedAt: runStartMs, dir });
    assert.deepEqual(art.cards[HR_ID].buyLastKnown, { price: 1600, version: 'HR', source: 'fullahead', timestamp: OBSC, sourceKey: 'hBP01-024-HR' }, 'premise: covered card-only holder');
    fs.writeFileSync(dbFile(sb), `${JSON.stringify(art, null, 2)}\n`);
    assert.equal(gate(sb).status, 0, 'premise: the card-only merge artifact passes');
    const a = JSON.parse(JSON.stringify(art));
    a.cards[HR_ID].buyLastKnown.timestamp = new Date(Date.parse(OBSC) + 1800e3).toISOString(); // before the run start
    a.buyQuoteRun.retainedCarryDigest = productionAudit(a, dir).carryDigest;
    const audit = productionAudit(a, dir);
    assert.equal(audit.violations.size, 1, 'exactly one violation');
    assert.equal(audit.violations.get(vkey(HR_ID, '#card')), 'newer-than-own-bound-entry', 'card-only newer holder is rejected exactly by the N8 rule');
    fs.writeFileSync(dbFile(sb), `${JSON.stringify(a, null, 2)}\n`);
    assert.notEqual(gate(sb).status, 0, 'card-only own-provider newer holder (digest recomputed) must make the real gate fail');
    check('N10 card-only N8 negative: newer holder with its own provider still quoting HR fails the real gate (reason newer-than-own-bound-entry)');
  }

  // N8 positive: a DIFFERENT-provider prior capture newer than the bound entry is legitimately
  // carried (torecolo OBSC+1h captured vs fullahead OBSC still in the files) — retained, passes.
  {
    const runStartMs = Date.now() - 60e3;
    const OBSC = new Date(runStartMs - 3 * 3600e3).toISOString();
    const T_TORE = new Date(Date.parse(OBSC) + 3600e3).toISOString();
    const sb = makeSandbox(cacheAt(OBSC, { u: null }));
    sandboxes.push(sb);
    const art = {
      lastUpdated: '2026-11-07T00:00:00.000Z', totalCards: 1,
      cards: {
        [HR_ID]: {
          id: HR_ID, cardNumber: 'hBP01-024', rarity: 'HR', series: 'hBP07', buyPriceHistory: { '2026-09-27': 1600 },
          prices: [{ name: 'ベスティア・ゼータ(パラレル/HR)', sellPrice: 9000 }],
          buyPriorSource: [{ sourceKey: 'hBP01-024-HR', token: 'HR', price: 1700, source: 'torecolo', timestamp: T_TORE }],
        },
      },
    };
    mergeQuiet(art, { now: Date.now(), runStartedAt: runStartMs, dir: path.join(sb, 'data/buy-prices') });
    assert.deepEqual(art.cards[HR_ID].buyLastKnown, { price: 1700, version: 'HR', source: 'torecolo', timestamp: T_TORE, sourceKey: 'hBP01-024-HR' }, 'newest (other provider) quote retained');
    assert.equal(art.cards[HR_ID].prices[0].buyPriceSource, 'torecolo');
    fs.writeFileSync(dbFile(sb), `${JSON.stringify(art, null, 2)}\n`);
    const g = gate(sb);
    assert.equal(g.status, 0, `a different-provider newer capture is a legitimate carried quote:\n${(g.stderr || g.stdout).slice(-1500)}`);
    assert.match(g.stdout, /source-covered 0, carried 2\)/, 'card holder + variant tuple both carried');
    check('N8 positive: a different-provider prior capture newer than the bound entry is retained as carried and passes');
  }

  // Publication: the run proof never ships.
  {
    const { sanitizeDatabase, stripInternalAuditDatabase } = await import('./lib/store-mvp-sanitize.mjs');
    assert.ok(!('buyQuoteRun' in sanitizeDatabase(retainedSnapshot)) && !('buyQuoteRun' in stripInternalAuditDatabase(retainedSnapshot)),
      'run proof stripped from Store MVP / native and full web projections');
    check('run proof is internal: absent from every published projection');
  }
} finally {
  for (const sb of sandboxes) fs.rmSync(sb, { recursive: true, force: true });
}
console.log(`buy regen fixed point (N5): ${passed} checks passed`);
