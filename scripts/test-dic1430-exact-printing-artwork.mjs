#!/usr/bin/env node
// DIC-1430 CR round 3 — an exact printing shows its OWN artwork or NO artwork.
//
// The regression this pins, in two halves:
//
// 1. EXACT ART PRESENT. The canonical resolver matched the exact printing for
//    the LABEL and the PRICE, then handed CardDetail `base.imageUrl` — the
//    elected representative row's card-level image. That image is identical for
//    every printing of a card number, so hBP01-024's ¥3,480 PARALLEL/HR opened
//    showing exactly the same picture as its ¥50 PARALLEL/hBP07 sibling.
//
// 2. EXACT ART UNAVAILABLE. Round 2 fixed (1) but kept a fallback: a printing
//    whose own listing published no art still inherited the card-level image,
//    on the reasoning that it was "the only art the source states". On screen
//    that is indistinguishable from (1) — an unproven picture beside a proven
//    price, with nothing saying the art was never proven — so it is now a
//    fail-closed case too. CR round 2 rejected the fallback AND rejected this
//    test for explicitly blessing it.
//
// The rule, uniformly: the ONLY thing that may depict a printing is that
// printing's own listing.
//   * exactly one proven listing image → that image;
//   * listings disagree            → NO image;
//   * listing published no art     → NO image;
//   * no listing at all            → NO image.
//
// Why this test cannot go falsely green:
//   * expectations are derived from data/database.json, not hardcoded;
//   * each printing's expected art is asserted DISTINCT from its siblings' and
//     from the representative art, so the round-1 behaviour (all identical)
//     fails on the first printing;
//   * every unavailable case asserts the resolved image is not the
//     representative / officialImage / localImage / sibling art — which is
//     exactly what restoring `?? base.imageUrl` would produce, so the round-2
//     behaviour fails too;
//   * assertions run on the REAL rendered <img src>, and the render is checked
//     for the reconstructed card-number URL (`buildImageUrl`) that would
//     otherwise undo the fail-closed decision one layer below;
//   * the conflict case asserts the dedupe kept BOTH disagreeing listings —
//     with a label+price key it collapses to one and the survivor's art would
//     be presented as proven.

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
const imgSrcs = (container) =>
  [...container.querySelectorAll('img')].map((img) => img.getAttribute('src') || '');

/** Render an exact-printing payload and assert nothing depicts it but its own
 * proven art. `expectedImage` empty means the honest unavailable state. */
async function assertRenderedArt(card, expectedImage, forbidden, label) {
  const { container, cleanup } = await render(React.createElement(CardDetailScreen, {
    route: { params: { card } },
    navigation: { navigate() {}, goBack() {}, setOptions() {} },
  }));
  try {
    const srcs = imgSrcs(container);
    for (const bad of forbidden) {
      if (!bad) continue;
      assert.ok(!srcs.includes(bad), `${label}: must not render ${bad}`);
    }
    // `buildImageUrl` reconstructs art from the CARD NUMBER — the same picture
    // for every printing. It must never run for an exact-printing payload.
    assert.ok(
      !srcs.some((src) => src.includes('hololive-official-cardgame.com')),
      `${label}: must not reconstruct a card-number image URL (saw: ${srcs.join(', ') || 'none'})`,
    );
    if (expectedImage) {
      assert.ok(srcs.includes(expectedImage), `${label}: renders its own proven art`);
    } else {
      assert.equal(srcs.length, 0, `${label}: renders NO artwork (saw: ${srcs.join(', ')})`);
      assert.ok(
        container.querySelector('[data-testid="card-detail-hero-art-unavailable"]'),
        `${label}: renders the honest unavailable hero state`,
      );
    }
  } finally { await cleanup(); }
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
  assert.ok(e.imageUrl, `${printing} has proven listing art (the "present" half of the test)`);
  assert.notEqual(
    e.imageUrl, representativeArt,
    `${printing}'s listing art differs from the representative art (round-1 value)`,
  );
}

console.log('── DIC-1430 CR3 · exact-printing artwork ──');
for (const [printing, e] of expected) {
  console.log(`   ${CARD} [${printing}] ¥${e.sellPrice} → ${e.imageUrl.split('/').slice(-2).join('/')}`);
}
console.log(`   representative (round-1, shared by all): ${representativeArt.split('/').pop()}`);

