#!/usr/bin/env node
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

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

// Import real shipped component & error boundary
const { AdSlot, AdSlotInner, AdSlotErrorBoundary, PRODUCTION_ADS_ENABLED } = await import('../src/components/AdSlot.tsx');
const { useAuthStore } = await import('../src/store/authStore.ts');

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function renderComponent(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  await flush();
  return {
    container,
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

console.log('── Real Component Render Test: AdSlot (CR DIC-1162 Blocker 1) ──');

await test('PRODUCTION_ADS_ENABLED flag default is false', async () => {
  assert.equal(PRODUCTION_ADS_ENABLED, false, 'Production ads flag must default to false');
});

await test('Absent serverValidatedRole renders null fail-closed (does not trust client authStore.role)', async () => {
  useAuthStore.setState({ role: 'free_user', isAuthenticated: true });
  const { container, cleanup } = await renderComponent(
    React.createElement(AdSlot, { testProvider: true, hasConsent: true })
  );
  try {
    assert.equal(container.querySelector('[data-testid^="ad-slot-"]'), null);
    assert.equal(container.innerHTML, '');
  } finally {
    await cleanup();
  }
});

await test('Null serverValidatedRole renders null fail-closed', async () => {
  useAuthStore.setState({ role: 'free_user', isAuthenticated: true });
  const { container, cleanup } = await renderComponent(
    React.createElement(AdSlot, { testProvider: true, hasConsent: true, serverValidatedRole: null })
  );
  try {
    assert.equal(container.querySelector('[data-testid^="ad-slot-"]'), null);
    assert.equal(container.innerHTML, '');
  } finally {
    await cleanup();
  }
});

await test('Missing CMP consent (hasConsent=false) renders null (fail-closed)', async () => {
  useAuthStore.setState({ role: 'free_user', isAuthenticated: true });
  const { container, cleanup } = await renderComponent(
    React.createElement(AdSlot, { testProvider: true, hasConsent: false, serverValidatedRole: 'free_user' })
  );
  try {
    assert.equal(container.querySelector('[data-testid^="ad-slot-"]'), null);
    assert.equal(container.innerHTML, '');
  } finally {
    await cleanup();
  }
});

await test('Server-validated subscriber role renders null (pro entitlement hide)', async () => {
  const { container, cleanup } = await renderComponent(
    React.createElement(AdSlot, { testProvider: true, hasConsent: true, serverValidatedRole: 'subscriber' })
  );
  try {
    assert.equal(container.querySelector('[data-testid^="ad-slot-"]'), null);
    assert.equal(container.innerHTML, '');
  } finally {
    await cleanup();
  }
});

await test('Unknown/invalid serverValidatedRole renders null (fail-closed)', async () => {
  const { container, cleanup } = await renderComponent(
    React.createElement(AdSlot, { testProvider: true, hasConsent: true, serverValidatedRole: 'unverified_role' })
  );
  try {
    assert.equal(container.querySelector('[data-testid^="ad-slot-"]'), null);
  } finally {
    await cleanup();
  }
});

await test('Explicit server-validated free_user with consent & testProvider renders test ad slot', async () => {
  const { container, cleanup } = await renderComponent(
    React.createElement(AdSlot, { testProvider: true, hasConsent: true, serverValidatedRole: 'free_user', slotId: 'footer_banner' })
  );
  try {
    const el = container.querySelector('[data-testid="ad-slot-footer_banner"]');
    assert.ok(el, 'Test ad container should render for explicit serverValidatedRole free_user');
    assert.ok(container.textContent.includes('贊助廣告'));
    assert.ok(container.textContent.includes('HoloHunter 低干擾測試廣告版位'));
  } finally {
    await cleanup();
  }
});

await test('AdSlotErrorBoundary catches child component crash and renders null fail-closed', async () => {
  const CrashingChild = () => {
    throw new Error('Simulated Component Crash during Ad Render');
  };
  
  const originalWarn = console.warn;
  console.warn = () => {};

  const { container, cleanup } = await renderComponent(
    React.createElement(
      AdSlotErrorBoundary,
      { fallback: null },
      React.createElement(CrashingChild)
    )
  );

  console.warn = originalWarn;

  try {
    assert.equal(container.innerHTML, '', 'Error boundary must render null fallback on crash');
  } finally {
    await cleanup();
  }
});

console.log(`\nAdSlot real component tests: ${passed} checks passed`);
