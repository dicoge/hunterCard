#!/usr/bin/env node
/**
 * 2026-11-04 — F1 (SCAN_PICK_INDEPENDENT_REVIEW.md): a LOST ACK let a fast-clock phone's
 * uncapped pick time overwrite a later genuine pick made on another phone. Fixed by
 * lost-ACK recovery (ACK_RECOVERY_DESIGN_REVIEW.md): the exact request whose answer was
 * lost is replayed with its own idempotency key before the next push / hydrate.
 *
 * Harness (unchanged from the reproduction):
 *   • the REAL api/auth sync handler + account-sync-store (scripts/fixtures/
 *     account-sync-server.cjs, in-memory KV, 127.0.0.1 only, synthetic identities);
 *   • phones as separate Node processes (scripts/fixtures/account-sync-device.mjs)
 *     running the REAL binding, orchestrator and stores, persisted to files (a respawn
 *     is a real restart). Phone B's clock is skewed; the server's is not.
 * Nothing here re-implements the merge or the recovery: outcomes are what the shipped
 * code does. Commits are counted by the server's REVISION (an idempotent replay also
 * answers HTTP 200, so 200s are not commits), and requests by their idempotency key.
 *
 * Cases
 *   1 (reported route)  lost ACK → hydrate → A picks Y → B pushes → account keeps Y
 *   2 (app route)       lost ACK → A picks Y → B's automatic retry → account keeps Y
 *   3a post-send edits  another scan removed + an unrelated edit after sending: the
 *                       replay confirms only the original; both edits still reach the
 *                       server; Y kept
 *   3b post-send pick   B re-picks the same scan after sending: kept, not overwritten
 *   4a never arrived    same revision: the replay commits the original exactly once
 *   4b never arrived    revision moved: 409 → record dropped → normal merge
 *   5  restart          the record survives a process restart and is replayed first
 *   6  owner isolation  sign-out / another account: A's key/patch never sent as B;
 *                       A's unsent edit stays parked for A
 * Old reproduction assertions that described the defect itself ("B stays dirty after
 * the hydrate", "B's retry hits a 409") are replaced by the recovery postconditions;
 * the final "account keeps Y" assertions are unchanged.
 *
 * Run: node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-account-sync-lost-ack-pick.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { start } = require('./fixtures/account-sync-server.cjs');
const { scanPickFingerprint } = await import('../src/utils/scanSessionSync.ts');
const server = await start();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lost-ack-pick-'));
const DB = JSON.parse(fs.readFileSync(new URL('../public/data/database.json', import.meta.url), 'utf8')).cards;
const cardOf = (id, prices) => {
  const r = DB[id];
  assert.ok(r, `fixture card row ${id} present in the shipped catalog`);
  return {
    id: r.id, name: r.name, cardNumber: r.cardNumber, type: r.type ?? '', rarity: r.rarity, series: r.series,
    sellPrice: r.sellPrice ?? null, yuyuName: r.yuyuName ?? '', color: r.color ?? '', imageUrl: '', prices: prices ?? r.prices,
  };
};
// Same synthetic two-listing card the two-device suite uses: versions 0 and 1.
const DUAL = cardOf('hBP01-051_hEB01_SR_hBP01-051_SR_02',
  [{ name: '風真いろは', sellPrice: 120, imageUrl: '' }, { name: '風真いろは(パラレル)', sellPrice: 980, imageUrl: '' }]);
const OTHER = cardOf('hBP01-010_hBP01_U_hBP01-010_U');
const SKEW_MS = 5 * 60 * 1000;

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
    ready,
    call: (cmd, args) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject, cmd }); child.send({ id, cmd, args }); }),
    kill: () => new Promise((res) => { child.once('exit', res); child.kill(); live.delete(dev); }),
  };
  live.add(dev);
  return dev;
}
async function device(name) { const d = spawnDevice(name); await d.ready; return d; }
async function act(dev, cmd, args) { await dev.call(cmd, args); await dev.call('settle'); return dev.call('state'); }
const serverSnapshot = async (session) =>
  (await (await fetch(`http://127.0.0.1:${server.port}/api/auth/sync`, { headers: { authorization: `Bearer ${session}` } })).json()).snapshot;
const count = (pred) => server.log.filter(pred).length;
const conflicts = () => count((x) => x.method === 'POST' && x.status === 409);
const entryOf = (snap, id) => snap.scanSession.entries.find((e) => e.instanceId === id);

let passed = 0;
async function test(label, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (err) { process.exitCode = 1; console.error(`  ✗ ${label} — ${err.message}`); }
  for (const d of [...live]) await d.kill();
}

/** A and B on one account, both holding the same scan(s) with no explicit pick yet. */
async function pair(tag, { extraScan = false } = {}) {
  const S = await server.createSession(`lost-ack-${tag}`);
  const user = { ...S.user };
  const pa = await device(`${tag}-a`);
  const pb = await device(`${tag}-b`);
  await act(pa, 'login', { session: S.session, user });
  await act(pb, 'login', { session: S.session, user });
  await act(pa, 'scan', { card: DUAL });
  if (extraScan) await act(pa, 'scan', { card: OTHER });
  await pb.call('resync'); await pb.call('settle');
  const sb = await pb.call('state');
  assert.equal(sb.scans.length, extraScan ? 2 : 1, 'setup: B has the scan(s)');
  assert.equal(sb.scans[0].cardNumber, DUAL.cardNumber);
  assert.equal(sb.scans[0].selectedAt, null, 'setup: no explicit pick yet');
  assert.equal(sb.sync.dirty, false, 'setup: B in sync');
  return { S, user, pa, pb, tag, instanceId: sb.scans[0].instanceId, otherId: sb.scans[1]?.instanceId };
}

