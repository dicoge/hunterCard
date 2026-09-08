#!/usr/bin/env node
// DIC-1159 regression — production desktop hBP04 search blanked with
// "Missing translation key: color_◇ (zh)" because SearchResultsScreen fed the
// raw source color value (`◇` wildcard on hBP04-087/088 / hBP06-084;
// `blue_red` on hBP08-060) straight into `t(\`color_${color}\`)`. The rendering
// path threw during render, React unmounted the whole page, and the parent
// DIC-1141 canonical desktop E2E was blocked from ever running.
//
// After the 2026-08-28 catalog sync (chore: sync official catalog) the
// authoritative token no longer sits at `card.color` — the sync rewrites the
// top-level color on hBP04-087/088/hBP06-084 to the string `"null"` and
// keeps `◇` only inside the nested `skillsJp.color` / `skillsZh.color`. The
// DIC-1159 CR (Mac-Codex) called out that reading only top-level `card.color`
// leaves those winners rendering NO color instead of the DIC-1192 `無色`.
//
// This suite locks the fail-safe in place through the REAL screens, not
// source regex or reimplemented dedup:
//   1. `canonicalCardColors()` splits authoritative dual-color tokens
//      (`blue_red` → ['blue', 'red']) and drops anything else (`◇`, gibberish)
//      into an empty list flagged with `hasUnknownColor: true`.
//   2. `resolveCardColorsWithNestedFallback()` composes canonical → permissive
//      → nested-source, so ◇ still becomes `colorless` on the real winning
//      row and never leaks a raw token to `t()`.
//   3. The i18n dictionary carries `color_<id>` for every canonical id — and
//      never for `◇` / `blue_red` / other raw tokens; `t()` still throws on
//      a missing `color_<raw>` key so any regression is loud.
//   4. Production `data/database.json` still carries the exact
//      hBP04-087/088 / hBP06-084 / hBP08-060 rows the crash was reported
//      against, so the regression stays anchored to real cards.
//   5. The real `SearchResultsScreen` renders the hBP04 diamond winner as
//      `無色` at 1440 AND 390, blue_red as `藍色 / 紅色`, and hides the label
//      (without throwing) for a truly unknown token — driven end-to-end
//      through the shipped `searchCards` → `CardListItem` path.
//   6. The real `CardDetailScreen` renders `無色` for the ◇ row (top-level
//      "null" + nested `◇`), `藍色 / 紅色` for `blue_red`, and hides the
//      color row (without throwing) for a truly unknown token.
//   7. If a future edit removes the nested-source fallback, the composed
//      helper returns [] on the exact production-shape fixture, so the
//      mutation shows up here before it can ship.
//
// Run: npm run test:dic1159-unknown-color

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// ── jsdom must be installed before react-native-web is imported. ──────────
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://holohunter.dicoge.com/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key in globalThis) continue;
  try { globalThis[key] = dom.window[key]; } catch { /* read-only */ }
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const observedLayoutNodes = new Set();
class TestResizeObserver {
  constructor(callback) { this.callback = callback; }
  observe(node) { observedLayoutNodes.add({ node, callback: this.callback }); }
  unobserve(node) {
    for (const entry of Array.from(observedLayoutNodes)) {
      if (entry.node === node && entry.callback === this.callback) observedLayoutNodes.delete(entry);
    }
  }
  disconnect() {
    for (const entry of Array.from(observedLayoutNodes)) {
      if (entry.callback === this.callback) observedLayoutNodes.delete(entry);
    }
  }
}
globalThis.ResizeObserver = TestResizeObserver;
dom.window.ResizeObserver = TestResizeObserver;

