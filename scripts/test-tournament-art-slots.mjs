#!/usr/bin/env node
/**
 * Proven art-slot consolidation in the Deck Log adapter (X9552 follow-up).
 *
 * Deck Log publishes one row per ARTWORK. X9552 lists hSD14-010 twice — ids 2727 and
 * 2995, images hPR/hSD14-010_P.png and hPR/hSD14-010_P_02.png, version P, ×1 each —
 * and the official column image linked to X9552 shows the two different holoAN arts ×1
 * each. cardsFromDecklog may merge such rows into ONE slot with the summed count, but
 * only when the published fields prove it; everything else must stay separate so the
 * strict duplicate gate still refuses it.
 *
 * Source: scripts/fixtures/decklog-x9552-art-slots.json (sanitized public response with
 * provenance). Offline.
 *
 * Run: npm run test:tournament-art-slots
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cardsFromDecklog,
  decklogArtSlotGroups,
  verifyDeckCards,
  normalizeCards,
  totalsByZone,
} from '../src/utils/tournamentReport.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/decklog-x9552-art-slots.json'), 'utf8'));
const catalog = new Set(
  Object.values(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/database.json'), 'utf8')).cards)
    .map((c) => String(c.cardNumber ?? '').trim()),
);

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const deck = () => structuredClone(FIXTURE.deck);
const holoAN = (d) => d.list.filter((r) => r.card_number === 'hSD14-010');
const rawTotals = (d) => ({
  oshi: d.p_list.reduce((n, r) => n + r.num, 0),
  main: d.list.reduce((n, r) => n + r.num, 0),
  yell: d.sub_list.reduce((n, r) => n + r.num, 0),
});
/** The adapter must still return exactly the published rows (one slot each), so the
 * strict gate refuses the duplicate — the pre-existing fail-closed behaviour. */
function assertStillRefused(d, reason) {
  const groups = decklogArtSlotGroups(d);
  const g = groups.find((x) => x.cardNumber === 'hSD14-010');
  assert.equal(g.proven, false, 'must not be proven');
  assert.match(g.failure, reason);
  const cards = cardsFromDecklog(d);
  assert.equal(cards.filter((c) => c.cardNumber === 'hSD14-010').length, holoAN(d).length, 'rows kept separate');
  assert.deepEqual(totalsByZone(cards), rawTotals(d), 'nothing dropped');
  const v = verifyDeckCards(cards, catalog);
  assert.equal(v.cardsVerified, false);
  assert.match(v.failure, /duplicate card slot within zone: main:hSD14-010/);
}

check('fixture provenance: public Deck Log X9552 (HTTP 200) and the official column image it is linked from', () => {
  const p = FIXTURE.provenance;
  assert.equal(p.decklog.url, 'https://decklog.bushiroad.com/system/app/api/view/X9552');
  assert.equal(p.decklog.httpStatus, 200);
  assert.match(p.decklog.responseSha256, /^[0-9a-f]{64}$/);
  assert.equal(p.officialColumn.linksImageToDeckLog, 'https://decklog.bushiroad.com/view/X9552');
  assert.match(p.officialColumn.image.url, /deck-showcase_vol-15\/img_column05\.jpg$/);
  assert.match(p.officialColumn.image.sha256, /^[0-9a-f]{64}$/);
  // Proof fields only: no names, owner, title, comments or image bytes.
  for (const list of ['p_list', 'list', 'sub_list']) {
    for (const r of FIXTURE.deck[list]) assert.deepEqual(Object.keys(r).sort(), ['card_number', 'id', 'img', 'num', 'rare', 'type']);
  }
});

