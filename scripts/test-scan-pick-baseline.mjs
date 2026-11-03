#!/usr/bin/env node
// 2026-11-03 — the same scan on both sides is decided by WHICH SIDE CHANGED ITS PICK since
// the device last matched the server, not by device clocks (src/utils/scanSessionSync.ts).
//
// Dependency-free: imports only src/utils/scanSessionSync.ts, the exact functions
// mergeLocalOntoServer calls (unionScanEntries([serverEntries, localEntries], clearedAt,
// removedAt, basePicks)). The base pick map is built with scanPickFingerprint, which is
// what baselineFrom stores. Synthetic entries only; no network, no images.
//
// Run: node --experimental-strip-types scripts/test-scan-pick-baseline.mjs
import assert from 'node:assert/strict';

const {
  preferScanEntry, preferScanEntryWithBaseline, scanPickFingerprint, unionScanEntries,
} = await import('../src/utils/scanSessionSync.ts');

let passed = 0;
function test(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    console.error(`  ✗ ${label} — ${err?.message ?? err}`);
    process.exitCode = 1;
  }
}

const VERSIONS = [
  { name: 'base', printing: 'BASE', sellPrice: 100, buyPrice: null },
  { name: 'parallel', printing: 'PARALLEL', sellPrice: 900, buyPrice: null },
];
const entry = (selectedVersion, selectedAt, over = {}) => ({
  instanceId: 'scan-1', scannedAt: '2026-11-03T08:00:00.000Z',
  card: { id: 'hBP01-001', cardNumber: 'hBP01-001', name: 'c', sellPrice: 100 },
  priceVersions: VERSIONS, selectedVersion, versionConfident: true,
  ...(selectedAt ? { selectedAt } : {}), ...over,
});
const T = (hhmm) => `2026-11-03T${hhmm}:00.000Z`;
// Both devices last matched the server holding version 0 picked at 10:00.
const BASE = entry(0, T('10:00'));
const picks = (...es) => Object.fromEntries(es.map((e) => [e.instanceId, scanPickFingerprint(e)]));
const BASE_PICKS = picks(BASE);
// Exactly the merge call: [server, local], with the device's baseline picks.
const merge = (server, local, basePicks = BASE_PICKS, clearedAt = null, removedAt = {}) =>
  unionScanEntries([server, local], clearedAt, removedAt, basePicks);
const only = (list) => { assert.equal(list.length, 1); return list[0]; };

test('negative control: the clock-only rule (no baseline) still loses a slow-clock new pick — the original bug', () => {
  const localNew = entry(1, T('09:50'));
  assert.equal(preferScanEntry(BASE, localNew), BASE);
  assert.equal(only(unionScanEntries([[BASE], [localNew]], null)), BASE, 'no basePicks: behaviour unchanged');
  assert.equal(only(unionScanEntries([[BASE], [localNew]], null, {}, null)), BASE, 'explicit null basePicks: unchanged');
});

test('slow-clock LOCAL new pick vs UNCHANGED server → the local pick survives', () => {
  const localNew = entry(1, T('09:50'));
  assert.equal(only(merge([BASE], [localNew])), localNew);
});

test('UNCHANGED local (later stamp) vs NEWER server pick from a slow-clock device → the server pick wins', () => {
  const serverNew = entry(1, T('09:50'));
  assert.equal(only(merge([serverNew], [BASE])), serverNew);
});

test('same pick time, different pick: the side that changed wins, in either direction', () => {
  const changed = entry(1, T('10:00'));
  assert.equal(only(merge([BASE], [changed])), changed, 'local changed');
  assert.equal(only(merge([changed], [BASE])), changed, 'server changed');
});

test('both sides changed (true concurrent picks): the existing clock rule decides', () => {
  const a = entry(1, T('10:05'));
  const b = entry(1, T('10:10'), { priceVersions: VERSIONS });
  const c = entry(0, T('10:20'));
  assert.equal(only(merge([a], [c])), c, 'newer pick time wins');
  assert.equal(only(merge([c], [a])), c);
  assert.equal(only(merge([b], [a])), preferScanEntry(b, a));
  const tieServer = entry(1, T('10:30'));
  const tieLocal = entry(0, T('10:30'));
  assert.equal(only(merge([tieServer], [tieLocal])), tieServer, 'same time, both changed → server copy (old tie rule)');
});