/** B (clock +5 min) picks X=0; the server commits it, the response is lost; B records it. */
async function lostAck({ S, user, pb, instanceId }) {
  const rev0 = (await serverSnapshot(S.session)).revision;
  await pb.call('clock', { skewMs: SKEW_MS });
  await pb.call('loseNextResponse', { method: 'POST' });
  await pb.call('pickVersion', { index: 0, version: 0 });      // the binding pushes it
  await pb.call('settle');
  const sb = await pb.call('state');
  const meta = await pb.call('syncMeta');
  const snap = await serverSnapshot(S.session);
  const srv = entryOf(snap, instanceId);
  assert.equal(meta.lostResponses, 1, 'setup: exactly one response was dropped (lost ACK)');
  assert.equal(snap.revision, rev0 + 1, 'setup: the server COMMITTED B\'s push (one new revision)');
  assert.equal(srv.selectedVersion, 0, 'setup: server holds X');
  assert.equal(srv.versionConfident, true);
  assert.equal(sb.scans[0].selectedVersion, 0);
  const localAt = Date.parse(sb.scans[0].selectedAt);
  assert.ok(Date.parse(srv.selectedAt) <= Date.now() + 1000, 'setup: server capped the pick time to its own now');
  assert.ok(localAt - Date.parse(srv.selectedAt) > SKEW_MS / 2, 'setup: B still holds the UNCAPPED future time');
  assert.equal(sb.sync.dirty, true, 'setup: B stays dirty after the lost ACK');
  assert.notEqual(meta.scanPicks?.[instanceId], scanPickFingerprint(srv), 'setup: B\'s baseline predates the commit');
  const lost = meta.postLog.at(-1);
  // Recovery: the exact request is recorded for this owner.
  assert.ok(meta.pendingAck, 'fix: the lost request is recorded (pendingAck)');
  assert.equal(meta.pendingAck.idempotencyKey, lost.idempotencyKey, 'fix: record = the request that was sent');
  assert.equal(meta.pendingAck.baseRevision, rev0);
  assert.equal(meta.pendingAck.ownerId, user.internalId);
  return { revisionAfterX: snap.revision, localAt, lostKey: lost.idempotencyKey, srvX: srv };
}