check('positive: the proven pair becomes one hSD14-010 P slot ×2; totals, every other row and order are preserved', () => {
  const d = deck();
  const cards = cardsFromDecklog(d);
  const slots = cards.filter((c) => c.cardNumber === 'hSD14-010');
  assert.deepEqual(slots, [{ zone: 'main', cardNumber: 'hSD14-010', version: 'P', count: 2 }]);
  assert.deepEqual(totalsByZone(cards), { oshi: 1, main: 50, yell: 20 });
  assert.deepEqual(totalsByZone(cards), rawTotals(d));
  // Every other published row survives exactly as before, in order.
  const others = (list, zone) => list.filter((r) => r.card_number !== 'hSD14-010')
    .map((r) => ({ zone, cardNumber: r.card_number, version: r.rare, count: r.num }));
  assert.deepEqual(
    cards.filter((c) => c.cardNumber !== 'hSD14-010'),
    [...others(d.p_list, 'oshi'), ...others(d.list, 'main'), ...others(d.sub_list, 'yell')],
  );
  // The consolidated slot sits where the first published row was.
  assert.equal(cards.findIndex((c) => c.cardNumber === 'hSD14-010'), 1 + d.list.findIndex((r) => r.card_number === 'hSD14-010'));
  // Source-published counts are not "fixed" by any copy-limit assumption.
  assert.equal(cards.find((c) => c.cardNumber === 'hBP01-068').count, 5);
  const v = verifyDeckCards(cards, catalog);
  assert.equal(v.cardsVerified, true, v.failure);
});

check('positive: the proof record names both ids, both images and both counts', () => {
  const [g] = decklogArtSlotGroups(deck());
  assert.equal(g.proven, true);
  assert.deepEqual(g.rows.map((r) => [r.id, r.img, r.count]), [
    [2727, 'hPR/hSD14-010_P.png', 1],
    [2995, 'hPR/hSD14-010_P_02.png', 1],
  ]);
  assert.equal(decklogArtSlotGroups(deck()).length, 1, 'no other card number repeats');
});

check('negative: the same Deck Log id twice is not proof', () => {
  const d = deck();
  holoAN(d)[1].id = holoAN(d)[0].id;
  assertStillRefused(d, /same Deck Log id/);
});

check('negative: the same image twice is not proof', () => {
  const d = deck();
  holoAN(d)[1].img = holoAN(d)[0].img;
  assertStillRefused(d, /same image/);
});

check('negative: missing or unreadable ids are not proof', () => {
  for (const bad of [undefined, null, 0, -1, 1.5, '2995']) {
    const d = deck();
    holoAN(d)[1].id = bad;
    assertStillRefused(d, /no readable Deck Log id/);
  }
});

check('negative: missing, malformed or contradictory images are not proof', () => {
  for (const [bad, reason] of [
    [undefined, /no readable image path/],
    ['', /no readable image path/],
    ['hPR/../hSD14-010_P_02.png', /no readable image path/],
    ['hPR/hSD14-011_P_02.png', /does not name hSD14-010/],
  ]) {
    const d = deck();
    holoAN(d)[1].img = bad;
    assertStillRefused(d, reason);
  }
});

check('negative: differing or missing versions are not proof (no printing is chosen)', () => {
  for (const bad of ['S', '', null]) {
    const d = deck();
    holoAN(d)[1].rare = bad;
    assertStillRefused(d, /one common version/);
  }
});

check('negative: malformed type or count still throws before any consolidation', () => {
  const d1 = deck();
  holoAN(d1)[1].type = 2;
  assert.throws(() => cardsFromDecklog(d1), /hSD14-010 has type 2, expected 1/);
  for (const num of [0, -1, 1.5, '1', undefined]) {
    const d2 = deck();
    holoAN(d2)[1].num = num;
    assert.throws(() => cardsFromDecklog(d2), /hSD14-010 has no readable copy count/);
  }
});

check('negative: the same normalized duplicate list is still refused by verifyDeckCards / normalizeCards', () => {
  const d = deck();
  for (const r of holoAN(d)) { delete r.id; delete r.img; } // what the old minimal capture carried
  assertStillRefused(d, /no readable Deck Log id/);
  const split = cardsFromDecklog(d);
  const { verified, failure } = normalizeCards(split, catalog);
  assert.equal(verified, false);
  assert.match(failure, /duplicate card slot within zone: main:hSD14-010/);
});

check('rows without any id/img (existing callers) are returned exactly as published', () => {
  const plain = {
    p_list: [{ card_number: 'hBP07-006', num: 1, rare: 'OSR', type: 3 }],
    list: [{ card_number: 'hBP07-063', num: 2, rare: 'C', type: 1 }, { card_number: 'hBP07-063', num: 2, rare: 'C', type: 1 }],
    sub_list: [{ card_number: 'hY05-003', num: 20, rare: 'SY', type: 2 }],
  };
  assert.deepEqual(cardsFromDecklog(plain).filter((c) => c.cardNumber === 'hBP07-063').map((c) => c.count), [2, 2]);
});

console.log(`\nX9552 proven art-slot adapter: ${passed} checks passed`);
