/**
 * verify-scan-dedup.mjs
 *
 * Standalone verification for the scan de-duplication logic (DIC-700).
 * Runs the pure helpers from src/utils/scanDedup.ts against the same
 * scenarios that reproduce the "single card recorded twice" bug.
 *
 * Run:  node --experimental-strip-types scripts/verify-scan-dedup.mjs
 * (Node 22.6+; type stripping lets us import the .ts helper directly.)
 */
import assert from 'node:assert/strict';
import {
  dedupKey,
  isDuplicateScan,
  SCAN_DEDUP_WINDOW_MS,
} from '../src/utils/scanDedup.ts';

/**
 * Minimal re-implementation of the store's addCard dedup branch so we can
 * exercise the full sequence a scan session goes through without pulling in
 * zustand / react-native. This mirrors scanSessionStore.addCard exactly.
 */
function makeSession() {
  const state = { cards: [], lastScanKey: null, lastScanAt: null };
  return {
    state,
    addCard(card, now, options = {}) {
      const key = dedupKey(card);
      if (!options.force && isDuplicateScan(state.lastScanKey, state.lastScanAt, key, now)) {
        state.lastScanAt = now; // refresh window on blocked attempt
        return false;
      }
      state.cards.push({ ...card, scannedAt: now });
      state.lastScanKey = key;
      state.lastScanAt = now;
      return true;
    },
  };
}

const cardA = { cardNumber: 'hBP01-001', series: 'hbp', rarity: 'R' };
const cardB = { cardNumber: 'hSD13-014', series: 'hsd', rarity: 'C' };

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('scan dedup verification');

check('dedupKey is stable + case/space-insensitive', () => {
  assert.equal(dedupKey(cardA), dedupKey({ cardNumber: ' HBP01-001 ', series: 'HBP', rarity: 'r' }));
  assert.notEqual(dedupKey(cardA), dedupKey(cardB));
});

check('dedupKey falls back to id when cardNumber missing', () => {
  assert.equal(dedupKey({ id: 'x1', series: 's', rarity: 'C' }), 'x1|s|c');
});

check('BUG REPRO: auto-scan re-fires on same stable card → only ONE record', () => {
  const s = makeSession();
  // First scan at t=0
  assert.equal(s.addCard(cardA, 0), true);
  // Auto-scan cooldown is 3s; the card is still in frame so it re-triggers
  // at ~3s, ~6s, ~9s, ~12s. Before the fix each of these appended a row.
  assert.equal(s.addCard(cardA, 3000), false);
  assert.equal(s.addCard(cardA, 6000), false);
  assert.equal(s.addCard(cardA, 9000), false);
  assert.equal(s.addCard(cardA, 12000), false);
  assert.equal(s.state.cards.length, 1);
});

check('different cards in a row are all recorded', () => {
  const s = makeSession();
  assert.equal(s.addCard(cardA, 0), true);
  assert.equal(s.addCard(cardB, 500), true);
  assert.equal(s.addCard(cardA, 3000), true); // switched cards → new distinct scan
  assert.equal(s.state.cards.length, 3);
});

check('consecutive same card is blocked; a different card between is not', () => {
  const s = makeSession();
  assert.equal(s.addCard(cardA, 0), true);
  assert.equal(s.addCard(cardA, 1000), false); // immediate repeat blocked
  assert.equal(s.addCard(cardB, 2000), true);  // different card passes
  assert.equal(s.state.cards.length, 2);
});

check('same card after the window has elapsed IS recorded again', () => {
  const s = makeSession();
  assert.equal(s.addCard(cardA, 0), true);
  // Card leaves frame; no detections for longer than the window, then returns.
  assert.equal(s.addCard(cardA, SCAN_DEDUP_WINDOW_MS + 1), true);
  assert.equal(s.state.cards.length, 2);
});

check('explicit force ("再加入一張") bypasses dedup', () => {
  const s = makeSession();
  assert.equal(s.addCard(cardA, 0), true);
  assert.equal(s.addCard(cardA, 1000, { force: true }), true);
  assert.equal(s.state.cards.length, 2);
});

console.log(`\nAll ${passed} checks passed.`);
