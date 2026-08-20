#!/usr/bin/env node
/**
 * DIC-1087 — the alerts page, driven end to end.
 *
 * The page used to carry two overlapping features: exact-version 到價提醒 and a
 * card-number 趨勢追蹤 list. This renders the REAL screen through
 * react-native-web against the REAL shipped catalog, at the production origin,
 * and walks one alert through its whole life: a legacy tracking row arrives,
 * the user is asked which printing it means, the alert is created, edited,
 * survives a reload, triggers exactly one notification when the exact version's
 * price enters the interval, and is removed.
 *
 * Throughout, the page must show ONE alerts section and never the second
 * feature's name, at desktop and at mobile width.
 *
 * Run: npm run test:alert-unification-e2e
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

// The DOM must exist before react-native-web is imported: its StyleSheet
// installs a real style element at module-evaluation time.
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

const rawDb = JSON.parse(fs.readFileSync('public/data/database.json', 'utf8'));

// The screen loads its catalog over fetch(). Serve the shipped file so the render
// path is unchanged — and so any OTHER request the page makes is a failure.
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : String(input?.url ?? input);
  assert.equal(url, '/data/database.json', `unexpected fetch during render: ${url}`);
  return { ok: true, json: async () => rawDb };
};

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { SafeAreaProvider } = await import('react-native-safe-area-context');
const WatchlistScreen = (await import('../src/screens/WatchlistScreen.tsx')).default;
const { usePriceAlertStore } = await import('../src/stores/priceAlertStore.ts');
const { useWatchlistStore } = await import('../src/stores/watchlistStore.ts');
const platformStorage = (await import('../src/stores/storage.ts')).default;
const {
  evaluatePriceAlerts, priceAlertKey, buildAlertMessage,
} = await import('../src/utils/priceAlerts.ts');

const ALERT_KEY = 'hunterCard-price-alerts';
const LEGACY_KEY = 'watchlist-storage';
const TOKEN = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';

/**
 * The second feature's vocabulary. Pinned as literals rather than imported from
 * the app, so deleting a constant cannot quietly empty this list — a re-added
 * section is caught by its words, wherever they come from.
 */
const FORBIDDEN_COPY = ['趨勢追蹤', '追蹤清單', '加入追蹤', '目標價格提醒'];

// The real card the two features disagreed about: one card number, three
// printings, ¥980 / ¥9,980 / ¥69,800. Guessing any of them for the user would be
// an alert about a different physical card.
const CARD_NUMBER = 'hBP04-005';
const CHOSEN_PRINTING = 'PARALLEL';
const CHOSEN_LABEL = 'ラプラス・ダークネス(パラレル)';
const CHOSEN_PRICE = 9980;
const SHARED_SIGNED_IMAGE = 'https://hololive-official-cardgame.com/wp-content/images/cardlist/hBP04/hBP04-005_SEC.png';
const OTHER_PRINTING = 'BASE';

const DESKTOP = { width: 1280, height: 900 };
const MOBILE = { width: 390, height: 844 };

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ── Harness ─────────────────────────────────────────────────────────────────
/** react-native-web's Dimensions reads documentElement.clientWidth (jsdom has no
 *  layout, so it otherwise reports 0 and every render is silently the mobile one). */
function setViewport({ width, height }) {
  const docEl = dom.window.document.documentElement;
  Object.defineProperty(docEl, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(docEl, 'clientHeight', { value: height, configurable: true });
  dom.window.dispatchEvent(new dom.window.Event('resize'));
}

const navigation = { navigate: () => {} };

async function render(viewport = DESKTOP) {
  setViewport(viewport);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(SafeAreaProvider, null, React.createElement(WatchlistScreen, { navigation })),
    );
  });
  // The screen loads its catalog in an effect; let that promise settle.
  await act(async () => { await Promise.resolve(); });
  const cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { container, cleanup };
}

/** The editor is a Modal, which react-native-web renders through a portal onto
 *  document.body — so every query runs against the whole document. */
const byTestId = (testID) => document.querySelector(`[data-testid="${testID}"]`);
const allByTestId = (testID) => Array.from(document.querySelectorAll(`[data-testid="${testID}"]`));

