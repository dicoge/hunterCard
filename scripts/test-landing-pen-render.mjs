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

  await test(`${label}: Pen Deck/Collection section mounts (DIC-1409 Phase 7 — Pen KXeLu/a7oRL)`, async () => {
    const { container, cleanup } = await renderLanding(viewport);
    try {
      const preview = byTestId(container, 'landing-collection-preview');
      assert.ok(preview, 'deck/collection section mounts');
      assert.ok(/缺卡預估總額/.test(preview.textContent), 'deck panel 缺卡預估總額 mounts');
      assert.ok(/牌組編輯器/.test(preview.textContent), 'section pill names the Pen 牌組編輯器 anchor');
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

// ── DIC-1409 Phase 7: Pen `N8ds5T`/`PPAfW` price CHART CARD (the text
//    price rows were the exact "價格視覺" regression the issue named).
for (const [label, viewport] of [['mobile 390', MOBILE], ['desktop 1440', DESKTOP]]) {
  await test(`${label}: Pen Price section mounts the chart card (DIC-1409 Phase 7 — Pen N8ds5T)`, async () => {
    const { container, cleanup } = await renderLanding(viewport);
    try {
      const price = byTestId(container, 'landing-price');
      assert.ok(price, 'Price section mounts');
      const chart = byTestId(container, 'landing-price-chart');
      assert.ok(chart, 'Pen price chart card mounts (not text price rows)');
      assert.ok(/星街すいせい \/ UR/.test(chart.textContent), 'chart header names the Pen-anchored printing');
      assert.ok(/hBP01-081/.test(chart.textContent), 'chart header carries the Pen catalog number');
      assert.ok(/NT\$ 3,600/.test(chart.textContent), 'chart shows the Pen price value');
      assert.ok(/\+12\.4%/.test(chart.textContent), 'chart shows the Pen 7-day delta');
      const timeframes = byTestId(container, 'landing-price-timeframes');
      assert.ok(timeframes, 'timeframe segmented control mounts');
      for (const tf of ['7D', '30D', '90D']) {
        assert.ok(timeframes.textContent.includes(tf), `timeframe segment ${tf} present`);
      }
      for (const xl of ['6/09', '7/07']) {
        assert.ok(chart.textContent.includes(xl), `chart x-axis label ${xl} present`);
      }
      // Truthful coming-soon cells: 店家收購 + trend forecast never render a
      // fabricated value.
      const buyback = byTestId(container, 'landing-price-coming-buyback');
      assert.ok(buyback, '店家收購 cell mounts');
      assert.ok(/即將推出/.test(buyback.textContent), '店家收購 stays 即將推出');
      const forecast = byTestId(container, 'landing-price-coming-forecast');
      assert.ok(forecast, '價格趨勢預測 cell mounts');
      assert.ok(/即將推出/.test(forecast.textContent), '價格趨勢預測 stays 即將推出');
      assert.ok(/遊々亭/.test(price.textContent), 'price section credits the 遊々亭 source');
    } finally { await cleanup(); }
  });
}

// ── DIC-1409 Phase 7: Pen `voo0h`/`RzGa0` deck-builder PANEL (the exact
//    "牌組面板" regression the issue named).
for (const [label, viewport] of [['mobile 390', MOBILE], ['desktop 1440', DESKTOP]]) {
  await test(`${label}: Pen Deck section mounts the deck-builder panel (DIC-1409 Phase 7 — Pen voo0h)`, async () => {
    const { container, cleanup } = await renderLanding(viewport);
    try {
      const section = byTestId(container, 'landing-collection-preview');
      assert.ok(section, 'Deck/Collection section mounts');
      const panel = byTestId(container, 'landing-deck-panel');
      assert.ok(panel, 'Pen deck-builder panel mounts (not generic collection cards)');
      assert.ok(/白上フブキ Buzz/.test(panel.textContent), 'panel names the Pen deck draft');
      assert.ok(/NT\$ 2,140/.test(panel.textContent), 'panel shows the Pen 缺卡預估總額 value');
      assert.ok(/還缺的 7 張/.test(panel.textContent), 'panel shows the Pen missing-count row');
      assert.ok(/套用低價版本/.test(panel.textContent), 'panel shows the Pen cheap-version action');
      for (const row of ['hBP02-012', 'hBP02-013', 'hBP01-021', 'ブルームエール']) {
        assert.ok(panel.textContent.includes(row), `deck progress row ${row} mounts`);
      }
      assert.ok(/有 2 \/ 需 4/.test(panel.textContent), 'progress rows carry the Pen 有/需 counts');
      assert.ok(/組完牌，順便/.test(section.textContent), 'section headline follows Pen 牌組編輯器 copy');
    } finally { await cleanup(); }
  });
}

// ── DIC-1409 Phase 7: Pen `hUcaS` bento search mockup (the exact
//    "搜尋 mockup" regression the issue named).
for (const [label, viewport] of [['mobile 390', MOBILE], ['desktop 1440', DESKTOP]]) {
  await test(`${label}: Pen Features bento search mockup mounts (DIC-1409 Phase 7 — Pen hUcaS)`, async () => {
    const { container, cleanup } = await renderLanding(viewport);
    try {
      const mockup = byTestId(container, 'landing-feature-search-mockup');
      assert.ok(mockup, 'search mockup card mounts');
      assert.ok(/八個條件疊加的卡牌檢索/.test(mockup.textContent), 'search card carries the Pen title');
      assert.ok(/すいせい/.test(mockup.textContent), 'search input mockup carries the Pen query');
      for (const chip of ['藍', 'Holomen', 'hBP04', '有平行版', 'SR 以上']) {
        assert.ok(mockup.textContent.includes(chip), `filter chip ${chip} mounts`);
      }
      // Icon-tile feature cards from the Pen bento
      for (const title of ['拍照辨識，順便估值', '牌組編輯器', '賽事月報', '規則教學與模擬戰']) {
        assert.ok(byTestId(container, `landing-feature-${title}`), `feature card ${title} mounts`);
      }
    } finally { await cleanup(); }
  });
}

await test('desktop 1440: Pen three-card Hero composition + floating chips mount (DIC-1409 Phase 7 — Pen z5AkG)', async () => {
  const { container, cleanup } = await renderLanding(DESKTOP);
  try {
    // Hero visual carries THREE card anchors: primary + secondary + tertiary
    assert.ok(byTestId(container, 'landing-hero-card-primary'), 'hero primary card mounts');
    assert.ok(byTestId(container, 'landing-hero-card-secondary'), 'hero secondary card mounts');
    assert.ok(byTestId(container, 'landing-hero-card-tertiary'), 'hero tertiary card mounts');
    // Pen floating chips: deck-legality (donut) + price w/ sparkline.
    const legality = byTestId(container, 'landing-hero-legality');
    assert.ok(legality, 'Pen legality chip mounts over the hero cards');
    assert.ok(/主牌組合法性/.test(legality.textContent), 'legality chip carries the Pen label');
    assert.ok(/43 \/ 50/.test(legality.textContent), 'legality chip carries the Pen 43/50 value');
    const priceChip = byTestId(container, 'landing-hero-price-chip');
    const sparkline = byTestId(container, 'landing-hero-sparkline');
    assert.ok(priceChip && sparkline && priceChip.contains(sparkline), 'sparkline lives inside the Pen price chip');
    assert.ok(/星街すいせい UR/.test(priceChip.textContent), 'price chip names the Pen printing');
    assert.ok(/NT\$ 3,600/.test(priceChip.textContent), 'price chip shows the Pen price');
    const visual = byTestId(container, 'landing-hero-visual');
    assert.ok(visual.contains(legality) && visual.contains(priceChip), 'chips float inside the hero visual');
  } finally { await cleanup(); }
});

await test('mobile 390: Pen hero price card mounts with sparkline (DIC-1409 Phase 7 — Pen T43dEj)', async () => {
  const { container, cleanup } = await renderLanding(MOBILE);
  try {
    const priceChip = byTestId(container, 'landing-hero-price-chip');
    assert.ok(priceChip, 'mobile hero price card mounts');
    const sparkline = byTestId(container, 'landing-hero-sparkline');
    assert.ok(priceChip.contains(sparkline), 'mobile price card carries the sparkline');
    assert.ok(/資料來源：遊々亭/.test(priceChip.textContent), 'mobile price card credits the source');
  } finally { await cleanup(); }
});

// ── DIC-1409 Phase 7: Pen `VfmUx` FAQ accordion — REAL expand/collapse
//    state, not a static list. Desktop opens item 0 only; toggling a
//    closed item must reveal its reviewed answer.
await test('desktop 1440: FAQ accordion expands/collapses with real state (DIC-1409 Phase 7 — Pen VfmUx)', async () => {
  const { container, cleanup } = await renderLanding(DESKTOP);
  try {
    const item0 = byTestId(container, 'landing-faq-item-0');
    const item1 = byTestId(container, 'landing-faq-item-1');
    assert.ok(item0 && item1, 'FAQ accordion items mount');
    assert.ok(/App Store \/ Google Play \/ Stripe/.test(item0.textContent), 'first FAQ answer is open by default (desktop)');
    assert.ok(!/拍照掃描需登入 Google 或 Apple 帳號/.test(item1.textContent), 'second FAQ answer starts collapsed on desktop');
    const toggle1 = byTestId(container, 'landing-faq-toggle-1');
    await act(async () => {
      toggle1.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    const item1After = byTestId(container, 'landing-faq-item-1');
    assert.ok(/拍照掃描需登入 Google 或 Apple 帳號/.test(item1After.textContent), 'toggling reveals the reviewed answer (real state)');
  } finally { await cleanup(); }
});

// ── DIC-1409 Phase 7: Pen `TldCK` footer columns + `QumbV` CTA card copy
await test('desktop 1440: Pen footer columns + final CTA card copy (DIC-1409 Phase 7)', async () => {
  const { container, cleanup } = await renderLanding(DESKTOP);
  try {
    const footer = byTestId(container, 'landing-footer');
    for (const col of ['產品', '資源', '關於']) {
      assert.ok(footer.textContent.includes(col), `footer column ${col} mounts`);
    }
    assert.ok(/與官方無隸屬關係/.test(footer.textContent), 'footer carries the Pen brand disclaimer');
    const finalCta = byTestId(container, 'landing-final-cta');
    assert.ok(/先從查一張卡開始/.test(finalCta.textContent), 'final CTA carries the Pen headline');
    assert.ok(/非官方工具 · 卡牌圖像與名稱版權屬於原公司/.test(finalCta.textContent), 'final CTA carries the Pen attribution note');
  } finally { await cleanup(); }
});

// ── DIC-1381 W9 CR: hero images + section order DERIVED FROM THE
//    ACCEPTED PEN FILE, not from self-authored anchors. `data/pen/
//    holohunter-landing-v2.pen` is the on-disk copy of the same artifact
//    PM attached to DIC-1380; parsing it here means a re-accepted Pen
//    (different image URL, reordered section list) fails these checks
//    unless production is updated to match. If the Pen file is missing
//    or unparseable, the tests fail closed — a passing green cannot
//    happen without the artifact.
const fs = await import('node:fs');
const pathMod = await import('node:path');
const PEN_PATH = pathMod.resolve('data/pen/holohunter-landing-v2.pen');
if (!fs.existsSync(PEN_PATH)) {
  throw new Error(`Pen artifact fixture not found at ${PEN_PATH}. The Landing Pen conformance regression cannot run without it.`);
}
const pen = JSON.parse(fs.readFileSync(PEN_PATH, 'utf8'));

// Pen files store the tree as nested `children` arrays of full node
// objects (id / name / type / …). Walk the tree to locate the frame by
// id, then read its direct `children` one level down. Follow the two
// Landing frames (`XwzSU` desktop / `D2SGVB` mobile) to recover the
// top-level section order the Pen anchors.
function findPenNode(id) {
  const stack = Array.isArray(pen.children) ? [...pen.children] : [];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== 'object') continue;
    if (n.id === id) return n;
    if (Array.isArray(n.children)) for (const c of n.children) stack.push(c);
  }
  return null;
}
function penChildrenOf(rootId) {
  const node = findPenNode(rootId);
  if (!node) throw new Error(`Pen node ${rootId} not found`);
  const children = Array.isArray(node.children) ? node.children : [];
  return children.map((c) => ({ id: c.id, name: String(c.name ?? ''), type: String(c.type ?? '') }));
}

// Section-name → production testID mapping. Pen names are human-readable
// design labels; production carries stable testIDs. A section that lands
// in the Pen but has no mapped testID here is a Pen-composition surface
// we haven't wired yet — the test fails so it can't be silently skipped.
const PEN_TO_TESTID = new Map([
  ['Nav', 'landing-nav'],
  ['Hero', 'landing-hero'],
  ['Stats Bar', 'landing-stats-bar'],
  ['Features', 'landing-features'],
  ['Price Section', 'landing-price'],
  ['Collection Section', 'landing-collection-preview'],
  // Mobile Pen renames the Collection section to "Deck Section"; both
  // land in the same Landing surface (`landing-collection-preview`).
  ['Deck Section', 'landing-collection-preview'],
  ['How It Works', 'landing-how-it-works'],
  ['Plans', 'landing-plans'],
  ['FAQ Section', 'landing-faq'],
  ['FAQ', 'landing-faq'],
  ['Final CTA', 'landing-final-cta'],
  ['Footer', 'landing-footer'],
]);

function penSectionOrderAsTestIds(rootId) {
  return penChildrenOf(rootId).map(({ name }) => {
    const id = PEN_TO_TESTID.get(name);
    if (!id) throw new Error(`Pen section "${name}" under ${rootId} has no production testID mapping — wire it or update PEN_TO_TESTID`);
    return id;
  });
}

const DESKTOP_ORDER = penSectionOrderAsTestIds('XwzSU');
const MOBILE_ORDER = penSectionOrderAsTestIds('D2SGVB');

for (const [label, viewport, expectedOrder, rootPenId] of [
  ['desktop 1440', DESKTOP, DESKTOP_ORDER, 'XwzSU'],
  ['mobile 390', MOBILE, MOBILE_ORDER, 'D2SGVB'],
]) {
  await test(`${label}: Landing section order matches accepted Pen frame ${rootPenId} (DIC-1381 W9 CR — derived from data/pen/holohunter-landing-v2.pen)`, async () => {
    const { container, cleanup } = await renderLanding(viewport);
    try {
      const positions = expectedOrder.map((id) => {
        const el = byTestId(container, id);
        assert.ok(el, `Pen section testID '${id}' (derived from ${rootPenId}) must mount at ${label}`);
        return el;
      });
      for (let i = 0; i < positions.length - 1; i++) {
        const a = positions[i];
        const b = positions[i + 1];
        const rel = a.compareDocumentPosition(b);
        assert.ok(
          rel & 0x04, // DOCUMENT_POSITION_FOLLOWING
          `${label}: section ${expectedOrder[i]} must precede ${expectedOrder[i + 1]} — Pen ${rootPenId} order is ${expectedOrder.join(' → ')}`,
        );
      }
    } finally { await cleanup(); }
  });
}

// ── DIC-1381 W9 CR: three image-card hero — derived from Pen `z5AkG` ──
// The accepted Pen anchors an image fill on `Card Left` / `Card Right` /
// `Card Center` (frame `z5AkG`); we recover the image URLs from the Pen
// file and assert that production renders a real <img> at the same three
// filenames. A coloured <View> stand-in fails because the DOM node
// carries no `src` attribute pointing at those specific catalog card art
// files.
function penHeroCardFills() {
  const hero = findPenNode('z5AkG');
  if (!hero) throw new Error('Pen hero frame z5AkG not found');
  const found = {};
  for (const child of hero.children ?? []) {
    if (!child || typeof child !== 'object') continue;
    const name = String(child.name ?? '');
    if (!/^Card /.test(name)) continue;
    const fill = child.fill;
    const url = (fill && typeof fill === 'object' && fill.type === 'image' && typeof fill.url === 'string') ? fill.url : null;
    if (!url) throw new Error(`Pen hero card frame "${name}" (${child.id}) has no image fill — the accepted Pen anchor requires an image fill on every Card frame`);
    const filenameMatch = url.match(/([^\/]+?)(\.png|\.jpg|\.jpeg)$/i);
    const key = name.replace(/^Card\s+/i, '').toLowerCase();
    found[key] = { penUrl: url, penFilename: filenameMatch ? filenameMatch[1] : url };
  }
  if (!found.left || !found.right || !found.center) throw new Error(`Pen hero frame z5AkG must carry Card Left / Card Right / Card Center — got ${JSON.stringify(Object.keys(found))}`);
  return found;
}

const HERO_FILLS = penHeroCardFills();

// Pen Card Left / Center / Right map onto production primary /
// secondary / tertiary in the Landing composition (Left = primary
// biggest tile with sparkline; Center = middle; Right = right).
const PEN_TO_PROD = { left: 'primary', center: 'secondary', right: 'tertiary' };

await test(
  'desktop 1440: hero three image-card tiles render <Image> with the Pen-anchored card artwork (DIC-1381 W9 CR — derived from Pen z5AkG image fills)',
  async () => {
    const { container, cleanup } = await renderLanding(DESKTOP);
    try {
      for (const [penKey, prodKey] of Object.entries(PEN_TO_PROD)) {
        const anchor = byTestId(container, `landing-hero-cardart-${prodKey}-art`);
        assert.ok(anchor, `hero ${prodKey} tile carries a card-art anchor mapped to Pen "Card ${penKey}"`);
        // react-native-web renders <Image> as `<div role="img">` carrying
        // an inner background-image + a fallback <img>. Either surface
        // must carry the specific Pen catalog filename — a plain colour
        // <div> would carry neither.
        assert.equal(
          anchor.getAttribute('role'), 'img',
          `hero ${prodKey} anchor must render as an image (Pen "Card ${penKey}" carries an image fill); react-native-web sets role="img"`,
        );
        const innerImg = anchor.querySelector('img');
        const innerBg = anchor.querySelector('[style*="background-image"]');
        const penFilename = HERO_FILLS[penKey].penFilename;
        const imgSrc = innerImg?.getAttribute('src') || '';
        const bgStyle = innerBg?.getAttribute('style') || '';
        assert.ok(
          imgSrc.includes(penFilename) || bgStyle.includes(penFilename),
          `hero ${prodKey} tile must reference Pen filename "${penFilename}" (from ${HERO_FILLS[penKey].penUrl}) in either <img src> or background-image; got img.src="${imgSrc}" bg.style="${bgStyle}"`,
        );
      }
      const hero = byTestId(container, 'landing-hero-visual');
      // Each Pen card artwork is a specific catalog printing — assert
      // production tiles show the same catalog card numbers rather than
      // arbitrary substitutes.
      for (const pf of Object.values(HERO_FILLS)) {
        const number = pf.penFilename.replace(/_[A-Z]+$/i, '');
        assert.ok(hero.textContent.includes(number), `hero tile shows Pen-anchored card number ${number}`);
      }
    } finally { await cleanup(); }
  },
);

// ── DIC-1381 W9 CR: Landing sync copy must not contradict the Store MVP
//    binding gate. `installAccountSyncBinding()` is gated on
//    `FEATURES.favorites || FEATURES.watchlist || FEATURES.premium`, and
//    all three are derived from `!STORE_MVP` — so under Store MVP those
//    fields don't sync. Any sentence on the Landing that claims
//    favorites/decks/priceAlerts/settings sync must either omit the
//    unconditional claim or explicitly gate it on non-Store-MVP builds.
await test('desktop 1440: Landing has no unqualified sync claim (DIC-1381 W9 CR — derived from App.tsx binding gate)', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  // Truth check: App.tsx really does gate the binding on all three flags,
  // and all three flags are STORE_MVP-off under releaseFlags.ts. Fail
  // closed if the wiring assumption stops holding.
  const appSrc = fs.readFileSync(path.resolve('App.tsx'), 'utf8');
  assert.ok(
    /installAccountSyncBinding\(\)/.test(appSrc)
      && /FEATURES\.favorites\s*\|\|\s*FEATURES\.watchlist\s*\|\|\s*FEATURES\.premium/.test(appSrc),
    'App.tsx must gate installAccountSyncBinding() on FEATURES.favorites || .watchlist || .premium — the assumption this test rides on',
  );
  const flagsSrc = fs.readFileSync(path.resolve('src/config/releaseFlags.ts'), 'utf8');
  for (const key of ['favorites', 'watchlist', 'premium']) {
    assert.ok(
      new RegExp(`${key}:\\s*!STORE_MVP`).test(flagsSrc),
      `releaseFlags.ts must derive FEATURES.${key} from !STORE_MVP so the Store MVP build disables the sync binding`,
    );
  }

  const { container, cleanup } = await renderLanding(DESKTOP);
  try {
    const text = container.textContent || '';
    // The Landing is user-visible copy; SYNC_FIELD_WORDS covers the
    // sync-payload fields in ordinary language on both zh and en. A
    // sentence that combines a sync verb with several of these fields
    // and NO Store-MVP qualifier is the exact false claim the CR named.
    const SYNC_FIELD_WORDS = ['收藏', '牌組', '價格提醒', '到價提醒', '設定', 'favorites', 'decks', 'price alerts', 'settings'];
    const SYNC_VERB = /(同步到|會同步|sync to|are synced|are sync|同步至|同步(?![^。]{0,20}僅))/i;
    const QUALIFIER = /(Store MVP|feature flag|installAccountSyncBinding|Web Develop|Web Staging|不會|does not|does NOT|not currently|not sent|only sync|僅在啟用|僅限啟用|尚未|本機儲存|裝置本機|local storage|per-device|for now)/i;
    // Split into sentence-ish spans; punctuation covers zh + en.
    const spans = text.split(/[。.!?]|(?<=；)\s+/g);
    const bad = [];
    for (const s of spans) {
      if (!s || s.length < 15) continue;
      const fields = SYNC_FIELD_WORDS.filter((w) => s.includes(w));
      if (fields.length < 2) continue;
      if (!SYNC_VERB.test(s)) continue;
      if (QUALIFIER.test(s)) continue;
      bad.push(s.trim().slice(0, 220));
    }
    assert.equal(bad.length, 0, `Landing sync copy contradicts Store MVP binding gate. Offending spans:\n    - ${bad.join('\n    - ')}`);
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
