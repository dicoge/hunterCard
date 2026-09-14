#!/usr/bin/env node
// DIC-1430 CR round 2 — an exact printing must resolve its OWN artwork, not the
// card number's representative art.
//
// The regression this pins: the canonical resolver matched the exact printing
// for the LABEL and the PRICE, then handed CardDetail `base.imageUrl` — the
// elected representative row's card-level image. That image is identical for
// every printing of a card number, so hBP01-024's ¥3,480 PARALLEL/HR opened
// showing exactly the same picture as its ¥50 PARALLEL/hBP07 sibling. The
// price was right and the picture was wrong, which is the worst combination
// for a player deciding what they are about to buy.
//
// yuyu-tei publishes art per LISTING, so the printing the user opened must
// carry the image that printing's own listing proved:
//   * one proven image → that image;
//   * listings disagree → NO image, never an arbitrary pick;
//   * no listing image at all → the card-level image, which is not a
//     cross-printing borrow.
//
// Why this test cannot go falsely green:
//   * expectations are derived from data/database.json listings, not hardcoded;
//   * every printing's expected image is asserted DISTINCT from its siblings'
//     and from the representative art, so the pre-fix behaviour (all three
//     identical) fails on the first printing;
//   * the image is asserted on the REAL rendered <img src>, not just the payload;
//   * the conflict case asserts the dedupe kept BOTH disagreeing listings —
//     with the pre-fix label+price key it collapses to one and the survivor's
//     art would be presented as proven.

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
const { printingFromLabel } = await import('../src/utils/printingIdentity.ts');
const {
  loadCanonicalCardIndex, buildCanonicalCardIndex,
} = await import('../src/utils/canonicalCardRecord.ts');
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

const CARD = 'hBP01-024';

// ── Expectations derived from the shipped catalog ───────────────────────────
const rawDb = await loadDatabaseJson();
const rows = Object.values(rawDb.cards || {}).filter((c) => c?.cardNumber === CARD);
assert.ok(rows.length > 0, `shipped catalog still carries ${CARD}`);

// Every printing this card number publishes, with the art + price its own
// listing proves. Built from source so the test tracks the data, not a snapshot.
const expected = new Map();
for (const listing of rows.flatMap((r) => r.prices ?? [])) {
  const printing = printingFromLabel(listing?.name ?? '');
  const image = (listing?.imageUrl ?? '').trim();
  const prev = expected.get(printing);
  if (prev) {
    assert.equal(prev.imageUrl, image, `${CARD} [${printing}] listings agree on art`);
    continue;
  }
  expected.set(printing, { imageUrl: image, sellPrice: listing.sellPrice, label: listing.name });
}
assert.ok(expected.size >= 3, `${CARD} ships at least BASE + two parallels (saw ${expected.size})`);

const representativeArt = rows.map((r) => r.officialImage).find(Boolean);
assert.ok(representativeArt, `${CARD} has representative card-level art`);

// The images must genuinely differ per printing, or nothing below is sensitive.
const distinctImages = new Set([...expected.values()].map((e) => e.imageUrl));
assert.equal(
  distinctImages.size, expected.size,
  'each printing publishes DIFFERENT art — the premise that makes this test sharp',
);
for (const [printing, e] of expected) {
  assert.notEqual(
    e.imageUrl, representativeArt,
    `${printing}'s listing art differs from the representative art (pre-fix value)`,
  );
}

console.log('── DIC-1430 CR2 · exact-printing artwork ──');
for (const [printing, e] of expected) {
  console.log(`   ${CARD} [${printing}] ¥${e.sellPrice} → ${e.imageUrl.split('/').slice(-2).join('/')}`);
}
console.log(`   representative (pre-fix, shared by all): ${representativeArt.split('/').pop()}`);

const index = await loadCanonicalCardIndex();

