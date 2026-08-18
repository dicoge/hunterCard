#!/usr/bin/env node
/**
 * DIC-1087 — 到價提醒 and the card-number 趨勢追蹤 list were two names for one
 * feature. This pins the model half of folding them into one:
 *
 *   - migration: a legacy card-number row becomes a real alert ONLY when the
 *     catalog proves the card number has exactly one printing and the row
 *     already stated a target price; otherwise it asks, and never guesses or
 *     crosses versions
 *   - duplicate records: differently-keyed records for the same printing
 *     collapse deterministically, and the user's configured range survives
 *   - interval boundaries: both ends inclusive, one step outside does not fire
 *   - exact-version isolation: two printings of one card number are two alerts
 *     with two prices and two arm states
 *   - image identity: a row's thumbnail comes from its own source listing or
 *     from a stable placeholder — never from a representative/sibling image
 *   - reload: alerts, pending rows and the collapse survive rehydration
 *   - notification dedupe: one push per entry into the interval, per device
 *
 * Run: npm run test:alert-unification
 */
import assert from 'node:assert/strict';
import {
  dedupePriceAlerts, evaluatePriceAlerts, evaluateAlertStatus, armStateKey,
  priceAlertKey, buildAlertMessage, hasUsableInterval,
} from '../src/utils/priceAlerts.ts';
import {
  migrateLegacyTracking, buildPrintingIndex, resolvePrintingImage, pendingPrompt,
} from '../src/utils/alertMigration.ts';
import { usePriceAlertStore } from '../src/stores/priceAlertStore.ts';
import { useWatchlistStore } from '../src/stores/watchlistStore.ts';
import platformStorage from '../src/stores/storage.ts';
import { adaptDatabase } from '../src/utils/deckCardData.ts';

const STORE_KEY = 'hunterCard-price-alerts';
const TOKEN = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const OTHER_TOKEN = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]';
const NOW = '2026-08-18T00:00:00.000Z';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function resetStores() {
  usePriceAlertStore.setState({ alerts: {}, pending: {} });
  useWatchlistStore.setState({ items: [] });
  platformStorage.removeItem(STORE_KEY);
}

const alertOf = (over = {}) => ({
  cardNumber: 'hBP04-005',
  printing: 'BASE',
  printingLabel: 'ラプラス・ダークネス',
  name: 'ラプラス・ダークネス',
  currency: 'JPY',
  lowerPrice: null,
  upperPrice: 1200,
  createdAt: '2026-08-16T00:00:00.000Z',
  updatedAt: '2026-08-16T00:00:00.000Z',
  ...over,
});

// A card number with ONE printing, and one with three — the whole migration
// question is which of those two a legacy row is.
const CATALOG = adaptDatabase([
  {
    id: 'single', cardNumber: 'hBP01-075', name: 'single', nameZh: '單一版本',
    series: 'hBP01', type: 'Member', timestamp: '2026-08-01',
    officialImage: 'https://img.test/hBP01-075.png',
    prices: [{
      name: '單一版本', sellPrice: 600, buyPrice: 200,
      imageUrl: 'https://img.test/hBP01-075-base.png',
    }],
  },
  {
    id: 'multi', cardNumber: 'hBP04-005', name: 'multi', nameZh: 'ラプラス・ダークネス',
    series: 'hBP04', type: 'Member', timestamp: '2026-08-01',
    // This card-level image depicts the signed printing. It must never leak
    // into BASE or PARALLEL merely because this row is representative.
    officialImage: 'https://img.test/hBP04-005_SEC.png',
    prices: [
      {
        name: 'ラプラス・ダークネス', sellPrice: 980, buyPrice: 300,
        imageUrl: 'https://img.test/hBP04-005_BASE.png',
      },
      {
        name: 'ラプラス・ダークネス(パラレル)', sellPrice: 9980,
        imageUrl: 'https://img.test/hBP04-005_PARALLEL.png',
      },
      {
        name: 'ラプラス・ダークネス(パラレル/サイン)', sellPrice: 69800,
        imageUrl: 'https://img.test/hBP04-005_PARALLEL_SIGN.png',
      },
    ],
  },
]);
const INDEX = buildPrintingIndex(CATALOG.cards, CATALOG.priceRecords);

