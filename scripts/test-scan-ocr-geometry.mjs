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
  assert.deepEqual(cfg.android.modules, ['com.holohunter.ocrgeometry.HoloHunterOcrGeometryModule', 'com.holohunter.ocrgeometry.HoloHunterCardScannerModule']);
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

await test('tracked native FRAME-SCANNER contract (v42 CR): CameraX preview + ImageAnalysis (keep-only-latest, one frame in ML Kit, bounded interval, active gate), still only on request, deterministic release', () => {
  const dir = '../modules/holohunter-ocr-geometry/android/src/main/java/com/holohunter/ocrgeometry/';
  const mod = fs.readFileSync(new URL(dir + 'HoloHunterCardScannerModule.kt', import.meta.url), 'utf8');
  const view = fs.readFileSync(new URL(dir + 'HoloHunterCardScannerView.kt', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../src/services/nativeCardScanner.ts', import.meta.url), 'utf8');
  assert.match(mod, /Name\("HoloHunterCardScanner"\)/);
  assert.match(js, /NATIVE_CARD_SCANNER = 'HoloHunterCardScanner'/, 'JS loads the same native name');
  assert.match(mod, /Events\("onCameraReady", "onMountError", "onFrameText"\)/);
  for (const prop of ['active', 'session', 'torch', 'analysisIntervalMs']) assert.match(mod, new RegExp(`Prop\\("${prop}"\\)`));
  assert.match(mod, /OnViewDestroys \{ view: HoloHunterCardScannerView ->\s*view\.release\(\)/);
  assert.match(mod, /AsyncFunction\("takePicture"\)/);
  // continuous preview, cover-fit like the screen's crop mapping; 4:3 preview AND analysis
  assert.match(view, /scaleType = PreviewView\.ScaleType\.FILL_CENTER/);
  assert.match(view, /RATIO_4_3_FALLBACK_AUTO_STRATEGY/);
  assert.match(view, /AspectRatioStrategy\(AspectRatio\.RATIO_4_3/);
  // backpressure + bounded sampling + active gate, frame closed on every path
  assert.match(view, /setBackpressureStrategy\(ImageAnalysis\.STRATEGY_KEEP_ONLY_LATEST\)/);
  assert.match(view, /if \(released \|\| failed \|\| !analysisActive \|\| inFlight \|\| now - lastAnalysedAt < intervalMs\) \{\s*proxy\.close\(\)/);
  assert.match(view, /coerceIn\(MIN_INTERVAL_MS, MAX_INTERVAL_MS\)/);
  // v44: the frame is reduced synchronously and closed on every path; one delivery pending
  assert.match(view, /CardFrameLuma\.sample\(plane\.buffer, plane\.rowStride, plane\.pixelStride, crop, rotation\)[\s\S]{0,120}\} finally \{\s*proxy\.close\(\)\s*\}/);
  assert.match(view, /inFlight = true\s*ContextCompat\.getMainExecutor\(context\)\.execute \{\s*inFlight = false/);
  // CR fea33de P2: ownership of an analysis = the session + generation it STARTED in
  assert.match(view, /val startSession = session\s*val startGeneration = generation/);
  assert.match(view, /if \(!released && (?:!failed && )?analysisActive && startSession == session && startGeneration == generation\) \{\s*onFrameText\(/,
    'a completion from before a deactivate/reactivate or session change is not delivered');
  assert.match(view, /fun setAnalysisActive\(active: Boolean\) \{[\s\S]{0,120}if \(next != analysisActive\) \{\s*generation \+= 1/, 'every on/off transition voids in-flight work');
  assert.match(view, /fun setSession\(value: Int\) \{[\s\S]{0,80}generation \+= 1/);
  assert.match(view, /"session" to startSession/);
  // CR fea33de geometry: one field of view for preview / analysis / still
  assert.match(view, /val viewPort = previewView\.viewPort/);
  assert.match(view, /UseCaseGroup\.Builder\(\)\s*\.setViewPort\(viewPort\)\s*\.addUseCase\(previewUseCase\)\s*\.addUseCase\(captureUseCase\)\s*\.addUseCase\(analysisUseCase\)/);
  assert.match(view, /bindToLifecycle\(owner, CameraSelector\.DEFAULT_BACK_CAMERA, group\)/);
  for (const field of ['"rotation" to rotation', '"bufferWidth" to bufferWidth', '"bufferHeight" to bufferHeight', '"cropRect" to mapOf']) assert.ok(view.includes(field), field);
  assert.match(view, /val crop = Rect\(proxy\.cropRect\)/);
  assert.match(view, /crop = Rect\(image\.cropRect\)/, 'the still uses the view-port crop of its own capture');
  assert.match(view, /Bitmap\.createBitmap\(decoded, left, top, cw, ch, matrix, true\)/, 'still cropped to the visible rect and rotated upright');
  // v44: preview frames → a luminance grid for the card-region detector; no text reader
  // on preview frames (the card number is read from the one still only)
  assert.ok(view.includes('"luma" to mapOf("width" to grid.width, "height" to grid.height, "data" to grid.data.toList())'));
  assert.ok(!/InputImage|TextRecognition|mapBlocks/.test(view), 'no ML Kit text reading of preview frames');
  const analyze = view.slice(view.indexOf('private fun analyze'), view.indexOf('fun takePicture'));
  assert.ok(!/takePicture|FileOutputStream/.test(analyze), 'frame analysis never captures a still or writes a file');
  // the still: only through takePicture, flash off (the light is the torch)
  assert.match(view, /setFlashMode\(ImageCapture\.FLASH_MODE_OFF\)/);
  assert.match(view, /cameraControl\.enableTorch/);
  // CR fea33de P2: pending captures settled exactly once; proxy always closed; no orphan file
  assert.match(view, /private class PendingCapture[\s\S]{0,400}settled\.compareAndSet\(false, true\)/);
  assert.match(view, /pendingCaptures\.add\(pending\)/);
  assert.match(view, /\} finally \{\s*image\.close\(\)\s*\}/, 'ImageProxy closed on every path');
  assert.match(view, /ioExecutor\.execute \{ process\(pending, data, rotation, visible, quality, base64\) \}/, 'JPEG work not on the cancellable scope');
  assert.match(view, /if \(!pending\.resolve\(result\)\) pending\.file\?\.delete\(\)/, 'a file for a released capture is deleted');
  assert.match(view, /catch \(e: Exception\) \{\s*pending\.file\?\.delete\(\)\s*pending\.reject\(/);
  assert.match(view, /override fun onError\(exception: ImageCaptureException\) \{\s*pending\.reject\(/);
  // deterministic release
  const release = view.slice(view.indexOf('fun release()'));
  for (const step of ['released = true', 'analysisActive = false', 'generation += 1', 'pending.reject("E_CAMERA_RELEASED"', 'clearAnalyzer()', 'cameraProvider?.unbind(', 'analysisExecutor.shutdown()', 'ioExecutor.shutdown()', 'scope.cancel()']) {
    assert.ok(release.includes(step), `release: ${step}`);
  }
  assert.ok(release.indexOf('pending.reject') < release.indexOf('scope.cancel()'), 'pending captures settled before the scope is cancelled');
  const gradle = fs.readFileSync(new URL('../modules/holohunter-ocr-geometry/android/build.gradle', import.meta.url), 'utf8');
  const cameraGradle = fs.readFileSync(new URL('../node_modules/expo-camera/android/build.gradle', import.meta.url), 'utf8');
  const v = /camerax_version = "([^"]+)"/.exec(cameraGradle)[1];
  assert.match(gradle, new RegExp(`camerax_version = "${v.replace(/\./g, '\\.')}"`), `same CameraX ${v} as expo-camera`);
});

await test('v43 preview LAYOUT contract (user device: automatic scan showed no camera): the preview surface CameraX adds after binding is laid out by the view itself; ready = preview STREAMING, not camera OPEN', () => {
  const view = fs.readFileSync(new URL('../modules/holohunter-ocr-geometry/android/src/main/java/com/holohunter/ocrgeometry/HoloHunterCardScannerView.kt', import.meta.url), 'utf8');
  const rnGroup = fs.readFileSync(new URL('../node_modules/react-native/ReactAndroid/src/main/java/com/facebook/react/views/view/ReactViewGroup.kt', import.meta.url), 'utf8');
  const expoCamera = fs.readFileSync(new URL('../node_modules/expo-camera/android/src/main/java/expo/modules/camera/ExpoCameraView.kt', import.meta.url), 'utf8');
  // Why: the installed React Native swallows requestLayout(), and the working expo-camera view
  // lays its PreviewView children out on hierarchy change for exactly that reason.
  assert.match(rnGroup, /override fun requestLayout\(\) \{\s*\/\/ No-op/, 'premise: RN parents swallow requestLayout()');
  assert.match(expoCamera, /setOnHierarchyChangeListener[\s\S]{0,300}onChildViewAdded[\s\S]{0,200}measure\([\s\S]{0,200}layout\(/, 'reference: expo-camera lays out the surface child');
  assert.match(view, /previewView\.setOnHierarchyChangeListener\([\s\S]{0,200}onChildViewAdded\([^)]*\) = layoutPreview\(\)/, 'the surface child CameraX adds is laid out');
  const lp = /private fun layoutPreview\(\) \{([\s\S]*?)\n  \}/.exec(view)?.[1] ?? '';
  assert.match(lp, /previewView\.measure\([\s\S]*EXACTLY[\s\S]*EXACTLY/, 'measured EXACTLY to the view size');
  assert.match(lp, /previewView\.layout\(0, 0, w, h\)/, 'laid out to the view size');
  assert.match(view, /addView\(previewView, ViewGroup\.LayoutParams\(ViewGroup\.LayoutParams\.MATCH_PARENT, ViewGroup\.LayoutParams\.MATCH_PARENT\)\)/);
  assert.match(view, /override val shouldUseAndroidLayout: Boolean = true/, 'requestLayout() from the surface re-runs measure + layout');
  const onLayout = /override fun onLayout\([\s\S]*?\n  \}/.exec(view)?.[0] ?? '';
  assert.match(onLayout, /layoutPreview\(\)/);
  const bind = /private fun startBind\(\) \{([\s\S]*?)\n  \}\n/.exec(view)?.[1] ?? '';
  assert.match(bind, /bindToLifecycle[\s\S]*layoutPreview\(\)/, 'laid out again right after binding');
  assert.match(bind, /previewView\.previewStreamState\.observe\(owner\)[\s\S]{0,200}StreamState\.STREAMING[\s\S]{0,120}onCameraReady/, 'ready only when the preview streams');
  assert.ok(!/CameraState\.Type\.OPEN[\s\S]{0,120}onCameraReady/.test(bind), 'an opened camera alone is not "ready"');
  assert.match(bind, /ErrorType\.CRITICAL\) fail\(/, 'a critical camera error is terminal (fail)');
  const analyze = /private fun analyze\(proxy: ImageProxy\) \{([\s\S]*?)\n  \}\n/.exec(view)?.[1] ?? '';
  assert.ok(!/takePicture/.test(analyze), 'still: never from analysis');
});

await test('CR c5acd45 native FAILURE contract: a CRITICAL camera error before OR after STREAMING is reported once and latched — no ready, frame or still from that view afterwards', () => {
  const view = fs.readFileSync(new URL('../modules/holohunter-ocr-geometry/android/src/main/java/com/holohunter/ocrgeometry/HoloHunterCardScannerView.kt', import.meta.url), 'utf8');
  const bind = /private fun startBind\(\) \{([\s\S]*?)\n  \}\n/.exec(view)?.[1] ?? '';
  const observer = /cameraInfo\.cameraState\.observe\(owner\) \{([\s\S]*?)\n        \}/.exec(bind)?.[1] ?? '';
  assert.ok(observer, 'camera-state observer found');
  assert.match(observer, /error\.type == CameraState\.ErrorType\.CRITICAL\) fail\(/);
  assert.ok(!/readySent/.test(observer), 'not limited to before the first STREAMING');
  assert.match(bind, /catch \(e: Exception\) \{\s*fail\(/, 'bind exceptions take the same path');
  const fail = /private fun fail\(message: String\) \{([\s\S]*?)\n  \}/.exec(view)?.[1] ?? '';
  assert.match(fail, /if \(released \|\| errorSent\) return\s*errorSent = true\s*failed = true/, 'once, then latched');
  assert.match(fail, /analysisActive = false/);
  assert.match(fail, /generation \+= 1/, 'analyses in flight are void');
  assert.match(fail, /pending\.reject\("E_CAMERA_FAILED"/, 'pending stills settled');
  assert.ok(fail.indexOf('pending.reject') < fail.indexOf('onMountError'), 'settled before JS hears about it');
  assert.match(view, /StreamState\.STREAMING && !readySent && !released && !failed/, 'no ready after a failure');
  assert.match(view, /val next = active && !released && !failed/, 'analysis cannot be re-enabled on the failed view');
  const analyze = /private fun analyze\(proxy: ImageProxy\) \{([\s\S]*?)\n  \}\n/.exec(view)?.[1] ?? '';
  assert.match(analyze, /if \(released \|\| failed \|\| !analysisActive/, 'no new analysis');
  assert.match(analyze, /if \(!released && !failed && analysisActive && startSession == session && startGeneration == generation\)/, 'no delivery of one in flight');
  assert.match(view, /if \(released \|\| failed \|\| capture == null\) \{\s*pending\.reject\("E_CAMERA_NOT_READY"/, 'no still');
});

await test('v44 CardFrameLuma.kt follows the JS reference sampler (lumaGridFromRgba): same grid size rule, 2×2 points per cell, rotation inverse = frameGeometry convention', async () => {
  const kt = fs.readFileSync(new URL('../modules/holohunter-ocr-geometry/android/src/main/java/com/holohunter/ocrgeometry/CardFrameLuma.kt', import.meta.url), 'utf8');
  const ts = fs.readFileSync(new URL('../src/utils/cardRegionDetector.ts', import.meta.url), 'utf8');
  const { LUMA_GRID_LONG_SIDE } = await import('../src/utils/cardRegionDetector.ts');
  assert.match(kt, new RegExp(`const val LONG_SIDE = ${LUMA_GRID_LONG_SIDE}\\b`));
  assert.match(kt, /gh = max\(1, \(LONG_SIDE\.toDouble\(\) \* visH \/ visW\)\.roundToInt\(\)\)/);
  assert.match(ts, /Math\.max\(1, Math\.round\(LUMA_GRID_LONG_SIDE \* visibleHeight \/ visibleWidth\)\)/);
  assert.match(kt, /\(gx \+ \(sx \+ 0\.5\) \/ 2\.0\) \* visW \/ gw/);
  assert.match(ts, /\(gx \+ \(sx \+ 0\.5\) \/ 2\) \* width\) \/ gw/);
  assert.match(kt, /90 -> \{ bx = v; by = ch - 1 - u \}/);
  assert.match(kt, /180 -> \{ bx = cw - 1 - u; by = ch - 1 - v \}/);
  assert.match(kt, /270 -> \{ bx = cw - 1 - v; by = u \}/);
  assert.match(kt, /out\[gy \* gw \+ gx\] = sum shr 2/);
  assert.match(kt, /val visW = if \(rotation % 180 == 0\) cw else ch/);
});

if ((process.exitCode ?? 0) === 0) console.log(`\n✅ scan-ocr-geometry: ${passed} checks passed`);
else console.error('\n❌ scan-ocr-geometry failed');
