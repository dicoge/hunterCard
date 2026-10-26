#!/usr/bin/env node
// DIC-1452 CR remediation: the tabbed bottom stack must reserve the COMPUTED
// bottom inset — Math.max(reported, native ? LAYOUT.safeMobile : 0) — not the
// raw reported inset. A native device that reports bottom = 0 (three-button
// Android nav, inset provider not ready) must still keep the tab bar
// LAYOUT.safeMobile (20px) off the screen edge; web keeps the true zero.
//
// Behavioral, not source-string: the real AppShell renders through
// react-native-web with the platform and the useSafeAreaInsets() return
// controlled per case, and each assertion reads the bottom stack's computed
// padding-bottom out of the DOM.

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://holohunter.dicoge.com/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key in globalThis) continue;
  try { globalThis[key] = dom.window[key]; } catch {}
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = TestResizeObserver;
dom.window.ResizeObserver = TestResizeObserver;

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Platform, Text } = await import('react-native');
const { __setSafeAreaInsetsForTest } = await import('react-native-safe-area-context');
const AppShell = (await import('../src/components/shell/AppShell.tsx')).default;
const { LAYOUT, SPACING } = await import('../src/theme/tokensV2.ts');

const TABS = {
  items: [
    { key: 'home', label: '首頁' },
    { key: 'search', label: '搜尋' },
    { key: 'scan', label: '掃描', onPress: () => {} },
    { key: 'deck', label: '牌組' },
    { key: 'me', label: '我的' },
  ],
  activeKey: 'search',
};

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

// Renders the real AppShell with the platform and reported insets pinned for
// the duration of the render, then hands back computed padding-bottom values.
async function renderShell({ platform, insets, bottomTabBar = TABS, scrollable = false }) {
  const previousOS = Platform.OS;
  Platform.OS = platform;
  __setSafeAreaInsetsForTest(insets);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(AppShell, {
      bottomTabBar,
      scrollable,
      appBar: { title: 'HoloHunter' },
    }, React.createElement(Text, null, 'row'))));
    await flush();
    const bottomStack = container.querySelector('[data-testid="shell-root-bottom"]');
    const content = container.querySelector('[data-testid="shell-content"]');
    return {
      bottomStack,
      content,
      bottomStackPaddingBottom: bottomStack
        ? dom.window.getComputedStyle(bottomStack).paddingBottom
        : null,
      contentPaddingBottom: content
        ? dom.window.getComputedStyle(content).paddingBottom
        : null,
    };
  } finally {
    await act(async () => root.unmount());
    container.remove();
    Platform.OS = previousOS;
    __setSafeAreaInsetsForTest(null);
  }
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('── DIC-1452 · AppShell bottom stack inset fallback ──');

assert.equal(LAYOUT.safeMobile, 20, 'fallback constant under test is the Pen 20px safe margin');

await test('native + reported bottom inset 0: tabbed bottom stack reserves LAYOUT.safeMobile (20px)', async () => {
  const { bottomStack, bottomStackPaddingBottom } = await renderShell({
    platform: 'ios',
    insets: { top: 0, bottom: 0 },
  });
  assert.ok(bottomStack, 'tabbed shell renders the bottom stack');
  assert.equal(
    bottomStackPaddingBottom,
    `${LAYOUT.safeMobile}px`,
    'native zero-inset state keeps the 20px fallback under the tab bar',
  );
});

await test('native + reported bottom inset 34 (> fallback): bottom stack keeps the real 34px', async () => {
  const { bottomStackPaddingBottom } = await renderShell({
    platform: 'ios',
    insets: { top: 59, bottom: 34 },
  });
  assert.equal(bottomStackPaddingBottom, '34px', 'a real reported inset above 20 wins over the fallback');
});

await test('web + reported bottom inset 0: bottom stack reserves exactly 0', async () => {
  const { bottomStack, bottomStackPaddingBottom } = await renderShell({
    platform: 'web',
    insets: { top: 0, bottom: 0 },
  });
  assert.ok(bottomStack, 'tabbed shell renders the bottom stack');
  assert.equal(bottomStackPaddingBottom, '0px', 'web keeps the true zero — no phantom 20px band');
});

await test('native + zero inset: tabbed content keeps SPACING.md only — the inset is not re-added to content', async () => {
  const { contentPaddingBottom } = await renderShell({
    platform: 'ios',
    insets: { top: 0, bottom: 0 },
  });
  assert.equal(
    contentPaddingBottom,
    `${SPACING.md}px`,
    'tabbed content must not absorb the bottom inset (that was the dead-void bug)',
  );
});

await test('tabless native shell absorbs the computed inset into content (no bottom stack)', async () => {
  const { bottomStack, contentPaddingBottom } = await renderShell({
    platform: 'ios',
    insets: { top: 0, bottom: 0 },
    bottomTabBar: false,
  });
  assert.equal(bottomStack, null, 'tabless shell renders no bottom stack');
  assert.equal(
    contentPaddingBottom,
    `${SPACING['3xl'] + LAYOUT.safeMobile}px`,
    'tabless content keeps SPACING.3xl plus the computed native fallback inset',
  );
});

console.log(`\nPassed ${passed} tests.`);
