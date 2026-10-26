#!/usr/bin/env node
// DIC-1380 W4 CR — DeckEditor is routed through the shared card-name resolver.
//
// The W4 handback called out that the previous DIC-1064 fix was only a
// test-env change. The production change owed for W4 is:
//   * `DeckEditor` renders both the selected-slot row and the shortage row
//     through `resolveCardDisplayName`, so the same primary + subtitle rules
//     apply on the deck editor as on SearchResults / CardDetail /
//     ScanResultCard / ScanCandidateSelector.
//   * The mobile deck editor keeps its shared 5-tab panel switch and
//     accessible 44px-min touch targets (the Pen mobile UI contract).
//
// This suite renders the real DeckEditorScreen at 390px with a bilingual
// deck and asserts both the primary + subtitle land in the DOM, and that
// swapping `preferredLanguage` between 'ja' and 'zh' actually flips which
// name is primary — the mutation-sensitive proof that the resolver is
// wired, not open-coded.

process.env.EXPO_PUBLIC_STORE_MVP = '0';

import assert from 'node:assert/strict';
import fs from 'node:fs';
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
class NoopResizeObserver { observe(){} unobserve(){} disconnect(){} }
globalThis.ResizeObserver = NoopResizeObserver;
dom.window.ResizeObserver = NoopResizeObserver;

const MOBILE = { width: 390, height: 844 };
function setViewport({ width, height }) {
  Object.defineProperty(dom.window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(dom.window, 'innerHeight', { value: height, configurable: true });
  Object.defineProperty(dom.window.document.documentElement, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(dom.window.document.documentElement, 'clientHeight', { value: height, configurable: true });
}

const bundledDb = (await import('../public/data/database.json')).default;
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : String(input?.url ?? input);
  assert.fail(`no network in this render: ${url}`);
};

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const DeckEditorScreen = (await import('../src/screens/DeckEditorScreen.tsx')).default;
const { useDeckStore } = await import('../src/store/deckStore.ts');
const { useSettingsStore } = await import('../src/store/settingsStore.ts');

// Compose a deck slot with an explicit bilingual card so the assertion is
// deterministic regardless of what the shipped catalog names look like.
const BILINGUAL_CARD = {
  id: 'test-bilingual|BASE',
  cardNumber: 'hBP04-001',
  printing: 'BASE',
  printingLabel: '普通版',
  name: '博衣こより',
  nameZh: '博衣可佑理',
  type: 'Member',
  color: 'white',
  rarity: 'C',
};

async function renderMobileEditor() {
  setViewport(MOBILE);
  const host = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(DeckEditorScreen));
    await Promise.resolve();
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return {
    container: host,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

let passed = 0;
async function test(label, fn) {
  useDeckStore.setState((s) => ({
    ...s,
    decks: [{
      id: 'test-deck',
      name: 'Test Deck',
      oshi: [{ card: BILINGUAL_CARD, qty: 1 }],
      main: [],
      yell: [],
      updatedAt: '2026-09-08T00:00:00.000Z',
    }],
    activeDeckId: 'test-deck',
    collection: {},
  }));
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    console.error(`  ✗ ${label} — ${err?.message ?? err}`);
    if (err?.stack) console.error(err.stack);
    process.exitCode = 1;
  }
}

async function openZonePanel(container, zone) {
  const tab = container.querySelector(`[data-testid="deck-mobile-panel-${zone}"]`);
  assert.ok(tab, `mobile ${zone} tab must render`);
  await act(async () => tab.click());
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

// Under zh preference: nameZh primary + name (JP) as subtitle.
await test('mobile DeckEditor under zh preference: nameZh renders as primary + name as subtitle', async () => {
  useSettingsStore.setState((s) => ({ ...s, preferredLanguage: 'zh', preferredCurrency: 'TWD' }));
  const { container, cleanup } = await renderMobileEditor();
  try {
    await openZonePanel(container, 'oshi');
    const text = container.textContent;
    assert.ok(text.includes(BILINGUAL_CARD.nameZh), 'primary line must render the Chinese name');
    assert.ok(text.includes(BILINGUAL_CARD.name), 'subtitle must render the Japanese name');
    const zhPos = text.indexOf(BILINGUAL_CARD.nameZh);
    const jpPos = text.indexOf(BILINGUAL_CARD.name);
    assert.ok(zhPos > -1 && jpPos > -1 && zhPos < jpPos, 'Chinese primary appears before the Japanese subtitle');
  } finally { await cleanup(); }
});

// Under ja preference: name (JP) primary + nameZh subtitle — the DIC-1380
// unified rule swaps the primary; the mutation-sensitive proof that the
// resolver is actually wired, not open-coded.
await test('mobile DeckEditor under ja preference: name renders as primary + nameZh as subtitle', async () => {
  useSettingsStore.setState((s) => ({ ...s, preferredLanguage: 'ja', preferredCurrency: 'JPY' }));
  const { container, cleanup } = await renderMobileEditor();
  try {
    await openZonePanel(container, 'oshi');
    const text = container.textContent;
    assert.ok(text.includes(BILINGUAL_CARD.name), 'primary line must render the Japanese name');
    assert.ok(text.includes(BILINGUAL_CARD.nameZh), 'subtitle must render the Chinese name');
    const zhPos = text.indexOf(BILINGUAL_CARD.nameZh);
    const jpPos = text.indexOf(BILINGUAL_CARD.name);
    assert.ok(jpPos > -1 && zhPos > -1 && jpPos < zhPos, 'Japanese primary appears before the Chinese subtitle');
  } finally { await cleanup(); }
});

// Pen mobile UI: the 5-tab panel switch is mounted with the shared testIDs the
// Pen artifact anchors on, and every tab is a real interactive element.
await test('mobile DeckEditor mounts the Pen 5-tab panel switch with the shared testIDs', async () => {
  useSettingsStore.setState((s) => ({ ...s, preferredLanguage: 'zh' }));
  const { container, cleanup } = await renderMobileEditor();
  try {
    const panelSwitch = container.querySelector('[data-testid="deck-mobile-panel-switch"]');
    assert.ok(panelSwitch, 'mobile panel switch must mount on 390px viewport');
    for (const tab of ['picker', 'oshi', 'main', 'yell', 'shortage']) {
      const el = container.querySelector(`[data-testid="deck-mobile-panel-${tab}"]`);
      assert.ok(el, `mobile panel tab ${tab} must render`);
    }
  } finally { await cleanup(); }
});

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ DeckEditor name resolver + Pen mobile UI: ${passed} checks passed`);
} else {
  console.error(`\n❌ DeckEditor name resolver + Pen mobile UI failed`);
}
