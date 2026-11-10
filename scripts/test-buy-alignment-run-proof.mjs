#!/usr/bin/env node
/**
 * test-buy-alignment-run-proof.mjs — PR #287 repair regression (2026-11-10).
 *
 * Root cause pinned here: the committed 2026-11-10 artifact was written by merge-buy-prices.js
 * WITHOUT a valid run marker (`buyQuoteRun.runStartedAt: null`), so by the merge's reviewed
 * contract nothing is fresh and every proven quote is RETAINED with its own source/time.
 * verify-buy-price-alignment.mjs re-derived "fresh" from snapshot age instead and therefore
 *   (a) counted 0 fresh priced cards (all 883 are retained) → `priced > 100` failed, and
 *   (b) expected this run's quotes as fresh variant assignments → 2 mismatches per hBP05-023 /
 *       hBP07-074 / hBP06-066, one of which (the SR row's plain (パラレル) taking the UR listing)
 *       is a CROSS-PRINTING borrow the merge correctly did not make.
 *   2026-11-10 matcher repair (A + B): plain (パラレル) variants are bound by their own rarity / the
 *   row's printing, so that snapshot expectation no longer exists (asserted below), and the SR
 *   variant takes only the exact SR listing (old, retained, own shop/time).
 *
 * Independent review R1 (P1-1 / P1-2): the resolver-free retained coverage classifier
 * (lib/buy-retained-coverage.mjs) must equal the proof audit's covered / carried counts, report
 * carried quotes as consistency-only, and refuse vacuous / mismatched / malformed coverage; and one
 * tamper per certified field (shop, time, printing, sourceKey, proof digests, time zone, now, a
 * faked run marker, carried quotes) must end in invalid-run-proof with the expected reason, the
 * verifier gate failing and nothing ever fresh. Self-consistent limits are pinned, not hidden.
 *
 * Uses the REAL merge (mergeBuyPricesInto), the REAL run-proof validator and the verifier's
 * fresh-context module, on throwaway source files in os.tmpdir(). No network, no repo data written.
 * Run: node scripts/test-buy-alignment-run-proof.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeBuyPricesInto, buildBuyIndex, assignVariantBuyPrices } from './merge-buy-prices.js';
import { latestSourceTs } from './regen-buy-alignment.mjs';
import { freshContextForArtifact, runProofProblems } from './lib/buy-alignment-fresh.mjs';
import { classifyRetainedQuotes, retainedCoverageProblems } from './lib/buy-retained-coverage.mjs';
import { normalizeCardNumber } from './lib/variant-key.js';

let passed = 0;
const ok = (m) => { passed += 1; console.log(`  ✓ ${m}`); };
const T_RUN = '2026-11-10T12:08:40.195Z';          // this run's fullahead observation (shape of PR #287)
const T_OLD = '2026-08-24T10:07:24.215Z';          // an old yuyu observation (stale, > 18h)
const NOW = Date.parse('2026-11-10T12:08:41.498Z');

function sourceDir() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'buy-run-proof-')));
  fs.writeFileSync(path.join(d, 'fullahead-prices.json'), JSON.stringify({ 'hBP05-023-UR': { buyPrice: 600, rarity: 'UR', timestamp: T_RUN } }));
  fs.writeFileSync(path.join(d, 'torecolo-prices.json'), JSON.stringify({}));
  fs.writeFileSync(path.join(d, 'yuyu-prices.json'), JSON.stringify({
    'HBP05-023-UR': { buyPrice: 800, rarity: 'UR', timestamp: T_OLD },
    'HBP05-023-SR': { buyPrice: 150, rarity: 'SR', timestamp: T_OLD },
  }));
  return d;
}
const row = (rarity) => ({
  id: `hBP05-023_hBP05_${rarity}_hBP05-023_${rarity}`, cardNumber: 'hBP05-023', rarity, series: 'hBP05',
  prices: [{ name: 'アイラニ・イオフィフティーン(パラレル)', rarity, sellPrice: rarity === 'UR' ? 1280 : 320 }],
});
function artifact() {
  const ur = row('UR');
  const sr = row('SR');
  // main's pre-existing tuple on the SR row: the UR listing (the latent borrow on main)
  Object.assign(sr.prices[0], { buyPrice: 600, buyPriceVersion: 'UR', buyPriceSource: 'fullahead', buyPriceTimestamp: '2026-11-08T12:05:50.906Z' });
  return { cards: { [ur.id]: ur, [sr.id]: sr } };
}
/** The verifier's recompute invariant (same rule as findRecomputeViolations). */
function recomputeViolations(cards, entriesFor) {
  const out = [];
  for (const [id, c] of Object.entries(cards)) {
    const expected = assignVariantBuyPrices(c.prices, entriesFor(normalizeCardNumber(c.cardNumber)), c.rarity);
    c.prices.forEach((v, i) => {
      if (v.buyPriceRetained === true && expected[i] == null) return;
      if ((v.buyPrice ?? null) !== (expected[i] ?? null)) out.push(`${id} stored=${v.buyPrice ?? null} expected=${expected[i] ?? null}`);
    });
  }
  return out;
}
const entriesOf = (idx) => (num) => [...((idx.get(num)) || [])];

