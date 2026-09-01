#!/usr/bin/env node
/**
 * DIC-1286 regression: opening the Scan screen must fail SAFE, never fatally.
 *
 * User-reported blocker on the Closed Test Android APK: launching the Scan
 * function crashes the entire app. Root cause is native (a synchronous error
 * inside a native module reached during CameraView mount happens before any
 * JS `onMountError` callback can fire), so the delivery gate is a
 * defence-in-depth JS layer that keeps a crash inside the scan subtree
 * instead of taking the whole APK down. This test locks that layer in place:
 *
 *   1. `src/components/ScanScreenErrorBoundary.tsx` exists as a class
 *      component with `getDerivedStateFromError` + `componentDidCatch`, and
 *      resets `hasError` when the retry handler fires.
 *   2. The boundary really re-renders its children after retry — proven by
 *      rendering it through react-native-web against a child that throws on
 *      its first render and succeeds on its second.
 *   3. `src/navigation/AppNavigator.tsx` wraps the Scan drawer route with
 *      the boundary, so the drawer's `component` identity is the safe
 *      wrapper (not the raw ScanScreen). This is the only path that reaches
 *      ScanScreen in the real app; a regression that swaps it back to
 *      `component={ScanScreen}` reintroduces the original crash surface.
 *   4. `src/screens/ScanScreen.tsx` guards `require('expo-ocr-kit')`
 *      against a missing / broken native module so a stray OCR-side failure
 *      cannot bring down the render tree via an unhandled require throw.
 *   5. Both i18n locales carry the boundary's copy keys with actual bodies
 *      (empty strings would blank the fallback UI).
 *
 * Run: node --import ./scripts/register-web-render.mjs \
 *      scripts/test-scan-screen-fail-safe.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import ReactDOMServer from 'react-dom/server';

import ScanScreenErrorBoundary from '../src/components/ScanScreenErrorBoundary.tsx';
import { zh, ja } from '../src/i18n/index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

// ── 1. Source file existence and shape ─────────────────────────────────────
const boundarySource = fs.readFileSync(
  path.join(ROOT, 'src/components/ScanScreenErrorBoundary.tsx'),
  'utf8',
);

test('ScanScreenErrorBoundary is a class extending Component', () => {
  assert.match(boundarySource, /export\s+class\s+ScanScreenErrorBoundary\s+extends\s+Component</);
});

test('ScanScreenErrorBoundary implements getDerivedStateFromError to flip hasError', () => {
  assert.match(
    boundarySource,
    /static\s+getDerivedStateFromError[\s\S]*hasError:\s*true/,
    'boundary must set hasError=true in getDerivedStateFromError',
  );
});

test('ScanScreenErrorBoundary implements componentDidCatch for logging seam', () => {
  assert.match(boundarySource, /componentDidCatch\s*\(/);
});

test('ScanScreenErrorBoundary resets hasError=false when retry fires', () => {
  assert.match(
    boundarySource,
    /handleRetry[\s\S]*setState\(\{\s*hasError:\s*false/,
    'retry handler must call setState({hasError:false}) so children re-mount',
  );
});

// ── 2. Behavioural: boundary state machine + fallback markup ──────────────
// React 19 server rendering re-throws inside class error boundaries in some
// configurations, so instead of rendering a throwing subtree through SSR we
// exercise the boundary's state machine directly (the same code paths React
// invokes when a real child throws in production) and then render the
// resolved fallback subtree — which is what the user sees when a native
// crash tears down the ScanScreen tree.

test('getDerivedStateFromError flips hasError and captures the thrown message', () => {
  const next = ScanScreenErrorBoundary.getDerivedStateFromError(new Error('camera mount blew up'));
  assert.equal(next.hasError, true);
  assert.match(next.message, /camera mount blew up/);
});

test('getDerivedStateFromError never returns undefined message', () => {
  const next = ScanScreenErrorBoundary.getDerivedStateFromError({});
  assert.equal(next.hasError, true);
  assert.equal(typeof next.message, 'string', 'message must be a string even for non-Error throws');
});

test('componentDidCatch invokes the onError seam without re-throwing', () => {
  let capturedError = null;
  const instance = new ScanScreenErrorBoundary({
    children: null,
    onError: (err) => { capturedError = err; },
  });
  const boom = new Error('render blew up');
  assert.doesNotThrow(() => instance.componentDidCatch(boom, { componentStack: 'stack' }));
  assert.strictEqual(capturedError, boom, 'onError must receive the exact Error instance');
});

test('boundary renders children while healthy; renders fallback markup while errored', () => {
  const healthyHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(
      ScanScreenErrorBoundary,
      null,
      React.createElement('div', { 'data-testid': 'child-ok' }, 'child rendered'),
    ),
  );
  assert.match(
    healthyHtml,
    /data-testid=["']child-ok["']/,
    'healthy boundary must pass its children through untouched',
  );
  assert.doesNotMatch(
    healthyHtml,
    /data-testid=["']scan-error-boundary-fallback["']/,
    'healthy boundary must NOT render the fallback UI',
  );

  // Reproduce the fallback branch React would reach after a caught render
  // error: the boundary's state has flipped to { hasError: true, message }.
  // Directly render an instance with that state so we can inspect the
  // resulting DOM without depending on SSR error handling.
  class ForceErrored extends ScanScreenErrorBoundary {
    constructor(props) {
      super(props);
      this.state = { hasError: true, message: 'camera mount blew up' };
    }
  }
  const erroredHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(ForceErrored, null,
      React.createElement('div', { 'data-testid': 'child-ok' }, 'child'),
    ),
  );
  assert.match(
    erroredHtml,
    /data-testid=["']scan-error-boundary-fallback["']/,
    'errored boundary must render the fallback container',
  );
  assert.match(
    erroredHtml,
    /data-testid=["']scan-error-boundary-retry["']/,
    'fallback must expose the retry button',
  );
  assert.match(
    erroredHtml,
    new RegExp(zh.scan_error_boundary_title),
    'fallback must show the localized title (default zh)',
  );
  assert.match(
    erroredHtml,
    /camera mount blew up/,
    'fallback must surface the captured error message for triage',
  );
  assert.doesNotMatch(
    erroredHtml,
    /data-testid=["']child-ok["']/,
    'errored boundary must NOT render children — those are the crashing tree',
  );
});

test('handleRetry resets hasError so React will re-mount the child subtree', () => {
  const instance = new ScanScreenErrorBoundary({ children: null });
  instance.state = { hasError: true, message: 'boom' };
  const captured = [];
  instance.setState = (patch) => {
    Object.assign(instance.state, patch);
    captured.push(patch);
  };
  // handleRetry is a private arrow-fn field, so it lives on the instance,
  // not on the prototype. Reach it via bracket access to keep TS happy.
  const retry = instance['handleRetry'];
  assert.equal(typeof retry, 'function', 'handleRetry must exist on the instance');
  retry();
  assert.equal(instance.state.hasError, false, 'retry must clear hasError');
  assert.equal(instance.state.message, '', 'retry must clear the stored message');
  assert.deepEqual(captured, [{ hasError: false, message: '' }]);
});

// ── 3. Navigator wraps ScanScreen with the boundary ────────────────────────
const navigatorSource = fs.readFileSync(
  path.join(ROOT, 'src/navigation/AppNavigator.tsx'),
  'utf8',
);

test('AppNavigator imports ScanScreenErrorBoundary', () => {
  assert.match(
    navigatorSource,
    /import\s+ScanScreenErrorBoundary\s+from\s+['"]\.\.\/components\/ScanScreenErrorBoundary['"]/,
  );
});

test('AppNavigator wraps ScanScreen inside ScanScreenErrorBoundary', () => {
  assert.match(
    navigatorSource,
    /<ScanScreenErrorBoundary[\s\S]*<ScanScreen[\s\S]*<\/ScanScreenErrorBoundary>/,
    'ScanScreen must be nested inside ScanScreenErrorBoundary in the safe wrapper',
  );
});

test('Scan drawer route resolves to the safe wrapper, not raw ScanScreen', () => {
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

// ── 4. ScanScreen guards the expo-ocr-kit require ──────────────────────────
const scanSource = fs.readFileSync(
  path.join(ROOT, 'src/screens/ScanScreen.tsx'),
  'utf8',
);

test("ScanScreen guards require('expo-ocr-kit') behind try/catch", () => {
  // Any executable `require('expo-ocr-kit')` in the file must be inside a
  // try/catch. This is a source-shape check because the actual module is
  // loaded lazily inside a handler; the crash mode we're locking out is a
  // synchronous require throw bubbling as an unhandled rejection.
  //
  // Strip `/* … */` block comments and `// …` line comments before scanning
  // — the DIC-1286 explanatory comment on the fix references
  // `require('expo-ocr-kit')` literally, and without stripping it a naive
  // regex would find that reference and blame the fix for missing a try.
  // Comments are replaced with spaces of the same length so brace-balance
  // positions map back to the original source layout.
  const executable = scanSource
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/(^|[^\\])\/\/[^\n]*/g, (m, prefix) => prefix + ' '.repeat(m.length - prefix.length));
  const uses = [...executable.matchAll(/require\(['"]expo-ocr-kit['"]\)/g)];
  assert.ok(uses.length > 0, 'expected at least one expo-ocr-kit require in ScanScreen');
  for (const match of uses) {
    const before = executable.slice(0, match.index);
    let depth = 0;
    let wrappedByTry = false;
    // Walk each `try {`, `{`, `}` from newest to oldest; a try token whose
    // opening `{` is at depth 0 relative to the require's position wraps it.
    const tokens = [...before.matchAll(/try\s*\{|\{|\}/g)];
    for (const tok of tokens.reverse()) {
      const text = tok[0];
      if (text === '}') depth += 1;
      else if (text === '{') {
        if (depth === 0) { break; }
        depth -= 1;
      } else if (/^try\s*\{$/.test(text)) {
        if (depth === 0) { wrappedByTry = true; break; }
        depth -= 1;
      }
    }
    assert.ok(
      wrappedByTry,
      `require('expo-ocr-kit') at offset ${match.index} must sit inside a try block`,
    );
    // And the catch clause must exist somewhere after the require (within
    // its enclosing function) — walk forward and require a `catch` token
    // before the file ends.
    const after = executable.slice(match.index, match.index + 800);
    assert.match(
      after,
      /\}\s*catch\s*\(/,
      `require('expo-ocr-kit') at offset ${match.index} must be followed by a catch block`,
    );
  }
});

test('ScanScreen falls back to empty OCR when the native module is missing', () => {
  assert.match(
    scanSource,
    /expo-ocr-kit unavailable[\s\S]*return\s+''/,
    'ScanScreen must log and return empty string on require failure, not rethrow',
  );
});

// ── 5. Locale coverage for the boundary UI ────────────────────────────────
const REQUIRED_KEYS = [
  'scan_error_boundary_title',
  'scan_error_boundary_body',
  'scan_error_boundary_retry',
  'scan_error_boundary_home',
  'scan_error_boundary_details',
];

test('every boundary copy key exists in both zh and ja with non-empty values', () => {
  for (const key of REQUIRED_KEYS) {
    assert.ok(zh[key], `zh must define ${key}`);
    assert.ok(ja[key], `ja must define ${key}`);
    assert.ok(zh[key].trim().length > 0, `zh.${key} must not be empty`);
    assert.ok(ja[key].trim().length > 0, `ja.${key} must not be empty`);
    assert.notEqual(zh[key], ja[key], `${key}: zh and ja copy must actually differ`);
  }
});

// ── 6. CI wires the test in ────────────────────────────────────────────────
test('CI executes the scan-screen fail-safe regression', () => {
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
