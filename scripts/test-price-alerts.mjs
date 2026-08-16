#!/usr/bin/env node
/**
 * DIC-1023 desired-purchase-price interval + arrival alert regression.
 *
 * Covers the issue's acceptance matrix (item 10):
 *   - interval validation (non-negative integers, upper required, lower <= upper)
 *   - exact-version matching (never card-number-only / cross-version / same-name)
 *   - sell-vs-buy isolation (a store acquisition price can never trigger)
 *   - range entry and below-lower behaviour
 *   - dedupe on unchanged price + re-arm after leaving and re-entering
 *   - legacy card-number-only watchlist items are readable but never promoted
 *   - local persistence across reload (rehydration)
 *   - API validation / security (payload rules + fail-closed internal secret)
 *   - missing / unpriced rows produce no alert instead of a guessed one
 *
 * Run: node --experimental-strip-types --import ./scripts/register-ts.mjs \
 *        scripts/test-price-alerts.mjs
 */
import assert from 'node:assert/strict';
import {
  validateInterval, parsePriceField, isPriceInInterval, evaluateAlertStatus,
  evaluatePriceAlerts, priceAlertKey, armStateKey, buildAlertMessage,
  formatInterval, MAX_ALERT_PRICE,
} from '../src/utils/priceAlerts.ts';
import { usePriceAlertStore } from '../src/stores/priceAlertStore.ts';
import { useWatchlistStore } from '../src/stores/watchlistStore.ts';
import platformStorage from '../src/stores/storage.ts';
import { adaptCardNumber } from '../src/utils/deckCardData.ts';
import { computeGap, resolveExactPrice } from '../src/utils/deckRules.ts';
import {
  parsePriceAlertRequest, parsePriceSnapshot, indexPrices,
} from '../api/_lib/price-alert-request.ts';
import { isInternalRequest } from '../api/_lib/internal-auth.ts';

const STORE_KEY = 'hunterCard-price-alerts';
const TOKEN = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
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

function resetStores() {
  usePriceAlertStore.setState({ alerts: {} });
  useWatchlistStore.setState({ items: [] });
  platformStorage.removeItem(STORE_KEY);
}

// ── 1. Interval validation ──────────────────────────────────────────────────
await test('upper bound is required', () => {
  const r = validateInterval('', '');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'UPPER_REQUIRED');
  assert.equal(validateInterval('100', null).code, 'UPPER_REQUIRED');
});

await test('bounds must be non-negative integers', () => {
  for (const bad of ['-1', '1.5', '1,2.5', 'abc', '¥1200', '1e3', ' - ']) {
    const r = validateInterval('', bad);
    assert.equal(r.ok, false, `${bad} must be rejected`);
    assert.equal(r.code, 'NOT_INTEGER', `${bad} → NOT_INTEGER`);
  }
  // 0 is a legitimate bound, and a full-width / comma-formatted paste folds.
  assert.deepEqual(validateInterval('0', '0'), { ok: true, lowerPrice: 0, upperPrice: 0 });
  assert.deepEqual(validateInterval('', '１,２００'), { ok: true, lowerPrice: null, upperPrice: 1200 });
});

await test('lower must not exceed upper', () => {
  const r = validateInterval('1500', '1200');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'LOWER_ABOVE_UPPER');
  assert.equal(validateInterval('1200', '1200').ok, true, 'equal bounds are a valid interval');
});

await test('absurd amounts are capped', () => {
  assert.equal(validateInterval('', String(MAX_ALERT_PRICE + 1)).code, 'TOO_LARGE');
  assert.equal(parsePriceField(String(MAX_ALERT_PRICE)).value, MAX_ALERT_PRICE);
});

await test('an omitted lower bound means "no floor"; both ends are inclusive', () => {
  assert.equal(isPriceInInterval(1, null, 1200), true);
  assert.equal(isPriceInInterval(1200, 800, 1200), true);
  assert.equal(isPriceInInterval(800, 800, 1200), true);
  assert.equal(isPriceInInterval(1201, 800, 1200), false);
  assert.equal(isPriceInInterval(null, null, 1200), false);
});