const tmps = [];
try {
  console.log('── no run marker (the PR #287 artifact shape) ──');
  {
    const dir = sourceDir(); tmps.push(dir);
    const db = artifact();
    mergeBuyPricesInto(db, { now: NOW, runStartedAt: null, dir });
    const ur = db.cards['hBP05-023_hBP05_UR_hBP05-023_UR'];
    const sr = db.cards['hBP05-023_hBP05_SR_hBP05-023_SR'];
    assert.equal(db.buyQuoteRun.runStartedAt, null);
    // the merge: card-level UR row keeps its OWN exact UR quote as last-known (original shop/time);
    // the SR row never takes the UR listing. 2026-11-10 matcher repair A: each plain (パラレル) is
    // bound by its OWN rarity — UR variant ← the UR quote, SR variant ← the exact SR quote (old,
    // labelled retained with its own shop/time), never the other printing's listing.
    assert.equal(ur.buyPrice, 600);
    assert.equal(ur.buyPriceRetained, true);
    assert.deepEqual(ur.buyLastKnown, { price: 600, version: 'UR', source: 'fullahead', timestamp: T_RUN, sourceKey: 'hBP05-023-UR' });
    assert.equal(sr.buyPrice, undefined, 'SR row card level: bare absent and an own-code SR listing exists → fail closed');
    const tuple = (v) => [v.buyPrice, v.buyPriceVersion, v.buyPriceSource, v.buyPriceTimestamp, v.buyPriceRetained];
    assert.deepEqual(tuple(ur.prices[0]), [600, 'UR', 'fullahead', T_RUN, true]);
    assert.deepEqual(tuple(sr.prices[0]), [150, 'SR', 'yuyu', T_OLD, true],
      'the main-era UR tuple on the SR variant is not carried; the SR printing takes only the SR listing');
    assert.equal(ur.buyPriceHistory, undefined, 'retained quotes never write history');
    ok('merge without run marker: exact-printing last-known kept with original source/time; no cross-printing borrow; no history written');

    // OLD verifier semantics (snapshot age): the reported CI mismatch on the SR printing WAS the
    // UR-listing borrow; with printing binding the snapshot expectation no longer demands it
    const snapIdx = buildBuyIndex(latestSourceTs(dir) + 1000, { dir });
    const snapV = recomputeViolations(db.cards, entriesOf(snapIdx));
    assert.deepEqual(snapV, [], snapV.join('\n'));
    assert.deepEqual(assignVariantBuyPrices(sr.prices, entriesOf(snapIdx)('HBP05-023'), sr.rarity), [null], 'the SR printing is never expected to take the UR listing');
    assert.deepEqual(assignVariantBuyPrices([{ name: sr.prices[0].name }], entriesOf(snapIdx)('HBP05-023'), sr.rarity), [null], 'nor without variant rarity (row printing SR ≠ UR)');
    assert.deepEqual(assignVariantBuyPrices(ur.prices, entriesOf(snapIdx)('HBP05-023'), ur.rarity), [600]);
    ok('snapshot semantics with printing binding: no SR-printing expectation of the UR listing (borrow gone, with or without variant rarity); UR printing consistent');

    // NEW verifier context: the merge's own contract, valid proof, zero audit violations, nothing fresh
    const ctx = freshContextForArtifact(db, { buyDir: dir });
    assert.equal(ctx.mode, 'run-proof');
    assert.equal(ctx.runStartedAt, null);
    assert.equal(ctx.freshIndex.size, 0);
    assert.equal(ctx.proof.audit.violations.size, 0);
    assert.deepEqual(recomputeViolations(db.cards, entriesOf(ctx.freshIndex)), []);
    assert.equal(ctx.isFresh(Date.parse(T_RUN)), false, 'no run marker → nothing is fresh');
    assert.ok((ctx.boundEvidence.get('HBP05-023') || []).some((e) => e.token === 'UR' && e.price === 600 && e.timestamp === T_RUN), 'retained evidence visible to collapse checks');
    ok('run-proof context: valid proof, audit 0 violations, empty fresh index, recompute clean, evidence kept for collapse detection');

    // fail closed: any change to the bound source bytes invalidates the proof → verifier must FAIL
    fs.writeFileSync(path.join(dir, 'fullahead-prices.json'), JSON.stringify({ 'hBP05-023-UR': { buyPrice: 601, rarity: 'UR', timestamp: T_RUN } }));
    assert.equal(freshContextForArtifact(db, { buyDir: dir }).mode, 'invalid-run-proof');
    // and a tampered retained quote in the artifact (value changed) invalidates it as well
    const dir2 = sourceDir(); tmps.push(dir2);
    const db2 = artifact();
    mergeBuyPricesInto(db2, { now: NOW, runStartedAt: null, dir: dir2 });
    db2.cards['hBP05-023_hBP05_UR_hBP05-023_UR'].buyPrice = 800;
    db2.cards['hBP05-023_hBP05_UR_hBP05-023_UR'].buyLastKnown.price = 800;
    const c2 = freshContextForArtifact(db2, { buyDir: dir2 });
    assert.ok(c2.mode === 'invalid-run-proof' || c2.proof.audit.violations.size > 0, 'an edited retained quote is never accepted');
    ok('source bytes changed → invalid-run-proof; edited retained quote → invalid / audit violation (fail closed, never green)');
  }

  // ── review R1 P1-1 / P1-2: independent retained coverage + one tamper per certified field ──
  // A third row whose quote has NO source entry left (torecolo SEC, observed 2026-11-09): the merge
  // certifies it as CARRIED (variant tuple + card holder). Nothing distinguishes it from an invented
  // quote except the immutable parent artifact — exactly what the coverage report must say.
  const T_MID = '2026-11-09T12:00:00.000Z';
  const CARRIED_ID = 'hBP05-099_hBP05_SEC_hBP05-099_SEC';
  const UR_KEY = 'hBP05-023_hBP05_UR_hBP05-023_UR\u0000#card';
  const carriedRow = () => ({
    id: CARRIED_ID, cardNumber: 'hBP05-099', rarity: 'SEC', series: 'hBP05',
    prices: [{ name: 'テスト(パラレル/サイン)', rarity: 'SEC', sellPrice: 9000,
      buyPrice: 3000, buyPriceVersion: 'SEC', buyPriceSource: 'torecolo', buyPriceTimestamp: T_MID, buyPriceRetained: true }],
  });
  const freshCount = (ctx) => [...ctx.freshIndex.values()].reduce((n, m) => n + (m instanceof Map ? m.size : (m && m.length) || 0), 0);
  console.log('── independent retained coverage (P1-1) ──');
  const dirC = sourceDir(); tmps.push(dirC);
  const clean = artifact();
  clean.cards[CARRIED_ID] = carriedRow();
  mergeBuyPricesInto(clean, { now: NOW, runStartedAt: null, dir: dirC });
  {
    const ctx = freshContextForArtifact(clean, { buyDir: dirC });
    assert.equal(ctx.mode, 'run-proof');
    assert.deepEqual(runProofProblems(ctx), []);
    const cov = classifyRetainedQuotes(clean, { buyDir: dirC, now: ctx.proof.now, runStartedAt: ctx.proof.runStartedAt });
    assert.equal(cov.retainedTuples, 5);
    assert.equal(cov.covered, 3, 'UR holder + UR variant (fullahead) and SR variant (yuyu SR) are in the raw files (same number/token/shop/price/time[/sourceKey])');
    assert.equal(cov.carried, 2, 'the SEC variant tuple + holder have no raw entry');
    assert.deepEqual([cov.covered, cov.carried], [ctx.proof.audit.covered, ctx.proof.audit.carried], 'independent counts == proof audit');
    assert.deepEqual(retainedCoverageProblems(cov, ctx.proof, clean.buyQuoteRun.retainedCarryDigest), []);
    assert.deepEqual(cov.coveredRows, [
      { id: 'hBP05-023_hBP05_SR_hBP05-023_SR', slot: '0', token: 'SR', file: 'yuyu-prices.json', sourceKey: 'HBP05-023-SR' },
      { id: 'hBP05-023_hBP05_UR_hBP05-023_UR', slot: '0', token: 'UR', file: 'fullahead-prices.json', sourceKey: 'hBP05-023-UR' },
      { id: 'hBP05-023_hBP05_UR_hBP05-023_UR', slot: 'card', token: 'UR', file: 'fullahead-prices.json', sourceKey: 'hBP05-023-UR' },
    ]);
    // carried = consistency-only: reported with full value / shop / time for the host parent comparison
    assert.deepEqual(cov.carriedRows.map((r) => [r.id, r.slot, r.token, r.price, r.source, r.timestamp]),
      [[CARRIED_ID, '0', 'SEC', 3000, 'torecolo', T_MID], [CARRIED_ID, 'card', 'SEC', 3000, 'torecolo', T_MID]]);
    // independence: a covered tuple edited in the artifact is no longer covered by the RAW files,
    // whatever the (clean) proof says → count mismatch is reported
    const m = JSON.parse(JSON.stringify(clean));
    m.cards['hBP05-023_hBP05_UR_hBP05-023_UR'].buyPrice = 601;
    m.cards['hBP05-023_hBP05_UR_hBP05-023_UR'].buyLastKnown.price = 601;
    const covM = classifyRetainedQuotes(m, { buyDir: dirC, now: ctx.proof.now, runStartedAt: ctx.proof.runStartedAt });
    assert.deepEqual([covM.covered, covM.carried], [2, 3]);
    const pm = retainedCoverageProblems(covM, ctx.proof, m.buyQuoteRun.retainedCarryDigest);
    assert.ok(pm.some((x) => /independent covered 2 != proof audit covered 3/.test(x)), pm.join(' | '));
    assert.ok(pm.some((x) => /independent carried 3 != proof audit carried 2/.test(x)), pm.join(' | '));
    assert.ok(pm.some((x) => /does not match buyQuoteRun\.retainedCarryDigest/.test(x)), pm.join(' | '));
    // malformed / at-or-after-bound tuples are problems, never silently carried
    const bad = JSON.parse(JSON.stringify(clean));
    bad.cards[CARRIED_ID].prices[0].buyPriceSource = 'ebay';
    bad.cards[CARRIED_ID].buyLastKnown.timestamp = new Date(NOW + 60e3).toISOString();
    const covB = classifyRetainedQuotes(bad, { buyDir: dirC, now: ctx.proof.now, runStartedAt: ctx.proof.runStartedAt });
    const pb = retainedCoverageProblems(covB, ctx.proof, bad.buyQuoteRun.retainedCarryDigest);
    assert.ok(pb.some((x) => /malformed/.test(x)) && pb.some((x) => /at\/after the retained bound/.test(x)), pb.join(' | '));
    // vacuity: an all-carried artifact (no retained quote backed by any raw entry) is refused
    const dirV = sourceDir(); tmps.push(dirV);
    const onlyCarried = { cards: { [CARRIED_ID]: carriedRow() } };
    mergeBuyPricesInto(onlyCarried, { now: NOW, runStartedAt: null, dir: dirV });
    const cV = freshContextForArtifact(onlyCarried, { buyDir: dirV });
    assert.equal(cV.mode, 'run-proof', 'the proof itself is self-consistent');
    const covV = classifyRetainedQuotes(onlyCarried, { buyDir: dirV, now: cV.proof.now, runStartedAt: cV.proof.runStartedAt });
    assert.deepEqual([covV.covered, covV.carried], [0, 2]);
    assert.ok(retainedCoverageProblems(covV, cV.proof, onlyCarried.buyQuoteRun.retainedCarryDigest).some((x) => /vacuous/.test(x)));
    // a proof audit that disagrees with the independent counts is reported
    const fake = { audit: { covered: 2, carried: 1, violations: new Map() } };
    const pf = retainedCoverageProblems(cov, fake, clean.buyQuoteRun.retainedCarryDigest);
    assert.ok(pf.some((x) => /covered 3 != proof audit covered 2/.test(x)) && pf.some((x) => /carried 2 != proof audit carried 1/.test(x)), pf.join(' | '));
    ok('independent coverage (raw files, no resolver/merge): covered 3 / carried 2 == proof audit; carried rows reported as consistency-only; edited covered tuple, malformed / after-bound tuple, all-carried (vacuous) and audit-count mismatch all reported');
  }

  console.log('── tamper mutations through the verifier context (P1-2) ──');
  {
    const mutate = (fn) => { const m = JSON.parse(JSON.stringify(clean)); fn(m); return freshContextForArtifact(m, { buyDir: dirC }); };
    const urRow = (m) => m.cards['hBP05-023_hBP05_UR_hBP05-023_UR'];
    const cRow = (m) => m.cards[CARRIED_ID];
    const rejected = (name, ctx, expect) => {
      assert.equal(ctx.mode, 'invalid-run-proof', `${name}: must be invalid-run-proof`);
      assert.ok(runProofProblems(ctx).length > 0, `${name}: the verifier's run-proof gate must fail`);
      assert.equal(freshCount(ctx), 0, `${name}: nothing fresh`);
      assert.equal(ctx.isFresh(Date.parse(T_RUN)), false, `${name}: retained never turned fresh`);
      if (expect.violation) {
        const [key, why] = expect.violation;
        assert.ok(ctx.proof && ctx.proof.audit.violations.get(key) === why,
          `${name}: expected audit violation ${why}, got ${ctx.proof ? JSON.stringify([...ctx.proof.audit.violations]) : 'no proof'}`);
      } else {
        assert.equal(ctx.proof, null, `${name}: expected proof rejection (digest / malformed field)`);
      }
    };
    const cases = {
      'retained shop': [(m) => { urRow(m).buyLastKnown.source = 'yuyu'; }, { violation: [UR_KEY, 'newer-than-own-bound-entry'] }],
      'retained time (earlier)': [(m) => { urRow(m).buyLastKnown.timestamp = '2026-11-10T11:00:00.000Z'; }, { violation: [UR_KEY, 'older-than-bound-evidence'] }],
      'retained time (after bound)': [(m) => { urRow(m).buyLastKnown.timestamp = new Date(NOW + 60e3).toISOString(); }, { violation: [UR_KEY, 'after-run-start'] }],
      'retained printing (card holder)': [(m) => { urRow(m).buyLastKnown.version = 'SR'; }, { violation: [UR_KEY, 'not-the-merge-assignment'] }],
      'retained printing (variant tuple)': [(m) => { cRow(m).prices[0].buyPriceVersion = 'HR'; }, { digest: true }],
      // the PR #287 borrow itself: the SR variant given the (raw-covered) UR listing tuple
      'cross-printing borrow (SR variant ← UR listing)': [(m) => {
        Object.assign(m.cards['hBP05-023_hBP05_SR_hBP05-023_SR'].prices[0], { buyPrice: 600, buyPriceVersion: 'UR', buyPriceSource: 'fullahead', buyPriceTimestamp: T_RUN });
      }, { violation: ['hBP05-023_hBP05_SR_hBP05-023_SR\u00000', 'not-the-merge-assignment'] }],
      'retained sourceKey (covered)': [(m) => { urRow(m).buyLastKnown.sourceKey = 'hBP05-023-SR'; }, { violation: [UR_KEY, 'conflicts-bound-evidence'] }],
      'retained sourceKey (carried)': [(m) => { cRow(m).buyLastKnown.sourceKey = 'hBP05-099-SEC'; }, { digest: true }],
      'proof sourceDigest': [(m) => { m.buyQuoteRun.sourceDigest = '0'.repeat(64); }, { digest: true }],
      'proof retainedCarryDigest': [(m) => { m.buyQuoteRun.retainedCarryDigest = '0'.repeat(64); }, { digest: true }],
      'proof timeZone invalid': [(m) => { m.buyQuoteRun.timeZone = 'Not/AZone'; }, { digest: true }],
      'proof timeZone empty': [(m) => { m.buyQuoteRun.timeZone = ''; }, { digest: true }],
      'proof now unparsable': [(m) => { m.buyQuoteRun.now = 'yesterday'; }, { digest: true }],
      'proof now before a retained observation': [(m) => { m.buyQuoteRun.now = new Date(Date.parse(T_RUN) - 1000).toISOString(); }, { violation: [UR_KEY, 'after-run-start'] }],
      'faked run marker before the observations': [(m) => { m.buyQuoteRun.runStartedAt = new Date(Date.parse(T_RUN) - 600e3).toISOString(); }, { violation: [UR_KEY, 'after-run-start'] }],
      'faked run marker unparsable': [(m) => { m.buyQuoteRun.runStartedAt = 'today'; }, { digest: true }],
      'carried value (digest unchanged)': [(m) => { cRow(m).buyPrice = 3100; cRow(m).buyLastKnown.price = 3100; }, { digest: true }],
      'carried variant value (digest unchanged)': [(m) => { cRow(m).prices[0].buyPrice = 3100; }, { digest: true }],
      'carried shop (digest unchanged)': [(m) => { cRow(m).buyLastKnown.source = 'fullahead'; }, { digest: true }],
      'carried time (digest unchanged)': [(m) => { cRow(m).buyLastKnown.timestamp = '2026-11-09T13:00:00.000Z'; }, { digest: true }],
    };
    for (const [name, [fn, expect]] of Object.entries(cases)) rejected(name, mutate(fn), expect);
    // a non-zero audit makes the verifier gate fail even if a caller hands it a "run-proof" context
    const forged = { mode: 'run-proof', proof: { audit: { violations: new Map([[UR_KEY, 'conflicts-bound-evidence']]) } } };
    assert.ok(runProofProblems(forged).some((x) => /retained audit violations 1/.test(x)));
    assert.ok(runProofProblems({ mode: 'run-proof', proof: { audit: {} } }).some((x) => /no retained audit result/.test(x)));
    // Pinned limitations (NOT detectable by a verifier-only change; recorded in the evidence):
    //  - a faked marker AFTER every observation reproduces the identical merge → still zero fresh;
    //  - a later `now` or another VALID time zone is not bound by the proof; with no marker neither
    //    changes any output (nothing fresh, no BUY history), and nothing becomes fresh.
    for (const [name, fn] of Object.entries({
      'marker after all observations': (m) => { m.buyQuoteRun.runStartedAt = new Date(NOW - 500).toISOString(); },
      'later now': (m) => { m.buyQuoteRun.now = new Date(NOW + 86400e3).toISOString(); },
      'other valid time zone': (m) => { m.buyQuoteRun.timeZone = 'UTC'; },
    })) {
      const ctx = mutate(fn);
      assert.equal(ctx.mode, 'run-proof', `${name}: self-consistent (documented limitation)`);
      assert.equal(freshCount(ctx), 0, `${name}: still nothing fresh`);
      assert.equal(ctx.isFresh(Date.parse(T_RUN)), false, `${name}: retained never turned fresh`);
    }
    ok(`${Object.keys(cases).length} tamper mutations (shop / time / printing / sourceKey / proof digests / time zone / now / faked marker / carried quote) → invalid-run-proof with the expected audit reason or proof rejection; gate fails on any audit violation; nothing ever fresh; 3 self-consistent limits pinned`);
  }

  console.log('── PR #287 hBP06-081 shape: both borrows are audit violations under A + B ──');
  {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'buy-run-proof-081-'))); tmps.push(d);
    const T_Y = '2026-08-24T10:07:27.123Z';
    fs.writeFileSync(path.join(d, 'fullahead-prices.json'), JSON.stringify({ 'hBP06-081-UR': { buyPrice: 1900, rarity: 'UR', timestamp: T_RUN } }));
    fs.writeFileSync(path.join(d, 'torecolo-prices.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(d, 'yuyu-prices.json'), JSON.stringify({ 'HBP06-081-UR': { buyPrice: 3500, rarity: 'UR', timestamp: T_Y }, 'HBP06-081': { buyPrice: 5, rarity: null, timestamp: T_Y } }));
    const r = (rarity, name, vr) => ({ id: `hBP06-081_hBP06_${rarity}_hBP06-081_${rarity}`, cardNumber: 'hBP06-081', rarity, series: 'hBP06', prices: [{ name, rarity: vr, sellPrice: 100 }] });
    const SR = 'hBP06-081_hBP06_SR_hBP06-081_SR';
    const db = { cards: {} };
    for (const c of [r('RR', '大空スバル', 'RR'), r('UR', '大空スバル(パラレル)', 'UR'), r('SR', '大空スバル(パラレル)', 'SR')]) db.cards[c.id] = c;
    mergeBuyPricesInto(db, { now: NOW, runStartedAt: null, dir: d });
    assert.equal(db.cards[SR].buyPrice, undefined, 'B: the SR row never takes the bare (RR) listing');
    assert.equal(db.cards[SR].prices[0].buyPrice, undefined, 'A: the SR variant never takes the UR listing');
    assert.equal(db.cards['hBP06-081_hBP06_RR_hBP06-081_RR'].buyPrice, 5, 'RR base row keeps its bare listing');
    assert.equal(db.cards['hBP06-081_hBP06_UR_hBP06-081_UR'].buyPrice, 1900, 'UR row keeps its own UR quote');
    assert.equal(db.cards['hBP06-081_hBP06_UR_hBP06-081_UR'].prices[0].buyPriceVersion, 'UR');
    assert.equal(freshContextForArtifact(db, { buyDir: d }).mode, 'run-proof');
    // the committed PR #287 values on the SR row (both raw-covered quotes → only the printing rule rejects them)
    const pr = JSON.parse(JSON.stringify(db));
    Object.assign(pr.cards[SR], { buyPrice: 5, buyPriceRetained: true, buyLastKnown: { price: 5, version: 'BASE', source: 'yuyu', timestamp: T_Y, sourceKey: 'HBP06-081' } });
    Object.assign(pr.cards[SR].prices[0], { buyPrice: 1900, buyPriceVersion: 'UR', buyPriceSource: 'fullahead', buyPriceTimestamp: T_RUN, buyPriceRetained: true });
    const ctx = freshContextForArtifact(pr, { buyDir: d });
    assert.equal(ctx.mode, 'invalid-run-proof');
    assert.ok(ctx.proof, 'digest unchanged: both quotes are raw-covered, so the proof itself is consistent');
    assert.equal(ctx.proof.audit.violations.get(`${SR}\u0000#card`), 'not-the-merge-assignment');
    assert.equal(ctx.proof.audit.violations.get(`${SR}\u00000`), 'not-the-merge-assignment');
    assert.equal(ctx.proof.audit.violations.size, 2);
    ok('hBP06-081: merge gives the SR row nothing (A + B), RR keeps bare 5, UR keeps UR 1900; the committed SR-row values are exactly 2 audit violations');
  }

  console.log('── run marker present (a normal daily run) ──');
  {
    const dir = sourceDir(); tmps.push(dir);
    const db = artifact();
    const runStartedAt = Date.parse(T_RUN) - 600e3;
    mergeBuyPricesInto(db, { now: NOW, runStartedAt, dir });
    const ctx = freshContextForArtifact(db, { buyDir: dir });
    assert.equal(ctx.mode, 'run-proof');
    assert.equal(ctx.runStartedAt, runStartedAt);
    assert.ok(ctx.freshIndex.get('HBP05-023'), 'this run\'s quote is fresh under the marker');
    assert.equal(ctx.isFresh(Date.parse(T_RUN)), true);
    assert.equal(ctx.isFresh(Date.parse(T_OLD)), false);
    assert.equal(ctx.isFresh(runStartedAt - 1), false, 'observed before the run start → not fresh');
    assert.deepEqual(recomputeViolations(db.cards, entriesOf(ctx.freshIndex)), [], 'verifier and merge agree');
    assert.equal(db.cards['hBP05-023_hBP05_UR_hBP05-023_UR'].buyPrice, 600);
    assert.equal(db.cards['hBP05-023_hBP05_UR_hBP05-023_UR'].buyPriceRetained, undefined, 'fresh, not retained');
    ok('with a valid run marker the verifier uses exactly the merge\'s fresh index (notBefore = run start); merge and verifier agree');
  }

  console.log('── legacy artifact (no buyQuoteRun) ──');
  {
    const dir = sourceDir(); tmps.push(dir);
    const ctx = freshContextForArtifact({ cards: {} }, { buyDir: dir });
    assert.equal(ctx.mode, 'snapshot');
    assert.equal(ctx.now, latestSourceTs(dir) + 1000);
    assert.equal(ctx.isFresh(Date.parse(T_RUN)), true);
    assert.equal(ctx.isFresh(Date.parse(T_OLD)), false);
    ok('no buyQuoteRun → the unchanged snapshot semantics');
  }
} finally {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
}
console.log(`buy-alignment run-proof regression: ${passed} checks passed`);
