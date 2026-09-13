#!/usr/bin/env node
// DIC-1427 QA P0 — Pen `App / 10 賽事月報` (frame wRgD8) IA on the shipped
// TournamentReportScreen with the REAL report pipeline intact.
//
// The prior Preview rendered an emoji heading + chip grid — no month
// navigator, no 本月熱門卡 hero, no color-distribution bars, no podium.
// These tests load the REAL committed report fixtures
// (public/data/tournaments/*.json) through a stubbed fetch and pin:
//   • HJici month navigator: prev/next really move the scope
//   • RxPbs hero: top representative card + real 樣本/採用率 metrics
//   • XmHeK 觀察分佈: one Pen color bar per real topColors entry, tap filters
//   • SboNx podium: medal rows from the real notable placements
//   • loading/error states and the summary/donut/events pipeline preserved

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
Object.defineProperty(dom.window, 'innerWidth', { value: 390, configurable: true });

// Serve the REAL committed report fixtures through fetch.
const FIXTURES = {
  '/data/tournaments/index.json': JSON.parse(readFileSync('public/data/tournaments/index.json', 'utf8')),
  '/data/tournaments/2026-08.json': JSON.parse(readFileSync('public/data/tournaments/2026-08.json', 'utf8')),
  '/data/tournaments/2026-07.json': JSON.parse(readFileSync('public/data/tournaments/2026-07.json', 'utf8')),
};
globalThis.fetch = async (url) => {
  const path = String(url).replace('https://holohunter.dicoge.com', '');
  const body = FIXTURES[path];
  if (!body) return { ok: false, status: 404, json: async () => { throw new Error('404'); } };
  return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
};
dom.window.fetch = globalThis.fetch;

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { buildTournamentMonthlySummary } = await import('../src/utils/tournamentSummary.ts');
const { default: TournamentReportScreen } = await import('../src/screens/TournamentReportScreen.tsx');

const expectedSummary = buildTournamentMonthlySummary(
  [FIXTURES['/data/tournaments/2026-08.json'], FIXTURES['/data/tournaments/2026-07.json']],
  'all',
  'zh',
);
assert.ok(expectedSummary.topColors.length >= 2, 'real fixtures carry a color distribution');
assert.ok(expectedSummary.notablePlacements.length >= 3, 'real fixtures carry notable placements for the podium');
assert.ok(expectedSummary.representativeCards.length >= 1, 'real fixtures carry a representative card for the hero');

async function flush(ms = 0) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}
async function render(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  // Let the index + month reports resolve.
  await flush(10);
  await flush(10);
  await flush(10);
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

console.log('── DIC-1427 · App 10 賽事月報 Pen wRgD8 IA parity ──');

await test('wRgD8 month navigator (Pen HJici): prev/next really move the real scope', async () => {
  const { container, cleanup } = await render(React.createElement(TournamentReportScreen));
  try {
    const nav = container.querySelector('[data-testid="tournament-month-nav"]');
    assert.ok(nav, 'month navigator renders');
    const label = container.querySelector('[data-testid="tournament-month-label"]');
    assert.ok(label, 'scope label renders');
    const initialLabel = label.textContent;

    const next = container.querySelector('[data-testid="tournament-month-next"]');
    assert.ok(next, 'next chevron');
    await act(async () => next.click());
    await flush(10);
    const movedLabel = container.querySelector('[data-testid="tournament-month-label"]').textContent;
    assert.notEqual(movedLabel, initialLabel, 'next moves to a different real scope');
    assert.ok(/2026/.test(movedLabel), 'scoped label carries the real month');

    const prev = container.querySelector('[data-testid="tournament-month-prev"]');
    await act(async () => prev.click());
    await flush(10);
    assert.equal(
      container.querySelector('[data-testid="tournament-month-label"]').textContent,
      initialLabel,
      'prev returns to the original scope',
    );
  } finally { await cleanup(); }
});

await test('wRgD8 hero (Pen RxPbs): top representative card with real 樣本 + 採用率 metrics', async () => {
  const { container, cleanup } = await render(React.createElement(TournamentReportScreen));
  try {
    const hero = container.querySelector('[data-testid="tournament-hero"]');
    assert.ok(hero, 'gradient hero renders');
    const topCard = expectedSummary.representativeCards[0];
    assert.ok(hero.textContent.includes(topCard.cardNumber), 'hero names the real top representative card');
    assert.ok(
      hero.textContent.includes(`${expectedSummary.verifiedDeckCount}`),
      'hero sample line carries the real verified deck count',
    );
    const rate = Math.round(topCard.adoptionRate * 100);
    assert.ok(hero.textContent.includes(`${rate}%`), `hero metric carries the real adoption rate ${rate}%`);
  } finally { await cleanup(); }
});

await test('wRgD8 觀察分佈 (Pen XmHeK): one color bar per real topColors entry; tap filters events', async () => {
  const { container, cleanup } = await render(React.createElement(TournamentReportScreen));
  try {
    const bars = container.querySelector('[data-testid="tournament-color-bars"]');
    assert.ok(bars, 'color bar block renders');
    for (const item of expectedSummary.topColors) {
      const row = bars.querySelector(`[data-testid="summary-color-${item.color}"]`);
      assert.ok(row, `bar row for real color ${item.color}`);
      const pct = Math.round((item.count / expectedSummary.verifiedDeckCount) * 100);
      assert.ok(row.textContent.includes(`${pct}%`), `row shows the real share ${pct}% for ${item.color}`);
    }
    const first = expectedSummary.topColors[0];
    await act(async () => bars.querySelector(`[data-testid="summary-color-${first.color}"]`).click());
    await flush(10);
    assert.ok(
      container.querySelector('[data-testid="donut-clear"]'),
      'tapping a color bar arms the real color filter (clear affordance appears)',
    );
  } finally { await cleanup(); }
});

await test('wRgD8 podium (Pen SboNx): medal rows from the real notable placements', async () => {
  const { container, cleanup } = await render(React.createElement(TournamentReportScreen));
  try {
    const podium = container.querySelector('[data-testid="tournament-podium"]');
    assert.ok(podium, 'podium renders');
    const rows = podium.querySelectorAll('[data-testid^="tournament-podium-row-"]');
    const expectedRows = Math.min(3, expectedSummary.notablePlacements.length);
    assert.equal(rows.length, expectedRows, `podium shows the real top ${expectedRows} placements`);
    const first = expectedSummary.notablePlacements[0];
    assert.ok(
      rows[0].textContent.includes(first.archetypeLabel || first.oshi || ''),
      'first podium row carries the real deck label',
    );
    assert.ok(
      rows[0].textContent.includes(first.playerName || ''),
      'first podium row carries the real player',
    );
  } finally { await cleanup(); }
});

await test('wRgD8 preserved pipeline: summary card, distribution chart and event/deck list survive', async () => {
  const { container, cleanup } = await render(React.createElement(TournamentReportScreen));
  try {
    assert.ok(container.querySelector('[data-testid="tournament-monthly-summary"]'), 'monthly summary card intact');
    assert.ok(
      container.querySelector('[data-testid="dimension-archetype"]'),
      'archetype/oshi dimension chart intact',
    );
    assert.ok(
      container.querySelectorAll('[data-testid^="deck-"]').length > 0,
      'real event deck rows intact',
    );
    assert.ok(
      container.querySelector('[data-testid="tournament-source-footer"]'),
      'source coverage footer intact',
    );
  } finally { await cleanup(); }
});

console.log(`\nPassed ${passed} tests.`);
