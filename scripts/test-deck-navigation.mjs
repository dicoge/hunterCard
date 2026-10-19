#!/usr/bin/env node
// 牌組 navigation (user 2026-10-19) on the REAL navigator tree (root stack + MainDrawer +
// the DeckEditor stack DeckList → DeckDetail): list entry, create/open push the editor
// route, app-bar back / Android back (stack pop) / web browser back return to the list,
// tab re-entry lands on the list, card-detail 加入牌組 handoff, decks kept. Harness copied
// from test-shell-tab-navigation.mjs (jsdom + react-native-web). No device.
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
class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = NoopResizeObserver;
dom.window.ResizeObserver = NoopResizeObserver;
if (!dom.window.matchMedia) {
  dom.window.matchMedia = () => ({
    matches: false,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
  });
  globalThis.matchMedia = dom.window.matchMedia;
}
Object.defineProperty(dom.window, 'innerWidth', { value: 390, configurable: true });
Object.defineProperty(dom.window, 'innerHeight', { value: 844, configurable: true });
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { NavigationContainer, createNavigationContainerRef } = await import('@react-navigation/native');
const { StackNavigator } = await import('../src/navigation/AppNavigator.tsx');

const byTestId = (id) => dom.window.document.querySelector(`[data-testid="${id}"]`);
const click = async (el) => {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  await settle();
};
const settle = async () => {
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

let passed = 0;
async function test(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    process.exitCode = 1;
    console.error(`  ✗ ${label} — ${err.message}`);
  }
}


const { useDeckStore } = await import('../src/store/deckStore.ts');
const navRef = createNavigationContainerRef();
const host = dom.window.document.createElement('div');
dom.window.document.body.appendChild(host);
const root = createRoot(host);
useDeckStore.setState({ decks: [], activeDeckId: null });
await act(async () => {
  root.render(React.createElement(NavigationContainer, { ref: navRef }, React.createElement(StackNavigator)));
  await Promise.resolve();
});
await settle();
const route = () => navRef.getCurrentRoute();
// the DeckEditor stack's own route list (DeckList / DeckDetail)
const deckStackRoutes = () => {
  const findStack = (state) => {
    if (!state) return null;
    for (const r of state.routes) {
      if (r.name === 'DeckEditor') return r.state?.routes?.map((x) => x.name) ?? [];
      const inner = findStack(r.state);
      if (inner) return inner;
    }
    return null;
  };
  return findStack(navRef.getRootState());
};
const waitFor = async (cond, n = 40) => { for (let i = 0; i < n && !cond(); i++) await settle(); };
const byText = (text) => [...dom.window.document.querySelectorAll('[role="button"], [tabindex]')].find((el) => el.textContent.trim() === text);
const deckTab = () => byTestId('shell-bottom-tab-deck');
const homeTab = () => byTestId('shell-bottom-tab-home');

await test('牌組 tab opens the deck LIST (entry route DeckList); an empty list creates NO deck', async () => {
  await click(homeTab());
  await click(deckTab());
  await waitFor(() => byTestId('deck-library-grid'));
  assert.equal(route()?.name, 'DeckList');
  assert.ok(byTestId('deck-library-grid'), 'deck list rendered');
  for (let i = 0; i < 10; i++) await settle();
  assert.equal(useDeckStore.getState().decks.length, 0, 'no phantom deck');
});

let deckId;
await test('建立 pushes the editor route DeckDetail({deckId}) over DeckList', async () => {
  const create = byText('建立');
  assert.ok(create, '建立 button');
  await click(create);
  await waitFor(() => route()?.name === 'DeckDetail');
  deckId = useDeckStore.getState().decks[0]?.id;
  assert.ok(deckId, 'a deck was created by the explicit action');
  assert.equal(route()?.name, 'DeckDetail');
  assert.equal(route()?.params?.deckId, deckId);
  assert.deepEqual(deckStackRoutes(), ['DeckList', 'DeckDetail'], 'editor stacked on the list');
  assert.equal(useDeckStore.getState().activeDeckId, deckId, 'store edits target the route deck');
});

await test('editor app-bar ‹ pops back to the deck list (not out of 牌組); the deck is kept', async () => {
  const back = byTestId('deck-mobile-appbar-back');
  assert.ok(back, 'app-bar back');
  await click(back);
  await waitFor(() => route()?.name === 'DeckList');
  assert.equal(route()?.name, 'DeckList');
  assert.deepEqual(deckStackRoutes(), ['DeckList']);
  assert.equal(useDeckStore.getState().decks.length, 1);
  assert.equal(useDeckStore.getState().activeDeckId, null);
});

await test('open from the list pushes DeckDetail; the stack pop (what Android hardware back performs) returns to the list', async () => {
  await click(byTestId(`deck-open-${deckId}`));
  await waitFor(() => route()?.name === 'DeckDetail');
  assert.equal(route()?.name, 'DeckDetail');
  await act(async () => { navRef.goBack(); });
  await settle();
  assert.equal(route()?.name, 'DeckList');
});

await test('web browser back on an open deck returns to the list (deck history entry)', async () => {
  await click(byTestId(`deck-open-${deckId}`));
  await waitFor(() => route()?.name === 'DeckDetail');
  assert.equal(dom.window.history.state?.hhDeckDetail, deckId, 'the open deck owns a history entry');
  await act(async () => { dom.window.history.back(); });
  await waitFor(() => route()?.name === 'DeckList');
  assert.equal(route()?.name, 'DeckList');
  assert.deepEqual(deckStackRoutes(), ['DeckList'], 'browser back popped the editor route');
  assert.notEqual(dom.window.history.state?.hhDeckDetail, deckId);
  assert.equal(useDeckStore.getState().decks.length, 1);
});

await test('tab re-entry: open deck → 首頁 tab → 牌組 tab lands on the deck LIST; deck kept', async () => {
  await click(byTestId(`deck-open-${deckId}`));
  await waitFor(() => route()?.name === 'DeckDetail');
  await click(homeTab());
  assert.equal(route()?.name, 'Home');
  await click(deckTab());
  await waitFor(() => route()?.name === 'DeckList');
  assert.equal(route()?.name, 'DeckList');
  assert.deepEqual(deckStackRoutes(), ['DeckList'], 'no editor lingers under the list (back leaves 牌組)');
  assert.equal(useDeckStore.getState().decks.length, 1);
});

await test('card detail 加入牌組 handoff: list carries the card number into the opened deck (picker pre-filtered)', async () => {
  await act(async () => { navRef.navigate('MainDrawer', { screen: 'DeckEditor', params: { screen: 'DeckList', params: { addCardNumber: 'hBP01-010' } } }); });
  await waitFor(() => route()?.name === 'DeckList');
  assert.equal(route()?.params?.addCardNumber, 'hBP01-010');
  await click(byTestId(`deck-open-${deckId}`));
  await waitFor(() => route()?.name === 'DeckDetail');
  assert.equal(route()?.params?.deckId, deckId);
  assert.equal(route()?.params?.addCardNumber, 'hBP01-010', 'handoff reaches the editor');
});

await test('a deck deleted elsewhere (e.g. sync) closes its editor back to the list', async () => {
  assert.equal(route()?.name, 'DeckDetail');
  await act(async () => { useDeckStore.getState().deleteDeck(deckId); });
  await waitFor(() => route()?.name === 'DeckList');
  assert.equal(route()?.name, 'DeckList');
});

await act(async () => root.unmount());
if ((process.exitCode ?? 0) === 0) console.log(`\n✅ deck-navigation (real navigator): ${passed} checks passed`);
else console.error('\n❌ deck-navigation failed');
process.exit();
