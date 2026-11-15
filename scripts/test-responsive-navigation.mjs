#!/usr/bin/env node
// 2026-11-03 responsive navigation — mounts the REAL nested navigator
// (root stack + MainDrawer + shipped screens), like test-shell-tab-navigation,
// and drives the window width through mobile / tablet / desktop:
//   • <768 (mobile web): drawer-hosted screens keep the Pen H8TW7 bottom bar,
//     whose five slots now fit the 390 bar (no 402px overflow) with ≥44px
//     touch targets;
//   • ≥768 (permanent 260px drawer): drawer-hosted screens draw NO bottom bar —
//     the sidebar is the single global navigation (no duplicate nav);
//   • ≥768 root-stack screens (SearchResults / TutorialDetail / Tutorial
//     Simulation, outside the drawer) keep the SAME tab registry as a compact
//     centred dock (max 390), so global navigation stays reachable there;
//   • width transitions in both directions re-render the chrome;
//   • safe area is applied once (bottom stack OR tabless content, never both).
// No network, no images, no account writes.

process.env.EXPO_PUBLIC_STORE_MVP = '0';

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
  dom.window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  globalThis.matchMedia = dom.window.matchMedia;
}
// One mutable viewport behind every width source react-native-web may read.
let W = 390;
let VH = 844;
for (const [obj, key, get] of [
  [dom.window, 'innerWidth', () => W], [dom.window, 'innerHeight', () => VH],
  [dom.window.document.documentElement, 'clientWidth', () => W],
  [dom.window.document.documentElement, 'clientHeight', () => VH],
]) Object.defineProperty(obj, key, { get, configurable: true });
// R3 (review B1): react-native-web's Dimensions reads the width from
// window.visualViewport and subscribes ONLY to its 'resize' event when it
// exists. The stub therefore keeps real listeners and setWidth() delivers the
// resize to them (and to window), so Dimensions really follows each width.
const vvListeners = new Map(); // type -> Set<listener>
const visualViewportStub = {
  get width() { return W; }, get height() { return VH; }, scale: 1,
  addEventListener(type, fn) { if (!vvListeners.has(type)) vvListeners.set(type, new Set()); vvListeners.get(type).add(fn); },
  removeEventListener(type, fn) { vvListeners.get(type)?.delete(fn); },
  dispatchEvent(event) {
    for (const fn of [...(vvListeners.get(event.type) ?? [])]) (typeof fn === 'function' ? fn : fn.handleEvent).call(visualViewportStub, event);
    return true;
  },
};
Object.defineProperty(dom.window, 'visualViewport', { value: visualViewportStub, configurable: true });
// Every request is answered locally (404) and recorded; no network is reachable.
const fetchCalls = [];
globalThis.fetch = async (input) => { fetchCalls.push(String(input)); return { ok: false, status: 404, json: async () => ({}), text: async () => '' }; };

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Dimensions, Platform, Text } = await import('react-native');
const { NavigationContainer, createNavigationContainerRef } = await import('@react-navigation/native');
const { StackNavigator } = await import('../src/navigation/AppNavigator.tsx');
const AppShell = (await import('../src/components/shell/AppShell.tsx')).default;
const { DrawerHostContext, resolveShellNavMode, drawerPresentation, isPermanentDrawer } = await import('../src/components/shell/navigationChrome.ts');
const { DESKTOP_BREAKPOINT } = await import('../src/hooks/useBreakpoint.ts');
const fs = await import('node:fs');
const { TAB_BAR_DOCK_MAX_WIDTH } = await import('../src/components/shell/BottomTabBar.tsx');
const { __setSafeAreaInsetsForTest } = await import('react-native-safe-area-context');
const { LAYOUT, SPACING } = await import('../src/theme/tokensV2.ts');

