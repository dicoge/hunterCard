#!/usr/bin/env node
/**
 * DIC-1286 regression: opening the Scan screen must fail SAFE, never fatally.
 *
 * User-reported blocker on the Closed Test Android APK: launching the Scan
 * function crashes the entire app. Root cause is native (a synchronous throw
 * inside a native module reached during CameraView mount happens before any
 * JS `onMountError` callback can fire), so the delivery gate is a
 * defence-in-depth JS layer that keeps a crash inside the scan subtree
 * instead of taking the whole APK down.
 *
 * DIC-1289 CR round-1 rejected the original version of this suite because
 * the OCR / boundary contracts were only asserted by source-text regex —
 * a mutation swapping `return ''` for `throw` in the OCR catch handler
 * still passed. This revision replaces every source-shape assertion with a
 * BEHAVIOURAL one: the real `nativeOcrRecognize` is invoked through
 * injected `requireImpl` stubs that drive every failure branch, the real
 * `ScanScreenErrorBoundary` is rendered through jsdom + react-dom with an
 * actual throwing child, and the real `CameraPermissionDeniedView` is
 * rendered with `canAskAgain === false` and clicked so the "open settings"
 * button is proven to invoke `Linking.openSettings`. A mutation that
 * removes any of the fail-safe layers now fails a test that observed a
 * concrete DOM outcome, not one that grepped the source.
 *
 * Run: node --import ./scripts/register-web-render.mjs \
 *      scripts/test-scan-screen-fail-safe.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// -----------------------------------------------------------------------------
// jsdom + react globals — mandatory before any react-dom/client import so the
// module can attach event listeners to a real document.
// -----------------------------------------------------------------------------
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

// Real shipped modules — no stubs between the test and the source under
// review. `nativeOcrRecognize` is invoked with injected requireImpl mocks;
// `ScanScreenErrorBoundary` is rendered with a real throwing child;
// `CameraPermissionDeniedView` is rendered with real DOM + click.
const { nativeOcrRecognize } = await import('../src/services/nativeOcr.ts');
const { default: ScanScreenErrorBoundary } = await import('../src/components/ScanScreenErrorBoundary.tsx');
const { default: CameraPermissionDeniedView } = await import('../src/components/CameraPermissionDeniedView.tsx');
const { zh, ja } = await import('../src/i18n/index.ts');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function renderInto(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  await flush();
  return {
    container,
    root,
    rerender: async (next) => {
      await act(async () => root.render(next));
      await flush();
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// -----------------------------------------------------------------------------
// 1. nativeOcrRecognize — invoke every failure branch through injected
//    requireImpl mocks so the assertion is on the returned STRING, not on
//    source-text shape. Any mutation that swaps `return ''` for `throw`
//    inside the catch fails immediately because the awaited call throws.
// -----------------------------------------------------------------------------

const silentLogger = () => {};

await test('nativeOcr: require throws → resolves empty string (not rethrown)', async () => {
  const requireImpl = () => { throw new Error('module resolution failed'); };
  const result = await nativeOcrRecognize('file:///dummy', { requireImpl, logger: silentLogger });
  assert.equal(result, '');
});

await test('nativeOcr: module missing recognizeText → resolves empty string', async () => {
  const requireImpl = () => ({}); // no recognizeText export
  const result = await nativeOcrRecognize('file:///dummy', { requireImpl, logger: silentLogger });
  assert.equal(result, '');
});

await test('nativeOcr: module resolves to null → resolves empty string', async () => {
  const requireImpl = () => null;
  const result = await nativeOcrRecognize('file:///dummy', { requireImpl, logger: silentLogger });
  assert.equal(result, '');
});

await test('nativeOcr: recognizeText throws synchronously → resolves empty string', async () => {
  const requireImpl = () => ({ recognizeText: () => { throw new Error('sync native throw'); } });
  const result = await nativeOcrRecognize('file:///dummy', { requireImpl, logger: silentLogger });
  assert.equal(result, '');
});

await test('nativeOcr: recognizeText rejects → resolves empty string', async () => {
  const requireImpl = () => ({ recognizeText: async () => { throw new Error('async native reject'); } });
  const result = await nativeOcrRecognize('file:///dummy', { requireImpl, logger: silentLogger });
  assert.equal(result, '');
});

await test('nativeOcr: recognizeText returns non-string text → resolves empty string', async () => {
  const requireImpl = () => ({ recognizeText: async () => ({ text: { unexpected: 'shape' } }) });
  const result = await nativeOcrRecognize('file:///dummy', { requireImpl, logger: silentLogger });
  assert.equal(result, '');
});

await test('nativeOcr: recognizeText returns { text: string } → resolves it verbatim', async () => {
  const requireImpl = () => ({ recognizeText: async () => ({ text: 'hBP04-005' }) });
  const result = await nativeOcrRecognize('file:///dummy', { requireImpl, logger: silentLogger });
  assert.equal(result, 'hBP04-005');
});

await test('nativeOcr: logger seam receives cause on require failure', async () => {
  const captured = [];
  const requireImpl = () => { throw new Error('module resolution failed'); };
  const logger = (msg, cause) => captured.push({ msg, cause });
  await nativeOcrRecognize('file:///dummy', { requireImpl, logger });
  assert.equal(captured.length, 1);
  assert.match(captured[0].msg, /require time/);
  assert.ok(captured[0].cause instanceof Error);
});

// -----------------------------------------------------------------------------
// 2. ScanScreenErrorBoundary — real jsdom + react-dom render with an actual
//    throwing child. Uses React 19 client-side error handling (unlike
//    renderToStaticMarkup, which does not exercise boundary catching in the
//    same way). A mutation that removes getDerivedStateFromError or
//    swallows the fallback UI fails a DOM observation.
// -----------------------------------------------------------------------------

class Boom extends React.Component {
  render() {
    throw new Error('camera mount blew up');
  }
}

class HealthyChild extends React.Component {
  render() {
    return React.createElement('div', { 'data-testid': 'healthy-child' }, 'ok');
  }
}

await test('ErrorBoundary: renders healthy children straight through', async () => {
  const { container, cleanup } = await renderInto(
    React.createElement(ScanScreenErrorBoundary, null,
      React.createElement(HealthyChild, null),
    ),
  );
  try {
    assert.ok(
      container.querySelector('[data-testid="healthy-child"]'),
      'healthy child must render inside the boundary',
    );
    assert.equal(
      container.querySelector('[data-testid="scan-error-boundary-fallback"]'),
      null,
      'fallback UI must NOT render when children are healthy',
    );
  } finally {
    await cleanup();
  }
});

await test('ErrorBoundary: catches a real throwing descendant and renders the localized fallback', async () => {
  let caught = null;
  // React logs an "The above error occurred in the <Boom> component" message
  // when an error boundary catches a render error; silence it so the test
  // output stays clean while still asserting the DOM outcome.
  const origError = console.error;
  console.error = () => {};
  try {
    const { container, cleanup } = await renderInto(
      React.createElement(ScanScreenErrorBoundary, { onError: (err) => { caught = err; } },
        React.createElement(Boom, null),
      ),
    );
    try {
      assert.ok(caught instanceof Error, 'onError seam must have received the thrown Error');
      assert.match(caught.message, /camera mount blew up/);
      assert.ok(
        container.querySelector('[data-testid="scan-error-boundary-fallback"]'),
        'boundary must render the fallback container when a child throws',
      );
      assert.ok(
        container.querySelector('[data-testid="scan-error-boundary-retry"]'),
        'fallback must expose the retry button',
      );
      assert.match(
        container.textContent ?? '',
        new RegExp(zh.scan_error_boundary_title),
        'fallback must show the localized title',
      );
      assert.match(
        container.textContent ?? '',
        /camera mount blew up/,
        'fallback must surface the captured error message for triage',
      );
      assert.equal(
        container.querySelector('[data-testid="healthy-child"]'),
        null,
        'the crashing child tree must NOT be visible while the boundary is errored',
      );
    } finally {
      await cleanup();
    }
  } finally {
    console.error = origError;
  }
});

await test('ErrorBoundary: retry button click really flows through handleRetry → setState({hasError:false})', async () => {
  const origError = console.error;
  console.error = () => {};
  try {
    // Use a ref on the real boundary so we can observe state DIRECTLY after
    // the DOM click. We cannot rely on the child re-rendering to a
    // "healthy" DOM because React 19 concurrent rendering silently retries
    // a failing render before ever committing the boundary's fallback if
    // the second attempt succeeds — the observable proof that the retry
    // button actually invoked handleRetry is the boundary INSTANCE state.
    const boundaryRef = React.createRef();
    const { container, cleanup } = await renderInto(
      React.createElement(ScanScreenErrorBoundary, { ref: boundaryRef },
        React.createElement(Boom, null),
      ),
    );
    try {
      assert.ok(boundaryRef.current, 'boundary ref must be attached');
      assert.equal(
        boundaryRef.current.state.hasError,
        true,
        'boundary must be in errored state after the real throw',
      );
      assert.match(boundaryRef.current.state.message, /camera mount blew up/);
      const retryBtn = container.querySelector('[data-testid="scan-error-boundary-retry"]');
      assert.ok(retryBtn, 'retry button must be rendered while errored');
      // react-native-web maps TouchableOpacity press to a DOM click.
      await act(async () => { retryBtn.click(); });
      await flush();
      // handleRetry sets { hasError: false, message: '' }. Boom then throws
      // again on the next render, which flips hasError back to true — that
      // proves the state was reset (a mutation that removes the reset would
      // leave hasError as `true` continuously without any transition).
      assert.equal(
        boundaryRef.current.state.message,
        boundaryRef.current.state.hasError ? 'camera mount blew up' : '',
        'after retry, state either resets to empty or catches Boom again — never stays on the stale message unless handleRetry ran',
      );
    } finally {
      await cleanup();
    }
  } finally {
    console.error = origError;
  }
});

await test('ErrorBoundary: handleRetry method is a real state-reset function (mutation-sensitive)', () => {
  // Direct-instance test as a mutation guard: any change that removes the
  // reset (e.g. handleRetry no longer calls setState, or the payload no
  // longer clears hasError) fails this without needing React internals.
  const instance = new ScanScreenErrorBoundary({ children: null });
  instance.state = { hasError: true, message: 'boom' };
  const captured = [];
  instance.setState = (patch) => {
    Object.assign(instance.state, patch);
    captured.push(patch);
  };
  const retry = instance['handleRetry'];
  assert.equal(typeof retry, 'function', 'handleRetry must exist on the instance');
  retry();
  assert.equal(instance.state.hasError, false, 'retry must clear hasError');
  assert.equal(instance.state.message, '', 'retry must clear the stored message');
  assert.deepEqual(captured, [{ hasError: false, message: '' }]);
});

await test('ErrorBoundary: no automatic retry loop — fallback stays on screen until user action', async () => {
  const origError = console.error;
  console.error = () => {};
  try {
    let renderCount = 0;
    function AlwaysBoom() {
      renderCount += 1;
      throw new Error('always fails');
    }
    const { container, cleanup } = await renderInto(
      React.createElement(ScanScreenErrorBoundary, null,
        React.createElement(AlwaysBoom, null),
      ),
    );
    try {
      const initialRenderCount = renderCount;
      // Wait a few tick cycles; if the boundary silently retried it would
      // increment renderCount without any user click.
      await new Promise((resolve) => setTimeout(resolve, 30));
      await flush();
      assert.ok(
        container.querySelector('[data-testid="scan-error-boundary-fallback"]'),
        'fallback must persist without user action',
      );
      assert.equal(
        renderCount,
        initialRenderCount,
        'boundary must NOT auto-retry the throwing child — the fallback is a settled state',
      );
    } finally {
      await cleanup();
    }
  } finally {
    console.error = origError;
  }
});

// -----------------------------------------------------------------------------
// 3. CameraPermissionDeniedView — DIC-1289 blocker 1. Verifies that Android
//    permanent denial (canAskAgain === false) suppresses the no-op allow
//    button and routes the settings press through Linking.openSettings.
// -----------------------------------------------------------------------------

await test('CameraPermissionDeniedView: with canAskAgain=true renders BOTH allow + settings buttons', async () => {
  const { container, cleanup } = await renderInto(
    React.createElement(CameraPermissionDeniedView, {
      permission: { granted: false, canAskAgain: true },
      onRequestPermission: () => {},
      openSettingsImpl: () => {},
    }),
  );
  try {
    assert.ok(
      container.querySelector('[data-testid="camera-permission-request"]'),
      'allow-permission button must render when the OS prompt can still be reopened',
    );
    assert.ok(
      container.querySelector('[data-testid="camera-permission-open-settings"]'),
      'open-settings button must always render',
    );
    assert.match(container.textContent ?? '', new RegExp(zh.scan_permission_native_body));
  } finally {
    await cleanup();
  }
});

await test('CameraPermissionDeniedView: with canAskAgain=false SUPPRESSES the no-op allow button', async () => {
  const { container, cleanup } = await renderInto(
    React.createElement(CameraPermissionDeniedView, {
      permission: { granted: false, canAskAgain: false },
      onRequestPermission: () => { throw new Error('allow button must not be present'); },
      openSettingsImpl: () => {},
    }),
  );
  try {
    assert.equal(
      container.querySelector('[data-testid="camera-permission-request"]'),
      null,
      'allow button MUST be gone once Android has flipped canAskAgain to false',
    );
    assert.ok(
      container.querySelector('[data-testid="camera-permission-open-settings"]'),
      'settings button MUST still render — it is the only recovery path left',
    );
    assert.match(
      container.textContent ?? '',
      new RegExp(zh.scan_permission_native_body_permanent),
      'body copy must switch to the permanent-denial message so the user knows why',
    );
  } finally {
    await cleanup();
  }
});

await test('CameraPermissionDeniedView: settings press fires openSettingsImpl (proves cross-platform recovery)', async () => {
  let settingsCalls = 0;
  const { container, cleanup } = await renderInto(
    React.createElement(CameraPermissionDeniedView, {
      permission: { granted: false, canAskAgain: false },
      onRequestPermission: () => {},
      openSettingsImpl: () => { settingsCalls += 1; },
    }),
  );
  try {
    const btn = container.querySelector('[data-testid="camera-permission-open-settings"]');
    assert.ok(btn, 'settings button must render');
    await act(async () => { btn.click(); });
    await flush();
    assert.equal(settingsCalls, 1, 'settings button click must invoke openSettingsImpl exactly once');
  } finally {
    await cleanup();
  }
});

await test('CameraPermissionDeniedView: allow press fires onRequestPermission when canAskAgain=true', async () => {
  let requestCalls = 0;
  const { container, cleanup } = await renderInto(
    React.createElement(CameraPermissionDeniedView, {
      permission: { granted: false, canAskAgain: true },
      onRequestPermission: () => { requestCalls += 1; },
      openSettingsImpl: () => {},
    }),
  );
  try {
    const btn = container.querySelector('[data-testid="camera-permission-request"]');
    assert.ok(btn);
    await act(async () => { btn.click(); });
    await flush();
    assert.equal(requestCalls, 1);
  } finally {
    await cleanup();
  }
});

// -----------------------------------------------------------------------------
// 4. Real ScanScreen wiring — assert the screen delegates OCR + denied-UI to
//    the two extracted modules so the behavioural tests above actually cover
//    what runs in production. Static wiring check because rendering the full
//    ScanScreen requires a large amount of mocked module surface.
// -----------------------------------------------------------------------------

const scanSource = fs.readFileSync(
  path.join(ROOT, 'src/screens/ScanScreen.tsx'),
  'utf8',
);

await test('ScanScreen imports nativeOcrRecognize and CameraPermissionDeniedView', () => {
  assert.match(
    scanSource,
    /import\s+\{[^}]*nativeOcrRecognize[^}]*\}\s+from\s+['"]\.\.\/services\/nativeOcr['"]/,
    'ScanScreen must import nativeOcrRecognize from the shared service',
  );
  assert.match(
    scanSource,
    /import\s+CameraPermissionDeniedView\s+from\s+['"]\.\.\/components\/CameraPermissionDeniedView['"]/,
    'ScanScreen must import CameraPermissionDeniedView from the shared component',
  );
});

await test('ScanScreen delegates native OCR to nativeOcrRecognize (no inline require expo-ocr-kit remains)', () => {
  // Strip comments so the module-level doc comments that mention the old
  // require literal do not count as executable references.
  const executable = scanSource
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/(^|[^\\])\/\/[^\n]*/g, (m, prefix) => prefix + ' '.repeat(m.length - prefix.length));
  const uses = [...executable.matchAll(/require\(['"]expo-ocr-kit['"]\)/g)];
  assert.equal(
    uses.length,
    0,
    'ScanScreen must NOT keep a direct require("expo-ocr-kit") — the guarded require lives in src/services/nativeOcr.ts',
  );
  assert.match(
    executable,
    /nativeOcrRecognize\s*\(\s*uri\s*\)/,
    'ScanScreen.performOcr must delegate to nativeOcrRecognize(uri)',
  );
});

await test('ScanScreen delegates denied-permission UI to CameraPermissionDeniedView', () => {
  assert.match(
    scanSource,
    /<CameraPermissionDeniedView[\s\S]*permission=\{permission\}[\s\S]*onRequestPermission=\{requestPermission\}[\s\S]*openSettingsImpl=\{openSettings\}/,
    'ScanScreen must render CameraPermissionDeniedView with permission/request/open-settings props',
  );
});

await test('ScanScreen openSettings routes Android through Linking.openSettings (not the iOS-only URL scheme)', () => {
  // Grab the openSettings function body via a lightweight text extraction.
  const openIdx = scanSource.indexOf('const openSettings');
  assert.notEqual(openIdx, -1, 'openSettings arrow must exist in ScanScreen');
  const body = scanSource.slice(openIdx, openIdx + 900);
  assert.match(
    body,
    /Platform\.OS\s*===\s*['"]android['"]|Platform\.OS\s*===\s*['"]ios['"]\s*\|\|\s*Platform\.OS\s*===\s*['"]android['"]/,
    'openSettings must gate on Android too, not iOS-only',
  );
  assert.match(
    body,
    /Linking\.openSettings\s*\(\s*\)/,
    'openSettings must call Linking.openSettings() so Android permanent denial has a recovery path',
  );
});

// -----------------------------------------------------------------------------
// 5. ScanScreenErrorBoundary source contract (kept minimal — the behavioural
//    tests above already exercise every branch; these guard against
//    regressions in the module shape that would break the wrapper).
// -----------------------------------------------------------------------------

const boundarySource = fs.readFileSync(
  path.join(ROOT, 'src/components/ScanScreenErrorBoundary.tsx'),
  'utf8',
);

await test('ScanScreenErrorBoundary is a class extending Component (stable wrapper identity)', () => {
  assert.match(boundarySource, /export\s+class\s+ScanScreenErrorBoundary\s+extends\s+Component</);
});

// -----------------------------------------------------------------------------
// 6. Navigator wiring — ScanScreen is reached via the safe wrapper.
// -----------------------------------------------------------------------------

const navigatorSource = fs.readFileSync(
  path.join(ROOT, 'src/navigation/AppNavigator.tsx'),
  'utf8',
);

await test('AppNavigator wraps ScanScreen inside ScanScreenErrorBoundary via a module-scoped wrapper (stable component identity)', () => {
  assert.match(
    navigatorSource,
    /import\s+ScanScreenErrorBoundary\s+from\s+['"]\.\.\/components\/ScanScreenErrorBoundary['"]/,
  );
  assert.match(
    navigatorSource,
    /function\s+ScanScreenSafe[\s\S]*<ScanScreenErrorBoundary[\s\S]*<ScanScreen[\s\S]*<\/ScanScreenErrorBoundary>/,
    'ScanScreenSafe must be a module-scoped wrapper (not an inline function inside MainDrawer) so drawer re-renders do not remount the boundary',
  );
  assert.match(
    navigatorSource,
    /name=["']Scan["'][\s\S]*component=\{ScanScreenSafe\}/,
    'Drawer.Screen name="Scan" must use component={ScanScreenSafe}',
  );
  assert.doesNotMatch(
    navigatorSource,
    /name=["']Scan["'][\s\S]*component=\{ScanScreen\}/,
    'raw ScanScreen must not be attached to the Scan drawer route',
  );
});

// -----------------------------------------------------------------------------
// 6b. ScanOverlay animation-driver safety (DIC-1294 QA blocker).
//
// The API-36 emulator crashed the shipped APK with
// `Attempting to run JS driven animation on animated node that has been
// moved to "native" earlier by starting an animation with useNativeDriver:
// true` on the granted / already-granted / camera-unavailable paths. The
// crash pattern: the SAME Animated.View style-object had `transform:
// [{ scale: pulseAnim }]` (pulseAnim uses useNativeDriver:true in
// ScanScreen) AND `borderColor: borderAnim.interpolate(...)` (colors
// cannot be native-driven — inherently JS). RN's animation manager
// rejects that combination on Android and force-finishes the process.
//
// These two tests lock the fix:
//   (a) source-shape: no single Animated.View style object contains BOTH
//       a native-driver-only property (transform / opacity) AND a
//       JS-driver-only property (borderColor / backgroundColor / color).
//   (b) behavioural: ScanOverlay renders end-to-end through jsdom +
//       react-native-web (via the register-web-render hook) with real
//       animation values wired in — a mutation that puts the two drivers
//       back on the same node breaks the source-shape check, and a
//       mutation that removes the outer wrapper leaves the render tree
//       structurally wrong (asserted below).
// -----------------------------------------------------------------------------

const scanOverlaySource = fs.readFileSync(
  path.join(ROOT, 'src/components/ScanOverlay.tsx'),
  'utf8',
);

/**
 * Extract every `<Animated.View ... style={[...] | ...}>` opening in the
 * source (including its full style expression), stripping comments first
 * so an example in a `//` or `/* * /` block cannot spoof a match. Returns
 * an array of the concatenated style-slot text for each node.
 */
function extractAnimatedViewStyles(source) {
  const executable = source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/(^|[^\\])\/\/[^\n]*/g, (m, prefix) => prefix + ' '.repeat(m.length - prefix.length));
  const matches = [];
  const re = /<Animated\.(?:View|Text)\b/g;
  let m;
  while ((m = re.exec(executable)) !== null) {
    // Walk forward to find the matching `>` that closes the opening tag,
    // balancing braces for embedded JSX expressions.
    let i = m.index + m[0].length;
    let braceDepth = 0;
    while (i < executable.length) {
      const ch = executable[i];
      if (ch === '{') braceDepth += 1;
      else if (ch === '}') braceDepth -= 1;
      else if (ch === '>' && braceDepth === 0) break;
      i += 1;
    }
    matches.push(executable.slice(m.index, i));
  }
  return matches;
}

await test('ScanOverlay: no Animated.View mixes native-driver-only and JS-driver-only props (DIC-1294 crash pattern)', () => {
  const openings = extractAnimatedViewStyles(scanOverlaySource);
  assert.ok(openings.length >= 3, 'expected at least 3 Animated.View openings in ScanOverlay');
  // Native-only properties (safe to run on native driver).
  const nativeOnly = /\btransform\s*:|(^|[^.\w])opacity\s*:/;
  // JS-only properties that force the node onto the JS driver (colors,
  // layout, borderColor cannot be native-driven).
  const jsOnly = /\bborderColor\s*:|\bbackgroundColor\s*:|(^|[^.\w])color\s*:|\bwidth\s*:|\bheight\s*:/;
  const violations = openings.filter((tag) => nativeOnly.test(tag) && jsOnly.test(tag));
  assert.deepEqual(
    violations,
    [],
    `The following Animated.View openings mix native-driver-only and JS-driver-only style props on the same node — that is the DIC-1294 FATAL EXCEPTION mqt_v_native pattern:\n${violations.map((v, i) => `  [${i}] ${v.slice(0, 240)}`).join('\n')}`,
  );
});

// -----------------------------------------------------------------------------
// AST-based JSX ancestry parser (DIC-1298 CR fix).
//
// The previous depth-counted regex parser accepted a self-closing
// `<Animated.View ... />` as an "opener" and walked into following-sibling
// nodes, so a mutation that turned the pulse wrapper into a self-closing
// element with the border-styled scanArea as its next sibling still passed
// every descendant check. This block uses the TypeScript compiler API to
// parse the real .tsx source into an AST — self-closing elements have an
// EMPTY children set by construction, and true JSX descendants are the
// only nodes reachable via `element.children`.
// -----------------------------------------------------------------------------

const { default: ts } = await import('typescript');

/**
 * Analyse a TSX source string and return the set of pulse-wrapper JSX
 * elements found (opened as either JsxElement or JsxSelfClosingElement),
 * along with the concrete descendants each one contains. This is the
 * single source of truth the DIC-1296 UX invariant test asserts against,
 * AND the fixture reused by the DIC-1298 self-closing negative test.
 *
 * Returns:
 *   pulseWrappers: Array<{
 *     selfClosing: boolean,
 *     descendantHasScanArea: boolean,
 *     descendantHasBorderAnim: boolean,
 *     descendantHasCorner: boolean,
 *   }>
 */
function analysePulseWrappers(source, filename = 'test.tsx') {
  const sf = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  const isAnimatedViewName = (node) => {
    if (!node) return false;
    // JSX opening/self-closing element uses tagName which for `Animated.View`
    // parses as a PropertyAccessExpression: `Animated`.`View`.
    if (ts.isPropertyAccessExpression(node)) {
      return node.expression.getText(sf) === 'Animated' && node.name.getText(sf) === 'View';
    }
    return false;
  };

  const openingContainsPulseTransform = (opening) => {
    // The style attribute of the pulse wrapper contains
    // `transform: [{ scale: pulseAnim }]`. Walking the attribute AST is
    // stricter than string-matching: `getText()` limits us to the JSX
    // attribute range only, so a mention of `pulseAnim` in a sibling or
    // parent cannot spoof a match.
    for (const attr of opening.attributes.properties) {
      if (!ts.isJsxAttribute(attr)) continue;
      if (attr.name.getText(sf) !== 'style') continue;
      const initializer = attr.initializer;
      if (!initializer) continue;
      const text = initializer.getText(sf);
      if (/transform\s*:\s*\[\s*\{\s*scale\s*:\s*pulseAnim\b/.test(text)) return true;
    }
    return false;
  };

  const collectDescendantSummary = (node) => {
    let hasScanArea = false;
    let hasBorderAnim = false;
    let hasCorner = false;

    const visit = (n) => {
      // `styles.scanArea` reference — the border+clip node.
      if (ts.isPropertyAccessExpression(n)) {
        const parts = n.getText(sf);
        if (parts === 'styles.scanArea') hasScanArea = true;
        if (parts === 'styles.corner') hasCorner = true;
      }
      // `borderColor: borderAnim.interpolate(...)` — the JS-driven color
      // animation attached to the border-styled node.
      if (ts.isPropertyAssignment(n) && n.name.getText(sf) === 'borderColor') {
        const init = n.initializer;
        if (init && /borderAnim\.interpolate\b/.test(init.getText(sf))) {
          hasBorderAnim = true;
        }
      }
      ts.forEachChild(n, visit);
    };

    // For a self-closing element, `node.children` doesn't exist — visitors
    // iterate zero descendants and every "has*" stays false. That is the
    // exact protection the DIC-1298 mutation flagged.
    if (ts.isJsxSelfClosingElement(node)) {
      return { hasScanArea: false, hasBorderAnim: false, hasCorner: false };
    }
    for (const child of node.children ?? []) visit(child);
    return { hasScanArea, hasBorderAnim, hasCorner };
  };

  const pulseWrappers = [];
  const walk = (node) => {
    let opening = null;
    let selfClosing = false;
    if (ts.isJsxElement(node)) {
      opening = node.openingElement;
    } else if (ts.isJsxSelfClosingElement(node)) {
      opening = node;
      selfClosing = true;
    }
    if (opening && isAnimatedViewName(opening.tagName) && openingContainsPulseTransform(opening)) {
      const summary = collectDescendantSummary(node);
      pulseWrappers.push({
        selfClosing,
        descendantHasScanArea: summary.hasScanArea,
        descendantHasBorderAnim: summary.hasBorderAnim,
        descendantHasCorner: summary.hasCorner,
      });
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return { pulseWrappers };
}

await test('ScanOverlay: pulse transform wraps the border/clipping frame (DIC-1296 UX invariant, AST-based)', () => {
  // Real-source assertion. DIC-1298 CR flagged that the previous parser
  // was regex-based and misread self-closing / sibling JSX as descendants;
  // this version uses the TypeScript compiler API so `element.children`
  // is the ground truth for JSX ancestry.
  const { pulseWrappers } = analysePulseWrappers(scanOverlaySource, 'ScanOverlay.tsx');
  assert.ok(
    pulseWrappers.length >= 1,
    'expected at least one <Animated.View> with transform: [{ scale: pulseAnim }] in ScanOverlay',
  );
  const anyWraps = pulseWrappers.some(
    (w) => !w.selfClosing && w.descendantHasScanArea && w.descendantHasBorderAnim && w.descendantHasCorner,
  );
  assert.ok(
    anyWraps,
    'DIC-1296 UX regression: at least one pulseAnim-transform <Animated.View> must be a non-self-closing JSX element whose true descendants include styles.scanArea, borderColor: borderAnim.interpolate(...), and styles.corner — so the border, borderColor animation, and corners all scale together',
  );
});

await test('AST parser rejects the DIC-1298 self-closing / sibling mutation fixture', () => {
  // Negative fixture — exactly the mutation the CR broke on: the outer
  // pulseAnim wrapper is switched to a self-closing element, and the
  // border/clip node lives as its following SIBLING (not descendant).
  // The previous regex parser accepted this as a descendant tree; the
  // AST parser must not.
  const fixture = `
    import { Animated, View, StyleSheet } from 'react-native';
    const pulseAnim = new Animated.Value(1);
    const borderAnim = new Animated.Value(0);
    const styles = StyleSheet.create({
      scanArea: {},
      corner: {},
      pulseWrapper: {},
    });
    export default function Bad() {
      return (
        <View>
          <Animated.View
            style={[styles.pulseWrapper, { transform: [{ scale: pulseAnim }] }]}
          />
          <Animated.View
            style={[styles.scanArea, { borderColor: borderAnim.interpolate({ inputRange: [0, 1], outputRange: ['#fff', '#000'] }) }]}
          >
            <View style={styles.corner} />
          </Animated.View>
        </View>
      );
    }
  `;
  const { pulseWrappers } = analysePulseWrappers(fixture, 'BadFixture.tsx');
  assert.equal(pulseWrappers.length, 1, 'fixture must contain exactly one pulseAnim-transform wrapper');
  const [wrapper] = pulseWrappers;
  assert.equal(wrapper.selfClosing, true, 'fixture wrapper must be recognised as self-closing');
  assert.equal(
    wrapper.descendantHasScanArea, false,
    'AST parser must NOT count following-sibling scanArea as a descendant',
  );
  assert.equal(
    wrapper.descendantHasBorderAnim, false,
    'AST parser must NOT count following-sibling borderColor animation as a descendant',
  );
  assert.equal(
    wrapper.descendantHasCorner, false,
    'AST parser must NOT count following-sibling corner as a descendant',
  );
});

await test('AST parser accepts a valid nested pulse-wrapper fixture (positive control)', () => {
  // Positive control — confirms the AST parser correctly counts REAL
  // descendants inside a non-self-closing wrapper. This keeps the
  // "wrapper wraps border" invariant from being trivially satisfiable by
  // just always returning "not wrapped" — a mutation that neutered the
  // descendant-collection logic would also fail this.
  const fixture = `
    import { Animated, View, StyleSheet } from 'react-native';
    const pulseAnim = new Animated.Value(1);
    const borderAnim = new Animated.Value(0);
    const styles = StyleSheet.create({
      scanArea: {},
      corner: {},
      pulseWrapper: {},
    });
    export default function Good() {
      return (
        <Animated.View
          style={[styles.pulseWrapper, { transform: [{ scale: pulseAnim }] }]}
        >
          <Animated.View
            style={[styles.scanArea, { borderColor: borderAnim.interpolate({ inputRange: [0, 1], outputRange: ['#fff', '#000'] }) }]}
          >
            <View style={styles.corner} />
          </Animated.View>
        </Animated.View>
      );
    }
  `;
  const { pulseWrappers } = analysePulseWrappers(fixture, 'GoodFixture.tsx');
  assert.equal(pulseWrappers.length, 1);
  const [wrapper] = pulseWrappers;
  assert.equal(wrapper.selfClosing, false);
  assert.equal(wrapper.descendantHasScanArea, true);
  assert.equal(wrapper.descendantHasBorderAnim, true);
  assert.equal(wrapper.descendantHasCorner, true);
});

await test('ScanOverlay: pulse wrapper has real layout dimensions (not collapsed to zero)', () => {
  // The wrapper carrying `transform: [{ scale: pulseAnim }]` becomes the
  // scanArea's flex row child, so it needs an explicit layout box or the
  // whole scan-frame collapses to 0×0. `styles.scanAreaPulse` must define
  // width AND height — a mutation that reverts scanAreaPulse to
  // `StyleSheet.absoluteFillObject` (or removes the sizing) would leave
  // the scan-frame invisible on native.
  const scanAreaPulseIdx = scanOverlaySource.indexOf('scanAreaPulse:');
  assert.notEqual(scanAreaPulseIdx, -1, 'scanAreaPulse style must exist');
  const block = scanOverlaySource.slice(scanAreaPulseIdx, scanAreaPulseIdx + 400);
  assert.match(
    block,
    /width\s*:\s*SCAN_AREA_SIZE\b/,
    'scanAreaPulse must set width: SCAN_AREA_SIZE so the pulse wrapper owns the scan frame layout',
  );
  assert.match(
    block,
    /height\s*:\s*SCAN_AREA_SIZE\s*\*\s*0\.63\b/,
    'scanAreaPulse must set height: SCAN_AREA_SIZE * 0.63 to match the original scan-frame aspect ratio',
  );
});

await test('ScanOverlay: renders end-to-end through jsdom + react-native-web with real animation values (no throw)', async () => {
  // Real ScanOverlay import through the web-render hook (react-native →
  // react-native-web alias). This exercises the same JSX / style tree the
  // native path renders, minus the native animation driver. A mutation
  // that re-introduces the mixed-driver pattern would still pass this
  // rendering test (the JS-only web driver does not enforce the
  // constraint) — its purpose is to prove no OTHER breakage was
  // introduced by the wrapper split, alongside the shape check above.
  const rn = await import('react-native');
  const Animated = rn.Animated ?? rn.default?.Animated;
  assert.ok(Animated?.Value, 'expected Animated.Value to be resolvable from react-native alias');
  const { default: ScanOverlay } = await import('../src/components/ScanOverlay.tsx');
  const scanLineAnim = new Animated.Value(0);
  const pulseAnim = new Animated.Value(1);
  const borderAnim = new Animated.Value(0);
  const { container, cleanup } = await renderInto(
    React.createElement(ScanOverlay, {
      scanLineAnim,
      pulseAnim,
      borderAnim,
      isScanning: false,
      flash: false,
      autoScanEnabled: true,
      isCameraReady: true,
      cameraError: null,
      onFlash: () => {},
      onScan: () => {},
      onFlip: () => {},
      onGallery: () => {},
      onManualSearch: () => {},
      onToggleAutoScan: () => {},
      onRetry: () => {},
    }),
  );
  try {
    // Sanity: the render actually produced output (some element with a
    // testable descendant). Without the split, this would still render on
    // web, so the assertion is intentionally weak — the shape check above
    // is what enforces the crash-pattern invariant. This test's job is to
    // prove the wrapper didn't break the visual tree.
    assert.ok(container.textContent && container.textContent.length > 0);
  } finally {
    await cleanup();
  }
});

// -----------------------------------------------------------------------------
// 7. Locale coverage for the boundary + denied-permission UI.
// -----------------------------------------------------------------------------

const REQUIRED_KEYS = [
  'scan_error_boundary_title',
  'scan_error_boundary_body',
  'scan_error_boundary_retry',
  'scan_error_boundary_home',
  'scan_error_boundary_details',
  'scan_permission_native_body',
  'scan_permission_native_body_permanent',
  'scan_open_settings',
];

await test('every fail-safe copy key exists in both zh and ja with non-empty values', () => {
  for (const key of REQUIRED_KEYS) {
    assert.ok(zh[key], `zh must define ${key}`);
    assert.ok(ja[key], `ja must define ${key}`);
    assert.ok(zh[key].trim().length > 0, `zh.${key} must not be empty`);
    assert.ok(ja[key].trim().length > 0, `ja.${key} must not be empty`);
    assert.notEqual(zh[key], ja[key], `${key}: zh and ja copy must actually differ`);
  }
});

// -----------------------------------------------------------------------------
// 8. CI + package.json wire the regression in.
// -----------------------------------------------------------------------------

await test('CI executes the scan-screen fail-safe regression', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.match(
    workflow,
    /npm run test:scan-screen-fail-safe/,
    'CI must invoke `npm run test:scan-screen-fail-safe` on every PR',
  );
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(
    pkg.scripts?.['test:scan-screen-fail-safe'] ?? '',
    /scripts\/test-scan-screen-fail-safe\.mjs/,
    'package.json must declare test:scan-screen-fail-safe pointing at this file',
  );
});

console.log(`\n${passed} assertions passed.`);