const index = await loadCanonicalCardIndex();

// ════════════════════════════════════════════════════════════════════════════
// PART 1 — exact listing artwork IS available
// ════════════════════════════════════════════════════════════════════════════

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
    'the printings resolve to DISTINCT images — round-1 they all shared one',
  );
});

await test('no printing borrows a sibling printing\'s artwork', async () => {
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
    const siblings = [...expected.entries()]
      .filter(([other]) => other !== printing)
      .map(([, otherExpected]) => otherExpected.imageUrl);
    await assertRenderedArt(
      res.card, e.imageUrl, [representativeArt, ...siblings], `${CARD} [${printing}]`,
    );
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

// ════════════════════════════════════════════════════════════════════════════
// PART 2 — exact listing artwork is NOT available → fail closed
//
// Each case asserts the resolved image is neither the representative art nor
// any sibling's, while the printing's IDENTITY and its same-printing PRICE
// survive. Restoring `?? base.imageUrl` turns every one of them red.
// ════════════════════════════════════════════════════════════════════════════

await test('a listing that published NO art fails closed — even when a sibling printing has art', async () => {
  // The sharpest form of the round-2 finding: the card number HAS proven art
  // (on another printing) and HAS card-level art, and the printing the user
  // opened still must show nothing. The shipped catalog publishes art on every
  // listing, so this evidence is constructed — from a real row, so the record
  // shape is genuine.
  const base = JSON.parse(JSON.stringify(rows[0]));
  base.cardNumber = 'hZZ02-002';
  base.id = 'hZZ02-002_noart';
  const siblingArt = 'https://card.yuyu-tei.jp/hocg/100_140/zz02/20002.jpg';
  base.prices = [
    { name: 'アートなし検証', sellPrice: 120, rarity: '' },
    { name: 'アートなし検証(パラレル)', sellPrice: 4800, rarity: '', imageUrl: siblingArt },
  ];
  assert.ok(base.officialImage, 'precondition: the row still carries card-level art to borrow');

  const built = buildCanonicalCardIndex([base], {});

  const bare = built.resolve('hZZ02-002', 'BASE');
  assert.equal(bare.status, 'ok', 'the printing still resolves — identifiable, just not depictable');
  assert.equal(bare.card.printing, 'BASE', 'exact-printing identity survives the missing art');
  assert.equal(bare.card.yuyuPrice, 120, 'and its own same-printing price survives');
  assert.equal(bare.card.imageUrl, '', 'no listing art → NO image');
  assert.notEqual(
    bare.card.imageUrl, base.officialImage,
    'must not substitute the card-level/representative art — the round-2 fallback',
  );
  assert.notEqual(bare.card.imageUrl, base.localImage || ' ', 'nor the local card-level art');
  assert.notEqual(bare.card.imageUrl, siblingArt, 'nor the sibling printing\'s art');

  // The sibling is unaffected: fail-closed must not blank proven art.
  const parallel = built.resolve('hZZ02-002', 'PARALLEL');
  assert.equal(parallel.card.imageUrl, siblingArt, 'the printing WITH proven art still shows it');
  assert.equal(parallel.card.yuyuPrice, 4800, 'and keeps its own price');

  await assertRenderedArt(
    bare.card, '', [base.officialImage, base.localImage, siblingArt], 'hZZ02-002 [BASE] no listing art',
  );
});

await test('listings identical but for their ART fail closed — dedupe cannot erase the disagreement', async () => {
  // Two listings that agree on label AND price but publish DIFFERENT art. This
  // is exactly the evidence a `name|sellPrice|buyPrice` dedupe key collapsed:
  // the survivor's picture would then look source-proven for a printing the
  // source does not actually describe unambiguously.
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
    'both conflicting listings survive dedupe — a label+price key collapsed them to 1',
  );
  const carried = res.card.prices.map((p) => p.imageUrl).sort();
  assert.deepEqual(carried, [artA, artB].sort(), 'both images are preserved as evidence');

  assert.notEqual(res.card.imageUrl, artA, 'does not arbitrarily pick the first listing\'s art');
  assert.notEqual(res.card.imageUrl, artB, 'does not arbitrarily pick the second listing\'s art');
  assert.equal(res.card.imageUrl, '', 'conflicting art resolves to NO exact image (fail closed)');
  assert.notEqual(
    res.card.imageUrl, base.officialImage,
    'and does not silently substitute the representative art for a contradicted printing',
  );

  // The price was never in dispute, so it must still resolve.
  assert.equal(res.card.yuyuPrice, 500, 'an image conflict does not suppress an unambiguous price');

  await assertRenderedArt(
    res.card, '', [artA, artB, base.officialImage], 'hZZ01-001 [BASE] conflicting art',
  );
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
  const conflictRepArt = conflictRows.map((r) => r.officialImage).find(Boolean);

  const res = index.resolve('hBP02-017', 'PARALLEL');
  assert.equal(res.status, 'ok', 'the printing is still selectable');
  assert.equal(res.card.printing, 'PARALLEL', 'exact-printing identity survives');
  assert.equal(res.card.yuyuPrice, null, 'an ambiguously priced printing stays unpriced');
  for (const image of images) {
    assert.notEqual(res.card.imageUrl, image, 'no conflicting listing image is chosen');
  }
  assert.equal(res.card.imageUrl, '', 'conflicting art resolves to NO exact image (fail closed)');
  assert.notEqual(
    res.card.imageUrl, conflictRepArt,
    'and does not substitute the representative art',
  );

  await assertRenderedArt(
    res.card, '', [...images, conflictRepArt], 'hBP02-017 [PARALLEL] real conflict',
  );
});

await test('a printing with NO listing at all fails closed — card-level art is NOT proof of a printing', async () => {
  // 257 card numbers ship no listings whatsoever; their synthetic UNLISTED base
  // has no listing art to prove. Round 2 let the card-level image stand here.
  // It is still an unproven claim about this printing, rendered beside this
  // printing's (unavailable) price, so it fails closed like every other case.
  const unlisted = Object.values(rawDb.cards || {}).find(
    (c) => c?.cardNumber && c.officialImage && (c.prices ?? []).length === 0
      && Object.values(rawDb.cards).filter((x) => x?.cardNumber === c.cardNumber)
        .every((x) => (x.prices ?? []).length === 0),
  );
  assert.ok(unlisted, 'the catalog still carries a card number with no listings');

  const res = index.resolve(unlisted.cardNumber, 'BASE');
  assert.equal(res.status, 'ok', `${unlisted.cardNumber} resolves its unlisted base printing`);
  assert.equal(res.card.printing, 'BASE', 'exact-printing identity survives');
  assert.equal(res.card.yuyuPrice, null, 'and it remains honestly unpriced');
  assert.equal(res.card.imageUrl, '', 'no listing → NO image');
  assert.notEqual(
    res.card.imageUrl, unlisted.officialImage,
    'card-level art must not stand in for an unproven printing — the round-2 fallback',
  );

  await assertRenderedArt(
    res.card, '', [unlisted.officialImage, unlisted.localImage], `${unlisted.cardNumber} [BASE] unlisted`,
  );

  // …and end to end through Favorites, where the reduced-payload branch used to
  // borrow the same card-level image.
  useFavoritesStore.setState({
    favorites: [{ cardNumber: unlisted.cardNumber, printing: 'BASE', addedAt: '2026-09-01T00:00:00Z' }],
    removals: {},
  });
  const navs = [];
  const { container, cleanup } = await render(React.createElement(FavoritesScreen, {
    navigation: { navigate: (route, params) => navs.push([route, params]), goBack() {} },
  }));
  try {
    const open = container.querySelector(
      `[data-testid="favorite-open-${unlisted.cardNumber}-BASE"]`,
    );
    assert.ok(open, 'the unlisted favorite row renders');
    await act(async () => open.click());
    await flush(10);
    assert.equal(navs.length, 1, 'tapping navigates once');
    const payload = navs[0][1]?.card;
    assert.equal(payload.imageUrl, '', 'Favorites hands CardDetail no borrowed artwork');
    assert.notEqual(payload.imageUrl, unlisted.officialImage, 'not the card-level image');
  } finally { await cleanup(); }
});

console.log(`\n✅ DIC-1430 CR3 exact-printing artwork: ${passed} tests passed`);
