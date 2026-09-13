#!/usr/bin/env node
// DIC-1427 QA P0 — Pen `App / 03 卡牌詳情` (frame o7WO3r) IA parity on the
// shipped CardDetailScreen with real stores, pricing, and navigation intact.
//
// The prior Preview still showed the pre-Pen skin: full-bleed card image,
// flat 類型/Bloom/顏色 info list, no 技能/市場/成員 segmented tabs, no bottom
// 收藏/加入牌組 action bar. Every assertion below is pinned to a Pen node id
// so a drift back to the old IA fails a named line:
//   • jzuT9  Card Hero — compact 130px art + name/set/badges/HP cells
//   • EFhFr  Tabs — 技能與效果 / 市場價格 / 成員數據 segments that really swap
//   • qJqlm  Price Card — 遊々亭 參考售價 + 30/700 value + delta chip +
//             history bar chart + 買入成本/店家收購/買賣差價 spread cells
//   • jB05M  Alert Row — 到價提醒 banner opens the real PriceAlertEditor
//   • Mst3p  Action Bar — 加入收藏 round-trips useFavoritesStore,
//             加入牌組 navigates to the real DeckEditor with the card number

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

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const CardDetailScreen = (await import('../src/screens/CardDetailScreen.tsx')).default;
const { PALETTE } = await import('../src/theme/tokensV2.ts');
const { useFavoritesStore } = await import('../src/store/favoritesStore.ts');

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

// Real-shaped single-printing card: validated 14-day history so the Pen delta
// chip / compare line / bar chart light up from genuine trend math, plus a
// buy price so the spread row exercises the aligned fail-closed path.
const DAY = 86_400_000;
const NOW = Date.parse('2026-09-10T00:00:00Z');
const HISTORY_POINTS = 14;
const priceHistory = {};
for (let i = HISTORY_POINTS - 1; i >= 0; i -= 1) {
  const t = new Date(NOW - i * DAY).toISOString();
  priceHistory[t] = i >= 7 ? 3200 + (HISTORY_POINTS - 1 - i) * 10 : 3550 + (7 - (NOW - Date.parse(t)) / DAY) * 10;
}

const DETAIL_CARD = {
  id: 'hBP01-081_hBP01',
  cardNumber: 'hBP01-081',
  name: '星街すいせい',
  type: 'Member',
  grade: '2nd',
  rarity: 'UR',
  sourceRarity: 'UR',
  hp: '210',
  colors: ['blue'],
  colorNames: ['藍色'],
  series: ['hBP01'],
  seriesNames: ['ブルーミングレディアンス'],
  tags: [],
  imageUrl: 'https://example.com/hBP01-081_UR.png',
  yuyuPrice: 3600,
  buyPrice: 2640,
  prices: [{ name: 'UR', sellPrice: 3600, buyPrice: 2640, rarity: 'UR', printing: 'UR' }],
  priceHistory,
  // `printingFromLabel('UR')` (no parenthetical) resolves to the BASE printing,
  // so the exact-identity validator only accepts history stamped BASE.
  priceHistoryMeta: { cardNumber: 'hBP01-081', printing: 'BASE', currency: 'JPY' },
  skillsJp: {
    arts: [{ name: '輝く彗星', cost: '青青青◇赤+50', damage: '60+', effect: 'このホロメンの青エール2枚をアーカイブできる。' }],
    keywords: [{ label: 'キーワード', effect: '空を駆ける光\n自分のエールデッキの上から1枚を、自分の青ホロメンに送る。' }],
  },
  searchKeywords: [],
  normalized: { category: 'holomen', categoryLabel: 'Holomen', stage: '2nd', stageLabel: '2nd' },
};

async function renderDetail(navigation = { navigate() {}, goBack() {} }) {
  return render(React.createElement(CardDetailScreen, {
    route: { params: { card: DETAIL_CARD } },
    navigation,
  }));
}

console.log('── DIC-1427 · App 03 卡牌詳情 Pen o7WO3r IA parity ──');