// ── 2. Range entry / below-lower / above-upper ──────────────────────────────
await test('status reflects entry, below-lower and above-upper', () => {
  const alert = alertOf({ lowerPrice: 800, upperPrice: 1200 });
  assert.equal(evaluateAlertStatus(alert, { price: 1000, currency: 'JPY' }), 'IN_RANGE');
  assert.equal(evaluateAlertStatus(alert, { price: 500, currency: 'JPY' }), 'BELOW_RANGE');
  assert.equal(evaluateAlertStatus(alert, { price: 5000, currency: 'JPY' }), 'ABOVE_RANGE');
  assert.equal(evaluateAlertStatus(alert, null), 'UNPRICED');
  assert.equal(evaluateAlertStatus(alert, { price: 1000, currency: 'TWD' }), 'CURRENCY_MISMATCH');
});

await test('a price below the lower bound does NOT fire', () => {
  const alert = alertOf({ lowerPrice: 800, upperPrice: 1200 });
  const result = evaluatePriceAlerts(
    [{ token: TOKEN, alert }],
    () => ({ price: 500, currency: 'JPY' }),
    {},
  );
  assert.equal(result.sends.length, 0, 'below the floor is outside the interval');
});

// ── 3. Exact-version matching ───────────────────────────────────────────────
await test('a PARALLEL price never satisfies a BASE alert (and vice versa)', () => {
  const prices = indexPrices([
    { cardNumber: 'hBP04-005', printing: 'BASE', price: 9800, currency: 'JPY' },
    { cardNumber: 'hBP04-005', printing: 'PARALLEL', price: 900, currency: 'JPY' },
  ]);
  const lookup = (cardNumber, printing) => prices.get(priceAlertKey(cardNumber, printing)) ?? null;

  // The cheap PARALLEL listing must not fire the BASE alert.
  const base = evaluatePriceAlerts([{ token: TOKEN, alert: alertOf() }], lookup, {});
  assert.equal(base.sends.length, 0);

  const parallel = evaluatePriceAlerts(
    [{ token: TOKEN, alert: alertOf({ printing: 'PARALLEL' }) }], lookup, {},
  );
  assert.equal(parallel.sends.length, 1);
  assert.equal(parallel.sends[0].price, 900);
});

await test('a same-name / different card number price never matches', () => {
  const prices = indexPrices([
    { cardNumber: 'hBP01-075', printing: 'BASE', price: 100, currency: 'JPY' },
  ]);
  const result = evaluatePriceAlerts(
    [{ token: TOKEN, alert: alertOf() }],
    (cardNumber, printing) => prices.get(priceAlertKey(cardNumber, printing)) ?? null,
    {},
  );
  assert.equal(result.sends.length, 0);
  assert.equal(result.unpriced, 1);
});

await test('the alert key folds case/width but keeps distinct printings apart', () => {
  assert.equal(priceAlertKey('hBP04-005', ' parallel '), priceAlertKey('hBP04-005', 'PARALLEL'));
  assert.notEqual(priceAlertKey('hBP04-005', 'PARALLEL'), priceAlertKey('hBP04-005', 'PARALLEL/SIGN'));
  assert.notEqual(priceAlertKey('hBP04-005', 'BASE'), priceAlertKey('hBP04-006', 'BASE'));
});

// ── 4. Sell-vs-buy isolation ────────────────────────────────────────────────
await test('a store BUY price can never trigger an alert', () => {
  // The source lists this printing at ¥3,000 to the player; the shop pays ¥900.
  const { priceRecords } = adaptCardNumber([{
    id: 'x', cardNumber: 'hBP04-005', name: 'ラプラス', series: 'hBP04', cardTypeJp: 'ホロメン',
    timestamp: '2026-08-01', prices: [{ name: 'ラプラス', sellPrice: 3000, buyPrice: 900 }],
  }]);
  assert.equal(priceRecords.length, 1);
  assert.equal(priceRecords[0].price, 3000, 'only the player SELL price becomes a price record');

  const prices = indexPrices(priceRecords.map((r) => ({
    cardNumber: r.cardNumber, printing: r.version, price: r.price, currency: r.currency,
  })));
  // The user would happily pay ¥1,000 — above the shop's buy price, below the
  // sell price. Nothing must fire.
  const result = evaluatePriceAlerts(
    [{ token: TOKEN, alert: alertOf({ upperPrice: 1000 }) }],
    (cardNumber, printing) => prices.get(priceAlertKey(cardNumber, printing)) ?? null,
    {},
  );
  assert.equal(result.sends.length, 0);
});