// Mirrors the currently shipped hBP04-005 shape: three price listings but only
// one representative SEC image at card level. No printing has image provenance.
const UNPROVEN_INDEX = buildPrintingIndex(adaptDatabase([{
  id: 'unproven', cardNumber: 'hBP04-005', name: 'multi', series: 'hBP04', type: 'Member',
  officialImage: 'https://img.test/hBP04-005_SEC.png',
  prices: [
    { name: 'ラプラス・ダークネス', sellPrice: 980 },
    { name: 'ラプラス・ダークネス(パラレル)', sellPrice: 9980 },
    { name: 'ラプラス・ダークネス(パラレル/サイン)', sellPrice: 69800 },
  ],
}]).cards, CATALOG.priceRecords);

// ── 1. Migration ────────────────────────────────────────────────────────────
await test('a one-printing row with a target price migrates into a real alert', () => {
  const result = migrateLegacyTracking(
    [{ cardNumber: 'hBP01-075', name: 'single', nameZh: '單一版本', targetPrice: 500, addedAt: '2025-01-01T00:00:00.000Z' }],
    {}, INDEX, NOW,
  );
  assert.equal(result.pending.length, 0);
  assert.equal(result.alerts.length, 1);
  const [alert] = result.alerts;
  assert.equal(alert.cardNumber, 'hBP01-075');
  assert.equal(alert.printing, 'BASE', 'the only printing the source states');
  assert.equal(alert.printingLabel, '單一版本');
  assert.equal(alert.lowerPrice, null);
  assert.equal(alert.upperPrice, 500, "the legacy target becomes the range's upper bound");
  assert.equal(alert.currency, 'JPY');
  assert.equal(alert.createdAt, '2025-01-01T00:00:00.000Z', 'the row keeps its original age');
  assert.ok(hasUsableInterval(alert));
});

await test('a multi-printing row asks for the version instead of guessing one', () => {
  const result = migrateLegacyTracking(
    [{ cardNumber: 'hBP04-005', name: 'multi', targetPrice: 1200 }], {}, INDEX, NOW,
  );
  assert.equal(result.alerts.length, 0, 'never picks a printing on the user behalf');
  assert.equal(result.pending.length, 1);
  const [item] = result.pending;
  assert.deepEqual(item.needs, ['PRINTING']);
  assert.equal(item.legacyTargetPrice, 1200, 'the target price is carried, not discarded');
  assert.match(pendingPrompt(item), /需選擇版本/);
});

await test('a row with no target price asks for the range too', () => {
  const single = migrateLegacyTracking([{ cardNumber: 'hBP01-075', name: 'single' }], {}, INDEX, NOW);
  assert.equal(single.alerts.length, 0, 'a row with no price to compare is not an alert');
  assert.deepEqual(single.pending[0].needs, ['RANGE']);
  assert.equal(single.pending[0].legacyTargetPrice, null);

  const both = migrateLegacyTracking([{ cardNumber: 'hBP04-005', name: 'multi' }], {}, INDEX, NOW);
  assert.deepEqual(both.pending[0].needs, ['PRINTING', 'RANGE']);
});

await test('a card number the catalog does not know is asked about, not invented', () => {
  const result = migrateLegacyTracking(
    [{ cardNumber: 'hBP99-999', name: 'unknown', targetPrice: 100 }], {}, INDEX, NOW,
  );
  assert.equal(result.alerts.length, 0);
  assert.deepEqual(result.pending[0].needs, ['PRINTING']);
});

await test('a malformed legacy target price is not smuggled in as a range', () => {
  for (const targetPrice of [-1, 12.5, Number.NaN]) {
    const result = migrateLegacyTracking(
      [{ cardNumber: 'hBP01-075', name: 'single', targetPrice }], {}, INDEX, NOW,
    );
    assert.equal(result.alerts.length, 0, `${targetPrice} must not become a bound`);
    assert.ok(result.pending[0].needs.includes('RANGE'));
  }
});

