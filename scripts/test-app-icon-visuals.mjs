#!/usr/bin/env node
// DIC-1160: mutation-sensitive regression for the AppIcon foundation.
//
// Every assertion targets the two migrated surfaces called out by DIC-1160
// scope 2 (AppNavigator drawer icons + PriceTrendBadge trend/status icons) and
// would fail if either surface reintroduced an OS emoji glyph, dropped its
// SVG icon, or lost its accessibility semantics.
//
// The test runs the real production modules through react-native-web (same as
// the shipped web build) so a mutation to PriceTrendBadge.tsx or to the icon
// registry surfaces immediately.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

// Forbidden emoji glyphs — the exact pre-migration set for the migrated
// surfaces. If any of these ever appear again in the rendered DOM, the
// mutation the CR forbids has landed.
const NAV_EMOJI = ['🏠', '📷', '🔍', '❤️', '🃏', '🏆', '🔔', '📚', '⚙️'];
const TREND_EMOJI = ['📈', '📉', '➡️', '📊'];

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
const { iconRegistry } = await import('../src/components/common/iconRegistry.ts');
const { AppIcon } = await import('../src/components/common/AppIcon.tsx');
const PriceTrendBadgeModule = await import('../src/components/PriceTrendBadge.tsx');
const PriceTrendBadge = PriceTrendBadgeModule.default;
const { DESIGN_TOKENS } = await import('../src/constants/tokens.ts');

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

// 1. Registry contract — the nav + trend icon set must exist as SVG path data.
await test('iconRegistry defines every drawer icon required by AppNavigator', async () => {
  const required = ['home', 'camera', 'search', 'heart', 'layers', 'trophy', 'bell', 'book-open', 'settings'];
  for (const name of required) {
    assert.ok(iconRegistry[name], `iconRegistry.${name} missing — AppNavigator drawer icon would fall through`);
    assert.ok(Array.isArray(iconRegistry[name]) && iconRegistry[name].length > 0, `iconRegistry.${name} must have at least one path`);
    for (const d of iconRegistry[name]) {
      assert.equal(typeof d, 'string');
      assert.ok(d.length > 0, `iconRegistry.${name} path must be a non-empty string`);
    }
  }
});

await test('iconRegistry defines every PriceTrendBadge state icon', async () => {
  for (const name of ['trending-up', 'trending-down', 'minus', 'bar-chart-2']) {
    assert.ok(iconRegistry[name], `iconRegistry.${name} missing — PriceTrendBadge would fall back to nothing`);
  }
});

// 2. Design tokens — the palette + icon-size scale must stay accessible.
await test('DESIGN_TOKENS carries the WCAG-AA palette the drawer icon relies on', async () => {
  assert.equal(DESIGN_TOKENS.colors.primary, '#ff6b9d');
  assert.equal(DESIGN_TOKENS.colors.textSecondary, '#a0aec0');
  assert.equal(DESIGN_TOKENS.iconSize.md, 20);
});

// 3. AppIcon rendering — decorative default + labelled variant.
await test('AppIcon(name="home") renders SVG paths, not emoji text', async () => {
  const { container, cleanup } = await render(React.createElement(AppIcon, { name: 'home', testID: 'icon-home' }));
  try {
    // Text must be free of ANY forbidden emoji (defense in depth).
    for (const glyph of [...NAV_EMOJI, ...TREND_EMOJI]) {
      assert.ok(!container.textContent.includes(glyph), `AppIcon rendered forbidden glyph ${glyph}`);
    }
    // SVG stub records each `d` prop as data-svg-path.
    const paths = Array.from(container.querySelectorAll('[data-svg-path]'));
    assert.ok(paths.length > 0, 'AppIcon must render at least one Path element');
    const dValues = paths.map((n) => n.getAttribute('data-svg-path'));
    for (const d of iconRegistry.home) {
      assert.ok(dValues.includes(d), `AppIcon(home) must render registry path ${d.slice(0, 20)}...`);
    }
  } finally { await cleanup(); }
});

await test('AppIcon default is decorative (aria-hidden) — the drawer text label is the a11y source', async () => {
  const { container, cleanup } = await render(React.createElement(AppIcon, { name: 'home' }));
  try {
    // JSDOM lowercases the attribute name. react-native-web forwards
    // accessibilityElementsHidden as aria-hidden on web.
    const svg = container.querySelector('[data-svg-tag="svg"]');
    assert.ok(svg, 'svg element must render');
    // On web the aria-hidden attribute lands on the <svg> stub.
    assert.equal(svg.getAttribute('aria-hidden'), 'true', 'decorative AppIcon must set aria-hidden on the SVG surface');
  } finally { await cleanup(); }
});

await test('AppIcon with decorative=false surfaces role=img + accessibilityLabel', async () => {
  const { container, cleanup } = await render(
    React.createElement(AppIcon, { name: 'trending-up', decorative: false, accessibilityLabel: 'Price trending up' }),
  );
  try {
    const svg = container.querySelector('[data-svg-tag="svg"]');
    assert.ok(svg, 'svg element must render');
    assert.equal(svg.getAttribute('role'), 'img');
    assert.equal(svg.getAttribute('aria-label'), 'Price trending up');
  } finally { await cleanup(); }
});