async function press(testID) {
  const el = byTestId(testID);
  assert.ok(el, `expected a pressable "${testID}" on screen`);
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

/** react-native-web renders TextInput as a real <input>; React only sees the
 *  change when the value is set through the native setter. */
async function type(testID, value) {
  const el = byTestId(testID);
  assert.ok(el, `expected an input "${testID}" on screen`);
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}

/** The page-level contract, asserted after every step: one alerts feature. */
function assertSingleAlertsFeature() {
  const text = document.body.textContent;
  const sections = allByTestId('price-alert-section');
  const empty = allByTestId('price-alert-empty');
  assert.equal(
    sections.length + empty.length, 1,
    `exactly one alerts section must exist, found ${sections.length} lists and ${empty.length} empty states`,
  );
  assert.ok(text.includes('到價提醒'), 'the one feature must be named on screen');
  for (const phrase of FORBIDDEN_COPY) {
    assert.ok(!text.includes(phrase), `the page must no longer say "${phrase}"`);
  }
  // Requirement 8: an unavailable price reads as words, not placeholder clutter.
  assert.ok(!text.includes('—'), 'no — placeholder clutter');
}

const alertState = () => usePriceAlertStore.getState();
const storedAlert = () => alertState().alerts[priceAlertKey(CARD_NUMBER, CHOSEN_PRINTING)];

function reset() {
  usePriceAlertStore.setState({ alerts: {}, pending: {} });
  useWatchlistStore.setState({ items: [] });
  platformStorage.removeItem(ALERT_KEY);
  platformStorage.removeItem(LEGACY_KEY);
}

// ── 1. Empty ────────────────────────────────────────────────────────────────
await test('an empty page offers one feature and names it 到價提醒', async () => {
  reset();
  const { container, cleanup } = await render();
  try {
    assert.ok(byTestId('price-alert-empty'), 'the empty state renders');
    assert.ok(container.textContent.includes('還沒有到價提醒'));
    assertSingleAlertsFeature();
  } finally {
    await cleanup();
  }
});

// ── 2. A legacy tracking row arrives ────────────────────────────────────────
await test('a legacy card-number row is folded in as a request, not a guess', async () => {
  reset();
  useWatchlistStore.setState({
    items: [{
      cardNumber: CARD_NUMBER,
      name: 'ラプラス・ダークネス',
      nameZh: '拉普拉斯·達克尼斯',
      addedAt: '2025-06-01T00:00:00.000Z',
      targetPrice: 12000,
    }],
  });

  const { cleanup } = await render();
  try {
    assert.deepEqual(useWatchlistStore.getState().items, [], 'the old list is emptied once imported');
    assert.ok(byTestId(`price-alert-pending-${CARD_NUMBER}`), 'the row stays visible, as a prompt');
    assert.deepEqual(
      Object.keys(alertState().alerts), [],
      'a three-printing card number must NOT be promoted to an alert on its own',
    );
    assert.ok(document.body.textContent.includes('需選擇版本'));
    assert.ok(
      document.body.textContent.includes('12,000'),
      'the old target price is carried over as a suggestion, not lost',
    );
    assertSingleAlertsFeature();
  } finally {
    await cleanup();
  }
});

// ── 3. Create ───────────────────────────────────────────────────────────────
await test('answering the prompt creates one alert on the exact chosen printing', async () => {
  reset();
  useWatchlistStore.setState({
    items: [{ cardNumber: CARD_NUMBER, name: 'ラプラス・ダークネス', addedAt: '2025-06-01T00:00:00.000Z', targetPrice: 12000 }],
  });
  const { container, cleanup } = await render();
  try {
    await press(`price-alert-resolve-${CARD_NUMBER}`);
    assert.ok(byTestId('price-alert-editor'), 'the one editor opens');
    assert.ok(byTestId('price-alert-printing-choices'), 'and asks which printing');
    assert.equal(
      byTestId('price-alert-printing-choices').querySelectorAll('[data-testid^="price-alert-printing-"]').length,
      3, 'all three real printings of this card number are offered',
    );

    // Saving without choosing must be refused rather than defaulted.
    await press('price-alert-save');
    assert.ok(byTestId('price-alert-error'), 'no printing → no alert');
    assert.deepEqual(Object.keys(alertState().alerts), []);

    await press(`price-alert-printing-${CHOSEN_PRINTING}`);
    await type('price-alert-lower', '8000');
    await type('price-alert-upper', '12000');
    await press('price-alert-save');

    assert.equal(byTestId('price-alert-editor'), null, 'the editor closes on save');
    const alert = storedAlert();
    assert.ok(alert, 'the alert is stored under the exact printing');
    assert.equal(alert.printing, CHOSEN_PRINTING);
    assert.equal(alert.printingLabel, CHOSEN_LABEL);
    assert.equal(alert.lowerPrice, 8000);
    assert.equal(alert.upperPrice, 12000);
    assert.equal(alert.currency, 'JPY');
    assert.deepEqual(alertState().pending, {}, 'the prompt is answered and gone');

    const row = byTestId(`price-alert-row-${CARD_NUMBER}|${CHOSEN_PRINTING}`);
    assert.ok(row, 'the row renders');
    assert.ok(row.textContent.includes(CARD_NUMBER));
    assert.ok(row.textContent.includes(CHOSEN_LABEL), 'the exact printing is named on the row');
    assert.ok(row.textContent.includes('9,980'), 'the exact version current sell price');
    assert.ok(row.textContent.includes('已進入期望區間'), '¥9,980 is inside 8000–12000');
    assert.equal(
      allByTestId(`price-alert-row-${CARD_NUMBER}|${OTHER_PRINTING}`).length, 0,
      'no sibling printing was alerted on',
    );
    assert.equal(container.querySelectorAll('[data-testid^="price-alert-row-"]').length, 1, 'exactly one row');
    assertSingleAlertsFeature();
  } finally {
    await cleanup();
  }
});

// ── 4. Image identity ───────────────────────────────────────────────────────
await test('an unproven shared SEC image renders the stable placeholder', async () => {
  const { container, cleanup } = await render();
  try {
    const row = byTestId(`price-alert-row-${CARD_NUMBER}|${CHOSEN_PRINTING}`);
    assert.ok(
      row.querySelector(`[data-testid="price-alert-thumb-placeholder-${CARD_NUMBER}"]`),
      'the row shows the stable card-number placeholder',
    );
    const img = row.querySelector('img') ?? row.querySelector('[style*="background-image"]');
    assert.equal(img, null, 'no unproven printing art is rendered');
    assert.ok(!row.innerHTML.includes(SHARED_SIGNED_IMAGE), 'PARALLEL never borrows signed SEC art');
    assert.equal(storedAlert().imageUrl, undefined, 'the unproven image is not persisted');
  } finally {
    await cleanup();
  }
});

// ── 5. Edit ─────────────────────────────────────────────────────────────────
await test('editing the range overwrites the same alert in place', async () => {
  const { container, cleanup } = await render();
  try {
    await press(`price-alert-edit-${CARD_NUMBER}|${CHOSEN_PRINTING}`);
    assert.ok(byTestId('price-alert-editor'));
    assert.equal(byTestId('price-alert-printing-choices'), null, 'a settled alert is not re-asked its printing');

    // min > max must be refused, and must not damage the stored range.
    await type('price-alert-lower', '9000');
    await type('price-alert-upper', '500');
    await press('price-alert-save');
    assert.ok(byTestId('price-alert-error'), 'lower above upper is rejected');
    assert.equal(storedAlert().upperPrice, 12000, 'the configured range is untouched');

    await type('price-alert-lower', '');
    await type('price-alert-upper', '5000');
    await press('price-alert-save');

    const alert = storedAlert();
    assert.equal(alert.lowerPrice, null);
    assert.equal(alert.upperPrice, 5000);
    assert.equal(Object.keys(alertState().alerts).length, 1, 'edited in place, not duplicated');
    assert.equal(container.querySelectorAll('[data-testid^="price-alert-row-"]').length, 1);
    assert.ok(
      byTestId(`price-alert-status-${CARD_NUMBER}|${CHOSEN_PRINTING}`).textContent.includes('高於期望上限'),
      '¥9,980 is now above the ¥5,000 ceiling',
    );
    assertSingleAlertsFeature();
  } finally {
    await cleanup();
  }
});

// ── 6. Reload ───────────────────────────────────────────────────────────────
await test('the alert comes back unchanged after a reload', async () => {
  const raw = platformStorage.getItem(ALERT_KEY);
  assert.ok(raw, 'the alert must reach persistent storage');
  usePriceAlertStore.setState({ alerts: {}, pending: {} });
  platformStorage.setItem(ALERT_KEY, raw);
  await usePriceAlertStore.persist.rehydrate();

  const { container, cleanup } = await render();
  try {
    const alert = storedAlert();
    assert.ok(alert, 'the alert survives');
    assert.equal(alert.upperPrice, 5000);
    assert.equal(alert.printing, CHOSEN_PRINTING);
    assert.equal(container.querySelectorAll('[data-testid^="price-alert-row-"]').length, 1, 'still exactly one row');
    assertSingleAlertsFeature();
  } finally {
    await cleanup();
  }
});

// ── 7. Trigger ──────────────────────────────────────────────────────────────
await test('the alert fires once when the exact version enters the interval', async () => {
  // Widen the interval through the UI so it covers the real ¥9,980 listing.
  const { cleanup } = await render();
  try {
    await press(`price-alert-edit-${CARD_NUMBER}|${CHOSEN_PRINTING}`);
    await type('price-alert-lower', '8000');
    await type('price-alert-upper', '12000');
    await press('price-alert-save');
    assert.ok(
      byTestId(`price-alert-status-${CARD_NUMBER}|${CHOSEN_PRINTING}`).textContent.includes('已進入期望區間'),
      'the page says the alert is in range',
    );
  } finally {
    await cleanup();
  }

  // Same stored alert, same exact-version price, through the push evaluator.
  const alert = storedAlert();
  const priceOf = (cardNumber, printing) =>
    cardNumber === CARD_NUMBER && printing === CHOSEN_PRINTING
      ? { price: CHOSEN_PRICE, currency: 'JPY' }
      : null;
  const recipients = [{ token: TOKEN, alert }];

  const first = evaluatePriceAlerts(recipients, priceOf, {});
  assert.equal(first.sends.length, 1, 'entering the interval notifies');
  const { title, body } = buildAlertMessage(first.sends[0]);
  assert.ok(title.startsWith('到價提醒：'), `the push says 到價提醒, got: ${title}`);
  assert.ok(body.includes(CHOSEN_LABEL), 'and names the exact printing');
  for (const phrase of FORBIDDEN_COPY) {
    assert.ok(!`${title}${body}`.includes(phrase), `the push must not say "${phrase}"`);
  }

  const states = { [first.sends[0].stateKey]: { armed: false, lastNotifiedAt: 1, lastPrice: CHOSEN_PRICE } };
  assert.equal(evaluatePriceAlerts(recipients, priceOf, states).sends.length, 0, 'still in range → no second push');
  assert.equal(
    evaluatePriceAlerts(recipients, () => null, states).sends.length, 0,
    'a scrape gap notifies nothing',
  );
  assert.deepEqual(
    evaluatePriceAlerts(recipients, () => null, states).rearm, [],
    'and a scrape gap must not re-arm an alert that never left range',
  );

  const left = evaluatePriceAlerts(recipients, () => ({ price: 20000, currency: 'JPY' }), states);
  assert.deepEqual(left.rearm, [first.sends[0].stateKey], 'leaving the interval re-arms');
  assert.equal(
    evaluatePriceAlerts(recipients, priceOf, {}).sends.length, 1,
    're-entry notifies again',
  );
});

// ── 8. Responsive ───────────────────────────────────────────────────────────
for (const [label, viewport] of [['desktop', DESKTOP], ['mobile', MOBILE]]) {
  await test(`the one section renders at ${label} width`, async () => {
    const { container, cleanup } = await render(viewport);
    try {
      const row = byTestId(`price-alert-row-${CARD_NUMBER}|${CHOSEN_PRINTING}`);
      assert.ok(row, 'the alert row renders');
      assert.ok(row.textContent.includes(CHOSEN_LABEL));
      assert.ok(row.textContent.includes('9,980'));
      assert.equal(container.querySelectorAll('[data-testid^="price-alert-row-"]').length, 1);
      assertSingleAlertsFeature();
    } finally {
      await cleanup();
    }
  });
}

// ── 9. Unavailable price ────────────────────────────────────────────────────
await test('an alert whose printing has no price reads cleanly', async () => {
  usePriceAlertStore.getState().upsertAlert({
    cardNumber: 'hZZ99-999',
    printing: 'FOIL',
    printingLabel: 'テスト(箔押し)',
    name: '未上架版本',
    currency: 'JPY',
    lowerPrice: null,
    upperPrice: 300,
  });
  const { cleanup } = await render();
  try {
    const status = byTestId('price-alert-status-hZZ99-999|FOIL');
    assert.ok(status, 'the row still renders');
    assert.ok(status.textContent.includes('暫無資料'), `got: ${status.textContent}`);
    assertSingleAlertsFeature();
  } finally {
    await cleanup();
    usePriceAlertStore.getState().removeAlert('hZZ99-999', 'FOIL');
  }
});

// ── 10. Remove ──────────────────────────────────────────────────────────────
await test('removing the alert empties the one section', async () => {
  const confirms = [];
  dom.window.confirm = (message) => { confirms.push(message); return true; };
  const { cleanup } = await render();
  try {
    await press(`price-alert-delete-${CARD_NUMBER}|${CHOSEN_PRINTING}`);
    assert.equal(confirms.length, 1, 'removal is confirmed first');
    assert.ok(confirms[0].includes('移除到價提醒'));
    assert.deepEqual(alertState().alerts, {}, 'the alert is gone');
    assert.ok(byTestId('price-alert-empty'), 'the page falls back to the empty state');
    assertSingleAlertsFeature();
  } finally {
    await cleanup();
  }

  // …and stays gone across a reload.
  const raw = platformStorage.getItem(ALERT_KEY);
  usePriceAlertStore.setState({ alerts: {}, pending: {} });
  platformStorage.setItem(ALERT_KEY, raw);
  await usePriceAlertStore.persist.rehydrate();
  assert.deepEqual(alertState().alerts, {}, 'the removal persisted');
});

console.log(`\n[alert-unification-e2e] ${passed} tests passed`);