// ── 5. Dedupe + re-arm ──────────────────────────────────────────────────────
await test('one send on entry, none on an unchanged price, re-send after leaving and re-entering', () => {
  const alert = alertOf({ upperPrice: 1200 });
  const recipients = [{ token: TOKEN, alert }];
  const key = armStateKey(TOKEN, alert.cardNumber, alert.printing);
  const at = (price) => () => ({ price, currency: 'JPY' });

  // Run 1 — price enters the interval: exactly one send.
  let states = {};
  const run1 = evaluatePriceAlerts(recipients, at(1000), states);
  assert.equal(run1.sends.length, 1, 'entry must notify once');
  assert.equal(run1.sends[0].stateKey, key);
  // The endpoint disarms only on a confirmed Expo ticket.
  states = { [key]: { armed: false, lastNotifiedAt: 1, lastPrice: 1000 } };

  // Run 2 — same price, still in range: silent.
  const run2 = evaluatePriceAlerts(recipients, at(1000), states);
  assert.equal(run2.sends.length, 0, 'unchanged price must not notify again');
  assert.equal(run2.skipped, 1);
  assert.deepEqual(run2.rearm, [], 'staying in range must not re-arm');

  // Run 3 — a cheaper price still inside the interval: still silent.
  assert.equal(evaluatePriceAlerts(recipients, at(950), states).sends.length, 0);

  // Run 4 — price leaves the interval: re-arm, but do not notify.
  const run4 = evaluatePriceAlerts(recipients, at(4000), states);
  assert.equal(run4.sends.length, 0);
  assert.deepEqual(run4.rearm, [key], 'leaving the interval re-arms');
  states = { [key]: { armed: true } };

  // Run 5 — price re-enters: notify again.
  assert.equal(evaluatePriceAlerts(recipients, at(1100), states).sends.length, 1);
});

await test('a scrape gap does not re-arm a disarmed alert', () => {
  const alert = alertOf();
  const key = armStateKey(TOKEN, alert.cardNumber, alert.printing);
  const result = evaluatePriceAlerts(
    [{ token: TOKEN, alert }], () => null, { [key]: { armed: false } },
  );
  assert.deepEqual(result.rearm, [], 'a missing price is not "left the interval"');
  assert.equal(result.unpriced, 1);
});

await test('a fresh alert is armed by default and each device is tracked separately', () => {
  const other = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]';
  const alert = alertOf();
  const result = evaluatePriceAlerts(
    [{ token: TOKEN, alert }, { token: other, alert }],
    () => ({ price: 1000, currency: 'JPY' }),
    { [armStateKey(TOKEN, alert.cardNumber, alert.printing)]: { armed: false } },
  );
  assert.equal(result.sends.length, 1, "one device's delivery must not silence another");
  assert.equal(result.sends[0].token, other);
  assert.equal(result.skipped, 1);
});

await test('the push body names the exact version, the price and the interval', () => {
  const [send] = evaluatePriceAlerts(
    [{ token: TOKEN, alert: alertOf({ lowerPrice: 800, upperPrice: 1200 }) }],
    () => ({ price: 1000, currency: 'JPY' }),
    {},
  ).sends;
  const message = buildAlertMessage(send);
  assert.match(message.body, /hBP04-005/);
  assert.match(message.body, /ラプラス・ダークネス/);
  assert.match(message.body, /¥1,000/);
  assert.match(message.body, /¥800 – ¥1,200/);
  assert.equal(formatInterval({ lowerPrice: null, upperPrice: 1200, currency: 'JPY' }), '≤ ¥1,200');
});

// ── 6. Missing / unpriced rows ──────────────────────────────────────────────
await test('an ambiguous printing stays unpriced and offers no alert', () => {
  // Two listings claim the same printing at different prices → fail closed.
  const { cards, priceRecords } = adaptCardNumber([{
    id: 'y', cardNumber: 'hBP03-027', name: '白銀ノエル', series: 'hBP03', cardTypeJp: 'ホロメン',
    timestamp: '2026-08-01',
    prices: [
      { name: '白銀ノエル(パラレル)', sellPrice: 3480 },
      { name: '白銀ノエル(パラレル)', sellPrice: 500 },
    ],
  }]);
  const parallel = cards.find((c) => c.printing === 'PARALLEL');
  assert.ok(parallel);
  assert.equal(resolveExactPrice('hBP03-027', 'PARALLEL', priceRecords).status, 'NO_EXACT_PRICE');

  const deck = { id: 'd', name: 'd', updatedAt: '', oshi: [], main: [{ card: parallel, qty: 2 }], yell: [] };
  const gap = computeGap(deck, {}, priceRecords);
  const row = gap.rows[0];
  assert.equal(row.missing, 2, 'the row is a missing-card row');
  assert.equal(row.price.status, 'NO_EXACT_PRICE', 'and it must be offered no alert price');

  assert.equal(
    evaluateAlertStatus(alertOf({ cardNumber: 'hBP03-027', printing: 'PARALLEL' }), null),
    'UNPRICED',
  );
});

