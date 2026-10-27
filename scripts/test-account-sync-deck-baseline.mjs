#!/usr/bin/env node
// 2026-10-27 — deck merge against the device's last-matched baseline, by CONTENT.
//
// Device clocks disagree. A deck the device has not changed since it last matched
// the server must yield to a genuine server change even when its own `updatedAt`
// is later (fast clock here, slow clock on the other device); a deck edited here
// must win over an unchanged server copy even when its stamp is earlier. Only a
// deck changed on both sides — or a baseline saved before content fingerprints
// existed, or no baseline — keeps the old newer-`updatedAt` rules. Runs the REAL
// orchestrator and stores; fetch is a queued fake (no account, no network).
process.env.EXPO_PUBLIC_STORE_MVP = '0';

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://holohunter.dicoge.com/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key in globalThis) continue;
  try { globalThis[key] = dom.window[key]; } catch {}
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });

const fetchCalls = [];
let responseQueue = [];
globalThis.fetch = async (input, init) => {
  fetchCalls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
  const next = responseQueue.shift();
  if (!next) throw new Error('unexpected fetch call — no response queued');
  return next();
};

const {
  mergeLocalOntoServer,
  baselineFrom,
  deckContentFingerprint,
  pushAccountSyncFromStores,
  hydrateAccountSyncFromServer,
  setLastKnownRevision,
  resetLastKnownRevision,
} = await import('../src/services/accountSyncOrchestrator.ts');
const { useAuthStore } = await import('../src/store/authStore.ts');
const { useDeckStore } = await import('../src/store/deckStore.ts');
const { useAccountSyncStateStore } = await import('../src/store/accountSyncStateStore.ts');

const SESSION = 'session-deck-baseline';
let passed = 0;
async function test(label, fn) {
  fetchCalls.length = 0;
  responseQueue = [];
  resetLastKnownRevision();
  useAuthStore.setState((s) => ({ ...s, session: SESSION }));
  useDeckStore.setState((s) => ({ ...s, decks: [], collection: {}, activeDeckId: null, deletedDeckIds: {}, collectionChangedKeys: {} }));
  useAccountSyncStateStore.getState().reset();
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    console.error(`  ✗ ${label} — ${err?.message ?? err}`);
    if (err?.stack) console.error(err.stack);
    process.exitCode = 1;
  }
}
const jsonResponse = (status, body) => () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const card = (n) => ({ id: `hBP01-0${n}#BASE`, cardNumber: `hBP01-0${n}`, name: `c${n}`, printing: 'BASE', printingLabel: '', series: 'hBP01' });
const deck = (id, name, updatedAt, main) => ({ id, name, oshi: [], main: main.map((n) => ({ card: card(n), qty: 2 })), yell: [], updatedAt });
const SNAP = (revision, decks, extra = {}) => ({
  schemaVersion: 1, revision, updatedAt: '2026-10-27T00:00:00.000Z', decks, collection: {},
  settings: { preferredCurrency: 'TWD', preferredLanguage: 'zh' }, ...extra,
});
const names = (decks) => (decks ?? []).map((d) => d.name).sort();
const ids = (decks) => (decks ?? []).map((d) => d.id).sort();

// Device A (fast clock) last matched the server holding this copy, stamped 10:00.
const FAST = '2026-10-27T10:00:00.000Z';
const SLOW = '2026-10-27T09:45:00.000Z'; // device B's later real-time edit, slow clock
const synced = deck('d1', 'synced', FAST, [1, 2]);
const base = () => baselineFrom(SNAP(10, [synced]));
const oldBase = () => { const b = base(); delete b.deckContent; return b; };

await test('fingerprint: ignores updatedAt, key order and null/undefined fields; sees name, cards and quantities', () => {
  const reordered = { yell: [], updatedAt: '2000-01-01T00:00:00.000Z', main: synced.main, name: 'synced', oshi: [], id: 'd1', origin: undefined };
  assert.equal(deckContentFingerprint(reordered), deckContentFingerprint(synced));
  const withNull = { ...synced, main: synced.main.map((s) => ({ ...s, card: { ...s.card, nameZh: null, imageUrl: undefined } })) };
  assert.equal(deckContentFingerprint(withNull), deckContentFingerprint(synced));
  assert.notEqual(deckContentFingerprint({ ...synced, name: 'other' }), deckContentFingerprint(synced));
  assert.notEqual(deckContentFingerprint({ ...synced, main: [{ ...synced.main[0], qty: 3 }, synced.main[1]] }), deckContentFingerprint(synced));
  assert.notEqual(deckContentFingerprint(deck('d1', 'synced', FAST, [2, 1])), deckContentFingerprint(synced), 'slot order is content');
});

