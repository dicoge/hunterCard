#!/usr/bin/env node
// DIC-1430 — Favorites → CardDetail must hand over the FULL canonical record
// for the favorite's EXACT printing.
//
// The regression this pins: FavoritesScreen resolved its rows through
// `loadCardDatabase()`, whose `DeckCard` is the deck editor's deliberately
// reduced shape (id / number / name / printing / art). It then navigated with
// that object, so `CardDetailScreen` — which reads `yuyuPrice`, `prices`,
// `skills*`, `normalized`, `hp`/`life` and history straight off the route param
// — opened a correctly priced favorite with no market data at all. The prior
// hub parity test only checked the destination route and card number, so the
// broken payload sailed through.
//
// What this test proves, end to end, on the REAL shipped catalog:
//   1. tapping a real favorite navigates with the canonical record;
//   2. the payload carries THIS printing's own sell price — never the
//      card-number-level aggregate, which is the minimum across every printing;
//   3. the payload's version list actually contains the opened printing;
//   4. substantive detail data (skills, normalized identity, stats) survives;
//   5. the destination RENDERS that price — and the old reduced payload does
//      not, so assertion 5 is sensitive to the bug rather than vacuous;
//   6. a legacy/unknown bookmark, and a known card number with a printing the
//      catalog no longer lists, both fail CLOSED: they still open (no dead end)
//      but carry no borrowed price from a sibling printing.

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
Object.defineProperty(dom.window.document.documentElement, 'clientWidth', { value: 390, configurable: true });
Object.defineProperty(dom.window, 'innerWidth', { value: 390, configurable: true });

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { loadDatabaseJson } = await import('../src/utils/staticData.ts');
const { adaptCardNumber } = await import('../src/utils/deckCardData.ts');
const { printingFromLabel } = await import('../src/utils/printingIdentity.ts');
const { useFavoritesStore } = await import('../src/store/favoritesStore.ts');
const { default: FavoritesScreen } = await import('../src/screens/FavoritesScreen.tsx');
const { default: CardDetailScreen } = await import('../src/screens/CardDetailScreen.tsx');

