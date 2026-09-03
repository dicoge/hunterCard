#!/usr/bin/env node
/**
 * DIC-1319 regression: the scan viewfinder is a focused primary path.
 *
 * The v21 closed-test report was "camera screen shows many unnecessary buttons
 * below the camera"; the product core is point at a card and get its price.
 * ScanOverlay used to render five controls in a row (torch, gallery, scan,
 * flip, manual search) plus an auto-scan mode toggle underneath — and the
 * auto-scan toggle was inert on Android, because the frame-stability loop that
 * backs it is web-only.
 *
 * What this test pins:
 *
 *   1. BEHAVIOURAL — ScanOverlay is really rendered through jsdom +
 *      react-native-web and the DOM is inspected. The viewfinder exposes
 *      exactly one primary scan action and exactly one secondary control (the
 *      torch, which is a framing aid for the card in hand). A regression that
 *      re-adds a control fails on the pressable count, not on a source regex.
 *
 *   2. COPY — the removed controls' strings are gone from the rendered tree AND
 *      from the locale bundles, so nothing can quietly resurrect them.
 *
 *   3. RECOVERY IS NOT WEAKENED — the whole point of the acceptance criterion
 *      is "no extra normal-flow buttons WITHOUT weakening permission/error
 *      recovery". Manual search must still be reachable from the scan-failure
 *      and low-confidence panels, and gallery import from the permission-denied
 *      and web-camera-unavailable fallbacks. Those are asserted on ScanScreen
 *      source because they live behind runtime states this harness cannot
 *      cheaply drive.
 *
 *   4. MUTATION SENSITIVITY — a positive control renders a deliberately
 *      "regressed" overlay with an extra control and proves the count
 *      assertion goes red for it.
 *
 * Run: node --import ./scripts/register-web-render.mjs scripts/test-scan-primary-path.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// jsdom + react globals must exist before react-dom/client is imported.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://holohunter.dicoge.com/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key in globalThis) continue;
  try { globalThis[key] = dom.window[key]; } catch { /* read-only */ }
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Animated, TouchableOpacity, Text, View } = await import('react-native');