let viewportWidth = 1440;
let viewportHeight = 900;
const DESKTOP_MAX_WIDTH = 1100;
function setViewport(width, height = 900) {
  viewportWidth = width;
  viewportHeight = height;
  Object.defineProperty(document.documentElement, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(document.documentElement, 'clientHeight', { value: height, configurable: true });
  Object.defineProperty(document.documentElement, 'scrollWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
  window.dispatchEvent(new window.Event('resize'));
}
Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get() { return Math.min(viewportWidth, DESKTOP_MAX_WIDTH); },
});
Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get() { return viewportHeight; },
});
Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetLeft', { configurable: true, get() { return 0; } });
Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetTop', { configurable: true, get() { return 0; } });

const {
  canonicalCardColors,
  CANONICAL_COLOR_IDS,
  resolveCardColorsWithNestedFallback,
  normalizeColorTokens,
} = await import('../src/utils/cardNormalization.ts');
const { t, zh, ja } = await import('../src/i18n/index.ts');

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { SafeAreaProvider } = await import('react-native-safe-area-context');
const searchResultsModule = await import('../src/screens/SearchResultsScreen.tsx');
const {
  default: SearchResultsScreen,
  __seedSearchResultsCacheForTest: seedCache,
} = searchResultsModule;
const CardDetailScreen = (await import('../src/screens/CardDetailScreen.tsx')).default;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function fireObservedLayouts() {
  await act(async () => {
    for (const { node, callback } of Array.from(observedLayoutNodes)) callback([{ target: node }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// ── 1. canonicalCardColors semantics ───────────────────────────────────────

await test('canonicalCardColors drops the ◇ wildcard so it never reaches t()', () => {
  const result = canonicalCardColors('◇');
  assert.deepEqual(result.colors, [], '◇ must not be treated as a real color');
  assert.equal(result.hasUnknownColor, true, '◇ must be flagged as unknown');
});

await test('canonicalCardColors splits blue_red into canonical parts', () => {
  const result = canonicalCardColors('blue_red');
  assert.deepEqual(result.colors, ['blue', 'red']);
  assert.equal(result.hasUnknownColor, false, 'split canonical parts are not unknown');
});

await test('canonicalCardColors also accepts / as dual-color separator', () => {
  const result = canonicalCardColors('blue/red');
  assert.deepEqual(result.colors, ['blue', 'red']);
  assert.equal(result.hasUnknownColor, false);
});

await test('canonicalCardColors refuses to split when one side is not canonical', () => {
  const result = canonicalCardColors('blue_mystery');
  assert.deepEqual(result.colors, []);
  assert.equal(result.hasUnknownColor, true);
});

await test('canonicalCardColors treats every canonical single value as canonical', () => {
  for (const id of CANONICAL_COLOR_IDS) {
    const result = canonicalCardColors(id);
    assert.deepEqual(result.colors, [id]);
    assert.equal(result.hasUnknownColor, false, `${id} is not unknown`);
  }
});

await test('canonicalCardColors treats empty / null / non-string as no color, not unknown', () => {
  for (const raw of ['', '   ', null, undefined, 42, {}]) {
    const result = canonicalCardColors(raw);
    assert.deepEqual(result.colors, []);
    assert.equal(result.hasUnknownColor, false,
      `${JSON.stringify(raw)} is empty, not unknown`);
  }
});

// ── 2. i18n coverage: canonical keys present, non-canonical keys absent ───

await test('every canonical color id has a color_<id> translation in zh and ja', () => {
  for (const id of CANONICAL_COLOR_IDS) {
    const key = `color_${id}`;
    assert.ok(zh[key] && zh[key].trim().length > 0, `zh.${key} present`);
    assert.ok(ja[key] && ja[key].trim().length > 0, `ja.${key} present`);
    assert.doesNotThrow(() => t(key, 'zh'), `t(${key}, zh) resolves`);
    assert.doesNotThrow(() => t(key, 'ja'), `t(${key}, ja) resolves`);
  }
});

await test('non-canonical color values do NOT get a translation key (the whole point)', () => {
  for (const raw of ['◇', 'blue_red', 'blue/red', 'blue_mystery', 'mystery', 'null']) {
    const key = `color_${raw}`;
    assert.equal(zh[key], undefined, `zh must not have ${key}`);
    assert.equal(ja[key], undefined, `ja must not have ${key}`);
  }
});

await test('t() still fails closed on missing color_<raw> so any regression is loud', () => {
  assert.throws(
    () => t('color_◇', 'zh'),
    /Missing translation key: color_◇ \(zh\)/,
    't() must keep throwing on the exact key that crashed production',
  );
  assert.throws(
    () => t('color_blue_red', 'zh'),
    /Missing translation key: color_blue_red \(zh\)/,
  );
  assert.throws(
    () => t('color_null', 'zh'),
    /Missing translation key: color_null \(zh\)/,
    'the string "null" that catalog sync now writes at top-level MUST also fail if it slipped through to t()',
  );
});

// ── 3. Production data still carries the crashing fixtures ────────────────

const db = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'database.json'), 'utf8'));
const allCards = Object.values(db.cards || {});

await test('database.json still has the hBP04 / hBP06 ◇ printings from the DIC-1146 evidence', () => {
  // 2026-08-28 catalog sync normalises the top-level `color` on the crashing
  // rows to the string `"null"`, but the authoritative token still lives in
  // the nested skillsJp / skillsZh blocks — and that's the source the
  // canonical/permissive composition now falls back to. A row counts as
  // "still carries the ◇ crash source" if ◇ appears at ANY of those spots.
  const carriesDiamond = (c) =>
    c.color === '◇' ||
    (c.skillsJp && c.skillsJp.color === '◇') ||
    (c.skillsZh && c.skillsZh.color === '◇');
  for (const cardNumber of ['hBP04-087', 'hBP04-088', 'hBP06-084']) {
    const withDiamond = allCards.filter(
      (c) => c.cardNumber === cardNumber && carriesDiamond(c),
    );
    assert.ok(
      withDiamond.length > 0,
      `${cardNumber} with a ◇ source colour (top-level or skillsJp/skillsZh) must remain in database.json`,
    );
  }
});

await test('database.json still has the hBP08-060 blue_red printing from the DIC-1146 evidence', () => {
  const fuwamoco = allCards.find(
    (c) => c.cardNumber === 'hBP08-060' && c.color === 'blue_red',
  );
  assert.ok(fuwamoco, "hBP08-060 with color='blue_red' must remain in database.json");
});

// ── 4. resolveCardColorsWithNestedFallback: composed helper contract ──────

await test('resolveCardColorsWithNestedFallback returns canonical colors when top-level is authoritative', () => {
  assert.deepEqual(resolveCardColorsWithNestedFallback({ color: 'blue' }), ['blue']);
  assert.deepEqual(resolveCardColorsWithNestedFallback({ color: 'blue_red' }), ['blue', 'red']);
});

await test('resolveCardColorsWithNestedFallback recovers colorless for the DIC-1192 top-level ◇ shape', () => {
  assert.deepEqual(resolveCardColorsWithNestedFallback({ color: '◇' }), ['colorless']);
});

await test('resolveCardColorsWithNestedFallback falls back to nested skillsJp/skillsZh when top-level yields nothing', () => {
  // The exact production-shape after 2026-08-28 catalog sync: top-level
  // `color: "null"` (a stringified null the sync emits when it isn't sure)
  // + nested `◇` in skillsJp / skillsZh. This is the CR blocker fixture.
  const productionShape = {
    color: 'null',
    skillsJp: { color: '◇' },
    skillsZh: { color: '◇' },
  };
  assert.deepEqual(
    resolveCardColorsWithNestedFallback(productionShape),
    ['colorless'],
    'nested ◇ must resolve to colorless when top-level color is stringified "null"',
  );
});

await test('resolveCardColorsWithNestedFallback prefers top-level authoritative colour over nested legacy value', () => {
  // A row that DOES carry a real top-level color must not be diluted by an
  // out-of-date nested value. The fallback only fires when the top-level
  // produced nothing. This is the guardrail against the naïve fix "just
  // always mix both".
  const shape = {
    color: 'purple',
    skillsJp: { color: '◇' },
    skillsZh: { color: '◇' },
  };
  assert.deepEqual(resolveCardColorsWithNestedFallback(shape), ['purple']);
});

await test('resolveCardColorsWithNestedFallback drops truly unknown top-level tokens with no nested rescue', () => {
  // Truly unknown top-level (mystery/gibberish) with no nested value must
  // NOT synthesise a color — that would mislabel the card.
  assert.deepEqual(resolveCardColorsWithNestedFallback({ color: 'mystery' }), []);
  assert.deepEqual(resolveCardColorsWithNestedFallback({ color: 'mystery', skillsJp: null, skillsZh: null }), []);
});

await test('resolveCardColorsWithNestedFallback handles empty / missing card safely', () => {
  assert.deepEqual(resolveCardColorsWithNestedFallback(undefined), []);
  assert.deepEqual(resolveCardColorsWithNestedFallback(null), []);
  assert.deepEqual(resolveCardColorsWithNestedFallback({}), []);
  assert.deepEqual(resolveCardColorsWithNestedFallback({ color: '', skillsJp: {}, skillsZh: {} }), []);
});

// ── 5. Real SearchResultsScreen render — production-shape fixtures ────────

const SERIES_NAMES = {
  hBP04: 'ホロライブ ブースターパック 04',
  hBP08: 'ホロライブ ブースターパック 08',
  hBP09: 'DIC-1159 CR fixture series',
};

// Exactly the shape data/database.json currently carries on the real crash
// winners after the 2026-08-28 catalog sync: top-level `color: "null"` and
// the authoritative ◇ token inside skillsJp / skillsZh.
function productionShapeDiamondRow() {
  return {
    id: 'hBP04-087_hBP04',
    cardNumber: 'hBP04-087',
    name: 'エリザベス・ローズ・ブラッドフレイム',
    nameZh: '伊麗莎白',
    series: 'hBP04',
    type: 'Holomen',
    rarity: 'S',
    color: 'null',
    sellPrice: 30,
    prices: [{ name: 'S', sellPrice: 30, rarity: 'S' }],
    skillsJp: { cardNumber: 'hBP04-087', name: 'エリザベス', cardType: 'ホロメン', color: '◇' },
    skillsZh: { cardNumber: 'hBP04-087', name: '伊麗莎白', cardType: '成員', color: '◇' },
  };
}

function blueRedRow() {
  return {
    id: 'hBP08-060_hBP08',
    cardNumber: 'hBP08-060',
    name: 'フワモコ',
    nameZh: '芙娃莫娃',
    series: 'hBP08',
    type: 'Holomen',
    rarity: 'R',
    color: 'blue_red',
    sellPrice: 200,
    prices: [{ name: 'R', sellPrice: 200, rarity: 'R' }],
  };
}

function unknownTokenRow() {
  return {
    id: 'hBP09-999_hBP09',
    cardNumber: 'hBP09-999',
    name: 'CR Negative Fixture',
    nameZh: 'CR 負面測試',
    series: 'hBP09',
    type: 'Support',
    rarity: 'C',
    color: 'mystery',
    sellPrice: 10,
    prices: [{ name: 'C', sellPrice: 10, rarity: 'C' }],
    skillsJp: { color: 'mystery' },
    skillsZh: { color: 'mystery' },
  };
}

async function renderSearchAt(viewport, query, row) {
  seedCache({ cards: { [row.id]: row }, totalCards: 1, lastUpdated: '2026-08-28' }, SERIES_NAMES);
  setViewport(viewport, viewport === 390 ? 844 : 900);
  observedLayoutNodes.clear();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const captured = [];
  const originalError = console.error;
  console.error = (...args) => { captured.push(args.map(String).join(' ')); };
  try {
    await act(async () => root.render(React.createElement(SearchResultsScreen, {
      route: { params: { query } },
      navigation: { navigate() {} },
    })));
    await flush();
    await fireObservedLayouts();
    await flush();
  } finally {
    console.error = originalError;
  }
  const items = Array.from(container.querySelectorAll('[data-testid="search-result-grid-item"]'));
  return {
    container,
    items,
    capturedErrors: captured,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
      seedCache(null, null);
    },
  };
}

for (const viewport of [1440, 390]) {
  await test(`SearchResultsScreen at ${viewport}px renders 無色 for the real hBP04-087 winner (top-level color:"null" + skillsJp/skillsZh ◇)`, async () => {
    const { container, items, capturedErrors, cleanup } = await renderSearchAt(viewport, 'hBP04', productionShapeDiamondRow());
    try {
      assert.equal(items.length, 1, `hBP04-087 fixture must render one grid item at ${viewport}px, got ${items.length}`);
      const missingKey = capturedErrors.find((msg) => /Missing translation key/i.test(msg));
      assert.equal(missingKey, undefined,
        `render must not throw \`Missing translation key\` — saw: ${missingKey}`);
      const text = container.textContent;
      assert.ok(text.includes('hBP04-087'), 'the crash-row card number must appear in the rendered DOM');
      assert.ok(text.includes('無色'),
        `the nested ◇ MUST resolve to 無色 on the real screen at ${viewport}px — this is the DIC-1192 label DIC-1159 CR requires preserved`);
      assert.ok(!text.includes('color_◇'), 'raw i18n key must never leak to the DOM');
      assert.ok(!text.includes('◇'), 'raw ◇ marker must not appear as the color label');
    } finally { await cleanup(); }
  });
}

for (const viewport of [1440, 390]) {
  await test(`SearchResultsScreen at ${viewport}px renders 藍 / 紅 for the real hBP08-060 blue_red winner`, async () => {
    const { container, items, capturedErrors, cleanup } = await renderSearchAt(viewport, 'hBP08', blueRedRow());
    try {
      assert.equal(items.length, 1);
      const missingKey = capturedErrors.find((msg) => /Missing translation key/i.test(msg));
      assert.equal(missingKey, undefined,
        `blue_red must not throw a missing-key error — saw: ${missingKey}`);
      const text = container.textContent;
      // zh translations are single-char (see src/i18n/locales/zh.ts): color_blue = 藍, color_red = 紅.
      // CardListItem joins them with ' / ' — the rendered label is `藍 / 紅`, which is
      // the exact string the JP scraper's `blue_red` composite must land as after both
      // canonicalCardColors splits and t() lookup.
      assert.ok(text.includes('hBP08-060'));
      assert.ok(text.includes('藍 / 紅'),
        `blue_red must render as the joined single-char label \`藍 / 紅\` at ${viewport}px — got: ${text}`);
      assert.ok(!text.includes('color_blue_red'), 'raw composite key must not leak');
      assert.ok(!text.includes('blue_red'), 'raw composite token must not appear in the DOM');
    } finally { await cleanup(); }
  });
}

await test('SearchResultsScreen at 1440px never crashes on a truly unknown color token — label is hidden, page still renders', async () => {
  const { container, items, capturedErrors, cleanup } = await renderSearchAt(1440, 'hBP09', unknownTokenRow());
  try {
    assert.equal(items.length, 1, 'unknown-color row must still render as a grid item — no fail-closed page unmount');
    const missingKey = capturedErrors.find((msg) => /Missing translation key/i.test(msg));
    assert.equal(missingKey, undefined,
      `unknown token must not throw a missing-key error — saw: ${missingKey}`);
    const text = container.textContent;
    assert.ok(text.includes('hBP09-999'), 'the unknown-color row must still be visible');
    assert.ok(!text.includes('mystery'), 'the raw unknown token must not be shown as a color label');
    assert.ok(!text.includes('color_mystery'), 'the raw i18n key must not leak');
  } finally { await cleanup(); }
});

// ── 6. Real CardDetailScreen render — production-shape fixtures ───────────

async function renderCardDetail(cardParam) {
  setViewport(1440, 900);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const captured = [];
  const originalError = console.error;
  console.error = (...args) => { captured.push(args.map(String).join(' ')); };
  try {
    await act(async () => root.render(
      React.createElement(
        SafeAreaProvider,
        { initialMetrics: { insets: { top: 0, bottom: 0, left: 0, right: 0 }, frame: { x: 0, y: 0, width: 1440, height: 900 } } },
        React.createElement(CardDetailScreen, {
          route: { params: { card: cardParam } },
          navigation: { navigate() {}, goBack() {} },
        }),
      ),
    ));
    await flush();
  } finally {
    console.error = originalError;
  }
  return {
    container,
    capturedErrors: captured,
    cleanup: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

await test('CardDetailScreen renders 無色 for the real hBP04-087 winner (top-level color:"null" + nested ◇)', async () => {
  const { container, capturedErrors, cleanup } = await renderCardDetail(productionShapeDiamondRow());
  try {
    const missingKey = capturedErrors.find((msg) => /Missing translation key/i.test(msg));
    assert.equal(missingKey, undefined,
      `CardDetail render must not throw a missing-key error — saw: ${missingKey}`);
    const text = container.textContent;
    assert.ok(text.includes('hBP04-087'), 'card number must render on the detail page');
    assert.ok(text.includes('無色'),
      'CardDetail must resolve the nested ◇ to 無色 — CR blocker #1');
    assert.ok(!text.includes('color_◇'), 'raw i18n key must not leak');
    assert.ok(!text.includes(' ◇ '), 'raw ◇ marker must not appear as the color value');
  } finally { await cleanup(); }
});

await test('CardDetailScreen renders 藍 / 紅 for the real hBP08-060 blue_red row', async () => {
  const { container, capturedErrors, cleanup } = await renderCardDetail(blueRedRow());
  try {
    const missingKey = capturedErrors.find((msg) => /Missing translation key/i.test(msg));
    assert.equal(missingKey, undefined);
    const text = container.textContent;
    assert.ok(text.includes('hBP08-060'));
    assert.ok(text.includes('藍 / 紅'),
      `CardDetail must render the joined blue/red label \`藍 / 紅\` (zh single-char color_* values, joined by InfoRow) — got: ${text}`);
    assert.ok(!text.includes('color_blue_red'));
    assert.ok(!text.includes('blue_red'), 'raw composite token must not appear on the detail page');
  } finally { await cleanup(); }
});

await test('CardDetailScreen never crashes on a truly unknown color token — color row hidden, page still renders', async () => {
  const { container, capturedErrors, cleanup } = await renderCardDetail(unknownTokenRow());
  try {
    const missingKey = capturedErrors.find((msg) => /Missing translation key/i.test(msg));
    assert.equal(missingKey, undefined,
      `unknown token must not throw a missing-key error — saw: ${missingKey}`);
    const text = container.textContent;
    assert.ok(text.includes('hBP09-999'), 'card number must still render');
    assert.ok(!text.includes('mystery'), 'raw unknown token must not leak as a color label');
    assert.ok(!text.includes('color_mystery'), 'raw i18n key must not leak');
  } finally { await cleanup(); }
});

// ── 7. Sanity: normaliser cannot rescue a truly unknown token ─────────────
// If someone "fixes" resolveCardColorsWithNestedFallback by ALWAYS returning
// something for any input, this catches it: normalizeColorTokens('mystery')
// must stay empty, otherwise the negative-token render tests above would go
// green for the wrong reason.

await test('normalizeColorTokens keeps dropping truly unknown tokens', () => {
  assert.deepEqual(normalizeColorTokens('mystery'), []);
  assert.deepEqual(normalizeColorTokens('gibberish_xyz'), []);
});

console.log(`\nDIC-1159 unknown color regression checks passed (${passed} assertions)`);