/** A, up to date, genuinely picks Y=1 (correct clock) and the server accepts it. */
async function genuineY({ S, pa, instanceId }) {
  const sa0 = await act(pa, 'resync');
  assert.equal(sa0.scans[0].selectedVersion, 0, 'setup: A first sees X');
  const sa = await act(pa, 'pickVersion', { index: 0, version: 1 });
  assert.equal(sa.sync.dirty, false, 'setup: A\'s Y acknowledged');
  const snap = await serverSnapshot(S.session);
  assert.equal(entryOf(snap, instanceId).selectedVersion, 1, 'setup: server holds A\'s Y');
  return { yAt: Date.parse(entryOf(snap, instanceId).selectedAt), revisionAfterY: snap.revision };
}

/** The replay: the first POST carrying `key` after index `from`, and how many there were. */
const replaysOf = (meta, key, from = 0) => meta.postLog.slice(from).filter((p) => p.idempotencyKey === key);

await test('F1 case 1: lost ACK → hydrate replays the same request first → A genuinely picks Y → B\'s push → account keeps Y', async () => {
  const ctx = await pair('h');
  const { revisionAfterX, localAt, lostKey, srvX } = await lostAck(ctx);
  // Keep the recovery out of reach once: B's automatic retry (5 s) fails offline.
  const posts0 = (await ctx.pb.call('syncMeta')).postLog.length;
  await ctx.pb.call('offline', { value: true });
  for (let i = 0; i < 160 && (await ctx.pb.call('syncMeta')).postLog.length === posts0; i += 1) await ctx.pb.call('wait', { ms: 50 });
  let meta = await ctx.pb.call('syncMeta');
  assert.ok(meta.postLog.length > posts0, 'setup: B\'s automatic retry ran (and failed offline)');
  assert.equal(replaysOf(meta, lostKey, posts0).length, 1, 'fix: the failed retry was the REPLAY of the lost request');
  assert.equal(meta.pendingAck?.idempotencyKey, lostKey, 'fix: a failed replay keeps the record');
  assert.equal(meta.pendingAck.attempts, 0, 'R1: an offline (no-response) replay is not counted against the attempt cap');
  await ctx.pb.call('offline', { value: false });
  const posts1 = meta.postLog.length;
  const h = await ctx.pb.call('hydrate');
  assert.equal(h.ok, true, `setup: hydrate returned the snapshot (${h.error ?? ''})`);
  meta = await ctx.pb.call('syncMeta');
  const sb = await ctx.pb.call('state');
  assert.equal(replaysOf(meta, lostKey, posts1).length, 1, 'fix: hydrate replayed the same key BEFORE pulling');
  assert.equal((await serverSnapshot(ctx.S.session)).revision, revisionAfterX, 'fix: the replay committed nothing new (idempotent)');
  assert.equal(meta.pendingAck, null, 'fix: record cleared after the recovered ACK');
  assert.equal(meta.dirtySeq, meta.ackedSeq, 'fix: the recovered ACK confirmed the original push (B clean)');
  assert.equal(sb.scans[0].selectedAt && Date.parse(sb.scans[0].selectedAt), Date.parse(srvX.selectedAt), 'fix: B adopted the server\'s canonical (capped) time');
  assert.equal(meta.scanPicks?.[ctx.instanceId], scanPickFingerprint(srvX), 'fix: baseline = the committed pick');
  const { yAt } = await genuineY(ctx);
  assert.ok(localAt > yAt, 'setup: B\'s ORIGINAL stamp was later than A\'s genuine pick (old clock rule would pick X)');
  const c0 = conflicts();
  await ctx.pb.call('push');
  await ctx.pb.call('settle');
  assert.ok(conflicts() > c0, 'setup: B\'s push went out against the old revision and was merged after a 409');
  const final = entryOf(await serverSnapshot(ctx.S.session), ctx.instanceId);
  assert.equal(final.selectedVersion, 1, 'F1: the account must keep A\'s later genuine pick Y (server)');
  assert.equal((await ctx.pb.call('state')).scans[0].selectedVersion, 1, 'F1: B shows Y too');
});

