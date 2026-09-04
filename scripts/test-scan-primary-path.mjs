#!/usr/bin/env node
/**
 * DIC-1319 (primary path) + DIC-1336 (native gallery reachability) regression.
 *
 * The v21 report was "camera screen shows many unnecessary buttons"; the
 * product core is point at a card and get its price. The overlay used to
 * render torch + gallery + scan + flip + manual search plus an auto-scan mode
 * toggle underneath — the toggle was inert on Android to begin with because
 * the frame-stability loop that backs it is web-only. Flip / manual search /
 * auto-scan toggle went away, and manual search still lives on the
 * scan-failure and low-confidence recovery panels.
 *
 * DIC-1332 (release-like Android QA) then found the follow-on defect: the
 * shipped APK had NO reachable gallery scan path. Both `pickFromGallery`
 * invocation sites in ScanScreen were gated by `isWeb`, so on native the
 * gallery button did not exist — not in the viewfinder, not on the
 * permission-denied screen, not on the camera-unavailable fallback. The
 * previous version of THIS test asserted `>= 3 pickFromGallery references in
 * the ScanScreen source`, which was true even when every reference was under
 * `isWeb` and therefore unreachable at runtime on Android. That is the
 * false-green this rewrite exists to prevent.
 *
 * What this test now pins BEHAVIOURALLY, in a real DOM render:
 *
 *   1. Viewfinder exposes exactly ONE primary scan action, exactly ONE torch
 *      (framing aid), and exactly ONE gallery entry (DIC-1336). No
 *      developer/session controls (flip, auto-scan toggle, manual search)
 *      may re-appear in the viewfinder.
 *
 *   2. The gallery button is wired: rendering ScanOverlay with an `onGallery`
 *      spy and clicking `data-testid="scan-gallery-action"` fires it exactly
 *      once. A regression that gates the button behind `isWeb`, drops the
 *      prop, or renders it disabled by default fails this assertion. The
 *      overlay accepts NO `isWeb` prop and MUST NOT branch on the platform
 *      when deciding to render the gallery control.
 *
 *   3. `CameraPermissionDeniedView` — the ONLY thing rendered when Android
 *      CAMERA permission is denied — accepts an `onPickGallery` prop and
 *      renders a `data-testid="camera-permission-pick-gallery"` button that
 *      fires it. Present with canAskAgain=true AND canAskAgain=false. A
 *      regression that drops the prop or hides the button behind a platform
 *      gate fails this assertion.
 *
 *   4. `ScanScreen` wires `pickFromGallery` into BOTH the overlay (native and
 *      web CameraView legs) and the permission-denied view — no isWeb gate
 *      on either. This is the source-level guarantee that the behavioural
 *      renders above exercise the same wiring the shipped bundle carries.
 *
 *   5. `pickFromGallery`'s success branch routes through `handleRecognized`
 *      with `isAmbiguousPrinting` classification (DIC-1325 invariant) — a
 *      new native entry point must not bypass the safe recognition decision
 *      point.
 *
 *   6. Recovery paths remain: manual search stays on the scan-error /
 *      candidate-selector panels; camera retry stays on the overlay error
 *      state.
 *
 *   7. Mutation controls: a regressed overlay that omits the gallery
 *      control, and a regressed permission-denied view that omits the
 *      gallery button, both fail their respective render assertions.
 *
 *   8. Positive control: an overlay with an extra fourth control fails the
 *      three-pressable assertion.
 *
 *   9. Locale bundles still have no orphan copy for the truly-removed
 *      controls (flip / auto-scan toggle / auto-mode / manual-mode).
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
const { default: CameraPermissionDeniedView } = await import('../src/components/CameraPermissionDeniedView.tsx');
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
    onGallery: () => {},
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

// ── 1. Exactly one primary action, one torch, one gallery ────────────────────
{
  const { container, cleanup } = await renderInto(overlayElement());
  try {
    const row = controlRow(container);

    await test('viewfinder exposes exactly one primary scan action', () => {
      const primaries = container.querySelectorAll('[data-testid="scan-primary-action"]');
      assert.equal(primaries.length, 1, `expected 1 primary scan action, got ${primaries.length}`);
    });

    await test('viewfinder control row holds exactly three pressables (torch + scan + gallery)', () => {
      const buttons = pressablesIn(row);
      assert.equal(
        buttons.length,
        3,
        `expected torch + scan + gallery only, got ${buttons.length}: ${buttons.map((b) => b.textContent).join(' | ')}`,
      );
    });

    await test('the torch is present as a framing aid', () => {
      assert.equal(container.querySelectorAll('[data-testid="scan-flash-toggle"]').length, 1);
    });

    await test('the gallery entry is present in the viewfinder (DIC-1336 native reachability)', () => {
      const gallery = container.querySelector('[data-testid="scan-gallery-action"]');
      assert.ok(gallery, 'scan-gallery-action must render — the shipped APK previously had no reachable gallery scan path');
    });

    await test('removed controls (flip / auto-scan toggle / manual search) render nothing', () => {
      const text = container.textContent || '';
      for (const gone of ['翻轉', '自動掃描', '手動模式']) {
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

// ── 1b. Gallery click really fires the wired callback ────────────────────────
await test('viewfinder gallery button click invokes onGallery exactly once (native reachability)', async () => {
  let calls = 0;
  const { container, cleanup } = await renderInto(overlayElement({
    onGallery: () => { calls += 1; },
  }));
  try {
    const btn = container.querySelector('[data-testid="scan-gallery-action"]');
    assert.ok(btn, 'scan-gallery-action must render even when no platform prop is passed');
    await act(async () => { btn.click(); });
    assert.equal(calls, 1, 'clicking the gallery action must invoke onGallery once');
  } finally {
    await cleanup();
  }
});

// ── 1c. Overlay MUST NOT branch on `isWeb`; gallery is unconditional ─────────
await test('ScanOverlay renders the gallery control unconditionally (no isWeb / Platform.OS branch)', () => {
  const src = read('src/components/ScanOverlay.tsx');
  // Comments are stripped so header text discussing DIC-1319 / DIC-1336 is
  // not counted as a live branch.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert.ok(
    !/Platform\.OS/.test(code),
    'ScanOverlay must not read Platform.OS — the overlay renders the same three controls on every platform',
  );
  assert.ok(
    !/\bisWeb\b/.test(code),
    'ScanOverlay must not branch on isWeb; the gallery control must not be platform-gated',
  );
  assert.match(
    code,
    /testID=["']scan-gallery-action["']/, // JSX literal for the gallery control
    'ScanOverlay must render scan-gallery-action',
  );
});

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
await test('ScanOverlayProps no longer declares onFlip / onManualSearch / onToggleAutoScan', () => {
  for (const prop of ['onFlip', 'onManualSearch', 'onToggleAutoScan']) {
    assert.ok(
      !overlaySource.includes(prop),
      `${prop} must be gone from ScanOverlay — a live prop is a control waiting to be re-rendered`,
    );
  }
});

await test('ScanOverlay declares onGallery as part of its callback contract', () => {
  assert.match(
    overlaySource,
    /onGallery:\s*\(\)\s*=>\s*void/,
    'onGallery must be a declared, required callback so the wiring cannot silently drop',
  );
});

// ── 5. Locale bundles dropped the orphaned control copy ──────────────────────
await test('orphaned control copy is deleted from both zh and ja bundles', () => {
  // scan_use_gallery / scan_gallery_action are legitimate DIC-1336 gallery
  // copy and MUST exist; only the fully-removed control keys must be gone.
  for (const key of ['scan_flip', 'scan_auto_mode', 'scan_manual_mode']) {
    assert.ok(!(key in zh), `zh still defines removed key ${key}`);
    assert.ok(!(key in ja), `ja still defines removed key ${key}`);
  }
});

await test('the DIC-1336 gallery-action label exists in both locales', () => {
  assert.ok(typeof zh.scan_gallery_action === 'string' && zh.scan_gallery_action.length > 0);
  assert.ok(typeof ja.scan_gallery_action === 'string' && ja.scan_gallery_action.length > 0);
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

// ── 8. ScanScreen wires pickFromGallery into every reachable native surface ──
// This is the source-level guarantee that behavioural tests (§ 1b, § 9) cover
// the same wiring the shipped bundle carries. It is intentionally NOT a raw
// call-site counter (the DIC-1332 defect passed the old counter because every
// reference was under `isWeb`); it is a shape assertion on THREE required
// wires that must be present WITHOUT an `isWeb` guard.
// Anchor the block search on the JSX opener `<CameraView\n` (a real JSX
// element start with a newline after — the `useRef<CameraView>(null)` at the
// top of the file uses `<CameraView>` on a single line and would otherwise
// be the first match and drag the whole component into the "block".
function jsxBlock(source, tag) {
  const openRe = new RegExp(`<${tag}\\s*\\n`);
  const openMatch = openRe.exec(source);
  if (!openMatch) return null;
  const closeIdx = source.indexOf(`</${tag}>`, openMatch.index);
  if (closeIdx === -1) return null;
  return source.slice(openMatch.index, closeIdx);
}

await test('ScanScreen wires pickFromGallery into ScanOverlay via onGallery (native CameraView leg)', () => {
  const block = jsxBlock(scanScreenSource, 'CameraView');
  assert.ok(block, 'ScanScreen must render a <CameraView> JSX element');
  assert.match(
    block,
    /onGallery=\{pickFromGallery\}/,
    'native <CameraView> ScanOverlay must receive onGallery={pickFromGallery} unconditionally',
  );
  // No conditional wrapping the ScanOverlay's onGallery prop. Compressing
  // whitespace makes a same-line `isWeb ?` before the prop syntactically
  // detectable without dragging in other unrelated ternaries in the block.
  const flat = block.replace(/\s+/g, ' ');
  assert.ok(
    !/(?:isWeb|Platform\.OS[^&|]*?)\s*\?[^:]*?onGallery=\{pickFromGallery\}/.test(flat),
    'onGallery on the native leg must not be wrapped in a platform ternary',
  );
});

await test('ScanScreen wires pickFromGallery into ScanOverlay via onGallery (web WebCamera leg)', () => {
  const block = jsxBlock(scanScreenSource, 'WebCamera');
  assert.ok(block, 'ScanScreen must render a <WebCamera> JSX element');
  assert.match(
    block,
    /onGallery=\{pickFromGallery\}/,
    'web <WebCamera> ScanOverlay must receive onGallery={pickFromGallery}',
  );
});

await test('ScanScreen wires pickFromGallery into CameraPermissionDeniedView (native fallback)', () => {
  // The denied view is the ONLY thing rendered when Android CAMERA is denied.
  // Without this wire, a denied user has zero scan paths on native.
  assert.match(
    scanScreenSource,
    /<CameraPermissionDeniedView[\s\S]*?onPickGallery=\{pickFromGallery\}/,
    'CameraPermissionDeniedView must receive onPickGallery={pickFromGallery} so denial does not become a dead end',
  );
});

await test('the gallery success branch routes through handleRecognized with ambiguity classification', () => {
  // Guards the DIC-1325 invariant on the SAME entry point this task promotes
  // to native reachability. A new native entry point that bypasses the safe
  // recognition decision point fails here.
  const code = scanScreenSource
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const successIdx = code.indexOf('galleryVisionResult.success');
  const lowConfIdx = code.indexOf('galleryVisionResult.lowConfidence');
  assert.ok(successIdx !== -1 && lowConfIdx !== -1 && successIdx < lowConfIdx,
    'pickFromGallery must still have the success branch before its lowConfidence branch (regression fixture)');
  const branch = code.slice(successIdx, lowConfIdx);
  assert.ok(!branch.includes('commitCard('),
    'the gallery success branch must not call commitCard directly (DIC-1325)');
  assert.match(branch, /handleRecognized\(/,
    'the gallery success branch must route through handleRecognized');
  assert.match(branch, /isAmbiguousPrinting\(galleryVisionResult\)/,
    'the gallery success branch must classify the result on the way');
});

// ── 9. CameraPermissionDeniedView exposes the gallery entry ─────────────────
// Rendered behaviourally on both canAskAgain=true and canAskAgain=false so a
// regression that hides the button on either state fails.
for (const canAskAgain of [true, false]) {
  await test(`permission-denied view exposes gallery when canAskAgain=${canAskAgain} (native reachability)`, async () => {
    let calls = 0;
    const { container, cleanup } = await renderInto(
      React.createElement(CameraPermissionDeniedView, {
        permission: { granted: false, canAskAgain },
        onRequestPermission: () => {},
        openSettingsImpl: () => {},
        onPickGallery: () => { calls += 1; },
      }),
    );
    try {
      const btn = container.querySelector('[data-testid="camera-permission-pick-gallery"]');
      assert.ok(btn, `gallery button must render on the denied view when canAskAgain=${canAskAgain}`);
      await act(async () => { btn.click(); });
      assert.equal(calls, 1, 'clicking the denied-view gallery button must invoke onPickGallery once');
    } finally {
      await cleanup();
    }
  });
}

// Contract: if `onPickGallery` is not wired, the button MUST NOT render — that
// way a ScanScreen regression that drops the wire is caught by the § 8 wiring
// assertion AND by any consumer test that expects the button.
await test('permission-denied view hides the gallery entry when onPickGallery is not wired (fail-loud contract)', async () => {
  const { container, cleanup } = await renderInto(
    React.createElement(CameraPermissionDeniedView, {
      permission: { granted: false, canAskAgain: true },
      onRequestPermission: () => {},
      openSettingsImpl: () => {},
      // no onPickGallery
    }),
  );
  try {
    assert.equal(
      container.querySelector('[data-testid="camera-permission-pick-gallery"]'),
      null,
      'without onPickGallery the button must not render — a phantom button would hide the wiring regression',
    );
  } finally {
    await cleanup();
  }
});

// ── 10. Mutation controls: red-before-green ─────────────────────────────────
// A regressed overlay that omits the gallery entry must fail. Uses the SAME
// pressable count / testID lookups as the production assertion above so a
// mutation cannot escape by using a different DOM shape.
await test('mutation: an overlay missing scan-gallery-action fails the gallery assertion', async () => {
  function RegressedOverlay() {
    return React.createElement(
      View,
      { 'data-testid': 'scan-primary-controls', testID: 'scan-primary-controls' },
      React.createElement(TouchableOpacity, { testID: 'scan-flash-toggle', accessibilityRole: 'button' },
        React.createElement(Text, null, '💡')),
      React.createElement(TouchableOpacity, { testID: 'scan-primary-action', accessibilityRole: 'button' },
        React.createElement(Text, null, '📷')),
      // NO gallery — this is the exact shape the shipped Android APK had.
    );
  }
  const { container, cleanup } = await renderInto(React.createElement(RegressedOverlay));
  try {
    assert.equal(
      container.querySelector('[data-testid="scan-gallery-action"]'),
      null,
      'positive control must really omit the gallery action',
    );
    assert.throws(
      () => {
        const gallery = container.querySelector('[data-testid="scan-gallery-action"]');
        assert.ok(gallery, 'production assertion');
      },
      'the gallery assertion must reject the regressed overlay',
    );
  } finally {
    await cleanup();
  }
});

await test('mutation: a permission-denied view missing pick-gallery fails the reachability assertion', async () => {
  function RegressedDeniedView() {
    return React.createElement(
      View,
      { 'data-testid': 'camera-permission-denied', testID: 'camera-permission-denied' },
      React.createElement(TouchableOpacity, { testID: 'camera-permission-open-settings', accessibilityRole: 'button' },
        React.createElement(Text, null, 'Settings')),
      // NO gallery — this is the exact shape the shipped Android APK had.
    );
  }
  const { container, cleanup } = await renderInto(React.createElement(RegressedDeniedView));
  try {
    assert.equal(
      container.querySelector('[data-testid="camera-permission-pick-gallery"]'),
      null,
      'positive control must really omit the gallery action',
    );
    assert.throws(
      () => {
        const btn = container.querySelector('[data-testid="camera-permission-pick-gallery"]');
        assert.ok(btn, 'production assertion');
      },
      'the reachability assertion must reject the regressed denied view',
    );
  } finally {
    await cleanup();
  }
});

// A regressed overlay with an extra fourth control fails the three-pressable
// assertion — protects against re-adding removed developer/session controls.
await test('mutation: an overlay with a fourth control fails the three-pressable assertion', async () => {
  function RegressedOverlay() {
    return React.createElement(
      View,
      { 'data-testid': 'scan-primary-controls', testID: 'scan-primary-controls' },
      React.createElement(TouchableOpacity, { testID: 'scan-flash-toggle', accessibilityRole: 'button' },
        React.createElement(Text, null, '💡')),
      React.createElement(TouchableOpacity, { testID: 'scan-primary-action', accessibilityRole: 'button' },
        React.createElement(Text, null, '📷')),
      React.createElement(TouchableOpacity, { testID: 'scan-gallery-action', accessibilityRole: 'button' },
        React.createElement(Text, null, '🖼️')),
      // A resurrected flip control, deliberately WITHOUT accessibilityRole —
      // that is how the removed controls were actually written.
      React.createElement(TouchableOpacity, { testID: 'scan-flip' },
        React.createElement(Text, null, '🔄')),
    );
  }
  const { container, cleanup } = await renderInto(React.createElement(RegressedOverlay));
  try {
    const buttons = pressablesIn(controlRow(container));
    assert.equal(buttons.length, 4, 'positive control must really render four pressables');
    assert.throws(
      () => assert.equal(buttons.length, 3),
      'the three-pressable assertion must reject the regressed overlay',
    );
  } finally {
    await cleanup();
  }
});

// ── 11. CI actually runs this ─────────────────────────────────────────────────
await test('CI executes the scan primary-path regression', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.ok(ci.includes('test:scan-primary-path'), 'ci.yml must run npm run test:scan-primary-path');
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.scripts['test:scan-primary-path'], 'package.json must define test:scan-primary-path');
});

console.log(`\n✅ Scan primary-path regression: ${passed} assertions passed`);