// 4. PriceTrendBadge — every trend variant, compact + expanded, must render an
// AppIcon and contain no forbidden trend emoji glyph.
for (const [trend, iconName] of [
  ['up', 'trending-up'],
  ['down', 'trending-down'],
  ['stable', 'minus'],
]) {
  await test(`PriceTrendBadge(compact, trend="${trend}") renders AppIcon(${iconName}) and no emoji`, async () => {
    const { container, cleanup } = await render(
      React.createElement(PriceTrendBadge, { trend, score: 0.1, compact: true }),
    );
    try {
      for (const glyph of TREND_EMOJI) {
        assert.ok(!container.textContent.includes(glyph), `PriceTrendBadge compact ${trend} rendered forbidden glyph ${glyph}`);
      }
      const iconWrap = container.querySelector(`[data-testid="price-trend-icon-${trend}"]`);
      assert.ok(iconWrap, `expected price-trend-icon-${trend} wrapper`);
      const paths = Array.from(container.querySelectorAll('[data-svg-path]'));
      const dValues = paths.map((n) => n.getAttribute('data-svg-path'));
      for (const d of iconRegistry[iconName]) {
        assert.ok(dValues.includes(d), `PriceTrendBadge(${trend}) must render iconRegistry.${iconName} path ${d.slice(0, 24)}...`);
      }
    } finally { await cleanup(); }
  });

  await test(`PriceTrendBadge(expanded, trend="${trend}") renders AppIcon(${iconName}) and no emoji`, async () => {
    const { container, cleanup } = await render(
      React.createElement(PriceTrendBadge, { trend, score: 0.1, confidence: 0.5 }),
    );
    try {
      for (const glyph of TREND_EMOJI) {
        assert.ok(!container.textContent.includes(glyph), `PriceTrendBadge expanded ${trend} rendered forbidden glyph ${glyph}`);
      }
      const iconWrap = container.querySelector(`[data-testid="price-trend-icon-${trend}"]`);
      assert.ok(iconWrap, `expected price-trend-icon-${trend} wrapper`);
    } finally { await cleanup(); }
  });
}

// 5. Static source assertion — the drawer file must NOT reintroduce nav emojis.
// This catches a mutation that touches AppNavigator.tsx directly (bypasses
// the runtime rendering path entirely).
await test('AppNavigator.tsx source contains no forbidden drawer emoji glyphs', async () => {
  const source = readFileSync(path.join(repoRoot, 'src/navigation/AppNavigator.tsx'), 'utf8');
  for (const glyph of NAV_EMOJI) {
    assert.ok(!source.includes(glyph), `AppNavigator.tsx still contains forbidden emoji ${glyph}`);
  }
  // Must reference AppIcon (proves the migration is wired, not just deleted).
  assert.ok(source.includes("from '../components/common/AppIcon'"), 'AppNavigator.tsx must import AppIcon');
  // Nine drawer icons via drawerIconFor(...) — home, camera, search, heart,
  // layers, trophy, bell, book-open, settings.
  const usages = source.match(/drawerIconFor\(/g) ?? [];
  assert.ok(usages.length >= 9, `AppNavigator.tsx must wire drawerIconFor for every route (got ${usages.length})`);
});

await test('PriceTrendBadge.tsx source contains no forbidden trend emoji glyphs', async () => {
  const source = readFileSync(path.join(repoRoot, 'src/components/PriceTrendBadge.tsx'), 'utf8');
  for (const glyph of TREND_EMOJI) {
    assert.ok(!source.includes(glyph), `PriceTrendBadge.tsx still contains forbidden emoji ${glyph}`);
  }
  assert.ok(source.includes("from './common/AppIcon'"), 'PriceTrendBadge.tsx must import AppIcon');
});

// 6. i18n nav_* keys must not reintroduce emoji-prefixed titles for the
// migrated drawer entries.
await test('nav_* i18n titles carry no leading emoji', async () => {
  for (const locale of ['zh', 'ja']) {
    const source = readFileSync(path.join(repoRoot, `src/i18n/locales/${locale}.ts`), 'utf8');
    for (const key of ['nav_home', 'nav_scan', 'nav_search', 'nav_favorites', 'nav_deck_editor', 'nav_tournament_report', 'nav_watchlist', 'nav_tutorial', 'nav_settings']) {
      const match = source.match(new RegExp(`${key}:\\s*'([^']*)'`));
      assert.ok(match, `${locale}.ts missing ${key}`);
      for (const glyph of [...NAV_EMOJI, ...TREND_EMOJI]) {
        assert.ok(!match[1].includes(glyph), `${locale}.${key} = "${match[1]}" still contains ${glyph}`);
      }
    }
  }
});

console.log(`\nDIC-1160 AppIcon foundation: ${passed} tests passed`);