const { default: ScanOverlay } = await import('../src/components/ScanOverlay.tsx');
const { zh, ja } = await import('../src/i18n/index.ts');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function renderInto(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function overlayElement(overrides = {}) {
  return React.createElement(ScanOverlay, {
    scanLineAnim: new Animated.Value(0),
    pulseAnim: new Animated.Value(1),
    borderAnim: new Animated.Value(0),
    isScanning: false,
    flash: false,
    autoScanActive: false,
    isCameraReady: true,
    cameraError: null,
    onFlash: () => {},
    onScan: () => {},
    onRetry: () => {},
    ...overrides,
  });
}

// react-native-web renders Touchables as elements carrying the testID as
// data-testid and an interactive role. Counting pressables inside the control
// row is what makes "one clear scan action" checkable rather than aspirational.
function controlRow(container) {
  const row = container.querySelector('[data-testid="scan-primary-controls"]');
  assert.ok(row, 'scan-primary-controls row must exist in the rendered overlay');
  return row;
}
// Count FOCUSABLE elements, not just role="button". react-native-web only emits
// role="button" when a Touchable declares accessibilityRole — the controls this
// task removed did not — so counting roles alone would let a re-added
// unlabelled control slip through. Every Touchable does get tabindex, so the
// union of the two catches both spellings.
function pressablesIn(node) {
  return Array.from(new Set([
    ...node.querySelectorAll('[role="button"]'),
    ...node.querySelectorAll('[tabindex]'),
  ]));
}

// ── 1. Exactly one primary action, one secondary control ──────────────────────
{
  const { container, cleanup } = await renderInto(overlayElement());
  try {
    const row = controlRow(container);

    await test('viewfinder exposes exactly one primary scan action', () => {
      const primaries = container.querySelectorAll('[data-testid="scan-primary-action"]');
      assert.equal(primaries.length, 1, `expected 1 primary scan action, got ${primaries.length}`);
    });

    await test('viewfinder control row holds exactly two pressables (torch + scan)', () => {
      const buttons = pressablesIn(row);
      assert.equal(
        buttons.length,
        2,
        `expected torch + scan only, got ${buttons.length}: ${buttons.map((b) => b.textContent).join(' | ')}`,
      );
    });

    await test('the torch is the only secondary control and is present for low-light framing', () => {
      assert.equal(container.querySelectorAll('[data-testid="scan-flash-toggle"]').length, 1);
    });

    await test('removed controls (gallery / flip / manual search / auto-scan toggle) render nothing', () => {
      const text = container.textContent || '';
      for (const gone of ['相簿', '翻轉', '自動掃描', '手動模式']) {
        assert.ok(!text.includes(gone), `viewfinder must not render "${gone}" — got: ${text}`);
      }
      // 搜尋 is the manual-search control's label (common_search). The frame
      // hint copy does not contain it, so a bare substring check is safe here.
      assert.ok(!text.includes(zh.common_search), `viewfinder must not render "${zh.common_search}"`);
    });

    await test('the primary action still carries its own label so it reads as the one action', () => {
      const primary = container.querySelector('[data-testid="scan-primary-action"]');
      assert.ok(primary.textContent && primary.textContent.trim().length > 0);
    });
  } finally {
    await cleanup();
  }
}

// ── 2. Scanning state still reports recognition progress ─────────────────────
{
  const { container, cleanup } = await renderInto(overlayElement({ isScanning: true }));
  try {
    await test('recognition state is surfaced while scanning (primary path feedback)', () => {
      assert.ok((container.textContent || '').includes(zh.scan_recognizing));
    });
    await test('the primary action is disabled mid-scan so it cannot double-fire', () => {
      const primary = container.querySelector('[data-testid="scan-primary-action"]');
      // react-native-web reflects `disabled` on the pressable.
      assert.ok(
        primary.getAttribute('aria-disabled') === 'true' || primary.hasAttribute('disabled'),
        'primary scan action must be disabled while isScanning',
      );
    });
  } finally {
    await cleanup();
  }
}

// ── 3. Auto-scan copy tells the truth per platform ───────────────────────────
{
  const off = await renderInto(overlayElement({ autoScanActive: false }));
  const on = await renderInto(overlayElement({ autoScanActive: true }));
  try {
    await test('frame hint distinguishes auto-scan active from manual (no false Android promise)', () => {
      const offText = off.container.textContent || '';
      const onText = on.container.textContent || '';
      assert.ok(offText.includes(zh.scan_frame_manual), 'inactive auto-scan must use the manual hint');
      assert.ok(onText.includes(zh.scan_frame_auto), 'active auto-scan must use the auto hint');
      assert.notEqual(offText, onText, 'the two hints must actually differ');
    });
  } finally {
    await off.cleanup();
    await on.cleanup();
  }
}

// ── 4. The overlay no longer accepts the removed callbacks ───────────────────
const overlaySource = read('src/components/ScanOverlay.tsx');
await test('ScanOverlayProps no longer declares onGallery / onFlip / onManualSearch / onToggleAutoScan', () => {
  for (const prop of ['onGallery', 'onFlip', 'onManualSearch', 'onToggleAutoScan']) {
    assert.ok(
      !overlaySource.includes(prop),
      `${prop} must be gone from ScanOverlay — a live prop is a control waiting to be re-rendered`,
    );
  }
});

// ── 5. Locale bundles dropped the orphaned control copy ──────────────────────
await test('orphaned control copy is deleted from both zh and ja bundles', () => {
  for (const key of ['scan_gallery', 'scan_flip', 'scan_auto_mode', 'scan_manual_mode']) {
    assert.ok(!(key in zh), `zh still defines removed key ${key}`);
    assert.ok(!(key in ja), `ja still defines removed key ${key}`);
  }
});

// ── 6. Recovery paths are NOT weakened ───────────────────────────────────────
const scanScreenSource = read('src/screens/ScanScreen.tsx');
await test('manual search stays reachable from the scan-failure panel', () => {
  assert.match(
    scanScreenSource,
    /scanError\s*&&[\s\S]*?setShowSearch\(true\)[\s\S]*?scan_manual_search/,
    'the OCR-empty error panel must still offer manual search',
  );
});
await test('manual search stays reachable from the low-confidence candidate selector', () => {
  assert.match(
    scanScreenSource,
    /<ScanCandidateSelector[\s\S]*?onManualSearch=\{[^}]*setShowSearch\(true\)/,
    'the candidate selector must still hand off to manual search',
  );
});
await test('the manual search modal is still mounted (its entry points are not dead ends)', () => {
  assert.match(scanScreenSource, /<Modal[\s\S]*?onRequestClose=\{\(\)\s*=>\s*setShowSearch\(false\)\}/);
});
await test('gallery import stays reachable from the camera-permission / web fallback paths', () => {
  const galleryCallSites = scanScreenSource.match(/pickFromGallery/g) || [];
  // definition + permission-denied fallback + web gallery-mode screen
  assert.ok(
    galleryCallSites.length >= 3,
    `expected the gallery fallback to survive outside the viewfinder, found ${galleryCallSites.length} references`,
  );
  assert.match(
    scanScreenSource,
    /webGalleryMode\s*\?\s*\([\s\S]*?onPress=\{pickFromGallery\}/,
    'the web camera-unavailable fallback must still offer gallery import',
  );
});
await test('camera error retry is still wired from the overlay', () => {
  assert.match(scanScreenSource, /onRetry=\{\(\)\s*=>\s*\{[\s\S]*?setCameraError\(null\)/);
});

// ── 7. Auto-scan is platform-driven, not a user-facing dead toggle ───────────
await test('auto-scan activity is derived from the platform, not from a mode switch', () => {
  assert.match(
    scanScreenSource,
    /const autoScanActive = isWeb;/,
    'autoScanActive must be platform-derived so Android never advertises an auto capture it cannot do',
  );
  assert.ok(
    !/setAutoScanEnabled/.test(scanScreenSource),
    'the auto-scan mode setter must be gone with its toggle',
  );
});

// ── 8. Mutation sensitivity: the pressable count really can go red ───────────
await test('mutation: an overlay with a third control fails the two-pressable assertion', async () => {
  function RegressedOverlay() {
    return React.createElement(
      View,
      { 'data-testid': 'scan-primary-controls', testID: 'scan-primary-controls' },
      React.createElement(TouchableOpacity, { testID: 'scan-flash-toggle', accessibilityRole: 'button' },
        React.createElement(Text, null, '💡')),
      React.createElement(TouchableOpacity, { testID: 'scan-primary-action', accessibilityRole: 'button' },
        React.createElement(Text, null, '📷')),
      // Deliberately WITHOUT accessibilityRole — this is how the removed
      // controls were actually written, so it is the regression shape the
      // counter has to catch.
      React.createElement(TouchableOpacity, { testID: 'scan-gallery' },
        React.createElement(Text, null, '🖼️')),
    );
  }
  const { container, cleanup } = await renderInto(React.createElement(RegressedOverlay));
  try {
    const buttons = pressablesIn(controlRow(container));
    assert.equal(buttons.length, 3, 'positive control must really render three pressables');
    assert.throws(
      () => assert.equal(buttons.length, 2),
      'the two-pressable assertion must reject the regressed overlay',
    );
  } finally {
    await cleanup();
  }
});

// ── 9. CI actually runs this ─────────────────────────────────────────────────
await test('CI executes the scan primary-path regression', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.ok(ci.includes('test:scan-primary-path'), 'ci.yml must run npm run test:scan-primary-path');
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.scripts['test:scan-primary-path'], 'package.json must define test:scan-primary-path');
});

console.log(`\n✅ Scan primary-path regression: ${passed} assertions passed`);
