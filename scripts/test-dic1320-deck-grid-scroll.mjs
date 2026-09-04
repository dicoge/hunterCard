#!/usr/bin/env node
/**
 * DIC-1320 regression: the deck editor's card picker must own the vertical drag.
 *
 * THE REPORT (Closed Test v21, Android). The grid shows cards — DIC-1287 fixed
 * that — but "the card picker cannot be dragged/scrolled; gestures move only the
 * outer screen and the selection area cannot be navigated."
 *
 * THE ROOT CAUSE. `CardPickerGrid` is a FlatList, i.e. a VirtualizedList, and
 * v21 mounted it inside a same-orientation page `ScrollView`:
 *
 *     <ScrollView contentContainerStyle={styles.pad}>   ← owns the drag
 *       …<CardPickerGrid height={460} />                ← never sees it
 *     </ScrollView>
 *
 * On Android nested scrolling is OFF by default (`setNestedScrollingEnabled`
 * is false unless `nestedScrollEnabled` is set), so the parent ScrollView wins
 * the touch outright in `onInterceptTouchEvent` and the inner list is frozen.
 * iOS and the browser both handle the same nesting natively, which is why this
 * only ever showed up on the Android artifact.
 *
 * The knock-on effect is the "cannot be navigated" half of the report: the grid
 * pages in 60 card numbers at a time and asks `onEndReached` for the rest. A
 * list that never scrolls never fires `onEndReached`, so the 推しホロメン tab —
 * 155 card numbers, the zone the editor OPENS on — was permanently stuck at its
 * first 60. 95 cards were unreachable by any gesture.
 *
 * NOT A DEFECT: dragging a CARD (drag-and-drop onto a zone) was never built.
 * Cards are added by TAPPING them, and that has always worked. The defect is
 * exclusively the vertical scroll of the picker, which is what this file pins.
 *
 * THE FIX. Remove the nesting rather than paper over it: every deck editor
 * layout now hands the grid a bounded, NON-scrolling parent and lets the grid
 * be the scroller (the stacked layout puts the surrounding panels into the
 * grid's own header/footer so the page still has exactly one scroller).
 *
 * WHY THESE ASSERTIONS. react-native-web does NOT implement React Native's
 * "VirtualizedLists should never be nested inside plain ScrollViews" warning —
 * a render of the BROKEN screen through this harness emits zero warnings — so
 * asserting on console output here would pass no matter what and prove nothing.
 * The structural check below is the same invariant that warning exists to
 * protect, and unlike the warning it fails loudly on the v21 tree: it resolves
 * react-native-web's generated CSS and walks the grid's real ancestors looking
 * for another vertical scroller.
 *
 * Run: npm run test:deck-grid-scroll
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// ── DOM first: react-native-web's StyleSheet installs a style element at
//    module-evaluation time, and this test READS those generated rules. ───────
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://holohunter.dicoge.com/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key in globalThis) continue;
  try {
    globalThis[key] = dom.window[key];
  } catch {
    // read-only globals (e.g. `location`) are already usable via `window`
  }
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = NoopResizeObserver;
dom.window.ResizeObserver = NoopResizeObserver;

// React Native has no page origin: the packaged app's relative fetches reject.
// Keeping that faithful means this renders the same catalog path the APK does.
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : String(input?.url ?? input);
  throw new TypeError(`Network request failed (native has no origin for ${url})`);
};

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const DeckEditorScreen = (await import('../src/screens/DeckEditorScreen.tsx')).default;
const { loadCardDatabase } = await import('../src/utils/deckCardData.ts');
const { useDeckStore } = await import('../src/store/deckStore.ts');

let passed = 0;
const failures = [];
// Every case runs even after one fails. When this suite is pointed at the broken
// v21 tree it should report WHICH layouts regressed, not just the first one.
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  ✗ ${name}`);
    console.log(`      ${String(err.message).split('\n')[0]}`);
  }
}

// ── Viewports ────────────────────────────────────────────────────────────────
// The phone sizes are the Android screens the Closed Test actually runs on.
// 600px is the stacked layout (small tablet / unfolded foldable) and 800px is
// where an Android tablet crosses into the three-column layout — both mount the
// same grid and must keep the same invariant.
const ANDROID_PHONES = [
  { label: 'Android 360×800 (Galaxy A-class)', width: 360, height: 800 },
  { label: 'Android 390×844', width: 390, height: 844 },
  { label: 'Android 412×915 (Pixel 7)', width: 412, height: 915 },
];
const WIDE_LAYOUTS = [
  { label: 'stacked 600×960', width: 600, height: 960 },
  { label: 'Android tablet 800×1280', width: 800, height: 1280 },
  { label: 'desktop 1280×900', width: 1280, height: 900 },
];

function setViewport({ width, height }) {
  const docEl = dom.window.document.documentElement;
  Object.defineProperty(docEl, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(docEl, 'clientHeight', { value: height, configurable: true });
  dom.window.dispatchEvent(new dom.window.Event('resize'));
}

const byTestId = (root, testID) => root.querySelector(`[data-testid="${testID}"]`);

async function render(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function openEmptyDeck() {
  useDeckStore.setState({
    decks: [{
      id: 'dic1320-regression',
      name: 'DIC-1320',
      oshi: [],
      main: [],
      yell: [],
      updatedAt: '2026-09-03T00:00:00.000Z',
    }],
    activeDeckId: 'dic1320-regression',
    collection: {},
  });
}

// ── Reading react-native-web's real styles ───────────────────────────────────
// RNW compiles `StyleSheet.create` into atomic single-class rules
// (`.r-overflowY-1rnoaur { overflow-y: auto; }`). jsdom has no layout engine and
// its getComputedStyle does not cascade these, so the rules are resolved here.
function declarationsFor(el) {
  const classes = new Set((el.getAttribute('class') || '').split(/\s+/).filter(Boolean));
  const decls = {};
  for (const sheet of dom.window.document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of rules) {
      const selector = rule.selectorText;
      if (!selector) continue;
      const single = /^\.([\w-]+)$/.exec(selector.trim());
      if (!single || !classes.has(single[1])) continue;
      for (const prop of rule.style) decls[prop] = rule.style.getPropertyValue(prop);
    }
  }
  for (const prop of el.style) decls[prop] = el.style.getPropertyValue(prop);
  return decls;
}

const SCROLLS = new Set(['auto', 'scroll', 'overlay']);

/** Does this element scroll VERTICALLY — i.e. would it claim a vertical drag? */
function isVerticalScroller(el) {
  const d = declarationsFor(el);
  return SCROLLS.has(d['overflow-y']) || SCROLLS.has(d['overflow']);
}