await test('a card number that already has an alert absorbs its legacy row silently', () => {
  const existing = { [priceAlertKey('hBP01-075', 'BASE')]: alertOf({ cardNumber: 'hBP01-075' }) };
  const result = migrateLegacyTracking(
    [{ cardNumber: 'hBP01-075', name: 'single', targetPrice: 500 }], existing, INDEX, NOW,
  );
  assert.equal(result.alerts.length, 0, 'the configured alert is not overwritten');
  assert.equal(result.pending.length, 0, 'and the user is not asked about it again');
  assert.equal(result.absorbed, 1);
});

await test('the same card number listed twice migrates once', () => {
  const result = migrateLegacyTracking([
    { cardNumber: 'hBP01-075', name: 'single', targetPrice: 500 },
    { cardNumber: 'hBP01-075', name: 'single again', targetPrice: 900 },
  ], {}, INDEX, NOW);
  assert.equal(result.alerts.length, 1);
  assert.equal(result.alerts[0].upperPrice, 500, 'the first row wins deterministically');
  assert.equal(result.absorbed, 1);
});

await test('importing through the store clears nothing the user configured', () => {
  resetStores();
  const store = usePriceAlertStore.getState();
  store.upsertAlert({
    cardNumber: 'hBP04-005', printing: 'PARALLEL', printingLabel: 'ラプラス・ダークネス(パラレル)',
    name: 'ラプラス', currency: 'JPY', lowerPrice: 5000, upperPrice: 9000,
  });
  store.importLegacyTracking([
    { cardNumber: 'hBP01-075', name: 'single', targetPrice: 500 },
    { cardNumber: 'hBP04-005', name: 'multi', targetPrice: 1200 },
  ], INDEX, NOW);

  const state = usePriceAlertStore.getState();
  assert.equal(state.alerts[priceAlertKey('hBP04-005', 'PARALLEL')].upperPrice, 9000, 'kept as configured');
  assert.equal(state.alerts[priceAlertKey('hBP01-075', 'BASE')].upperPrice, 500, 'resolved row became an alert');
  assert.deepEqual(Object.keys(state.pending), [], 'hBP04-005 already had an alert, so nothing is pending');
});

await test('configuring a pending row is what removes it from the list', () => {
  resetStores();
  const store = usePriceAlertStore.getState();
  store.importLegacyTracking([{ cardNumber: 'hBP04-005', name: 'multi', targetPrice: 1200 }], INDEX, NOW);
  assert.deepEqual(Object.keys(usePriceAlertStore.getState().pending), ['hBP04-005']);

  store.upsertAlert({
    cardNumber: 'hBP04-005', printing: 'PARALLEL', printingLabel: 'ラプラス・ダークネス(パラレル)',
    name: 'ラプラス', currency: 'JPY', lowerPrice: null, upperPrice: 9000,
  });
  const state = usePriceAlertStore.getState();
  assert.deepEqual(state.pending, {}, 'the prompt is answered');
  assert.equal(state.alerts[priceAlertKey('hBP04-005', 'PARALLEL')].upperPrice, 9000);
  assert.equal(state.alerts[priceAlertKey('hBP04-005', 'BASE')], undefined, 'only the chosen printing');
});

// ── 2. Duplicate records ────────────────────────────────────────────────────
await test('records for one printing under different keys collapse to one', () => {
  const result = dedupePriceAlerts({
    // Same printing, two storage keys: an untrimmed card number and a
    // case/width-folded token both address the one identity.
    ' hBP04-005 |parallel': alertOf({ cardNumber: ' hBP04-005 ', printing: 'parallel', upperPrice: 5000, updatedAt: '2026-08-01T00:00:00.000Z' }),
    'hBP04-005|PARALLEL': alertOf({ printing: 'ＰＡＲＡＬＬＥＬ', upperPrice: 9000, updatedAt: '2026-08-10T00:00:00.000Z' }),
  });
  assert.equal(Object.keys(result.alerts).length, 1);
  assert.equal(result.merged, 1);
  const survivor = result.alerts[priceAlertKey('hBP04-005', 'PARALLEL')];
  assert.equal(survivor.upperPrice, 9000, 'the most recently configured range survives');
});

