#!/usr/bin/env node
/**
 * PR228 — the frozen price fixture may only be EXTENDED, never re-priced.
 *
 * Synthetic, offline. Exercises scripts/lib/frozen-price-fixture.mjs#extendFixture and
 * #listingSetForCardNumber against hand-built databases in both shapes the scraper has
 * produced (card-number-wide rows, and per-printing rows since late 2026-08), plus the
 * committed fixture's own provenance.
 *
 * Run: npm run test:frozen-prices-extend
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extendFixture, listingSetForCardNumber, FIXTURE_PATH } from './lib/frozen-price-fixture.mjs';

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const L = (name, sellPrice) => ({ name, sellPrice, rarity: '', imageUrl: `https://example.invalid/${encodeURIComponent(name)}.jpg` });
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
// Old shape: every row of a card number carries the same card-number-wide set.
const OLD_DB = {
  'X-001_set1': { cardNumber: 'X-001', prices: [L('X', 100), L('X(パラレル)', 900)] },
  'X-001_set2': { cardNumber: 'X-001', prices: [L('X', 100), L('X(パラレル)', 900)] },
  'Y-001_set1': { cardNumber: 'Y-001', prices: [L('Y', 30)] },
};
// New shape: each printing row carries only its own listing.
const NEW_DB = {
  'Y-001_set1': { cardNumber: 'Y-001', prices: [L('Y', 45)] },
  'Z-001_C': { cardNumber: 'Z-001', prices: [L('Z', 50)] },
  'Z-001_S': { cardNumber: 'Z-001', prices: [L('Z(パラレル)', 1280)] },
  'Z-001_P': { cardNumber: 'Z-001', prices: [] },
  'W-001_C': { cardNumber: 'W-001', prices: [L('W', 50)] },
  'W-001_S': { cardNumber: 'W-001', prices: [L('W', 70)] }, // same label, different data
};
const EXISTING = {
  _comment: 'c',
  generator: 'g',
  source: { path: 'public/data/database.json', ref: 'old' },
  cards: { 'Y-001': [L('Y', 30)] },
};

check('rows that agree give that set unchanged', () => {
  assert.deepEqual(listingSetForCardNumber(OLD_DB, 'X-001'), { listings: OLD_DB['X-001_set1'].prices, method: 'rows-agree' });
});

check('per-printing rows give the union of their own listings, never a borrowed price', () => {
  const r = listingSetForCardNumber(NEW_DB, 'Z-001');
  assert.equal(r.method, 'per-printing-union');
  assert.deepEqual(r.listings.map((l) => [l.name, l.sellPrice]), [['Z', 50], ['Z(パラレル)', 1280]]);
});

check('negative: one label with two different prices across rows is refused, not guessed', () => {
  assert.throws(() => listingSetForCardNumber(NEW_DB, 'W-001'), /two printing rows list "W" with different data/);
});

check('existing entries and source are kept byte-for-byte even when a newer database re-prices them', () => {
  const next = extendFixture(EXISTING, ['X-001', 'Y-001', 'Z-001'], [
    { ref: 'A', commit: SHA_A, cards: NEW_DB },
    { ref: 'B', commit: SHA_B, cards: OLD_DB },
  ]);
  assert.deepEqual(next.cards['Y-001'], [L('Y', 30)], 'Y-001 must not take the newer ¥45');
  assert.deepEqual(next.source, EXISTING.source);
  assert.deepEqual(next.cards['X-001'], OLD_DB['X-001_set1'].prices);
  assert.deepEqual(next.supplements, [
    { ref: 'B', commit: SHA_B, method: 'rows-agree', cardNumbers: ['X-001'] },
    { ref: 'A', commit: SHA_A, method: 'per-printing-union', cardNumbers: ['Z-001'] },
  ]);
});

check('negative: a required card number no source has fails instead of being left out', () => {
  assert.throws(() => extendFixture(EXISTING, ['Q-404'], [{ ref: 'A', commit: SHA_A, cards: NEW_DB }]), /no source database has a row for: Q-404/);
});

check('committed fixture: original 89 entries untouched by supplements; every supplement is a full commit', () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  assert.equal(fixture.source.ref, 'a00676629');
  const supplemented = (fixture.supplements ?? []).flatMap((s) => s.cardNumbers);
  assert.equal(new Set(supplemented).size, supplemented.length);
  assert.equal(Object.keys(fixture.cards).length - supplemented.length, 89);
  for (const s of fixture.supplements) {
    assert.match(s.commit, /^[0-9a-f]{40}$/);
    assert.ok(['rows-agree', 'per-printing-union'].includes(s.method));
  }
  // The DIC-1127 DUKHN regression listings (¥12,660 at a00676629) are not supplements.
  for (const n of ['hBP05-080', 'hBP01-104', 'hBP05-074']) assert.ok(!supplemented.includes(n), n);
  // The three plain listings the 2026-08-21 scrape moved (lib header) keep their frozen values.
  const plain = (n, label) => fixture.cards[n].filter((l) => l.name === label).map((l) => l.sellPrice);
  assert.deepEqual(plain('hBP05-080', 'SorAZセレブレーション'), [980]);
  assert.deepEqual(plain('hBP01-104', 'ふつうのパソコン'), [500]);
  assert.deepEqual(plain('hBP05-074', 'フレンドリーパソコン'), [320]);
});

console.log(`\nPR228 frozen fixture additive extension: ${passed} checks passed`);