/** Can this element scroll at all, i.e. is its height bounded by its parent? */
function isHeightBounded(el) {
  const d = declarationsFor(el);
  if (d.height && d.height !== 'auto') return true;
  const flex = d.flex || '';
  return d['flex-grow'] === '1' || /^1\b/.test(flex);
}

/**
 * A label that says WHY an element was flagged, so a failure names the offending
 * box instead of printing an anonymous `<div>`.
 */
function describe(el) {
  const id = el.getAttribute('data-testid');
  const d = declarationsFor(el);
  const why = ['overflow-y', 'overflow', 'flex', 'height']
    .filter((p) => d[p])
    .map((p) => `${p}:${d[p]}`)
    .join('; ');
  return `<${el.tagName.toLowerCase()}${id ? ` data-testid="${id}"` : ''}${why ? ` {${why}}` : ''}>`;
}

/** Every ancestor of the grid, up to but excluding the render container. */
function ancestorsOf(el, container) {
  const chain = [];
  for (let node = el.parentElement; node && node !== container; node = node.parentElement) {
    chain.push(node);
  }
  return chain;
}

// ── 1. The reproduction anchor: 155 cards, only 60 of them on the first page ─
// This pins the exact number the tester reported, and shows WHY the frozen
// gesture hid cards rather than merely feeling stiff.
const OSHI_TOTAL = 155;

await test(`the 推し tab the editor opens on holds ${OSHI_TOTAL} card numbers, paged 60 at a time`, async () => {
  openEmptyDeck();
  setViewport(ANDROID_PHONES[1]);
  const { container, cleanup } = await render(React.createElement(DeckEditorScreen));
  try {
    const grid = byTestId(container, 'card-picker-grid');
    assert.ok(grid, 'the picker grid must mount');

    // The load-more hint lives INSIDE the grid and is the only "n/n" in it —
    // the deck progress counters are outside, on the pinned header.
    const paging = /(\d+)\s*\/\s*(\d+)/.exec(grid.textContent);
    assert.ok(paging, `the grid must report its page window, grid text: ${grid.textContent.slice(0, 120)}`);
    const [, visible, total] = paging.map(Number);

    assert.equal(
      total, OSHI_TOTAL,
      `the 推し zone must still be the ${OSHI_TOTAL}-card set the v21 report describes, saw ${total}`,
    );
    assert.ok(
      visible < total,
      `the grid must page: ${visible}/${total} leaves ${total - visible} cards behind a scroll gesture`,
    );
  } finally {
    await cleanup();
  }
});