await test('baseline: records deck content next to updatedAt; an older persisted baseline (no deckContent) is still accepted', () => {
  const b = base();
  assert.deepEqual(b.decks, { d1: FAST });
  assert.equal(b.deckContent.d1, deckContentFingerprint(synced));
  assert.doesNotThrow(() => mergeLocalOntoServer(SNAP(11, [synced]), { decks: [synced] }, {}, oldBase()));
});

await test('stale fast-clock local copy, untouched since baseline, yields to a newer slow-clock server edit', () => {
  const remote = deck('d1', 'B edit', SLOW, [1, 3]);
  const merged = mergeLocalOntoServer(SNAP(11, [remote]), { decks: [synced] }, {}, base());
  assert.deepEqual(merged.decks, [remote]);
});

await test('normal local edit wins over an unchanged server copy, even with an earlier (slow-clock) stamp', () => {
  const local = deck('d1', 'A edit', '2026-10-27T09:00:00.000Z', [1, 4]);
  const merged = mergeLocalOntoServer(SNAP(11, [synced]), { decks: [local] }, {}, base());
  assert.deepEqual(merged.decks, [local]);
});

await test('equal timestamps, different content: the side that changed wins; both changed → local on tie (old rule)', () => {
  const remoteSameTs = deck('d1', 'B same ts', FAST, [1, 5]);
  assert.deepEqual(mergeLocalOntoServer(SNAP(11, [remoteSameTs]), { decks: [synced] }, {}, base()).decks, [remoteSameTs], 'local untouched → server change kept');
  const localSameTs = deck('d1', 'A same ts', FAST, [1, 6]);
  assert.deepEqual(mergeLocalOntoServer(SNAP(11, [synced]), { decks: [localSameTs] }, {}, base()).decks, [localSameTs], 'server untouched → local edit kept');
  assert.deepEqual(mergeLocalOntoServer(SNAP(11, [remoteSameTs]), { decks: [localSameTs] }, {}, base()).decks, [localSameTs], 'both changed, tie → local');
});

await test('changed on both sides (true concurrent conflict): newer updatedAt still wins', () => {
  const remote = deck('d1', 'B edit', '2026-10-27T10:30:00.000Z', [1, 3]);
  const local = deck('d1', 'A edit', '2026-10-27T10:10:00.000Z', [1, 4]);
  assert.deepEqual(mergeLocalOntoServer(SNAP(11, [remote]), { decks: [local] }, {}, base()).decks, [remote]);
  const laterLocal = { ...local, updatedAt: '2026-10-27T11:00:00.000Z' };
  assert.deepEqual(mergeLocalOntoServer(SNAP(11, [remote]), { decks: [laterLocal] }, {}, base()).decks, [laterLocal]);
});

await test('no baseline, or a baseline saved before fingerprints: unchanged timestamp rules (compatibility)', () => {
  const remote = deck('d1', 'B edit', SLOW, [1, 3]);
  assert.deepEqual(mergeLocalOntoServer(SNAP(11, [remote]), { decks: [synced] }, {}).decks, [synced], 'no baseline: newer stamp wins as before');
  assert.deepEqual(mergeLocalOntoServer(SNAP(11, [remote]), { decks: [synced] }, {}, oldBase()).decks, [synced], 'old baseline: as before');
  const slowEdit = deck('d1', 'A slow edit', '2026-10-27T09:00:00.000Z', [1, 4]);
  assert.deepEqual(mergeLocalOntoServer(SNAP(11, []), { decks: [slowEdit] }, {}, oldBase()).decks, [], 'old baseline: deleted-elsewhere still by timestamp');
  // A server without the deck list cannot use the baseline either.
  const noDecks = SNAP(11, undefined);
  delete noDecks.decks;
  assert.deepEqual(mergeLocalOntoServer(noDecks, { decks: [synced] }, {}, base()).decks, [synced]);
});

await test('remote deletion: an untouched local copy stays deleted; a slow-clock local edit is kept', () => {
  assert.deepEqual(mergeLocalOntoServer(SNAP(11, []), { decks: [synced] }, {}, base()).decks, [], 'untouched → stays deleted (no resurrection)');
  const slowEdit = deck('d1', 'A slow edit', '2026-10-27T09:00:00.000Z', [1, 4]);
  assert.deepEqual(mergeLocalOntoServer(SNAP(11, []), { decks: [slowEdit] }, {}, base()).decks, [slowEdit], 'edited here → kept');
});