await test('the collapse is deterministic whatever order the records are read in', () => {
  const records = {
    b: alertOf({ printing: 'PARALLEL', upperPrice: 9000, updatedAt: '2026-08-10T00:00:00.000Z' }),
    a: alertOf({ printing: 'parallel', upperPrice: 7000, updatedAt: '2026-08-10T00:00:00.000Z' }),
    c: alertOf({ printing: ' PARALLEL ', upperPrice: 8000, updatedAt: '2026-08-10T00:00:00.000Z' }),
  };
  const forward = dedupePriceAlerts(records);
  const reversed = dedupePriceAlerts(Object.fromEntries(Object.entries(records).reverse()));
  assert.deepEqual(forward.alerts, reversed.alerts, 'same records → same survivor');
  // Every tie-break above is equal down to the storage key, so 'a' decides it.
  assert.equal(Object.values(forward.alerts)[0].upperPrice, 7000);
});

await test('a configured range is never lost to a malformed twin', () => {
  const result = dedupePriceAlerts({
    // The newer record would win on recency alone, but its interval is one the
    // editor would have rejected, so it must not displace the real range.
    fresh: alertOf({ lowerPrice: 5000, upperPrice: 100, updatedAt: '2026-08-17T00:00:00.000Z' }),
    real: alertOf({ lowerPrice: 800, upperPrice: 1200, updatedAt: '2026-08-01T00:00:00.000Z' }),
  });
  const survivor = Object.values(result.alerts)[0];
  assert.equal(survivor.lowerPrice, 800);
  assert.equal(survivor.upperPrice, 1200);
});

await test('the collapse fills the survivor blanks instead of blanking the row', () => {
  const result = dedupePriceAlerts({
    a: alertOf({ printingLabel: 'ラプラス・ダークネス', imageUrl: 'https://img.test/a.png', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }),
    b: alertOf({ printingLabel: '', imageUrl: undefined, updatedAt: '2026-08-10T00:00:00.000Z' }),
  });
  const survivor = Object.values(result.alerts)[0];
  assert.equal(survivor.updatedAt, '2026-08-10T00:00:00.000Z', 'the newer record still wins');
  assert.equal(survivor.printingLabel, 'ラプラス・ダークネス', 'label recovered from the loser');
  assert.equal(survivor.imageUrl, 'https://img.test/a.png', 'thumbnail recovered from the loser');
  assert.equal(survivor.createdAt, '2026-01-01T00:00:00.000Z', 'tracked since the earliest record');
});

await test('records with no representable identity or interval are dropped, not kept half-alive', () => {
  const result = dedupePriceAlerts({
    noPrinting: alertOf({ printing: '   ' }),
    noCardNumber: alertOf({ cardNumber: '' }),
    noRange: alertOf({ cardNumber: 'hBP01-075', upperPrice: null }),
  });
  assert.deepEqual(result.alerts, {});
  assert.equal(result.dropped, 3);
});

await test('distinct printings of one card number are never merged', () => {
  const result = dedupePriceAlerts([
    alertOf({ printing: 'BASE' }),
    alertOf({ printing: 'PARALLEL' }),
    alertOf({ printing: 'PARALLEL/SIGN' }),
  ]);
  assert.equal(Object.keys(result.alerts).length, 3);
  assert.equal(result.merged, 0);
});

// ── 3. Interval boundaries ──────────────────────────────────────────────────
await test('both ends of the interval are inclusive and one step outside is silent', () => {
  const alert = alertOf({ lowerPrice: 800, upperPrice: 1200 });
  const fire = (price) => evaluatePriceAlerts(
    [{ token: TOKEN, alert }], () => ({ price, currency: 'JPY' }), {},
  ).sends.length;
  assert.equal(fire(800), 1, 'the lower bound itself is in range');
  assert.equal(fire(1200), 1, 'the upper bound itself is in range');
  assert.equal(fire(799), 0);
  assert.equal(fire(1201), 0);
  assert.equal(evaluateAlertStatus(alert, { price: 799, currency: 'JPY' }), 'BELOW_RANGE');
  assert.equal(evaluateAlertStatus(alert, { price: 1201, currency: 'JPY' }), 'ABOVE_RANGE');
});