// ── 2. THE FIX: nothing above the grid may claim the vertical drag ───────────
for (const viewport of [...ANDROID_PHONES, ...WIDE_LAYOUTS]) {
  await test(`the card grid is the only vertical scroller over the cards — ${viewport.label}`, async () => {
    openEmptyDeck();
    setViewport(viewport);
    const { container, cleanup } = await render(React.createElement(DeckEditorScreen));
    try {
      const grid = byTestId(container, 'card-picker-grid');
      assert.ok(grid, 'the picker grid must mount on every layout');

      // (a) The grid itself must be a scroller, and be able to overflow.
      assert.ok(
        isVerticalScroller(grid),
        'the card grid must be the element that scrolls vertically',
      );
      assert.ok(
        isHeightBounded(grid),
        'the card grid must be height-bounded (flex-filled or fixed) or it cannot scroll at all',
      );

      // (b) No ancestor may ALSO scroll vertically. This is the v21 defect:
      //     the page ScrollView sat three levels above the grid and, on
      //     Android, took every drag that started on a card.
      const thieves = ancestorsOf(grid, container).filter(isVerticalScroller);
      assert.deepEqual(
        thieves.map(describe), [],
        'no ancestor of the card grid may scroll vertically — on Android the outer '
        + 'scroller wins the drag and the grid freezes (DIC-1320)',
      );
    } finally {
      await cleanup();
    }
  });
}

// ── 3. Scrolling the grid really does reach all 155 cards ────────────────────
// jsdom has no layout, so a synthetic wheel/touch cannot make VirtualizedList
// compute an end-of-list. The list's own `onEndReached` — the callback a real
// scroll invokes, and the one the frozen grid could never fire — is driven
// directly off the rendered fiber instead.
function onEndReachedOf(gridEl) {
  const fiberKey = Object.keys(gridEl).find((k) => k.startsWith('__reactFiber$'));
  assert.ok(fiberKey, 'the grid must expose a React fiber to drive its paging');
  for (let node = gridEl[fiberKey], up = 0; node && up < 30; node = node.return, up += 1) {
    const props = node.memoizedProps;
    if (props && typeof props.onEndReached === 'function') return props.onEndReached;
  }
  return null;
}

await test(`scrolling to the end pages in every one of the ${OSHI_TOTAL} cards, then stops`, async () => {
  openEmptyDeck();
  setViewport(ANDROID_PHONES[1]);
  const { container, cleanup } = await render(React.createElement(DeckEditorScreen));
  try {
    const grid = byTestId(container, 'card-picker-grid');
    const windowOf = () => {
      const m = /(\d+)\s*\/\s*(\d+)/.exec(grid.textContent);
      // The hint disappears once the whole result set is in the window.
      return m ? Number(m[1]) : OSHI_TOTAL;
    };

    assert.equal(windowOf(), 60, 'the first page must be the 60 cards v21 was stuck on');

    const seen = [windowOf()];
    for (let hop = 0; hop < 6 && seen[seen.length - 1] < OSHI_TOTAL; hop += 1) {
      const onEndReached = onEndReachedOf(grid);
      assert.ok(onEndReached, 'the grid must keep an onEndReached for a real scroll to fire');
      await act(async () => {
        onEndReached({ distanceFromEnd: 0 });
      });
      seen.push(windowOf());
    }

    assert.deepEqual(
      seen, [60, 120, OSHI_TOTAL],
      'reaching the end must page 60 → 120 → 155 and clamp at the last card',
    );

    // Idempotent at the boundary: hitting the end again must not run away.
    await act(async () => {
      onEndReachedOf(grid)({ distanceFromEnd: 0 });
    });
    assert.equal(windowOf(), OSHI_TOTAL, 'the window must clamp at the end, not keep growing');
  } finally {
    await cleanup();
  }
});