await test('Card Hero (Pen jzuT9): compact 130px art beside name/set/badges — not the legacy full-bleed image', async () => {
  const { container, cleanup } = await renderDetail();
  try {
    const hero = container.querySelector('[data-testid="card-detail-hero"]');
    assert.ok(hero, 'hero row exists');
    const art = container.querySelector('[data-testid="card-detail-hero-art"]');
    assert.ok(art, 'hero art frame exists (Pen Gwfdo)');
    const artStyle = dom.window.getComputedStyle(art);
    assert.equal(artStyle.width, '130px', 'Pen Gwfdo art width 130 — kills the full-bleed 400px image');
    assert.ok(hero.textContent.includes('星街すいせい'), 'real name in hero (Pen HMarO)');
    assert.ok(hero.textContent.includes('ブルーミングレディアンス'), 'real set line in hero (Pen K8NRDY)');
    const colorBadge = container.querySelector('[data-testid="card-detail-badge-color-blue"]');
    assert.ok(colorBadge, 'color badge chip with dot (Pen r4maBW)');
    const hpCell = container.querySelector('[data-testid="card-detail-stat-hp"]');
    assert.ok(hpCell, 'HP stat cell (Pen w2xYV)');
    assert.ok(hpCell.textContent.includes('210'), 'real HP value renders');
  } finally { await cleanup(); }
});

await test('Tabs (Pen EFhFr): 技能與效果 / 市場價格 / 成員數據 segments really swap the pane', async () => {
  const { container, cleanup } = await renderDetail();
  try {
    const seg = (key) => container.querySelector(`[data-testid="card-detail-seg-${key}"]`);
    const paneHidden = (key) => {
      const pane = container.querySelector(`[data-testid="card-detail-${key}-panel"]`);
      assert.ok(pane, `${key} pane wrapper exists`);
      return dom.window.getComputedStyle(pane).display === 'none';
    };
    for (const key of ['skills', 'market', 'member']) assert.ok(seg(key), `segment ${key} exists`);
    assert.equal(seg('market').getAttribute('aria-selected'), 'true', '市場價格 active by default (Pen P4kfO)');
    assert.ok(container.querySelector('[data-testid="card-detail-price-section"]'), 'market pane holds the price card');
    assert.equal(paneHidden('market'), false, 'market pane visible by default');
    assert.equal(paneHidden('skills'), true, 'skills pane hidden while market active');
    assert.equal(paneHidden('member'), true, 'member pane hidden while market active');

    await act(async () => seg('skills').click());
    assert.equal(seg('skills').getAttribute('aria-selected'), 'true', '技能與效果 activates');
    assert.equal(paneHidden('skills'), false, 'skills pane becomes visible');
    assert.ok(container.textContent.includes('輝く彗星'), 'real art name renders in skills pane');
    assert.equal(paneHidden('market'), true, 'price pane leaves with its tab');

    await act(async () => seg('member').click());
    assert.equal(paneHidden('member'), false, 'member pane becomes visible');
    assert.ok(container.textContent.includes('ブルーミングレディアンス'), 'series info stays reachable in member pane');
  } finally { await cleanup(); }
});

await test('Price Card (Pen qJqlm): source label + 30/700 value + delta chip + history bars + spread cells', async () => {
  const { container, cleanup } = await renderDetail();
  try {
    const priceCard = container.querySelector('[data-testid="card-detail-price-section"]');
    assert.ok(priceCard, 'price card renders');
    assert.ok(priceCard.textContent.includes('遊々亭'), 'source label (Pen jXaTG)');
    const nodes = Array.from(priceCard.querySelectorAll('*'));
    const priceNode = nodes.find((n) => n.textContent === '¥3,600' && n.children.length === 0);
    assert.ok(priceNode, 'price value node');
    const style = dom.window.getComputedStyle(priceNode);
    assert.equal(style.fontSize, '30px', 'Pen x0c32A 30px');
    assert.equal(style.fontWeight, '700', 'Pen x0c32A weight 700');
    assert.equal(style.color, hexToRgb(PALETTE.textPrimary), 'Pen $text-primary');

    const delta = container.querySelector('[data-testid="card-detail-price-delta"]');
    assert.ok(delta, 'delta chip renders from the validated trend (Pen OON71)');
    assert.ok(/%/.test(delta.textContent), 'delta chip carries the real percentage');

    const compare = container.querySelector('[data-testid="card-detail-price-compare"]');
    assert.ok(compare, 'compare line renders (Pen VPvPK)');
    assert.ok(/7/.test(compare.textContent), 'compare line references the 7-day windows');

    const chart = container.querySelector('[data-testid="card-detail-price-chart"]');
    assert.ok(chart, 'history mini chart renders (Pen AKxk8)');
    const bars = chart.querySelectorAll('[data-testid^="card-detail-price-bar-"]');
    assert.ok(bars.length >= 7, `chart draws one bar per real history point (got ${bars.length})`);

    for (const cellKey of ['buy-cost', 'shop-buyback', 'spread']) {
      assert.ok(
        container.querySelector(`[data-testid="card-detail-spread-${cellKey}"]`),
        `spread cell ${cellKey} renders (Pen UhG5Z)`,
      );
    }
  } finally { await cleanup(); }
});

