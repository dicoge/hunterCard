#!/usr/bin/env node
/**
 * v42 (Android 41 user report "根本不會偵測"; PM BLOCK_GROUPING_REPRO): the automatic
 * scan must measure the printed card NUMBER, not the ML Kit text BLOCK it is grouped
 * into. Real nativeOcrProbe adapter + real observationsFromProbeText + real trigger state
 * machine, fed native-module-shaped payloads (no camera, no bitmap, no ML Kit run).
 * Native source contract of the tracked local module is checked statically here; its
 * compilation is the remote Android CI gate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { nativeOcrProbe } = await import('../src/services/nativeOcr.ts');
const { createAutoCaptureMachine, observationsFromProbeText } = await import('../src/services/autoCapture.ts');
const { findCardNumberTokens } = await import('../src/utils/cardNumberToken.ts');

let passed = 0;
async function test(label, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (e) { process.exitCode = 1; console.error(`  ✗ ${label} — ${e.message}`); }
}

const W = 1600, H = 1600;
const NUMBER = { x: 500, y: 1110, width: 300, height: 32 };   // the printed number: fixed
const geometryOf = (payload) => () => ({ recognizeGeometry: async () => payload });
const noOcrKit = () => { throw new Error('expo-ocr-kit must not be needed when line geometry is available'); };
const probe = async (payload) => observationsFromProbeText(
  await nativeOcrProbe('synthetic://no-camera', { geometryImpl: geometryOf(payload), requireImpl: noOcrKit }),
  findCardNumberTokens, W, H,
);
// What ML Kit may return for the SAME physical card on consecutive frames: the number
// grouped with an adjacent line into one block, or standalone. Line/element boxes of the
// number are identical; only the block bounds change (PM reproduction, 1600 px crop).
const grouped = (number = NUMBER) => ({ text: 'synthetic adjacent text\nhBP01-010 U', blocks: [{
  text: 'synthetic adjacent text\nhBP01-010 U', boundingBox: { x: 500, y: number.y - 160, width: 330, height: 192 },
  lines: [
    { text: 'synthetic adjacent text', boundingBox: { x: 500, y: number.y - 160, width: 330, height: 40 }, elements: [] },
    { text: 'hBP01-010 U', boundingBox: { x: number.x, y: number.y, width: number.width + 30, height: number.height },
      elements: [{ text: 'hBP01-010', boundingBox: number }, { text: 'U', boundingBox: { x: number.x + number.width + 10, y: number.y, width: 20, height: number.height } }] },
  ] }] });
const standalone = (number = NUMBER) => ({ text: 'hBP01-010', blocks: [{
  text: 'hBP01-010', boundingBox: number,
  lines: [{ text: 'hBP01-010', boundingBox: number, elements: [{ text: 'hBP01-010', boundingBox: number }] }] }] });

await test('PM reproduction, new native payload: the same number alternately grouped / standalone → ONE trigger by the 2nd probe (was none 8/8 on block boxes)', async () => {
  const m = createAutoCaptureMachine();
  const decisions = [];
  for (let i = 0; i < 8 && !decisions.includes('trigger'); i++) decisions.push(m.onProbe(await probe(i % 2 ? standalone() : grouped())));
  assert.deepEqual(decisions, ['none', 'trigger']);
});

await test('the measured box is the number element itself (not the block, not the line with the rarity letter)', async () => {
  const [o] = await probe(grouped());
  assert.equal(o.token, 'hbp01-010');
  assert.deepEqual(o.box, { x: NUMBER.x / W, y: NUMBER.y / H, width: NUMBER.width / W, height: NUMBER.height / H });
});

await test('safeguards unchanged — a number that MOVES between probes never triggers, even with line geometry', async () => {
  const m = createAutoCaptureMachine();
  const decisions = [];
  for (let i = 0; i < 6; i++) decisions.push(m.onProbe(await probe(standalone({ ...NUMBER, x: 200 + i * 120 }))));
  assert.ok(!decisions.includes('trigger'), decisions.join(','));
});

await test('safeguards unchanged — a number outside the frame region (crop margin) never triggers', async () => {
  const m = createAutoCaptureMachine();
  const edge = { x: 10, y: 1580, width: 300, height: 18 };
  const d = [m.onProbe(await probe(standalone(edge))), m.onProbe(await probe(standalone(edge))), m.onProbe(await probe(standalone(edge)))];
  assert.ok(!d.includes('trigger'), d.join(','));
});

await test('safeguards unchanged — no card number / two numbers in one probe → no trigger', async () => {
  const m = createAutoCaptureMachine();
  const empty = { text: '', blocks: [] };
  const two = { text: 'hBP01-010\nhBP01-011', blocks: [{ text: 'hBP01-010\nhBP01-011', boundingBox: { x: 500, y: 900, width: 300, height: 260 }, lines: [
    { text: 'hBP01-010', boundingBox: NUMBER, elements: [{ text: 'hBP01-010', boundingBox: NUMBER }] },
    { text: 'hBP01-011', boundingBox: { ...NUMBER, y: 900 }, elements: [{ text: 'hBP01-011', boundingBox: { ...NUMBER, y: 900 } }] }] }] };
  const d = [];
  for (let i = 0; i < 3; i++) d.push(m.onProbe(await probe(empty)));
  for (let i = 0; i < 3; i++) d.push(m.onProbe(await probe(two)));
  assert.ok(!d.includes('trigger'), d.join(','));
});

await test('no element for the number (e.g. split into words) → the LINE box is used', async () => {
  const payload = { text: 'hBP01-010 U', blocks: [{ text: 'x\nhBP01-010 U', boundingBox: { x: 0, y: 0, width: 900, height: 900 }, lines: [
    { text: 'hBP01-010 U', boundingBox: { x: 500, y: 1110, width: 330, height: 32 }, elements: [{ text: 'hBP01', boundingBox: { x: 500, y: 1110, width: 120, height: 32 } }] }] }] };
  const [o] = await probe(payload);
  assert.equal(o.box.width, 330 / W);
});

await test('fallback: without the geometry module (iOS / other builds) the expo-ocr-kit blocks are read exactly as before', async () => {
  const blocks = await nativeOcrProbe('synthetic://no-camera', {
    geometryImpl: () => null,
    requireImpl: () => ({ recognizeText: async () => ({ text: 'hBP01-010', blocks: [{ text: 'hBP01-010', boundingBox: NUMBER }] }) }),
  });
  assert.deepEqual(blocks, [{ text: 'hBP01-010', box: NUMBER }]);
  const obs = observationsFromProbeText(blocks, findCardNumberTokens, W, H);
  assert.deepEqual(obs, [{ token: 'hbp01-010', box: { x: NUMBER.x / W, y: NUMBER.y / H, width: NUMBER.width / W, height: NUMBER.height / H } }]);
});

await test('fail-safe: a throwing geometry module falls back to expo-ocr-kit; both failing → no observations (the probe says nothing)', async () => {
  let b = await nativeOcrProbe('u', { geometryImpl: () => ({ recognizeGeometry: async () => { throw new Error('ml kit'); } }),
    requireImpl: () => ({ recognizeText: async () => ({ blocks: [{ text: 'hBP01-010', boundingBox: NUMBER }] }) }) });
  assert.equal(b.length, 1);
  b = await nativeOcrProbe('u', { geometryImpl: () => { throw new Error('missing'); }, requireImpl: () => { throw new Error('missing'); } });
  assert.deepEqual(b, []);
});

await test('tracked native module contract: autolinked Android module named HoloHunterOcrGeometry exporting blocks → lines → elements with boxes, same scaling as expo-ocr-kit', () => {
  const cfg = JSON.parse(fs.readFileSync(new URL('../modules/holohunter-ocr-geometry/expo-module.config.json', import.meta.url), 'utf8'));
  assert.deepEqual(cfg.platforms, ['android']);
  assert.deepEqual(cfg.android.modules, ['com.holohunter.ocrgeometry.HoloHunterOcrGeometryModule']);
  const kt = fs.readFileSync(new URL('../modules/holohunter-ocr-geometry/android/src/main/java/com/holohunter/ocrgeometry/HoloHunterOcrGeometryModule.kt', import.meta.url), 'utf8');
  assert.match(kt, /^package com\.holohunter\.ocrgeometry$/m);
  assert.match(kt, /class HoloHunterOcrGeometryModule : Module\(\)/);
  assert.match(kt, /Name\("HoloHunterOcrGeometry"\)/);
  assert.match(kt, /AsyncFunction\("recognizeGeometry"\)/);
  assert.match(kt, /"lines" to block\.lines\.map/);
  assert.match(kt, /"elements" to line\.elements\.map/);
  assert.match(kt, /"x" to rect\.left \* scale/);
  const ocrKit = fs.readFileSync(new URL('../node_modules/expo-ocr-kit/android/src/main/java/expo/modules/ocrkit/ExpoOcrKitModule.kt', import.meta.url), 'utf8');
  assert.match(ocrKit, /MAX_IMAGE_DIMENSION = 2000/);
  assert.match(kt, /MAX_IMAGE_DIMENSION = 2000/, 'same down-sampling as expo-ocr-kit → same coordinate space');
  const gradle = fs.readFileSync(new URL('../modules/holohunter-ocr-geometry/android/build.gradle', import.meta.url), 'utf8');
  assert.match(gradle, /com\.google\.mlkit:text-recognition:16\.0\.1/, 'same ML Kit artifact as expo-ocr-kit (no new SDK)');
  const js = fs.readFileSync(new URL('../src/services/nativeOcr.ts', import.meta.url), 'utf8');
  assert.match(js, /requireOptionalNativeModule\?\.\('HoloHunterOcrGeometry'\)/, 'JS loads the module by the native Name');
});

if ((process.exitCode ?? 0) === 0) console.log(`\n✅ scan-ocr-geometry: ${passed} checks passed`);
else console.error('\n❌ scan-ocr-geometry failed');