await test('F1 case 2 (app path): lost ACK → A genuinely picks Y → B\'s automatic retry replays the same key → account keeps Y', async () => {
  const ctx = await pair('r');
  const { localAt, lostKey } = await lostAck(ctx);
  await ctx.pb.call('hold', { method: 'POST' });             // park B's automatic retry so A's pick lands first
  const posts0 = (await ctx.pb.call('syncMeta')).postLog.length;
  const { yAt, revisionAfterY } = await genuineY(ctx);
  assert.ok(localAt > yAt, 'setup: B\'s ORIGINAL stamp was later than A\'s genuine pick');
  await ctx.pb.call('waitHeld', { method: 'POST', maxMs: 15000 });
  await ctx.pb.call('release', { method: 'POST' });
  await ctx.pb.call('settle');
  const meta = await ctx.pb.call('syncMeta');
  assert.equal(replaysOf(meta, lostKey, posts0).length, 1, 'fix: B\'s retry replayed the SAME idempotency key (the original request)');
  assert.equal(meta.postLog.slice(posts0)[0].idempotencyKey, lostKey, 'fix: the replay went out before anything else');
  assert.equal((await serverSnapshot(ctx.S.session)).revision, revisionAfterY, 'fix: no new commit — X was not written again over Y');
  assert.equal(meta.pendingAck, null);
  assert.equal(meta.dirtySeq, meta.ackedSeq, 'fix: nothing left to send');
  const final = entryOf(await serverSnapshot(ctx.S.session), ctx.instanceId);
  assert.equal(final.selectedVersion, 1, 'F1: the account must keep A\'s later genuine pick Y (server)');
  const sb = await act(ctx.pb, 'resync');                     // B's next normal pull
  assert.equal(sb.scans[0].selectedVersion, 1, 'F1: B shows Y after its next hydrate');
});

await test('3a post-send edits: another scan removed + an unrelated edit after sending — the replay confirms only the original; both edits still reach the server; Y kept', async () => {
  const ctx = await pair('e', { extraScan: true });
  const { lostKey } = await lostAck(ctx);
  await ctx.pb.call('hold', { method: 'POST' });
  const posts0 = (await ctx.pb.call('syncMeta')).postLog.length;
  await ctx.pb.call('removeScan', { index: 1 });               // after sending: delete the other scan
  await ctx.pb.call('own', { cardNumber: 'hBP05-071', version: 'BASE', qty: 2 });   // and an unrelated edit
  const { revisionAfterY } = await genuineY(ctx);
  await ctx.pb.call('waitHeld', { method: 'POST', maxMs: 15000 });
  await ctx.pb.call('release', { method: 'POST' });
  await ctx.pb.call('settle');
  const meta = await ctx.pb.call('syncMeta');
  const replay = replaysOf(meta, lostKey, posts0);
  assert.equal(replay.length, 1, 'fix: the original request was replayed');
  assert.ok(replay[0].scans.some((s) => s.instanceId === ctx.otherId), 'fix: the replay is the FROZEN original (still carries the other scan), not the current stores');
  assert.equal(replay[0].collection?.['hBP05-071|BASE'], undefined, 'fix: … and not the post-send edit');
  const after = meta.postLog.slice(posts0).filter((p) => p.idempotencyKey !== lostKey);
  assert.ok(after.length >= 1, 'fix: the post-send edits were still dirty and pushed afterwards');
  const snap = await serverSnapshot(ctx.S.session);
  assert.ok(snap.revision > revisionAfterY, 'the post-send edits were committed');
  assert.equal(entryOf(snap, ctx.otherId), undefined, 'post-send deletion kept (its tombstone was not cleared by the replay ACK)');
  assert.equal(snap.collection['hBP05-071|BASE'], 2, 'post-send unrelated edit kept');
  assert.equal(entryOf(snap, ctx.instanceId).selectedVersion, 1, 'F1: Y kept');
  assert.equal(meta.dirtySeq, meta.ackedSeq);
});

