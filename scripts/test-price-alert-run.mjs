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
 *   - two OVERLAPPING runs make exactly one Expo call for one armed alert
 *   - an edit landing mid-send cannot hand a second evaluator the same send
 *   - a stale lease owner cannot clean up or commit after a takeover
 *   - an unconfirmed or crashed send releases/expires its claim so it retries
 *   - the run endpoint is unauthorized without the shared secret
 *
 * Run: node --experimental-strip-types --import ./scripts/register-kv-mock.mjs \
 *        scripts/test-price-alert-run.mjs
 */
import assert from 'node:assert/strict';
import { resetKv, advanceKvClock } from './fixtures/kv-mock.mjs';
import runHandler from '../api/push/price-alert-run.ts';
import configHandler from '../api/push/price-alerts.ts';
import {
  claimAlertSend, releaseAlertClaim, commitAlertClaim, ALERT_CLAIM_LEASE_MS,
} from '../api/_lib/kv-storage.ts';
import { armStateKey } from '../src/utils/priceAlerts.ts';

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
/** Every `ok` ticket Expo has handed back, across every run in a test. */
let okTickets = 0;
let ticketStatus = 'ok';
/** When set, the stub parks inside the Expo call until the test releases it. */
let expoGate = null;
/** When set, replaces the happy-path ticket response. */
let expoRespond = null;