// ── 4. Exact-version isolation ──────────────────────────────────────────────
await test('two printings of one card number are two alerts with two prices', () => {
  const base = alertOf({ printing: 'BASE', upperPrice: 1200 });
  const parallel = alertOf({ printing: 'PARALLEL', upperPrice: 1200 });
  const priceOf = (cardNumber, printing) => {
    const option = INDEX.get(cardNumber)?.find((o) => o.printing === printing);
    return option && option.sellPrice !== null ? { price: option.sellPrice, currency: option.currency } : null;
  };
  const result = evaluatePriceAlerts(
    [{ token: TOKEN, alert: base }, { token: TOKEN, alert: parallel }], priceOf, {},
  );
  assert.equal(result.sends.length, 1, 'only the printing actually in range fires');
  assert.equal(result.sends[0].alert.printing, 'BASE');
  assert.equal(result.sends[0].price, 980, "and it fires on its OWN printing's price");
});

await test('the two printings keep separate arm states', () => {
  const base = alertOf({ printing: 'BASE' });
  const parallel = alertOf({ printing: 'PARALLEL' });
  const baseKey = armStateKey(TOKEN, 'hBP04-005', 'BASE');
  assert.notEqual(baseKey, armStateKey(TOKEN, 'hBP04-005', 'PARALLEL'));

  const result = evaluatePriceAlerts(
    [{ token: TOKEN, alert: base }, { token: TOKEN, alert: parallel }],
    () => ({ price: 1000, currency: 'JPY' }),
    { [baseKey]: { armed: false } },
  );
  assert.equal(result.sends.length, 1, 'silencing one printing must not silence the other');
  assert.equal(result.sends[0].alert.printing, 'PARALLEL');
});

// ── 5. Image identity ───────────────────────────────────────────────────────
await test('BASE, PARALLEL and signed rows resolve three source-proven images', () => {
  const expected = {
    BASE: 'https://img.test/hBP04-005_BASE.png',
    PARALLEL: 'https://img.test/hBP04-005_PARALLEL.png',
    'PARALLEL/SIGN': 'https://img.test/hBP04-005_PARALLEL_SIGN.png',
  };
  for (const [printing, imageUrl] of Object.entries(expected)) {
    assert.equal(
      resolvePrintingImage('hBP04-005', printing, INDEX),
      imageUrl,
      `${printing} keeps its own listing image`,
    );
  }
  assert.equal(resolvePrintingImage('hBP01-075', 'BASE', INDEX), 'https://img.test/hBP01-075-base.png');
});

await test('a shared card-level SEC image becomes placeholders for all three printings', () => {
  for (const printing of ['BASE', 'PARALLEL', 'PARALLEL/SIGN']) {
    assert.equal(
      resolvePrintingImage('hBP04-005', printing, UNPROVEN_INDEX),
      undefined,
      `${printing} must not borrow the representative signed image`,
    );
  }
});

await test('an unknown printing or card number borrows no image at all', () => {
  assert.equal(resolvePrintingImage('hBP04-005', 'FOIL', INDEX), undefined, 'no sibling printing fallback');
  assert.equal(resolvePrintingImage('hBP04-005', '', INDEX), undefined, 'card-number-only resolves nothing');
  assert.equal(resolvePrintingImage('hBP99-999', 'BASE', INDEX), undefined, 'no other card fallback');
});