await test('every catalog printing resolves its OWN image and its OWN price', async () => {
  const seen = new Set();
  for (const [printing, e] of expected) {
    const res = index.resolve(CARD, printing);
    assert.equal(res.status, 'ok', `${printing} resolves`);
    assert.equal(res.card.printing, printing, `${printing} keeps its identity`);
    assert.equal(
      res.card.imageUrl, e.imageUrl,
      `${printing} carries the image its OWN listing proved (not the representative art)`,
    );
    assert.notEqual(
      res.card.imageUrl, representativeArt,
      `${printing} must not fall back to representative art — the bug this pins`,
    );
    assert.equal(
      res.card.yuyuPrice, e.sellPrice,
      `${printing} carries its own same-printing sell price`,
    );
    seen.add(res.card.imageUrl);
  }
  assert.equal(
    seen.size, expected.size,
    'the printings resolve to DISTINCT images — pre-fix they all shared one',
  );
});

await test('no printing borrows a sibling printing\'s artwork', async () => {
  // Cross-check every resolved image against every OTHER printing's expectation.
  for (const [printing, e] of expected) {
    const res = index.resolve(CARD, printing);
    for (const [other, otherExpected] of expected) {
      if (other === printing) continue;
      assert.notEqual(
        res.card.imageUrl, otherExpected.imageUrl,
        `${printing} must not show ${other}'s artwork`,
      );
    }
    assert.equal(res.card.imageUrl, e.imageUrl, `${printing} still shows its own`);
  }
});

await test('CardDetail RENDERS the exact-printing image for each printing', async () => {
  for (const [printing, e] of expected) {
    const res = index.resolve(CARD, printing);
    const { container, cleanup } = await render(React.createElement(CardDetailScreen, {
      route: { params: { card: res.card } },
      navigation: { navigate() {}, goBack() {}, setOptions() {} },
    }));
    try {
      const srcs = [...container.querySelectorAll('img')].map((img) => img.getAttribute('src'));
      assert.ok(
        srcs.includes(e.imageUrl),
        `CardDetail renders ${printing}'s own art (saw: ${srcs.join(', ') || 'none'})`,
      );
      assert.ok(
        !srcs.includes(representativeArt),
        `CardDetail does not render the representative art for ${printing}`,
      );
    } finally { await cleanup(); }
  }
});

await test('Favorites → CardDetail carries the exact-printing image end to end', async () => {
  for (const [printing, e] of expected) {
    useFavoritesStore.setState({
      favorites: [{ cardNumber: CARD, printing, addedAt: '2026-09-01T00:00:00Z' }],
      removals: {},
    });
    const navs = [];
    const { container, cleanup } = await render(React.createElement(FavoritesScreen, {
      navigation: { navigate: (route, params) => navs.push([route, params]), goBack() {} },
    }));
    try {
      const open = container.querySelector(`[data-testid="favorite-open-${CARD}-${printing}"]`);
      assert.ok(open, `favorite row for ${printing} renders`);
      await act(async () => open.click());
      await flush(10);
      assert.equal(navs.length, 1, `tapping ${printing} navigates once`);
      const payload = navs[0][1]?.card;
      assert.equal(payload.imageUrl, e.imageUrl, `${printing} opens with its own artwork`);
      assert.equal(payload.yuyuPrice, e.sellPrice, `${printing} opens with its own price`);
    } finally { await cleanup(); }
  }
});