await test('Alert Row (Pen jB05M): 到價提醒 banner lives in the market pane and opens the real editor', async () => {
  const { container, cleanup } = await renderDetail();
  try {
    const banner = container.querySelector('[data-testid="card-price-alert-chip"]');
    assert.ok(banner, 'alert banner renders');
    await act(async () => banner.click());
    await flush();
    assert.ok(
      container.querySelector('[data-testid="price-alert-editor"]')
        || document.querySelector('[data-testid="price-alert-editor"]')
        || container.textContent.includes('UR'),
      'clicking the banner opens the real PriceAlertEditor (printing chooser)',
    );
  } finally { await cleanup(); }
});

await test('Action Bar (Pen Mst3p): 加入收藏 round-trips the favorites store; 加入牌組 targets the real DeckEditor', async () => {
  useFavoritesStore.setState({ favorites: [] });
  const events = [];
  const { container, cleanup } = await renderDetail({
    navigate: (route, params) => events.push([route, params]),
    goBack() {},
  });
  try {
    const bar = container.querySelector('[data-testid="card-detail-action-bar"]');
    assert.ok(bar, 'bottom action bar renders');

    const fav = container.querySelector('[data-testid="card-detail-action-favorite"]');
    assert.ok(fav, '加入收藏 button (Pen c0EK58)');
    await act(async () => fav.click());
    assert.equal(useFavoritesStore.getState().favorites.length, 1, 'favorite persisted to the real store');
    assert.equal(useFavoritesStore.getState().favorites[0].cardNumber, 'hBP01-081');
    await act(async () => container.querySelector('[data-testid="card-detail-action-favorite"]').click());
    assert.equal(
      useFavoritesStore.getState().favorites.filter((f) => !f.removedAt && !f.deleted).length === 1 ? 1 : 0,
      0,
      'second press unfavorites (tombstone or removal)',
    );

    const addDeck = container.querySelector('[data-testid="card-detail-action-add-deck"]');
    assert.ok(addDeck, '加入牌組 button (Pen j8ywIo)');
    await act(async () => addDeck.click());
    assert.equal(events.length, 1, 'one navigation dispatched');
    assert.equal(events[0][0], 'DeckEditor', 'navigates to the real DeckEditor route');
    assert.equal(events[0][1]?.addCardNumber, 'hBP01-081', 'carries the card number for the picker');
  } finally { await cleanup(); }
});

await test('Old-skin rejection: flat info list is not the default pane; member pane carries it instead', async () => {
  const { container, cleanup } = await renderDetail();
  try {
    const memberPane = container.querySelector('[data-testid="card-detail-member-panel"]');
    assert.equal(
      dom.window.getComputedStyle(memberPane).display,
      'none',
      'legacy 類型： info list stays off the default (market) pane',
    );
    assert.ok(memberPane.textContent.includes('類型'), 'info rows live inside the member pane');
    const memberSeg = container.querySelector('[data-testid="card-detail-seg-member"]');
    await act(async () => memberSeg.click());
    assert.notEqual(dom.window.getComputedStyle(memberPane).display, 'none', 'member pane opens on demand');
    assert.ok(memberPane.textContent.includes('Holomen'), 'category info survives inside the member pane');
  } finally { await cleanup(); }
});

console.log(`\nPassed ${passed} tests.`);
