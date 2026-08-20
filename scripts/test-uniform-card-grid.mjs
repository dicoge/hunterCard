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

console.log(`\nDIC-1088 uniform card grid: ${passed} tests passed`);
