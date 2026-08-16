#!/usr/bin/env node
/**
 * DIC-1023 server alert-evaluator end-to-end fixture.
 *
 * Runs the REAL /api/push/price-alerts and /api/push/price-alert-run handlers
 * against an in-memory KV and a stubbed Expo Push API — no credentials, no
 * network. Proves the delivery gate:
 *   - exactly one send when the exact printing's SELL price enters the interval
 *   - no duplicate send while the price stays inside the interval
 *   - a re-send after the price leaves and re-enters
 *   - an explicit user edit re-arms the alert
 *   - a failed Expo ticket does NOT record the alert as notified
 *   - the run endpoint is unauthorized without the shared secret
 *
 * Run: node --experimental-strip-types --import ./scripts/register-kv-mock.mjs \
 *        scripts/test-price-alert-run.mjs
 */
import assert from 'node:assert/strict';
import { resetKv } from './fixtures/kv-mock.mjs';
import runHandler from '../api/push/price-alert-run.ts';
import configHandler from '../api/push/price-alerts.ts';

const SECRET = 'test-internal-secret';
const TOKEN = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

process.env.PUSH_NOTIFY_SECRET = SECRET;

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ── Stubbed Expo Push API ───────────────────────────────────────────────────
let pushes = [];
let ticketStatus = 'ok';