await test('local deletion tombstone: beats an unchanged server copy whatever the clocks; a changed server copy keeps the old rule', () => {
  const tomb = { deletedDeckIds: { d1: '2026-10-27T09:30:00.000Z' } }; // slow clock, earlier than FAST
  assert.deepEqual(mergeLocalOntoServer(SNAP(11, [synced]), { decks: [] }, tomb, base()).decks, [], 'unchanged server copy → deletion wins');
  const remoteLater = deck('d1', 'B edit', '2026-10-27T09:40:00.000Z', [1, 3]);
  assert.deepEqual(mergeLocalOntoServer(SNAP(11, [remoteLater]), { decks: [] }, tomb, base()).decks, [remoteLater], 'server edited after the delete → kept');
  const remoteEarlier = deck('d1', 'B edit', '2026-10-27T09:20:00.000Z', [1, 3]);
  assert.deepEqual(mergeLocalOntoServer(SNAP(11, [remoteEarlier]), { decks: [] }, tomb, base()).decks, [], 'delete after the server edit → deleted');
  assert.deepEqual(mergeLocalOntoServer(SNAP(11, [synced]), { decks: [] }, tomb, oldBase()).decks, [synced], 'old baseline: timestamp rule as before');
});

await test('new decks on either side are kept, ids are never duplicated', () => {
  const remoteNew = deck('d2', 'B new', SLOW, [7]);
  const localNew = deck('d3', 'A new', '2026-10-27T08:00:00.000Z', [8]);
  const merged = mergeLocalOntoServer(SNAP(11, [deck('d1', 'B edit', SLOW, [1, 3]), remoteNew]), { decks: [synced, localNew] }, {}, base());
  assert.deepEqual(ids(merged.decks), ['d1', 'd2', 'd3']);
  assert.deepEqual(names(merged.decks), ['A new', 'B edit', 'B new']);
});

await test('end to end: a 409 retry writes the server edit back, not the stale local deck; other pending edits survive', async () => {
  const remote = deck('d1', 'B edit', SLOW, [1, 3]);
  useDeckStore.setState((s) => ({ ...s, decks: [synced], collection: { 'hBP01-009|BASE': 1 }, collectionChangedKeys: { 'hBP01-009|BASE': '2026-10-27T10:05:00.000Z' } }));
  useAccountSyncStateStore.setState({ baseline: base(), dirtySeq: 1, ackedSeq: 0, lastRevision: 10 });
  setLastKnownRevision(10);
  responseQueue = [
    jsonResponse(409, { error: 'revision_conflict', serverRevision: 11, snapshot: SNAP(11, [remote]) }),
    jsonResponse(200, { ok: true, snapshot: SNAP(12, [remote], { collection: { 'hBP01-009|BASE': 1 } }) }),
  ];
  await pushAccountSyncFromStores(SESSION);
  assert.equal(fetchCalls.length, 2);
  assert.deepEqual(fetchCalls[1].body.patch.decks, [remote], 'retry writes B\'s edit');
  assert.equal(fetchCalls[1].body.patch.collection['hBP01-009|BASE'], 1, 'unrelated pending local edit kept');
  assert.deepEqual(useDeckStore.getState().decks, [remote]);
  assert.equal(useAccountSyncStateStore.getState().baseline.deckContent.d1, deckContentFingerprint(remote), 'baseline advances to the acked copy');
});

await test('end to end: a dirty hydrate merges the same way (server edit kept, local edit to another deck kept)', async () => {
  const other = deck('d2', 'other', FAST, [9]);
  const otherEdited = deck('d2', 'other edited', '2026-10-27T09:00:00.000Z', [9, 9]);
  const remote = deck('d1', 'B edit', SLOW, [1, 3]);
  useDeckStore.setState((s) => ({ ...s, decks: [synced, otherEdited] }));
  useAccountSyncStateStore.setState({ ownerId: null, baseline: baselineFrom(SNAP(10, [synced, other])), dirtySeq: 1, ackedSeq: 0 });
  responseQueue = [jsonResponse(200, { snapshot: SNAP(11, [remote, other]) })];
  // Not dirty for the owner check (ownerId null) but edited during the pull: force the merge path.
  const p = hydrateAccountSyncFromServer(SESSION);
  useAccountSyncStateStore.getState().markDirty();
  await p;
  const byId = Object.fromEntries(useDeckStore.getState().decks.map((d) => [d.id, d.name]));
  assert.deepEqual(byId, { d1: 'B edit', d2: 'other edited' });
});

console.log(`${passed} deck-baseline sync checks passed`);
if (process.exitCode) console.error('deck-baseline sync regression FAILED');