async function flush(ms = 0) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}
async function render(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
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

/** Tap a favorite row and return the object handed to the CardDetail route. */
async function openFavorite(cardNumber, printing) {
  useFavoritesStore.setState({
    favorites: [{ cardNumber, printing, addedAt: '2026-09-01T00:00:00Z' }],
    removals: {},
  });
  const navs = [];
  const { container, cleanup } = await render(React.createElement(FavoritesScreen, {
    navigation: { navigate: (route, params) => navs.push([route, params]), goBack() {} },
  }));
  try {
    const open = container.querySelector(`[data-testid="favorite-open-${cardNumber}-${printing}"]`);
    assert.ok(open, `favorite row for ${cardNumber} / ${printing} renders its open action`);
    await act(async () => open.click());
    assert.equal(navs.length, 1, 'tapping the row navigates exactly once');
    assert.equal(navs[0][0], 'CardDetail', 'to the real CardDetail route');
    return navs[0][1]?.card;
  } finally { await cleanup(); }
}

// ── Fixture: a REAL card number whose exact printing price differs sharply from
// the card-number-level aggregate. That gap is what makes every price assertion
// below mutation-sensitive: a cross-version fallback lands on a different number.
const rawDb = await loadDatabaseJson();
const byNumber = new Map();
for (const row of Object.values(rawDb.cards || {})) {
  if (!row?.cardNumber) continue;
  const list = byNumber.get(row.cardNumber);
  if (list) list.push(row);
  else byNumber.set(row.cardNumber, [row]);
}

let fixture = null;
for (const [cardNumber, group] of byNumber) {
  const adapted = adaptCardNumber(group);
  if (adapted.priceRecords.length < 2) continue;
  const sorted = adapted.priceRecords.slice().sort((a, b) => b.price - a.price);
  const dear = sorted[0];
  if (dear.price === sorted[sorted.length - 1].price) continue;
  // The card-number-level `sellPrice` the reduced payload would have exposed.
  const cardLevelPrices = group
    .map((row) => row.sellPrice)
    .filter((p) => typeof p === 'number' && p > 0);
  const cardLevelMin = cardLevelPrices.length > 0 ? Math.min(...cardLevelPrices) : null;
  if (cardLevelMin === null || dear.price === cardLevelMin) continue;
  fixture = { cardNumber, printing: dear.version, exactPrice: dear.price, cardLevelMin };
  break;
}
assert.ok(fixture, 'shipped catalog carries a card number priced differently per printing');

console.log('── DIC-1430 · Favorites → CardDetail canonical payload ──');
console.log(`   fixture: ${fixture.cardNumber} [${fixture.printing}] `
  + `exact ¥${fixture.exactPrice.toLocaleString()} vs card-number aggregate ¥${fixture.cardLevelMin.toLocaleString()}`);

let canonicalPayload = null;

await test('tapping a real favorite hands CardDetail the canonical record for THAT printing', async () => {
  const payload = await openFavorite(fixture.cardNumber, fixture.printing);
  canonicalPayload = payload;
  assert.ok(payload, 'the route carries a card payload');

  // Exact-printing identity survives the hop.
  assert.equal(payload.cardNumber, fixture.cardNumber, 'the real card number');
  assert.equal(payload.printing, fixture.printing, 'the EXACT printing the user bookmarked');
  assert.ok(payload.printingLabel, "the source's own listing label for that printing");

  // Same-printing price — the heart of the finding.
  assert.equal(payload.yuyuPrice, fixture.exactPrice, "this printing's own sell price");
  assert.notEqual(
    payload.yuyuPrice, fixture.cardLevelMin,
    'never the card-number aggregate (the minimum across all printings)',
  );

  // The destination builds its version list from `prices`; the opened printing
  // must be in it, or CardDetail would label this card with a sibling version.
  const listedPrintings = (payload.prices || []).map((p) => printingFromLabel(p?.name || ''));
  assert.ok(
    listedPrintings.includes(fixture.printing),
    `payload.prices carries the opened printing (saw: ${listedPrintings.join(', ') || 'none'})`,
  );

  // Substantive canonical detail data — absent from the old DeckCard payload.
  assert.ok(payload.skillsZh || payload.skillsJp, 'skills survive');
  assert.ok(payload.normalized?.category, 'normalized identity survives');
  assert.ok(
    (payload.hp || '').length > 0 || (payload.life || '').length > 0 || (payload.effects || []).length > 0,
    'card stats / effects survive',
  );
  assert.ok(payload.name, 'the real card name survives');
  assert.ok(payload.officialUrl && payload.yuyuUrl, 'the canonical outbound links survive');
});

await test('the destination RENDERS the same-printing price from that payload', async () => {
  const { container, cleanup } = await render(React.createElement(CardDetailScreen, {
    route: { params: { card: canonicalPayload } },
    navigation: { navigate() {}, goBack() {}, setOptions() {} },
  }));
  try {
    assert.ok(
      container.textContent.includes(fixture.exactPrice.toLocaleString()),
      `CardDetail shows ¥${fixture.exactPrice.toLocaleString()} for the opened printing`,
    );
    assert.ok(
      container.textContent.includes(canonicalPayload.nameZh || canonicalPayload.name),
      'CardDetail shows the real card name',
    );
  } finally { await cleanup(); }
});

await test('mutation guard: the pre-fix reduced payload renders NO market price', async () => {
  // Exactly the DeckCard-shaped object Favorites used to navigate with. If this
  // still rendered the price, the assertion above would prove nothing.
  const reduced = {
    id: canonicalPayload.id,
    cardNumber: canonicalPayload.cardNumber,
    name: canonicalPayload.name,
    nameZh: canonicalPayload.nameZh,
    printing: canonicalPayload.printing,
    printingLabel: canonicalPayload.printingLabel,
    series: canonicalPayload.series,
    type: canonicalPayload.type,
    imageUrl: canonicalPayload.imageUrl,
  };
  const { container, cleanup } = await render(React.createElement(CardDetailScreen, {
    route: { params: { card: reduced } },
    navigation: { navigate() {}, goBack() {}, setOptions() {} },
  }));
  try {
    assert.ok(
      !container.textContent.includes(fixture.exactPrice.toLocaleString()),
      'the reduced payload cannot show the real price — the bug this test pins',
    );
  } finally { await cleanup(); }
});

await test('legacy bookmark the catalog no longer carries: opens, but fails CLOSED on price', async () => {
  const payload = await openFavorite('hZZ99-999', 'BASE');
  assert.ok(payload, 'the route still opens — a legacy bookmark never dead-ends');
  assert.equal(payload.cardNumber, 'hZZ99-999', 'carrying its own identity');
  assert.equal(payload.printing, 'BASE', 'preserving the bookmarked printing');
  assert.equal(payload.yuyuPrice, undefined, 'no price is invented for an unknown card');
  assert.equal(payload.prices, undefined, 'no listings are invented for an unknown card');
});

await test('known card number, printing the catalog no longer lists: no cross-version fallback', async () => {
  const bogus = 'PARALLEL/NOT-A-REAL-PRINTING';
  const payload = await openFavorite(fixture.cardNumber, bogus);
  assert.ok(payload, 'the route still opens');
  assert.equal(payload.cardNumber, fixture.cardNumber, 'carrying the real card number');
  assert.equal(payload.printing, bogus, 'preserving the bookmarked printing verbatim');
  // The card number IS priced — resolving it anyway would be exactly the
  // card-number-only fallback the identity rules forbid.
  assert.equal(payload.yuyuPrice, undefined, "no sibling printing's price is borrowed");
  assert.equal(payload.prices, undefined, "no sibling printing's listings are borrowed");
});

console.log(`\n✅ DIC-1430 favorites canonical payload: ${passed} tests passed`);
