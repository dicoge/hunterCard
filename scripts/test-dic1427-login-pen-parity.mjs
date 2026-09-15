#!/usr/bin/env node
// DIC-1427 QA P0 — Pen `App / 16 登入` (frame p28zL): the Pen auth surface
// must be a REAL, REACHABLE state while the living auth gate stays intact.
//
// Before this fix the Pen-styled LoginScreen existed only as an unmounted
// seam — unauthenticated visitors landed on the marketing Landing with no
// route to the Pen login state at all. These tests pin:
//   • the Landing exposes a real 登入 entry that navigates to the AuthLogin
//     stack screen (gate preserved: still the unauthenticated stack);
//   • LoginScreen carries the Pen identity (開始獵卡之旅 headline, brand
//     label, white Google button) with REAL auth-store actions;
//   • truthfulness: no 使用電子郵件 button (the product has no email auth)
//     and Apple only renders behind the real APPLE_LOGIN_ENABLED gate.

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

process.env.EXPO_PUBLIC_STORE_MVP = '0';

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
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = TestResizeObserver;
dom.window.ResizeObserver = TestResizeObserver;
Object.defineProperty(dom.window.document.documentElement, 'clientWidth', { value: 390, configurable: true });
Object.defineProperty(dom.window, 'innerWidth', { value: 390, configurable: true });

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: LandingScreen } = await import('../src/screens/LandingScreen.tsx');
const { default: LoginScreen } = await import('../src/screens/LoginScreen.tsx');
const { APPLE_LOGIN_ENABLED } = await import('../src/services/authService.ts');

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function render(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  await flush();
  return {
    container,
    cleanup: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('── DIC-1427 · App 16 登入 Pen p28zL reachability + parity ──');

await test('Landing exposes a real 登入 entry that routes to the Pen AuthLogin screen (mobile menu)', async () => {
  const events = [];
  const { container, cleanup } = await render(React.createElement(LandingScreen, {
    navigation: { navigate: (r) => events.push(r), goBack() {} },
  }));
  try {
    const menuBtn = container.querySelector('[data-testid="landing-mobile-menu-btn"]');
    assert.ok(menuBtn, 'mobile menu button');
    await act(async () => menuBtn.click());
    const loginEntry = container.querySelector('[data-testid="landing-menu-login"]');
    assert.ok(loginEntry, '登入 entry in the mobile menu');
    await act(async () => loginEntry.click());
    assert.deepEqual(events, ['AuthLogin'], '登入 navigates to the AuthLogin stack screen');
  } finally { await cleanup(); }
});

await test('LoginScreen carries the Pen p28zL identity with the real action set', async () => {
  const { container, cleanup } = await render(React.createElement(LoginScreen, {
    navigation: { goBack() {} },
  }));
  try {
    assert.ok(container.querySelector('[data-testid="login-shell"]'), 'login root');
    assert.ok(container.textContent.includes('開始獵卡之旅'), 'Pen headline (node tumk0)');
    assert.ok(container.querySelector('[data-testid="login-logo-tile"]'), 'Pen logo tile (node FTEuu)');
    assert.ok(container.querySelector('[data-testid="login-google"]'), 'real Google action (node ilZGG)');
    assert.ok(container.querySelector('[data-testid="login-guest"]'), 'real guest action (node qfrcy)');

    // Truthfulness: the Pen frame shows an email option the product does not
    // have — it must NOT be faked into the shipped screen.
    assert.ok(!container.textContent.includes('使用電子郵件'), 'no fake email-auth button');
    const apple = container.querySelector('[data-testid="login-apple"]');
    if (APPLE_LOGIN_ENABLED) {
      assert.ok(apple, 'Apple renders because the real gate is open');
    } else {
      assert.equal(apple, null, 'Apple stays hidden while the real gate is closed');
    }
  } finally { await cleanup(); }
});

await test('LoginScreen back affordance returns to the Landing (gate preserved)', async () => {
  const events = [];
  const { container, cleanup } = await render(React.createElement(LoginScreen, {
    navigation: { goBack: () => events.push('back') },
  }));
  try {
    const back = container.querySelector('[data-testid="login-back"]');
    assert.ok(back, 'back affordance renders when the screen is pushed');
    await act(async () => back.click());
    assert.deepEqual(events, ['back']);
  } finally { await cleanup(); }
});

console.log(`\nPassed ${passed} tests.`);