await test('3b post-send pick: B re-picks the same scan after sending — the recovered ACK does not overwrite it', async () => {
  const ctx = await pair('p');
  const { lostKey, srvX } = await lostAck(ctx);
  await ctx.pb.call('hold', { method: 'POST' });
  const posts0 = (await ctx.pb.call('syncMeta')).postLog.length;
  await ctx.pb.call('pickVersion', { index: 0, version: 1 });  // after sending: B changes its own pick
  const picked = (await ctx.pb.call('state')).scans[0];
  assert.equal(picked.selectedVersion, 1);
  await ctx.pb.call('waitHeld', { method: 'POST', maxMs: 15000 });
  await ctx.pb.call('release', { method: 'POST' });
  await ctx.pb.call('settle');
  const meta = await ctx.pb.call('syncMeta');
  assert.equal(replaysOf(meta, lostKey, posts0).length, 1, 'fix: the original request was replayed once');
  assert.equal(meta.postLog[posts0].scans[0].selectedVersion, 0, 'fix: the replay carries the ORIGINAL pick (X), frozen before the re-pick');
  const sb = await ctx.pb.call('state');
  assert.equal(sb.scans[0].selectedVersion, 1, 'the post-send pick stays on B');
  // Its own later push may canonicalise ITS time; the old pick's canonical time must never land on it.
  assert.notEqual(Date.parse(sb.scans[0].selectedAt), Date.parse(srvX.selectedAt), 'the OLD pick\'s canonical time was not adopted onto the new pick');  assert.equal(entryOf(await serverSnapshot(ctx.S.session), ctx.instanceId).selectedVersion, 1, 'and it reaches the server');
});

await test('4a never arrived, revision unchanged: the replay commits the original exactly once', async () => {
  const ctx = await pair('n');
  const rev0 = (await serverSnapshot(ctx.S.session)).revision;
  await ctx.pb.call('offline', { value: true });
  await act(ctx.pb, 'pickVersion', { index: 0, version: 0 });  // the push fails before reaching the server
  let meta = await ctx.pb.call('syncMeta');
  const key = meta.pendingAck?.idempotencyKey;
  assert.ok(key, 'setup: no-response failure recorded');
  assert.equal((await serverSnapshot(ctx.S.session)).revision, rev0, 'setup: nothing reached the server');
  await ctx.pb.call('offline', { value: false });
  const r = await ctx.pb.call('push');
  assert.equal(r.ok, true, r.error);
  meta = await ctx.pb.call('syncMeta');
  let snap = await serverSnapshot(ctx.S.session);
  assert.equal(snap.revision, rev0 + 1, 'fix: committed exactly once');
  assert.equal(entryOf(snap, ctx.instanceId).selectedVersion, 0);
  assert.equal(meta.pendingAck, null);
  assert.equal(meta.dirtySeq, meta.ackedSeq);
  await ctx.pb.call('wait', { ms: 5500 });                    // past the binding's first retry delay
  snap = await serverSnapshot(ctx.S.session);
  assert.equal(snap.revision, rev0 + 1, 'fix: no duplicate commit afterwards');
});