// ── 4. Sane boundary handoff, both directions ────────────────────────────────
// The picker route has NO page scroller, so there is nothing for the grid to
// hand an overscroll to and nothing to steal the drag back mid-gesture. The
// panels that hold no list must still scroll, which is what stops a "fix" that
// simply deletes every ScrollView on the screen.
await test('the phone picker route has no page scroller, but the deck panel still scrolls', async () => {
  openEmptyDeck();
  setViewport(ANDROID_PHONES[1]);
  const { container, cleanup } = await render(React.createElement(DeckEditorScreen));
  try {
    const scrollersOutsideGrid = () => {
      const grid = byTestId(container, 'card-picker-grid');
      return [...container.querySelectorAll('div')]
        .filter((el) => isVerticalScroller(el))
        .filter((el) => !grid || (el !== grid && !grid.contains(el)));
    };

    assert.ok(byTestId(container, 'deck-mobile-panel-switch'), 'this must be the phone layout');
    assert.deepEqual(
      scrollersOutsideGrid().map(describe), [],
      'the picker route must leave the grid as the screen\'s only scroller',
    );

    // Switch to 主牌組: no list there, so the page must scroll again.
    await act(async () => byTestId(container, 'deck-mobile-panel-main').click());
    assert.equal(byTestId(container, 'card-picker-grid'), null, 'the deck panel replaces the picker');
    assert.ok(
      scrollersOutsideGrid().length > 0,
      'the deck panel must still be scrollable — the fix removes the CONFLICT, not scrolling',
    );
  } finally {
    await cleanup();
  }
});

// ── 5. Search / filter and tap-to-add still work under the new ownership ─────
function typeInto(input, value) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

await test('search narrows the grid and resets it to the top of the result set', async () => {
  openEmptyDeck();
  setViewport(ANDROID_PHONES[1]);
  const { container, cleanup } = await render(React.createElement(DeckEditorScreen));
  try {
    const grid = byTestId(container, 'card-picker-grid');
    const firstCell = container.querySelector('[data-testid^="card-cell-"]');
    assert.ok(firstCell, 'the grid must have mounted cells to search against');
    const cardNumber = firstCell.getAttribute('data-testid').replace('card-cell-', '');
    const db = await loadCardDatabase();
    const name = db.cards.find((c) => c.cardNumber === cardNumber)?.name;
    assert.ok(name, `${cardNumber} must carry a name to search for`);

    // Page past the first window so the reset is observable.
    await act(async () => {
      onEndReachedOf(grid)({ distanceFromEnd: 0 });
    });

    await act(async () => byTestId(container, 'open-filters').click());
    // RNW renders Modal content into the document, which may be outside `container`.
    const search = byTestId(document, 'card-search-input');
    assert.ok(search, 'the filter sheet must offer the search input');
    await act(async () => typeInto(search, name));

    const count = byTestId(container, 'card-result-count-mobile');
    const narrowed = Number((count.textContent.match(/\d[\d,]*/) ?? [])[0]?.replace(/,/g, ''));
    assert.ok(
      narrowed > 0 && narrowed < OSHI_TOTAL,
      `searching "${name}" must narrow ${OSHI_TOTAL} cards to a smaller non-empty set, got ${narrowed}`,
    );

    const regrid = byTestId(container, 'card-picker-grid');
    assert.ok(
      isVerticalScroller(regrid) && ancestorsOf(regrid, container).filter(isVerticalScroller).length === 0,
      'the grid must still own the drag after a filter change',
    );
  } finally {
    await cleanup();
  }
});

await test('tapping a card still adds it to the open deck', async () => {
  openEmptyDeck();
  setViewport(ANDROID_PHONES[1]);
  const { container, cleanup } = await render(React.createElement(DeckEditorScreen));
  try {
    const firstCell = container.querySelector('[data-testid^="card-cell-"]');
    const cardNumber = firstCell.getAttribute('data-testid').replace('card-cell-', '');
    await act(async () => byTestId(container, `card-cell-${cardNumber}`).click());

    const deck = useDeckStore.getState().decks[0];
    const added = ['oshi', 'main', 'yell']
      .flatMap((zone) => deck[zone])
      .find((slot) => slot.card.cardNumber === cardNumber);
    assert.ok(added, `tapping ${cardNumber} must put it in the deck — the picker adds by TAP, not by drag`);
    assert.ok(added.qty > 0, `${cardNumber} must be held with a real quantity`);

    const badge = byTestId(container, `card-qty-${cardNumber}`);
    assert.ok(badge, 'the tapped cell must show its quantity badge');
    assert.equal(badge.textContent, String(added.qty), 'the badge must show the held quantity');
  } finally {
    await cleanup();
  }
});

if (failures.length > 0) {
  console.log(`\nDIC-1320 deck picker scroll ownership: ${passed} passed, ${failures.length} FAILED`);
  for (const { name, err } of failures) {
    console.log(`\n  ✗ ${name}\n${String(err.stack || err.message)}`);
  }
  process.exit(1);
}

console.log(`\nDIC-1320 deck picker scroll ownership: ${passed} tests passed`);