test('neither side changed: the server copy, as before', () => {
  const sameLocal = entry(0, '2026-11-03T18:00:00+08:00'); // same instant, other ISO form
  assert.equal(only(merge([BASE], [sameLocal])), BASE);
});

test('no baseline pick for this scan (scanned after the baseline) or an old baseline: unchanged clock rule', () => {
  const localNew = entry(1, T('09:50'));
  assert.equal(only(merge([BASE], [localNew], {})), BASE, 'id missing from basePicks');
  assert.equal(only(merge([BASE], [localNew], null)), BASE, 'no scanPicks in the persisted baseline');
});

test('an index means nothing across different priceVersions: same index, different listing = a change', () => {
  const swapped = [VERSIONS[1], VERSIONS[0]];
  const sameIndexOtherListing = entry(0, T('10:00'), { priceVersions: swapped });
  assert.notEqual(scanPickFingerprint(sameIndexOtherListing), scanPickFingerprint(BASE));
  assert.equal(only(merge([BASE], [sameIndexOtherListing])), sameIndexOtherListing, 'local is not treated as unchanged');
});

test('confidence and provenance are part of the pick', () => {
  const resolved = entry(0, undefined);                          // the scan's own resolution
  const explicit = entry(0, T('09:00'));                         // a hand pick of the same version
  const unsure = entry(0, undefined, { versionConfident: false });
  const base = picks(resolved);
  assert.notEqual(scanPickFingerprint(explicit), scanPickFingerprint(resolved));
  assert.equal(only(unionScanEntries([[resolved], [explicit]], null, {}, base)), explicit, 'explicit confirmation is a change');
  assert.notEqual(scanPickFingerprint(unsure), scanPickFingerprint(resolved));
  assert.equal(only(unionScanEntries([[unsure], [resolved]], null, {}, base)), unsure, 'server changed confidence → server');
});

test('a re-pick of the SAME version is still a new pick (conservative: counts as a change)', () => {
  const repick = entry(0, T('09:55'));
  assert.equal(only(merge([BASE], [repick])), repick);
});

test('ACK canonical time: the server\'s normalised form of the same instant is the same pick', () => {
  const canonical = entry(1, T('09:50'));
  const localForm = entry(1, '2026-11-03T17:50:00+08:00');
  assert.equal(scanPickFingerprint(canonical), scanPickFingerprint(localForm));
  const unparseable = entry(1, 'not a date');
  assert.notEqual(scanPickFingerprint(unparseable), scanPickFingerprint(canonical), 'an unparseable time never equals a server copy');
});

test('order-independent: a list repeating an id, or local listed first, gives the same choice', () => {
  const localNew = entry(1, T('09:50'));
  assert.equal(only(unionScanEntries([[localNew], [BASE]], null, {}, BASE_PICKS)), localNew);
  assert.equal(preferScanEntryWithBaseline(BASE, localNew, BASE_PICKS['scan-1']), localNew);
  assert.equal(preferScanEntryWithBaseline(localNew, BASE, BASE_PICKS['scan-1']), localNew);
});

test('removal tombstones and whole-list clears still win: no resurrection through a changed pick', () => {
  const localNew = entry(1, T('09:50'));
  const serverNew = entry(1, T('09:50'));
  assert.deepEqual(merge([serverNew], [], BASE_PICKS, null, { 'scan-1': T('09:00') }), [], 'removed here');
  assert.deepEqual(merge([BASE], [localNew], BASE_PICKS, T('09:00')), [], 'cleared after the scan time');
  const other = entry(0, T('10:00'), { instanceId: 'scan-2', scannedAt: '2026-11-03T08:30:00.000Z' });
  assert.deepEqual(merge([BASE, other], [localNew], { ...BASE_PICKS, ...picks(other) }, null, { 'scan-2': T('09:00') }).map((e) => e.instanceId),
    ['scan-1'], 'per-scan removal of another scan still applies');
});

test('different scans are never merged with each other; order is by scan time', () => {
  const s2 = entry(1, T('09:50'), { instanceId: 'scan-2', scannedAt: '2026-11-03T07:00:00.000Z' });
  const out = merge([BASE], [s2]);
  assert.deepEqual(out.map((e) => e.instanceId), ['scan-2', 'scan-1']);
});

console.log(`${passed} scan-pick baseline checks passed`);
if (process.exitCode) console.error('scan-pick baseline regression FAILED');