// ── Conflict / fail-closed ─────────────────────────────────────────────────
await test('listings identical but for their ART fail closed — dedupe cannot erase the disagreement', async () => {
  // Clone a real row so the record shape is genuine, then give it two listings
  // that agree on label AND price but publish DIFFERENT art. This is exactly
  // the evidence the old `name|sellPrice|buyPrice` dedupe key collapsed: the
  // survivor's picture would then look source-proven for a printing the source
  // does not actually describe unambiguously.
  const base = JSON.parse(JSON.stringify(rows[0]));
  base.cardNumber = 'hZZ01-001';
  base.id = 'hZZ01-001_conflict';
  const artA = 'https://card.yuyu-tei.jp/hocg/100_140/zz01/00001.jpg';
  const artB = 'https://card.yuyu-tei.jp/hocg/100_140/zz01/00002.jpg';
  base.prices = [
    { name: 'コンフリクト検証', sellPrice: 500, rarity: '', imageUrl: artA },
    { name: 'コンフリクト検証', sellPrice: 500, rarity: '', imageUrl: artB },
  ];

  const conflicted = buildCanonicalCardIndex([base], {});
  const res = conflicted.resolve('hZZ01-001', 'BASE');
  assert.equal(res.status, 'ok', 'the printing still resolves — it is identifiable, just not depictable');

  // Dedupe identity must include imageUrl: BOTH listings have to survive, or
  // the disagreement is invisible downstream.
  assert.equal(
    res.card.prices.length, 2,
    'both conflicting listings survive dedupe — the pre-fix key collapsed them to 1',
  );
  const carried = res.card.prices.map((p) => p.imageUrl).sort();
  assert.deepEqual(carried, [artA, artB].sort(), 'both images are preserved as evidence');

  // …and the resolved artwork fails closed rather than picking a winner.
  assert.notEqual(res.card.imageUrl, artA, 'does not arbitrarily pick the first listing\'s art');
  assert.notEqual(res.card.imageUrl, artB, 'does not arbitrarily pick the second listing\'s art');
  assert.equal(res.card.imageUrl, '', 'conflicting art resolves to NO exact image (fail closed)');
  assert.notEqual(
    res.card.imageUrl, base.officialImage,
    'and does not silently substitute the representative art for a contradicted printing',
  );

  // The price was never in dispute, so it must still resolve.
  assert.equal(res.card.yuyuPrice, 500, 'an image conflict does not suppress an unambiguous price');
});

await test('real catalog conflict (hBP02-017 PARALLEL) fails closed on BOTH art and price', async () => {
  // The shipped dataset really does ship 白銀ノエル(パラレル) twice, at ¥3,480 and
  // ¥500, with different art. Neither may be presented as proven.
  const conflictRows = Object.values(rawDb.cards || {}).filter((c) => c?.cardNumber === 'hBP02-017');
  assert.ok(conflictRows.length > 0, 'shipped catalog still carries hBP02-017');
  const parallelListings = conflictRows
    .flatMap((r) => r.prices ?? [])
    .filter((l) => printingFromLabel(l?.name ?? '') === 'PARALLEL');
  const images = new Set(parallelListings.map((l) => (l.imageUrl ?? '').trim()).filter(Boolean));
  assert.ok(images.size > 1, 'precondition: the source publishes conflicting art for this printing');

  const res = index.resolve('hBP02-017', 'PARALLEL');
  assert.equal(res.status, 'ok', 'the printing is still selectable');
  assert.equal(res.card.yuyuPrice, null, 'an ambiguously priced printing stays unpriced');
  for (const image of images) {
    assert.notEqual(res.card.imageUrl, image, 'no conflicting listing image is chosen');
  }
  assert.equal(res.card.imageUrl, '', 'conflicting art resolves to NO exact image (fail closed)');
});

await test('a printing with NO listing image keeps the card-level art (not a cross-printing borrow)', async () => {
  // 257 card numbers ship no listings at all; their synthetic UNLISTED base has
  // no listing art to prove. Card-level art is the only thing the source states
  // for them, so it must survive — blanking it would be a false "fail closed".
  const unlisted = Object.values(rawDb.cards || {}).find(
    (c) => c?.cardNumber && c.officialImage && (c.prices ?? []).length === 0
      && Object.values(rawDb.cards).filter((x) => x?.cardNumber === c.cardNumber)
        .every((x) => (x.prices ?? []).length === 0),
  );
  assert.ok(unlisted, 'the catalog still carries a card number with no listings');
  const res = index.resolve(unlisted.cardNumber, 'BASE');
  assert.equal(res.status, 'ok', `${unlisted.cardNumber} resolves its unlisted base printing`);
  assert.ok(res.card.imageUrl, 'card-level art still shows when the source proves no listing art');
  assert.equal(res.card.yuyuPrice, null, 'and it remains honestly unpriced');
});

console.log(`\n✅ DIC-1430 CR2 exact-printing artwork: ${passed} tests passed`);
