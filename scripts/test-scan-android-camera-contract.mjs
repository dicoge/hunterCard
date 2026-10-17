#!/usr/bin/env node
/**
 * v42 (Android 41 user report: automatic scan "只會一直閃根本不會偵測"): pins the
 * INSTALLED native behaviour the scanner relies on, from the actual Android sources in
 * node_modules (no device, no camera). scripts/fixtures/native-camera-fixture.mjs models
 * exactly these rules for the ScanScreen render tests; if expo-camera / expo-ocr-kit
 * change, this test fails and the fixture must be re-checked.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../node_modules/${p}`, import.meta.url), 'utf8');
const camVersion = JSON.parse(read('expo-camera/package.json')).version;
const view = read('expo-camera/android/src/main/java/expo/modules/camera/ExpoCameraView.kt');
const mod = read('expo-camera/android/src/main/java/expo/modules/camera/CameraViewModule.kt');
const types = read('expo-camera/build/Camera.types.d.ts');
const ocr = read('expo-ocr-kit/android/src/main/java/expo/modules/ocrkit/ExpoOcrKitModule.kt');
const scan = fs.readFileSync(new URL('../src/screens/ScanScreen.tsx', import.meta.url), 'utf8');

let passed = 0;
const check = (label, fn) => { try { fn(); passed += 1; console.log(`  ✓ ${label}`); } catch (e) { process.exitCode = 1; console.error(`  ✗ ${label} — ${e.message}`); } };

check(`expo-camera ${camVersion}: every takePicture paints the whole view WHITE unless animateShutter is false (native default true)`, () => {
  assert.match(view, /var animateShutter: Boolean = true/);
  const cb = view.slice(view.indexOf('override fun onCaptureStarted'), view.indexOf('override fun onCaptureSuccess'));
  assert.match(cb, /if \(!animateShutter\) \{\s*return\s*\}/, 'only animateShutter=false skips it');
  assert.match(cb, /rootView\.foreground = Color\.WHITE/, 'white overlay on the root view');
  assert.match(mod, /Prop\("animateShutter"\) \{ view, animate: Boolean\? ->\s*view\.animateShutter = animate \?: true/);
  assert.match(types, /animateShutter\?: boolean;/, 'the JS CameraView accepts the prop');
});

check('the capture flash mode is the ImageCapture flash mode (flash="on" fires the LED on EVERY capture, probes included); changing it does not rebind the camera', () => {
  assert.match(view, /ImageCapture\.Builder\(\)[\s\S]{0,120}\.setFlashMode\(flashMode\.mapToLens\(\)\)/);
  const setter = view.slice(view.indexOf('var flashMode = FlashMode.OFF'), view.indexOf('var cameraMode'));
  assert.match(setter, /setCameraFlashMode\(value\)/);
  assert.ok(!/shouldCreateCamera = true/.test(setter), 'flash change = no rebind');
});

check('enableTorch is a continuous torch through CameraControl (no per-capture strobe), and the JS prop exists', () => {
  assert.match(view, /camera\?\.cameraControl\?\.enableTorch\(enabled\)/);
  assert.match(types, /enableTorch\?: boolean;/);
});

check('a pictureSize change marks the camera for re-creation (CameraX rebind = preview restart)', () => {
  const setter = view.slice(view.indexOf('var pictureSize: String = ""'), view.indexOf('var mirror'));
  assert.match(setter, /shouldCreateCamera = true/);
});

check('expo-ocr-kit (Android) returns ML Kit TEXT BLOCKS with boxes in source-image pixels (scaled back by the decode sample size)', () => {
  assert.match(ocr, /result\.textBlocks\.map/);
  assert.match(ocr, /"boundingBox" to rectToMap\(block\.boundingBox, scaleFactor\)/);
});

check('the native scanner uses the contract: no shutter animation; in automatic mode a torch instead of the capture flash', () => {
  const start = scan.search(/<CameraView\s*\n/);
  assert.ok(start > 0, 'native <CameraView> element found');
  const cam = scan.slice(start, scan.indexOf('<ScanOverlay', start));
  assert.match(cam, /animateShutter=\{false\}/);
  assert.match(cam, /flash=\{flash && !autoScanActive \? 'on' : 'off'\}/);
  assert.match(cam, /enableTorch=\{flash && autoScanActive\}/);
});

if ((process.exitCode ?? 0) === 0) console.log(`\n✅ scan-android-camera-contract: ${passed} checks passed`);
else console.error('\n❌ scan-android-camera-contract failed');