const doc = dom.window.document;
const css = (el) => dom.window.getComputedStyle(el);
// R4: navigators keep non-active screens MOUNTED. @react-navigation/native-stack
// (web) renders every route of the stack and hides all but the focused one with
// `display: none` (NativeStackView.js:93–94); the drawer hides inactive screens
// the same way. A retained, hidden dock is history, not visible navigation, so
// every navigation assertion is scoped to elements whose whole ancestry is
// actually shown — never to raw DOM counts — and clicks can only reach those.
function hiddenBy(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const s = css(n);
    if (s.display === 'none' || s.visibility === 'hidden' || n.getAttribute('aria-hidden') === 'true') {
      return n.getAttribute('data-testid') || n.tagName.toLowerCase();
    }
  }
  return null;
}
const isShown = (el) => hiddenBy(el) === null;
const allByTestId = (id) => [...doc.querySelectorAll(`[data-testid="${id}"]`)];
/** The single VISIBLE element with this testID (fails on visible duplicates). */
function byTestId(id) {
  const shown = allByTestId(id).filter(isShown);
  assert.ok(shown.length <= 1, `duplicate VISIBLE [${id}] ×${shown.length}\n${navDiag()}`);
  return shown[0] ?? null;
}
/** Visible global bottom navigation (bar or dock). Hidden retained screens excluded. */
const bars = () => allByTestId('shell-bottom-tab-bar').filter(isShown);
function navDiag() {
  const st = navRef.getRootState?.();
  const walk = (s) => (s ? s.routes.map((r, i) => `${i === s.index ? '*' : ''}${r.name}${r.state ? `[${walk(r.state)}]` : ''}`).join(',') : '');
  const mounted = allByTestId('shell-bottom-tab-bar').map((b, i) => `  bar#${i}: ${isShown(b) ? 'VISIBLE' : `hidden by ${hiddenBy(b)}`}`);
  return `root state: ${walk(st)}\nfocused: ${navRef.getCurrentRoute()?.name}\nmounted bars:\n${mounted.join('\n') || '  (none)'}`;
}
/** Exactly `n` visible global navigation bars, with a clear diagnosis when not. */
function expectBars(n, msg) {
  assert.equal(bars().length, n, `${msg}: expected ${n} visible global nav, got ${bars().length}\n${navDiag()}`);
}
const settle = async () => {
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const click = async (el) => {
  await act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })); await Promise.resolve(); });
  await settle();
};
async function setWidth(width) {
  W = width;
  // react-native-web must have subscribed to the viewport (B1 precondition).
  assert.ok((vvListeners.get('resize')?.size ?? 0) > 0, 'react-native-web Dimensions subscribed to visualViewport resize');
  await act(async () => {
    visualViewportStub.dispatchEvent(new dom.window.Event('resize'));
    dom.window.dispatchEvent(new dom.window.Event('resize'));
  });
  await settle();
  // Fail loudly if the harness cannot drive the width (never a silent pass).
  assert.equal(Dimensions.get('window').width, width, `window width must follow the test viewport (${width})`);
}