globalThis.fetch = async (url, init) => {
  assert.equal(url, EXPO_PUSH_URL, 'the handler must only call the Expo Push API');
  const batch = JSON.parse(init.body);
  pushes.push(...batch);
  if (expoGate) await expoGate.promise;
  if (expoRespond) return expoRespond(batch);
  if (ticketStatus === 'ok') okTickets += batch.length;
  return new Response(
    JSON.stringify({ data: batch.map(() => ({ status: ticketStatus })) }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
};

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/** Yield to the event loop until `predicate()` holds. */
async function waitFor(predicate, what) {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  assert.fail(`timed out waiting for ${what}`);
}

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

/** Fire the evaluator without waiting for it — used to overlap two runs. */
function startRun(price, printing = 'BASE') {
  return runHandler(post(
    'https://x.test/api/push/price-alert-run',
    { prices: [{ cardNumber: 'hBP04-005', printing, price, currency: 'JPY' }] },
    { 'X-Internal-Secret': SECRET },
  ));
}

/** One evaluator cycle at the given exact-version SELL price. */
async function runAt(price, printing = 'BASE') {
  pushes = [];
  const res = await startRun(price, printing);
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

// ── Concurrency: the atomic send claim (DIC-1025) ───────────────────────────
await test('two overlapping runs make exactly one Expo call for one armed alert', async () => {
  resetKv();
  ticketStatus = 'ok';
  await saveAlert(BASE_ALERT);

  pushes = [];
  // Park whichever run wins inside the Expo call. The other run therefore does
  // its whole evaluation — and finishes — while the disarm provably has not
  // been written yet, which is exactly the window that used to double-send.
  const gate = deferred();
  expoGate = gate;

  let settled = 0;
  const track = (p) => p.then((res) => { settled += 1; return res; });
  const runs = [track(startRun(1000)), track(startRun(1000))];

  await waitFor(
    // Either the loser finished while the winner is parked (correct), or both
    // runs reached Expo (the DIC-1025 double-send) — release the gate for both
    // so the assertions below report the real outcome instead of timing out.
    () => pushes.length >= 2 || (pushes.length > 0 && settled > 0),
    'the second run to either lose the claim or reach the Expo Push API',
  );
  gate.resolve();
  expoGate = null;

  const bodies = await Promise.all(runs.map(async (p) => expectOk(await p)));
  const total = (field) => bodies.reduce((sum, body) => sum + body[field], 0);

  assert.equal(pushes.length, 1, 'only one runner may call Expo for the same armed alert');
  assert.equal(total('sent'), 1, 'exactly one run may report the send');
  assert.equal(total('contended'), 1, 'the losing run must report a lost claim');

  // The episode is over: the alert stays silent until the price leaves.
  const after = await runAt(1000);
  assert.equal(after.body.sent, 0);
  assert.equal(after.pushes.length, 0);

  // ...and a genuine re-entry still fires, so the claim did not wedge it.
  assert.equal((await runAt(4000)).body.rearmed, 1);
  assert.equal((await runAt(1000)).body.sent, 1);
});

await test('an edit landing mid-send cannot hand a second evaluator the same send', async () => {
  resetKv();
  ticketStatus = 'ok';
  await saveAlert(BASE_ALERT);

  pushes = [];
  okTickets = 0;

  // Runner A wins the claim and parks inside its Expo call, so the alert is
  // visible and still armed to everyone else while a send is genuinely in
  // flight — the window an edit used to reopen.
  const gate = deferred();
  expoGate = gate;
  const runA = startRun(1000);
  await waitFor(() => pushes.length === 1, 'the first runner to reach the Expo Push API');

  // The user edits the alert mid-send. Publishing the new alert and retiring
  // the old episode is one atomic transition, and it may only supersede A's
  // live claim — freeing it is what let a second evaluator send again.
  await saveAlert({ ...BASE_ALERT, lowerPrice: 700, upperPrice: 1300 });

  // A second evaluator now sees the edited alert and must find it claimed.
  let settledB = false;
  const runB = startRun(1000).then((res) => { settledB = true; return res; });
  await waitFor(
    // Either B lost the claim (correct), or the edit freed it and B reached
    // Expo — release the gate for both so the assertions report the real
    // outcome instead of deadlocking behind the parked runner.
    () => settledB || pushes.length >= 2,
    'the second evaluator to either lose the claim or reach the Expo Push API',
  );
  gate.resolve();
  expoGate = null;

  const bodyB = await expectOk(await runB);
  const bodyA = await expectOk(await runA);

  assert.equal(pushes.length, 1, 'an edit must not hand a second runner the same send');
  assert.equal(bodyB.sent, 0);
  assert.equal(bodyB.contended, 1, 'the edited alert must still be claimed by the runner mid-send');
  assert.equal(okTickets, 1, 'exactly one successful ticket for the whole interleave');
  assert.equal(bodyA.sent, 1);
  assert.equal(bodyA.superseded, 1, "A delivered for the episode the edit replaced, so it cannot disarm");

  // The edit re-armed the alert, so the new interval notifies once — the
  // superseded claim must not have wedged it.
  const afterEdit = await runAt(1000);
  assert.equal(afterEdit.body.sent, 1);
  assert.equal(afterEdit.pushes.length, 1);
});

await test('a stale lease owner cannot clean up or commit after a takeover', async () => {
  resetKv();
  ticketStatus = 'ok';
  await saveAlert(BASE_ALERT);

  pushes = [];
  okTickets = 0;

  // A runner takes the claim and then stalls past its lease.
  const stateKey = armStateKey(TOKEN, BASE_ALERT.cardNumber, BASE_ALERT.printing);
  const stale = await claimAlertSend(stateKey);
  assert.ok(stale, 'the first claim must win');
  advanceKvClock(ALERT_CLAIM_LEASE_MS + 1);

  // The next run takes the episode over and delivers it.
  assert.equal((await expectOk(await startRun(1000))).sent, 1);
  assert.equal(pushes.length, 1);
  assert.equal(okTickets, 1);

  // The stalled runner finally wakes up. Both of its cleanup paths are fenced
  // by the owner it was handed, so neither can touch the episode that now
  // belongs to somebody else.
  await releaseAlertClaim(stateKey, stale);
  assert.equal(await commitAlertClaim(stateKey, stale, Date.now(), 999), 'superseded');

  const after = await runAt(1000);
  assert.equal(after.body.sent, 0, 'a stale owner must not re-arm an alert that was just delivered');
  assert.equal(after.pushes.length, 0);
  assert.equal(okTickets, 1, 'exactly one successful ticket across the takeover');
});

await test('a whole-batch Expo failure releases the claim for the next run', async () => {
  resetKv();
  ticketStatus = 'ok';
  await saveAlert(BASE_ALERT);

  expoRespond = () => new Response('upstream unavailable', { status: 502 });
  const failed = await runAt(1000);
  assert.equal(failed.body.sent, 0);
  assert.equal(failed.body.errors, 1);

  expoRespond = null;
  const retried = await runAt(1000);
  assert.equal(retried.body.sent, 1, 'a transport failure must not leave the alert claimed');
});

await test('an unconfirmed send releases the claim so the next run retries', async () => {
  resetKv();
  ticketStatus = 'ok';
  await saveAlert(BASE_ALERT);

  // 200 with no per-message tickets: delivery is not confirmed.
  expoRespond = () => Response.json({});
  assert.equal((await runAt(1000)).body.sent, 1);

  expoRespond = null;
  const retried = await runAt(1000);
  assert.equal(retried.body.sent, 1, 'an unconfirmed delivery must stay armed and unclaimed');
});

await test('a crashed run only suppresses the alert until its lease expires', async () => {
  resetKv();
  ticketStatus = 'ok';
  await saveAlert(BASE_ALERT);

  // A runner that took the claim and then died: nothing ever released it.
  const stateKey = armStateKey(TOKEN, BASE_ALERT.cardNumber, BASE_ALERT.printing);
  assert.ok(await claimAlertSend(stateKey));

  const blocked = await runAt(1000);
  assert.equal(blocked.body.sent, 0);
  assert.equal(blocked.body.contended, 1);
  assert.equal(blocked.pushes.length, 0);

  advanceKvClock(ALERT_CLAIM_LEASE_MS + 1);
  const recovered = await runAt(1000);
  assert.equal(recovered.body.sent, 1, 'the lease must expire so a crash cannot silence an alert');
  assert.equal(recovered.pushes.length, 1);
});

await test('a delivered alert stays silent long after the lease window passes', async () => {
  resetKv();
  ticketStatus = 'ok';
  await saveAlert(BASE_ALERT);
  assert.equal((await runAt(1000)).body.sent, 1);

  // The claim of a confirmed send carries no TTL, so lease expiry can never
  // resurrect it into a second notification.
  advanceKvClock(ALERT_CLAIM_LEASE_MS * 10);
  const later = await runAt(1000);
  assert.equal(later.body.sent, 0);
  assert.equal(later.pushes.length, 0);
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
