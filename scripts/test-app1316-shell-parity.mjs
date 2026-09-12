#!/usr/bin/env node
// DIC-1409 Phase 6 mutation-sensitive tests: App 13 教學詳情 (TutorialDetail) /
// App 14 教學模擬 (TutorialSimulation) / App 15 設定 (Settings refinement) /
// App 16 登入 (Login/Auth) on the shared Pen v2 shell/tokens with real
// tutorial data, auth store actions, and navigation contracts intact.
//
// Pinned to Pen frames rV4Za / I6WwjY / x44r8t / p28zL.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
Object.defineProperty(dom.window.document.documentElement, 'clientHeight', { value: 844, configurable: true });
Object.defineProperty(dom.window, 'innerWidth', { value: 390, configurable: true });
Object.defineProperty(dom.window, 'innerHeight', { value: 844, configurable: true });

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { PALETTE } = await import('../src/theme/tokensV2.ts');

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function createRooter(element, container) {
  const root = createRoot(container);
  await act(async () => root.render(element));
  await flush();
  return {
    container,
    cleanup: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}
function hexToRgb(hex) {
  const v = hex.replace('#', '');
  return `rgb(${parseInt(v.slice(0, 2), 16)}, ${parseInt(v.slice(2, 4), 16)}, ${parseInt(v.slice(4, 6), 16)})`;
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('── DIC-1409 Phase 6 · App 13–16 shell parity ──');

// ── App / 13 教學詳情 (Pen rV4Za) ─────────────────────────────────────────

await test('TutorialDetail renders in the shell with the real chapter title and goBack dispatch', async () => {
  const { getTutorialData } = await import('../src/data/tutorialData.ts');
  const sections = getTutorialData('zh');
  assert.ok(sections.length >= 3, 'real tutorial dataset present');
  const target = sections[1];
  const { default: TutorialDetailScreen } = await import('../src/screens/TutorialDetailScreen.tsx');
  const events = [];
  const container = document.createElement('div');
  document.body.appendChild(container);
  const { container: c, cleanup } = await createRooter(
    React.createElement(TutorialDetailScreen, {
      route: { params: { sectionId: target.id } },
      navigation: { navigate: () => {}, goBack: () => events.push('goBack') },
    }),
    container,
  );
  try {
    assert.ok(c.querySelector('[data-testid="tutorial-detail-shell"]'), 'shell root');
    assert.equal(
      c.querySelector('[data-testid="shell-app-bar-title"]').textContent,
      target.title,
      'Pen app bar carries the real chapter title (node DEchs)',
    );
    const homeTab = c.querySelector('[data-testid="shell-bottom-tab-home"]');
    assert.equal(homeTab.getAttribute('aria-selected'), 'true', 'TutorialDetail folds onto 首頁');
    assert.ok(
      c.querySelector(`[data-testid="tutorial-detail-content-${target.id}"]`),
      'route param drives the real section content (existing testID contract)',
    );
    await act(async () => c.querySelector('[data-testid="tutorial-detail-shell-back"]').click());
    assert.deepEqual(events, ['goBack']);
  } finally { await cleanup(); }
});

// ── App / 14 教學模擬 (Pen I6WwjY) ────────────────────────────────────────

await test('TutorialSimulation renders in the shell with real phase steps and progression intact', async () => {
  const { default: TutorialSimulationScreen } = await import('../src/screens/TutorialSimulationScreen.tsx');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const { container: c, cleanup } = await createRooter(
    React.createElement(TutorialSimulationScreen, {
      navigation: { navigate: () => {}, goBack: () => {} },
    }),
    container,
  );
  try {
    assert.ok(c.querySelector('[data-testid="tutorial-simulation-shell"]'), 'shell root');
    assert.ok(c.querySelector('[data-testid="tutorial-simulation-content"]'), 'existing content testID intact');
    const step = c.querySelector('[data-testid^="tutorial-simulation-step-"]');
    assert.ok(step, 'real simulation step renders from the shipped dataset');
    const homeTab = c.querySelector('[data-testid="shell-bottom-tab-home"]');
    assert.equal(homeTab.getAttribute('aria-selected'), 'true', 'TutorialSimulation folds onto 首頁');
  } finally { await cleanup(); }
});

// ── App / 15 設定 (Pen x44r8t) — grouped-card refinement ─────────────────

await test('Settings sections carry the Pen x44r8t group-card composition (source contract)', () => {
  const src = readFileSync(new URL('../src/screens/SettingsScreen.tsx', import.meta.url), 'utf8');
  assert.match(
    src,
    /section:\s*\{[^}]*backgroundColor:\s*PALETTE\.appSurface[^}]*borderRadius:\s*14/s,
    'sections are $app-surface r14 group cards (Pen nodes Qpkox/Vp4g7/phxwj)',
  );
  assert.match(
    src,
    /sectionTitle:\s*\{[^}]*fontSize:\s*11[^}]*fontWeight:\s*'700'/s,
    'section headings are the Pen 11/700 muted labels (nodes U2n8Jp/sed7I/Ld7b7)',
  );
  // No second shell layered on the App 07 composition.
  assert.equal((src.match(/<AppShell/g) || []).length, 1, 'exactly one AppShell in Settings');
  assert.ok(!src.includes('<RouteShell'), 'Settings refines the existing shell, no RouteShell layering');
});

// ── App / 16 登入 (Pen p28zL) — real auth store ───────────────────────────

await test('Login renders the Pen v2 auth surface with no tab bar and full-profile copy', async () => {
  const { default: LoginScreen } = await import('../src/screens/LoginScreen.tsx');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const { container: c, cleanup } = await createRooter(React.createElement(LoginScreen), container);
  try {
    assert.ok(c.querySelector('[data-testid="login-shell"]'), 'login root');
    assert.ok(c.querySelector('[data-testid="shell-status-bar"]'), 'status bar (Pen p28zL keeps it)');
    assert.equal(c.querySelector('[data-testid="shell-bottom-tab-bar"]'), null, 'no tab bar in the Pen auth frame');
    assert.ok(c.querySelector('[data-testid="login-logo-tile"]'), 'Pen logo tile (node FTEuu)');
    const google = c.querySelector('[data-testid="login-google"]');
    assert.ok(google, 'Google button renders');
    const style = dom.window.getComputedStyle(google);
    assert.equal(style.backgroundColor, 'rgb(255, 255, 255)', 'Pen white Google button (node ilZGG)');
    assert.equal(style.borderTopLeftRadius, '14px', 'Pen r14 button corner');
    assert.ok(c.textContent.includes('登入後可'), 'full-profile login description renders (STORE_MVP=0 swap intact)');
  } finally { await cleanup(); }
});

await test('Login guest action drives the real auth store (continueAsGuest mutation)', async () => {
  const { useAuthStore } = await import('../src/store/authStore.ts');
  const { default: LoginScreen } = await import('../src/screens/LoginScreen.tsx');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const { container: c, cleanup } = await createRooter(React.createElement(LoginScreen), container);
  try {
    assert.equal(useAuthStore.getState().isGuest, false, 'fresh store starts non-guest');
    await act(async () => c.querySelector('[data-testid="login-guest"]').click());
    assert.equal(useAuthStore.getState().isGuest, true, 'guest press mutates the real auth store');
  } finally {
    await cleanup();
  }
});

console.log(`\nPassed ${passed} tests.`);
