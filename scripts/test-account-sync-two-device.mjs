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

  await phone1.kill();
} finally {
  for (const d of [...live]) await d.kill();
  await server.close();
}

if ((process.exitCode ?? 0) === 0) console.log(`\n✅ account-sync two-device: ${passed} checks passed`);
else console.error('\n❌ account-sync two-device failed');