// ── 6. Reload ───────────────────────────────────────────────────────────────
await test('alerts and pending rows survive a reload', async () => {
  resetStores();
  const store = usePriceAlertStore.getState();
  store.upsertAlert({
    cardNumber: 'hBP04-005', printing: 'base', printingLabel: 'ラプラス・ダークネス',
    name: 'ラプラス', currency: 'JPY', lowerPrice: 800, upperPrice: 1200,
    imageUrl: 'https://img.test/hBP04-005_BASE.png',
  });
  store.importLegacyTracking([{ cardNumber: 'hBP99-999', name: 'unknown', targetPrice: 100 }], INDEX, NOW);

  const raw = platformStorage.getItem(STORE_KEY);
  assert.ok(raw, 'a persisted payload must be written');
  usePriceAlertStore.setState({ alerts: {}, pending: {} });
  platformStorage.setItem(STORE_KEY, raw);
  await usePriceAlertStore.persist.rehydrate();

  const restored = usePriceAlertStore.getState();
  const alert = restored.alerts[priceAlertKey('hBP04-005', 'BASE')];
  assert.ok(alert, 'the alert survives');
  assert.equal(alert.lowerPrice, 800);
  assert.equal(alert.upperPrice, 1200);
  assert.equal(alert.imageUrl, 'https://img.test/hBP04-005_BASE.png', 'the exact printing thumbnail survives');
  assert.ok(restored.pending['hBP99-999'], 'an unanswered prompt is still asked after a reload');
});

await test('a v1 payload with duplicate records rehydrates collapsed', async () => {
  resetStores();
  platformStorage.setItem(STORE_KEY, JSON.stringify({
    version: 1,
    state: {
      alerts: {
        'hBP04-005|parallel': alertOf({ printing: 'parallel', upperPrice: 5000, updatedAt: '2026-08-01T00:00:00.000Z' }),
        'hBP04-005|PARALLEL': alertOf({ printing: 'PARALLEL', upperPrice: 9000, updatedAt: '2026-08-10T00:00:00.000Z' }),
        'hBP04-005|BASE': alertOf({
          printing: 'BASE', upperPrice: 1200,
          imageUrl: 'https://img.test/hBP04-005_SEC.png',
        }),
      },
    },
  }));
  await usePriceAlertStore.persist.rehydrate();

  const { alerts } = usePriceAlertStore.getState();
  assert.equal(Object.keys(alerts).length, 2, 'the two PARALLEL records became one');
  assert.equal(alerts[priceAlertKey('hBP04-005', 'PARALLEL')].upperPrice, 9000, 'range preserved');
  assert.equal(alerts[priceAlertKey('hBP04-005', 'BASE')].upperPrice, 1200, 'BASE untouched');
  assert.equal(
    alerts[priceAlertKey('hBP04-005', 'BASE')].imageUrl,
    undefined,
    'v1/v2 representative thumbnails are discarded because their printing was never proven',
  );
});

// ── 7. Notification dedupe ──────────────────────────────────────────────────
await test('one 到價提醒 per entry into the interval, and it says 到價提醒', () => {
  const alert = alertOf({ lowerPrice: 800, upperPrice: 1200 });
  const recipients = [{ token: TOKEN, alert }];
  const key = armStateKey(TOKEN, alert.cardNumber, alert.printing);
  const at = (price) => () => ({ price, currency: 'JPY' });

  const entry = evaluatePriceAlerts(recipients, at(1000), {});
  assert.equal(entry.sends.length, 1);
  assert.match(buildAlertMessage(entry.sends[0]).title, /到價提醒/);

  const disarmed = { [key]: { armed: false, lastNotifiedAt: 1, lastPrice: 1000 } };
  assert.equal(evaluatePriceAlerts(recipients, at(1000), disarmed).sends.length, 0, 'no repeat');
  assert.equal(evaluatePriceAlerts(recipients, at(900), disarmed).sends.length, 0, 'still no repeat while inside');
  assert.deepEqual(evaluatePriceAlerts(recipients, at(2000), disarmed).rearm, [key], 'leaving re-arms');
  assert.equal(evaluatePriceAlerts(recipients, at(1000), { [key]: { armed: true } }).sends.length, 1);
});

await test('each device is deduped on its own', () => {
  const alert = alertOf();
  const result = evaluatePriceAlerts(
    [{ token: TOKEN, alert }, { token: OTHER_TOKEN, alert }],
    () => ({ price: 1000, currency: 'JPY' }),
    { [armStateKey(TOKEN, alert.cardNumber, alert.printing)]: { armed: false } },
  );
  assert.equal(result.sends.length, 1);
  assert.equal(result.sends[0].token, OTHER_TOKEN);
  assert.equal(result.skipped, 1);
});

console.log(`\n[alert-unification] ${passed} checks passed`);
