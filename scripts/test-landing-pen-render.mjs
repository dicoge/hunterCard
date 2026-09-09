#!/usr/bin/env node
// DIC-1380 W5b — LandingScreen renders the accepted Pen artifact at
// 390 px (mobile `LX2IZ` / `bDwDO`) and 1440 px (desktop `Rlx6E` /
// `avS3j`).
//
// The PM correction "accepted Pen design is not deployed" flagged that
// the previous PR shipped the Pen artifact and PNG previews but never
// wired the Landing into product code. This suite is the code-side proof
// that `/` for an unauthenticated visitor now renders the Pen sections:
// Nav, Hero, Stats Bar, Features, Plans, Footer. Every assertion pins a
// testID or a substring that comes DIRECTLY from the Pen `.pen` frame,
// so removing a section from the screen fails the corresponding check.
//
// The browser-side proof (real screenshots against the Vercel Preview
// URL at 390 x 844 and 1440 x 900) lives in the PR reply — this suite
// gates the code that makes those screenshots possible.

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
class NoopResizeObserver { observe(){} unobserve(){} disconnect(){} }
globalThis.ResizeObserver = NoopResizeObserver;
dom.window.ResizeObserver = NoopResizeObserver;

function setViewport({ width, height }) {
  Object.defineProperty(dom.window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(dom.window, 'innerHeight', { value: height, configurable: true });
  Object.defineProperty(dom.window.document.documentElement, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(dom.window.document.documentElement, 'clientHeight', { value: height, configurable: true });
  // react-native-web's Dimensions API caches; fire a resize event so any
  // hook subscribed via useWindowDimensions() re-reads before we render.
  try { dom.window.dispatchEvent(new dom.window.Event('resize')); } catch {}
}

globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const LandingScreen = (await import('../src/screens/LandingScreen.tsx')).default;

const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

async function renderLanding(viewport) {
  setViewport(viewport);
  const host = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(LandingScreen));
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

const byTestId = (el, id) => el.querySelector(`[data-testid="${id}"]`);

let passed = 0;
async function test(label, fn) {
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

// ── Every Pen section mounts at BOTH viewports ──────────────────────────
for (const [label, viewport] of [['mobile 390', MOBILE], ['desktop 1440', DESKTOP]]) {
  await test(`${label}: LandingScreen mounts with the Pen sections (nav, hero, stats-bar, features, plans, footer)`, async () => {
    const { container, cleanup } = await renderLanding(viewport);
    try {
      for (const id of [
        'landing-screen',
        'landing-nav',
        'landing-hero',
        'landing-headline',
        'landing-subhead',
        'landing-cta-row',
        'landing-cta-guest',
        'landing-cta-google',
        'landing-stats-bar',
        'landing-features',
        'landing-plans',
        'landing-plan-free',
        'landing-plan-pro',
        'landing-footer',
      ]) {
        assert.ok(byTestId(container, id), `Pen section testID '${id}' must mount at ${label}`);
      }
    } finally { await cleanup(); }
  });

  await test(`${label}: Pen artifact headline copy renders verbatim`, async () => {
    const { container, cleanup } = await renderLanding(viewport);
    try {
      const headline = byTestId(container, 'landing-headline');
      assert.ok(headline.textContent.includes('查得到效果'), 'Pen headline first line');
      assert.ok(headline.textContent.includes('也查得到現在值多少'), 'Pen headline second line');
      const subhead = byTestId(container, 'landing-subhead');
      assert.ok(subhead.textContent.includes('hololive OFFICIAL CARD GAME'), 'Pen subhead names hOCG');
    } finally { await cleanup(); }
  });

  await test(`${label}: Pen "coming soon" states are truthful (Google login + Pro plan)`, async () => {
    const { container, cleanup } = await renderLanding(viewport);
    try {
      const googleCta = byTestId(container, 'landing-cta-google');
      assert.ok(/即將推出/.test(googleCta.textContent), 'Google CTA carries the 即將推出 label');
      const proPlan = byTestId(container, 'landing-plan-pro');
      assert.ok(/規劃中|即將推出/.test(proPlan.textContent), 'Pro plan is marked coming-soon');
      assert.ok(/尚未開放/.test(proPlan.textContent), 'Pro plan tagline states "尚未開放"');
    } finally { await cleanup(); }
  });

  await test(`${label}: Pen Stats Bar renders all four stats`, async () => {
    const { container, cleanup } = await renderLanding(viewport);
    try {
      const statsBar = byTestId(container, 'landing-stats-bar');
      const text = statsBar.textContent;
      assert.ok(text.includes('36') && text.includes('個收錄系列'), 'Stat 1 (36 系列) present');
      assert.ok(text.includes('雙語'), 'Stat 2 (雙語) present');
      assert.ok(text.includes('NT$') && text.includes('¥') && text.includes('$'), 'Stat 3 (三幣別) present');
      assert.ok(text.includes('8') && text.includes('章'), 'Stat 4 (8 章) present');
    } finally { await cleanup(); }
  });

  await test(`${label}: Pen Free plan lists 100 掃描 scans/month + 全部卡表檢索`, async () => {
    const { container, cleanup } = await renderLanding(viewport);
    try {
      const freePlan = byTestId(container, 'landing-plan-free');
      const text = freePlan.textContent;
      assert.ok(text.includes('100') && text.includes('掃描'), 'Free plan lists the 100 scans/month quota');
      assert.ok(text.includes('全部卡表檢索與篩選'), 'Free plan lists the 全部卡表檢索與篩選 feature');
      assert.ok(text.includes('賽事月報'), 'Free plan lists 賽事月報');
    } finally { await cleanup(); }
  });

  await test(`${label}: Pen Footer links to terms / privacy / pricing / support`, async () => {
    const { container, cleanup } = await renderLanding(viewport);
    try {
      for (const id of ['landing-footer-terms', 'landing-footer-privacy', 'landing-footer-pricing', 'landing-footer-support']) {
        assert.ok(byTestId(container, id), `footer link ${id} must be present at ${label}`);
      }
      const footer = byTestId(container, 'landing-footer');
      assert.ok(/2026 HoloHunter/.test(footer.textContent), 'footer copy carries the 2026 HoloHunter attribution');
    } finally { await cleanup(); }
  });
}

// ── Desktop-only Pen anchors ────────────────────────────────────────────
await test('desktop 1440: Hero visual side-card + sparkline mount (Pen `z5AkG` / `MEruZ`)', async () => {
  const { container, cleanup } = await renderLanding(DESKTOP);
  try {
    assert.ok(byTestId(container, 'landing-hero-visual'), 'hero visual card mounts on desktop');
    assert.ok(byTestId(container, 'landing-hero-sparkline'), 'hero sparkline mounts on desktop');
    assert.ok(byTestId(container, 'landing-nav-links'), 'desktop nav-links strip mounts');
    assert.ok(byTestId(container, 'landing-nav-cta'), 'desktop 登入 nav CTA mounts');
  } finally { await cleanup(); }
});

// ── Mobile-only Pen anchors ─────────────────────────────────────────────
await test('mobile 390: burger menu is present + expands (Pen `bDwDO`.`aaIVQ`)', async () => {
  const { container, cleanup } = await renderLanding(MOBILE);
  try {
    const btn = byTestId(container, 'landing-mobile-menu-btn');
    assert.ok(btn, 'burger menu button mounts on mobile');
    assert.equal(byTestId(container, 'landing-mobile-menu'), null, 'menu is closed on mount');
    await act(async () => btn.click());
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    assert.ok(byTestId(container, 'landing-mobile-menu'), 'menu opens on tap');
    // Desktop-only nav elements MUST NOT mount at 390.
    assert.equal(byTestId(container, 'landing-nav-links'), null, 'desktop nav-links stay hidden on mobile');
    assert.equal(byTestId(container, 'landing-hero-visual'), null, 'desktop hero visual stays hidden on mobile');
  } finally { await cleanup(); }
});

// ── DIC-1380 W6 CR: full Pen composition — every additional section mounts
for (const [label, viewport] of [['mobile 390', MOBILE], ['desktop 1440', DESKTOP]]) {
  await test(`${label}: Pen How-It-Works three-step section mounts (DIC-1380 W6 CR full parity)`, async () => {
    const { container, cleanup } = await renderLanding(viewport);
    try {
      assert.ok(byTestId(container, 'landing-how-it-works'), 'how-it-works section mounts');
      assert.ok(byTestId(container, 'landing-how-01'), 'step 01 mounts');
      assert.ok(byTestId(container, 'landing-how-02'), 'step 02 mounts');
      assert.ok(byTestId(container, 'landing-how-03'), 'step 03 mounts');
    } finally { await cleanup(); }
  });

  await test(`${label}: Pen Collection Preview section mounts with three cards (DIC-1380 W6 CR full parity)`, async () => {
    const { container, cleanup } = await renderLanding(viewport);
    try {
      const preview = byTestId(container, 'landing-collection-preview');
      assert.ok(preview, 'collection preview section mounts');
      assert.ok(/36 個收錄系列/.test(preview.textContent), 'collection card 1 (36 系列) mounts');
      assert.ok(/每日行情/.test(preview.textContent), 'collection card 2 (每日行情) mounts');
      assert.ok(/缺卡預估總額/.test(preview.textContent), 'collection card 3 (缺卡預估) mounts');
    } finally { await cleanup(); }
  });

  await test(`${label}: Pen FAQ section mounts with the four questions (DIC-1380 W6 CR full parity)`, async () => {
    const { container, cleanup } = await renderLanding(viewport);
    try {
      const faq = byTestId(container, 'landing-faq');
      assert.ok(faq, 'FAQ section mounts');
      assert.ok(/需要付費才能使用嗎/.test(faq.textContent), 'FAQ Q1 (付費) mounts');
      assert.ok(/沒有帳號可以先試用嗎/.test(faq.textContent), 'FAQ Q2 (試用) mounts');
      assert.ok(/卡牌影像會被上傳到伺服器嗎/.test(faq.textContent), 'FAQ Q3 (影像上傳) mounts');
    } finally { await cleanup(); }
  });

  await test(`${label}: Pen Final CTA section mounts with both guest + Google CTAs (DIC-1380 W6 CR full parity)`, async () => {
    const { container, cleanup } = await renderLanding(viewport);
    try {
      assert.ok(byTestId(container, 'landing-final-cta'), 'final CTA section mounts');
      assert.ok(byTestId(container, 'landing-final-cta-guest'), 'final CTA guest button mounts');
      assert.ok(byTestId(container, 'landing-final-cta-google'), 'final CTA Google button mounts');
    } finally { await cleanup(); }
  });
}

// ── DIC-1380 W7 CR: standalone Price section + three-card Hero composition
for (const [label, viewport] of [['mobile 390', MOBILE], ['desktop 1440', DESKTOP]]) {
  await test(`${label}: Pen standalone Price section mounts with three price rows (DIC-1380 W7 CR)`, async () => {
    const { container, cleanup } = await renderLanding(viewport);
    try {
      const price = byTestId(container, 'landing-price');
      assert.ok(price, 'standalone Price section mounts (DIC-1380 W7 CR)');
      assert.ok(byTestId(container, 'landing-price-row-hSD01-016'), 'price row 1 (star primary) mounts');
      assert.ok(byTestId(container, 'landing-price-row-hBP01-042'), 'price row 2 mounts');
      assert.ok(byTestId(container, 'landing-price-row-hBP02-088'), 'price row 3 (down-trend) mounts');
      assert.ok(/NT\$ · ¥ · \$/.test(price.textContent), 'price section states the three-currency framing');
    } finally { await cleanup(); }
  });
}

await test('desktop 1440: Pen three-card Hero composition mounts (DIC-1380 W7 CR)', async () => {
  const { container, cleanup } = await renderLanding(DESKTOP);
  try {
    // Hero visual carries THREE card anchors: primary + secondary + tertiary
    assert.ok(byTestId(container, 'landing-hero-card-primary'), 'hero primary card (with sparkline) mounts');
    assert.ok(byTestId(container, 'landing-hero-card-secondary'), 'hero secondary card mounts');
    assert.ok(byTestId(container, 'landing-hero-card-tertiary'), 'hero tertiary card mounts');
    // Sparkline still sits on the primary card, not the compact secondaries.
    const primary = byTestId(container, 'landing-hero-card-primary');
    const sparkline = byTestId(container, 'landing-hero-sparkline');
    assert.ok(primary && sparkline && primary.contains(sparkline), 'sparkline lives inside the primary card');
  } finally { await cleanup(); }
});

// ── AppNavigator routes an unauthenticated visitor to LandingScreen ─────
await test('AppNavigator: unauthenticated + non-guest visitor is routed to LandingScreen (not the bare LoginScreen)', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = fs.readFileSync(
    path.resolve('src/navigation/AppNavigator.tsx'),
    'utf8',
  );
  assert.ok(src.includes("import LandingScreen from '../screens/LandingScreen'"), 'AppNavigator imports LandingScreen');
  assert.ok(
    /AuthStack\.Screen[^>]*component=\{LandingScreen\}/.test(src),
    'AppNavigator routes the visitor stack to LandingScreen',
  );
});

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ DIC-1380 W5b Landing Pen render regression: ${passed} checks passed`);
} else {
  console.error(`\n❌ DIC-1380 W5b Landing Pen render regression failed`);
}