globalThis.fetch = async (url, init) => {
  assert.equal(url, EXPO_PUSH_URL, 'the handler must only call the Expo Push API');
  const batch = JSON.parse(init.body);
  pushes.push(...batch);
  return new Response(
    JSON.stringify({ data: batch.map(() => ({ status: ticketStatus })) }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
};

function post(url, body, headers = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** Assert a 2xx without consuming the body on the happy path. */
async function expectOk(res) {
  if (res.status !== 200) assert.fail(`${res.status}: ${await res.text()}`);
  return res.json();
}

async function saveAlert(alert) {
  return expectOk(await configHandler(post('https://x.test/api/push/price-alerts', {
    token: TOKEN, action: 'upsert', alert,
  })));
}

/** One evaluator cycle at the given exact-version SELL price. */
async function runAt(price, printing = 'BASE') {
  pushes = [];
  const res = await runHandler(post(
    'https://x.test/api/push/price-alert-run',
    { prices: [{ cardNumber: 'hBP04-005', printing, price, currency: 'JPY' }] },
    { 'X-Internal-Secret': SECRET },
  ));
  return { body: await expectOk(res), pushes };
}

const BASE_ALERT = {
  cardNumber: 'hBP04-005',
  printing: 'BASE',
  printingLabel: 'ラプラス・ダークネス',
  name: 'ラプラス・ダークネス',
  currency: 'JPY',
  lowerPrice: 800,
  upperPrice: 1200,
};

// ── Delivery gate: one send, no duplicate, re-send after re-entry ───────────
await test('entry sends once, unchanged price is silent, re-entry sends again', async () => {
  resetKv();
  ticketStatus = 'ok';
  await saveAlert(BASE_ALERT);

  // Above the interval: nothing.
  const high = await runAt(5000);
  assert.equal(high.body.sent, 0);
  assert.equal(high.pushes.length, 0);

  // Enters the interval: exactly one push, naming the exact printing.
  const entry = await runAt(1000);
  assert.equal(entry.body.sent, 1);
  assert.equal(entry.pushes.length, 1);
  assert.equal(entry.pushes[0].to, TOKEN);
  assert.equal(entry.pushes[0].data.printing, 'BASE');
  assert.equal(entry.pushes[0].data.price, 1000);
  assert.match(entry.pushes[0].body, /¥1,000/);

  // Unchanged price, still in range: no duplicate.
  const again = await runAt(1000);
  assert.equal(again.body.sent, 0);
  assert.equal(again.body.skipped, 1);
  assert.equal(again.pushes.length, 0);

  // A different price inside the interval is still the same visit.
  assert.equal((await runAt(900)).pushes.length, 0);

  // Leaves the interval: re-arm, still silent.
  const left = await runAt(4000);
  assert.equal(left.body.sent, 0);
  assert.equal(left.body.rearmed, 1);
  assert.equal(left.pushes.length, 0);

  // Re-enters: sends again.
  const reentry = await runAt(1100);
  assert.equal(reentry.body.sent, 1);
  assert.equal(reentry.pushes.length, 1);
});

await test('a price below the lower bound never sends', async () => {
  resetKv();
  ticketStatus = 'ok';
  await saveAlert(BASE_ALERT);
  const below = await runAt(500);
  assert.equal(below.body.sent, 0);
  assert.equal(below.pushes.length, 0);
});

await test('another printing of the same card number never triggers the alert', async () => {
  resetKv();
  ticketStatus = 'ok';
  await saveAlert(BASE_ALERT);
  const parallel = await runAt(1000, 'PARALLEL');
  assert.equal(parallel.body.sent, 0);
  assert.equal(parallel.body.unpriced, 1, 'the BASE alert has no comparable price this run');
  assert.equal(parallel.pushes.length, 0);
});

await test('an explicit edit re-arms an already-notified alert', async () => {
  resetKv();
  ticketStatus = 'ok';
  await saveAlert(BASE_ALERT);
  assert.equal((await runAt(1000)).body.sent, 1);
  assert.equal((await runAt(1000)).body.sent, 0);

  // The user widens the interval — the same price must notify once more.
  await saveAlert({ ...BASE_ALERT, lowerPrice: null, upperPrice: 1500 });
  const afterEdit = await runAt(1000);
  assert.equal(afterEdit.body.sent, 1);
  assert.equal(afterEdit.pushes.length, 1);
});

await test('a failed Expo ticket leaves the alert armed for the next run', async () => {
  resetKv();
  await saveAlert(BASE_ALERT);

  ticketStatus = 'error';
  const failed = await runAt(1000);
  assert.equal(failed.body.sent, 0);
  assert.equal(failed.body.errors, 1);

  ticketStatus = 'ok';
  const retried = await runAt(1000);
  assert.equal(retried.body.sent, 1, 'a failed delivery must not be recorded as notified');
});

await test('removing the alert stops the pushes and clears the registry', async () => {
  resetKv();
  ticketStatus = 'ok';
  await saveAlert(BASE_ALERT);

  const removed = await configHandler(post('https://x.test/api/push/price-alerts', {
    token: TOKEN, action: 'remove', alert: { cardNumber: 'hBP04-005', printing: 'base' },
  }));
  assert.equal(removed.status, 200);
  assert.deepEqual((await removed.json()).alerts, []);

  const after = await runAt(1000);
  assert.equal(after.body.sent, 0);
  assert.equal(after.pushes.length, 0);
});

// ── Security ────────────────────────────────────────────────────────────────
await test('the run endpoint rejects a request without the shared secret', async () => {
  resetKv();
  await saveAlert(BASE_ALERT);
  pushes = [];

  const noSecret = await runHandler(post('https://x.test/api/push/price-alert-run', { prices: [] }));
  assert.equal(noSecret.status, 401);

  const wrongSecret = await runHandler(post(
    'https://x.test/api/push/price-alert-run', { prices: [] }, { 'X-Internal-Secret': 'nope' },
  ));
  assert.equal(wrongSecret.status, 401);
  assert.equal(pushes.length, 0);
});

await test('the config endpoint rejects a malformed alert before touching KV', async () => {
  resetKv();
  const res = await configHandler(post('https://x.test/api/push/price-alerts', {
    token: TOKEN, action: 'upsert', alert: { ...BASE_ALERT, printing: '' },
  }));
  assert.equal(res.status, 400);

  const listed = await configHandler(post('https://x.test/api/push/price-alerts', {
    token: TOKEN, action: 'list',
  }));
  assert.deepEqual((await listed.json()).alerts, []);
});

console.log(`\n[price-alert-run] ${passed} checks passed`);