let passed = 0;
async function test(label, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${label}`); } catch (err) { process.exitCode = 1; console.error(`  ✗ ${label} — ${err.message}`); }
}

// ── pure mode resolution (the single rule) ────────────────────────────────
await test('nav mode: native always keeps bottom tabs; web <768 tabs; web ≥768 drawer screens → drawer, root-stack → dock', () => {
  for (const isDesktop of [false, true]) for (const inDrawer of [false, true]) {
    assert.equal(resolveShellNavMode({ platform: 'ios', isDesktop, inDrawer }), 'bottom-tabs');
    assert.equal(resolveShellNavMode({ platform: 'android', isDesktop, inDrawer }), 'bottom-tabs');
  }
  assert.equal(resolveShellNavMode({ platform: 'web', isDesktop: false, inDrawer: true }), 'bottom-tabs');
  assert.equal(resolveShellNavMode({ platform: 'web', isDesktop: false, inDrawer: false }), 'bottom-tabs');
  assert.equal(resolveShellNavMode({ platform: 'web', isDesktop: true, inDrawer: true }), 'drawer');
  assert.equal(resolveShellNavMode({ platform: 'web', isDesktop: true, inDrawer: false }), 'dock');
});

// R2: drawer presentation and shell mode share ONE condition. Pure truth table
// over platform × width (incl. a 390×844 phone rotated to 844 landscape and a
// 1024 tablet). Native is not rendered here — this proves the decision the
// MainDrawer options are built from, not an OS-level render.
await test('drawer truth table: permanent sidebar ONLY on web ≥768; native phones (portrait/landscape) and tablets keep the overlay drawer', () => {
  assert.equal(DESKTOP_BREAKPOINT, 768);
  const isDesktop = (w) => w >= DESKTOP_BREAKPOINT;
  for (const platform of ['ios', 'android']) {
    for (const w of [360, 390, 767, 768, 844, 932, 1024, 1366]) {
      const p = drawerPresentation({ platform, isDesktop: isDesktop(w) });
      assert.deepEqual(p, { drawerType: 'front', width: 280, borderRightWidth: 0 }, `${platform} @${w}: overlay drawer`);
      for (const inDrawer of [true, false]) {
        assert.equal(resolveShellNavMode({ platform, isDesktop: isDesktop(w), inDrawer }), 'bottom-tabs', `${platform} @${w}: touch bottom tabs kept`);
      }
    }
  }
  for (const [w, permanent] of [[390, false], [767, false], [768, true], [844, true], [1024, true], [1440, true]]) {
    assert.equal(isPermanentDrawer({ platform: 'web', isDesktop: isDesktop(w) }), permanent, `web @${w}`);
    const p = drawerPresentation({ platform: 'web', isDesktop: isDesktop(w) });
    assert.equal(p.drawerType, permanent ? 'permanent' : 'front');
    // Consistency: a permanent sidebar never coexists with a drawer-page bottom bar, and vice versa.
    assert.equal(resolveShellNavMode({ platform: 'web', isDesktop: isDesktop(w), inDrawer: true }), permanent ? 'drawer' : 'bottom-tabs');
  }
});

await test('AppNavigator builds MainDrawer options from the shared rule (no separate isDesktop drawer condition left)', () => {
  const src = fs.readFileSync(new URL('../src/navigation/AppNavigator.tsx', import.meta.url), 'utf8');
  assert.match(src, /drawerPresentation\(\{ platform: Platform\.OS, isDesktop \}\)/);
  assert.match(src, /drawerType: drawer\.drawerType/);
  assert.doesNotMatch(src, /drawerType: isDesktop \?/);
});

// ── real nested navigator ──────────────────────────────────────────────────
const navRef = createNavigationContainerRef();
const host = doc.createElement('div');
doc.body.appendChild(host);
const root = createRoot(host);
await act(async () => {
  root.render(React.createElement(NavigationContainer, { ref: navRef }, React.createElement(StackNavigator)));
  await Promise.resolve();
});
await settle();
await setWidth(390);

await test('390 mobile: Home (drawer child) shows the full-width bottom bar; slots fit the bar with ≥44px touch targets', async () => {
  assert.ok(byTestId('home-shell'), 'Home mounts');
  assert.equal(navRef.getCurrentOptions()?.drawerType, 'front', 'mobile drawer is the overlay drawer');
  const bar = byTestId('shell-bottom-tab-bar-bar');
  assert.ok(bar, 'bottom bar present on mobile');
  assert.notEqual(css(bar).maxWidth, `${TAB_BAR_DOCK_MAX_WIDTH}px`, 'mobile uses the full (edge-to-edge) variant');
  const slots = ['home', 'search', 'deck', 'me'].map((k) => byTestId(`shell-bottom-tab-${k}`));
  for (const s of slots) {
    assert.ok(s, 'tab slot present');
    const st = css(s);
    assert.notEqual(st.width, '78px', 'slots no longer have a fixed 78px width (that overflowed to x=402 at 390)');
    assert.equal(st.maxWidth, '78px');
    assert.equal(st.minWidth, `${LAYOUT.minTouch}px`);
    assert.equal(st.minHeight, `${LAYOUT.minTouch}px`, 'touch target ≥ 44px tall');
    assert.equal(s.getAttribute('role'), 'tab');
    assert.ok(s.getAttribute('aria-label'), 'tab keeps its accessible label');
  }
  assert.equal(byTestId('shell-bottom-tab-home').getAttribute('aria-selected'), 'true', 'selected state kept');
  const padX = parseFloat(css(bar).paddingLeft) + parseFloat(css(bar).paddingRight);
  assert.ok(5 * LAYOUT.minTouch + padX <= 390, 'five minimum-width slots plus padding fit a 390 bar');
  assert.ok(5 * 78 + padX > 390, 'precondition: the old fixed 5×78 layout did overflow a 390 bar');
});

await test('390 → 1440: Home switches to the permanent drawer and draws NO bottom bar (single global nav)', async () => {
  await setWidth(1440);
  assert.equal(navRef.getCurrentRoute()?.name, 'Home');
  assert.equal(navRef.getCurrentOptions()?.drawerType, 'permanent', 'desktop drawer is the permanent sidebar');
  expectBars(0, 'no bottom tab bar on a drawer-hosted desktop page');
  // R4: Home's shell is scrollable — `shell-content` is the OUTER ScrollView
  // (no padding); AppShell's contentContainerStyle (incl. the trailing
  // padding) is on the ScrollView's INNER content container, its first child.
  const content = byTestId('shell-content');
  assert.ok(content, 'content region present');
  const inner = content.firstElementChild;
  assert.ok(inner, 'ScrollView content container present');
  assert.equal(css(inner).paddingBottom, `${SPACING['3xl']}px`, 'tabless desktop content keeps its 24px trailing space (last row not flush/obscured)');
});

await test('desktop drawer routes stay reachable via the registry: Scan, Collection, DeckEditor, Me', async () => {
  for (const screen of ['Scan', 'Collection', 'DeckEditor', 'Me', 'Home']) {
    await act(async () => { navRef.navigate('MainDrawer', { screen }); });
    await settle();
    const got = navRef.getCurrentRoute()?.name;
    assert.ok(got === screen || (screen === 'DeckEditor' && got === 'DeckList'), `expected ${screen}, got ${got}`);
    expectBars(0, `${screen}: no duplicate bottom bar beside the permanent drawer`);
  }
});

await test('1440 root-stack SearchResults: exactly one global nav — the centred dock — and its tabs still navigate', async () => {
  await act(async () => { navRef.navigate('SearchResults', { query: 'すいせい' }); });
  await settle();
  assert.equal(navRef.getCurrentRoute()?.name, 'SearchResults');
  expectBars(1, 'root-stack page keeps one bottom navigation');
  assert.equal(css(byTestId('shell-bottom-tab-bar-bar')).maxWidth, `${TAB_BAR_DOCK_MAX_WIDTH}px`, 'desktop root-stack uses the 390 dock, not a stretched bar');
  assert.equal(byTestId('shell-bottom-tab-search').getAttribute('aria-selected'), 'true');
  await click(byTestId('shell-bottom-tab-home'));
  assert.equal(navRef.getCurrentRoute()?.name, 'Home');
  expectBars(0, 'back on a drawer page: dock gone, drawer only');
});

await test('1024 tablet root-stack TutorialDetail: dock present; 牌組 tab → DeckList (drawer page, no bar)', async () => {
  await setWidth(1024);
  await act(async () => { navRef.navigate('TutorialDetail', { sectionId: 'section-1' }); });
  await settle();
  assert.equal(navRef.getCurrentRoute()?.name, 'TutorialDetail');
  expectBars(1, 'TutorialDetail dock');
  assert.equal(css(byTestId('shell-bottom-tab-bar-bar')).maxWidth, `${TAB_BAR_DOCK_MAX_WIDTH}px`);
  await click(byTestId('shell-bottom-tab-deck'));
  assert.equal(navRef.getCurrentRoute()?.name, 'DeckList');
  expectBars(0, 'DeckList is a drawer page');
});

await test('768 tablet root-stack TutorialSimulation keeps the dock; 767 switches back to the mobile bar', async () => {
  await setWidth(768);
  await act(async () => { navRef.navigate('TutorialSimulation'); });
  await settle();
  assert.equal(navRef.getCurrentRoute()?.name, 'TutorialSimulation');
  expectBars(1, 'TutorialSimulation dock @768');
  assert.equal(css(byTestId('shell-bottom-tab-bar-bar')).maxWidth, `${TAB_BAR_DOCK_MAX_WIDTH}px`);
  await setWidth(767);
  assert.equal(navRef.getCurrentRoute()?.name, 'TutorialSimulation');
  // R4: exact — only the focused page's bar is visible (was `>= 1` over all mounted screens).
  expectBars(1, 'TutorialSimulation full bar @767');
  assert.notEqual(css(byTestId('shell-bottom-tab-bar-bar')).maxWidth, `${TAB_BAR_DOCK_MAX_WIDTH}px`, 'below 768 the full mobile bar returns');
});

await test('1440 → 390 on a drawer page: the mobile bar comes back (resize/orientation transition)', async () => {
  await act(async () => { navRef.navigate('MainDrawer', { screen: 'Home' }); });
  await setWidth(1440);
  assert.equal(navRef.getCurrentRoute()?.name, 'Home');
  expectBars(0, 'Home @1440');
  await setWidth(390);
  assert.equal(navRef.getCurrentRoute()?.name, 'Home');
  expectBars(1, 'Home @390');
  assert.ok(byTestId('shell-bottom-tab-home'), 'mobile bar back on Home');
  assert.equal(navRef.getCurrentOptions()?.drawerType, 'front');
});

await test('768 boundary in both directions on a drawer page: 767 bar+overlay, 768 sidebar only, 767 again', async () => {
  for (const [w, permanent] of [[767, false], [768, true], [767, false]]) {
    await setWidth(w);
    assert.equal(navRef.getCurrentRoute()?.name, 'Home');
    assert.equal(navRef.getCurrentOptions()?.drawerType, permanent ? 'permanent' : 'front', `@${w}`);
    expectBars(permanent ? 0 : 1, `Home @${w}`);
    if (!permanent) assert.ok(byTestId('shell-bottom-tab-home'), `@${w}: bottom tabs present`);
  }
});

await test('web phone rotated to landscape (844×390): web is ≥768 → sidebar only, no bottom bar; back to 390×844 restores the bar', async () => {
  VH = 390;
  await setWidth(844);
  assert.equal(navRef.getCurrentOptions()?.drawerType, 'permanent');
  expectBars(0, 'landscape 844');
  VH = 844;
  await setWidth(390);
  expectBars(1, 'portrait 390');
  assert.ok(byTestId('shell-bottom-tab-home'));
});

// R2: CardDetail is a root-stack page that by design has NO tab bar — it keeps
// its back arrow and its own action bar. Real catalog row (image fields
// blanked, printing fixed so no art URL is derived) → no image request.
const DB = JSON.parse(fs.readFileSync(new URL('../public/data/database.json', import.meta.url), 'utf8'));
const row = Object.values(DB.cards).find((c) => c && c.cardNumber);
const CARD = { ...row, images: [], imageUrl: '', officialImage: '', localImage: '', printing: row.printing || 'BASE' };
async function openCardDetailFrom(width, origin) {
  await setWidth(width);
  if (origin === 'SearchResults') await act(async () => { navRef.navigate('SearchResults', { query: CARD.cardNumber }); });
  else await act(async () => { navRef.navigate('MainDrawer', { screen: 'Home' }); });
  await settle();
  const before = fetchCalls.length;
  await act(async () => { navRef.navigate('CardDetail', { card: CARD }); });
  await settle();
  return fetchCalls.slice(before);
}
for (const width of [390, 1440]) {
  await test(`CardDetail @${width}: back arrow + own action bar + content panels, no tab bar (documented exception); back returns to Home`, async () => {
    const calls = await openCardDetailFrom(width, 'Home');
    assert.equal(navRef.getCurrentRoute()?.name, 'CardDetail');
    assert.ok(byTestId('card-detail-shell'), 'CardDetail mounts with the real catalog row');
    assert.ok(byTestId('card-detail-back'), 'back arrow present');
    assert.ok(byTestId('card-detail-action-bar'), 'its own existing action bar present');
    // R5: with FEATURES.sellPrice on (this non-MVP run) CardDetail opens on its
    // 市場價格 segment and keeps the other panes mounted but hidden. Confirm that
    // product default, then switch with the REAL segment control and require the
    // skills pane to become the visible one (visibility scoping kept).
    const marketSeg = byTestId('card-detail-seg-market');
    assert.ok(marketSeg, 'market segment present');
    assert.equal(marketSeg.getAttribute('aria-selected'), 'true', 'product default: market segment active');
    assert.ok(byTestId('card-detail-market-panel'), 'market pane visible by default');
    assert.equal(byTestId('card-detail-skills-panel'), null, 'skills pane mounted but hidden before the switch');
    await click(byTestId('card-detail-seg-skills'));
    assert.equal(byTestId('card-detail-seg-skills').getAttribute('aria-selected'), 'true', 'skills segment now active');
    assert.ok(byTestId('card-detail-skills-panel'), 'source panels render (skills) after the real tab click');
    assert.equal(byTestId('card-detail-market-panel'), null, 'market pane hidden after the switch');
    assert.ok(byTestId('card-detail-shell-bottom') === null, 'CardDetail draws no bottom tab stack (intended)');
    assert.ok(!calls.some((u) => /^https?:\/\//.test(u) || u.includes('/api/')), `no API/external request: ${calls.join(', ')}`);
    assert.equal(byTestId('card-detail-shell').querySelectorAll('img[src]:not([src=""])').length, 0, 'CardDetail sets no image source (no image request)');
    await click(byTestId('card-detail-back'));
    assert.equal(navRef.getCurrentRoute()?.name, 'Home', 'back is not stranded');
    expectBars(width >= 768 ? 0 : 1, `back on Home @${width}`);
    if (width < 768) assert.ok(byTestId('shell-bottom-tab-home'), 'back on Home: bottom tabs');
  });
}
await test('1440 SearchResults → CardDetail → back: returns to SearchResults and its dock still navigates', async () => {
  await openCardDetailFrom(1440, 'SearchResults');
  // Genuine traversal: CardDetail is on top of the SearchResults it was opened from.
  const st = navRef.getRootState();
  assert.equal(st.routes[st.index]?.name, 'CardDetail', `focused root route\n${navDiag()}`);
  assert.equal(st.routes[st.index - 1]?.name, 'SearchResults', `CardDetail was pushed over SearchResults\n${navDiag()}`);
  const resultsKey = st.routes[st.index - 1].key;
  expectBars(0, 'CardDetail itself shows no dock (documented exception)');
  await click(byTestId('card-detail-back'));
  assert.equal(navRef.getCurrentRoute()?.name, 'SearchResults');
  assert.equal(navRef.getCurrentRoute()?.key, resultsKey, 'back returned to the SAME SearchResults instance');
  expectBars(1, 'dock back on SearchResults');
  assert.equal(css(byTestId('shell-bottom-tab-bar-bar')).maxWidth, `${TAB_BAR_DOCK_MAX_WIDTH}px`, 'the visible bar is the dock');
  assert.equal(byTestId('shell-bottom-tab-search').getAttribute('aria-selected'), 'true', 'active dock tab is 搜尋');
  await click(byTestId('shell-bottom-tab-deck'));
  assert.equal(navRef.getCurrentRoute()?.name, 'DeckList');
  expectBars(0, 'DeckList is a drawer page');
});

await act(async () => root.unmount());

// ── safe area applied once (standalone AppShell, platform pinned) ──────────
const TABS = { items: [{ key: 'home', label: '首頁' }, { key: 'search', label: '搜尋' }, { key: 'scan', label: '掃描', onPress() {} }, { key: 'deck', label: '牌組' }, { key: 'me', label: '我的' }], activeKey: 'home' };
async function shellAt({ width, inDrawer, platform = 'web', bottom = 34 }) {
  await setWidth(width);
  const previous = Platform.OS;
  Platform.OS = platform;
  __setSafeAreaInsetsForTest({ top: 0, bottom });
  const c = doc.createElement('div');
  doc.body.appendChild(c);
  const r = createRoot(c);
  try {
    await act(async () => r.render(React.createElement(DrawerHostContext.Provider, { value: inDrawer },
      React.createElement(AppShell, { bottomTabBar: TABS, scrollable: false, appBar: { title: 'x' } }, React.createElement(Text, null, 'last row')))));
    await settle();
    const stack = c.querySelector('[data-testid="shell-root-bottom"]');
    const content = c.querySelector('[data-testid="shell-content"]');
    return { stack: stack ? css(stack).paddingBottom : null, content: css(content).paddingBottom };
  } finally {
    await act(async () => r.unmount());
    c.remove();
    Platform.OS = previous;
    __setSafeAreaInsetsForTest(null);
  }
}

await test('safe area once: desktop drawer page absorbs the inset into content (no bottom stack)', async () => {
  const s = await shellAt({ width: 1440, inDrawer: true });
  assert.equal(s.stack, null);
  assert.equal(s.content, `${SPACING['3xl'] + 34}px`);
});
await test('safe area once: desktop root-stack dock keeps the inset on the bottom stack only', async () => {
  const s = await shellAt({ width: 1440, inDrawer: false });
  assert.equal(s.stack, '34px');
  assert.equal(s.content, `${SPACING.md}px`);
});
await test('safe area once: mobile web drawer page keeps the bar with the inset on the bottom stack only', async () => {
  const s = await shellAt({ width: 390, inDrawer: true });
  assert.equal(s.stack, '34px');
  assert.equal(s.content, `${SPACING.md}px`);
});
await test('native tablet width inside the drawer is unchanged: bottom bar kept (native behaviour preserved)', async () => {
  const s = await shellAt({ width: 1024, inDrawer: true, platform: 'ios', bottom: 0 });
  assert.equal(s.stack, `${LAYOUT.safeMobile}px`, 'native keeps the bar and the 20px computed fallback inset');
});

if ((process.exitCode ?? 0) === 0) console.log(`\n✅ responsive navigation (real nested navigator): ${passed} checks passed`);
else console.error('\n❌ responsive navigation failed');
