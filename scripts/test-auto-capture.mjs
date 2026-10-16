#!/usr/bin/env node
/**
 * v41 native automatic capture: the trigger rules (src/services/autoCapture) on
 * synthetic probe readings. A "probe" here is the list of whole-token card numbers the
 * on-device reader found inside the scan frame.
 */
import assert from 'node:assert/strict';

const { createAutoCaptureMachine, DEFAULT_FRAME_REGION } = await import('../src/services/autoCapture.ts');
const { findCardNumberTokens } = await import('../src/utils/cardNumberToken.ts');

let passed = 0;
function test(label, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (err) { process.exitCode = 1; console.error(`  ✗ ${label} — ${err.message}`); }
}
// The card number's box in the probe crop (normalised): bottom-left of the frame, steady.
const STEADY = { x: 0.1, y: 0.86, width: 0.22, height: 0.04 };
const at = (token, box = STEADY) => ({ token, box });
// Token-sequence tests: each reading is a number held at the same in-frame position.
const run = (m, probes) => probes.map((p) => m.onProbe(p.map((t) => at(t))));

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
test('removing the card (3 probes without it) re-arms; the next card held still triggers once', () => {
  const m = createAutoCaptureMachine();
  run(m, [['hbp01-010'], ['hbp01-010']]);
  assert.deepEqual(run(m, [[], [], [], ['hbp05-081'], ['hbp05-081'], ['hbp05-081']]), ['none', 'none', 'none', 'none', 'trigger', 'none']);
});
test('swapping straight to another card: re-armed once the old number is gone for 3 probes, then held still', () => {
  const m = createAutoCaptureMachine();
  run(m, [['hbp01-010'], ['hbp01-010']]);
  assert.deepEqual(run(m, [['heb01-014'], ['heb01-014'], ['heb01-014'], ['heb01-014']]), ['none', 'none', 'none', 'trigger']);
});
test('OCR noise while the SAME card stays: old → one empty read → old never re-arms (no second request)', () => {
  const m = createAutoCaptureMachine();
  run(m, [['hbp01-010'], ['hbp01-010']]);
  assert.deepEqual(run(m, [[], ['hbp01-010'], ['hbp01-010'], [], ['hbp01-010'], ['hbp01-010']]), Array(6).fill('none'));
  assert.equal(m.state().armed, false);
});
test('OCR noise while the SAME card stays: old → one misread token → old never re-arms', () => {
  const m = createAutoCaptureMachine();
  run(m, [['hbp01-010'], ['hbp01-010']]);
  assert.deepEqual(run(m, [['hbp01-016'], ['hbp01-010'], ['hbp01-016'], ['hbp01-016'], ['hbp01-010'], ['hbp01-010']]), Array(6).fill('none'));
  assert.equal(m.state().armed, false);
});
test('absentToRearm can never be configured below 2', () => {
  const m = createAutoCaptureMachine({ absentToRearm: 1 });
  run(m, [['hbp01-010'], ['hbp01-010']]);
  assert.deepEqual(run(m, [[], ['hbp01-010']]), ['none', 'none']);
});
test('after a manual (shutter) round it waits for an empty frame — the card that was shot is not re-scanned', () => {
  const m = createAutoCaptureMachine();
  m.roundStarted(null);
  assert.deepEqual(run(m, [['hbp01-010'], ['hbp01-010'], ['hbp01-010']]), ['none', 'none', 'none']);
  assert.deepEqual(run(m, [[], [], [], ['hbp01-010'], ['hbp01-010']]), ['none', 'none', 'none', 'none', 'trigger']);
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
test('geometry: the same number whose box MOVES between probes (card waved through) never triggers', () => {
  const m = createAutoCaptureMachine();
  const moving = [0.1, 0.25, 0.4, 0.55, 0.7].map((x) => [at('hbp01-010', { ...STEADY, x })]);
  assert.deepEqual(moving.map((p) => m.onProbe(p)), Array(5).fill('none'));
});
test('geometry: held still after moving → triggers once it stayed for two probes', () => {
  const m = createAutoCaptureMachine();
  assert.deepEqual([
    [at('hbp01-010', { ...STEADY, x: 0.3 })],
    [at('hbp01-010', { ...STEADY, x: 0.1 })],
    [at('hbp01-010', { ...STEADY, x: 0.105, y: 0.862 })],  // hand shake within tolerance
  ].map((p) => m.onProbe(p)), ['none', 'none', 'trigger']);
});
test('geometry: a number in the crop margin (outside the frame) never triggers', () => {
  const m = createAutoCaptureMachine();
  const margin = { x: 0.005, y: 0.5, width: 0.2, height: 0.04 };   // left of the frame edge
  assert.ok(margin.x < DEFAULT_FRAME_REGION.x);
  assert.deepEqual([[at('hbp01-010', margin)], [at('hbp01-010', margin)], [at('hbp01-010', margin)]].map((p) => m.onProbe(p)), ['none', 'none', 'none']);
});
test('geometry: a reading without a box (reader gave none) never triggers — fail closed', () => {
  const m = createAutoCaptureMachine();
  assert.deepEqual([['hbp01-010'], ['hbp01-010'], ['hbp01-010']].map((p) => m.onProbe(p)), ['none', 'none', 'none']);
});
test('geometry: the same number read twice in one probe (two places) is ambiguous → no trigger', () => {
  const m = createAutoCaptureMachine();
  const two = [at('hbp01-010'), at('hbp01-010', { ...STEADY, y: 0.2 })];
  assert.deepEqual([two, two, two].map((p) => m.onProbe(p)), ['none', 'none', 'none']);
});
test('geometry: a box growing fast (card pulled toward the lens) is not steady', () => {
  const m = createAutoCaptureMachine();
  assert.deepEqual([[at('hbp01-010')], [at('hbp01-010', { ...STEADY, width: 0.3, height: 0.055 })]].map((p) => m.onProbe(p)), ['none', 'none']);
});

test('probe readings use the strict whole-token parser: truncation / extra digits are not numbers', () => {
  assert.deepEqual(findCardNumberTokens('hBP01-0100'), []);
  assert.deepEqual(findCardNumberTokens('hBP01-010SR'), []);
  assert.deepEqual(findCardNumberTokens('天音かなた hBP01-010 U'), ['hbp01-010']);
});

if ((process.exitCode ?? 0) === 0) console.log(`\n✅ auto-capture: ${passed} checks passed`);
else console.error('\n❌ auto-capture failed');
