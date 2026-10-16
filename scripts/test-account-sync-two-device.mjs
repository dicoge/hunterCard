#!/usr/bin/env node
/**
 * v41 (2026-10-17): the same Google account on two phones, offline and synthetic.
 *
 * The REAL api/auth/[action] sync handler + account-sync-store run on 127.0.0.1 over
 * the in-memory KV emulation (scripts/fixtures/account-sync-server.cjs). Each phone
 * is its own Node process (scripts/fixtures/account-sync-device.mjs) with its own
 * stores, the REAL binding + orchestrator, Store MVP on (EXPO_PUBLIC_STORE_MVP=1, the
 * production profile) and file-backed persistence, so killing and re-spawning it is
 * a real restart. Identities are synthetic subjects signed by the real session signer.
 *
 * This is NOT a physical two-phone test and proves nothing about the deployed
 * backend's configuration — see ACCOUNT_DATA_FLOW.md.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { start } = require('./fixtures/account-sync-server.cjs');
const server = await start();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'two-device-'));
const DB = JSON.parse(fs.readFileSync(new URL('../public/data/database.json', import.meta.url), 'utf8')).cards;

const cardOf = (id) => {
  const r = DB[id];
  return {
    id: r.id, name: r.name, cardNumber: r.cardNumber, type: r.type ?? '', rarity: r.rarity, series: r.series,
    sellPrice: r.sellPrice ?? null, yuyuName: r.yuyuName ?? '', color: r.color ?? '', imageUrl: r.officialImage ?? '',
    prices: r.prices,
  };
};
const KANATA = cardOf('hBP01-010_hBP01_U_hBP01-010_U');
const IROHA_SR = cardOf('hBP01-051_hEB01_SR_hBP01-051_SR_02');

const live = new Set();
function spawnDevice(name) {
  const child = fork(new URL('./fixtures/account-sync-device.mjs', import.meta.url).pathname, [], {
    execArgv: ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', './scripts/register-web-render.mjs'],
    env: { ...process.env, DEVICE_STORE: path.join(tmp, `${name}.json`), SYNC_PORT: String(server.port), EXPO_PUBLIC_STORE_MVP: '1' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let seq = 0;
  const pending = new Map();
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const ready = new Promise((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`${name} exited ${code}: ${stderr.slice(-2000)}`)));
    child.on('message', (m) => {
      if (m.ready) return resolve();
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.ok ? p.resolve(m.result) : p.reject(new Error(`${name}.${p.cmd}: ${m.error}`));
    });
  });
  const dev = {
    name,
    ready,
    call: (cmd, args) => new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject, cmd });
      child.send({ id, cmd, args });
    }),
    kill: () => new Promise((r) => { child.once('exit', r); child.kill(); live.delete(dev); }),
  };
  live.add(dev);
  return dev;
}
async function device(name) { const d = spawnDevice(name); await d.ready; return d; }
async function act(dev, cmd, args) { await dev.call(cmd, args); await dev.call('settle'); return dev.call('state'); }
const serverSnapshot = async (session) => (await (await fetch(`http://127.0.0.1:${server.port}/api/auth/sync`, { headers: { authorization: `Bearer ${session}` } })).json()).snapshot;

let passed = 0;
async function test(label, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (err) { process.exitCode = 1; console.error(`  ✗ ${label} — ${err.message}`); }
}

const A = await server.createSession('two-device-user-a');
const B = await server.createSession('two-device-user-b');
const userA = { ...A.user };
const userB = { ...B.user };

try {
  const phone1 = await device('phone1');
  const phone2 = await device('phone2');

  await test('Store MVP profile is what runs (bookmarks hidden) and the binding is installed: a guest makes no sync request', async () => {
    let s = await act(phone1, 'own', { cardNumber: 'hBP01-010', version: 'BASE', qty: 2 });
    s = await act(phone1, 'scan', { card: KANATA });
    assert.equal(s.storeMvp, true);
    assert.deepEqual(s.requests, [], 'no account, no request');
    assert.equal(s.scans.length, 1);
    assert.equal(s.sync.ownerId, null);
  });

  await test('guest → sign in (phone 1): guest collection + scan list merged into the empty account, pushed, nothing lost', async () => {
    const quotaBefore = (await phone1.call('state')).quotaRemaining;
    const s = await act(phone1, 'login', { session: A.session, user: userA });
    assert.equal(s.sync.ownerId, userA.internalId, 'owner = server-verified internalId');
    assert.equal(s.sync.dirty, false, 'acknowledged by the server');
    assert.equal(s.collection['hBP01-010|BASE'], 2);
    assert.equal(s.scans.length, 1);
    assert.equal(s.quotaRemaining, quotaBefore, 'signing in neither charges nor resets the device quota');
    const snap = await serverSnapshot(A.session);
    assert.equal(snap.collection['hBP01-010|BASE'], 2);
    assert.equal(snap.scanSession.entries.length, 1);
    assert.equal(snap.scanSession.entries[0].card.cardNumber, 'hBP01-010');
    assert.deepEqual(s.pushedFields.filter((f) => f === 'favorites' || f === 'priceAlerts'), [], 'hidden surfaces never pushed in Store MVP');
  });

  await test('same account on phone 2: sees the same collection, scan list (same scan id) and settings', async () => {
    let s = await act(phone1, 'setLanguage', { lang: 'ja' });
    s = await act(phone2, 'login', { session: A.session, user: userA });
    const one = await phone1.call('state');
    assert.equal(s.collection['hBP01-010|BASE'], 2);
    assert.deepEqual(s.scans.map((x) => x.instanceId), one.scans.map((x) => x.instanceId));
    assert.equal(s.language, 'ja');
  });

  await test('Store MVP: a bookmark change (hidden surface) sends no request and writes nothing', async () => {
    const before = (await phone1.call('state')).requests.length;
    const s = await act(phone1, 'favorite', { cardNumber: 'hBP01-010' });
    assert.equal(s.requests.length, before, 'no push for a hidden surface');
    assert.deepEqual((await serverSnapshot(A.session)).favorites, []);
  });

  await test('another Google account (phone 3) sees nothing of account A', async () => {
    const phone3 = await device('phone3');
    const s = await act(phone3, 'login', { session: B.session, user: userB });
    assert.deepEqual(s.collection, {});
    assert.equal(s.scans.length, 0);
    const snapB = await serverSnapshot(B.session);
    assert.equal(snapB.revision, 0, 'B was never written');
    await phone3.kill();
  });

  await test('edits and deletions travel: phone 1 adds a scan, picks its version, removes the old one, sets ownership to 0 → phone 2 on foreground', async () => {
    await act(phone1, 'scan', { card: IROHA_SR });
    await act(phone1, 'pickVersion', { index: 1, version: 0 });
    await act(phone1, 'removeScan', { index: 0 });
    let s = await act(phone1, 'own', { cardNumber: 'hBP01-010', version: 'BASE', qty: 0 });
    assert.equal(s.scans.length, 1);
    assert.equal(s.sync.dirty, false);
    s = await act(phone2, 'foreground');
    assert.equal(s.scans.length, 1, 'removed scan gone on phone 2');
    assert.equal(s.scans[0].cardNumber, 'hBP01-051');
    assert.equal(s.scans[0].versionConfident, true, 'the explicit version pick travelled');
    assert.equal(s.scans[0].selectedVersion, 0);
    assert.equal(s.collection['hBP01-010|BASE'], undefined, 'ownership 0 propagated as a deletion');
  });

  await test('offline edit survives a restart and is sent once the phone is online again (no loss, no duplicate)', async () => {
    await phone2.call('offline', { value: true });
    let s = await act(phone2, 'own', { cardNumber: 'hEB01-014', version: 'SR', qty: 1 });
    s = await act(phone2, 'scan', { card: KANATA });
    assert.equal(s.sync.dirty, true, 'pending while offline');
    await phone2.kill();
    const phone2b = await device('phone2');   // same storage file = app restart
    s = await act(phone2b, 'state');
    assert.equal(s.sync.dirty, false, 'pushed at boot');
    assert.equal(s.collection['hEB01-014|SR'], 1);
    const snap = await serverSnapshot(A.session);
    assert.equal(snap.collection['hEB01-014|SR'], 1);
    assert.equal(snap.scanSession.entries.length, 2, 'Iroha + the offline Kanata scan, once each');
    assert.equal(new Set(snap.scanSession.entries.map((e) => e.instanceId)).size, 2);
    await phone2b.kill();
  });

  await test('concurrent edits on two phones (both offline, then online): a 409 merges both, nothing lost', async () => {
    const p2 = await device('phone2');
    await p2.call('offline', { value: true });
    await phone1.call('offline', { value: true });
    await act(phone1, 'own', { cardNumber: 'hSD01-001', version: 'BASE', qty: 4 });
    await act(p2, 'own', { cardNumber: 'hSD02-001', version: 'BASE', qty: 1 });
    await phone1.call('offline', { value: false });
    const s1 = await act(phone1, 'foreground');
    assert.equal(s1.sync.dirty, false, 'phone 1 caught up after a 409 merge');
    assert.ok(server.log.some((r) => r.method === 'POST' && r.status === 409), 'a real 409 from the real handler happened');
    await p2.call('offline', { value: false });
    const s2 = await act(p2, 'foreground');
    const snap = await serverSnapshot(A.session);
    assert.equal(snap.collection['hSD01-001|BASE'], 4, 'phone 1 edit kept');
    assert.equal(snap.collection['hSD02-001|BASE'], 1, 'phone 2 edit kept');
    assert.equal(s2.sync.dirty, false);
    await p2.kill();
  });

  await test('same person, NEW session token (re-sign-in / token rotation) with a pending offline edit: nothing wiped, the edit is pushed', async () => {
    await phone1.call('offline', { value: true });
    await act(phone1, 'own', { cardNumber: 'hBP04-001', version: 'BASE', qty: 2 });
    const A2 = await server.createSession('two-device-user-a');   // same subject → same account, new token
    assert.notEqual(A2.session, A.session);
    assert.equal(A2.user.internalId, userA.internalId);
    let s = await act(phone1, 'login', { session: A2.session, user: { ...A2.user } });
    assert.equal(s.collection['hBP04-001|BASE'], 2, 'pending edit kept across the token change');
    await phone1.call('offline', { value: false });
    s = await act(phone1, 'foreground');
    assert.equal(s.sync.dirty, false);
    assert.equal((await serverSnapshot(A.session)).collection['hBP04-001|BASE'], 2, 'and pushed');
  });

  // PM 2026-10-17: unacknowledged edits must not be lost silently at sign-out / switch.
  await test('edit then sign out INSIDE the push debounce (online): the guest sees nothing; the same account signing in again gets the edit back (account D) and it reaches the server', async () => {
    const D = await server.createSession('two-device-user-d');
    const userD = { ...D.user };
    const p = await device('outbox-1');
    await act(p, 'login', { session: D.session, user: userD });
    await p.call('own', { cardNumber: 'hBP05-001', version: 'BASE', qty: 7 });   // no settle: still in the debounce
    let s = await act(p, 'logout');
    assert.equal(s.collection['hBP05-001|BASE'], undefined, 'not shown to the next person');
    assert.deepEqual(s.parkedOwners, [userD.internalId], 'parked for account D only');
    assert.equal((await serverSnapshot(D.session)).collection['hBP05-001|BASE'], undefined, 'it had not reached the server');
    s = await act(p, 'login', { session: D.session, user: userD });
    assert.equal(s.collection['hBP05-001|BASE'], 7, 'restored for D');
    assert.deepEqual(s.parkedOwners, [], 'cleared after the server acknowledged');
    assert.equal((await serverSnapshot(D.session)).collection['hBP05-001|BASE'], 7, 'and synced');
    await p.kill();
  });

  await test('offline edit → sign out → ANOTHER account (B) signs in: B sees none of it and B\'s account gets none of it; the owner (E) later gets it back', async () => {
    const E = await server.createSession('two-device-user-e');
    const userE = { ...E.user };
    const p = await device('outbox-2');
    await act(p, 'login', { session: E.session, user: userE });
    await p.call('offline', { value: true });
    await act(p, 'own', { cardNumber: 'hBP05-002', version: 'BASE', qty: 3 });
    await act(p, 'scan', { card: KANATA });
    await act(p, 'logout');
    await p.call('offline', { value: false });
    let s = await act(p, 'login', { session: B.session, user: userB });
    assert.equal(s.collection['hBP05-002|BASE'], undefined, 'B does not see E\'s parked edit');
    assert.equal(s.scans.length, 0);
    assert.equal((await serverSnapshot(B.session)).collection['hBP05-002|BASE'], undefined, 'never written to B');
    assert.deepEqual(s.parkedOwners, [userE.internalId], 'still parked for E');
    await act(p, 'logout');
    s = await act(p, 'login', { session: E.session, user: userE });
    assert.equal(s.collection['hBP05-002|BASE'], 3);
    const snapE = await serverSnapshot(E.session);
    assert.equal(snapE.collection['hBP05-002|BASE'], 3, 'E\'s parked edit reached E\'s account');
    assert.ok(snapE.scanSession.entries.some((e) => e.card.cardNumber === 'hBP01-010'), 'parked scan too');
    assert.deepEqual(s.parkedOwners, []);
    await p.kill();
  });

  await test('account deletion discards anything parked for that account (never restored)', async () => {
    const C = await server.createSession('two-device-user-c');
    const p = await device('outbox-3');
    await act(p, 'login', { session: C.session, user: { ...C.user } });
    await p.call('offline', { value: true });
    await act(p, 'own', { cardNumber: 'hBP05-003', version: 'BASE', qty: 1 });
    let s = await act(p, 'logout');
    assert.deepEqual(s.parkedOwners, [C.user.internalId]);
    await act(p, 'login', { session: C.session, user: { ...C.user } });   // still offline: nothing restored yet
    await p.call('offline', { value: false });
    s = await act(p, 'deleteAccount');
    assert.deepEqual(s.parkedOwners, [], 'parked data of the deleted account is gone');
    assert.deepEqual(s.collection, {});
    await p.kill();
  });

  await test('sign out on phone 1: the account data (incl. the scan list) leaves the device; the next guest starts empty', async () => {
    const s = await act(phone1, 'logout');
    assert.deepEqual(s.collection, {});
    assert.equal(s.scans.length, 0);
    assert.equal(s.sync.ownerId, null);
    const snap = await serverSnapshot(A.session);
    assert.equal(snap.scanSession.entries.length, 2, 'signing out deletes nothing on the server');
  });

  await test('account switch on one phone: B signs in where A was — none of A appears, A\'s pending data is not pushed into B', async () => {
    const p = await device('switcher');
    await act(p, 'login', { session: A.session, user: userA });
    await p.call('offline', { value: true });
    await act(p, 'own', { cardNumber: 'hBP02-001', version: 'BASE', qty: 9 });
    await act(p, 'scan', { card: KANATA });
    // B takes over without A signing out first, while the phone is still offline —
    // B's server data cannot be fetched, so nothing may hide A's data but the clear.
    let s = await act(p, 'login', { session: B.session, user: userB });
    assert.equal(s.collection['hBP02-001|BASE'], undefined, 'A\'s pending edit not shown to B (offline)');
    assert.equal(s.scans.length, 0, 'A\'s scan list not shown to B (offline)');
    await p.call('offline', { value: false });
    s = await act(p, 'foreground');
    assert.equal(s.sync.ownerId, userB.internalId);
    assert.equal(s.collection['hBP02-001|BASE'], undefined, 'A\'s pending edit not shown to B');
    const snapB = await serverSnapshot(B.session);
    assert.equal(snapB.collection['hBP02-001|BASE'], undefined, 'and never written to B');
    assert.equal(snapB.scanSession.entries.length, 0);
    await p.kill();
  });

  await test('an expired / foreign session gets nothing: the server answers 401 and the device keeps its data', async () => {
    const p = await device('expired');
    await act(p, 'own', { cardNumber: 'hBP03-001', version: 'BASE', qty: 1 });
    const s = await act(p, 'login', { session: `${A.session.slice(0, -4)}AAAA`, user: userA });
    assert.equal(s.collection['hBP03-001|BASE'], 1, 'nothing wiped by a rejected session');
    const snap = await serverSnapshot(A.session);
    assert.equal(snap.collection['hBP03-001|BASE'], undefined, 'nothing written with a forged session');
    assert.ok(server.log.filter((r) => r.url === '/api/auth/sync' && r.status === 401).length >= 1);
    await p.kill();
  });

  // ── CR 2026-10-17 (fefb920 review): races, each RED on fefb920, GREEN after the fix ──
  await test('CR P1: A\'s push queued behind an in-flight pull, then the phone switches to B and B edits — nothing of B is sent under A\'s bearer; A\'s edit stays A\'s; B\'s edit reaches B', async () => {
    const F = await server.createSession('two-device-user-f'); const userF = { ...F.user };
    const G = await server.createSession('two-device-user-g'); const userG = { ...G.user };
    const p = await device('cr-p1');
    await act(p, 'login', { session: F.session, user: userF });
    await p.call('hold', { method: 'GET' });
    await p.call('resync');                                          // pull in flight, holds the sync lock
    await p.call('waitHeld', { method: 'GET' });
    await p.call('own', { cardNumber: 'hBP05-010', version: 'BASE', qty: 1 });   // A's edit
    await p.call('wait', { ms: 1000 });                              // debounce fired: A's push queued behind the lock
    await p.call('login', { session: G.session, user: userG });      // switch on the same phone
    await p.call('own', { cardNumber: 'hBP05-011', version: 'BASE', qty: 42 });  // B's private edit
    await p.call('release', { method: 'GET' });
    await p.call('settle');
    let s = await p.call('state');
    const leaked = s.posts.filter((x) => x.bearer === F.session && x.collection && x.collection['hBP05-011|BASE'] !== undefined);
    assert.equal(leaked.length, 0, `B's collection was sent under A's bearer (${leaked.length}×): ${JSON.stringify(leaked.map((x) => x.collection))}`);
    assert.equal((await serverSnapshot(F.session)).collection['hBP05-011|BASE'], undefined, 'A\'s account never gets B\'s data');
    assert.equal(s.collection['hBP05-010|BASE'], undefined, 'B does not see A\'s edit');
    assert.equal(s.collection['hBP05-011|BASE'], 42, 'B\'s edit is not overwritten by B\'s own hydrate');
    assert.equal((await serverSnapshot(G.session)).collection['hBP05-011|BASE'], 42, 'B\'s edit reaches B');
    assert.deepEqual(s.parkedOwners, [userF.internalId], 'A\'s unsent edit parked for A');
    await act(p, 'logout');
    s = await act(p, 'login', { session: F.session, user: userF });
    assert.equal(s.collection['hBP05-010|BASE'], 1);
    assert.equal((await serverSnapshot(F.session)).collection['hBP05-010|BASE'], 1, 'A\'s edit reaches A after re-login');
    await p.kill();
  });

  await test('CR P2: an edit made while a pull is in flight is not overwritten by the pulled snapshot (and is pushed)', async () => {
    const H = await server.createSession('two-device-user-h'); const userH = { ...H.user };
    const p1 = await device('cr-p2-1');
    const p2 = await device('cr-p2-2');
    await act(p1, 'login', { session: H.session, user: userH });
    await act(p2, 'login', { session: H.session, user: userH });
    await act(p1, 'own', { cardNumber: 'hBP05-012', version: 'BASE', qty: 3 });   // server: 3
    await p2.call('hold', { method: 'GET' });
    await p2.call('resync');
    await p2.call('waitHeld', { method: 'GET' });
    await p2.call('own', { cardNumber: 'hBP05-012', version: 'BASE', qty: 9 });   // user sets 9 meanwhile
    await p2.call('release', { method: 'GET' });
    await p2.call('settle');
    const s = await p2.call('state');
    assert.equal(s.collection['hBP05-012|BASE'], 9, 'the newer local edit survives the pull');
    assert.equal(s.sync.dirty, false);
    assert.equal((await serverSnapshot(H.session)).collection['hBP05-012|BASE'], 9, 'and reaches the server');
    await p1.kill(); await p2.kill();
  });

  await test('CR P2: deletions made on one phone stay deleted when a STALE phone of the same account pushes (scan, collection, deck)', async () => {
    const I = await server.createSession('two-device-user-i'); const userI = { ...I.user };
    const p1 = await device('cr-del-1');
    const p2 = await device('cr-del-2');
    await act(p1, 'login', { session: I.session, user: userI });
    await act(p2, 'login', { session: I.session, user: userI });
    await act(p1, 'scan', { card: KANATA });
    await act(p1, 'scan', { card: IROHA_SR });
    await act(p1, 'own', { cardNumber: 'hBP05-020', version: 'BASE', qty: 2 });
    const deckId = await p1.call('createDeck', { name: 'cr-deck' });
    await p1.call('settle');
    await p2.call('resync'); await p2.call('settle');
    let s2 = await p2.call('state');
    assert.equal(s2.scans.length, 2); assert.equal(s2.collection['hBP05-020|BASE'], 2); assert.ok(s2.decks.includes(deckId));
    const removedId = (await p1.call('state')).scans[0].instanceId;
    await act(p1, 'removeScan', { index: 0 });
    await act(p1, 'own', { cardNumber: 'hBP05-020', version: 'BASE', qty: 0 });
    await act(p1, 'deleteDeck', { id: deckId });
    let snap = await serverSnapshot(I.session);
    assert.ok(!snap.scanSession.entries.some((e) => e.instanceId === removedId));
    // phone 2 never pulled since: its next edit goes out against an old revision → 409 → merge
    s2 = await act(p2, 'own', { cardNumber: 'hBP05-021', version: 'BASE', qty: 1 });
    snap = await serverSnapshot(I.session);
    assert.ok(!snap.scanSession.entries.some((e) => e.instanceId === removedId), 'the removed scan does not come back');
    assert.equal(snap.scanSession.entries.length, 1);
    assert.equal(snap.collection['hBP05-020|BASE'], undefined, 'the removed collection entry does not come back');
    assert.ok(!snap.decks.some((d) => d.id === deckId), 'the deleted deck does not come back');
    assert.equal(snap.collection['hBP05-021|BASE'], 1, 'the stale phone\'s own edit is kept');
    assert.ok(!s2.scans.some((c) => c.instanceId === removedId) && !s2.decks.includes(deckId) && s2.collection['hBP05-020|BASE'] === undefined, 'phone 2 shows the deletions too');
    await p1.kill(); await p2.kill();
  });

  await test('CR P2: an edit made while a push is in flight survives that push\'s 409 merge', async () => {
    const J = await server.createSession('two-device-user-j'); const userJ = { ...J.user };
    const p1 = await device('cr-409-1');
    const p2 = await device('cr-409-2');
    await act(p1, 'login', { session: J.session, user: userJ });
    await act(p2, 'login', { session: J.session, user: userJ });
    await act(p1, 'own', { cardNumber: 'hBP05-030', version: 'BASE', qty: 1 });   // p2 is now behind → its push will 409
    await p2.call('hold', { method: 'POST' });
    await p2.call('own', { cardNumber: 'hBP05-031', version: 'BASE', qty: 1 });
    await p2.call('waitHeld', { method: 'POST' });
    await p2.call('own', { cardNumber: 'hBP05-032', version: 'BASE', qty: 4 });   // while the push is in flight
    await p2.call('release', { method: 'POST' });
    await p2.call('settle');
    const s = await p2.call('state');
    assert.equal(s.collection['hBP05-032|BASE'], 4, 'not overwritten by the 409 merge');
    const snap = await serverSnapshot(J.session);
    assert.deepEqual([snap.collection['hBP05-030|BASE'], snap.collection['hBP05-031|BASE'], snap.collection['hBP05-032|BASE']], [1, 1, 4]);
    await p1.kill(); await p2.kill();
  });

  await test('CR P2: a deletion made while a push is in flight is not forgotten when that push is acknowledged — a later 409 still honours it', async () => {
    const K = await server.createSession('two-device-user-k'); const userK = { ...K.user };
    const p1 = await device('cr-ack-1');
    const p2 = await device('cr-ack-2');
    await act(p1, 'login', { session: K.session, user: userK });
    await act(p2, 'login', { session: K.session, user: userK });
    await act(p1, 'own', { cardNumber: 'hBP05-040', version: 'BASE', qty: 2 });
    await p2.call('resync'); await p2.call('settle');
    await p2.call('hold', { method: 'POST' });
    await p2.call('hold', { method: 'POST' });
    await p2.call('own', { cardNumber: 'hBP05-041', version: 'BASE', qty: 1 });   // push 1 (carries hBP05-040 = 2)
    await p2.call('waitHeld', { method: 'POST' });
    await p2.call('own', { cardNumber: 'hBP05-040', version: 'BASE', qty: 0 });   // deleted while push 1 is in flight
    await p2.call('release', { method: 'POST' });                                // push 1 acknowledged
    await p2.call('waitHeld', { method: 'POST' });                               // push 2 (the deletion) in flight
    await act(p1, 'own', { cardNumber: 'hBP05-042', version: 'BASE', qty: 1 });  // the other phone moves the server on
    await p2.call('release', { method: 'POST' });                                // push 2 → 409 → merge
    await p2.call('settle');
    const snap = await serverSnapshot(K.session);
    assert.equal(snap.collection['hBP05-040|BASE'], undefined, 'the deletion survives');
    assert.equal(snap.collection['hBP05-041|BASE'], 1);
    assert.equal(snap.collection['hBP05-042|BASE'], 1, 'the other phone\'s edit is kept');
    assert.equal((await p2.call('state')).collection['hBP05-040|BASE'], undefined);
    await p1.kill(); await p2.kill();
  });

  await phone1.kill();
} finally {
  for (const d of [...live]) await d.kill();
  await server.close();
}

if ((process.exitCode ?? 0) === 0) console.log(`\n✅ account-sync two-device: ${passed} checks passed`);
else console.error('\n❌ account-sync two-device failed');