// ── 7. Legacy watchlist migration ───────────────────────────────────────────
await test('a legacy card-number-only watchlist item stays readable and is never promoted', () => {
  resetStores();
  useWatchlistStore.getState().addCard({
    cardNumber: 'hBP01-075', name: 'Legacy', rarity: 'SR',
    addedAt: '2025-01-01T00:00:00.000Z', targetPrice: 500,
  });

  const legacy = useWatchlistStore.getState().items[0];
  assert.equal(legacy.targetPrice, 500, 'legacy target price remains readable');
  assert.deepEqual(usePriceAlertStore.getState().alerts, {}, 'no exact-version alert is invented');
  assert.equal(usePriceAlertStore.getState().getAlert('hBP01-075', 'BASE'), null);
  assert.equal(usePriceAlertStore.getState().getAlert('hBP01-075', ''), null);
});

await test('an alert without a proven printing is refused', () => {
  resetStores();
  const created = usePriceAlertStore.getState().upsertAlert({
    cardNumber: 'hBP01-075', printing: '   ', name: 'x', currency: 'JPY',
    lowerPrice: null, upperPrice: 500,
  });
  assert.equal(created, null);
  assert.deepEqual(usePriceAlertStore.getState().alerts, {});
});

// ── 8. Local persistence ────────────────────────────────────────────────────
await test('an alert persists across reload and an edit overwrites in place', async () => {
  resetStores();
  const store = usePriceAlertStore.getState();
  store.upsertAlert({
    cardNumber: 'hBP04-005', printing: 'base', printingLabel: 'ラプラス',
    name: 'ラプラス', currency: 'JPY', lowerPrice: 800, upperPrice: 1200,
  });

  const key = priceAlertKey('hBP04-005', 'BASE');
  assert.ok(usePriceAlertStore.getState().alerts[key], 'printing is normalized on write');

  const raw = platformStorage.getItem(STORE_KEY);
  assert.ok(raw && raw.includes('hBP04-005'), 'a persisted payload must be written');

  usePriceAlertStore.setState({ alerts: {} });
  platformStorage.setItem(STORE_KEY, raw);
  await usePriceAlertStore.persist.rehydrate();

  const restored = usePriceAlertStore.getState().alerts[key];
  assert.ok(restored, 'alert must survive reload');
  assert.equal(restored.lowerPrice, 800);
  assert.equal(restored.upperPrice, 1200);

  // Editing the same printing updates the record instead of adding a second one.
  usePriceAlertStore.getState().upsertAlert({
    cardNumber: 'hBP04-005', printing: 'BASE', name: 'ラプラス', currency: 'JPY',
    lowerPrice: null, upperPrice: 900,
  });
  assert.equal(Object.keys(usePriceAlertStore.getState().alerts).length, 1);
  assert.equal(usePriceAlertStore.getState().alerts[key].upperPrice, 900);
  assert.equal(usePriceAlertStore.getState().alerts[key].lowerPrice, null);
  assert.equal(usePriceAlertStore.getState().alerts[key].createdAt, restored.createdAt);

  usePriceAlertStore.getState().removeAlert('hBP04-005', ' base ');
  assert.deepEqual(usePriceAlertStore.getState().alerts, {}, 'removal folds the same printing');
});

// ── 9. API validation / security ────────────────────────────────────────────
const validUpsert = {
  token: TOKEN,
  action: 'upsert',
  alert: {
    cardNumber: 'hBP04-005', printing: 'PARALLEL', printingLabel: 'ラプラス(パラレル)',
    name: 'ラプラス', currency: 'JPY', lowerPrice: 800, upperPrice: 1200,
  },
};

await test('a well-formed upsert is accepted and normalized', () => {
  const parsed = parsePriceAlertRequest(validUpsert);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.key, priceAlertKey('hBP04-005', 'PARALLEL'));
  assert.equal(parsed.alert.lowerPrice, 800);
  assert.equal(parsed.alert.upperPrice, 1200);
});

