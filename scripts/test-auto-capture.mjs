#!/usr/bin/env node
/**
 * v41 native automatic capture: the trigger rules (src/services/autoCapture) on
 * synthetic probe readings. A "probe" here is the list of whole-token card numbers the
 * on-device reader found inside the scan frame.
 */
import assert from 'node:assert/strict';

const { createAutoCaptureMachine } = await import('../src/services/autoCapture.ts');
const { findCardNumberTokens } = await import('../src/utils/cardNumberToken.ts');

let passed = 0;
function test(label, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (err) { process.exitCode = 1; console.error(`  ✗ ${label} — ${err.message}`); }
}
const run = (m, probes) => probes.map((p) => m.onProbe(p));

test('nothing readable never triggers (no blind timer capture)', () => {
  const m = createAutoCaptureMachine();
  assert.deepEqual(run(m, [[], [], [], []]), ['none', 'none', 'none', 'none']);
});
test('one number held still for two probes triggers exactly once', () => {
  const m = createAutoCaptureMachine();
  assert.deepEqual(run(m, [['hbp01-010'], ['hbp01-010']]), ['none', 'trigger']);
  assert.equal(m.state().armed, false);
});
test('a number seen once, then another, is not stable', () => {
  const m = createAutoCaptureMachine();
  assert.deepEqual(run(m, [['hbp01-010'], ['hbp01-011'], ['hbp01-010']]), ['none', 'none', 'none']);
});
test('two different numbers in the frame (two cards) never trigger', () => {
  const m = createAutoCaptureMachine();
  assert.deepEqual(run(m, [['hbp01-010', 'hbp01-011'], ['hbp01-010', 'hbp01-011'], ['hbp01-010', 'hbp01-011']]), ['none', 'none', 'none']);
});
test('the same card left in the frame after its round is never triggered again', () => {
  const m = createAutoCaptureMachine();
  run(m, [['hbp01-010'], ['hbp01-010']]);
  assert.deepEqual(run(m, Array(10).fill(['hbp01-010'])), Array(10).fill('none'));
});
test('removing the card re-arms; the next card held still triggers once', () => {
  const m = createAutoCaptureMachine();
  run(m, [['hbp01-010'], ['hbp01-010']]);
  assert.deepEqual(run(m, [[], ['hbp05-081'], ['hbp05-081'], ['hbp05-081']]), ['none', 'none', 'trigger', 'none']);
});
test('swapping straight to another card re-arms on that probe', () => {
  const m = createAutoCaptureMachine();
  run(m, [['hbp01-010'], ['hbp01-010']]);
  assert.deepEqual(run(m, [['heb01-014'], ['heb01-014']]), ['none', 'trigger']);
});
test('after a manual (shutter) round it waits for an empty frame — the card that was shot is not re-scanned', () => {
  const m = createAutoCaptureMachine();
  m.roundStarted(null);
  assert.deepEqual(run(m, [['hbp01-010'], ['hbp01-010'], ['hbp01-010']]), ['none', 'none', 'none']);
  assert.deepEqual(run(m, [[], ['hbp01-010'], ['hbp01-010']]), ['none', 'none', 'trigger']);
});
test('idle for maxIdleProbes pauses (battery); while paused nothing triggers; resume re-enables', () => {
  const m = createAutoCaptureMachine({ maxIdleProbes: 5 });
  run(m, Array(5).fill([]));
  assert.equal(m.state().paused, true);
  assert.deepEqual(run(m, [['hbp01-010'], ['hbp01-010']]), ['none', 'none']);
  m.resume();
  assert.deepEqual(run(m, [['hbp01-010'], ['hbp01-010']]), ['none', 'trigger']);
});
test('a card left in front of the camera after its round also pauses after maxIdleProbes', () => {
  const m = createAutoCaptureMachine({ maxIdleProbes: 4 });
  run(m, [['hbp01-010'], ['hbp01-010']]);
  run(m, Array(4).fill(['hbp01-010']));
  assert.equal(m.state().paused, true);
});
test('stableHits can never be configured below 2 (one probe is never enough)', () => {
  const m = createAutoCaptureMachine({ stableHits: 1 });
  assert.deepEqual(run(m, [['hbp01-010'], ['hbp01-010']]), ['none', 'trigger']);
});
test('probe readings use the strict whole-token parser: truncation / extra digits are not numbers', () => {
  assert.deepEqual(findCardNumberTokens('hBP01-0100'), []);
  assert.deepEqual(findCardNumberTokens('hBP01-010SR'), []);
  assert.deepEqual(findCardNumberTokens('天音かなた hBP01-010 U'), ['hbp01-010']);
});

if ((process.exitCode ?? 0) === 0) console.log(`\n✅ auto-capture: ${passed} checks passed`);
else console.error('\n❌ auto-capture failed');