await test('4b never arrived, revision moved: the replay gets 409, the record is dropped, the normal merge runs', async () => {
  const ctx = await pair('m');
  await ctx.pb.call('offline', { value: true });
  await act(ctx.pb, 'pickVersion', { index: 0, version: 0 });
  const key = (await ctx.pb.call('syncMeta')).pendingAck?.idempotencyKey;
  assert.ok(key, 'setup: recorded');
  await act(ctx.pa, 'pickVersion', { index: 0, version: 1 });  // A moves the revision on (later in real time)
  await ctx.pb.call('offline', { value: false });
  const c0 = conflicts();
  const posts0 = (await ctx.pb.call('syncMeta')).postLog.length;
  await ctx.pb.call('push');
  await ctx.pb.call('settle');
  const meta = await ctx.pb.call('syncMeta');
  assert.ok(conflicts() > c0, 'fix: the replay was answered 409 (never committed)');
  assert.equal(meta.postLog.slice(posts0)[0].idempotencyKey, key, 'fix: the replay went first');
  assert.equal(meta.pendingAck, null, 'fix: record dropped after 409');
  assert.ok(meta.postLog.slice(posts0).some((p) => p.idempotencyKey !== key), 'fix: then the normal push/merge ran');
  assert.equal(entryOf(await serverSnapshot(ctx.S.session), ctx.instanceId).selectedVersion, 1, 'existing rule: A\'s later pick wins the both-changed merge');
});

await test('5 restart: the record survives a process restart and is replayed first', async () => {
  const ctx = await pair('s');
  const { revisionAfterX, lostKey, srvX } = await lostAck(ctx);
  await ctx.pb.kill();                                         // before the 5 s retry
  const pb = await device('s-b');                              // same persisted stores
  await pb.call('settle');
  const meta = await pb.call('syncMeta');
  assert.ok(meta.postLog.length >= 1, 'the restarted phone synced');
  assert.equal(meta.postLog[0].idempotencyKey, lostKey, 'fix: the first POST after the restart is the replay');
  assert.equal(meta.pendingAck, null);
  assert.equal(meta.dirtySeq, meta.ackedSeq);
  assert.equal((await serverSnapshot(ctx.S.session)).revision, revisionAfterX, 'fix: no second commit');
  const sb = await pb.call('state');
  assert.equal(Date.parse(sb.scans[0].selectedAt), Date.parse(srvX.selectedAt), 'fix: canonical time adopted after restart');
});

await test('6 owner isolation: lost ACK → sign out → another account signs in — A\'s key/patch never sent as B; A\'s edit stays parked for A', async () => {
  const ctx = await pair('o');
  const { lostKey } = await lostAck(ctx);
  await act(ctx.pb, 'logout');
  let meta = await ctx.pb.call('syncMeta');
  assert.equal(meta.pendingAck, null, 'fix: logout clears the record');
  const parked = (await ctx.pb.call('state')).parkedOwners;
  assert.deepEqual(parked, [ctx.user.internalId], 'A\'s unacknowledged edit is parked for A (existing behaviour)');
  const O2 = await server.createSession('lost-ack-o-other');
  const posts0 = meta.postLog.length;
  await act(ctx.pb, 'login', { session: O2.session, user: { ...O2.user } });
  await ctx.pb.call('wait', { ms: 5500 });
  meta = await ctx.pb.call('syncMeta');
  const asB = meta.postLog.slice(posts0).filter((p) => p.bearer === O2.session);
  assert.equal(asB.filter((p) => p.idempotencyKey === lostKey).length, 0, 'fix: A\'s key is never sent under B');
  assert.equal(asB.filter((p) => p.scans.some((s) => s.instanceId === ctx.instanceId)).length, 0, 'fix: A\'s scan is never sent under B');
  assert.equal(((await serverSnapshot(O2.session))?.scanSession?.entries ?? []).length, 0, 'B\'s account holds none of A\'s scans');
});

for (const d of [...live]) await d.kill();
await server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${passed} lost-ACK pick checks passed`);
if (process.exitCode) console.error('lost-ACK pick regression FAILED');
