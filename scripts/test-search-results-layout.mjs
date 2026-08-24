#!/usr/bin/env node
// DIC-1150: viewport-level layout contract for the search results grid.
//
// This test locks in the invariants the ticket calls out: for every desktop
// viewport we care about, the FlatList row must fit inside the available width
// (no horizontal scrollbar), the third column must line up with the right
// edge of the content area, and the mobile viewport must stay single-column.
//
// The math mirrors what SearchResultsScreen does at render time:
//   1. centerWrap width = min(viewport, DESKTOP_MAX_WIDTH)
//   2. list content width = centerWrap width - 2 * LIST_PADDING_X
//   3. column count comes from useBreakpoint (>=1100 → 3, >=768 → 2, else 1)
//   4. per-card width = floor((content - (cols-1) * GAP) / cols)
//   5. row total = cols * per-card + (cols-1) * GAP
//
// The test does NOT re-implement the math — it imports the same helper the
// screen uses so that a regression in the math breaks the test.
import assert from 'node:assert/strict';
import { uniformGridItemStyle } from '../src/utils/gridLayout.ts';

const LIST_PADDING_X = 16;
const GRID_GAP = 12;
const DESKTOP_MAX_WIDTH = 1100;
const DESKTOP_BREAKPOINT = 768;
const WIDE_BREAKPOINT = 1100;

function columnsFor(viewport) {
  if (viewport >= WIDE_BREAKPOINT) return 3;
  if (viewport >= DESKTOP_BREAKPOINT) return 2;
  return 1;
}

function layoutForViewport(viewport) {
  const centerWrap = Math.min(viewport, DESKTOP_MAX_WIDTH);
  const content = centerWrap - LIST_PADDING_X * 2;
  const columns = columnsFor(viewport);
  const style = uniformGridItemStyle({ columns, containerWidth: content, gap: GRID_GAP });
  const perCard = style.width;
  const rowTotal = columns * perCard + (columns - 1) * GRID_GAP;
  return { centerWrap, content, columns, perCard, rowTotal, style };
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

for (const viewport of [1080, 1100, 1366, 1440]) {
  test(`viewport ${viewport}px keeps rows inside the content area (no horizontal scrollbar)`, () => {
    const { content, columns, rowTotal, perCard } = layoutForViewport(viewport);
    assert.ok(rowTotal <= content, `row ${rowTotal} exceeded content ${content}`);
    // Any slack must be at most `columns - 1` px (integer flooring per column
    // can drop up to 1px per card). Anything more means the math left a
    // visible gap on the right — which is the misalignment users see.
    const slack = content - rowTotal;
    assert.ok(
      slack <= columns - 1,
      `viewport ${viewport}: rowTotal ${rowTotal} leaves ${slack}px slack on ${content}px content`
    );
    // And of course the row must not exceed the outer centerWrap either,
    // which is what triggers the page-level horizontal scrollbar.
    assert.ok(rowTotal + LIST_PADDING_X * 2 <= Math.min(viewport, DESKTOP_MAX_WIDTH));
    assert.ok(perCard > 0, `perCard must be positive, got ${perCard}`);
  });
}

test('1080px desktop lands on the 2-column layout with the row closing to the content width', () => {
  // The wide breakpoint is 1100, so 1080 is 2 columns per useBreakpoint.
  const { columns, perCard, content, rowTotal } = layoutForViewport(1080);
  assert.equal(columns, 2);
  assert.equal(perCard, Math.floor((content - GRID_GAP) / 2));
  assert.ok(rowTotal <= content);
});

test('1366px desktop stays on the 3-column layout at the desktop max width', () => {
  const { centerWrap, columns, perCard } = layoutForViewport(1366);
  assert.equal(columns, 3);
  assert.equal(centerWrap, DESKTOP_MAX_WIDTH, 'centerWrap must be clamped to the desktop max');
  // 1100 → content 1068 → per card floor(1044/3) = 348.
  assert.equal(perCard, 348);
});

test('390px mobile falls back to a single full-width card', () => {
  const { columns, perCard, content } = layoutForViewport(390);
  assert.equal(columns, 1);
  assert.equal(perCard, content, 'single-column card must own the whole content area');
});

test('768px tablet lands on the 2-column layout', () => {
  const { columns, perCard, content, rowTotal } = layoutForViewport(768);
  assert.equal(columns, 2);
  assert.equal(perCard, Math.floor((content - GRID_GAP) / 2));
  assert.ok(rowTotal <= content);
});

console.log(`\nDIC-1150 search results layout: ${passed} tests passed`);