await test('the API rejects bad tokens, actions, currencies and intervals', () => {
  const reject = (patch, why) => {
    const body = JSON.parse(JSON.stringify(validUpsert));
    Object.assign(body, patch.body ?? {});
    if (patch.alert) Object.assign(body.alert, patch.alert);
    const parsed = parsePriceAlertRequest(body);
    assert.equal(parsed.ok, false, why);
    return parsed;
  };

  assert.equal(reject({ body: { token: 'not-a-token' } }, 'bad token').status, 400);
  reject({ body: { token: undefined } }, 'missing token');
  reject({ body: { action: 'drop' } }, 'unknown action');
  reject({ alert: { cardNumber: '' } }, 'empty cardNumber');
  reject({ alert: { cardNumber: 'x'.repeat(200) } }, 'oversized cardNumber');
  reject({ alert: { currency: 'jpy' } }, 'non-ISO currency');
  reject({ alert: { currency: 'JPYY' } }, 'non-ISO currency');
  reject({ alert: { lowerPrice: 1500 } }, 'lower above upper');
  reject({ alert: { upperPrice: -1 } }, 'negative upper');
  reject({ alert: { upperPrice: 12.5 } }, 'fractional upper');
  reject({ alert: { upperPrice: null } }, 'missing upper');
  reject({ alert: { upperPrice: '1200' } }, 'string upper');
  reject({ alert: { upperPrice: MAX_ALERT_PRICE + 1 } }, 'absurd upper');
});

await test('the API refuses a card-number-only alert', () => {
  for (const printing of [undefined, '', '   ']) {
    const body = JSON.parse(JSON.stringify(validUpsert));
    body.alert.printing = printing;
    const parsed = parsePriceAlertRequest(body);
    assert.equal(parsed.ok, false, 'an exact version is mandatory');
    assert.match(parsed.error, /printing/);
  }
});

await test('remove and list need no interval, but still need an exact version', () => {
  const removed = parsePriceAlertRequest({
    token: TOKEN, action: 'remove', alert: { cardNumber: 'hBP04-005', printing: 'base' },
  });
  assert.equal(removed.ok, true);
  assert.equal(removed.key, priceAlertKey('hBP04-005', 'BASE'));

  assert.equal(parsePriceAlertRequest({ token: TOKEN, action: 'list' }).ok, true);
  assert.equal(
    parsePriceAlertRequest({ token: TOKEN, action: 'remove', alert: { cardNumber: 'x' } }).ok,
    false,
  );
});

await test('the price snapshot drops malformed entries and rejects a non-array', () => {
  assert.equal(parsePriceSnapshot(undefined).ok, false);
  assert.equal(parsePriceSnapshot({ 'hBP04-005': 100 }).ok, false);
  const parsed = parsePriceSnapshot([
    { cardNumber: 'hBP04-005', printing: 'BASE', price: 980, currency: 'JPY' },
    { cardNumber: 'hBP04-005', printing: 'BASE', price: -1, currency: 'JPY' },
    { cardNumber: 'hBP04-005', printing: '', price: 980, currency: 'JPY' },
    { cardNumber: 'hBP04-005', printing: 'BASE', price: '980', currency: 'JPY' },
    { cardNumber: 'hBP04-005', printing: 'BASE', price: 980, currency: 'jpy' },
  ]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.prices.length, 1);
});

await test('the internal run endpoint fails closed without the shared secret', () => {
  const withHeader = (value) => new Request('https://example.test/api/push/price-alert-run', {
    method: 'POST',
    headers: value === null ? {} : { 'X-Internal-Secret': value },
  });
  const original = process.env.PUSH_NOTIFY_SECRET;

  delete process.env.PUSH_NOTIFY_SECRET;
  assert.equal(isInternalRequest(withHeader('anything')), false, 'unset secret must reject');

  process.env.PUSH_NOTIFY_SECRET = 's3cret-value';
  assert.equal(isInternalRequest(withHeader(null)), false, 'missing header must reject');
  assert.equal(isInternalRequest(withHeader('s3cret-valu')), false, 'short secret must reject');
  assert.equal(isInternalRequest(withHeader('S3CRET-VALUE')), false, 'wrong secret must reject');
  assert.equal(isInternalRequest(withHeader('s3cret-value')), true);

  if (original === undefined) delete process.env.PUSH_NOTIFY_SECRET;
  else process.env.PUSH_NOTIFY_SECRET = original;
});

console.log(`\n[price-alerts] ${passed} checks passed`);
