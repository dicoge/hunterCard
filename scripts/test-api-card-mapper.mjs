/**
 * test-api-card-mapper.mjs
 *
 * Direct input/output test of the SINGLE live pure mapper used by every scan
 * call site (ScanScreen candidates + API-success, cardRecognition API path):
 * src/utils/apiCardMapper.ts → mapApiCardToCardInfo.
 *
 * This replaces the old whole-file `source.includes` grep for the scan mapper,
 * which false-passed when a mapper with the right string literals was dead code
 * (DIC-856 CR finding). Binding the assertions to the actual mapper's output
 * guarantees buyPrice (including 0 / null), priceHistory, and ytStats really
 * flow from the API payload to the scan session card / CardDetail.
 *
 * Run:  node --experimental-strip-types scripts/test-api-card-mapper.mjs
 * (Node 22.6+; type stripping lets us import the .ts helper directly.)
 */
import assert from 'node:assert/strict';
import { mapApiCardToCardInfo } from '../src/utils/apiCardMapper.ts';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('api card mapper verification (DIC-361 / DIC-856)');

check('buyPrice = 0 is preserved (not coerced to null)', () => {
  const out = mapApiCardToCardInfo({ cardNumber: 'hSD01-001', buyPrice: 0 });
  assert.strictEqual(out.buyPrice, 0);
});

check('buyPrice = null stays null (fail-closed, no fallback)', () => {
  const out = mapApiCardToCardInfo({ cardNumber: 'hSD01-001', buyPrice: null });
  assert.strictEqual(out.buyPrice, null);
});

check('buyPrice undefined → null', () => {
  const out = mapApiCardToCardInfo({ cardNumber: 'hSD01-001' });
  assert.strictEqual(out.buyPrice, null);
});

check('positive buyPrice is passed through unchanged', () => {
  const out = mapApiCardToCardInfo({ cardNumber: 'hSD01-001', buyPrice: 38000 });
  assert.strictEqual(out.buyPrice, 38000);
});

check('priceHistory passes through; missing → {}', () => {
  const history = { '2026-07-01': 100, '2026-07-02': 120 };
  const out = mapApiCardToCardInfo({ cardNumber: 'hSD01-001', priceHistory: history });
  assert.deepStrictEqual(out.priceHistory, history);
  const empty = mapApiCardToCardInfo({ cardNumber: 'hSD01-001' });
  assert.deepStrictEqual(empty.priceHistory, {});
});

check('ytStats passes through; missing → null', () => {
  const yt = { subscribers: 1000, growth: 5 };
  const out = mapApiCardToCardInfo({ cardNumber: 'hSD01-001', ytStats: yt });
  assert.deepStrictEqual(out.ytStats, yt);
  const none = mapApiCardToCardInfo({ cardNumber: 'hSD01-001' });
  assert.strictEqual(none.ytStats, null);
});

check('sellPrice = 0 preserved; missing → null', () => {
  assert.strictEqual(mapApiCardToCardInfo({ cardNumber: 'x', sellPrice: 0 }).sellPrice, 0);
  assert.strictEqual(mapApiCardToCardInfo({ cardNumber: 'x' }).sellPrice, null);
});

check('core identity fields mapped', () => {
  const out = mapApiCardToCardInfo({
    cardNumber: 'hSD01-001',
    name: 'ラプラス・ダークネス',
    rarity: 'SEC',
    series: 'hSD01',
    imageUrl: 'https://example/img.png',
    prices: [{ name: 'SEC', sellPrice: 69800, buyPrice: 38000 }],
  });
  assert.strictEqual(out.id, 'hSD01-001');
  assert.strictEqual(out.cardNumber, 'hSD01-001');
  assert.strictEqual(out.name, 'ラプラス・ダークネス');
  assert.strictEqual(out.rarity, 'SEC');
  assert.strictEqual(out.series, 'hSD01');
  assert.strictEqual(out.imageUrl, 'https://example/img.png');
  assert.deepStrictEqual(out.prices, [{ name: 'SEC', sellPrice: 69800, buyPrice: 38000 }]);
});

console.log(`\nAll ${passed} checks passed.`);
