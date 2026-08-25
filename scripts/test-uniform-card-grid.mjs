#!/usr/bin/env node
import assert from 'node:assert/strict';
import { uniformGridItemStyle } from '../src/utils/gridLayout.ts';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

for (const itemCount of [1, 2, 3, 4, 5]) {
  test(`${itemCount} cards keep the same four-column width`, () => {
    const styles = Array.from({ length: itemCount }, () => uniformGridItemStyle(4));
    assert.ok(styles.every((style) => style.flexBasis === styles[0].flexBasis));
    assert.ok(styles.every((style) => style.maxWidth === styles[0].maxWidth));
    assert.equal(styles.at(-1).flexGrow, 0, 'the final partial-row card must not stretch');
    assert.notEqual(styles.at(-1).maxWidth, '100%', 'a lone final card must leave empty space');
  });
}

test('one-column mobile cards remain full width', () => {
  assert.deepEqual(uniformGridItemStyle(1), {
    flexBasis: '100%', maxWidth: '100%', flexGrow: 0, flexShrink: 1,
  });
});

test('invalid column counts safely fall back to one column', () => {
  assert.equal(uniformGridItemStyle(0).maxWidth, '100%');
});

// ── DIC-1150: pixel-mode contract ──
// The legacy percentage overload cannot close the row math (fixed 12px
// columnWrapper gap + guessed percentage gap → off by several px per row,
// which is exactly what produced the horizontal scrollbar and the
// unaligned third column on desktop). The pixel overload takes the
// measured container width and the actual gap so `n * width + (n-1) * gap`
// always equals `containerWidth`.

test('DIC-1150: 3 columns at 1068px with gap 12 → 348px per card', () => {
  const style = uniformGridItemStyle({ columns: 3, containerWidth: 1068, gap: 12 });
  assert.equal(style.width, 348);
  assert.equal(style.flexBasis, 348);
  assert.equal(style.maxWidth, 348);
  assert.equal(style.flexGrow, 0, 'pixel-mode cards must not grow to fill the row');
  assert.equal(style.flexShrink, 0, 'pixel-mode cards must not shrink into a neighbour');
  const rowTotal = 3 * style.width + 2 * 12;
  assert.ok(Math.abs(rowTotal - 1068) <= 1, `row math must close within 1px, got ${rowTotal}`);
});

test('DIC-1150: 2 columns at 736px with gap 12 → 362px per card', () => {
  const style = uniformGridItemStyle({ columns: 2, containerWidth: 736, gap: 12 });
  assert.equal(style.width, 362);
  assert.equal(style.flexBasis, 362);
  assert.equal(style.maxWidth, 362);
  const rowTotal = 2 * style.width + 12;
  assert.ok(Math.abs(rowTotal - 736) <= 1, `row math must close within 1px, got ${rowTotal}`);
});

test('DIC-1150: 1 column at 390px keeps the full container width', () => {
  const style = uniformGridItemStyle({ columns: 1, containerWidth: 390, gap: 12 });
  assert.equal(style.width, 390);
  assert.equal(style.flexBasis, 390);
  assert.equal(style.maxWidth, 390);
});

test('DIC-1150: pixel-mode rows must never overflow their container', () => {
  const cases = [
    { columns: 3, containerWidth: 1068 },
    { columns: 3, containerWidth: 1100 - 32 }, // 1080 desktop, minus 16px list padding on each side
    { columns: 3, containerWidth: 1366 - 32 },
    { columns: 3, containerWidth: 1440 - 32 },
    { columns: 2, containerWidth: 900 - 32 },
    { columns: 2, containerWidth: 768 - 32 },
    { columns: 1, containerWidth: 390 - 32 },
  ];
  for (const { columns, containerWidth } of cases) {
    const style = uniformGridItemStyle({ columns, containerWidth, gap: 12 });
    const rowTotal = columns * style.width + Math.max(0, (columns - 1) * 12);
    assert.ok(
      rowTotal <= containerWidth,
      `columns=${columns} container=${containerWidth} produced row ${rowTotal} > container`
    );
    assert.ok(
      containerWidth - rowTotal <= (columns - 1) + 1,
      `columns=${columns} container=${containerWidth} left too much slack: ${containerWidth - rowTotal}`
    );
  }
});

test('DIC-1150: last row of a partial grid keeps the row-1 pixel width', () => {
  const args = { columns: 3, containerWidth: 1068, gap: 12 };
  const styles = Array.from({ length: 5 }, () => uniformGridItemStyle(args));
  // Second row has just two cards; both must still be 348px so they do not stretch.
  assert.equal(styles[3].width, 348);
  assert.equal(styles[4].width, 348);
  assert.equal(styles[4].flexGrow, 0, 'the final partial-row card must not stretch');
});

test('DIC-1150: invalid container widths fall back to the legacy percentage layout', () => {
  const style = uniformGridItemStyle({ columns: 3, containerWidth: 0, gap: 12 });
  // 0 or negative container width means we have not measured yet — the fallback
  // must not render a 0-width row (that would collapse cards to invisible).
  assert.equal(style.maxWidth, `${(100 - 4) / 3}%`);
});

console.log(`\nDIC-1088 + DIC-1150 uniform card grid: ${passed} tests passed`);
